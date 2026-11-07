// ============================================================================
// MOTOR DE FRETE › INFRA › INBOX DE WEBHOOKS DE TRANSPORTADORA
//
// O endpoint NÃO processa: grava a entrega de forma IDEMPOTENTE aqui e enfileira
// o trabalho no `commerce_outbox` de sempre (ação `logistics-webhook`). O inbox
// é o registro DURÁVEL e a memória da integração; o outbox é a fila com claim
// CAS, retry e backoff — nenhuma fila paralela.
//
// IDEMPOTÊNCIA POR OPERADOR:
//   • com ID de entrega → (empresa, operador, entrega);
//   • sem ID de entrega → (empresa, operador, tipo, hash do corpo). Um corpo
//     DIFERENTE é evento novo; um corpo IDÊNTICO é a MESMA entrega reentregue.
//
// RECUPERAÇÃO: re-enfileira o que foi gravado mas nunca entrou na fila e o que
// está em `erro` após esgotar as tentativas do outbox.
// ============================================================================
import { createHash } from 'node:crypto';
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { enfileirarOutbox } from '../../../server/src/commerce/outbox';
import { R_WEBHOOK_INBOX } from './resources';
import { minimizarPayload } from './webhookSeguranca';
import type { Row, Tx } from '../../../server/src/store';

const R_OUTBOX = () => getResource('commerce_outbox')!;

export function chaveWebhook(provider: string, entregaId: number): string {
  return `logistics-webhook:${provider}:${entregaId}`;
}

export function hashCorpo(corpo: Buffer | string): string {
  const bytes = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export type DadosEntrega = {
  provider: string;
  event_type: string | null;
  external_delivery_id: string | null;
  payload: unknown;
  payload_hash: string;
  assinatura_ok: boolean;
  correlation_id: string | null;
};

async function entregaExistente(empresaId: number, dados: DadosEntrega, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  if (dados.external_delivery_id) {
    return s.findOneWhere(R_WEBHOOK_INBOX(), { empresa_id: empresaId, provider: dados.provider, external_delivery_id: dados.external_delivery_id }, tx);
  }
  return s.findOneWhere(R_WEBHOOK_INBOX(), { empresa_id: empresaId, provider: dados.provider, event_type: dados.event_type, payload_hash: dados.payload_hash }, tx);
}

function ehConflitoUnico(e: unknown): boolean {
  const pg = e as { code?: string; cause?: { code?: string } };
  return pg?.code === '23505' || pg?.cause?.code === '23505';
}

export type EntregaRegistrada = { id: number; duplicado: boolean; outbox_id: number | null; status: string };

/** Registra a entrega de forma idempotente e enfileira o processamento. */
export async function registrarEntrega(empresaId: number, dados: DadosEntrega, tx?: Tx): Promise<EntregaRegistrada> {
  const s = getStore();
  const payload = minimizarPayload(dados.payload);
  const jaExiste = await entregaExistente(empresaId, dados, tx);
  if (jaExiste) return { id: Number(jaExiste.id), duplicado: true, outbox_id: jaExiste.outbox_id != null ? Number(jaExiste.outbox_id) : null, status: String(jaExiste.status) };

  let linha: Row;
  try {
    linha = await s.insert(
      R_WEBHOOK_INBOX(),
      {
        empresa_id: empresaId,
        provider: dados.provider,
        external_delivery_id: dados.external_delivery_id,
        event_type: dados.event_type,
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
    if (ehConflitoUnico(e)) {
      const existente = await entregaExistente(empresaId, dados, tx);
      if (existente) return { id: Number(existente.id), duplicado: true, outbox_id: existente.outbox_id != null ? Number(existente.outbox_id) : null, status: String(existente.status) };
    }
    throw e;
  }

  if (!dados.assinatura_ok) return { id: Number(linha.id), duplicado: false, outbox_id: null, status: 'rejeitado' };

  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveWebhook(dados.provider, Number(linha.id)),
    { acao: 'logistics-webhook', provider: dados.provider, inbox_id: Number(linha.id) },
    tx
  );
  await s.update(R_WEBHOOK_INBOX(), Number(linha.id), { outbox_id: Number(evento.id), status: 'enfileirado' }, tx).catch(() => undefined);
  return { id: Number(linha.id), duplicado: false, outbox_id: Number(evento.id), status: 'enfileirado' };
}

export async function entregaPorId(empresaId: number, id: number, tx?: Tx): Promise<Row | null> {
  return getStore().findOneWhere(R_WEBHOOK_INBOX(), { id, empresa_id: empresaId }, tx);
}

export async function listarEntregas(empresaId: number, opcoes: { provider?: string; status?: string; pageSize?: number } = {}, tx?: Tx): Promise<Row[]> {
  const filtro: Record<string, unknown> = { empresa_id: empresaId };
  if (opcoes.provider) filtro.provider = opcoes.provider;
  if (opcoes.status) filtro.status = opcoes.status;
  const out = await getStore().list(R_WEBHOOK_INBOX(), { page: 1, pageSize: Math.min(5000, opcoes.pageSize ?? 500), filter: filtro, sort: 'id', dir: 'desc' }, tx);
  return out.rows;
}

export function contarEntregas(entregas: Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entregas) {
    const status = String(e.status || 'recebido');
    out[status] = (out[status] ?? 0) + 1;
  }
  return out;
}

export async function marcarProcessamento(
  empresaId: number,
  inboxId: number,
  desfecho: { status: 'processado' | 'erro'; erro?: string | null },
  tx?: Tx
): Promise<void> {
  const s = getStore();
  const linha = await entregaPorId(empresaId, inboxId, tx);
  if (!linha) return;
  const dados: Record<string, unknown> = {
    status: desfecho.status,
    attempts: Number(linha.attempts || 0) + 1,
    last_error: desfecho.erro ? String(desfecho.erro).slice(0, 500) : null,
    atualizado_em: new Date().toISOString(),
  };
  if (desfecho.status === 'processado') dados.processed_at = new Date().toISOString();
  await s.update(R_WEBHOOK_INBOX(), Number(linha.id), dados, tx);
}

/** Re-arma um evento de webhook TERMINAL (mesmo CAS do lote recorrente). */
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

/** Re-enfileira UMA entrega (ação administrativa "reprocessar"). Idempotente. */
export async function reenfileirarEntrega(empresaId: number, inboxId: number): Promise<boolean> {
  const s = getStore();
  const entrega = await s.findOneWhere(R_WEBHOOK_INBOX(), { id: inboxId, empresa_id: empresaId });
  if (!entrega) return false;
  const evento = await enfileirarOutbox(empresaId, 'sincronizacao', chaveWebhook(String(entrega.provider), inboxId), {
    acao: 'logistics-webhook',
    provider: String(entrega.provider),
    inbox_id: inboxId,
  });
  const rearmado = await rearmarEventoWebhook(evento);
  await s.update(R_WEBHOOK_INBOX(), inboxId, { status: 'enfileirado', outbox_id: Number(rearmado.id), processed_at: null, last_error: null, atualizado_em: new Date().toISOString() });
  return true;
}

export type ResultadoRecuperacao = { reenfileirados: number; erros: number };

/** Recupera entregas presas (gravadas mas não enfileiradas) ou em erro terminal. */
export async function recuperarEntregasPendentes(empresaId: number): Promise<ResultadoRecuperacao> {
  const s = getStore();
  const presas = await listarEntregas(empresaId, { status: 'recebido', pageSize: 500 });
  const comErro = await listarEntregas(empresaId, { status: 'erro', pageSize: 500 });
  let reenfileirados = 0;
  let erros = 0;
  for (const entrega of [...presas, ...comErro]) {
    try {
      const evento = await enfileirarOutbox(empresaId, 'sincronizacao', chaveWebhook(String(entrega.provider), Number(entrega.id)), {
        acao: 'logistics-webhook',
        provider: String(entrega.provider),
        inbox_id: Number(entrega.id),
      });
      await s.update(R_WEBHOOK_INBOX(), Number(entrega.id), { outbox_id: Number(evento.id), status: 'enfileirado', last_error: null }).catch(() => undefined);
      reenfileirados += 1;
    } catch {
      erros += 1;
    }
  }
  return { reenfileirados, erros };
}
