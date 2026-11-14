// ============================================================================
// CONTROL PLANE › INFRA › REPOSITÓRIO DE OPERAÇÕES
//
// Acesso às operações via STORE (pgstore/memdb) — nunca SQL cru. O id OPACO
// (`public_id`) é a chave de API; a PK interna é `id`. O recorte por empresa é
// aplicado em TODA leitura (nunca confiando no cliente).
// ============================================================================
import { getStore } from '../../../server/src/services';
import { R_OPERATIONS } from './resources';
import { novoIdOperacao } from './ids';
import type { OperationRow } from '../domain/operation';
import type { Tx } from '../../../server/src/store';

export async function criarOperacao(
  dados: {
    empresaId: number;
    operationType: string;
    workflowKey: string;
    requestedBy: number;
    parameters: Record<string, unknown>;
    parametersHash: string;
    reason: string;
    status: string;
    requiresApproval: boolean;
    requestedScopes: string;
    idempotencyKey: string;
    expiresAt: string;
  },
  tx?: Tx
): Promise<OperationRow> {
  const row = await getStore().insert(
    R_OPERATIONS,
    {
      public_id: novoIdOperacao(),
      empresa_id: dados.empresaId,
      operation_type: dados.operationType,
      workflow_key: dados.workflowKey,
      requested_by: dados.requestedBy,
      parameters: dados.parameters,
      parameters_hash: dados.parametersHash,
      reason: dados.reason,
      status: dados.status,
      requires_approval: dados.requiresApproval,
      requested_scopes: dados.requestedScopes,
      idempotency_key: dados.idempotencyKey,
      expires_at: dados.expiresAt,
    },
    tx
  );
  return row as OperationRow;
}

/** Operação pelo id OPACO, dentro da empresa. `null` = inexistente/outro tenant. */
export async function operacaoPorPublicId(empresaId: number, publicId: string, tx?: Tx): Promise<OperationRow | null> {
  const row = await getStore().findOneWhere(R_OPERATIONS, { empresa_id: empresaId, public_id: String(publicId) }, tx);
  return (row as OperationRow) ?? null;
}

/** Operação pela PK interna (uso interno, ainda recortado por empresa). */
export async function operacaoPorId(empresaId: number, id: number, tx?: Tx): Promise<OperationRow | null> {
  const row = await getStore().findOneWhere(R_OPERATIONS, { empresa_id: empresaId, id: Number(id) }, tx);
  return (row as OperationRow) ?? null;
}

/** Operação pela chave de idempotência (mesma empresa). */
export async function operacaoPorIdempotencia(empresaId: number, idempotencyKey: string, tx?: Tx): Promise<OperationRow | null> {
  const row = await getStore().findOneWhere(R_OPERATIONS, { empresa_id: empresaId, idempotency_key: String(idempotencyKey) }, tx);
  return (row as OperationRow) ?? null;
}

/**
 * Atualiza o status SOB CONTROLE TRANSACIONAL: só transiciona se o estado atual
 * for o esperado (CAS). Devolve a linha atualizada ou `null` quando outra
 * instância já mudou o estado — é o que impede dois dispatches simultâneos.
 */
export async function transicionarStatus(
  empresaId: number,
  id: number,
  de: string,
  para: string,
  extra: Record<string, unknown> = {},
  tx?: Tx
): Promise<OperationRow | null> {
  const row = await getStore().tryUpdateIf(R_OPERATIONS, id, { empresa_id: empresaId, status: de }, { status: para, ...extra }, tx);
  return (row as OperationRow) ?? null;
}

export type FiltroOperacoes = { workflowKey?: string; status?: string; limit?: number };

/** Lista operações da empresa (mais recentes primeiro). */
export async function listarOperacoes(empresaId: number, filtro: FiltroOperacoes = {}, tx?: Tx): Promise<OperationRow[]> {
  const where: Record<string, unknown> = { empresa_id: empresaId };
  if (filtro.workflowKey) where.workflow_key = filtro.workflowKey;
  if (filtro.status) where.status = filtro.status;
  const limit = Math.min(Math.max(Number(filtro.limit) || 20, 1), 100);
  const res = await getStore().list(R_OPERATIONS, { page: 1, pageSize: limit, sort: 'id', dir: 'desc', filter: where }, tx);
  return res.rows as OperationRow[];
}

/** Operações ainda não despachadas (para expiração/reconciliação). */
export async function operacoesPendentes(empresaId: number, tx?: Tx): Promise<OperationRow[]> {
  const res = await getStore().list(
    R_OPERATIONS,
    { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { empresa_id: empresaId, status: 'pending_approval' } },
    tx
  );
  return res.rows as OperationRow[];
}
