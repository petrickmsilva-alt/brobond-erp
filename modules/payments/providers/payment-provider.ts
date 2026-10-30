import type { PaymentMethod, PaymentStatus, ProviderCode } from '../domain/payment';
export type Capability = {
  method: PaymentMethod;
  countries: string[];
  currencies: string[];
  min: number;
  max: number;
  requiredCustomerFields: ('email' | 'name' | 'tax_id')[];
  maxInstallments: number;
  authorize: boolean;
  capture: boolean;
  cancel: boolean;
  refund: boolean;
  partialRefund: boolean;
  recurring: boolean;
  tokenization: boolean;
  threeDS: boolean;
  asynchronous: boolean;
  settlement: 'PROVIDER' | 'MANUAL';
};
export type ProviderContext = {
  empresaId: number;
  credentials: Record<string, string>;
  webhookSecret: string | null;
  environment: 'teste' | 'producao';
  operationKey: string;
};
export type PaymentInput = {
  amount: number;
  currency: string;
  method: PaymentMethod;
  reference: string;
  email: string;
  token?: string;
  taxId?: string;
  customerName?: string;
  installments: number;
  expiresAt?: string;
};
/** Evidência da operação específica retornada pelo mesmo provider autenticado. */
export type RefundEvidence = {
  reference: string;
  paymentReference: string;
  amount: number;
  status: 'PENDING' | 'SUCCEEDED';
};
export type PaymentResult = {
  reference: string;
  status: PaymentStatus;
  amount?: number;
  currency?: string;
  refunded?: number;
  refundEvidence?: RefundEvidence;
  action?: { type: string; url?: string; code?: string; qrCode?: string; expiresAt?: string };
  risk?: string;
};
export type WebhookEvent = { id: string; reference: string; type: string };
export interface PaymentProvider {
  readonly code: ProviderCode;
  readonly legacyId: string;
  capabilities(ctx: ProviderContext): Capability[];
  supports(ctx: ProviderContext, method: PaymentMethod): boolean;
  createPaymentIntent(ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult>;
  authorize(ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult>;
  capture(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult>;
  cancel(ctx: ProviderContext, reference: string): Promise<PaymentResult>;
  refund(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult>;
  getRefund?(ctx: ProviderContext, paymentReference: string, refundReference: string): Promise<RefundEvidence>;
  partialRefund(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult>;
  getPayment(ctx: ProviderContext, reference: string): Promise<PaymentResult>;
  getPaymentStatus(ctx: ProviderContext, reference: string): Promise<PaymentStatus>;
  createPaymentMethod(ctx: ProviderContext, token: string): Promise<{ reference: string }>;
  verifyWebhook(ctx: ProviderContext, raw: string, headers: Record<string, string | undefined>): boolean;
  parseWebhook(raw: string): WebhookEvent | null;
  healthCheck(ctx: ProviderContext): Promise<'UP' | 'DEGRADED' | 'DOWN' | 'NOT_CONFIGURED'>;
}
export const capability = (method: PaymentMethod, options: Partial<Capability> = {}): Capability => ({
  method,
  countries: ['BR'],
  currencies: ['BRL'],
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  requiredCustomerFields: ['email'],
  maxInstallments: 1,
  authorize: false,
  capture: false,
  cancel: false,
  refund: false,
  partialRefund: false,
  recurring: false,
  tokenization: false,
  threeDS: false,
  asynchronous: true,
  settlement: 'PROVIDER',
  ...options,
});
