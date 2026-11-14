// ============================================================================
// CONTROL PLANE › DOMÍNIO › REGISTRO DE WORKFLOWS AUTORIZADOS
//
// O cliente NUNCA informa repositório, arquivo de workflow, branch arbitrária
// ou comando: ele informa a CHAVE (`workflow_key`) e o servidor resolve TUDO
// daqui. Repositório é FIXO; a branch só pode ser uma das `allowedRefs`; os
// parâmetros aceitos são declarados em `parameters`.
//
// `enabled: false` é INTENCIONAL no primeiro registro: a integração nasce
// desligada e só é ativada depois da homologação (Fase 4). Um workflow
// desabilitado é recusado pela política com 422 — nunca "executa mesmo assim".
//
// Um workflow com contrato nasce desabilitado e nenhum endpoint é presumido —
// mesmo princípio das transportadoras em modules/logistics.
// ============================================================================

/** Parâmetro aceito de um workflow (validação de tipo e de valor). */
export type WorkflowParameterSpec = {
  type: 'string' | 'integer' | 'boolean';
  required?: boolean;
  /** Conjunto fechado de valores permitidos (quando aplicável). */
  enum?: readonly string[];
  maxLength?: number;
};

export type WorkflowDefinition = {
  /** Chave estável usada pela API e pelas ferramentas MCP. */
  key: string;
  /** Repositório FIXO (owner/repo). Nunca vem do cliente. */
  repository: string;
  /** Arquivo do workflow no repositório (ex.: `brobond-migracao-producao.yml`). */
  workflowFile: string;
  /** Branch PADRÃO quando o cliente não informa `ref`. */
  branch: string;
  /** Refs (branches/tags) que o dispatch pode usar. `main` fica FORA por padrão. */
  allowedRefs: readonly string[];
  /** Natureza da operação — `diagnostic.read_only` nunca escreve. */
  operation: 'diagnostic.read_only' | 'workflow.dispatch';
  /** Exige aprovação humana? (read-only de diagnóstico também exige.) */
  requiresApproval: boolean;
  /** Habilitação. Nasce `false` até a homologação. */
  enabled: boolean;
  /** Parâmetros aceitos; qualquer chave fora daqui é recusada. */
  parameters: Record<string, WorkflowParameterSpec>;
  /** Execuções simultâneas permitidas (1 = uma por vez). */
  maximumConcurrentExecutions: number;
  /** Escopos OAuth mínimos para solicitar/consultar. */
  requiredScopes?: readonly string[];
};

/**
 * REGISTRO INTERNO. É a ÚNICA fonte de repositório/arquivo/branch.
 * Primeiro registro: o diagnóstico read-only do Neon (homologação).
 */
export const WORKFLOW_REGISTRY: Record<string, WorkflowDefinition> = {
  'neon-production-diagnostic': {
    key: 'neon-production-diagnostic',
    repository: 'petrickmsilva-alt/brobond-erp',
    workflowFile: 'brobond-migracao-producao.yml',
    branch: 'ops/workflow-migracao-producao-diagnostico',
    allowedRefs: ['ops/workflow-migracao-producao-diagnostico'],
    operation: 'diagnostic.read_only',
    requiresApproval: true,
    enabled: false,
    parameters: {},
    maximumConcurrentExecutions: 1,
    requiredScopes: ['brobond:workflow:request'],
  },
} as const;

export function obterWorkflow(key: unknown): WorkflowDefinition | undefined {
  const k = String(key ?? '').trim();
  return Object.prototype.hasOwnProperty.call(WORKFLOW_REGISTRY, k) ? WORKFLOW_REGISTRY[k] : undefined;
}

/** Resolve a ref pedida: vazia → branch padrão; fora da allowlist → recusa. */
export function refPermitida(def: WorkflowDefinition, ref: unknown): string {
  const pedida = ref === undefined || ref === null || String(ref).trim() === '' ? def.branch : String(ref).trim();
  return def.allowedRefs.includes(pedida) ? pedida : '';
}

/** Resumo público do registro (sem detalhe interno) para a tela de capacidades. */
export function resumoRegistro(): Array<Pick<WorkflowDefinition, 'key' | 'operation' | 'enabled' | 'requiresApproval' | 'branch' | 'allowedRefs'>> {
  return Object.values(WORKFLOW_REGISTRY).map((d) => ({
    key: d.key,
    operation: d.operation,
    enabled: d.enabled,
    requiresApproval: d.requiresApproval,
    branch: d.branch,
    allowedRefs: d.allowedRefs,
  }));
}
