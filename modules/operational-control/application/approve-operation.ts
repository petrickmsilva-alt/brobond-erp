// ============================================================================
// CONTROL PLANE › APLICAÇÃO › APROVAR OPERAÇÃO
//
// A aprovação é HUMANA, vinculada ao hash dos parâmetros e de USO ÚNICO.
// O agente MCP nunca aprova a própria solicitação (`exigirAprovadorHumano`).
// Aprovar exige que a operação esteja em `pending_approval` e dentro do prazo.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { exigirAprovadorHumano } from '../domain/approval-policy';
import { estadoEfetivo, exigirTransicao } from '../domain/operation-status';
import { operacaoPorPublicId, transicionarStatus } from '../infrastructure/operation.repository';
import { registrarDecisao, aprovacaoDaOperacao } from '../infrastructure/approval.repository';
import { auditarOperacao } from '../infrastructure/audit';
import type { OperationalActor, OperationRow } from '../domain/operation';

const TTL_APROVACAO_MS = Number(process.env.OPERATIONAL_APPROVAL_TTL_MINUTES ?? 30) * 60_000;

export type AprovarEntrada = { operationId: string; confirmation: string };

export async function aprovarOperacao(actor: OperationalActor, entrada: AprovarEntrada): Promise<OperationRow> {
  exigirAutorizacao(actor, 'workflow.approve');
  // O agente MCP não aprova; só o aprovador humano (admin) na interface do ERP.
  exigirAprovadorHumano(actor);

  const confirmacao = String(entrada.confirmation ?? '').trim();
  if (confirmacao.length < 5) throw new OperationalError('PARAMETRO_INVALIDO', 'A confirmação explícita da aprovação é obrigatória.', { confirmation: 'obrigatória' });

  const op = await operacaoPorPublicId(actor.empresa_id, entrada.operationId);
  if (!op) throw new OperationalError('NAO_ENCONTRADO', 'Operação não encontrada.');

  const statusEfetivo = estadoEfetivo(op.status, op.expires_at);
  if (statusEfetivo !== 'pending_approval') {
    throw new OperationalError('CONFLITO', `A operação está em "${statusEfetivo}" e não pode ser aprovada.`);
  }
  exigirTransicao(statusEfetivo, 'approved');

  // Sem aprovação duplicada: uma única 'approve' por operação.
  const jaAprovada = await aprovacaoDaOperacao(Number(op.id));
  if (jaAprovada) throw new OperationalError('CONFLITO', 'A operação já foi aprovada.');

  await registrarDecisao({
    empresaId: actor.empresa_id,
    operationId: Number(op.id),
    approvedBy: actor.id,
    decision: 'approve',
    parametersHash: String(op.parameters_hash),
    confirmation: confirmacao,
    reason: null,
    expiresAt: new Date(Date.now() + TTL_APROVACAO_MS).toISOString(),
  });

  const atualizada = await transicionarStatus(actor.empresa_id, Number(op.id), op.status, 'approved');
  if (!atualizada) throw new OperationalError('CONFLITO', 'A operação mudou de estado durante a aprovação.');

  await auditarOperacao({
    empresaId: actor.empresa_id,
    operationId: Number(op.id),
    actorId: actor.id,
    eventType: 'operation.approved',
    payload: { parameters_hash: String(op.parameters_hash) },
  });

  return atualizada;
}
