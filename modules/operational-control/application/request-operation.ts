// ============================================================================
// CONTROL PLANE › APLICAÇÃO › SOLICITAR OPERAÇÃO
//
// Cria a SOLICITAÇÃO (nunca executa). Ordem:
//   1. autoriza (escopo OAuth ∩ perfil);
//   2. resolve o workflow do REGISTRO e exige habilitado;
//   3. valida os parâmetros e resolve a ref contra a allowlist;
//   4. trata a IDEMPOTÊNCIA (mesma chave + mesmos parâmetros → devolve a
//      existente; mesmos parâmetros diferentes → 409);
//   5. grava a operação (pending_approval quando exige aprovação);
//   6. audita a intenção.
//
// O cliente NÃO envia repositório, arquivo, branch arbitrária nem comando.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { exigirWorkflowRegistrado, exigirWorkflowHabilitado } from '../policies/workflow-allowlist';
import { resolverRef } from '../policies/branch-policy';
import { validarParametros, hashParametros } from '../policies/parameter-policy';
import { criarOperacao, operacaoPorIdempotencia } from '../infrastructure/operation.repository';
import { auditarOperacao } from '../infrastructure/audit';
import type { OperationalActor, OperationRow } from '../domain/operation';

const TTL_MS = Number(process.env.OPERATIONAL_OPERATION_TTL_MINUTES ?? 60) * 60_000;

export type SolicitarEntrada = {
  workflowKey: string;
  parameters?: Record<string, unknown>;
  reason: string;
  idempotencyKey: string;
  ref?: string;
};

export type SolicitarResultado = {
  operation: OperationRow;
  /** `true` quando a operação já existia (idempotência) — não criou de novo. */
  reutilizada: boolean;
};

export async function solicitarOperacao(actor: OperationalActor, entrada: SolicitarEntrada): Promise<SolicitarResultado> {
  exigirAutorizacao(actor, 'workflow.request');

  const idempotencyKey = String(entrada.idempotencyKey ?? '').trim();
  if (!idempotencyKey) throw new OperationalError('PARAMETRO_INVALIDO', 'O cabeçalho Idempotency-Key é obrigatório.', { 'Idempotency-Key': 'obrigatório' });

  const reason = String(entrada.reason ?? '').trim();
  if (!reason) throw new OperationalError('PARAMETRO_INVALIDO', 'O motivo da solicitação é obrigatório.', { reason: 'obrigatório' });
  if (reason.length > 500) throw new OperationalError('PARAMETRO_INVALIDO', 'O motivo excede 500 caracteres.', { reason: 'muito longo' });

  const def = exigirWorkflowRegistrado(entrada.workflowKey);
  exigirWorkflowHabilitado(def);
  const ref = resolverRef(def, entrada.ref);
  const parameters = validarParametros(def, entrada.parameters ?? {});
  const parametersHash = hashParametros({ ref, ...parameters });

  // IDEMPOTÊNCIA: a mesma chave com os MESMOS parâmetros devolve a existente.
  const existente = await operacaoPorIdempotencia(actor.empresa_id, idempotencyKey);
  if (existente) {
    const hashExistente = String(existente.parameters_hash);
    if (hashExistente === parametersHash) return { operation: existente, reutilizada: true };
    throw new OperationalError('CONFLITO', 'A chave de idempotência já foi usada com parâmetros diferentes.', {
      'Idempotency-Key': 'conflito de parâmetros',
    });
  }

  const status = def.requiresApproval ? 'pending_approval' : 'approved';
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const operation = await criarOperacao({
    empresaId: actor.empresa_id,
    operationType: def.operation,
    workflowKey: def.key,
    requestedBy: actor.id,
    parameters: { ref, ...parameters },
    parametersHash,
    reason,
    status,
    requiresApproval: def.requiresApproval,
    requestedScopes: (actor.scopes ?? []).join(' '),
    idempotencyKey,
    expiresAt,
  });

  await auditarOperacao({
    empresaId: actor.empresa_id,
    operationId: Number(operation.id),
    actorId: actor.id,
    eventType: 'operation.requested',
    payload: { workflow_key: def.key, ref, requires_approval: def.requiresApproval, via_mcp: !!actor.viaMcp },
  });

  return { operation, reutilizada: false };
}
