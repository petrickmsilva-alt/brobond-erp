// ============================================================================
// CONTROL PLANE › POLÍTICA › BRANCH (PURO)
//
// A branch/ref é resolvida do REGISTRO e conferida contra a allowlist. `main`
// não está na allowlist do primeiro workflow de propósito: a especificação
// exige que o diagnóstico rode na branch de homologação, não em produção.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { refPermitida, type WorkflowDefinition } from '../domain/workflow-registry';

/** Devolve a ref efetiva (válida) ou lança 422. */
export function resolverRef(def: WorkflowDefinition, ref: unknown): string {
  const resolvida = refPermitida(def, ref);
  if (!resolvida) {
    throw new OperationalError(
      'POLITICA_REJEITOU',
      `A ref "${String(ref)}" não está autorizada para o workflow "${def.key}". Permitidas: ${def.allowedRefs.join(', ')}.`,
      { allowed_refs: [...def.allowedRefs] }
    );
  }
  return resolvida;
}
