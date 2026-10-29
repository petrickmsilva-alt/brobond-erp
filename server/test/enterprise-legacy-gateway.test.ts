import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const gateway = await import('../src/gateway');
const { cifrarSegredo } = await import('../src/segredos');
const { R_LATE_REVIEWS } = await import('../../modules/payments/infrastructure/resources');
const { intencaoMercadoPago } = await import('../../modules/payments/providers/mercado-pago/legacy');
const { chamar, reqDe, garantirAdmin } = await import('./_p1util');
await garantirAdmin(); const s = getStore();
async function config(provider: string) {
  if (await s.findOneWhere(gateway.R_GATEWAY_CONFIGS, { empresa_id: 1, provider })) return;
  await s.insert(gateway.R_GATEWAY_CONFIGS, { empresa_id: 1, provider, ativo: true, ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'fixture-only' })), webhook_segredo_cifrado: null });
}
let seq = 0;
async function charge(provider: string, status: string) {
  await config(provider); const ref = `legacy-fixture-${++seq}`;
  return s.insert(gateway.R_GATEWAY_COBRANCAS, { empresa_id: 1, provider, metodo: 'pix', status, provider_ref: ref,
    valor: 100, valor_liquido: 100, taxa_pct: 0, parcelas: 1, idempotency_key: ref });
}
async function event(c: any, status: string, name: string) {
  return s.insert(gateway.R_GATEWAY_WEBHOOK_EVENTS, { empresa_id: 1, provider: c.provider, evento_id: `${name}-${c.id}`, evento: 'payment',
    payload: { type: 'payment', event: 'payment.paid', status, data: { id: c.provider_ref } }, assinatura_ok: true,
    status: 'recebido', tentativas: 0, recebido_em: new Date().toISOString() });
}

test('Mercado Pago legado distingue chargeback, estorno parcial e integral', () => {
  const result = (status: string, refunded: number) => ({ provider_ref: 'x', status: 'pendente' as const,
    bruto: { status, transaction_amount: 100, transaction_amount_refunded: refunded } });
  assert.throws(() => intencaoMercadoPago(result('charged_back', 0)), /Chargeback/);
  assert.throws(() => intencaoMercadoPago(result('approved', 10)), /parcial/);
  assert.throws(() => intencaoMercadoPago(result('refunded', 10)), /integral/);
  assert.equal(intencaoMercadoPago(result('refunded', 100)), 'estornada');
});

test('estorno legado: valor parcial, saldo já parcial e confirmação insuficiente nunca viram estorno integral', async (t) => {
  const c = await charge('mercadopago', 'paga'); let refunded = 10; let state = 'approved'; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'POST') { calls++; refunded = 40; }
    return new Response(JSON.stringify({ id: c.provider_ref, status: state, transaction_amount: 100, currency_id: 'BRL', transaction_amount_refunded: refunded }));
  });
  const requestRefund = (body: Record<string, unknown> = {}) => chamar(gateway.estornarCobranca, reqDe(body, { params: { id: c.id } }));
  await assert.rejects(() => requestRefund({ valor: 0 }), (e: any) => e.status === 400);
  await assert.rejects(() => requestRefund({ valor: 25 }), (e: any) => e.status === 409);
  await assert.rejects(() => requestRefund(), (e: any) => e.status === 409); assert.equal(calls, 0);
  refunded = 0; await assert.rejects(() => requestRefund(), (e: any) => e.status === 409); assert.equal(calls, 1);
  await assert.rejects(() => requestRefund(), (e: any) => e.status === 409); assert.equal(calls, 1, 'não envia nova operação contra reembolso parcial');
  assert.equal((await s.get(gateway.R_GATEWAY_COBRANCAS, Number(c.id)))?.status, 'paga');
  state = 'refunded'; refunded = 100; const done = await requestRefund();
  assert.equal(done.cobranca.status, 'estornada'); assert.equal(calls, 1, 'prova obtida por consulta, sem reenviar');
});

test('cancelamento legado não substitui pagamento concorrente', async (t) => {
  const c = await charge('mock', 'pendente');
  t.mock.method(gateway.mockProvider, 'cancelaCobranca', async () => {
    await s.update(gateway.R_GATEWAY_COBRANCAS, Number(c.id), { status: 'paga' }); return { status: 'cancelada' };
  });
  await assert.rejects(() => chamar(gateway.cancelarCobranca, reqDe({}, { params: { id: c.id } })), (e: any) => e.status === 409);
  assert.equal((await s.get(gateway.R_GATEWAY_COBRANCAS, Number(c.id)))?.status, 'paga');
});

test('webhook legado rejeita valor remoto divergente e sanitiza erros arbitrários', async (t) => {
  const c = await charge('mercadopago', 'pendente'); const e = await event(c, 'pago', 'divergent');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: c.provider_ref, status: 'approved', currency_id: 'BRL', transaction_amount: 99, transaction_amount_refunded: 0 })));
  await assert.rejects(() => gateway.processarEvento(e), (err: any) => err.status === 409 && !err.message.includes('99'));
  assert.equal((await s.get(gateway.R_GATEWAY_COBRANCAS, Number(c.id)))?.status, 'pendente');
  assert.equal((await s.get(gateway.R_GATEWAY_WEBHOOK_EVENTS, Number(e.id)))?.status, 'erro');
  const m = await charge('mock', 'pendente'); const bad = await event(m, 'pago', 'secret');
  t.mock.method(gateway.mockProvider, 'resolveWebhook', async () => { throw new Error('SENSITIVE-TOKEN-fixture'); });
  await assert.rejects(() => gateway.processarEvento(bad), (err: any) => err.status === 502 && !err.message.includes('SENSITIVE'));
  assert.doesNotMatch(JSON.stringify(await s.get(gateway.R_GATEWAY_WEBHOOK_EVENTS, Number(bad.id))), /SENSITIVE/);
});

test('pagamento legado tardio abre revisão sem reabrir pedido; estorno legado não resolve revisão automaticamente', async () => {
  const c = await charge('mock', 'expirada'); const ref = `legacy-order-${c.id}`;
  await s.insert(RESOURCES.sales, { id: ref, empresa_id: 1, status: 'CANCELLED', amount_cents: 10000, currency: 'BRL', channel: 'BROBOND', usuario_id: 1, external_order_id: ref });
  const order = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', sale_id: ref, pedido_externo: ref,
    chave_checkout: ref, estado: 'EXPIRADO', cobranca_id: c.id, total: 100 });
  const e = await event(c, 'pago', 'late');
  assert.equal((await gateway.processarEvento(e)).resultado, 'paga');
  const review = await s.findOneWhere(R_LATE_REVIEWS, { empresa_id: 1, order_id: Number(order.id) });
  assert.equal(review?.status, 'OPEN'); assert.equal((await s.get(RESOURCES.commerce_pedidos, Number(order.id)))?.estado, 'EXPIRADO');
  await chamar(gateway.estornarCobranca, reqDe({}, { params: { id: c.id } }));
  const { confirmarPagamentoCobranca } = await import('../src/commerce/pedidos');
  await confirmarPagamentoCobranca({ empresaId: 1, cobrancaId: Number(c.id), intencao: 'estornada' });
  assert.equal((await s.get(R_LATE_REVIEWS, Number(review?.id)))?.status, 'OPEN');
  assert.match(String((await s.get(RESOURCES.commerce_pedidos, Number(order.id)))?.erro), /conciliação manual/);
});

test('revisão legada fecha somente após consulta comprovar estorno integral de referência, moeda e valor', async (t) => {
  const c = await charge('mercadopago', 'paga'); const ref = `legacy-proof-${c.id}`;
  await s.insert(RESOURCES.sales, { id: ref, empresa_id: 1, status: 'CANCELLED', amount_cents: 10000, currency: 'BRL', channel: 'BROBOND', usuario_id: 1, external_order_id: ref });
  const order = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', sale_id: ref, pedido_externo: ref,
    chave_checkout: ref, estado: 'EXPIRADO', cobranca_id: c.id, total: 100, pagamento_estado: 'APPROVED' });
  const review = await s.insert(R_LATE_REVIEWS, { empresa_id: 1, order_id: order.id, cobranca_id: c.id, status: 'OPEN', created_at: new Date().toISOString() });
  let refunded = 50;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: c.provider_ref, status: 'refunded', transaction_amount: 100, currency_id: 'BRL', transaction_amount_refunded: refunded })));
  const refund = () => chamar(gateway.estornarCobranca, reqDe({}, { params: { id: c.id } }));
  await assert.rejects(refund, (e: any) => e.status === 409);
  assert.equal((await s.get(R_LATE_REVIEWS, Number(review.id)))?.status, 'OPEN');
  refunded = 100; await refund();
  assert.equal((await s.get(R_LATE_REVIEWS, Number(review.id)))?.status, 'REFUNDED');
  const { confirmarPagamentoCobranca } = await import('../src/commerce/pedidos');
  await confirmarPagamentoCobranca({ empresaId: 1, cobrancaId: Number(c.id), intencao: 'paga' });
  const end = await s.get(RESOURCES.commerce_pedidos, Number(order.id));
  assert.equal(end?.estado, 'EXPIRADO'); assert.equal(end?.pagamento_estado, 'REFUNDED'); assert.match(end!.erro, /estornado/);
});
