// ============================================================================
// CONTROL PLANE › INFRA › REPOSITÓRIO DE APROVAÇÕES
//
// A aprovação é VINCULADA à operação e ao hash dos parâmetros, e é de USO
// ÚNICO. O consumo é atômico (CAS em `consumed_at`): duas instâncias tentando
// despachar consomem a mesma aprovação no máximo uma vez.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { R_APPROVALS } from './resources';
import type { ApprovalRow } from '../domain/operation';
import type { Tx } from '../../../server/src/store';

/** Cria a decisão (aprovar/rejeitar). Uma aprovação 'approve' por operação. */
export async function registrarDecisao(
  dados: {
    empresaId: number;
    operationId: number;
    approvedBy: number;
    decision: 'approve' | 'reject';
    parametersHash: string;
    confirmation: string | null;
    reason: string | null;
    expiresAt: string;
  },
  tx?: Tx
): Promise<ApprovalRow> {
  const row = await getStore().insert(
    R_APPROVALS,
    {
      empresa_id: dados.empresaId,
      operation_id: dados.operationId,
      approved_by: dados.approvedBy,
      decision: dados.decision,
      parameters_hash: dados.parametersHash,
      confirmation: dados.confirmation,
      reason: dados.reason,
      expires_at: dados.expiresAt,
    },
    tx
  );
  return row as ApprovalRow;
}

/** Aprovação 'approve' vigente da operação (ou `null`). */
export async function aprovacaoDaOperacao(operationId: number, tx?: Tx): Promise<ApprovalRow | null> {
  const store = getStore();
  const res = await store.list(
    R_APPROVALS,
    { page: 1, pageSize: 1, sort: 'id', dir: 'desc', filter: { operation_id: Number(operationId), decision: 'approve' } },
    tx
  );
  return (res.rows[0] as ApprovalRow) ?? null;
}

/** Última decisão (aprovar OU rejeitar) da operação. */
export async function ultimaDecisao(operationId: number, tx?: Tx): Promise<ApprovalRow | null> {
  const store = getStore();
  const res = await store.list(R_APPROVALS, { page: 1, pageSize: 1, sort: 'id', dir: 'desc', filter: { operation_id: Number(operationId) } }, tx);
  return (res.rows[0] as ApprovalRow) ?? null;
}

/**
 * Consome a aprovação ATOMICAMENTE: só grava `consumed_at` se ainda estiver
 * nulo. Devolve `true` quando ESTA chamada consumiu — `false` significa que
 * outra instância já consumiu (dispatch duplicado barrado).
 */
export async function consumirAprovacao(empresaId: number, approvalId: number, tx?: Tx): Promise<boolean> {
  const row = await getStore().tryUpdateIf(
    R_APPROVALS,
    Number(approvalId),
    { empresa_id: empresaId, consumed_at: null },
    { consumed_at: new Date().toISOString() },
    tx
  );
  return row !== null;
}
