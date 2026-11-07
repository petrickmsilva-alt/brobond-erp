import { createHash, timingSafeEqual } from 'node:crypto';
import { GenericPaymentProvider } from '../generic';
import { capability, type PaymentInput, type PaymentResult, type ProviderContext } from '../payment-provider';
import { PaymentError } from '../../domain/payment';
import { providerRequest } from '../http';
/** PagBank Orders API. Only implemented/account-enabled methods are advertised. */
export class PagBankProvider extends GenericPaymentProvider {
  constructor() {
    super('PAGBANK', 'pagbank');
  }
  capabilities(ctx: ProviderContext) {
    if (!ctx.credentials.access_token || !ctx.webhookSecret || !ctx.credentials.notification_url?.startsWith('https://')) return [];
    // PIX Orders implemented; raw-card/debit/boleto flows require additional payer/PCI contracts.
    return (ctx.credentials.enabled_methods || '').split(',').includes('PIX')
      ? [capability('PIX', { refund: true, partialRefund: true, requiredCustomerFields: ['name', 'email', 'tax_id'] })]
      : [];
  }
  private call(ctx: ProviderContext, path: string, data?: object) {
    if (!ctx.credentials.access_token) throw new PaymentError('PROVIDER_UNAVAILABLE');
    const base = ctx.environment === 'teste' ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
    return providerRequest(`${base}${path}`, {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${ctx.credentials.access_token}`,
        'Content-Type': 'application/json',
        'x-idempotency-key': ctx.operationKey,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  }
  async createPaymentIntent(ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult> {
    if (!this.supports(ctx, input.method) || !/^([0-9]{11}|[0-9]{14})$/.test(input.taxId || '') || !input.customerName)
      throw new PaymentError('INVALID_REQUEST');
    const r = await this.call(ctx, '/orders', {
      reference_id: input.reference,
      customer: { name: input.customerName, email: input.email, tax_id: input.taxId },
      items: [{ reference_id: input.reference, name: 'Pedido BROBOND', quantity: 1, unit_amount: input.amount }],
      qr_codes: [{ amount: { value: input.amount }, ...(input.expiresAt ? { expiration_date: input.expiresAt } : {}) }],
      ...(ctx.credentials.notification_url ? { notification_urls: [ctx.credentials.notification_url] } : {}),
    });
    if (!r.id) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    return {
      reference: r.id,
      status: 'PENDING',
      action: { type: 'PIX', code: r.qr_codes?.[0]?.text, expiresAt: r.qr_codes?.[0]?.expiration_date },
    };
  }
  async getPayment(ctx: ProviderContext, reference: string): Promise<PaymentResult> {
    const r = await this.call(ctx, `/orders/${encodeURIComponent(reference)}`);
    type Charge = { id?: string; status?: string; amount?: { currency?: string; summary?: { paid?: number; refunded?: number } } };
    type Item = { unit_amount?: number; quantity?: number };
    if (r.id !== reference || !Array.isArray(r.items) || !Array.isArray(r.charges))
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const items = r.items as Item[];
    if (!items.length || items.some((i) => !Number.isSafeInteger(i.unit_amount) || Number(i.unit_amount) < 0 ||
        !Number.isSafeInteger(i.quantity) || Number(i.quantity) <= 0)) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const amount = items.reduce((n, i) => n + Number(i.unit_amount) * Number(i.quantity), 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const charges = (r.charges as Charge[]).filter((c) => ['PAID', 'CANCELED'].includes(String(c.status)));
    if (new Set(charges.map((c) => c.id)).size !== charges.length) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    if (charges.some((c) => !c.id || c.amount?.currency !== 'BRL' || !Number.isSafeInteger(c.amount?.summary?.paid) ||
        Number(c.amount?.summary?.paid) < 0 || !Number.isSafeInteger(c.amount?.summary?.refunded) ||
        Number(c.amount?.summary?.refunded) < 0 || Number(c.amount?.summary?.refunded) > Number(c.amount?.summary?.paid)))
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const paid = charges.reduce((n, c) => n + Number(c.amount!.summary!.paid), 0);
    const refunded = charges.reduce((n, c) => n + Number(c.amount!.summary!.refunded), 0);
    if (!Number.isSafeInteger(paid) || !Number.isSafeInteger(refunded) || (paid !== 0 && paid !== amount) ||
        (charges.some((c) => c.status === 'PAID') && paid !== amount)) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    return {
      reference: String(r.id), amount, currency: 'BRL', refunded: charges.length ? refunded : undefined,
      status: refunded === amount ? 'REFUNDED' : refunded > 0 ? 'PARTIALLY_REFUNDED' :
        charges.some((c) => c.status === 'PAID') ? 'PAID' : 'PENDING',
    };
  }
  async refund(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult> {
    const order = await this.call(ctx, `/orders/${encodeURIComponent(reference)}`);
    if (order.id !== reference || !Array.isArray(order.charges)) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const paid = order.charges.filter((c: { status?: string }) => c.status === 'PAID');
    if (paid.length !== 1 || !paid[0]?.id) throw new PaymentError('INVALID_REQUEST');
    const charge = paid[0];
    await this.call(ctx, `/charges/${encodeURIComponent(charge.id)}/cancel`, { amount: { value: amount } });
    return this.getPayment(ctx, reference);
  }
  verifyWebhook(ctx: ProviderContext, raw: string, headers: Record<string, string | undefined>) {
    // PagBank authenticates with SHA256(token + '-' + original payload), not HMAC.
    const token = ctx.credentials.access_token;
    const supplied = headers['x-authenticity-token'] || '';
    // R-10: sem segredo de webhook próprio configurado, nada é aceito (falha fechada).
    // Segredo vazio ou só espaços é ausente (defesa própria do verificador, sem depender da configuração).
    if (!ctx.webhookSecret || !String(ctx.webhookSecret).trim()) return false;
    if (!token || !/^[a-f\d]{64}$/i.test(supplied)) return false;
    return timingSafeEqual(Buffer.from(createHash('sha256').update(`${token}-${raw}`).digest('hex')), Buffer.from(supplied.toLowerCase()));
  }
  parseWebhook(raw: string) {
    try {
      const b = JSON.parse(raw);
      const orderId = String(b.id || '');
      if (!orderId.startsWith('ORDE_')) return null;
      // P3-02: o payload do webhook de Order NÃO tem um identificador de
      // notificação no topo, mas o contrato oficial inclui, para PIX, um
      // `charges[].payment_method.pix.notification_id` (formato `NTF_...`) que
      // identifica a NOTIFICAÇÃO. Fonte:
      // developer.pagbank.com.br/reference/webhooks ("notification_id").
      // A identidade é:
      //   1. os `notification_id` oficiais, quando presentes (mais estável que
      //      qualquer composição — uma reentrega do mesmo aviso mantém o mesmo
      //      id mesmo com bytes diferentes);
      //   2. senão, a Order (`id`) + o conjunto normalizado de cobranças
      //      (`charges[].id` + `charges[].status`) — de modo que:
      //        • reentrega do mesmo estado, com formatação diferente, deduplica;
      //        • mudança legítima de estado da MESMA cobrança é um evento novo;
      //        • uma nova cobrança na mesma Order também é um evento novo.
      // O hash do corpo continua como evidência complementar em
      // `gateway_webhook_events.payload_hash` (nunca como chave de deduplicação).
      const charges = Array.isArray(b.charges) ? (b.charges as Record<string, unknown>[]) : [];
      const notificationIds = [
        ...new Set(
          charges
            .map((c) => {
              const pm = c?.payment_method as Record<string, unknown> | undefined;
              const pix = pm?.pix as Record<string, unknown> | undefined;
              const ntf = String(pix?.notification_id ?? '');
              return ntf.startsWith('NTF_') ? ntf : '';
            })
            .filter(Boolean)
        ),
      ].sort();
      if (notificationIds.length) return { id: `${orderId}:${notificationIds.join('|')}`.slice(0, 300), reference: orderId, type: 'order.notification' };
      const assinatura = charges.length
        ? charges
            .map((c) => `${String(c?.id ?? '')}:${String(c?.status ?? '')}`)
            .sort()
            .join('|')
        : String(b.status ?? '');
      return { id: `${orderId}:${assinatura}`.slice(0, 300), reference: orderId, type: 'order.updated' };
    } catch {
      return null;
    }
  }
  async healthCheck(ctx: ProviderContext): Promise<'DEGRADED' | 'NOT_CONFIGURED'> {
    // No fabricated connectivity: there is no undocumented ping endpoint.
    return ctx.credentials.access_token && ctx.webhookSecret ? 'DEGRADED' : 'NOT_CONFIGURED';
  }
}
