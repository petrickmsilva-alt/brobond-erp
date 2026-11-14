// ============================================================================
// CONTROL PLANE › POLÍTICA › AUTORIZAÇÃO (PURO)
//
// PERMISSÃO EFETIVA = ESCOPO OAUTH ∩ PERMISSÃO DO USUÁRIO ∩ POLÍTICA
// OPERACIONAL ∩ ESCOPO DA EMPRESA ∩ ALLOWLIST DE WORKFLOWS.
//
// Se QUALQUER condição falhar, a operação é negada. Ser `admin` NÃO dispensa a
// política específica da operação: um admin sem o escopo OAuth de aprovação
// continua sem aprovar por essa via.
//
// A identidade vem SEMPRE do token validado; o cliente MCP não envia
// `user_id`, `perfil`, `empresa_id` ou `role` como prova de autorização.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { SCOPES, temEscopo } from '../domain/scopes';
import type { OperationalActor } from '../domain/operation';

/** Ações operacionais governadas pela política. */
export type AcaoOperacional =
  | 'system.read'
  | 'github.read'
  | 'workflow.read'
  | 'workflow.request'
  | 'workflow.approve'
  | 'audit.read';

/** Escopos OAuth que habilitam cada ação. */
const ESCOPOS_POR_ACAO: Record<AcaoOperacional, readonly string[]> = {
  'system.read': [SCOPES.systemRead],
  'github.read': [SCOPES.githubRead],
  'workflow.read': [SCOPES.workflowRead],
  'workflow.request': [SCOPES.workflowRequest],
  'workflow.approve': [SCOPES.workflowApprove],
  'audit.read': [SCOPES.auditRead],
};

/** Perfil mínimo para cada ação (RBAC do ERP, complementar à política). */
const PERFIL_MINIMO: Record<AcaoOperacional, OperationalActor['perfil'][]> = {
  'system.read': ['admin', 'gerente', 'operador'],
  'github.read': ['admin', 'gerente'],
  'workflow.read': ['admin', 'gerente'],
  'workflow.request': ['admin'],
  'workflow.approve': ['admin'],
  'audit.read': ['admin'],
};

const RANK: Record<OperationalActor['perfil'], number> = { operador: 1, gerente: 2, admin: 3 };

/** A permissão do usuário (RBAC) autoriza a ação? */
export function perfilAutoriza(actor: Pick<OperationalActor, 'perfil'>, acao: AcaoOperacional): boolean {
  const permitidos = PERFIL_MINIMO[acao];
  return permitidos.some((p) => RANK[actor.perfil] >= RANK[p]);
}

/** O escopo OAuth autoriza a ação? */
export function escopoAutoriza(scopes: readonly string[], acao: AcaoOperacional): boolean {
  return temEscopo(scopes, ESCOPOS_POR_ACAO[acao]);
}

/**
 * Exige a permissão efetiva. Falha com 403 (escopo ausente) ou 401 (sem ator).
 * Nunca distingue "escopo faltando" de "perfil insuficiente" na mensagem
 * pública — a trilha de auditoria é quem registra o motivo detalhado.
 */
export function exigirAutorizacao(actor: OperationalActor | null | undefined, acao: AcaoOperacional): OperationalActor {
  if (!actor || !actor.id) throw new OperationalError('NAO_AUTENTICADO', 'Autenticação obrigatória.');
  if (!escopoAutoriza(actor.scopes ?? [], acao)) {
    throw new OperationalError('SEM_PERMISSAO', `O cliente OAuth não possui o escopo necessário para "${acao}".`, { escopo: ESCOPOS_POR_ACAO[acao] });
  }
  if (!perfilAutoriza(actor, acao)) {
    throw new OperationalError('SEM_PERMISSAO', `O perfil "${actor.perfil}" não autoriza "${acao}".`);
  }
  return actor;
}

/** Capacidades efetivas do ator (seção 6.1) — calculadas, nunca presumidas. */
export function capacidadesEfetivas(actor: OperationalActor): {
  repository_read: boolean;
  workflow_read: boolean;
  workflow_request: boolean;
  workflow_approval: boolean;
  arbitrary_command_execution: false;
} {
  const pode = (acao: AcaoOperacional) => escopoAutoriza(actor.scopes ?? [], acao) && perfilAutoriza(actor, acao);
  return {
    repository_read: pode('github.read'),
    workflow_read: pode('workflow.read'),
    workflow_request: pode('workflow.request'),
    workflow_approval: pode('workflow.approve'),
    // NUNCA verdadeiro: a arquitetura proíbe execução arbitrária.
    arbitrary_command_execution: false,
  };
}
