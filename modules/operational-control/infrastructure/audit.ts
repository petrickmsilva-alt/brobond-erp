// ============================================================================
// CONTROL PLANE › INFRA › AUDITORIA OPERACIONAL (cadeia de hashes)
//
// Trilha própria (`operational_audit_events`) com ENCADEAMENTO por operação:
// cada evento assina SHA-256(hash_anterior | payload canônico). Editar um
// evento quebra o hash dele; remover um quebra a cadeia do seguinte.
//
// Complementa a auditoria global (`store.audit`) com o detalhe operacional —
// mesmo padrão de `logistics_audit_logs`. NUNCA grava token, secret, senha ou
// corpo remoto bruto; o payload é MINIMIZADO.
// ============================================================================
import { createHash } from 'node:crypto';
import { getStore } from '../../../server/src/services';
import { EMPRESA_PADRAO } from '../../../server/src/empresa';
import { R_AUDIT_EVENTS } from './resources';
import type { Tx } from '../../../server/src/store';

export type EventoOperacional =
  | 'oauth.consent'
  | 'oauth.token_issued'
  | 'oauth.token_revoked'
  | 'operation.requested'
  | 'operation.rejected'
  | 'operation.approved'
  | 'operation.cancelled'
  | 'operation.expired'
  | 'operation.dispatched'
  | 'operation.dispatch_failed'
  | 'workflow.started'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'github.communication_failed'
  | 'access.denied'
  | 'replay.blocked';

export type EntradaAuditoria = {
  empresaId: number;
  operationId?: number | null;
  actorId?: number | null;
  eventType: EventoOperacional;
  payload?: Record<string, unknown>;
  /** Hash do último evento DESTA operação (encadeia a trilha). */
  previousHash?: string | null;
};

/** JSON canônico (chaves ordenadas) — estável entre Postgres (JSONB) e memória. */
export function jsonCanonico(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jsonCanonico).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + jsonCanonico(obj[k]))
      .join(',') +
    '}'
  );
}

/** Assinatura do evento: SHA-256(hash_anterior | payload canônico do evento). */
export function hashEvento(previousHash: string, entrada: EntradaAuditoria, occurredAt: string): string {
  const assinavel = jsonCanonico({
    empresa_id: entrada.empresaId,
    operation_id: entrada.operationId ?? null,
    actor_id: entrada.actorId ?? null,
    event_type: entrada.eventType,
    payload: entrada.payload ?? {},
    occurred_at: occurredAt,
  });
  return createHash('sha256').update(`${previousHash}|${assinavel}`).digest('hex');
}

/**
 * Grava um evento encadeado. A cadeia é POR OPERAÇÃO (operation_id); eventos
 * globais (sem operação) encadeiam entre si por empresa. Nunca lança por falha
 * de auditoria — a operação de negócio já concluída não pode ser derrubada por
 * um erro de trilha (mesma regra de logistics/audit.ts).
 */
export async function auditarOperacao(entrada: EntradaAuditoria, tx?: Tx): Promise<void> {
  try {
    // Eventos globais (token revogado, acesso negado) não têm empresa de
    // negócio: `empresa_id` é NOT NULL com FK para `empresas`, então um 0
    // quebraria a FK no PostgreSQL. Usa a empresa padrão do ERP.
    const empresaId = Number(entrada.empresaId) > 0 ? Number(entrada.empresaId) : EMPRESA_PADRAO;
    const anterior = await ultimoHash(empresaId, entrada.operationId ?? null, tx);
    const occurredAt = new Date().toISOString();
    const eventHash = hashEvento(anterior ?? '', { ...entrada, empresaId }, occurredAt);
    await getStore().insert(
      R_AUDIT_EVENTS,
      {
        empresa_id: empresaId,
        operation_id: entrada.operationId ?? null,
        actor_id: entrada.actorId ?? null,
        event_type: entrada.eventType,
        payload: entrada.payload ?? {},
        occurred_at: occurredAt,
        previous_hash: anterior,
        event_hash: eventHash,
      },
      tx
    );
  } catch (e) {
    console.error('[operational:audit] falha ao gravar auditoria operacional', {
      event_type: entrada.eventType,
      erro: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Último hash da cadeia (da operação, ou da empresa quando global). O store não
 * filtra por `IS NULL` (valor nulo no filtro é IGNORADO), então a cadeia global
 * é resolvida por varredura: sem isso, um evento global encadearia no último
 * evento de QUALQUER operação da empresa e a trilha global ficaria mentirosa.
 */
async function ultimoHash(empresaId: number, operationId: number | null, tx?: Tx): Promise<string | null> {
  const store = getStore();
  if (operationId !== null) {
    const rows = await store.list(R_AUDIT_EVENTS, { page: 1, pageSize: 1, sort: 'id', dir: 'desc', filter: { operation_id: operationId } }, tx);
    const ultimo = rows.rows[0];
    return ultimo ? String(ultimo.event_hash) : null;
  }
  // Cadeia global: o store IGNORA filtro com valor nulo, então `operation_id IS
  // NULL` é resolvido por varredura. Uma janela fixa mentiria quando houvesse
  // mais eventos de OPERAÇÃO que a página recentes que o último global — a
  // trilha global encadearia no hash errado (ou recomeçaria). Paginamos até
  // achar o primeiro evento global, sem depender de quantos eventos existam.
  const pageSize = 500;
  for (let page = 1; ; page++) {
    const res = await store.list(R_AUDIT_EVENTS, { page, pageSize, sort: 'id', dir: 'desc', filter: { empresa_id: empresaId } }, tx);
    const global = res.rows.find((r) => r.operation_id === null || r.operation_id === undefined);
    if (global) return String(global.event_hash);
    if (res.rows.length < pageSize) return null;
  }
}

/** Normaliza o instante para o MESMO texto gravado (ISO UTC), venha do PG ou da memória. */
function ocorridoEm(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Verifica a cadeia de uma operação (tamper-evidence). */
export async function verificarCadeiaOperacao(operationId: number): Promise<{ ok: boolean; total: number; quebras: number[] }> {
  const store = getStore();
  // Varredura COMPLETA por páginas (nunca uma janela fixa): uma trilha maior que
  // a página seria "verificada" só em parte e o resultado mentiria.
  const pageSize = 500;
  let anterior: string | null = null;
  const quebras: number[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const lote = await store.list(R_AUDIT_EVENTS, { page, pageSize, sort: 'id', dir: 'asc', filter: { operation_id: operationId } });
    for (const row of lote.rows) {
      total++;
      const entrada: EntradaAuditoria = {
        empresaId: Number(row.empresa_id),
        operationId: row.operation_id === null ? null : Number(row.operation_id),
        actorId: row.actor_id === null ? null : Number(row.actor_id),
        eventType: row.event_type as EventoOperacional,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      };
      // O PG devolve TIMESTAMPTZ como Date; `jsonCanonico` serializaria um Date
      // como `{}` e a recomputação divergiria do hash gravado. Normalizamos para
      // o MESMO texto ISO usado na escrita.
      const esperado = hashEvento(anterior ?? '', entrada, ocorridoEm(row.occurred_at));
      if (esperado !== String(row.event_hash) || (row.previous_hash ?? null) !== anterior) quebras.push(Number(row.id));
      anterior = String(row.event_hash);
    }
    if (lote.rows.length < pageSize) break;
  }
  return { ok: quebras.length === 0, total, quebras };
}
