// ============================================================================
// CONTROL PLANE › APLICAÇÃO › RECONCILIAR EXECUÇÃO
//
// O dispatch do GitHub responde 204 SEM corpo: o run id é descoberto aqui, por
// consulta, e o estado da execução é atualizado. Sem webhook, é ESTA rotina
// que impede uma operação de ficar permanentemente sem atualização.
//
// Também EXPIRA operações `pending_approval`/`approved` vencidas — nunca
// ficam abertas para sempre. Não é automático sobre resultado desconhecido:
// uma operação em `dispatching` só sai desse estado com confirmação do GitHub.
// ============================================================================
import { estadoEfetivo } from '../domain/operation-status';
import { obterWorkflow } from '../domain/workflow-registry';
import { getStore } from '../../../server/src/services';
import { R_OPERATIONS } from '../infrastructure/resources';
import { transicionarStatus } from '../infrastructure/operation.repository';
import { execucaoDaOperacao, atualizarExecucao } from '../infrastructure/execution.repository';
import { normalizarStatusRun, type GithubActionsClient } from '../infrastructure/github-actions.client';
import { githubActions } from '../infrastructure/github-actions.client';
import { auditarOperacao } from '../infrastructure/audit';
import type { ExecutionRow, OperationRow } from '../domain/operation';

export type ReconciliarDeps = { actions?: GithubActionsClient; agora?: () => Date };

/** Conclusão do GitHub → status normalizado do ERP. */
function mapearConclusao(conclusao: string | null | undefined): 'completed' | 'failed' | 'cancelled' | 'unknown' {
  const c = String(conclusao ?? '').toLowerCase();
  if (c === 'success') return 'completed';
  if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') return 'failed';
  if (c === 'cancelled') return 'cancelled';
  return 'unknown';
}

/** Atualiza a execução a partir do estado real no GitHub (uma operação). */
async function reconciliarUma(op: OperationRow, actions: GithubActionsClient): Promise<void> {
  const exec = await execucaoDaOperacao(Number(op.id));
  if (!exec) return;
  const def = obterWorkflow(op.workflow_key);
  if (!def) return;

  const params = (op.parameters ?? {}) as Record<string, unknown>;
  const ref = String(params.ref ?? def.branch);

  const run = await actions.ultimaRun(def.repository, def.workflowFile, ref);
  if (!run) return;

  const statusNorm = normalizarStatusRun(run.status, run.conclusion);
  const statusExec: ExecutionRow['status'] = statusNorm === 'completed' ? mapearConclusao(run.conclusion) : statusNorm;
  const dados: Record<string, unknown> = {
    github_run_id: run.id,
    status: statusExec,
    conclusion: run.conclusion ?? null,
    html_url: run.html_url ?? null,
    started_at: run.run_started_at ?? run.created_at ?? null,
  };
  if (statusNorm === 'completed') dados.completed_at = run.updated_at ?? null;
  await atualizarExecucao(op.empresa_id, Number(exec.id), dados);

  // A OPERAÇÃO acompanha a execução (nunca o contrário).
  if (statusNorm === 'in_progress' && op.status !== 'running') {
    await transicionarStatus(op.empresa_id, Number(op.id), 'dispatched', 'running');
    await auditarOperacao({ empresaId: op.empresa_id, operationId: Number(op.id), actorId: null, eventType: 'workflow.started', payload: { run_id: run.id } });
  } else if (statusNorm === 'completed') {
    const destino = statusExec === 'completed' ? 'completed' : statusExec === 'cancelled' ? 'failed' : 'failed';
    if (op.status === 'dispatched' || op.status === 'running') {
      await transicionarStatus(op.empresa_id, Number(op.id), op.status, destino);
    }
    await auditarOperacao({
      empresaId: op.empresa_id,
      operationId: Number(op.id),
      actorId: null,
      eventType: destino === 'completed' ? 'workflow.completed' : 'workflow.failed',
      payload: { run_id: run.id, conclusion: run.conclusion ?? null },
    });
  }
}

/** Expira operações vencidas que nunca foram despachadas. */
export async function expirarOperacoesVencidas(empresaId?: number): Promise<number> {
  const store = getStore();
  const res = await store.list(R_OPERATIONS, { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: empresaId ? { empresa_id: empresaId } : {} });
  const agora = new Date();
  let expiradas = 0;
  for (const row of res.rows as OperationRow[]) {
    const efetivo = estadoEfetivo(row.status, row.expires_at, agora);
    if (efetivo === 'expired' && row.status !== 'expired') {
      const atualizada = await transicionarStatus(row.empresa_id, Number(row.id), row.status, 'expired');
      if (atualizada) {
        expiradas++;
        await auditarOperacao({ empresaId: row.empresa_id, operationId: Number(row.id), actorId: null, eventType: 'operation.expired', payload: {} });
      }
    }
  }
  return expiradas;
}

/** Reconcilia uma execução específica (por id público da execução). */
export async function reconciliarExecucao(operationPublicId: string, empresaId: number, deps: ReconciliarDeps = {}): Promise<void> {
  const actions = deps.actions ?? githubActions;
  const store = getStore();
  const op = await store.findOneWhere(R_OPERATIONS, { empresa_id: empresaId, public_id: operationPublicId });
  if (!op) return;
  await reconciliarUma(op as OperationRow, actions);
}

/** Reconcilia todas as execuções em curso de uma empresa (job/endpoint). */
export async function reconciliarEmpresa(empresaId: number, deps: ReconciliarDeps = {}): Promise<{ reconciliadas: number; expiradas: number }> {
  const actions = deps.actions ?? githubActions;
  const store = getStore();
  const emCurso = await store.list(R_OPERATIONS, {
    page: 1,
    pageSize: 200,
    sort: 'id',
    dir: 'asc',
    filter: { empresa_id: empresaId },
  });
  let reconciliadas = 0;
  for (const row of emCurso.rows as OperationRow[]) {
    if (!['dispatched', 'running', 'dispatching'].includes(String(row.status))) continue;
    try {
      await reconciliarUma(row, actions);
      reconciliadas++;
    } catch {
      // Falha de comunicação com o GitHub não altera estado crítico — tenta de novo depois.
    }
  }
  const expiradas = await expirarOperacoesVencidas(empresaId);
  return { reconciliadas, expiradas };
}
