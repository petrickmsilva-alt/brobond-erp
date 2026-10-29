import { PaymentError, type ProviderCode } from '../../domain/payment';
import type { Capability, PaymentInput, PaymentResult, ProviderContext, PaymentProvider, WebhookEvent } from '../payment-provider';
/** Unbound adapters fail closed. A bank/PSP must supply its own API contract. */
export class GenericPaymentProvider implements PaymentProvider {
  constructor(
    readonly code: ProviderCode = 'ACQUIRER_GENERIC',
    readonly legacyId = 'acquirer_generic'
  ) {}
  capabilities(_ctx: ProviderContext): Capability[] {
    return [];
  }
  supports(ctx: ProviderContext, method: PaymentInput['method']) {
    return this.capabilities(ctx).some((c) => c.method === method);
  }
  async createPaymentIntent(_ctx: ProviderContext, _input: PaymentInput): Promise<PaymentResult> {
    throw new PaymentError('INVALID_PAYMENT_METHOD');
  }
  async authorize(_ctx: ProviderContext, _input: PaymentInput): Promise<PaymentResult> {
    throw new PaymentError('INVALID_PAYMENT_METHOD');
  }
  async capture(_ctx: ProviderContext, _reference: string, _amount: number): Promise<PaymentResult> {
    throw new PaymentError('INVALID_PAYMENT_METHOD');
  }
  async cancel(_ctx: ProviderContext, _reference: string): Promise<PaymentResult> {
    throw new PaymentError('INVALID_PAYMENT_METHOD');
  }
  async refund(_ctx: ProviderContext, _reference: string, _amount: number): Promise<PaymentResult> {
    throw new PaymentError('INVALID_PAYMENT_METHOD');
  }
  partialRefund(ctx: ProviderContext, reference: string, amount: number) {
    return this.refund(ctx, reference, amount);
  }
  async getPayment(_ctx: ProviderContext, _reference: string): Promise<PaymentResult> {
    throw new PaymentError('INVALID_PAYMENT_METHOD');
  }
  async getPaymentStatus(ctx: ProviderContext, reference: string) {
    return (await this.getPayment(ctx, reference)).status;
  }
  async createPaymentMethod(_ctx: ProviderContext, _token: string): Promise<{ reference: string }> {
    throw new PaymentError('INVALID_PAYMENT_METHOD');
  }
  verifyWebhook(_ctx: ProviderContext, _raw: string, _headers: Record<string, string | undefined>) {
    return false;
  }
  parseWebhook(_raw: string): WebhookEvent | null {
    return null;
  }
  async healthCheck(_ctx: ProviderContext): Promise<'UP' | 'DEGRADED' | 'DOWN' | 'NOT_CONFIGURED'> {
    return 'NOT_CONFIGURED';
  }
}
