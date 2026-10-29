// Test harness compatibility ONLY. Never registered outside NODE_ENV=test.
import { GenericPaymentProvider } from '../generic';
import { capability, type PaymentInput, type PaymentResult, type ProviderContext } from '../payment-provider';
export class TestPaymentProvider extends GenericPaymentProvider {
  private results = new Map<string, PaymentResult>();
  constructor() {
    super('ACQUIRER_GENERIC', 'mock');
  }
  capabilities(_ctx: ProviderContext) {
    return process.env.NODE_ENV === 'test' ? [capability('PIX')] : [];
  }
  async createPaymentIntent(ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult> {
    if (process.env.NODE_ENV !== 'test') throw new Error('Test adapter disabled');
    const key = `${ctx.empresaId}:${ctx.operationKey}`;
    const old = this.results.get(key);
    if (old) return old;
    const { mockProvider } = await import('../../../../server/src/gateway');
    const r = await mockProvider.criaCobranca(
      { empresaId: ctx.empresaId, config: {}, credenciais: {}, webhookSegredo: null },
      { valor: input.amount / 100, metodo: 'pix', referencia: ctx.operationKey, payer_email: input.email }
    );
    const result: PaymentResult = {
      reference: r.provider_ref,
      status: 'PENDING',
      action: { type: 'PIX', code: r.copia_cola || undefined, qrCode: r.qr_code || undefined },
    };
    this.results.set(key, result);
    return result;
  }
}
