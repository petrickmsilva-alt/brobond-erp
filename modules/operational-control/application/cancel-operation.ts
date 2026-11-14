// ============================================================================
// CONTROL PLANE › APLICAÇÃO › CANCELAR OPERAÇÃO
//
// Só operações AINDA NÃO DESPACHADAS podem ser canceladas. Depois de
// `dispatching`, o resultado pode ser desconhecido — quem resolve é a
// reconciliação, nunca um cancelamento que finge que nada foi enviado.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { estadoEfetivo, foiDespachado, TERMINAIS, exigirTransicao } from '../domain/operation-status';
import { operacaoPorPublicId, transicionarStatus } from '../infrastructure/operation.repository';
import { auditarOperacao } from '../infrastructure/audit';
import type { OperationalActor, OperationRow } from '../domain/operation';

export type CancelarEntrada = { operationId: string; reason?: string };

export async function cancelarOperacao(actor: OperationalActor, entrada: CancelarEntrada): Promise<OperationRow> {
  // Cancelar é uma ação de gestão: exige o escopo de solicitação e perfil admin.
  exigirAutorizacao(actor, 'workflow.request');

  const op = await operacaoPorPublicId(actor.empresa_id, entrada.operationId);
  if (!op) throw new OperationalError('NAO_ENCONTRADO', 'Operação não encontrada.');

  const statusEfetivo = estadoEfetivo(op.status, op.expires_at);
  if (foiDespachado(statusEfetivo) || TERMINAIS.includes(statusEfetivo)) {
    throw new OperationalError('CONFLITO', `A operação está em "${statusEfetivo}" e não pode ser cancelada.`);
  }
  exigirTransicao(statusEfetivo, 'cancelled');

  const atualizada = await transicionarStatus(actor.empresa_id, Number(op.id), op.status, 'cancelled');
  if (!atualizada) throw new OperationalError('CONFLITO', 'A operação mudou de estado durante o cancelamento.');

  await auditarOperacao({
    empresaId: actor.empresa_id,
    operationId: Number(op.id),
    actorId: actor.id,
    eventType: 'operation.cancelled',
    payload: { motivo: String(entrada.reason ?? '').slice(0, 200) },
  });

  return atualizada;
}
