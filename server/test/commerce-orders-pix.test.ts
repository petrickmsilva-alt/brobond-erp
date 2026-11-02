// ============================================================================
// STOREFRONT ENTERPRISE — PIX real via Mercado Pago ORDERS API.
//
// Estes testes NÃO fazem pagamento real e NÃO tocam a rede: o fetch é mockado
// com respostas no formato documentado do provedor. O que se prova aqui:
//   • POST /v1/orders com X-Idempotency-Key e Access Token SOMENTE no backend;
//   • QR (base64), Copia e Cola (EMV), ticket_url e Order id vêm do PAYLOAD;
//   • nenhum QR é fabricado quando o provedor não devolve;
//   • "action_required" NUNCA é projetado como pago;
//   • GET /v1/orders/{id} é a autoridade do webhook (processed/accredited);
//   • valor/moeda/referência divergentes falham fechado (409, sem baixa);
//   • webhook type="order" com assinatura x-signature é aceito.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mercadopagoProvider } from '../src/gateway';

const ctx = {
  empresaId: 1,
  config: null,
  credenciais: { access_token: 'APP_USR-fixture-sem-rede' },
  webhookSegredo: 'segredo-teste',
} as any;

type Chamada = { url: string; init: RequestInit };
function mockFetch(t: any, resposta: (c: Chamada) => unknown) {
  const chamadas: Chamada[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const c = { url: String(url), init };
    chamadas.push(c);
    return new globalThis.Response(JSON.stringify(resposta(c)), { status: 200 });
  });
  return chamadas;
}

function ordemPix(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ORD01HRYFWNYRE1MR1E60MW3X0T2P',
    type: 'online',
    total_amount: '109.90',
    total_paid_amount: '0.00',
    currency: 'BRL',
    country_code: 'BRA',
    status: 'action_required',
    status_detail: 'waiting_transfer',
    external_reference: 'checkout:pedido-1',
    transactions: {
      payments: [{
        id: 'PAY01HRYFXQ53Q3JPEC48MYWMR0TE',
        amount: '109.90',
        status: 'action_required',
        status_detail: 'waiting_transfer',
        payment_method: {
          id: 'pix',
          type: 'bank_transfer',
          ticket_url: 'https://www.mercadopago.com.br/payments/123/ticket?caller_id=1&hash=abc',
          qr_code: '00020126580014br.gov.bcb.pix0136b76aa9c2-2ec4-4110-954e-ebfe34f05b61520400005303986540510.005802BR5912TESTPVBWOSBE6009SaoPaulo6304C3C0',
          qr_code_base64: 'iVBORw0KGgoAAAANSUhEUgAABWQAAAVkAQAAAAB79i',
        },
      }],
    },
    ...overrides,
  };
}

describe('PIX via Mercado Pago Orders API — contrato real, sem simulação', () => {
  test('POST /v1/orders: token no backend, idempotência, CPF, total do servidor e QR REAL', async (t) => {
    const chamadas = mockFetch(t, () => ordemPix());
    const r = await mercadopagoProvider.criaCobranca(ctx, {
      valor: 109.9,
      metodo: 'pix',
      referencia: 'checkout:pedido-1',
      payer_email: 'comprador@example.invalid',
      payer_documento: '529.982.247-25',
      payer_nome: 'Maria Silva',
      expira_em: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, 'https://api.mercadopago.com/v1/orders');
    const headers = chamadas[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Idempotency-Key'], 'checkout:pedido-1');
    assert.equal(headers.authorization, 'Bearer APP_USR-fixture-sem-rede');
    const body = JSON.parse(String(chamadas[0].init.body));
    assert.equal(body.type, 'online');
    assert.equal(body.total_amount, '109.90');
    assert.equal(body.external_reference, 'checkout:pedido-1');
    assert.equal(body.transactions.payments[0].payment_method.id, 'pix');
    assert.equal(body.transactions.payments[0].payment_method.type, 'bank_transfer');
    assert.deepEqual(body.payer.identification, { type: 'CPF', number: '52998224725' });
    assert.equal(body.payer.first_name, 'Maria');
    assert.equal(body.payer.last_name, 'Silva');
    assert.match(String(body.transactions.payments[0].expiration_time), /^PT\d+M$/);
    // Nada de preço/empresa/status vindo do browser: só campos do servidor.
    assert.equal(r.provider_ref, 'ORD01HRYFWNYRE1MR1E60MW3X0T2P');
    assert.equal(r.status, 'pendente', 'action_required não é pagamento aprovado');
    assert.equal(r.qr_code, 'iVBORw0KGgoAAAANSUhEUgAABWQAAAVkAQAAAAB79i');
    assert.match(String(r.copia_cola), /^000201/);
    assert.match(String(r.ticket_url), /^https:\/\/www\.mercadopago\.com\.br\//);
  });

  test('provedor sem QR/ticket → campos nulos, NENHUM QR fabricado', async (t) => {
    mockFetch(t, () => ({ id: 'ORD-SEM-QR', type: 'online', total_amount: '50.00', currency: 'BRL', status: 'action_required', status_detail: 'waiting_transfer', transactions: { payments: [{ payment_method: { id: 'pix' } }] } }));
    const r = await mercadopagoProvider.criaCobranca(ctx, { valor: 50, metodo: 'pix', payer_email: 'a@example.invalid', referencia: 'k-2' });
    assert.equal(r.qr_code, null);
    assert.equal(r.copia_cola, null);
    assert.equal(r.ticket_url, null);
    assert.equal(r.status, 'pendente');
  });

  test('total ecoado divergente ou Order id ausente → 409/502, sem baixa', async (t) => {
    mockFetch(t, () => ordemPix({ total_amount: '999.00' }));
    await assert.rejects(
      () => mercadopagoProvider.criaCobranca(ctx, { valor: 109.9, metodo: 'pix', payer_email: 'a@example.invalid', referencia: 'k-3' }),
      (e: any) => e.status === 409
    );
    t.mock.restoreAll();
    mockFetch(t, () => ({ status: 'action_required' }));
    await assert.rejects(
      () => mercadopagoProvider.criaCobranca(ctx, { valor: 10, metodo: 'pix', payer_email: 'a@example.invalid', referencia: 'k-4' }),
      (e: any) => e.status === 502
    );
  });

  test('GET /v1/orders/{id}: processed/accredited é a ÚNICA fonte de "paga"', async (t) => {
    const aprovada = ordemPix({ status: 'processed', status_detail: 'accredited', total_paid_amount: '109.90' });
    const chamadas = mockFetch(t, () => aprovada);
    const r = await mercadopagoProvider.consultaCobranca(ctx, 'ORD01HRYFWNYRE1MR1E60MW3X0T2P');
    assert.equal(chamadas[0].url, 'https://api.mercadopago.com/v1/orders/ORD01HRYFWNYRE1MR1E60MW3X0T2P');
    assert.equal(chamadas[0].init.method, 'GET');
    assert.equal(r?.status, 'paga');
    assert.equal((r?.bruto as any)?.status, 'approved');
    assert.equal((r?.bruto as any)?.currency_id, 'BRL');
    assert.equal((r?.bruto as any)?.transaction_amount, 109.9);
    assert.equal((r?.bruto as any)?.transaction_amount_refunded, 0);
  });

  test('referência divergente na consulta da Order → 409 (nunca confirma outra Order)', async (t) => {
    mockFetch(t, () => ordemPix());
    await assert.rejects(
      () => mercadopagoProvider.consultaCobranca(ctx, 'ORD-OUTRA'),
      (e: any) => e.status === 409
    );
  });

  test('webhook type="order" + x-signature com id em caixa alta é válido', () => {
    const id = 'ORD01HRYFWNYRE1MR1E60MW3X0T2P';
    const corpo = JSON.stringify({ id: 'notificacao-orders-1', type: 'order', action: 'order.processed', data: { id }, date_created: '2026-11-02T12:00:00Z' });
    const parsed = mercadopagoProvider.parseWebhook(corpo);
    assert.equal(parsed?.provider_ref, id);
    assert.equal(parsed?.evento, 'order');
    const ts = '1793293200';
    const reqId = 'Request-ID-Orders';
    const sig = createHmac('sha256', 'segredo-teste').update(`id:${id};request-id:${reqId};ts:${ts};`).digest('hex');
    assert.equal(mercadopagoProvider.verificaAssinatura(ctx, corpo, { 'x-request-id': reqId, 'x-signature': `ts=${ts},v1=${sig}` }), true);
    assert.equal(mercadopagoProvider.verificaAssinatura(ctx, corpo, { 'x-request-id': reqId, 'x-signature': `ts=${ts},v1=${'0'.repeat(64)}` }), false);
  });

  test('x-signature usa data.id da QUERY (manifesto oficial) e recusa divergência com o corpo', () => {
    const id = 'ORD01HRYFWNYRE1MR1E60MW3X0T2P';
    const corpo = JSON.stringify({ id: 'notificacao-orders-2', type: 'order', action: 'order.processed', data: { id }, date_created: '2026-11-02T12:00:00Z' });
    const ts = '1793293200';
    const reqId = 'Request-ID-Orders-2';
    const headers = { 'x-request-id': reqId, 'x-signature': '' };
    const assinar = (manifestId: string) => createHmac('sha256', 'segredo-teste').update(`id:${manifestId};request-id:${reqId};ts:${ts};`).digest('hex');
    // O provedor assina o id minúsculo da query ?data.id=<id>.
    const query = { 'data.id': id.toLowerCase() };
    headers['x-signature'] = `ts=${ts},v1=${assinar(id.toLowerCase())}`;
    assert.equal(mercadopagoProvider.verificaAssinatura(ctx, corpo, headers, query), true);
    // Assinatura calculada com o id do corpo (caixa alta) não basta quando a
    // query traz outro id: o manifesto oficial é o da URL.
    headers['x-signature'] = `ts=${ts},v1=${assinar(id)}`;
    assert.equal(mercadopagoProvider.verificaAssinatura(ctx, corpo, headers, query), false);
    // Query com id de OUTRA order não pode ser trocada pelo corpo assinado.
    const corpoOutro = JSON.stringify({ type: 'order', data: { id: 'ORD-OUTRA' } });
    headers['x-signature'] = `ts=${ts},v1=${assinar(id.toLowerCase())}`;
    assert.equal(mercadopagoProvider.verificaAssinatura(ctx, corpoOutro, headers, query), false);
  });

  test('Payment Engine expõe ticketUrl real na action (sem token no frontend)', async (t) => {
    const { MercadoPagoProvider } = await import('../../modules/payments/providers/mercado-pago');
    mockFetch(t, () => ordemPix());
    const provider = new MercadoPagoProvider();
    const pctx: any = {
      empresaId: 1, operationKey: 'checkout:pedido-1', environment: 'teste',
      credentials: { access_token: 'APP_USR-fixture', enabled_methods: 'PIX' }, webhookSecret: 'segredo-teste',
    };
    const result = await provider.createPaymentIntent(pctx, {
      amount: 10990, currency: 'BRL', method: 'PIX', reference: 'checkout:pedido-1',
      email: 'a@example.invalid', customerName: 'Maria Silva', taxId: '52998224725', installments: 1,
    });
    assert.equal(result.reference, 'ORD01HRYFWNYRE1MR1E60MW3X0T2P');
    assert.equal(result.status, 'PENDING');
    assert.match(String(result.action?.ticketUrl), /^https:\/\//);
    assert.match(String(result.action?.qrCode), /^iVBOR/);
    assert.match(String(result.action?.code), /^000201/);
  });
});
