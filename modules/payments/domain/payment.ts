/** Money is always integer minor units at the engine boundary. No card data. */
export const METHODS = [
  'PIX',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'BOLETO',
  'DIGITAL_WALLET',
  'BUY_NOW_PAY_LATER',
  'BANK_TRANSFER',
  'GIFT_CARD',
  'MANUAL_PAYMENT',
  'OTHER',
] as const;
export type PaymentMethod = (typeof METHODS)[number];
export const PROVIDERS = ['MERCADO_PAGO', 'PAGBANK', 'STRIPE', 'PIX_DIRECT', 'ACQUIRER_GENERIC', 'BOLETO_GENERIC', 'MANUAL'] as const;
// PIX_DIRECT identifies an unbound bank/PSP connector slot, NOT the PIX method.
export type ProviderCode = (typeof PROVIDERS)[number];
export const STATES = [
  'CREATED',
  'PENDING',
  'PENDING_MANUAL_CONFIRMATION',
  'REQUIRES_ACTION',
  'AUTHORIZED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'PAID',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELED',
  'FAILED',
  'EXPIRED',
  'CHARGEBACK',
  'DISPUTED',
] as const;
export type PaymentStatus = (typeof STATES)[number];
const edges: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ['PENDING', 'PENDING_MANUAL_CONFIRMATION', 'REQUIRES_ACTION', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELED'],
  PENDING: [
    'PENDING_MANUAL_CONFIRMATION',
    'REQUIRES_ACTION',
    'AUTHORIZED',
    'CAPTURE_PENDING',
    'CAPTURED',
    'PAID',
    'FAILED',
    'CANCELED',
    'EXPIRED',
  ],
  PENDING_MANUAL_CONFIRMATION: ['PAID', 'CANCELED', 'EXPIRED'],
  REQUIRES_ACTION: ['PENDING', 'AUTHORIZED', 'CAPTURED', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED'],
  AUTHORIZED: ['CAPTURE_PENDING', 'CAPTURED', 'PAID', 'CANCELED', 'EXPIRED'],
  CAPTURE_PENDING: ['AUTHORIZED', 'CAPTURED', 'PAID', 'FAILED'],
  CAPTURED: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK'],
  PAID: ['PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK'],
  DISPUTED: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CHARGEBACK'],
  CHARGEBACK: [],
  REFUNDED: [],
  CANCELED: [],
  FAILED: [],
  EXPIRED: [],
};
export function transition(from: PaymentStatus, to: PaymentStatus): PaymentStatus {
  if (from === to) return from;
  if (!edges[from]?.includes(to)) throw new Error(`Invalid payment transition: ${from} → ${to}`);
  return to;
}
export const ERROR_CODES = [
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'INVALID_PAYMENT_METHOD',
  'PAYMENT_DECLINED',
  'FRAUD_REJECTED',
  'AUTHENTICATION_REQUIRED',
  'INSUFFICIENT_FUNDS',
  'INVALID_REQUEST',
  'DUPLICATE_REQUEST',
  'UNKNOWN_PROVIDER_ERROR',
] as const;
export class PaymentError extends Error {
  constructor(
    public code: (typeof ERROR_CODES)[number],
    public ambiguous = false
  ) {
    super(code);
  }
}
export function canFallback(error: unknown): boolean {
  return error instanceof PaymentError && !error.ambiguous && ['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMITED'].includes(error.code);
}
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.min(3_600_000, 1000 * 2 ** Math.min(attempt, 12)) * (0.75 + random() * 0.5);
export const DISPUTE_STATES = [
  'DISPUTE_OPENED',
  'UNDER_REVIEW',
  'EVIDENCE_REQUIRED',
  'EVIDENCE_SUBMITTED',
  'WON',
  'LOST',
  'CLOSED',
] as const;
export const RECONCILIATION_STATES = ['UNRECONCILED', 'MATCHED', 'PARTIAL', 'DIVERGENT', 'RESOLVED'] as const;
export function minorUnits(value: number): number {
  const n = Math.round((value + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(n) || n <= 0) throw new PaymentError('INVALID_REQUEST');
  return n;
}
