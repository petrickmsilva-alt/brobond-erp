// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › VÍNCULOS EXTERNOS.
//
// Um produto do ERP pode ter UM vínculo na RETAIL e OUTRO na WHOLESALE; uma
// variação (tamanho) tem o próprio `external_variation_id`. O vínculo é a
// MEMÓRIA da integração: sem ele, republicar criaria um SEGUNDO anúncio e a
// sincronização de estoque atualizaria o produto errado.
//
// `external_variation_id` NULL identifica o vínculo do PRODUTO (pai ou simples);
// não-nulo, o da VARIAÇÃO. É essa distinção que faz a unicidade NULL-safe
// funcionar: dois índices parciais cobrem os dois casos (ver migration 0100).
//
// Estes recursos são INTERNOS (sem CRUD genérico): o operador vê os vínculos no
// painel por loja, mas nunca os cria/edita à mão — quem grava é a publicação.
// ============================================================================
import type { Row, Tx } from '../../store';
import { getStore } from '../../services';
import { getResource } from '../../resources';
import type { StoreKey } from './registry';

// Recursos declarados em `resources.ts` (fonte única do CRUD/inventário).
const R_WOO_LINKS = () => getResource('woocommerce_product_links')!;
export const R_WOO_SYNC_STATE = () => getResource('woocommerce_sync_state')!;

export type Vinculo = {
  id: number;
  empresa_id: number;
  store_key: StoreKey;
  produto_id: number;
  external_product_id: string;
  external_variation_id: string | null;
  sku: string | null;
  status: string;
};

/** Vínculo do PRODUTO (simples ou pai) na loja, se existir. */
export async function vinculoDoProduto(
  empresaId: number,
  store: StoreKey,
  produtoId: number,
  tx?: Tx
): Promise<Row | null> {
  const s = getStore();
  const linhas = await s.list(
    R_WOO_LINKS(),
    { page: 1, pageSize: 200, filter: { empresa_id: empresaId, store_key: store, produto_id: produtoId } },
    tx
  );
  return linhas.rows.find((r) => r.external_variation_id == null || String(r.external_variation_id) === '') ?? null;
}

/**
 * Vínculo de VARIAÇÃO do produto-variante `produtoId` (o filho do pai). O
 * `external_variation_id` ainda é desconhecido antes da primeira publicação —
 * por isso a busca é por (empresa, loja, produto) + `external_variation_id`
 * NÃO nulo, e não pelo id externo.
 */
export async function vinculoDeVariacao(
  empresaId: number,
  store: StoreKey,
  produtoId: number,
  tx?: Tx
): Promise<Row | null> {
  const s = getStore();
  const linhas = await s.list(
    R_WOO_LINKS(),
    { page: 1, pageSize: 200, filter: { empresa_id: empresaId, store_key: store, produto_id: produtoId } },
    tx
  );
  return linhas.rows.find((r) => r.external_variation_id != null && String(r.external_variation_id) !== '') ?? null;
}

/**
 * Grava/atualiza o vínculo de forma IDEMPOTENTE.
 *
 * A busca é pelo (empresa, loja, produto) + `external_variation_id` exato —
 * nunca pelo ID externo apenas: um ID da RETAIL jamais pode ser confundido com
 * um da WHOLESALE. Se já existe vínculo, atualiza os IDs externos; senão cria.
 */
export async function registrarVinculo(
  empresaId: number,
  store: StoreKey,
  produtoId: number,
  dados: { external_product_id: string; external_variation_id?: string | null; sku?: string | null; status?: string },
  tx?: Tx
): Promise<Row> {
  const s = getStore();
  const variacao = dados.external_variation_id == null || String(dados.external_variation_id) === '' ? null : String(dados.external_variation_id);
  const existente = variacao
    ? await vinculoDeVariacao(empresaId, store, produtoId, tx)
    : await vinculoDoProduto(empresaId, store, produtoId, tx);
  const patch = {
    empresa_id: empresaId,
    store_key: store,
    produto_id: produtoId,
    external_product_id: String(dados.external_product_id),
    external_variation_id: variacao,
    sku: dados.sku ? String(dados.sku) : null,
    status: dados.status ?? 'LINKED',
    synced_at: new Date().toISOString(),
  };
  if (existente) {
    return (await s.update(R_WOO_LINKS(), Number(existente.id), patch, tx))!;
  }
  return s.insert(R_WOO_LINKS(), patch, tx);
}

/** Vínculos de uma loja (para o painel e para a reconciliação). */
export async function listarVinculos(
  empresaId: number,
  store: StoreKey,
  opcoes: { status?: string; pageSize?: number } = {},
  tx?: Tx
): Promise<Row[]> {
  const s = getStore();
  const filtro: Record<string, unknown> = { empresa_id: empresaId, store_key: store };
  if (opcoes.status) filtro.status = opcoes.status;
  const out = await s.list(
    R_WOO_LINKS(),
    { page: 1, pageSize: Math.min(20000, opcoes.pageSize ?? 5000), filter: filtro, sort: 'produto_id', dir: 'asc' },
    tx
  );
  return out.rows;
}

/** Contagem por status, para o painel (nunca inventa: lê o que existe). */
export function contarPorStatus(vinculos: Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of vinculos) {
    const status = String(v.status || 'LINKED');
    out[status] = (out[status] ?? 0) + 1;
  }
  return out;
}
