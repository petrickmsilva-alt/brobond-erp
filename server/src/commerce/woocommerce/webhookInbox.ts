// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › INBOX DE WEBHOOKS.
//
// O endpoint de webhook NÃO processa: ele grava a entrega de forma IDEMPOTENTE
// aqui e enfileira o trabalho no `commerce_outbox` de sempre (ação
// `woo-webhook`). O inbox é o registro DURÁVEL e a memória da integração; o
// outbox é a fila com claim CAS, retry e backoff.
//
// IDEMPOTÊNCIA POR LOJA (a loja faz parte da identidade):
//   • com ID de entrega (`X-WC-Webhook-Delivery-ID`) → (empresa, loja, entrega);
//   • sem ID de entrega → (empresa, loja, tópico, recurso externo, hash do
//     corpo). Um corpo DIFERENTE é um evento novo (nunca descarta atualização
//     legítima); um corpo IDÊNTICO é a MESMA entrega reentregue.
//
// O mesmo ID de entrega nas duas lojas gera DUAS linhas — a RETAIL e a
// WHOLESALE são independentes.
//
// RECUPERAÇÃO: `recuperarEntregasPendentes` re-enfileira o que foi gravado mas
// nunca entrou na fila (processo morreu entre o INSERT e o enfileiramento) e o
// que está em `erro` após esgotar as tentativas do outbox.
// ============================================================================
import { createHash } from 'node:crypto';
import { getStore } from '../../services';
import { getResource } from '../../resources';
import { HttpError } from '../../errors';
import type { Row, Tx } from '../../store';
import { enfileirarOutbox } from '../outbox';
import type { ConfigStore, StoreKey } from './registry';
import { ehStoreKey } from './registry';
import { minimizarPayload } from './webhookSeguranca';

const R_OUTBOX = () => getResource('commerce_outbox')!;
export const R_WOO_WEBHOOKS = () => getResource('woocommerce_webhook_events')!;

/** Chave idempotente do evento na fila (por loja e por entrega). */
export function chaveWebhook(store: StoreKey, entregaId: number): string {
  return `woo-webhook:${store}:${entregaId}`;
}

export type DadosEntrega = {
  topic: string;
  recurso: string;
  external_delivery_id: string | null;
  external_resource_id: string | null;
  payload: unknown;
  payload_hash: string;
  assinatura_ok: boolean;
  correlation_id: string | null;
};

/** Hash do corpo CRU (identidade da entrega quando não há delivery id). */
export function hashCorpo(corpo: Buffer | string): string {
  const bytes = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Busca a entrega já registrada pela chave de dedupe vigente. */
async function entregaExistente(empresaId: number, store: StoreKey, dados: DadosEntrega, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const base: Record<string, unknown> = { empresa_id: empresaId, store_key: store, topic: dados.topic };
  if (dados.external_delivery_id) {
    return s.findOneWhere(R_WOO_WEBHOOKS(), { empresa_id: empresaId, store_key: store, external_delivery_id: dados.external_delivery_id }, tx);
  }
  return s.findOneWhere(
    R_WOO_WEBHOOKS(),
    { ...base, external_resource_id: dados.external_resource_id, payload_hash: dados.payload_hash },
    tx
  );
}

function ehConflitoUnico(e: unknown): boolean {
  const pg = e as { code?: string; cause?: { code?: string } };
  return pg?.code === '23505' || pg?.cause?.code === '23505';
}

export type EntregaRegistrada = { id: number; duplicado: boolean; outbox_id: number | null; status: string };

/**
 * Registra a entrega de forma idempotente. Entrega já conhecida devolve a linha
 * existente com `duplicado: true` — nunca processa duas vezes o mesmo evento.
 */
export async function registrarEntrega(
  cfg: ConfigStore,
  empresaId: number,
  dados: DadosEntrega,
  tx?: Tx
): Promise<EntregaRegistrada> {
  const s = getStore();
  const payload = minimizarPayload(dados.payload);
  const jaExiste = await entregaExistente(empresaId, cfg.store_key, dados, tx);
  if (jaExiste) return { id: Number(jaExiste.id), duplicado: true, outbox_id: jaExiste.outbox_id != null ? Number(jaExiste.outbox_id) : null, status: String(jaExiste.status) };

  let linha: Row;
  try {
    linha = await s.insert(
      R_WOO_WEBHOOKS(),
      {
        empresa_id: empresaId,
        store_key: cfg.store_key,
        topic: dados.topic,
        recurso: dados.recurso,
        external_delivery_id: dados.external_delivery_id,
        external_resource_id: dados.external_resource_id,
        payload,
        payload_hash: dados.payload_hash,
        assinatura_ok: dados.assinatura_ok,
        status: dados.assinatura_ok ? 'recebido' : 'rejeitado',
        attempts: 0,
        correlation_id: dados.correlation_id,
        received_at: new Date().toISOString(),
        last_error: dados.assinatura_ok ? null : 'Assinatura inválida.',
      },
      tx
    );
  } catch (e) {
    // Corrida: outra requisição gravou a MESMA entrega e o índice único
    // arbitrou. Idempotência manda tratar como duplicado, nunca como erro.
    if (ehConflitoUnico(e)) {
      const existente = await entregaExistente(empresaId, cfg.store_key, dados, tx);
      if (existente) return { id: Number(existente.id), duplicado: true, outbox_id: existente.outbox_id != null ? Number(existente.outbox_id) : null, status: String(existente.status) };
    }
    throw e;
  }

  // Assinatura inválida: registrada para auditoria/métrica, NUNCA enfileirada.
  if (!dados.assinatura_ok) return { id: Number(linha.id), duplicado: false, outbox_id: null, status: 'rejeitado' };

  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveWebhook(cfg.store_key, Number(linha.id)),
    { acao: 'woo-webhook', store_key: cfg.store_key, webhook_event_id: Number(linha.id) },
    tx
  );
  await s
    .update(R_WOO_WEBHOOKS(), Number(linha.id), { outbox_id: Number(evento.id), status: 'enfileirado' }, tx)
    .catch(() => undefined);
  return { id: Number(linha.id), duplicado: false, outbox_id: Number(evento.id), status: 'enfileirado' };
}

/** Entrega por id, recortada pela empresa (isolamento entre empresas). */
export async function entregaPorId(empresaId: number, id: number, tx?: Tx): Promise<Row | null> {
  return getStore().findOneWhere(R_WOO_WEBHOOKS(), { id, empresa_id: empresaId }, tx);
}

/** Lista entregas de uma loja, opcionalmente por status. */
export async function listarEntregas(
  empresaId: number,
  store: StoreKey,
  opcoes: { status?: string; pageSize?: number } = {},
  tx?: Tx
): Promise<Row[]> {
  const filtro: Record<string, unknown> = { empresa_id: empresaId, store_key: store };
  if (opcoes.status) filtro.status = opcoes.status;
  const out = await getStore().list(R_WOO_WEBHOOKS(), {
    page: 1,
    pageSize: Math.min(5000, opcoes.pageSize ?? 500),
    filter: filtro,
    sort: 'id',
    dir: 'desc',
  }, tx);
  return out.rows;
}

/** Contagem por status (métrica do painel). */
export function contarEntregas(entregas: Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entregas) {
    const status = String(e.status || 'recebido');
    out[status] = (out[status] ?? 0) + 1;
  }
  return out;
}

export type ResultadoRecuperacao = { reenfileirados: number; erros: number };

/** Re-arma um evento de webhook TERMINAL (o mesmo CAS do lote recorrente). */
async function rearmarEventoWebhook(evento: Row): Promise<Row> {
  if (String(evento.estado) !== 'PROCESSADO') return evento;
  const rearmado = await getStore().tryUpdateIf(
    R_OUTBOX(),
    Number(evento.id),
    { estado: 'PROCESSADO', claim_versao: Number(evento.claim_versao || 0), empresa_id: Number(evento.empresa_id) },
    { estado: 'PENDENTE', tentativas: 0, ultimo_erro: null, proxima_tentativa_em: new Date().toISOString() }
  );
  return rearmado ?? evento;
}

/**
 * Re-enfileira UMA entrega específica (ação administrativa "reprocessar").
 * Devolve `false` quando a entrega não existe na loja/empresa.
 *
 * Reprocessar é IDEMPOTENTE: a importação de pedido não duplica (referência por
 * loja) e a publicação/estoque são rearmados com CAS. O inbox volta a
 * `enfileirado` para que a recuperação de presos volte a vê-la se o worker
 * falhar de novo.
 */
export async function reenfileirarEntrega(empresaId: number, store: StoreKey, entregaId: number): Promise<boolean> {
  const s = getStore();
  const entrega = await s.findOneWhere(R_WOO_WEBHOOKS(), { id: entregaId, empresa_id: empresaId, store_key: store });
  if (!entrega) return false;
  const evento = await enfileirarOutbox(empresaId, 'sincronizacao', chaveWebhook(store, entregaId), {
    acao: 'woo-webhook',
    store_key: store,
    webhook_event_id: entregaId,
  });
  const rearmado = await rearmarEventoWebhook(evento);
  await s.update(R_WOO_WEBHOOKS(), entregaId, {
    status: 'enfileirado',
    outbox_id: Number(rearmado.id),
    processed_at: null,
    last_error: null,
    atualizado_em: new Date().toISOString(),
  });
  return true;
}

/**
 * Recupera entregas que ficaram presas: gravadas mas nunca enfileiradas
 * (`recebido`), ou com o evento do outbox já terminal em ERRO (`erro`).
 *
 * Re-enfileira pelo MESMO id de entrega, então a chave idempotente do outbox
 * reusa a linha existente (o `rearmarRecorrente` do worker devolve o evento
 * terminal à fila). Nunca cria uma segunda linha de inbox.
 */
export async function recuperarEntregasPendentes(empresaId: number, store: StoreKey): Promise<ResultadoRecuperacao> {
  const s = getStore();
  const presas = await listarEntregas(empresaId, store, { status: 'recebido', pageSize: 500 });
  const comErro = await listarEntregas(empresaId, store, { status: 'erro', pageSize: 500 });
  let reenfileirados = 0;
  let erros = 0;
  for (const entrega of [...presas, ...comErro]) {
    try {
      const evento = await enfileirarOutbox(empresaId, 'sincronizacao', chaveWebhook(store, Number(entrega.id)), {
        acao: 'woo-webhook',
        store_key: store,
        webhook_event_id: Number(entrega.id),
      });
      await s
        .update(R_WOO_WEBHOOKS(), Number(entrega.id), { outbox_id: Number(evento.id), status: 'enfileirado', last_error: null })
        .catch(() => undefined);
      reenfileirados += 1;
    } catch {
      erros += 1;
    }
  }
  return { reenfileirados, erros };
}

/** Marca o desfecho do processamento no inbox (idempotente). */
export async function marcarProcessamento(
  empresaId: number,
  webhookEventId: number,
  desfecho: { status: 'processado' | 'erro'; erro?: string | null },
  tx?: Tx
): Promise<void> {
  const s = getStore();
  const linha = await entregaPorId(empresaId, webhookEventId, tx);
  if (!linha) return;
  const dados: Record<string, unknown> = {
    status: desfecho.status,
    attempts: Number(linha.attempts || 0) + 1,
    last_error: desfecho.erro ? String(desfecho.erro).slice(0, 500) : null,
    atualizado_em: new Date().toISOString(),
  };
  if (desfecho.status === 'processado') dados.processed_at = new Date().toISOString();
  await s.update(R_WOO_WEBHOOKS(), Number(linha.id), dados, tx);
}

/** Empresa da loja da entrega — recorte explícito para o worker. */
export function empresaDaLojaDaEntrega(entrega: Row): number {
  const n = Number(entrega.empresa_id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(409, 'Entrega de webhook sem empresa.');
  if (!ehStoreKey(entrega.store_key)) throw new HttpError(409, 'Entrega de webhook com loja desconhecida.');
  return n;
}
