// ============================================================================
// SMART PRODUCT SEARCH — capacidade central de localização de produtos.
//
// Uma única implementação atende PDV, estoque, compras, produção, commerce e
// formulários fiscais. O módulo chamador escolhe apenas o contexto (estoque,
// local, inativos e paginação); tenant, termos, ranking e variantes ficam aqui.
//
// PostgreSQL faz filtro, ranking, agregação e paginação no banco. O MemStore é
// o adaptador do modo demonstração/testes e segue o mesmo contrato e a mesma
// ordenação. Nenhum input é interpolado em SQL: valores sempre são parâmetros.
// ============================================================================
import type { Request, Response } from 'express';
import type { QueryConfig } from 'pg';
import { currentUser } from './auth';
import { query } from './db';
import type { EscopoEmpresa } from './empresa';
import { HttpError } from './errors';
import { RESOURCES } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import type { Row, Tx } from './store';

export const PRODUCT_SEARCH_DEFAULT_LIMIT = 20;
export const PRODUCT_SEARCH_MAX_LIMIT = 50;
const PRODUCT_SEARCH_MAX_QUERY = 120;

export type ProductSearchSize = {
  tamanho_id: number | null;
  tamanho: string;
  quantidade: number;
};

export type ProductSearchProduct = {
  id: number;
  produto_pai_id: number | null;
  sku: string;
  nome: string;
  codigo_barras: string | null;
  descricao: string | null;
  cor: string | null;
  categoria: string | null;
  marca: string | null;
  preco_venda: number;
  ativo: boolean;
  variacao_tamanho_id: number | null;
  estoque_disponivel: number;
  tamanhos: ProductSearchSize[];
};

export type ProductSearchItem = ProductSearchProduct & {
  variacoes: ProductSearchProduct[];
};

export type ProductSearchParams = {
  q?: string;
  page?: number | string;
  pageSize?: number | string;
  id?: number | string | null;
  onlyInStock?: boolean | number | string;
  inStockFirst?: boolean | number | string;
  includeInactive?: boolean | number | string;
  localId?: number | string | null;
};

export type ProductSearchResult = {
  rows: ProductSearchItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

type NormalizedParams = {
  q: string;
  id: number | null;
  localId: number | null;
  page: number;
  pageSize: number;
  onlyInStock: boolean;
  inStockFirst: boolean;
  includeInactive: boolean;
};

type StockRow = {
  produto_id: number;
  tamanho_id: number | null;
  tamanho: string | null;
  ordem?: number | null;
  quantidade: number;
};

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function normalized(value: unknown): string {
  return text(value).trim().toLocaleLowerCase('pt-BR');
}

/** Divide em termos sem duplicá-los; cada termo precisa ocorrer no documento. */
export function productSearchTerms(value: unknown): string[] {
  return [...new Set(normalized(value).split(/\s+/).filter(Boolean))].slice(0, 12);
}

function positiveInt(value: unknown, fallback: number, max: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new HttpError(400, `${label} deve ser um inteiro entre 1 e ${max}.`);
  }
  return parsed;
}

function optionalId(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${label} inválido.`);
  return parsed;
}

function bool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new HttpError(400, 'Filtro booleano inválido. Use true ou false.');
}

export function normalizeProductSearchParams(input: ProductSearchParams): NormalizedParams {
  const q = text(input.q).trim();
  if (q.length > PRODUCT_SEARCH_MAX_QUERY) {
    throw new HttpError(400, `A busca deve ter no máximo ${PRODUCT_SEARCH_MAX_QUERY} caracteres.`);
  }
  return {
    q: normalized(q),
    id: optionalId(input.id, 'id'),
    localId: optionalId(input.localId, 'local_id'),
    page: positiveInt(input.page, 1, 10_000, 'page'),
    pageSize: positiveInt(input.pageSize, PRODUCT_SEARCH_DEFAULT_LIMIT, PRODUCT_SEARCH_MAX_LIMIT, 'pageSize'),
    onlyInStock: bool(input.onlyInStock),
    inStockFirst: bool(input.inStockFirst),
    includeInactive: bool(input.includeInactive),
  };
}

/**
 * Ranking compartilhado com o adaptador em memória. O SQL abaixo implementa os
 * mesmos pesos: barcode exato, SKU exato, nome exato, prefixos e ocorrências.
 */
export function productSearchRank(product: Row, rawQuery: string): number {
  const q = normalized(rawQuery);
  if (!q) return 7;
  const barcode = normalized(product.codigo_barras);
  const sku = normalized(product.sku);
  const name = normalized(product.nome);
  if (barcode && barcode === q) return 0;
  if (sku === q) return 1;
  if (name === q) return 2;
  if (sku.startsWith(q)) return 3;
  if (name.startsWith(q)) return 4;
  if (name.includes(q)) return 5;
  if (sku.includes(q) || barcode.includes(q)) return 6;
  return 7;
}

function documentOf(product: Row, parent?: Row): string {
  const fields = [
    'sku', 'nome', 'codigo_barras', 'descricao', 'descricao_curta', 'cor',
    'cor_id__label', 'categoria_id__label', 'colecao_id__label', 'grade_id__label',
    'fornecedor_id__label', 'marca', 'tags', 'composicao', 'variacao_chave',
    'codigo_fornecedor', 'localizacao', 'unidade', 'formato', 'tipo', 'condicao',
    'producao', 'ncm', 'cest', 'gtin_tributario', 'cfop_saida',
  ];
  return normalized([
    ...fields.map((field) => product[field]),
    ...(parent ? fields.map((field) => parent[field]) : []),
  ].filter((value) => value !== null && value !== undefined).join(' '));
}

function isActive(product: Row): boolean {
  return product.ativo !== false;
}

/**
 * Tamanhos de um produto na identidade canônica (empresa + produto + tamanho).
 *
 * As linhas de `estoques` são somadas POR TAMANHO antes de virarem opções: sem
 * isso, um produto com o mesmo tamanho em dois locais aparecia duas vezes e a
 * variação podia exibir só a primeira linha (1 un.) enquanto a grade somava
 * todas (10 un.) — a divergência Grade × PDV. A soma nunca atravessa produtos:
 * saldo de variação e de pai não se misturam.
 */
function mapSizes(stock: StockRow[], productId: number, variationSizeId: number | null, variationSizeLabel?: unknown): ProductSearchSize[] {
  const porTamanho = new Map<number, { tamanho_id: number | null; tamanho: string; quantidade: number; ordem: number }>();
  for (const row of stock) {
    if (Number(row.produto_id) !== productId) continue;
    const tamanhoId = row.tamanho_id === null || row.tamanho_id === undefined ? null : Number(row.tamanho_id);
    const chave = tamanhoId === null ? 0 : tamanhoId;
    const atual = porTamanho.get(chave) ?? {
      tamanho_id: tamanhoId,
      tamanho: text(row.tamanho) || 'Sem tamanho',
      quantidade: 0,
      ordem: num(row.ordem),
    };
    atual.quantidade += num(row.quantidade);
    porTamanho.set(chave, atual);
  }
  const own = [...porTamanho.values()]
    .sort((a, b) => a.ordem - b.ordem || a.tamanho.localeCompare(b.tamanho, 'pt-BR', { numeric: true }) || Number(a.tamanho_id ?? -1) - Number(b.tamanho_id ?? -1))
    .map(({ tamanho_id, tamanho, quantidade }) => ({ tamanho_id, tamanho, quantidade }));
  // Uma variação recém-criada ainda pode não ter célula de estoque. Exibir o
  // tamanho real com saldo zero permite selecioná-la sem inventar disponibilidade.
  if (!own.length && variationSizeId !== null) {
    const known = stock.find((row) => Number(row.tamanho_id) === variationSizeId);
    return [{ tamanho_id: variationSizeId, tamanho: text(variationSizeLabel) || text(known?.tamanho) || `#${variationSizeId}`, quantidade: 0 }];
  }
  return own;
}

function toProduct(product: Row, stock: StockRow[]): ProductSearchProduct {
  const id = Number(product.id);
  const variationSizeId = product.variacao_tamanho_id === null || product.variacao_tamanho_id === undefined
    ? null
    : Number(product.variacao_tamanho_id);
  const tamanhos = mapSizes(stock, id, variationSizeId, product.variacao_tamanho__label);
  return {
    id,
    produto_pai_id: product.produto_pai_id === null || product.produto_pai_id === undefined ? null : Number(product.produto_pai_id),
    sku: text(product.sku),
    nome: text(product.nome),
    codigo_barras: product.codigo_barras === null || product.codigo_barras === undefined ? null : text(product.codigo_barras),
    descricao: product.descricao === null || product.descricao === undefined ? null : text(product.descricao),
    cor: product.cor_id__label ?? product.cor ?? null,
    categoria: product.categoria_id__label ?? null,
    marca: product.marca === null || product.marca === undefined ? null : text(product.marca),
    preco_venda: num(product.preco_venda),
    ativo: isActive(product),
    variacao_tamanho_id: variationSizeId,
    estoque_disponivel: tamanhos.reduce((sum, size) => sum + size.quantidade, 0),
    tamanhos,
  };
}

function assembleItems(
  candidates: Array<{ id: number; rank: number; estoque_familia?: number }>,
  products: Row[],
  stock: StockRow[],
): ProductSearchItem[] {
  const byId = new Map(products.map((product) => [Number(product.id), product]));
  return candidates.map((candidate) => {
    const product = byId.get(candidate.id)!;
    const own = toProduct(product, stock);
    const variants = products
      .filter((row) => Number(row.produto_pai_id) === candidate.id)
      .sort((a, b) => normalized(a.nome).localeCompare(normalized(b.nome), 'pt-BR') || Number(a.id) - Number(b.id))
      .map((row) => {
        const variant = toProduct(row, stock);
        // Regra canônica do ERP (PDV + migration 0018): SKU/preço pertencem à
        // variação, mas a venda e o saldo pertencem ao PAI + tamanho. O saldo da
        // variação é SEMPRE a célula da grade do pai — jamais a linha de
        // `estoques` gravada na variação (que não é vendável e não pode ser
        // somada à do pai). Variação legada sem `variacao_tamanho_id` continua
        // resolvida pelo único tamanho dela.
        const tamanhoId = variant.variacao_tamanho_id
          ?? (variant.tamanhos.length === 1 ? variant.tamanhos[0].tamanho_id : null);
        const parentSize = tamanhoId === null
          ? undefined
          : own.tamanhos.find((size) => size.tamanho_id === tamanhoId);
        const rotuloTamanho = variant.tamanhos[0]?.tamanho || text(row.variacao_tamanho__label) || `#${tamanhoId}`;
        const tamanhos = tamanhoId === null
          ? []
          : [parentSize ?? { tamanho_id: tamanhoId, tamanho: rotuloTamanho, quantidade: 0 }];
        return {
          ...variant,
          tamanhos,
          estoque_disponivel: tamanhos.reduce((sum, size) => sum + size.quantidade, 0),
        };
      });
    return {
      ...own,
      // Não somar as variações: elas são visões das mesmas células do pai.
      estoque_disponivel: own.estoque_disponivel,
      variacoes: variants,
    };
  });
}

async function searchInMemory(empresaId: number, params: NormalizedParams): Promise<ProductSearchResult> {
  const store = getStore();
  const listed = await store.list(RESOURCES.produtos, {
    page: 1,
    pageSize: 50_000,
    filter: { empresa_id: empresaId },
    sort: 'nome',
    dir: 'asc',
  });
  // O adaptador em memória existe apenas para demo/testes. Ainda assim, não
  // devolve silenciosamente uma página parcial se o conjunto crescer demais.
  if (listed.total > listed.rows.length) {
    throw new HttpError(409, 'O catálogo em memória excede o limite seguro da busca.');
  }
  const products = listed.rows;
  const byId = new Map(products.map((product) => [Number(product.id), product]));
  const terms = productSearchTerms(params.q);
  const matched = products.filter((product) => {
    if (!params.includeInactive && !isActive(product)) return false;
    if (params.id !== null && Number(product.id) !== params.id) return false;
    if (!terms.length) return true;
    const parent = product.produto_pai_id ? byId.get(Number(product.produto_pai_id)) : undefined;
    const document = documentOf(product, parent);
    return terms.every((term) => document.includes(term));
  });

  const candidateMap = new Map<number, { id: number; rank: number }>();
  for (const product of matched) {
    const id = params.id !== null ? Number(product.id) : Number(product.produto_pai_id ?? product.id);
    const canonical = byId.get(id);
    if (!canonical || (!params.includeInactive && !isActive(canonical))) continue;
    const rank = productSearchRank(product, params.q);
    const previous = candidateMap.get(id);
    if (!previous || rank < previous.rank) candidateMap.set(id, { id, rank });
  }

  const canonicalIds = [...candidateMap.keys()];
  const family = products.filter((product) => {
    const id = Number(product.id);
    return canonicalIds.includes(id) || canonicalIds.includes(Number(product.produto_pai_id));
  }).filter((product) => params.includeInactive || isActive(product));
  const familyIds = new Set(family.map((product) => Number(product.id)));
  const sizes = await store.list(RESOURCES.tamanhos, { page: 1, pageSize: 2_000, sort: 'ordem', dir: 'asc' });
  const sizeById = new Map(sizes.rows.map((size) => [Number(size.id), size]));
  const stockRows = await store.list(RESOURCES.estoques, {
    page: 1,
    pageSize: 100_000,
    filter: { empresa_id: empresaId },
  });
  const stock: StockRow[] = stockRows.rows
    .filter((row) => familyIds.has(Number(row.produto_id)))
    .filter((row) => params.localId === null || Number(row.local_id) === params.localId)
    .map((row) => {
      const sizeId = row.tamanho_id === null || row.tamanho_id === undefined ? null : Number(row.tamanho_id);
      const size = sizeId === null ? null : sizeById.get(sizeId);
      return {
        produto_id: Number(row.produto_id),
        tamanho_id: sizeId,
        tamanho: size ? text(size.codigo) : 'Sem tamanho',
        ordem: num(size?.ordem),
        quantidade: num(row.quantidade),
      };
    });

  const withStock = [...candidateMap.values()].map((candidate) => {
    const familyStock = stock
      .filter((row) => Number(row.produto_id) === candidate.id)
      .reduce((sum, row) => sum + num(row.quantidade), 0);
    return { ...candidate, estoque_familia: familyStock };
  }).filter((candidate) => !params.onlyInStock || candidate.estoque_familia > 0);

  withStock.sort((a, b) => {
    const productA = byId.get(a.id)!;
    const productB = byId.get(b.id)!;
    return a.rank - b.rank
      || (params.inStockFirst ? Number(b.estoque_familia > 0) - Number(a.estoque_familia > 0) : 0)
      || normalized(productA.nome).localeCompare(normalized(productB.nome), 'pt-BR')
      || a.id - b.id;
  });
  const total = withStock.length;
  const start = (params.page - 1) * params.pageSize;
  const pageCandidates = withStock.slice(start, start + params.pageSize);
  const pageIds = new Set(pageCandidates.map((candidate) => candidate.id));
  const pageProducts = family
    .filter((product) => pageIds.has(Number(product.id)) || pageIds.has(Number(product.produto_pai_id)))
    .map((product) => ({
      ...product,
      variacao_tamanho__label: product.variacao_tamanho_id
        ? text(sizeById.get(Number(product.variacao_tamanho_id))?.codigo)
        : null,
    }));
  return {
    rows: assembleItems(pageCandidates, pageProducts, stock),
    total,
    page: params.page,
    pageSize: params.pageSize,
    hasMore: start + pageCandidates.length < total,
  };
}

async function searchInPostgres(empresaId: number, params: NormalizedParams, tx?: Tx): Promise<ProductSearchResult> {
  const values: unknown[] = [
    empresaId,
    params.q,
    params.includeInactive,
    params.id,
    params.onlyInStock,
    params.inStockFirst,
    params.localId,
  ];
  const terms = productSearchTerms(params.q);
  const termConditions = terms.map((term) => {
    values.push(term);
    return `strpos(lower(concat_ws(' ',
      p.sku, p.nome, p.codigo_barras, p.descricao, p.descricao_curta, p.cor,
      p.marca, p.tags, p.composicao, p.variacao_chave, p.codigo_fornecedor,
      pai.sku, pai.nome, pai.codigo_barras, pai.descricao, pai.descricao_curta,
      pai.cor, pai.marca, pai.tags, pai.composicao, pai.variacao_chave,
      p.codigo_fornecedor, p.localizacao, p.unidade, p.formato, p.tipo,
      p.condicao, p.producao, p.ncm, p.cest, p.gtin_tributario, p.cfop_saida,
      pai.codigo_fornecedor, pai.localizacao, pai.unidade, pai.formato, pai.tipo,
      pai.condicao, pai.producao, pai.ncm, pai.cest, pai.gtin_tributario, pai.cfop_saida,
      categoria.nome, categoria_pai.nome, cor.nome, cor_pai.nome,
      colecao.nome, colecao_pai.nome, grade.nome, grade_pai.nome,
      fornecedor.nome, fornecedor_pai.nome
    )), $${values.length}) > 0`;
  });

  const cte = `
    WITH matched AS (
      SELECT p.id, p.produto_pai_id,
        CASE
          WHEN $2 = '' THEN 7
          WHEN p.codigo_barras IS NOT NULL AND lower(p.codigo_barras) = $2 THEN 0
          WHEN lower(p.sku) = $2 THEN 1
          WHEN lower(p.nome) = $2 THEN 2
          WHEN left(lower(p.sku), length($2)) = $2 THEN 3
          WHEN left(lower(p.nome), length($2)) = $2 THEN 4
          WHEN strpos(lower(p.nome), $2) > 0 THEN 5
          WHEN strpos(lower(p.sku), $2) > 0
            OR strpos(lower(coalesce(p.codigo_barras, '')), $2) > 0 THEN 6
          ELSE 7
        END AS rank
      FROM produtos p
      LEFT JOIN produtos pai ON pai.id = p.produto_pai_id AND pai.empresa_id = p.empresa_id
      LEFT JOIN categorias categoria ON categoria.id = p.categoria_id
      LEFT JOIN categorias categoria_pai ON categoria_pai.id = pai.categoria_id
      LEFT JOIN cores cor ON cor.id = p.cor_id
      LEFT JOIN cores cor_pai ON cor_pai.id = pai.cor_id
      LEFT JOIN colecoes colecao ON colecao.id = p.colecao_id AND colecao.empresa_id = p.empresa_id
      LEFT JOIN colecoes colecao_pai ON colecao_pai.id = pai.colecao_id AND colecao_pai.empresa_id = pai.empresa_id
      LEFT JOIN grades grade ON grade.id = p.grade_id
      LEFT JOIN grades grade_pai ON grade_pai.id = pai.grade_id
      LEFT JOIN fornecedores fornecedor ON fornecedor.id = p.fornecedor_id AND fornecedor.empresa_id = p.empresa_id
      LEFT JOIN fornecedores fornecedor_pai ON fornecedor_pai.id = pai.fornecedor_id AND fornecedor_pai.empresa_id = pai.empresa_id
      WHERE p.empresa_id = $1
        AND ($3::boolean OR p.ativo IS DISTINCT FROM false)
        AND ($4::integer IS NULL OR p.id = $4)
        ${termConditions.length ? `AND ${termConditions.join(' AND ')}` : ''}
    ), canonical AS (
      SELECT CASE WHEN $4::integer IS NOT NULL THEN id ELSE coalesce(produto_pai_id, id) END AS id, min(rank) AS rank
      FROM matched
      GROUP BY CASE WHEN $4::integer IS NOT NULL THEN id ELSE coalesce(produto_pai_id, id) END
    ), family_stock AS (
      SELECT c.id, coalesce(sum(e.quantidade), 0)::double precision AS quantidade
      FROM canonical c
      JOIN produtos raiz ON raiz.id = c.id AND raiz.empresa_id = $1
      LEFT JOIN estoques e ON e.empresa_id = $1
        AND e.produto_id = raiz.id
        AND ($7::integer IS NULL OR e.local_id = $7)
      GROUP BY c.id
    ), filtered AS (
      SELECT c.id, c.rank, coalesce(fs.quantidade, 0) AS estoque_familia,
        $6::boolean AS in_stock_first
      FROM canonical c
      JOIN produtos raiz ON raiz.id = c.id AND raiz.empresa_id = $1
      LEFT JOIN family_stock fs ON fs.id = c.id
      WHERE ($3::boolean OR raiz.ativo IS DISTINCT FROM false)
        AND (NOT $5::boolean OR coalesce(fs.quantidade, 0) > 0)
    )`;

  const listValues = [...values];
  listValues.push(params.pageSize, (params.page - 1) * params.pageSize);
  const limitParam = listValues.length - 1;
  const offsetParam = listValues.length;
  const result = tx
    ? await tx.query(`${cte}
      SELECT p.*, categoria.nome AS categoria_id__label, cor.nome AS cor_id__label,
        tamanho_var.codigo AS variacao_tamanho__label,
        f.rank, f.estoque_familia, count(*) OVER()::int AS total
      FROM filtered f
      JOIN produtos p ON p.id = f.id AND p.empresa_id = $1
      LEFT JOIN categorias categoria ON categoria.id = p.categoria_id
      LEFT JOIN cores cor ON cor.id = p.cor_id
      LEFT JOIN tamanhos tamanho_var ON tamanho_var.id = p.variacao_tamanho_id
      ORDER BY f.rank,
        CASE WHEN f.in_stock_first AND f.estoque_familia > 0 THEN 0 ELSE 1 END,
        lower(p.nome), p.id
      LIMIT $${limitParam} OFFSET $${offsetParam}`, listValues as QueryConfig['values'])
    : await query(`${cte}
      SELECT p.*, categoria.nome AS categoria_id__label, cor.nome AS cor_id__label,
        tamanho_var.codigo AS variacao_tamanho__label,
        f.rank, f.estoque_familia, count(*) OVER()::int AS total
      FROM filtered f
      JOIN produtos p ON p.id = f.id AND p.empresa_id = $1
      LEFT JOIN categorias categoria ON categoria.id = p.categoria_id
      LEFT JOIN cores cor ON cor.id = p.cor_id
      LEFT JOIN tamanhos tamanho_var ON tamanho_var.id = p.variacao_tamanho_id
      ORDER BY f.rank,
        CASE WHEN f.in_stock_first AND f.estoque_familia > 0 THEN 0 ELSE 1 END,
        lower(p.nome), p.id
      LIMIT $${limitParam} OFFSET $${offsetParam}`, listValues);

  let total = num(result.rows[0]?.total);
  if (!result.rows.length && total === 0) {
    // Também cobre páginas além da última sem confundir total com página vazia.
    const countResult = tx
      ? await tx.query(`${cte} SELECT count(*)::int AS total FROM filtered`, values as QueryConfig['values'])
      : await query(`${cte} SELECT count(*)::int AS total FROM filtered`, values);
    total = num(countResult.rows[0]?.total);
  }
  if (!result.rows.length) {
    return { rows: [], total, page: params.page, pageSize: params.pageSize, hasMore: false };
  }

  const ids = result.rows.map((row) => Number(row.id));
  const variantsResult = tx
    ? await tx.query(`SELECT v.*, categoria.nome AS categoria_id__label, cor.nome AS cor_id__label,
        tamanho_var.codigo AS variacao_tamanho__label
      FROM produtos v
      LEFT JOIN categorias categoria ON categoria.id = v.categoria_id
      LEFT JOIN cores cor ON cor.id = v.cor_id
      LEFT JOIN tamanhos tamanho_var ON tamanho_var.id = v.variacao_tamanho_id
      WHERE v.empresa_id = $1 AND v.produto_pai_id = ANY($2::integer[])
        AND ($3::boolean OR v.ativo IS DISTINCT FROM false)
      ORDER BY lower(v.nome), v.id`, [empresaId, ids, params.includeInactive] as QueryConfig['values'])
    : await query(`SELECT v.*, categoria.nome AS categoria_id__label, cor.nome AS cor_id__label,
        tamanho_var.codigo AS variacao_tamanho__label
      FROM produtos v
      LEFT JOIN categorias categoria ON categoria.id = v.categoria_id
      LEFT JOIN cores cor ON cor.id = v.cor_id
      LEFT JOIN tamanhos tamanho_var ON tamanho_var.id = v.variacao_tamanho_id
      WHERE v.empresa_id = $1 AND v.produto_pai_id = ANY($2::integer[])
        AND ($3::boolean OR v.ativo IS DISTINCT FROM false)
      ORDER BY lower(v.nome), v.id`, [empresaId, ids, params.includeInactive]);

  const stockResult = tx
    ? await tx.query(`SELECT e.produto_id, e.tamanho_id, t.codigo AS tamanho, t.ordem,
        sum(e.quantidade)::double precision AS quantidade
      FROM estoques e
      JOIN produtos p ON p.id = e.produto_id AND p.empresa_id = $1
      LEFT JOIN tamanhos t ON t.id = e.tamanho_id
      WHERE e.empresa_id = $1
        AND (p.id = ANY($2::integer[]) OR p.produto_pai_id = ANY($2::integer[]))
        AND ($3::integer IS NULL OR e.local_id = $3)
      GROUP BY e.produto_id, e.tamanho_id, t.codigo, t.ordem
      ORDER BY e.produto_id, t.ordem NULLS LAST, t.codigo, e.tamanho_id NULLS LAST`, [empresaId, ids, params.localId] as QueryConfig['values'])
    : await query(`SELECT e.produto_id, e.tamanho_id, t.codigo AS tamanho, t.ordem,
        sum(e.quantidade)::double precision AS quantidade
      FROM estoques e
      JOIN produtos p ON p.id = e.produto_id AND p.empresa_id = $1
      LEFT JOIN tamanhos t ON t.id = e.tamanho_id
      WHERE e.empresa_id = $1
        AND (p.id = ANY($2::integer[]) OR p.produto_pai_id = ANY($2::integer[]))
        AND ($3::integer IS NULL OR e.local_id = $3)
      GROUP BY e.produto_id, e.tamanho_id, t.codigo, t.ordem
      ORDER BY e.produto_id, t.ordem NULLS LAST, t.codigo, e.tamanho_id NULLS LAST`, [empresaId, ids, params.localId]);

  const stock = stockResult.rows.map((row) => ({
    produto_id: Number(row.produto_id),
    tamanho_id: row.tamanho_id === null || row.tamanho_id === undefined ? null : Number(row.tamanho_id),
    tamanho: row.tamanho_id === null || row.tamanho_id === undefined ? 'Sem tamanho' : text(row.tamanho),
    ordem: num(row.ordem),
    quantidade: num(row.quantidade),
  })) as StockRow[];
  const candidates = result.rows.map((row) => ({ id: Number(row.id), rank: num(row.rank), estoque_familia: num(row.estoque_familia) }));
  const rows = assembleItems(candidates, [...result.rows, ...variantsResult.rows], stock);
  return {
    rows,
    total,
    page: params.page,
    pageSize: params.pageSize,
    hasMore: params.page * params.pageSize < total,
  };
}

/** Entrada central usada por todos os módulos do backend. */
export async function searchProducts(
  escopo: EscopoEmpresa,
  input: ProductSearchParams = {},
  tx?: Tx,
): Promise<ProductSearchResult> {
  const params = normalizeProductSearchParams(input);
  // Mesmo quando o ator tem consolidação gerencial, selecionar um produto é
  // uma operação da empresa ativa. Nunca transformar o seletor em cross-tenant.
  const empresaId = escopo.empresaId;
  if (!Number.isInteger(empresaId) || empresaId < 1) throw new HttpError(400, 'Empresa ativa inválida.');
  return getStore().kind === 'postgres'
    ? searchInPostgres(empresaId, params, tx)
    : searchInMemory(empresaId, params);
}

/** GET /api/produtos/busca — busca autenticada e limitada ao tenant da sessão. */
export async function buscarProdutos(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  checkAccess(RESOURCES.produtos, actor, 'read');
  const result = await searchProducts(escopoDe(actor), {
    q: typeof req.query.q === 'string' ? req.query.q : '',
    id: req.query.id as string | undefined,
    localId: (req.query.local_id ?? req.query.localId) as string | undefined,
    page: req.query.page as string | undefined,
    pageSize: (req.query.pageSize ?? req.query.limit) as string | undefined,
    onlyInStock: (req.query.onlyInStock ?? req.query.somente_com_estoque) as string | undefined,
    inStockFirst: req.query.inStockFirst as string | undefined,
    includeInactive: req.query.includeInactive as string | undefined,
  });
  res.json(result);
}
