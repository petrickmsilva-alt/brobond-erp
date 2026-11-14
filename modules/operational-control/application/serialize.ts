// ============================================================================
// CONTROL PLANE › APLICAÇÃO › SERIALIZAÇÃO
//
// Converte as linhas em JSON de API. NUNCA devolve token, secret, chave ou
// corpo remoto. Os nomes de campo seguem a especificação (snake_case).
// ============================================================================
import { estadoEfetivo } from '../domain/operation-status';
import type { ApprovalRow, ExecutionRow, OperationRow } from '../domain/operation';

export function serializarOperacao(op: OperationRow, aprovacao?: ApprovalRow | null, execucao?: ExecutionRow | null): Record<string, unknown> {
  const status = estadoEfetivo(op.status, op.expires_at);
  return {
    id: op.public_id,
    operation_type: op.operation_type,
    workflow_key: op.workflow_key,
    requested_by: op.requested_by,
    parameters: op.parameters ?? {},
    reason: op.reason,
    status,
    requires_approval: op.requires_approval,
    expires_at: op.expires_at,
    created_at: op.criado_em,
    updated_at: op.atualizado_em,
    approval: aprovacao
      ? {
          required: op.requires_approval,
          approved: aprovacao.decision === 'approve' && !aprovacao.consumed_at,
          decision: aprovacao.decision,
          approved_by: aprovacao.approved_by,
          decided_at: aprovacao.decided_at,
          consumed: !!aprovacao.consumed_at,
        }
      : { required: op.requires_approval, approved: false, decision: null },
    execution: execucao
      ? {
          id: execucao.public_id,
          run_id: execucao.github_run_id,
          status: execucao.status,
          conclusion: execucao.conclusion,
          html_url: execucao.html_url,
        }
      : { id: null, run_id: null, status: 'not_dispatched', conclusion: null, html_url: null },
  };
}

export function serializarExecucao(exec: ExecutionRow, operationPublicId: string | null): Record<string, unknown> {
  return {
    id: exec.public_id,
    operation_id: operationPublicId,
    workflow_key: exec.workflow_key,
    branch: exec.branch,
    github_run_id: exec.github_run_id,
    status: exec.status,
    conclusion: exec.conclusion,
    html_url: exec.html_url,
    started_at: exec.started_at,
    completed_at: exec.completed_at,
    last_checked_at: exec.last_checked_at,
  };
}
