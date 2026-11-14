// ============================================================================
// CONTROL PLANE › POLÍTICA › ALLOWLIST DE WORKFLOWS (PURO)
//
// Um workflow só existe se estiver no REGISTRO INTERNO — e só executa se
// estiver HABILITADO. Workflow desconhecido e workflow desabilitado são
// recusados com 422 (política), nunca "ignorado".
// ============================================================================
import { OperationalError } from '../domain/errors';
import { obterWorkflow, type WorkflowDefinition } from '../domain/workflow-registry';

/** Resolve o workflow do registro; 422 quando desconhecido. */
export function exigirWorkflowRegistrado(key: unknown): WorkflowDefinition {
  const def = obterWorkflow(key);
  if (!def) {
    throw new OperationalError('POLITICA_REJEITOU', 'Workflow não cadastrado no registro interno.', { workflow_key: String(key ?? '') });
  }
  return def;
}

/** O workflow está habilitado para execução? Desabilitado → 422. */
export function exigirWorkflowHabilitado(def: WorkflowDefinition): void {
  if (!def.enabled) {
    throw new OperationalError(
      'OPERACAO_NAO_HABILITADA',
      `O workflow "${def.key}" ainda não foi habilitado para execução (aguarda homologação).`
    );
  }
}
