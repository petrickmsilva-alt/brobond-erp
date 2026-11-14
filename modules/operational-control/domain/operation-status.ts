// ============================================================================
// CONTROL PLANE › DOMÍNIO › CICLO DE VIDA DA OPERAÇÃO (PURO)
//
// As transições são a REGRA, não uma sugestão: só se chega a `dispatched`
// passando por `approved` → `dispatching`; `dispatching` só sai para
// `dispatched` ou `dispatch_failed`. Um estado terminal não volta atrás.
//
// O motor de reconciliação e o dispatch consultam estas regras — não há
// `UPDATE status = ...` espalhado sem passar por aqui.
// ============================================================================
import { OperationalError } from './errors';

export type OperationStatus =
  | 'requested'
  | 'pending_approval'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'approved'
  | 'dispatching'
  | 'dispatch_failed'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown';

/** Estados a partir dos quais NENHUMA transição é permitida. */
export const TERMINAIS: readonly OperationStatus[] = ['rejected', 'expired', 'cancelled', 'completed', 'failed'] as const;

/** Estados que representam execução já despachada (o workflow saiu daqui). */
export const DESPACHADOS: readonly OperationStatus[] = ['dispatched', 'running', 'completed', 'failed', 'unknown'] as const;

/** Transições permitidas, estado → estados alcançáveis. */
const TRANSICOES: Record<OperationStatus, readonly OperationStatus[]> = {
  requested: ['pending_approval', 'approved', 'rejected', 'expired', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'expired', 'cancelled'],
  rejected: [],
  expired: [],
  cancelled: [],
  approved: ['dispatching', 'cancelled', 'expired'],
  dispatching: ['dispatched', 'dispatch_failed', 'unknown'],
  dispatch_failed: ['dispatching', 'cancelled'],
  dispatched: ['running', 'completed', 'failed', 'unknown'],
  running: ['completed', 'failed', 'unknown'],
  completed: [],
  failed: [],
  unknown: ['running', 'completed', 'failed'],
};

export function estadoTerminal(status: OperationStatus): boolean {
  return TERMINAIS.includes(status);
}

export function foiDespachado(status: OperationStatus): boolean {
  return DESPACHADOS.includes(status);
}

/** A transição `de → para` é permitida? */
export function transicaoPermitida(de: OperationStatus, para: OperationStatus): boolean {
  return (TRANSICOES[de] ?? []).includes(para);
}

/** Exige a transição; lança 409 quando o estado atual não a permite. */
export function exigirTransicao(de: OperationStatus, para: OperationStatus): void {
  if (!transicaoPermitida(de, para)) {
    throw new OperationalError('CONFLITO', `Transição de estado inválida: "${de}" → "${para}".`);
  }
}

/**
 * O estado da operação à luz do relógio: `pending_approval`/`approved` que
 * passaram de `expires_at` são `expired`. `dispatching` NUNCA expira — o
 * resultado pode ser desconhecido e a reconciliação é quem resolve.
 */
export function estadoEfetivo(status: OperationStatus, expiresAt: string, agora: Date = new Date()): OperationStatus {
  if (status !== 'pending_approval' && status !== 'approved' && status !== 'requested') return status;
  return new Date(expiresAt).getTime() <= agora.getTime() ? 'expired' : status;
}
