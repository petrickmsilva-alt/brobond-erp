// ============================================================================
// CONTROL PLANE › APLICAÇÃO › REJEITAR OPERAÇÃO
//
// A rejeição encerra a operação (terminal) e fica registrada com o motivo.
// Também é humana: o agente MCP não decide.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { exigirAprovadorHumano } from '../domain/approval-policy';
import { estadoEfetivo, exigirTransicao } from '../domain/operation-status';
import { operacaoPorPublicId, transicionarStatus } from '../infrastructure/operation.repository';
import { registrarDecisao } from '../infrastructure/approval.repository';
import { auditarOperacao } from '../infrastructure/audit';
import type { OperationalActor, OperationRow } from '../domain/operation';

export type RejeitarEntrada = { operationId: string; reason: string };

export async function rejeitarOperacao(actor: OperationalActor, entrada: RejeitarEntrada): Promise<OperationRow> {
  exigirAutorizacao(actor, 'workflow.approve');
  exigirAprovadorHumano(actor);

  const motivo = String(entrada.reason ?? '').trim();
  if (!motivo) throw new OperationalError('PARAMETRO_INVALIDO', 'O motivo da rejeição é obrigatório.', { reason: 'obrigatório' });

  const op = await operacaoPorPublicId(actor.empresa_id, entrada.operationId);
  if (!op) throw new OperationalError('NAO_ENCONTRADO', 'Operação não encontrada.');

  const statusEfetivo = estadoEfetivo(op.status, op.expires_at);
  exigirTransicao(statusEfetivo, 'rejected');

  await registrarDecisao({
    empresaId: actor.empresa_id,
    operationId: Number(op.id),
    approvedBy: actor.id,
    decision: 'reject',
    parametersHash: String(op.parameters_hash),
    confirmation: null,
    reason: motivo,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const atualizada = await transicionarStatus(actor.empresa_id, Number(op.id), op.status, 'rejected');
  if (!atualizada) throw new OperationalError('CONFLITO', 'A operação mudou de estado durante a rejeição.');

  await auditarOperacao({
    empresaId: actor.empresa_id,
    operationId: Number(op.id),
    actorId: actor.id,
    eventType: 'operation.rejected',
    payload: { motivo: motivo.slice(0, 200) },
  });

  return atualizada;
}
