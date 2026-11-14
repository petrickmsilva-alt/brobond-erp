// ============================================================================
// CONTROL PLANE › INFRA › REPOSITÓRIO DE EXECUÇÕES
//
// Uma execução por operação. O `github_run_id` nasce nulo (not_dispatched) e é
// preenchido na reconciliação (o dispatch do GitHub responde 204 sem corpo).
// O estado é sempre o NORMALIZADO — nunca o valor bruto da API externa.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { R_EXECUTIONS } from './resources';
import { novoIdExecucao } from './ids';
import type { ExecutionRow } from '../domain/operation';
import type { Tx } from '../../../server/src/store';

export async function criarExecucao(
  dados: { empresaId: number; operationId: number; workflowKey: string; branch: string },
  tx?: Tx
): Promise<ExecutionRow> {
  const row = await getStore().insert(
    R_EXECUTIONS,
    {
      public_id: novoIdExecucao(),
      empresa_id: dados.empresaId,
      operation_id: dados.operationId,
      workflow_key: dados.workflowKey,
      branch: dados.branch,
      status: 'not_dispatched',
    },
    tx
  );
  return row as ExecutionRow;
}

export async function execucaoPorPublicId(empresaId: number, publicId: string, tx?: Tx): Promise<ExecutionRow | null> {
  const row = await getStore().findOneWhere(R_EXECUTIONS, { empresa_id: empresaId, public_id: String(publicId) }, tx);
  return (row as ExecutionRow) ?? null;
}

export async function execucaoDaOperacao(operationId: number, tx?: Tx): Promise<ExecutionRow | null> {
  const row = await getStore().findOneWhere(R_EXECUTIONS, { operation_id: Number(operationId) }, tx);
  return (row as ExecutionRow) ?? null;
}

export async function listarExecucoes(empresaId: number, filtro: { workflowKey?: string; status?: string; limit?: number } = {}, tx?: Tx): Promise<ExecutionRow[]> {
  const where: Record<string, unknown> = { empresa_id: empresaId };
  if (filtro.workflowKey) where.workflow_key = filtro.workflowKey;
  if (filtro.status) where.status = filtro.status;
  const limit = Math.min(Math.max(Number(filtro.limit) || 20, 1), 100);
  const res = await getStore().list(R_EXECUTIONS, { page: 1, pageSize: limit, sort: 'id', dir: 'desc', filter: where }, tx);
  return res.rows as ExecutionRow[];
}

/** Atualiza a execução (status/conclusão/run id/URL). */
export async function atualizarExecucao(empresaId: number, id: number, dados: Record<string, unknown>, tx?: Tx): Promise<ExecutionRow | null> {
  const row = await getStore().tryUpdateIf(R_EXECUTIONS, Number(id), { empresa_id: empresaId }, { ...dados, last_checked_at: new Date().toISOString() }, tx);
  return (row as ExecutionRow) ?? null;
}
