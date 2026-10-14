/**
 * Casamento do item de marketplace com o catálogo REAL do ERP.
 *
 * O `empresaId` é obrigatório e sempre vem do conector confiável que originou
 * a ingestão; SKU, código de barras, título e tamanho não são identidade de
 * tenant. Cada predicado consulta exclusivamente o catálogo dessa empresa,
 * inclusive os fallbacks de SKU composto e descrição.
 */

import type { ConnectorDatabase } from '../core/database';

export interface CatalogMatchInput {
  /** SKU informado pelo marketplace (seller_sku, item_sku, id do item). */
  sku?: string | null;
  /** Título do item no marketplace. */
  title?: string | null;
  /** Rótulo do tamanho extraído da variação ("M", "GG", "42"). */
  sizeLabel?: string | null;
  /** Texto cru da variação, usado como último recurso para o tamanho. */
  variacaoExterna?: string | null;
}

export interface CatalogMatch {
  productId: number | null;
  sizeId: number | null;
}

interface ProdutoRow extends Record<string, unknown> {
  id: number;
  sku: string;
}

interface TamanhoRow extends Record<string, unknown> {
  id: number;
  codigo: string;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function requireEmpresaId(empresaId: number): number {
  const tenant = Number(empresaId);
  if (!Number.isSafeInteger(tenant) || tenant <= 0) {
    throw new Error('O casamento de catálogo exige um empresaId explícito e válido.');
  }
  return tenant;
}

/** `tamanhos` é um dicionário global do ERP, não um recurso empresarial. */
export async function matchTamanho(db: ConnectorDatabase, label: string | null | undefined): Promise<number | null> {
  const candidate = clean(label);
  if (!candidate) return null;
  const { rows } = await db.query<TamanhoRow>(
    `SELECT id, codigo FROM tamanhos
     WHERE upper(btrim(codigo)) = upper(btrim($1))
        OR upper(btrim(coalesce(descricao, ''))) = upper(btrim($1))
     ORDER BY id ASC
     LIMIT 1`,
    [candidate]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Resolve o `produtos.id` exclusivamente por SKU/título da empresa. */
export async function matchProduto(db: ConnectorDatabase, empresaId: number, input: CatalogMatchInput): Promise<number | null> {
  const tenant = requireEmpresaId(empresaId);
  const sku = clean(input.sku);
  if (sku) {
    const { rows } = await db.query<ProdutoRow>(
      `SELECT id, sku FROM produtos
       WHERE empresa_id = $1
         AND (upper(btrim(sku)) = upper(btrim($2))
          OR upper(btrim(coalesce(codigo_barras, ''))) = upper(btrim($2)))
       ORDER BY id ASC
       LIMIT 1`,
      [tenant, sku]
    );
    if (rows[0]) return Number(rows[0].id);

    // SKU composto: "CAMISA-AZUL-M" → produto "CAMISA-AZUL" + tamanho "M".
    const separatorIndex = Math.max(sku.lastIndexOf('-'), sku.lastIndexOf('_'));
    if (separatorIndex > 0) {
      const prefix = sku.slice(0, separatorIndex);
      const { rows: prefixRows } = await db.query<ProdutoRow>(
        `SELECT id, sku FROM produtos
         WHERE empresa_id = $1 AND upper(btrim(sku)) = upper(btrim($2))
         ORDER BY id ASC
         LIMIT 1`,
        [tenant, prefix]
      );
      if (prefixRows[0]) return Number(prefixRows[0].id);
    }
  }

  const title = clean(input.title);
  if (title) {
    const { rows } = await db.query<ProdutoRow>(
      `SELECT id, sku FROM produtos
       WHERE empresa_id = $1 AND upper(btrim(nome)) = upper(btrim($2))
       ORDER BY id ASC
       LIMIT 1`,
      [tenant, title]
    );
    if (rows[0]) return Number(rows[0].id);
  }

  return null;
}

/**
 * Casa um item de pedido com produto + tamanho do tenant indicado. Nunca
 * lança para falhas de consulta: a venda pode entrar sem vínculo, mas jamais
 * será ligada a um produto ou tamanho de outra empresa.
 */
export async function matchCatalogItem(db: ConnectorDatabase, empresaId: number, input: CatalogMatchInput): Promise<CatalogMatch> {
  const tenant = requireEmpresaId(empresaId);
  try {
    const productId = await matchProduto(db, tenant, input);
    const sku = clean(input.sku);
    const separatorIndex = Math.max(sku.lastIndexOf('-'), sku.lastIndexOf('_'));
    const skuSuffix = separatorIndex > 0 ? sku.slice(separatorIndex + 1) : '';
    const sizeId =
      (await matchTamanho(db, input.sizeLabel)) ??
      (await matchTamanho(db, skuSuffix)) ??
      (await matchTamanho(db, input.variacaoExterna));
    return { productId, sizeId };
  } catch (error) {
    console.warn('⚠️  Casamento de catálogo indisponível (item entra sem vínculo):', error instanceof Error ? error.message : error);
    return { productId: null, sizeId: null };
  }
}
