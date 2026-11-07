import { GenericPaymentProvider } from '../generic';
import { capability, type PaymentInput, type PaymentResult, type ProviderContext, type RefundEvidence } from '../payment-provider';
import { consultarEstornoMercadoPago, mercadopagoProvider } from './legacy';
const legacy = async () => {
  const { getProvider } = await import('../../../../server/src/gateway');
  const p = getProvider('mercadopago');
  if (!p) throw new PaymentError('PROVIDER_UNAVAILABLE');
  return p;
};
import { PaymentError } from '../../domain/payment';
import { normalizarInstrumentosPix, temInstrumentoPix, type PixInstrumentos } from '../../domain/pix-instrument';
import type { CobrancaProviderResult, GatewayContext, MetodoCobranca } from '../../../../server/src/gateway';
import { providerRequest } from '../http';
export const legacyMethods: Partial<Record<PaymentInput['method'], MetodoCobranca>> = {
  PIX: 'pix',
  BOLETO: 'boleto',
  CREDIT_CARD: 'cartao_credito',
  DEBIT_CARD: 'cartao_debito',
};
/** Instrumentos PIX de um resultado legado — cada campo no seu papel. */
function instrumentosDoLegado(r: CobrancaProviderResult | null | undefined): PixInstrumentos {
  if (!r) return {};
  return normalizarInstrumentosPix({ code: r.copia_cola ?? r.qr_code, qrCodeBase64: r.qr_code_base64, ticketUrl: r.ticket_url, expiresAt: r.expires_em });
}
const espera = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Consulta curta e LIMITADA de uma Order recém-criada (criação assíncrona do PSP). */
export const PIX_REFRESH_DELAYS_MS = { valores: [500, 1000] };
const legacyContext = (ctx: ProviderContext): GatewayContext => ({
  empresaId: ctx.empresaId,
  operationKey: ctx.operationKey,
  config: {},
  credenciais: ctx.credentials,
  webhookSegredo: ctx.webhookSecret,
});
/** Apenas um refund individual com identidade, pagamento e quantia verificados. */
function refundEvidence(raw: Record<string, unknown> | undefined, paymentReference: string): RefundEvidence | undefined {
  if (!raw || raw.id === null || raw.id === undefined || raw.payment_id === null || raw.payment_id === undefined) return undefined;
  const reference = String(raw.id);
  const status = String(raw.status || '');
  const value = raw.amount;
  const amount = value === null || value === undefined || value === '' || typeof value === 'boolean' ? NaN : Number(value);
  const cents = Math.round(amount * 100);
  if (!reference || reference !== reference.trim() || reference.length > 160 || Array.from(reference).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || String(raw.payment_id) !== paymentReference ||
      !Number.isSafeInteger(cents) || cents <= 0 || Math.abs(amount * 100 - cents) > 1e-6 || !['approved', 'pending'].includes(status)) return undefined;
  return { reference, paymentReference, amount: cents, status: status === 'approved' ? 'SUCCEEDED' : 'PENDING' };
}

export class MercadoPagoProvider extends GenericPaymentProvider {
  constructor() {
    super('MERCADO_PAGO', 'mercadopago');
  }
  capabilities(ctx: ProviderContext) {
    if (!(ctx.credentials.access_token || ctx.credentials.accessToken) || !ctx.webhookSecret) return [];
    // Checkout próprio: apenas PIX (fluxo seguro completo). O gateway legado
    // (cobrança avulsa do financeiro) preserva PIX, boleto e cartão tokenizado
    // via `createPaymentIntent`, sem um segundo caminho de criação.
    const enabled = (ctx.credentials.enabled_methods || 'PIX').split(',');
    const pedidos: Partial<Record<PaymentInput['method'], Parameters<typeof capability>[1]>> = {
      PIX: { refund: true, partialRefund: true, cancel: true },
      BOLETO: { cancel: true },
      CREDIT_CARD: { authorize: true, capture: true, cancel: true, refund: true, partialRefund: true, tokenization: true },
      DEBIT_CARD: { authorize: true, capture: true, cancel: true, refund: true, partialRefund: true, tokenization: true },
    };
    return (['PIX', 'BOLETO', 'CREDIT_CARD', 'DEBIT_CARD'] as const)
      .filter((m) => enabled.includes(m))
      .map((m) => capability(m, pedidos[m]));
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
        payer_documento: input.taxId ?? null,
        payer_nome: input.customerName ?? null,
        token: input.token,
        parcelas: input.installments,
        expira_em: input.expiresAt,
      });
      if (input.method !== 'PIX') {
        return {
          reference: r.provider_ref,
          status: r.status === 'falhou' ? 'FAILED' : 'PENDING',
          action: { type: input.method, code: r.linha_digitavel || undefined, nossoNumero: r.nosso_numero || undefined, ticketUrl: r.ticket_url || undefined, expiresAt: r.expires_em || undefined },
        };
      }
      // PIX: payment_method.qr_code → code (Copia e Cola), qr_code_base64 →
      // qrCodeBase64 (imagem), ticket_url → ticketUrl. Nenhum campo é gerado.
      let instrumentos = instrumentosDoLegado(r);
      let status: PaymentResult['status'] = r.status === 'falhou' ? 'FAILED' : 'PENDING';
      // Criação ASSÍNCRONA documentada pela Orders API: a Order pode nascer
      // `processing` sem os dados do PIX. Consulta curta e limitada pela MESMA
      // Order (GET /v1/orders/{id}) — nunca uma nova cobrança. Falha de leitura
      // não apaga a referência já devolvida (ela é persistida pelo engine).
      for (const atraso of PIX_REFRESH_DELAYS_MS.valores) {
        if (status === 'FAILED' || temInstrumentoPix(instrumentos)) break;
        await espera(atraso);
        try {
          const atual = await (await legacy()).consultaCobranca(legacyContext(ctx), r.provider_ref);
          if (atual?.status === 'falhou') status = 'FAILED';
          instrumentos = { ...instrumentosDoLegado(atual), ...Object.fromEntries(Object.entries(instrumentos).filter(([, v]) => v)) };
        } catch {
          /* leitura falhou: segue com o que já foi devolvido */
        }
      }
      return {
        reference: r.provider_ref,
        // Preserve the returned reference immediately, but do not settle on a
        // create response lacking the authenticated money/refund read below.
        status,
        action: {
          type: 'PIX',
          code: instrumentos.code,
          qrCodeBase64: instrumentos.qrCodeBase64,
          ticketUrl: instrumentos.ticketUrl,
          expiresAt: instrumentos.expiresAt || r.expires_em || undefined,
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
    const totalCents = Math.round(total * 100), refundCents = Math.round(refundValue * 100);
    const hasRefund = rawRefund !== null && rawRefund !== undefined && rawRefund !== '';
    if (!b.id || String(b.id) !== reference || !Number.isSafeInteger(totalCents) || totalCents <= 0 ||
        Math.abs(total * 100 - totalCents) > 1e-6 || typeof b.currency_id !== 'string' || !b.currency_id ||
        (['approved', 'refunded'].includes(state) && !hasRefund) ||
        (hasRefund && (!Number.isSafeInteger(refundCents) || refundCents < 0 || refundCents > totalCents || Math.abs(refundValue * 100 - refundCents) > 1e-6)))
      throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    const refunded = hasRefund ? refundCents : undefined;
    const states: Record<string, PaymentResult['status']> = {
      approved: (refunded ?? 0) > 0 ? 'PARTIALLY_REFUNDED' : 'PAID',
      authorized: 'AUTHORIZED',
      cancelled: 'CANCELED',
      rejected: 'FAILED',
      expired: 'EXPIRED',
      refunded: 'REFUNDED',
      charged_back: 'CHARGEBACK',
      in_mediation: 'DISPUTED',
      pending: 'PENDING',
      in_process: 'PENDING',
    };
    const pix = b.ordem_api === 'orders' || String(b.payment_method_id || '') === 'pix' ? instrumentosDoLegado(r) : {};
    return {
      reference: String(b.id),
      status: states[state] || 'PENDING',
      amount: totalCents,
      currency: String(b.currency_id || ''),
      refunded,
      // Instrumentos atuais do PIX (Order assíncrona, reemissão): permitem
      // completar a cobrança local sem criar outra.
      ...(temInstrumentoPix(pix) || pix.expiresAt ? { action: { type: 'PIX', ...pix } } : {}),
    };
  }
  async cancel(ctx: ProviderContext, reference: string): Promise<PaymentResult> {
    await (await legacy()).cancelaCobranca(legacyContext(ctx), reference);
    return this.getPayment(ctx, reference);
  }
  async refund(ctx: ProviderContext, reference: string, amount: number): Promise<PaymentResult> {
    const response = await (await legacy()).estornaCobranca(legacyContext(ctx), reference, amount / 100);
    const candidate = refundEvidence(response.bruto, reference);
    const evidence = candidate?.amount === amount ? candidate : undefined;
    // Se o POST retornou uma identidade e a consulta posterior falhou, devolva
    // a evidência para ser persistida antes do retry somente de leitura.
    try { return { ...await this.getPayment(ctx, reference), ...(evidence ? { refundEvidence: evidence } : {}) }; }
    catch { return { reference, status: 'PENDING', ...(evidence ? { refundEvidence: evidence } : {}) }; }
  }
  async getRefund(ctx: ProviderContext, paymentReference: string, refundReference: string): Promise<RefundEvidence> {
    const raw = await consultarEstornoMercadoPago(legacyContext(ctx), paymentReference, refundReference);
    const evidence = refundEvidence(raw, paymentReference);
    if (!evidence || evidence.reference !== refundReference) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
    return evidence;
  }
  verifyWebhook(ctx: ProviderContext, raw: string, headers: Record<string, string | undefined>, query?: Record<string, unknown>) {
    return !!ctx.webhookSecret && mercadopagoProvider.verificaAssinatura(legacyContext(ctx), raw, headers, query);
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
