import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { copiaColaPixValido, qrCodeBase64Valido, ticketUrlPixValida } from '../../domain/pix-instrument';
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

/**
 * Duração ISO-8601 derivada do prazo REAL de expiração do pedido.
 * A Orders API exige `transactions.payments[].expiration_time` entre 30 min e
 * 30 dias (default do PSP: 24 h). Um prazo de checkout menor que 30 min seria
 * RECUSADO pelo Mercado Pago (HTTP 400) e derrubaria o checkout inteiro; o
 * mínimo é aplicado e o pagamento tardio continua tratado pela revisão de
 * pagamento tardio do Payment Engine (nunca vira venda sem estoque reservado).
 */
function duracaoOrders(expiraEm?: string | null): string | undefined {
  if (!expiraEm) return undefined;
  const restante = new Date(expiraEm).getTime() - Date.now();
  if (!Number.isFinite(restante) || restante <= 0) return undefined;
  const minutos = Math.min(30 * 1440, Math.max(30, Math.ceil(restante / 60_000)));
  return minutos < 1440 ? `PT${minutos}M` : `P${Math.ceil(minutos / 1440)}D`;
}

/** Referência externa aceita pela Orders API: [A-Za-z0-9_-], até 64 caracteres. */
function referenciaExternaOrders(ref: string): string {
  return ref.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

function documentoPagador(v?: string | null): { type: 'CPF' | 'CNPJ'; number: string } | null {
  const digitos = String(v ?? '').replace(/\D/g, '');
  if (digitos.length === 11) return { type: 'CPF', number: digitos };
  if (digitos.length === 14) return { type: 'CNPJ', number: digitos };
  return null;
}

/**
 * Status canônico de uma Order (tabela oficial "Order status"):
 *   processed/accredited → approved · processed/partially_refunded → approved
 *   (o valor estornado vem dos refunds) · refunded → refunded
 *   canceled|failed + status_detail=expired → expired · canceled → cancelled
 *   failed → rejected · charged_back → charged_back · processing → in_process
 *   created/action_required (waiting_transfer/waiting_payment) → pending.
 * A API usa `canceled` (um L); `cancelled` segue aceito por compatibilidade.
 */
export function statusCanonicoDaOrdem(statusBruto: unknown, detalheBruto: unknown): string {
  const status = String(statusBruto || '').toLowerCase();
  const detalhe = String(detalheBruto || '').toLowerCase();
  if (status === 'processed' && detalhe === 'accredited') return 'approved';
  if (status === 'processed' && detalhe === 'partially_refunded') return 'approved';
  if (status === 'refunded' || (status === 'processed' && detalhe === 'refunded')) return 'refunded';
  if (status === 'charged_back') return 'charged_back';
  if (detalhe === 'expired' && ['canceled', 'cancelled', 'failed', 'expired'].includes(status)) return 'expired';
  if (['canceled', 'cancelled', 'expired'].includes(status)) return 'cancelled';
  if (status === 'failed') return 'rejected';
  if (status === 'processing') return 'in_process';
  return 'pending';
}

/** Soma dos refunds PROCESSADOS da Order; null quando não comprovável. */
function totalEstornadoDaOrdem(r: Record<string, unknown>): number | null {
  const transacoes = (r.transactions && typeof r.transactions === 'object' ? r.transactions : {}) as Record<string, unknown>;
  if (!Array.isArray(transacoes.refunds)) return null;
  let centavos = 0;
  for (const bruto of transacoes.refunds as Record<string, unknown>[]) {
    const st = String(bruto?.status || '').toLowerCase();
    if (st && st !== 'processed') return null; // estorno em andamento/falho: sem prova de valor
    const v = valorMercadoPagoEmCentavos(bruto?.amount);
    if (v === null) return null;
    centavos += v;
  }
  return centavos / 100;
}

/**
 * Projeção do contrato Orders para o formato canônico já usado pelo domínio
 * (status/transaction_amount/currency_id/...). É ADAPTAÇÃO de campos reais,
 * não invenção: valores ausentes/ambíguos ficam undefined e as guardas
 * existentes (409 de conciliação) continuam impedindo baixa sem prova.
 *
 * CORREÇÃO (causa raiz do "pago que nunca confirma"): antes, toda Order NÃO
 * aprovada era projetada com `transaction_amount_refunded = total -
 * total_paid_amount`. Uma Order PIX pendente (`total_paid_amount: "0.00"`)
 * virava "estornada integralmente": a primeira consulta (webhook de criação
 * ou o job de 60 s) gravava refunded=total na tentativa e, quando o PIX era
 * pago, a aprovação (refunded=0) era rejeitada com 409 "Reembolso divergente".
 * Estorno agora só é afirmado com prova: status `refunded` (integral) ou a
 * soma dos refunds processados (parcial). `total_paid_amount` NÃO é estorno
 * (inclui descontos/gorjetas e é 0 enquanto o PIX não foi pago).
 */
function projecaoOrdem(r: Record<string, unknown>): Record<string, unknown> {
  const detalhe = String(r.status_detail || '');
  const pagamento = pagamentosDaOrdem(r)[0] || {};
  const pm = metodoDoPrimeiroPagamento(r);
  const total = Number(r.total_amount);
  const totalValido = Number.isFinite(total) && total > 0 ? total : null;
  const statusCanonico = statusCanonicoDaOrdem(r.status, detalhe);

  let devolvido: number | null = null;
  if (statusCanonico === 'refunded') devolvido = totalValido;
  else if (statusCanonico === 'approved') devolvido = detalhe.toLowerCase() === 'partially_refunded' ? totalEstornadoDaOrdem(r) : 0;

  return {
    ...r,
    id: r.id,
    ordem_api: 'orders',
    status: statusCanonico,
    status_detail: detalhe,
    transaction_amount: totalValido ?? undefined,
    transaction_amount_refunded: devolvido ?? undefined,
    currency_id: apenasTexto(r.currency) ?? apenasTexto(r.currency_id) ?? undefined,
    payment_reference: apenasTexto(pagamento.id) ?? (typeof pagamento.id === 'number' ? String(pagamento.id) : undefined),
    payment_status: apenasTexto(pagamento.status) ?? undefined,
    payment_method_qr_code: copiaColaPixValido(pm.qr_code) ? String(pm.qr_code).trim() : null,
    payment_method_qr_code_base64: qrCodeBase64Valido(pm.qr_code_base64) ? String(pm.qr_code_base64).replace(/\s/g, '') : null,
    payment_method_ticket_url: ticketUrlPixValida(pm.ticket_url) ? String(pm.ticket_url).trim() : null,
    payment_date_of_expiration: apenasTexto(pagamento.date_of_expiration) ?? null,
  };
}

/** Estado do contrato legado (gateway_cobrancas.status) a partir da projeção. */
function statusLegadoDaProjecao(bruto: Record<string, unknown>): CobrancaProviderResult['status'] {
  const st = String(bruto.status || '');
  if (st === 'approved' && Number(bruto.transaction_amount_refunded ?? 0) === 0) return 'paga';
  if (['cancelled', 'expired', 'rejected'].includes(st)) return 'falhou';
  return 'pendente';
}

function mpExtraiInstrumento(p: Record<string, unknown>, metodo: MetodoCobranca): Partial<CobrancaProviderResult> {
  if (metodo === 'pix') {
    const poi = (p.point_of_interaction || {}) as Record<string, unknown>;
    const td = (poi.transaction_data || {}) as Record<string, unknown>;
    // /v1/payments (legado): `qr_code` = EMV (Copia e Cola), `qr_code_base64` = imagem.
    const emv = copiaColaPixValido(td.qr_code) ? String(td.qr_code).trim() : null;
    return {
      qr_code: emv,
      copia_cola: emv,
      qr_code_base64: qrCodeBase64Valido(td.qr_code_base64) ? String(td.qr_code_base64).replace(/\s/g, '') : null,
      ticket_url: ticketUrlPixValida(td.ticket_url) ? String(td.ticket_url).trim() : null,
    };
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
  if (st === 'expired') return 'expirada';
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
      // X-Idempotency-Key DETERMINÍSTICA: a mesma operação (retry de rede,
      // replay do engine) recupera a MESMA Order — nunca cria segunda cobrança.
      if (!input.referencia || !String(input.referencia).trim())
        throw new HttpError(400, 'Cobrança PIX exige referência de idempotência determinística.');
      const ordem: Record<string, unknown> = {
        type: 'online',
        processing_mode: 'automatic',
        total_amount: total,
        description: input.descricao || 'Pedido BROBOND',
        external_reference: referenciaExternaOrders(String(input.referencia)),
        payer,
        transactions: { payments: [pagamento] },
      };
      const r = await mpFetch(
        '/v1/orders',
        { method: 'POST', headers: { 'X-Idempotency-Key': String(input.referencia) }, body: JSON.stringify(ordem) },
        ctx
      );
      if (!r.id) throw new HttpError(502, 'Mercado Pago Orders API não retornou o identificador da Order.');
      // O valor ecoado pelo provedor precisa bater com o total autorizado no
      // servidor. Quando o campo vem ausente, NÃO se inventa confirmação.
      if (r.total_amount != null && Number.isFinite(Number(r.total_amount)) && Math.abs(Number(r.total_amount) - Number(total)) > 0.001)
        throw new HttpError(409, 'Total retornado pela Orders API diverge do pedido; conciliação necessária.');
      const bruto = projecaoOrdem(r);
      return {
        provider_ref: String(r.id),
        status: statusLegadoDaProjecao(bruto),
        expires_em: (bruto.payment_date_of_expiration as string | null) ?? input.expira_em ?? null,
        // Contrato canônico (um campo, um significado):
        //   payment_method.qr_code        → qr_code (BR Code) e copia_cola
        //   payment_method.qr_code_base64 → qr_code_base64 (imagem)
        //   payment_method.ticket_url     → ticket_url
        qr_code: bruto.payment_method_qr_code as string | null,
        copia_cola: bruto.payment_method_qr_code as string | null,
        qr_code_base64: bruto.payment_method_qr_code_base64 as string | null,
        ticket_url: bruto.payment_method_ticket_url as string | null,
        bruto,
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
    if (!input.referencia || !String(input.referencia).trim())
      throw new HttpError(400, 'Cobrança exige referência de idempotência determinística.');
    const p = await mpFetch(
      '/v1/payments',
      { method: 'POST', headers: { 'X-Idempotency-Key': String(input.referencia) }, body: JSON.stringify(body) },
      ctx
    );
    if (!p.id) throw new HttpError(502, 'Mercado Pago não retornou o identificador do pagamento.');
    return {
      provider_ref: String(p.id),
      status: mpMapeiaStatus(String(p.status || 'pending')),
      expires_em: (p.date_of_expiration as string) || null,
      nsu: mpExtraiInstrumento(p, input.metodo).nsu ?? null,
      qr_code: mpExtraiInstrumento(p, input.metodo).qr_code ?? null,
      qr_code_base64: mpExtraiInstrumento(p, input.metodo).qr_code_base64 ?? null,
      ticket_url: mpExtraiInstrumento(p, input.metodo).ticket_url ?? null,
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
      return {
        provider_ref: providerRef,
        status: statusLegadoDaProjecao(bruto),
        qr_code: bruto.payment_method_qr_code as string | null,
        copia_cola: bruto.payment_method_qr_code as string | null,
        qr_code_base64: bruto.payment_method_qr_code_base64 as string | null,
        ticket_url: bruto.payment_method_ticket_url as string | null,
        expires_em: bruto.payment_date_of_expiration as string | null,
        bruto,
      };
    }
    const p = await mpFetch(`/v1/payments/${encodeURIComponent(providerRef)}`, { method: 'GET' }, ctx);
    const instrumento = String(p.payment_method_id || '') === 'pix' ? mpExtraiInstrumento(p, 'pix') : {};
    return { provider_ref: String(p.id || providerRef), status: mpMapeiaStatus(String(p.status || '')), ...instrumento, bruto: p };
  },
  async cancelaCobranca(ctx: GatewayContext, providerRef: string): Promise<{ status: string }> {
    if (ehOrdemMercadoPago(providerRef)) {
      const result = await mpFetch(
        `/v1/orders/${encodeURIComponent(providerRef)}/cancel`,
        { method: 'POST', headers: { 'X-Idempotency-Key': ctx.operationKey || `cancel:${providerRef}` }, body: JSON.stringify({}) },
        ctx
      );
      // A Orders API responde `canceled` (um L); `cancelled` aceito por compatibilidade.
      if (String(result.id || '') !== providerRef || !['canceled', 'cancelled'].includes(String(result.status || '').toLowerCase()))
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
      // Webhook `type=order` NÃO tem `id` de topo. A identidade do evento
      // combina Order (data.id) + pagamento (transactions.payments[0].id) +
      // estado notificado + ação + data: retry do MESMO aviso deduplica; um
      // aviso novo do mesmo pagamento é processado e o engine (idempotente)
      // garante 1 pagamento / 1 venda / 1 saída.
      const transacoes = (data.transactions && typeof data.transactions === 'object' ? data.transactions : {}) as Record<string, unknown>;
      const pagamento = (Array.isArray(transacoes.payments) ? transacoes.payments[0] : null) as Record<string, unknown> | null;
      const paymentRef = String(pagamento?.id ?? '');
      const estado = String(pagamento?.status ?? data.status ?? '');
      return {
        evento_id: String(
          body.id || body['x-request-id'] || body.request_id ||
            [tipo, ref, paymentRef, estado, body.action || '', body.date_created || ''].join(':')
        ).slice(0, 300),
        evento: tipo,
        provider_ref: ref,
      };
    } catch {
      return null;
    }
  },
  verificaAssinatura(
    ctx: GatewayContext,
    corpo: string,
    headers: Record<string, string | undefined>,
    query?: Record<string, unknown>
  ): boolean {
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
    // Manifesto OFICIAL do webhook `type=order`: o `id` vem do parâmetro de
    // query `data.id` (e NÃO do corpo), junto com `x-request-id` e `ts`.
    // https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/notifications
    //   id:${dataID};request-id:${xRequestId};ts:${ts};
    // Quando a query está presente (entrega HTTP real) ela é autoritativa:
    // um `data.id` diferente no corpo NÃO pode trocar o manifesto assinado.
    // O fallback pelo corpo só atende chamadas diretas/offline (testes e
    // reprocessamento interno), que não têm URL de webhook.
    const primeiro = (v: unknown): string => Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
    const idQuery = primeiro(query?.['data.id'] ?? query?.data_id ?? query?.id);
    const idManifesto = idQuery || id;
    if (!idManifesto) return false;
    if (idQuery && id && idQuery !== id && idQuery.toLowerCase() !== id.toLowerCase())
      return false; // divergência corpo/query: jamais confiar no corpo
    const reqId = String(headers['x-request-id'] || '').trim();
    // Manifesto oficial: `id:<data.id em minúsculas>;request-id:<x-request-id>;ts:<ts>;`
    // — partes ausentes são OMITIDAS. A caixa original segue aceita por
    // compatibilidade com notificações legadas (`type=payment`).
    const parte = (id: string) => [id ? `id:${id};` : '', reqId ? `request-id:${reqId};` : '', `ts:${ts};`].join('');
    const manifestos = [...new Set([parte(idManifesto.toLowerCase()), parte(idManifesto)])];
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
