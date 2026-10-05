/**
 * Casamento do item do marketplace com o catálogo REAL do ERP.
 *
 * Esta peça NÃO existia no brobond-ai-commerce: lá a `Sale` apontava
 * direto para um `Product` do próprio SaaS. No ERP um pedido de
 * marketplace vira N `sale_items`, cada um resolvido contra `produtos` e
 * `tamanhos` (a Fase 1 criou exatamente essas FKs, com `SET NULL` para
 * que o histórico fiscal sobreviva à exclusão do catálogo).
 *
 * Política de casamento, do mais forte para o mais fraco:
 *   1. SKU do vendedor = `produtos.sku` (comparação sem caixa);
 *   2. SKU do vendedor = `produtos.codigo_barras`;
 *   3. SKU com sufixo de tamanho (`CAMISA-AZUL-M`) → prefixo bate com o
 *      SKU do produto e o sufixo com o código do tamanho;
 *   4. título idêntico a `produtos.nome` (sem caixa).
 *
 * Não casou? `product_id` fica NULL e `variacao_externa` preserva o nome
 * literal da variação — a venda entra com valor correto e o operador
 * concilia depois. NUNCA inventamos um produto.
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

/** Resolve o `tamanhos.id` a partir de um rótulo de variação. */
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

/** Resolve o `produtos.id` a partir do SKU/título do marketplace. */
export async function matchProduto(db: ConnectorDatabase, input: CatalogMatchInput): Promise<number | null> {
  const sku = clean(input.sku);
  if (sku) {
    const { rows } = await db.query<ProdutoRow>(
      `SELECT id, sku FROM produtos
       WHERE upper(btrim(sku)) = upper(btrim($1))
          OR upper(btrim(coalesce(codigo_barras, ''))) = upper(btrim($1))
       ORDER BY id ASC
       LIMIT 1`,
      [sku]
    );
    if (rows[0]) return Number(rows[0].id);

    // SKU composto: "CAMISA-AZUL-M" → produto "CAMISA-AZUL" + tamanho "M".
    const separatorIndex = Math.max(sku.lastIndexOf('-'), sku.lastIndexOf('_'));
    if (separatorIndex > 0) {
      const prefix = sku.slice(0, separatorIndex);
      const { rows: prefixRows } = await db.query<ProdutoRow>(
        `SELECT id, sku FROM produtos
         WHERE upper(btrim(sku)) = upper(btrim($1))
         ORDER BY id ASC
         LIMIT 1`,
        [prefix]
      );
      if (prefixRows[0]) return Number(prefixRows[0].id);
    }
  }

  const title = clean(input.title);
  if (title) {
    const { rows } = await db.query<ProdutoRow>(
      `SELECT id, sku FROM produtos
       WHERE upper(btrim(nome)) = upper(btrim($1))
       ORDER BY id ASC
       LIMIT 1`,
      [title]
    );
    if (rows[0]) return Number(rows[0].id);
  }

  return null;
}

/**
 * Casa um item de pedido com produto + tamanho do ERP. Nunca lança: uma
 * consulta que falhe no casamento não pode impedir a venda de entrar.
 */
export async function matchCatalogItem(db: ConnectorDatabase, input: CatalogMatchInput): Promise<CatalogMatch> {
  try {
    const productId = await matchProduto(db, input);
    const sku = clean(input.sku);
    const separatorIndex = Math.max(sku.lastIndexOf('-'), sku.lastIndexOf('_'));
    const skuSuffix = separatorIndex > 0 ? sku.slice(separatorIndex + 1) : '';
    const sizeId =
      (await matchTamanho(db, input.sizeLabel)) ?? (await matchTamanho(db, skuSuffix)) ?? (await matchTamanho(db, input.variacaoExterna));
    return { productId, sizeId };
  } catch (error) {
    console.warn('⚠️  Casamento de catálogo indisponível (item entra sem vínculo):', error instanceof Error ? error.message : error);
    return { productId: null, sizeId: null };
  }
}
