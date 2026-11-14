// ============================================================================
// CONTROL PLANE › APLICAÇÃO › HISTÓRICO DE AUDITORIA
//
// Histórico AUTORIZADO: recorte por empresa do ator e payload minimizado —
// nunca token, secret ou senha. Exige o escopo `audit.read` e o perfil admin
// (o `exigirAutorizacao` aplica a interseção escopo ∩ perfil ∩ política).
// ============================================================================
import { getStore } from '../../../server/src/services';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { R_AUDIT_EVENTS } from '../infrastructure/resources';
import type { OperationalActor } from '../domain/operation';

export async function listarEventosAuditoria(actor: OperationalActor, limiteBruto: unknown): Promise<Record<string, unknown>[]> {
  exigirAutorizacao(actor, 'audit.read');
  const limite = Math.min(Math.max(Number(limiteBruto) || 20, 1), 100);
  const res = await getStore().list(R_AUDIT_EVENTS, { page: 1, pageSize: limite, sort: 'id', dir: 'desc', filter: { empresa_id: actor.empresa_id } });
  return res.rows.map((r) => ({
    id: Number(r.id),
    operation_id: r.operation_id === null || r.operation_id === undefined ? null : Number(r.operation_id),
    actor_id: r.actor_id === null || r.actor_id === undefined ? null : Number(r.actor_id),
    event_type: r.event_type,
    payload: r.payload ?? {},
    occurred_at: r.occurred_at,
  }));
}
