// ============================================================================
// CONTROL PLANE › APLICAÇÃO › LISTAR OPERAÇÕES / EXECUÇÃO POR ID
// ============================================================================
import { OperationalError } from '../domain/errors';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { listarOperacoes } from '../infrastructure/operation.repository';
import { execucaoPorPublicId } from '../infrastructure/execution.repository';
import { operacaoPorId } from '../infrastructure/operation.repository';
import { serializarOperacao, serializarExecucao } from './serialize';
import type { OperationalActor } from '../domain/operation';

export async function listarOperacoesDoAtor(actor: OperationalActor, filtro: { workflowKey?: string; status?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
  exigirAutorizacao(actor, 'workflow.read');
  const ops = await listarOperacoes(actor.empresa_id, filtro);
  return ops.map((o) => serializarOperacao(o));
}

export async function consultarExecucao(actor: OperationalActor, executionId: string): Promise<Record<string, unknown>> {
  exigirAutorizacao(actor, 'workflow.read');
  const exec = await execucaoPorPublicId(actor.empresa_id, executionId);
  if (!exec) throw new OperationalError('NAO_ENCONTRADO', 'Execução não encontrada.');
  const op = await operacaoPorId(actor.empresa_id, Number(exec.operation_id));
  return serializarExecucao(exec, op ? String(op.public_id) : null);
}
