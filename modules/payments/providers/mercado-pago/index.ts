import { GenericPaymentProvider } from '../generic';
import { capability, type PaymentInput, type PaymentResult, type ProviderContext } from '../payment-provider';
import { mercadopagoProvider } from './legacy';
const legacy = async () => {
  const { getProvider } = await import('../../../../server/src/gateway');
  const p = getProvider('mercadopago');
  if (!p) throw new PaymentError('PROVIDER_UNAVAILABLE');
  return p;
};
import { PaymentError } from '../../domain/payment';
import type { GatewayContext, MetodoCobranca } from '../../../../server/src/gateway';
import { providerRequest } from '../http';
export const legacyMethods: Partial<Record<PaymentInput['method'], MetodoCobranca>> = {
  PIX: 'pix',
  BOLETO: 'boleto',
  CREDIT_CARD: 'cartao_credito',
  DEBIT_CARD: 'cartao_debito',
};
const legacyContext = (ctx: ProviderContext): GatewayContext => ({
  empresaId: ctx.empresaId,
  operationKey: ctx.operationKey,
  config: {},
  credenciais: ctx.credentials,
  webhookSegredo: ctx.webhookSecret,
});
export class MercadoPagoProvider extends GenericPaymentProvider {
  constructor() {
    super('MERCADO_PAGO', 'mercadopago');
  }
  capabilities(ctx: ProviderContext) {
    if (!(ctx.credentials.access_token || ctx.credentials.accessToken) || !ctx.webhookSecret) return [];
    // Preserve existing PIX integration. Other methods need an explicitly enabled secure checkout flow.
    const enabled = (ctx.credentials.enabled_methods || 'PIX').split(',');
    return ['PIX'].filter((m) => enabled.includes(m)).map(() => capability('PIX', { refund: true, partialRefund: true, cancel: true }));
  }
  async createPaymentIntent(ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult> {
    if (!this.supports(ctx, input.method)) throw new PaymentError('INVALID_PAYMENT_METHOD');
    try {
      const r = await (
        await legacy()
      ).criaCobranca(legacyContext(ctx), {
        valor: input.amount / 100,
        metodo: legacyMethods[input.method]!,
        referencia: ctx.operationKey,
        payer_email: input.email,
        token: input.token,
        parcelas: input.installments,
        expira_em: input.expiresAt,
      });
      return {
        reference: r.provider_ref,
        status: r.status === 'paga' ? 'PAID' : r.status === 'autorizada' ? 'AUTHORIZED' : r.status === 'falhou' ? 'FAILED' : 'PENDING',
        action: {
          type: input.method,
          code: r.copia_cola || r.linha_digitavel || undefined,
          qrCode: r.qr_code || undefined,
          expiresAt: r.expires_em || undefined,
        },
      };
    } catch (e) {
      // Existing transport cannot establish whether a write reached MP. Never double-charge via fallback.
      if (e instanceof PaymentError) throw e;
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    }
  }
  async getPayment(ctx: ProviderContext, reference: string): Promise<PaymentResult> {
    const r = await (await legacy()).consultaCobranca(legacyContext(ctx), reference);
    const b = r?.bruto || {};
    const state = String(b.status || '');
    // Não substitua a referência retornada pela solicitada nem transforme
    // null/ausência em zero: ambos poderiam confirmar um fato inexistente.
    const rawRefund = b.transaction_amount_refunded;
    const refundValue = rawRefund === null || rawRefund === undefined || rawRefund === '' || typeof rawRefund === 'boolean' ? NaN : Number(rawRefund);
    const rawAmount = b.transaction_amount;
    const total = rawAmount === null || rawAmount === undefined || rawAmount === '' || typeof rawAmount === 'boolean' ? NaN : Number(rawAmount);
    if (!b.id || String(b.id) !== reference || !Number.isFinite(total) || total <= 0 || typeof b.currency_id !== 'string' || !b.currency_id ||
        (['approved', 'refunded'].includes(state) && (!Number.isFinite(refundValue) || refundValue < 0 || refundValue > total)))
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const refunded = Number.isFinite(refundValue) ? Math.round(refundValue * 100) : undefined;
    const states: Record<string, PaymentResult['status']> = {
      approved: (refunded ?? 0) > 0 ? 'PARTIALLY_REFUNDED' : 'PAID',
      authorized: 'AUTHORIZED',
      cancelled: 'CANCELED',
      rejected: 'FAILED',
      refunded: 'REFUNDED',
      charged_back: 'CHARGEBACK',
      in_mediation: 'DISPUTED',
      pending: 'PENDING',
      in_process: 'PENDING',
    };
    return {
      reference: String(b.id),
      status: states[state] || 'PENDING',
      amount: Math.round(total * 100),
      currency: String(b.currency_id || ''),
      refunded,
    };
  }
  async cancel(ctx: ProviderContext, reference: string): Promise<PaymentResult> {
    await (await legacy()).cancelaCobranca(legacyContext(ctx), reference);
    return this.getPayment(ctx, reference);
  }
  async refund(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult> {
    await (await legacy()).estornaCobranca(legacyContext(ctx), reference, amount / 100);
    return this.getPayment(ctx, reference);
  }
  verifyWebhook(ctx: ProviderContext, raw: string, headers: Record<string, string | undefined>) {
    return !!ctx.webhookSecret && mercadopagoProvider.verificaAssinatura(legacyContext(ctx), raw, headers);
  }
  parseWebhook(raw: string) {
    const e = mercadopagoProvider.parseWebhook(raw);
    return e?.provider_ref ? { id: e.evento_id, reference: e.provider_ref, type: e.evento || 'payment' } : null;
  }
  async healthCheck(ctx: ProviderContext): Promise<'UP' | 'DOWN' | 'NOT_CONFIGURED'> {
    if (!this.capabilities(ctx).length) return 'NOT_CONFIGURED';
    try {
      await providerRequest('https://api.mercadopago.com/users/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${ctx.credentials.access_token || ctx.credentials.accessToken}` },
      });
      return 'UP';
    } catch {
      return 'DOWN';
    }
  }
}
