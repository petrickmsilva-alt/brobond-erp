import { GenericPaymentProvider } from '../generic';
import { capability, type PaymentInput, type PaymentResult, type ProviderContext, type RefundEvidence } from '../payment-provider';
import { PaymentError } from '../../domain/payment';
import { providerRequest, validHmac } from '../http';
function refundEvidence(raw: Record<string, unknown>, paymentReference: string, paymentIntent: string): RefundEvidence | undefined {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const remoteIntent = typeof raw.payment_intent === 'string' ? raw.payment_intent : '';
  const status = String(raw.status || '');
  if (!id || id !== id.trim() || id.length > 160 || Array.from(id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || remoteIntent !== paymentIntent ||
      raw.currency !== 'brl' || !Number.isSafeInteger(raw.amount) || Number(raw.amount) <= 0 || !['succeeded', 'pending'].includes(status)) return undefined;
  return { reference: id, paymentReference, amount: Number(raw.amount), status: status === 'succeeded' ? 'SUCCEEDED' : 'PENDING' };
}
/** Official Checkout Sessions / PaymentIntents / Refunds APIs. Account opt-in is mandatory. */
export class StripeProvider extends GenericPaymentProvider {
  constructor() {
    super('STRIPE', 'stripe');
  }
  capabilities(ctx: ProviderContext) {
    if (!ctx.credentials.secret_key || !ctx.webhookSecret || !ctx.credentials.return_url?.startsWith('https://')) return [];
    const enabled = (ctx.credentials.enabled_methods || '').split(',');
    return ['CREDIT_CARD', 'PIX', 'BOLETO']
      .filter((m) => enabled.includes(m))
      .map((m) =>
        capability(m as PaymentInput['method'], {
          currencies: ['BRL'],
          authorize: m === 'CREDIT_CARD',
          capture: m === 'CREDIT_CARD',
          cancel: true,
          refund: true,
          partialRefund: true,
          tokenization: m === 'CREDIT_CARD',
          threeDS: m === 'CREDIT_CARD',
        })
      );
  }
  private call(ctx: ProviderContext, path: string, data?: URLSearchParams) {
    if (!ctx.credentials.secret_key) throw new PaymentError('PROVIDER_UNAVAILABLE');
    return providerRequest(`https://api.stripe.com/v1${path}`, {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${ctx.credentials.secret_key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': ctx.operationKey,
      },
      ...(data ? { body: data.toString() } : {}),
    });
  }
  async createPaymentIntent(ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult> {
    if (!this.supports(ctx, input.method) || !ctx.credentials.return_url?.startsWith('https://'))
      throw new PaymentError('INVALID_PAYMENT_METHOD');
    const data = new URLSearchParams({
      mode: 'payment',
      success_url: ctx.credentials.return_url,
      cancel_url: ctx.credentials.return_url,
      customer_email: input.email,
      client_reference_id: input.reference,
      'metadata[reference]': input.reference,
      'payment_intent_data[metadata][reference]': input.reference,
      'payment_method_types[0]': ({ CREDIT_CARD: 'card', PIX: 'pix', BOLETO: 'boleto' } as Record<string, string>)[input.method],
      'line_items[0][price_data][currency]': input.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(input.amount),
      'line_items[0][price_data][product_data][name]': 'Pedido BROBOND',
      'line_items[0][quantity]': '1',
    });
    if (input.method === 'BOLETO') data.set('tax_id_collection[enabled]', 'true');
    if (ctx.credentials.capture_mode === 'manual' && input.method === 'CREDIT_CARD')
      data.set('payment_intent_data[capture_method]', 'manual');
    const r = await this.call(ctx, '/checkout/sessions', data);
    if (!r.id || !r.url) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    return { reference: r.id, status: 'REQUIRES_ACTION', action: { type: 'REDIRECT', url: r.url } };
  }
  authorize(ctx: ProviderContext, input: PaymentInput) {
    return this.createPaymentIntent({ ...ctx, credentials: { ...ctx.credentials, capture_mode: 'manual' } }, input);
  }
  async capture(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult> {
    const session = await this.call(ctx, `/checkout/sessions/${encodeURIComponent(reference)}`);
    if (session.id !== reference || typeof session.payment_intent !== 'string' || !session.payment_intent)
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    await this.call(
      ctx,
      `/payment_intents/${encodeURIComponent(String(session.payment_intent))}/capture`,
      new URLSearchParams({ amount_to_capture: String(amount) })
    );
    return this.getPayment(ctx, reference);
  }
  async cancel(ctx: ProviderContext, reference: string): Promise<PaymentResult> {
    const session = await this.call(ctx, `/checkout/sessions/${encodeURIComponent(reference)}?expand[]=payment_intent`);
    if (session.id !== reference) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const pi = session.payment_intent;
    if (
      pi && typeof pi.id === 'string' && pi.id &&
      typeof pi === 'object' &&
      ['requires_capture', 'requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)
    ) {
      await this.call(ctx, `/payment_intents/${encodeURIComponent(pi.id)}/cancel`, new URLSearchParams());
    } else if (session.status === 'open')
      await this.call(ctx, `/checkout/sessions/${encodeURIComponent(reference)}/expire`, new URLSearchParams());
    else throw new PaymentError('INVALID_REQUEST');
    return this.getPayment(ctx, reference);
  }
  async getPayment(ctx: ProviderContext, reference: string): Promise<PaymentResult> {
    const r = await this.call(ctx, `/checkout/sessions/${encodeURIComponent(reference)}?expand[]=payment_intent`);
    const pi = typeof r.payment_intent === 'object' && r.payment_intent ? r.payment_intent : null;
    const total = r.amount_total;
    if (r.id !== reference || !Number.isSafeInteger(total) || total <= 0 || typeof r.currency !== 'string' || !r.currency)
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const reportsPaid = r.payment_status === 'paid' || pi?.status === 'succeeded';
    if (reportsPaid && (!pi || typeof pi.id !== 'string' || !pi.id || !Number.isSafeInteger(pi.amount_received) || pi.amount_received !== total))
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true); // a captura integral precisa ser comprovada
    let refunded: number | undefined;
    const latestCharge = typeof pi?.latest_charge === 'string' ? pi.latest_charge : pi?.latest_charge?.id;
    if (latestCharge) {
      const charge = await this.call(ctx, `/charges/${encodeURIComponent(String(latestCharge))}`);
      if (!pi?.id || charge.id !== latestCharge || charge.payment_intent !== pi.id || charge.currency !== r.currency ||
          !Number.isSafeInteger(charge.amount_captured) || charge.amount_captured !== total ||
          !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > total)
        throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      refunded = charge.amount_refunded;
    } else if (reportsPaid) {
      // Falta o valor autoritativo de estorno; não transformar ausência em zero.
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    }
    return {
      reference: String(r.id), amount: total, currency: r.currency.toUpperCase(), refunded,
      status: refunded === total ? 'REFUNDED' : (refunded ?? 0) > 0 ? 'PARTIALLY_REFUNDED' : reportsPaid ? 'PAID' :
        pi?.status === 'requires_capture' ? 'AUTHORIZED' : pi?.status === 'canceled' ? 'CANCELED' : r.status === 'expired' ? 'EXPIRED' : 'PENDING',
    };
  }
  async refund(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult> {
    const session = await this.call(ctx, `/checkout/sessions/${encodeURIComponent(reference)}`);
    if (session.id !== reference || typeof session.payment_intent !== 'string' || !session.payment_intent)
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const r = await this.call(ctx, '/refunds', new URLSearchParams({ payment_intent: session.payment_intent, amount: String(amount) }));
    const candidate = refundEvidence(r, reference, session.payment_intent);
    const evidence = candidate?.amount === amount ? candidate : undefined;
    // A resposta da operação é conservada mesmo se a leitura seguinte falhar.
    try { return { ...await this.getPayment(ctx, reference), ...(evidence ? { refundEvidence: evidence } : {}) }; }
    catch { return { reference, status: 'PENDING', ...(evidence ? { refundEvidence: evidence } : {}) }; }
  }
  async getRefund(ctx: ProviderContext, paymentReference: string, refundReference: string): Promise<RefundEvidence> {
    const session = await this.call(ctx, `/checkout/sessions/${encodeURIComponent(paymentReference)}`);
    if (session.id !== paymentReference || typeof session.payment_intent !== 'string' || !session.payment_intent)
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const r = await this.call(ctx, `/refunds/${encodeURIComponent(refundReference)}`);
    const evidence = refundEvidence(r, paymentReference, session.payment_intent);
    if (!evidence || evidence.reference !== refundReference) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    return evidence;
  }
  verifyWebhook(ctx: ProviderContext, raw: string, headers: Record<string, string | undefined>) {
    const signature = headers['stripe-signature'] || '';
    const ts = signature.match(/(?:^|,)t=(\d+)/)?.[1];
    if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    return [...signature.matchAll(/(?:^|,)v1=([a-f\d]+)/g)].some((m) => validHmac(ctx.webhookSecret, `${ts}.${raw}`, m[1]));
  }
  parseWebhook(raw: string) {
    try {
      const b = JSON.parse(raw);
      const o = b.data?.object;
      if (!b.id || !String(b.type).startsWith('checkout.session.') || !o?.id) return null;
      return { id: String(b.id), reference: String(o.id), type: String(b.type) };
    } catch {
      return null;
    }
  }
  async healthCheck(ctx: ProviderContext): Promise<'UP' | 'DOWN' | 'NOT_CONFIGURED'> {
    if (!ctx.credentials.secret_key || !ctx.webhookSecret) return 'NOT_CONFIGURED';
    try {
      await this.call(ctx, '/account');
      return 'UP';
    } catch {
      return 'DOWN';
    }
  }
}
