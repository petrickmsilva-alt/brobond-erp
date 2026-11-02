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

// ---------------------------------------------------------------------------
// MERCADO PAGO ORDERS API (PIX) — https://api.mercadopago.com/v1/orders
//
// Contrato oficial (Checkout API Orders / Pix):
//   POST /v1/orders   { type:"online", processing_mode:"automatic",
//     total_amount:"<string com 2 decimais>", external_reference, payer,
//     transactions.payments:[{ amount, payment_method:{ id:"pix",
//                                                     type:"bank_transfer" } }] }
//   resposta → transactions.payments[0].payment_method:
//     qr_code (EMV "Copia e Cola"), qr_code_base64 (imagem), ticket_url
//   GET /v1/orders/{id} → status "processed" + status_detail "accredited"
//   Webhook: type="order", data.id=<order id>, assinatura x-signature/v1.
//
// Access Token, X-Idempotency-Key e segredo de webhook ficam EXCLUSIVAMENTE
// no backend. Nenhum QR é gerado localmente: sem payload real, os campos
// ficam null e a loja mostra estado honesto.
// ---------------------------------------------------------------------------
function ehOrdemMercadoPago(ref: unknown): boolean {
  return /^ORD/i.test(String(ref ?? '').trim());
}

function pagamentosDaOrdem(r: Record<string, unknown>): Record<string, unknown>[] {
  const transacoes = (r.transactions && typeof r.transactions === 'object' ? r.transactions : {}) as Record<string, unknown>;
  return Array.isArray(transacoes.payments) ? (transacoes.payments as Record<string, unknown>[]) : [];
}

function metodoDoPrimeiroPagamento(r: Record<string, unknown>): Record<string, unknown> {
  const primeiro = pagamentosDaOrdem(r)[0] || {};
  return (primeiro.payment_method && typeof primeiro.payment_method === 'object' ? primeiro.payment_method : {}) as Record<string, unknown>;
}

function apenasTexto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function ticketUrlSegura(v: unknown): string | null {
  const url = apenasTexto(v);
  return url && /^https:\/\//i.test(url) ? url : null;
}

/** Duração ISO-8601 derivada do prazo REAL de expiração do pedido. */
function duracaoOrders(expiraEm?: string | null): string | undefined {
  if (!expiraEm) return undefined;
  const restante = new Date(expiraEm).getTime() - Date.now();
  if (!Number.isFinite(restante) || restante <= 0) return undefined;
  const minutos = Math.max(1, Math.ceil(restante / 60_000));
  return minutos < 1440 ? `PT${minutos}M` : `P${Math.ceil(minutos / 1440)}D`;
}

function documentoPagador(v?: string | null): { type: 'CPF' | 'CNPJ'; number: string } | null {
  const digitos = String(v ?? '').replace(/\D/g, '');
  if (digitos.length === 11) return { type: 'CPF', number: digitos };
  if (digitos.length === 14) return { type: 'CNPJ', number: digitos };
  return null;
}

/**
 * Projeção do contrato Orders para o formato canônico já usado pelo domínio
 * (status/transaction_amount/currency_id/...). É ADAPTAÇÃO de campos reais,
 * não invenção: valores ausentes/ambíguos ficam undefined e as guardas
 * existentes (409 de conciliação) continuam impedindo baixa sem prova.
 */
function projecaoOrdem(r: Record<string, unknown>): Record<string, unknown> {
  const status = String(r.status || '');
  const detalhe = String(r.status_detail || '');
  const pm = metodoDoPrimeiroPagamento(r);
  const total = Number(r.total_amount);
  const totalValido = Number.isFinite(total) && total > 0 ? total : null;
  const pagoBruto = r.total_paid_amount;
  const pago = pagoBruto === null || pagoBruto === undefined || pagoBruto === '' ? null : Number(pagoBruto);
  const pagoValido = pago !== null && Number.isFinite(pago) && pago >= 0 ? pago : null;

  let statusCanonico = 'pending';
  if (status === 'processed' && detalhe === 'accredited') statusCanonico = 'approved';
  else if (status === 'processed' && /refunded/i.test(detalhe)) statusCanonico = 'refunded';
  else if (status === 'cancelled' || status === 'expired') statusCanonico = 'cancelled';
  else if (/rejected|failed|error/i.test(detalhe)) statusCanonico = 'rejected';

  // `accredited` = valor integral creditado, sem estorno. Nos demais casos só
  // afirmamos "devolvido" quando os dois valores vieram do provedor.
  const devolvido = statusCanonico === 'approved' ? 0
    : totalValido !== null && pagoValido !== null ? Math.max(0, totalValido - pagoValido) : null;

  return {
    ...r,
    id: r.id,
    ordem_api: 'orders',
    status: statusCanonico,
    status_detail: detalhe,
    transaction_amount: totalValido ?? undefined,
    transaction_amount_refunded: devolvido ?? undefined,
    currency_id: apenasTexto(r.currency) ?? undefined,
    payment_method_qr_code: apenasTexto(pm.qr_code),
    payment_method_qr_code_base64: apenasTexto(pm.qr_code_base64),
    payment_method_ticket_url: ticketUrlSegura(pm.ticket_url),
  };
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

/** Parse monetary evidence without rounding a fractional cent into a fact. */
export function valorMercadoPagoEmCentavos(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number')) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const amount = Number(value), cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents >= 0 && Math.abs(amount * 100 - cents) <= 1e-6 ? cents : null;
}

/** Interpret the same authoritative response that was checked against the local charge. */
export function intencaoMercadoPago(atual: CobrancaProviderResult): IntencaoWebhook {
  const st = String(atual.bruto?.status || '');
  const devolvido = valorMercadoPagoEmCentavos(atual.bruto?.transaction_amount_refunded);
  if (['approved', 'refunded'].includes(st) && devolvido === null)
    throw new HttpError(409, 'Valor de estorno legado ausente ou inválido; requer conciliação manual.');
  if (st === 'approved' && devolvido !== null && devolvido > 0) throw new HttpError(409, 'Estorno parcial em cobrança legada requer conciliação manual.');
  if (st === 'approved') return 'paga';
  if (st === 'cancelled' || st === 'rejected') return 'cancelada';
  if (st === 'charged_back') throw new HttpError(409, 'Chargeback em cobrança legada requer revisão; não é estorno.');
  if (st === 'refunded') {
    const total = valorMercadoPagoEmCentavos(atual.bruto?.transaction_amount);
    if (total === null || total <= 0 || devolvido === null || devolvido !== total)
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
      // ---------------- Orders API (PIX oficial) ----------------
      // Mantém o MESMO adapter/gateway: não cria integração paralela.
      if (!input.payer_email)
        throw new HttpError(400, 'Cobrança PIX exige o e-mail do pagador (payer_email).', { payer_email: 'Obrigatório' });
      const total = round2(input.valor).toFixed(2);
      const partesNome = String(input.payer_nome ?? '').trim().split(/\s+/).filter(Boolean);
      const payer: Record<string, unknown> = { email: input.payer_email };
      if (partesNome.length) payer.first_name = partesNome[0].slice(0, 60);
      if (partesNome.length > 1) payer.last_name = partesNome.slice(1).join(' ').slice(0, 60);
      const identificacao = documentoPagador(input.payer_documento);
      if (identificacao) payer.identification = identificacao;
      const pagamento: Record<string, unknown> = {
        amount: total,
        payment_method: { id: 'pix', type: 'bank_transfer' },
      };
      const duracao = duracaoOrders(input.expira_em);
      if (duracao) pagamento.expiration_time = duracao;
      const ordem: Record<string, unknown> = {
        type: 'online',
        processing_mode: 'automatic',
        total_amount: total,
        description: input.descricao || 'Pedido BROBOND',
        payer,
        transactions: { payments: [pagamento] },
      };
      if (input.referencia) ordem.external_reference = input.referencia;
      const r = await mpFetch(
        '/v1/orders',
        { method: 'POST', headers: { 'X-Idempotency-Key': input.referencia || randomBytes(16).toString('hex') }, body: JSON.stringify(ordem) },
        ctx
      );
      if (!r.id) throw new HttpError(502, 'Mercado Pago Orders API não retornou o identificador da Order.');
      // O valor ecoado pelo provedor precisa bater com o total autorizado no
      // servidor. Quando o campo vem ausente, NÃO se inventa confirmação.
      if (r.total_amount != null && Number.isFinite(Number(r.total_amount)) && Math.abs(Number(r.total_amount) - Number(total)) > 0.001)
        throw new HttpError(409, 'Total retornado pela Orders API diverge do pedido; conciliação necessária.');
      const pm = metodoDoPrimeiroPagamento(r);
      const status = String(r.status || '');
      const detalhe = String(r.status_detail || '');
      return {
        provider_ref: String(r.id),
        status: status === 'processed' && detalhe === 'accredited' ? 'paga'
          : status === 'cancelled' || /rejected|failed/i.test(detalhe) ? 'falhou' : 'pendente',
        expires_em: input.expira_em ?? null,
        qr_code: apenasTexto(pm.qr_code_base64),
        copia_cola: apenasTexto(pm.qr_code),
        ticket_url: ticketUrlSegura(pm.ticket_url),
        bruto: projecaoOrdem(r),
      };
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
    // Orders API: a confirmação de mudanças assíncronas vem de GET /v1/orders.
    // Cobranças legadas (/v1/payments) continuam consultadas como antes —
    // histórico e regressões permanecem válidos, sem sistema paralelo.
    if (ehOrdemMercadoPago(providerRef)) {
      const r = await mpFetch(`/v1/orders/${encodeURIComponent(providerRef)}`, { method: 'GET' }, ctx);
      if (String(r.id ?? '') !== providerRef)
        throw new HttpError(409, 'Order consultada não corresponde à referência; conciliação necessária.');
      const bruto = projecaoOrdem(r);
      const status = String(bruto.status || '');
      return {
        provider_ref: providerRef,
        status: status === 'approved' ? 'paga' : status === 'cancelled' || status === 'rejected' ? 'falhou' : 'pendente',
        qr_code: bruto.payment_method_qr_code_base64 as string | null,
        copia_cola: bruto.payment_method_qr_code as string | null,
        ticket_url: bruto.payment_method_ticket_url as string | null,
        bruto,
      };
    }
    const p = await mpFetch(`/v1/payments/${encodeURIComponent(providerRef)}`, { method: 'GET' }, ctx);
    return { provider_ref: String(p.id || providerRef), status: mpMapeiaStatus(String(p.status || '')), bruto: p };
  },
  async cancelaCobranca(ctx: GatewayContext, providerRef: string): Promise<{ status: string }> {
    if (ehOrdemMercadoPago(providerRef)) {
      const result = await mpFetch(
        `/v1/orders/${encodeURIComponent(providerRef)}/cancel`,
        { method: 'POST', headers: { 'X-Idempotency-Key': ctx.operationKey || `cancel:${providerRef}` }, body: JSON.stringify({}) },
        ctx
      );
      if (String(result.id || '') !== providerRef || String(result.status || '') !== 'cancelled')
        throw new HttpError(409, 'Cancelamento da Order sem confirmação verificável do provider.');
      return { status: 'cancelada' };
    }
    const result = await mpFetch(
      `/v1/payments/${encodeURIComponent(providerRef)}`,
      {
        method: 'PUT',
        headers: { 'X-Idempotency-Key': ctx.operationKey || `cancel:${providerRef}` },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      ctx
    );
    if (String(result.id || '') !== providerRef || result.status !== 'cancelled')
      throw new HttpError(409, 'Cancelamento sem confirmação verificável do provider.');
    return { status: 'cancelada' };
  },
  async estornaCobranca(ctx: GatewayContext, providerRef: string, valor?: number): Promise<{ status: string; bruto: Record<string, unknown> }> {
    const body = valor && valor > 0 ? { amount: round2(valor) } : {};
    const bruto = await mpFetch(
      `/v1/payments/${encodeURIComponent(providerRef)}/refunds`,
      {
        method: 'POST',
        headers: { 'X-Idempotency-Key': ctx.operationKey || `refund:${providerRef}:${valor ?? 'full'}` },
        body: JSON.stringify(body),
      },
      ctx
    );
    return { status: String(bruto.status || ''), bruto };
  },
  parseWebhook(corpo: string): WebhookParse | null {
    try {
      const body = JSON.parse(corpo) as Record<string, unknown>;
      const tipo = String(body.type || body.topic || '');
      const data = (body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {}) as Record<string, unknown>;
      const ref = String(data.id || body.id || '');
      // Orders API notifica com type="order" (data.id = id da Order). O tópico
      // legado "payment" continua aceito para cobranças históricas.
      if (!ref || !/^(payment|order)/i.test(tipo)) return null;
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
    // Manifesto oficial: `id:<data.id>;request-id:...;ts:...;`. O id da Order
    // (ORD01...) é case-sensitive — validamos a caixa original e, por
    // compatibilidade com notificações legadas, também a versão minúscula.
    const manifestos = [
      `id:${id};request-id:${reqId};ts:${ts};`,
      `id:${id.toLowerCase()};request-id:${reqId};ts:${ts};`,
    ];
    return manifestos.some((m) => compararConstante(v1.toLowerCase(), hmacHex(segredo, m)));
  },
  async resolveWebhook(ctx: GatewayContext, parsed: WebhookParse): Promise<IntencaoWebhook> {
    // O Mercado Pago manda só a referência: o estado real vem da consulta.
    const atual = await this.consultaCobranca(ctx, parsed.provider_ref!);
    if (!atual) return null;
    return intencaoMercadoPago(atual);
  },
};

/** Consulta autenticada ao refund individual; não deduz identidade pelo total. */
export async function consultarEstornoMercadoPago(ctx: GatewayContext, paymentReference: string, refundReference: string) {
  return mpFetch(`/v1/payments/${encodeURIComponent(paymentReference)}/refunds/${encodeURIComponent(refundReference)}`, { method: 'GET' }, ctx);
}
