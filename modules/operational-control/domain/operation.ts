// ============================================================================
// CONTROL PLANE › DOMÍNIO › TIPOS DA OPERAÇÃO
//
// A operação é a SOLICITAÇÃO — nunca a execução. Ela carrega o workflow
// (resolvido do registro interno), o hash dos parâmetros (vínculo com a
// aprovação), a chave de idempotência e o prazo de validade.
// ============================================================================
import type { OperationStatus } from './operation-status';

/** Tipo de operação. `workflow.dispatch` dispara um workflow do GitHub Actions. */
export type OperationType = 'workflow.dispatch' | 'diagnostic.read_only';

export type OperationRow = {
  id: number;
  public_id: string;
  empresa_id: number;
  operation_type: OperationType;
  workflow_key: string;
  requested_by: number;
  parameters: Record<string, unknown>;
  parameters_hash: string;
  reason: string;
  status: OperationStatus;
  requires_approval: boolean;
  requested_scopes: string;
  idempotency_key: string;
  expires_at: string;
  criado_em: string;
  atualizado_em: string;
};

export type ApprovalRow = {
  id: number;
  empresa_id: number;
  operation_id: number;
  approved_by: number;
  decision: 'approve' | 'reject';
  parameters_hash: string;
  confirmation: string | null;
  reason: string | null;
  consumed_at: string | null;
  decided_at: string;
  expires_at: string;
};

export type ExecutionRow = {
  id: number;
  public_id: string;
  empresa_id: number;
  operation_id: number;
  workflow_key: string;
  branch: string;
  github_run_id: number | null;
  status: 'not_dispatched' | 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_checked_at: string | null;
  criado_em: string;
  atualizado_em: string;
};

export type AuditEventRow = {
  id: number;
  empresa_id: number;
  operation_id: number | null;
  actor_id: number | null;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  previous_hash: string | null;
  event_hash: string;
};

/** Ator autenticado (identidade do ERP — NUNCA vem do cliente MCP). */
export type OperationalActor = {
  id: number;
  name: string;
  perfil: 'admin' | 'gerente' | 'operador';
  empresa_id: number;
  /** Escopos OAuth concedidos ao cliente (interseção com a permissão do usuário). */
  scopes: string[];
  /** `true` quando a identidade veio do token OAuth do MCP (não da sessão do ERP). */
  viaMcp?: boolean;
};
