// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › OUTBOX POR LOJA.
//
// O outbox existente (commerce_outbox) é a fila at-least-once com claim CAS e
// retry com backoff. O modo multi-loja NÃO cria uma segunda fila: ele passa a
// levar `store_key` no payload e na coluna (migration 0100, aditiva).
//
// A CHAVE de idempotência inclui a loja — `woo-estoque:RETAIL` e
// `woo-estoque:WHOLESALE` são eventos DISTINTOS. Sem isso, o índice único
// (empresa, tipo, chave) faria a segunda loja ser engolida pela primeira.
//
// Nenhuma chamada externa acontece dentro da transação: o enfileiramento só
// grava a linha; quem fala com a loja é o worker.
// ============================================================================
import { getStore } from '../../services';
import { enfileirarOutbox, type TipoOutbox } from '../outbox';
import { getResource } from '../../resources';
import { HttpError } from '../../errors';
import type { Row } from '../../store';
import { STORE_KEYS, ehStoreKey, type StoreKey } from './registry';
import { importarPedidosDaLoja } from './pedidos';
import { sincronizarEstoqueDaLoja } from './estoque';
import { publicarProdutoNaLoja } from './publicacao';
import { exigirConfigStore, dryRun } from './registry';

const R_OUTBOX = () => getResource('commerce_outbox')!;

/** Chave idempotente POR LOJA (a loja é parte da identidade do evento). */
export function chaveStore(acao: string, store: StoreKey, sufixo: string): string {
  return `${acao}:${store}:${sufixo}`;
}

/**
 * Enfileira a sincronização de estoque de UMA loja. O payload carrega
 * `store_key` — o worker resolve a config daquela loja, e não a global.
 */
export async function enfileirarEstoqueDaLoja(empresaId: number, store: StoreKey): Promise<Row> {
  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveStore('woo-estoque', store, 'lote'),
    { acao: 'woo-estoque', store_key: store }
  );
  await marcarStoreKey(evento, store);
  return evento;
}

/** Enfileira a importação de pedidos de UMA loja. */
export async function enfileirarPedidosDaLoja(empresaId: number, store: StoreKey): Promise<Row> {
  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveStore('woo-pedidos', store, 'lote'),
    { acao: 'woo-pedidos', store_key: store }
  );
  await marcarStoreKey(evento, store);
  return evento;
}

/**
 * Enfileira a publicação de um produto em UMA loja. A chave é por
 * (loja, produto) — publicar o mesmo produto nas duas lojas gera dois eventos.
 */
export async function enfileirarPublicacaoDaLoja(empresaId: number, store: StoreKey, produtoId: number): Promise<Row> {
  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveStore('woo-publicacao', store, String(produtoId)),
    { acao: 'woo-publicacao', store_key: store, produto_id: produtoId }
  );
  await marcarStoreKey(evento, store);
  return evento;
}

/**
 * Grava `store_key` na COLUNA (o payload é JSON; a coluna permite índice e
 * relatório). Nunca falha o enfileiramento: a coluna é um índice operacional.
 */
async function marcarStoreKey(evento: Row, store: StoreKey): Promise<void> {
  if (String(evento.store_key || '') === store) return;
  await getStore()
    .update(R_OUTBOX(), Number(evento.id), { store_key: store })
    .catch(() => undefined);
}

/**
 * Processa UM evento multi-loja. Devolve `true` quando o evento foi tratado
 * (sucesso ou erro terminal) e `false` quando a loja está desabilitada — nesse
 * caso o evento permanece para o dono da fila decidir.
 */
export async function processarEventoStore(payload: Record<string, unknown>, empresaId: number): Promise<'ok' | 'ignorado'> {
  const store = payload.store_key;
  if (!ehStoreKey(store)) return 'ignorado';
  const acao = String(payload.acao || '');
  const cfg = exigirConfigStore(store);
  if (cfg.empresaId !== empresaId) {
    throw new HttpError(409, 'A loja não pertence à empresa do evento — sincronização recusada.');
  }
  if (dryRun()) return 'ok';

  if (acao === 'woo-estoque') {
    const r = await sincronizarEstoqueDaLoja(cfg, empresaId);
    if (!r.ok) throw new HttpError(502, r.erro || 'Falha ao sincronizar estoque.');
    return 'ok';
  }
  if (acao === 'woo-pedidos') {
    const r = await importarPedidosDaLoja(cfg, empresaId, { incremental: true, actor: { id: null, name: 'Commerce outbox' } });
    if (!r.ok) throw new HttpError(502, r.erro || 'Falha ao importar pedidos.');
    return 'ok';
  }
  if (acao === 'woo-publicacao') {
    const produtoId = Number(payload.produto_id);
    if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(409, 'Publicação sem produto.');
    await publicarProdutoNaLoja(cfg, empresaId, produtoId);
    return 'ok';
  }
  return 'ignorado';
}

/** Todas as lojas habilitadas com a empresa resolvida (para o agendado). */
export function lojasDaEmpresa(): { cfg: ReturnType<typeof exigirConfigStore>; empresaId: number }[] {
  const out: { cfg: ReturnType<typeof exigirConfigStore>; empresaId: number }[] = [];
  for (const store of STORE_KEYS) {
    try {
      const cfg = exigirConfigStore(store);
      out.push({ cfg, empresaId: cfg.empresaId });
    } catch {
      /* loja desabilitada ou incompleta: as outras seguem */
    }
  }
  return out;
}

export type { TipoOutbox };
