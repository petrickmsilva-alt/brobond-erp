// ============================================================================
// CONTROL PLANE › APLICAÇÃO › CONSULTAR OPERAÇÃO
//
// Devolve a operação com a aprovação e a execução correlacionadas. O recorte
// por empresa já é aplicado na leitura (404 para operação de outro tenant).
// O estado devolvido considera a EXPIRAÇÃO (nunca "pending_approval" vencida).
// ============================================================================
import { OperationalError } from '../domain/errors';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { estadoEfetivo } from '../domain/operation-status';
import { operacaoPorPublicId } from '../infrastructure/operation.repository';
import { ultimaDecisao } from '../infrastructure/approval.repository';
import { execucaoDaOperacao } from '../infrastructure/execution.repository';
import { serializarOperacao } from './serialize';
import type { OperationalActor } from '../domain/operation';

export async function consultarOperacao(actor: OperationalActor, operationId: string): Promise<Record<string, unknown>> {
  exigirAutorizacao(actor, 'workflow.read');
  const op = await operacaoPorPublicId(actor.empresa_id, operationId);
  if (!op) throw new OperationalError('NAO_ENCONTRADO', 'Operação não encontrada.');

  const status = estadoEfetivo(op.status, op.expires_at);
  const aprovacao = await ultimaDecisao(Number(op.id));
  const execucao = await execucaoDaOperacao(Number(op.id));

  return serializarOperacao({ ...op, status }, aprovacao, execucao);
}
