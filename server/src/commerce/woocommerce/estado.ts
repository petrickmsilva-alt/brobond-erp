// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › ESTADO DE SINCRONIZAÇÃO POR LOJA.
//
// Uma linha por (empresa, loja) em `woocommerce_sync_state`. É a ÁGUA-MARCA
// incremental da importação de pedidos e o retrato operacional da loja: última
// sincronização de estoque, última publicação, último erro real e tentativas.
//
// A linha da RETAIL e a da WHOLESALE são INDEPENDENTES: uma falha em uma não
// toca a outra (é o que a missão exige — "uma loja indisponível não deve
// interromper a outra").
// ============================================================================
import type { Row, Tx } from '../../store';
import { getStore } from '../../services';
import type { StoreKey } from './registry';
import { R_WOO_SYNC_STATE } from './vinculos';

export type EstadoSincronizacao = {
  empresa_id: number;
  store_key: StoreKey;
  ultimo_pedido_em: string | null;
  ultima_sincronizacao_estoque_em: string | null;
  ultima_publicacao_em: string | null;
  ultimo_erro: string | null;
  tentativas: number;
};

async function linhaDe(empresaId: number, store: StoreKey, tx?: Tx): Promise<Row | null> {
  return getStore().findOneWhere(R_WOO_SYNC_STATE(), { empresa_id: empresaId, store_key: store }, tx);
}

/** Lê o estado da loja; cria a linha vazia na primeira leitura (idempotente). */
export async function estadoDaStore(empresaId: number, store: StoreKey, tx?: Tx): Promise<EstadoSincronizacao> {
  const s = getStore();
  const linha = (await linhaDe(empresaId, store, tx)) ?? (await s.insert(R_WOO_SYNC_STATE(), { empresa_id: empresaId, store_key: store }, tx));
  return {
    empresa_id: empresaId,
    store_key: store,
    ultimo_pedido_em: linha.ultimo_pedido_em ? String(linha.ultimo_pedido_em) : null,
    ultima_sincronizacao_estoque_em: linha.ultima_sincronizacao_estoque_em ? String(linha.ultima_sincronizacao_estoque_em) : null,
    ultima_publicacao_em: linha.ultima_publicacao_em ? String(linha.ultima_publicacao_em) : null,
    ultimo_erro: linha.ultimo_erro ? String(linha.ultimo_erro) : null,
    tentativas: Number(linha.tentativas || 0),
  };
}

/**
 * Atualiza o estado com um patch parcial. `erro` (quando informado) grava a
 * mensagem de domínio e soma uma tentativa; sem erro, limpa o último erro.
 */
export async function registrarSincronizacao(
  empresaId: number,
  store: StoreKey,
  patch: Partial<Pick<EstadoSincronizacao, 'ultimo_pedido_em' | 'ultima_sincronizacao_estoque_em' | 'ultima_publicacao_em'>> & { erro?: string | null },
  tx?: Tx
): Promise<void> {
  const s = getStore();
  const atual = await estadoDaStore(empresaId, store, tx);
  const dados: Record<string, unknown> = {};
  if (patch.ultimo_pedido_em !== undefined) dados.ultimo_pedido_em = patch.ultimo_pedido_em;
  if (patch.ultima_sincronizacao_estoque_em !== undefined) dados.ultima_sincronizacao_estoque_em = patch.ultima_sincronizacao_estoque_em;
  if (patch.ultima_publicacao_em !== undefined) dados.ultima_publicacao_em = patch.ultima_publicacao_em;
  if (patch.erro !== undefined) {
    dados.ultimo_erro = patch.erro ? String(patch.erro).slice(0, 500) : null;
    dados.tentativas = patch.erro ? atual.tentativas + 1 : 0;
  }
  if (!Object.keys(dados).length) return;
  const linha = await linhaDe(empresaId, store, tx);
  if (linha) await s.update(R_WOO_SYNC_STATE(), Number(linha.id), dados, tx);
  else await s.insert(R_WOO_SYNC_STATE(), { empresa_id: empresaId, store_key: store, ...dados }, tx);
}

/**
 * Água-marca da importação incremental: o instante do pedido mais recente já
 * importado. Nunca retrocede (o `max` protege contra relógio fora de ordem).
 */
export async function avancarAguaMarcaPedidos(empresaId: number, store: StoreKey, instante: string, tx?: Tx): Promise<void> {
  const atual = await estadoDaStore(empresaId, store, tx);
  const anterior = atual.ultimo_pedido_em ? Date.parse(atual.ultimo_pedido_em) : null;
  const novo = Date.parse(instante);
  if (!Number.isFinite(novo)) return;
  if (anterior != null && Number.isFinite(anterior) && novo <= anterior) return;
  await registrarSincronizacao(empresaId, store, { ultimo_pedido_em: new Date(novo).toISOString() }, tx);
}
