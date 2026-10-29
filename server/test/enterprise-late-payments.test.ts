import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { cifrarSegredo } = await import('../src/segredos');
const { R_GATEWAY_CONFIGS, R_GATEWAY_COBRANCAS } = await import('../src/gateway');
const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');
const { providerRegistry } = await import('../../modules/payments/providers/registry');
const { paymentsRouter } = await import('../../modules/payments/api/routes');
const { R_LATE_REVIEWS, R_OPERATIONS, R_REFUNDS } = await import('../../modules/payments/infrastructure/resources');
const { converterPedidoSale } = await import('../src/commerce/pedidos');
const { converterOrdemMarketplaceEmVenda } = await import('../src/marketplaceOperacional');

let sequence = 0;
async function fixture(t: any) {
  const s = getStore(); const ref = `late-pay-${++sequence}`;
  if (!(await s.findOneWhere(R_GATEWAY_CONFIGS, { empresa_id: 1, provider: 'mercadopago' }))) {
    await s.insert(R_GATEWAY_CONFIGS, { empresa_id: 1, provider: 'mercadopago', ativo: true, ambiente: 'teste',
      credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'test-only' })), webhook_segredo_cifrado: cifrarSegredo('test-only') });
  }
  let refunded = 0; let refunds = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith('/refunds')) { refunds++; refunded += JSON.parse(String(init.body)).amount; return new Response(JSON.stringify({ status: 'approved' })); }
    if (init.method === 'POST') return new Response(JSON.stringify({ id: ref, status: 'pending', transaction_amount: 100, currency_id: 'BRL' }));
    return new Response(JSON.stringify({ id: ref, status: refunded === 100 ? 'refunded' : 'approved', transaction_amount: 100,
      currency_id: 'BRL', transaction_amount_refunded: refunded }));
  });
  const sale = await s.insert(RESOURCES.sales, { id: ref, empresa_id: 1, status: 'PENDING', amount_cents: 10000,
    currency: 'BRL', channel: 'BROBOND', usuario_id: 1, external_order_id: ref });
  const order = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', sale_id: sale.id,
    pedido_externo: ref, chave_checkout: `${ref}-cart`, estado: 'AGUARDANDO_PAGAMENTO', total: 100,
    comprador: { nome: 'Teste', email: 'test@example.invalid' }, expira_em: new Date(Date.now() + 600000).toISOString() });
  const created = await paymentEngine.createForOrder(1, Number(order.id), 'PIX', `${ref}-key`);
  return { s, ref, order, sale, id: Number(created.intent.id), refunds: () => refunds };
}

test('pagamento tardio: evento obsoleto não ressuscita, consulta autenticada abre revisão e estorno integral resolve', async (t) => {
  const f = await fixture(t);
  await paymentEngine.apply(1, f.id, { reference: f.ref, status: 'EXPIRED' });
  assert.equal((await f.s.get(RESOURCES.commerce_pedidos, Number(f.order.id)))?.estado, 'EXPIRADO');
  await paymentEngine.apply(1, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL' });
  assert.equal((await paymentEngine.intent(1, f.id)).status, 'EXPIRED', 'evento isolado não modifica estado terminal');
  assert.equal((await f.s.list(R_LATE_REVIEWS, { page: 1, pageSize: 10, filter: { empresa_id: 1, order_id: f.order.id } })).total, 0);
  await paymentEngine.synchronize(1, f.id);
  const order = await f.s.get(RESOURCES.commerce_pedidos, Number(f.order.id));
  assert.equal(order?.estado, 'EXPIRADO'); assert.equal(order?.pagamento_estado, 'APPROVED'); assert.ok(order?.pago_em);
  assert.equal((await paymentEngine.intent(1, f.id)).status, 'PAID');
  assert.equal((await f.s.get(RESOURCES.sales, f.sale.id as any))?.status, 'CANCELLED');
  assert.equal((await f.s.list(RESOURCES.vendas, { page: 1, pageSize: 10, filter: { empresa_id: 1, pedido_externo_id: f.ref } })).total, 0);
  const review = await f.s.findOneWhere(R_LATE_REVIEWS, { empresa_id: 1, order_id: f.order.id });
  assert.equal(review?.status, 'OPEN'); assert.equal(Number(review?.payment_intent_id), f.id);
  await assert.rejects(() => converterPedidoSale(1, String(f.sale.id)), (e: any) => e.status === 409);
  await assert.rejects(() => converterOrdemMarketplaceEmVenda(String(f.sale.id), { empresaId: 1, consolidado: false, permitidas: [1] }), (e: any) => e.status === 409);
  await paymentEngine.mutate(1, f.id, 'refund', 'late-refund-key-01');
  await paymentEngine.mutate(1, f.id, 'refund', 'late-refund-key-01');
  assert.equal(f.refunds(), 1, 'mesma chave não gera segundo estorno');
  assert.equal((await f.s.get(R_LATE_REVIEWS, Number(review!.id)))?.status, 'REFUNDED');
  const end = await f.s.get(RESOURCES.commerce_pedidos, Number(f.order.id));
  assert.equal(end?.estado, 'EXPIRADO'); assert.equal(end?.pagamento_estado, 'REFUNDED'); assert.match(end!.erro, /estornado/);
});

test('pagamento: falha antes de falar com provider não deixa operação PROCESSING nem vaza erro', async (t) => {
  const f = await fixture(t); await paymentEngine.synchronize(1, f.id);
  t.mock.method(providerRegistry, 'get', () => { throw new Error('SENSITIVE-TOKEN-test-only'); });
  await assert.rejects(() => paymentEngine.mutate(1, f.id, 'refund', 'before-provider-fail'), (e: any) => e.status === 422 && !e.message.includes('SENSITIVE'));
  const intent = await paymentEngine.intent(1, f.id); assert.equal(intent.active_operation, null);
  const operation = await f.s.findOneWhere(R_OPERATIONS, { empresa_id: 1, payment_intent_id: f.id, idempotency_key: 'before-provider-fail' });
  assert.equal(operation?.status, 'FAILED'); assert.doesNotMatch(JSON.stringify(operation), /SENSITIVE/);
  assert.equal((await f.s.findOneWhere(R_REFUNDS, { empresa_id: 1, operation_id: operation?.id }))?.status, 'FAILED');
  assert.equal(f.refunds(), 0);
});

test('fila de revisão: RBAC, empresa e cache privado', async (t) => {
  const f = await fixture(t); await paymentEngine.apply(1, f.id, { reference: f.ref, status: 'EXPIRED' }); await paymentEngine.synchronize(1, f.id);
  const review = await f.s.findOneWhere(R_LATE_REVIEWS, { empresa_id: 1, order_id: f.order.id });
  let actor = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1, empresas: [1] };
  const app = express(); app.use((req, _res, next) => { (req as any).user = actor; next(); }); app.use('/payments', paymentsRouter);
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  const list = await request(app).get('/payments/late-reviews?status=OPEN').expect(200);
  assert.equal(list.headers['cache-control'], 'private, no-store'); assert.ok(list.body.rows.some((x: any) => Number(x.id) === Number(review?.id)));
  actor = { ...actor, perfil: 'operador' }; await request(app).get('/payments/late-reviews').expect(403);
  actor = { ...actor, perfil: 'admin', empresa_id: 2, empresas: [2] }; await request(app).get(`/payments/late-reviews/${review?.id}`).expect(404);
});

test('reembolso inferior ao solicitado permanece UNCERTAIN até atingir o acumulado; nunca repete chamada externa', async (t) => {
  const f = await fixture(t); await paymentEngine.synchronize(1, f.id);
  const provider = providerRegistry.get('MERCADO_PAGO'); let externalCalls = 0; let confirmed = 2000;
  t.mock.method(provider, 'refund', async () => { externalCalls++; return { reference: f.ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: confirmed }; });
  t.mock.method(provider, 'getPayment', async () => ({ reference: f.ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: confirmed }));
  await assert.rejects(() => paymentEngine.mutate(1, f.id, 'refund', 'insufficient-refund', 5000), (e: any) => e.status === 409);
  const op = await f.s.findOneWhere(R_OPERATIONS, { empresa_id: 1, payment_intent_id: f.id, idempotency_key: 'insufficient-refund' });
  assert.equal(op?.status, 'UNCERTAIN'); assert.equal((await paymentEngine.intent(1, f.id)).status, 'PARTIALLY_REFUNDED');
  assert.equal(Number((await paymentEngine.intent(1, f.id)).active_operation), Number(op?.id));
  assert.equal((await f.s.findOneWhere(R_REFUNDS, { empresa_id: 1, operation_id: op?.id }))?.status, 'UNCERTAIN');
  await assert.rejects(() => paymentEngine.mutate(1, f.id, 'refund', 'another-refund-key', 1000), (e: any) => e.status === 409);
  await paymentEngine.synchronize(1, f.id); assert.equal((await f.s.get(R_OPERATIONS, Number(op?.id)))?.status, 'UNCERTAIN');
  confirmed = 5000; await paymentEngine.synchronize(1, f.id);
  assert.equal((await f.s.get(R_OPERATIONS, Number(op?.id)))?.status, 'SUCCEEDED');
  assert.equal((await paymentEngine.intent(1, f.id)).active_operation, null); assert.equal(externalCalls, 1);
});

test('captura parcial é bloqueada antes de qualquer efeito externo', async (t) => {
  const f = await fixture(t);
  await paymentEngine.apply(1, f.id, { reference: f.ref, status: 'AUTHORIZED', amount: 10000, currency: 'BRL' });
  await assert.rejects(() => paymentEngine.mutate(1, f.id, 'capture', 'partial-capture-key', 5000), (e: any) => e.status === 409 && /parcial/.test(e.message));
  assert.equal((await f.s.list(R_OPERATIONS, { page: 1, pageSize: 10, filter: { empresa_id: 1, payment_intent_id: f.id } })).total, 0);
});

test('callback pago obsoleto depois de estorno consulta cobrança atual e não converte pedido', async (t) => {
  const f = await fixture(t); const intent = await paymentEngine.intent(1, f.id);
  await f.s.update(R_GATEWAY_COBRANCAS, Number(intent.cobranca_id), { status: 'estornada' });
  await f.s.update((await import('../../modules/payments/infrastructure/resources')).R_INTENTS, f.id, { status: 'REFUNDED' });
  const { confirmarPagamentoCobranca } = await import('../src/commerce/pedidos');
  await confirmarPagamentoCobranca({ empresaId: 1, cobrancaId: Number(intent.cobranca_id), intencao: 'paga' });
  assert.equal((await f.s.get(RESOURCES.commerce_pedidos, Number(f.order.id)))?.estado, 'ESTORNADO');
  assert.equal((await f.s.get(RESOURCES.sales, f.sale.id as any))?.status, 'REFUNDED');
  assert.equal((await f.s.list(RESOURCES.vendas, { page: 1, pageSize: 10, filter: { empresa_id: 1, pedido_externo_id: f.ref } })).total, 0);
});

test('projeção da conversão não substitui cancelamento/estorno concorrente, nem no caminho de erro 409', async (t) => {
  for (const target of ['CONVERTIDO', 'AGUARDANDO_CORRECAO'] as const) {
    const f = await fixture(t);
    await f.s.update(RESOURCES.commerce_pedidos, Number(f.order.id), { estado: 'PAGO' });
    if (target === 'CONVERTIDO') await f.s.update(RESOURCES.sales, f.sale.id as any, { operational_venda_id: 123 });
    const original = f.s.tryUpdateIf.bind(f.s); let interleaved = false;
    f.s.tryUpdateIf = async (resource, id, expected, data, tx) => {
      if (resource.key === 'commerce_pedidos' && Number(id) === Number(f.order.id) && data.estado === target) {
        interleaved = true; await f.s.update(RESOURCES.commerce_pedidos, Number(f.order.id), { estado: target === 'CONVERTIDO' ? 'CANCELADO' : 'ESTORNADO' });
      }
      return original(resource, id, expected, data, tx);
    };
    try {
      await assert.rejects(() => converterPedidoSale(1, String(f.sale.id)), (e: any) => e.status === 409);
      assert.equal(interleaved, true);
      assert.equal((await f.s.get(RESOURCES.commerce_pedidos, Number(f.order.id)))?.estado, target === 'CONVERTIDO' ? 'CANCELADO' : 'ESTORNADO');
    } finally { f.s.tryUpdateIf = original; }
  }
});

test('financeiro não baixa título quando refund ultrapassa entrega de callback pago', async (t) => {
  const f = await fixture(t); await paymentEngine.synchronize(1, f.id);
  const intent = await paymentEngine.intent(1, f.id);
  const venda = await f.s.insert(RESOURCES.vendas, { empresa_id: 1, status: 'faturada', total: 100 });
  const title = await f.s.insert(RESOURCES.lancamentos_financeiros, { empresa_id: 1, descricao: 'Título de teste', tipo: 'receita', status: 'pendente', valor: 100,
    referencia_tipo: 'venda', referencia_id: venda.id, data: new Date().toISOString().slice(0, 10) });
  await f.s.update(RESOURCES.commerce_pedidos, Number(f.order.id), { estado: 'PAGO', venda_id: venda.id });
  let raced = false; const original = f.s.findOneWhere.bind(f.s);
  f.s.findOneWhere = async (resource, where, tx) => {
    if (!raced && resource.key === 'commerce_pedidos' && Number(where.id) === Number(f.order.id)) {
      raced = true;
      await f.s.update((await import('../../modules/payments/infrastructure/resources')).R_INTENTS, f.id, { status: 'REFUNDED' });
      await f.s.update(R_GATEWAY_COBRANCAS, Number(intent.cobranca_id), { status: 'estornada' });
      await f.s.update(RESOURCES.commerce_pedidos, Number(f.order.id), { estado: 'ESTORNADO' });
    }
    return original(resource, where, tx);
  };
  try { await paymentEngine.deliverToCommerce(1, f.id); } finally { f.s.findOneWhere = original; }
  assert.equal(raced, true); assert.equal((await f.s.get(RESOURCES.lancamentos_financeiros, Number(title.id)))?.status, 'pendente');
  assert.equal((await f.s.get(R_GATEWAY_COBRANCAS, Number(intent.cobranca_id)))?.lancamento_id ?? null, null);
});

test('job periódico consulta cancelados/expirados e detecta pagamento tardio sem depender de webhook', async (t) => {
  const f = await fixture(t); await paymentEngine.apply(1, f.id, { reference: f.ref, status: 'EXPIRED' });
  await f.s.update((await import('../../modules/payments/infrastructure/resources')).R_INTENTS, f.id, { updated_at: '2000-01-01T00:00:00.000Z' });
  const { runPaymentJobs } = await import('../../modules/payments/application/jobs'); await runPaymentJobs();
  assert.equal((await f.s.findOneWhere(R_LATE_REVIEWS, { empresa_id: 1, order_id: Number(f.order.id) }))?.status, 'OPEN');
  assert.equal((await f.s.get(RESOURCES.commerce_pedidos, Number(f.order.id)))?.estado, 'EXPIRADO');
});

test('job reconcilia operação incerta mesmo quando a intenção já está REFUNDED', async (t) => {
  const f = await fixture(t); await paymentEngine.synchronize(1, f.id);
  await paymentEngine.apply(1, f.id, { reference: f.ref, status: 'REFUNDED', amount: 10000, currency: 'BRL', refunded: 10000 });
  const op = await f.s.insert(R_OPERATIONS, { empresa_id: 1, payment_intent_id: f.id, operation: 'refund', idempotency_key: 'crash-after-apply',
    request_hash: 'fixture', amount: 10000, status: 'UNCERTAIN', result: { baseline_refunded: 0 }, created_at: '2000-01-01T00:00:00.000Z' });
  await f.s.insert(R_REFUNDS, { empresa_id: 1, payment_intent_id: f.id, operation_id: op.id, amount: 10000, status: 'UNCERTAIN' });
  await f.s.update((await import('../../modules/payments/infrastructure/resources')).R_INTENTS, f.id, { active_operation: op.id, updated_at: '2000-01-01T00:00:00.000Z' });
  t.mock.method(providerRegistry.get('MERCADO_PAGO'), 'getPayment', async () => ({ reference: f.ref, status: 'REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: 10000 }));
  const { runPaymentJobs } = await import('../../modules/payments/application/jobs'); await runPaymentJobs();
  assert.equal((await f.s.get(R_OPERATIONS, Number(op.id)))?.status, 'SUCCEEDED');
  assert.equal((await paymentEngine.intent(1, f.id)).active_operation, null);
});
