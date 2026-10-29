import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../../../server/src/errors';
import { round2 } from '../../../../server/src/utils';
import type {
  GatewayContext,
  CobrancaInput,
  CobrancaProviderResult,
  MetodoCobranca,
  WebhookParse,
  IntencaoWebhook,
  PaymentProvider,
} from '../../../../server/src/gateway';
const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');
function compararConstante(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
const MP_API_BASE = () => process.env.GATEWAY_MP_API_BASE_URL?.trim() || 'https://api.mercadopago.com';

function mpToken(ctx: GatewayContext): string {
  const token = ctx.credenciais?.access_token || ctx.credenciais?.accessToken || '';
  if (!token) throw new HttpError(503, 'Gateway Mercado Pago não configurado. Cadastre o Access Token em Financeiro → Gateway.');
  return String(token);
}

async function mpFetch(caminho: string, init: RequestInit, ctx: GatewayContext): Promise<Record<string, unknown>> {
  let res: globalThis.Response;
  try {
    res = await fetch(new URL(caminho, MP_API_BASE()), {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${mpToken(ctx)}`,
        ...(init.headers || {}),
      },
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(503, 'Falha de rede ao contatar o Mercado Pago.');
  }
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = `HTTP ${res.status}`;
    throw new HttpError(res.status >= 500 ? 502 : 400, `Mercado Pago recusou: ${msg}`);
  }
  return payload;
}

function mpMapeiaStatus(status: string): CobrancaProviderResult['status'] {
  switch (status) {
    case 'approved':
      return 'paga';
    case 'authorized':
      return 'autorizada';
    case 'rejected':
      return 'falhou';
    default:
      return 'pendente';
  }
}

function mpExtraiInstrumento(p: Record<string, unknown>, metodo: MetodoCobranca): Partial<CobrancaProviderResult> {
  if (metodo === 'pix') {
    const poi = (p.point_of_interaction || {}) as Record<string, unknown>;
    const td = (poi.transaction_data || {}) as Record<string, unknown>;
    return { qr_code: (td.qr_code_base64 as string) || null, copia_cola: (td.qr_code as string) || null };
  }
  if (metodo === 'boleto') {
    const td = (p.transaction_details || {}) as Record<string, unknown>;
    return { linha_digitavel: (td.digitable_line as string) || null, nosso_numero: (p.statement_descriptor as string) || null };
  }
  const td = (p.transaction_details || {}) as Record<string, unknown>;
  return { nsu: (td.payment_method_reference_id as string) || null };
}

/** Interpret the same authoritative response that was checked against the local charge. */
export function intencaoMercadoPago(atual: CobrancaProviderResult): IntencaoWebhook {
  const st = String(atual.bruto?.status || '');
  const devolvido = Number(atual.bruto?.transaction_amount_refunded || 0);
  if (st === 'approved' && devolvido > 0) throw new HttpError(409, 'Estorno parcial em cobrança legada requer conciliação manual.');
  if (st === 'approved') return 'paga';
  if (st === 'cancelled' || st === 'rejected') return 'cancelada';
  if (st === 'charged_back') throw new HttpError(409, 'Chargeback em cobrança legada requer revisão; não é estorno.');
  if (st === 'refunded') {
    const total = Number(atual.bruto?.transaction_amount);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(devolvido) || round2(devolvido) !== round2(total))
      throw new HttpError(409, 'Valor integral do estorno legado não pôde ser confirmado.');
    return 'estornada';
  }
  return null;
}

export const mercadopagoProvider: PaymentProvider = {
  id: 'mercadopago',
  nome: 'Mercado Pago',
  metodos: ['pix', 'boleto', 'cartao_credito', 'cartao_debito'],
  async criaCobranca(ctx: GatewayContext, input: CobrancaInput): Promise<CobrancaProviderResult> {
    const body: Record<string, unknown> = {
      transaction_amount: round2(input.valor),
      description: input.descricao || 'Cobrança BROBOND ERP',
      external_reference: input.referencia || null,
    };
    if (input.metodo === 'pix') {
      if (!input.payer_email)
        throw new HttpError(400, 'Cobrança PIX exige o e-mail do pagador (payer_email).', { payer_email: 'Obrigatório' });
      body.payment_method_id = 'pix';
      body.payer = { email: input.payer_email };
      if (input.expira_em) body.date_of_expiration = input.expira_em;
    } else if (input.metodo === 'boleto') {
      if (!input.payer_email)
        throw new HttpError(400, 'Cobrança boleto exige o e-mail do pagador (payer_email).', { payer_email: 'Obrigatório' });
      body.payment_method_id = 'bolbradesco';
      body.payer = { email: input.payer_email };
      if (input.vencimento) body.date_of_expiration = `${input.vencimento}T23:59:59.000-03:00`;
    } else {
      if (!input.token) {
        throw new HttpError(
          503,
          'Pagamento com cartão exige token gerado pelo SDK do Mercado Pago (PCI). O ERP não captura dados de cartão.'
        );
      }
      body.token = input.token;
      body.installments = Math.max(1, Math.trunc(input.parcelas || 1));
      body.capture = true; // autorização + captura
    }
    const p = await mpFetch(
      '/v1/payments',
      { method: 'POST', headers: { 'X-Idempotency-Key': input.referencia || randomBytes(16).toString('hex') }, body: JSON.stringify(body) },
      ctx
    );
    if (!p.id) throw new HttpError(502, 'Mercado Pago não retornou o identificador do pagamento.');
    return {
      provider_ref: String(p.id),
      status: mpMapeiaStatus(String(p.status || 'pending')),
      expires_em: (p.date_of_expiration as string) || null,
      nsu: mpExtraiInstrumento(p, input.metodo).nsu ?? null,
      qr_code: mpExtraiInstrumento(p, input.metodo).qr_code ?? null,
      copia_cola: mpExtraiInstrumento(p, input.metodo).copia_cola ?? null,
      linha_digitavel: mpExtraiInstrumento(p, input.metodo).linha_digitavel ?? null,
      bruto: p,
    };
  },
  async consultaCobranca(ctx: GatewayContext, providerRef: string): Promise<CobrancaProviderResult | null> {
    const p = await mpFetch(`/v1/payments/${encodeURIComponent(providerRef)}`, { method: 'GET' }, ctx);
    return { provider_ref: String(p.id || providerRef), status: mpMapeiaStatus(String(p.status || '')), bruto: p };
  },
  async cancelaCobranca(ctx: GatewayContext, providerRef: string): Promise<{ status: string }> {
    await mpFetch(
      `/v1/payments/${encodeURIComponent(providerRef)}`,
      {
        method: 'PUT',
        headers: { 'X-Idempotency-Key': ctx.operationKey || `cancel:${providerRef}` },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      ctx
    );
    return { status: 'cancelada' };
  },
  async estornaCobranca(ctx: GatewayContext, providerRef: string, valor?: number): Promise<{ status: string }> {
    const body = valor && valor > 0 ? { amount: round2(valor) } : {};
    await mpFetch(
      `/v1/payments/${encodeURIComponent(providerRef)}/refunds`,
      {
        method: 'POST',
        headers: { 'X-Idempotency-Key': ctx.operationKey || `refund:${providerRef}:${valor ?? 'full'}` },
        body: JSON.stringify(body),
      },
      ctx
    );
    return { status: 'estornada' };
  },
  parseWebhook(corpo: string): WebhookParse | null {
    try {
      const body = JSON.parse(corpo) as Record<string, unknown>;
      const tipo = String(body.type || body.topic || '');
      const data = (body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {}) as Record<string, unknown>;
      const ref = String(data.id || body.id || '');
      if (!ref || !/^payment/i.test(tipo)) return null;
      return {
        evento_id: String(
          body.id || body['x-request-id'] || body.request_id || `${tipo}:${ref}:${body.action || ''}:${body.date_created || ''}`
        ),
        evento: tipo,
        provider_ref: ref,
      };
    } catch {
      return null;
    }
  },
  verificaAssinatura(ctx: GatewayContext, corpo: string, headers: Record<string, string | undefined>): boolean {
    const segredo = ctx.webhookSegredo;
    if (!segredo) return true;
    const assinatura = String(headers['x-signature'] || '');
    const m = assinatura.match(/ts=([^,]+),\s*v1=([a-f0-9]+)/i);
    if (!m) return false;
    const [, ts, v1] = m;
    let id = '';
    try {
      const body = JSON.parse(corpo) as Record<string, unknown>;
      const data = (body.data || {}) as Record<string, unknown>;
      id = String((data as Record<string, unknown>).id || '');
    } catch {
      return false;
    }
    const reqId = String(headers['x-request-id'] || '');
    const manifest = `id:${id.toLowerCase()};request-id:${reqId};ts:${ts};`;
    return compararConstante(v1.toLowerCase(), hmacHex(segredo, manifest));
  },
  async resolveWebhook(ctx: GatewayContext, parsed: WebhookParse): Promise<IntencaoWebhook> {
    // O Mercado Pago manda só a referência: o estado real vem da consulta.
    const atual = await this.consultaCobranca(ctx, parsed.provider_ref!);
    if (!atual) return null;
    return intencaoMercadoPago(atual);
  },
};
