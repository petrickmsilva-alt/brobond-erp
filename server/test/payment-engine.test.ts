import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const { transition, STATES, PaymentError, canFallback, minorUnits, retryDelay } = await import('../../modules/payments/domain/payment');
const { routePayment } = await import('../../modules/payments/orchestration/provider-router');
const { StripeProvider } = await import('../../modules/payments/providers/stripe');
const { PagBankProvider } = await import('../../modules/payments/providers/pagbank');
const { MercadoPagoProvider } = await import('../../modules/payments/providers/mercado-pago');
const { GenericPaymentProvider } = await import('../../modules/payments/providers/generic');
const { capability } = await import('../../modules/payments/providers/payment-provider');
const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { R_GATEWAY_CONFIGS } = await import('../src/gateway');
const { cifrarSegredo } = await import('../src/segredos');
const { R_INTENTS, R_ATTEMPTS, R_ROUTING, R_OPERATIONS, R_REFUNDS } = await import('../../modules/payments/infrastructure/resources');
const { paymentsRouter } = await import('../../modules/payments/api/routes');
const ctx = { empresaId: 1, credentials: {}, webhookSecret: null, environment: 'teste' as const, operationKey: 'test-operation-key' };
test('Payment Engine: formal lifecycle forbids paid cancellation, stale settlement and terminal resurrection', () => {
  assert.equal(transition('CREATED', 'PENDING'), 'PENDING');
  assert.equal(transition('PENDING', 'REQUIRES_ACTION'), 'REQUIRES_ACTION');
  assert.equal(transition('REQUIRES_ACTION', 'PAID'), 'PAID');
  assert.equal(transition('PAID', 'PARTIALLY_REFUNDED'), 'PARTIALLY_REFUNDED');
  assert.equal(transition('PARTIALLY_REFUNDED', 'REFUNDED'), 'REFUNDED');
  for (const terminal of ['REFUNDED', 'CANCELED', 'EXPIRED', 'FAILED'] as const)
    for (const to of STATES) if (to !== terminal) assert.throws(() => transition(terminal, to));
  assert.throws(() => transition('PAID', 'CANCELED'));
  assert.throws(() => transition('PAID', 'PENDING'));
  assert.equal(transition('PAID', 'DISPUTED'), 'DISPUTED');
});
test('Payment Engine: money and bounded jitter retry', () => {
  assert.equal(minorUnits(109.9), 10990);
  assert.throws(() => minorUnits(NaN));
  assert.throws(() => minorUnits(0));
  assert.equal(
    retryDelay(2, () => 0.5),
    4000
  );
  assert.ok(retryDelay(100, () => 0) < 3600001);
});
test('Payment Engine: fallback never repeats fraud, decline, funds or an ambiguous write', () => {
  for (const code of ['PAYMENT_DECLINED', 'FRAUD_REJECTED', 'INSUFFICIENT_FUNDS', 'INVALID_REQUEST', 'AUTHENTICATION_REQUIRED'] as const)
    assert.equal(canFallback(new PaymentError(code)), false);
  assert.equal(canFallback(new PaymentError('TIMEOUT', true)), false);
  assert.equal(canFallback(new Error('503')), false);
  assert.equal(canFallback(new PaymentError('RATE_LIMITED')), true);
  assert.equal(canFallback(new PaymentError('PROVIDER_UNAVAILABLE')), true);
});
test('Payment Engine: deterministic routing checks tenancy, limits, channel, currency, health, capability, store and time', () => {
  const provider = new MercadoPagoProvider();
  const cap = capability('PIX');
  const candidate = {
    provider,
    context: ctx,
    capability: cap,
    priority: 1,
    conditions: { channel: 'OWN_STORE', min: 100, max: 50000, startHour: 8, endHour: 18, store: 'main' },
    health: 'UP',
    ruleId: 1,
  };
  const input = {
    empresaId: 1,
    method: 'PIX' as const,
    channel: 'OWN_STORE',
    store: 'main',
    country: 'BR',
    currency: 'BRL',
    amount: 10000,
    installments: 1,
    hour: 12,
  };
  assert.equal(routePayment(input, [candidate]).length, 1);
  for (const change of [
    { empresaId: 2 },
    { amount: 99 },
    { amount: 50001 },
    { channel: 'POS' },
    { currency: 'USD' },
    { installments: 2 },
    { hour: 20 },
    { store: 'other' },
  ])
    assert.equal(routePayment({ ...input, ...change }, [candidate]).length, 0);
  assert.equal(routePayment(input, [{ ...candidate, health: 'DOWN' }]).length, 0);
  assert.deepEqual(
    routePayment(input, [{ ...candidate, priority: 5, ruleId: 5 }, candidate]).map((c) => c.ruleId),
    [1, 5]
  );
});
test('Payment Engine: adapters fail closed; no external credential means no advertised capability', async () => {
  for (const p of [new StripeProvider(), new PagBankProvider(), new MercadoPagoProvider(), new GenericPaymentProvider()]) {
    assert.deepEqual(p.capabilities(ctx), []);
    assert.equal(await p.healthCheck(ctx), 'NOT_CONFIGURED');
    assert.equal(p.supports(ctx, 'PIX'), false);
  }
  const stripe = new StripeProvider();
  assert.deepEqual(
    stripe
      .capabilities({
        ...ctx,
        credentials: { secret_key: 'fixture', enabled_methods: 'CREDIT_CARD', return_url: 'https://example.invalid/order' },
        webhookSecret: 'fixture',
      })
      .map((c) => c.method),
    ['CREDIT_CARD']
  );
});
test('Payment Engine: Stripe verifies raw body and timestamp; PagBank verifies official authenticity hash', () => {
  const stripe = new StripeProvider(),
    pagbank = new PagBankProvider();
  const raw = '{"id":"evt_1","type":"checkout.session.completed","data":{"object":{"id":"cs_1"}}}';
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = 'test-not-production';
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  assert.equal(stripe.verifyWebhook({ ...ctx, webhookSecret: secret }, raw, { 'stripe-signature': `t=${ts},v1=${sig}` }), true);
  assert.equal(stripe.verifyWebhook({ ...ctx, webhookSecret: secret }, raw + ' ', { 'stripe-signature': `t=${ts},v1=${sig}` }), false);
  assert.equal(stripe.verifyWebhook({ ...ctx, webhookSecret: secret }, raw, { 'stripe-signature': `t=1,v1=${sig}` }), false);
  assert.equal(stripe.parseWebhook(raw)?.reference, 'cs_1');
  const pctx = { ...ctx, credentials: { access_token: secret } };
  const token = createHash('sha256').update(`${secret}-${raw}`).digest('hex');
  assert.equal(pagbank.verifyWebhook(pctx, raw, { 'x-authenticity-token': token }), true);
  assert.equal(pagbank.verifyWebhook(pctx, raw, { 'x-authenticity-token': '0'.repeat(64) }), false);
});
test('Payment Engine: real adapter contract uses official Stripe endpoints; a session is not paid and refund can remain pending', async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture' }), { status: 200 });
  });
  const p = new StripeProvider();
  const c = {
    ...ctx,
    webhookSecret: 'fixture',
    credentials: { secret_key: 'sk_fixture', enabled_methods: 'CREDIT_CARD', return_url: 'https://example.invalid/order' },
  };
  const result = await p.createPaymentIntent(c, {
    amount: 12345,
    currency: 'BRL',
    method: 'CREDIT_CARD',
    reference: 'internal-ref',
    email: 'a@example.invalid',
    installments: 1,
  });
  assert.equal(result.status, 'REQUIRES_ACTION');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal((calls[0].init.headers as Record<string, string>)['Idempotency-Key'], ctx.operationKey);
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get('line_items[0][price_data][unit_amount]'), '12345');
});
test('Payment Engine: checkout intent → adapter → inbox/state → order; concurrent requests, duplicate refund, tenancy, RBAC and secret masking', async (t) => {
  const s = getStore();
  await s.insert(R_GATEWAY_CONFIGS, {
    empresa_id: 1,
    provider: 'mercadopago',
    ativo: true,
    ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'secret-no-leak' })),
    webhook_segredo_cifrado: cifrarSegredo('webhook-no-leak'),
  });
  let creates = 0,
    refunds = 0,
    refunded = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/refunds')) {
      refunds++;
      const amount = JSON.parse(String(init.body)).amount;
      refunded += amount;
      return new Response(JSON.stringify({ id: `mp-refund-${refunds}`, payment_id: 'mp_fixture', amount, status: 'approved' }));
    }
    if (init.method === 'POST') {
      creates++;
      return new Response(
        JSON.stringify({
          id: 'mp_fixture',
          status: 'pending',
          transaction_amount: 100,
          currency_id: 'BRL',
          point_of_interaction: { transaction_data: { qr_code: 'test-code' } },
        })
      );
    }
    return new Response(
      JSON.stringify({
        id: 'mp_fixture',
        status: refunded === 100 ? 'refunded' : 'approved',
        transaction_amount: 100,
        currency_id: 'BRL',
        transaction_amount_refunded: refunded,
      })
    );
  });
  const sale = await s.insert(RESOURCES.sales, {
    id: 'engine-test-sale',
    empresa_id: 1,
    status: 'PENDING',
    amount_cents: 10000,
    currency: 'BRL',
    channel: 'BROBOND',
    usuario_id: 1,
    external_order_id: 'engine-test-sale',
  });
  const order = await s.insert(RESOURCES.commerce_pedidos, {
    empresa_id: 1,
    canal: 'BROBOND',
    sale_id: sale.id,
    pedido_externo: 'engine-test',
    chave_checkout: 'engine-test-cart',
    estado: 'AGUARDANDO_PAGAMENTO',
    total: 100,
    comprador: { nome: 'Fixture', email: 'a@example.invalid' },
    expira_em: new Date(Date.now() + 600000).toISOString(),
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => paymentEngine.createForOrder(1, Number(order.id), 'PIX', 'engine-checkout-key'))
  );
  assert.equal(new Set(results.map((r) => r.intent.id)).size, 1);
  assert.equal(creates, 1);
  const id = Number(results[0].intent.id);
  assert.equal((await paymentEngine.intent(1, id)).status, 'PENDING');
  assert.equal(
    (await s.list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { empresa_id: 1, pedido_externo_id: 'engine-test' } })).total,
    0
  );
  await assert.rejects(
    () => paymentEngine.intent(2, id),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    () => paymentEngine.createForOrder(1, Number(order.id), 'BOLETO', 'engine-checkout-key'),
    (e: any) => e.status === 409
  );
  await paymentEngine.synchronize(1, id);
  assert.equal((await paymentEngine.intent(1, id)).status, 'PAID');
  assert.equal((await paymentEngine.createForOrder(1, Number(order.id), 'PIX', 'engine-checkout-key')).idempotent, true);
  await paymentEngine.mutate(1, id, 'refund', 'refund-fixture-key', 2500);
  await paymentEngine.mutate(1, id, 'refund', 'refund-fixture-key', 2500);
  assert.equal(refunds, 1);
  assert.equal((await paymentEngine.intent(1, id)).status, 'PARTIALLY_REFUNDED');
  await assert.rejects(
    () => paymentEngine.mutate(1, id, 'refund', 'refund-fixture-key', 2600),
    (e: any) => e.status === 409
  );
  await assert.rejects(
    () => paymentEngine.mutate(1, id, 'refund', 'refund-too-large-key', 8000),
    (e: any) => e.status === 409
  );
  assert.equal((await s.list(R_REFUNDS, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total, 1);
  assert.equal((await s.list(R_OPERATIONS, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total, 1);
  let actor = { id: 1, name: 'Admin fixture', perfil: 'admin', empresa_id: 1 };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = actor;
    next();
  });
  app.use('/payments', paymentsRouter);
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  const admin = await request(app).get('/payments/providers').expect(200);
  assert.doesNotMatch(JSON.stringify(admin.body), /secret-no-leak|webhook-no-leak/);
  const detail = await request(app).get(`/payments/transactions/${id}`).expect(200);
  assert.equal(detail.body.attempts[0].request_cifradas, undefined);
  actor = { ...actor, empresa_id: 2 };
  await request(app).get(`/payments/transactions/${id}`).expect(404);
  actor = { ...actor, empresa_id: 1, perfil: 'operador' };
  await request(app).post(`/payments/${id}/refund`).send({ amount: 100 }).expect(403);
  await request(app).get('/payments/providers').expect(403);
  assert.equal((await s.list(R_INTENTS, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total, 1);
  assert.equal((await s.list(R_ATTEMPTS, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total, 1);
  assert.equal((await s.list(R_ROUTING, { page: 1, pageSize: 100, filter: { empresa_id: 2 } })).total, 0);
});
test('Payment Engine: manual payment is pending until authorized confirmation; confirmation is idempotent', async () => {
  const s = getStore();
  await s.insert(R_GATEWAY_CONFIGS, { empresa_id: 2, provider: 'manual', ativo: true, ambiente: 'teste' });
  await s.insert(R_ROUTING, {
    empresa_id: 2,
    method: 'MANUAL_PAYMENT',
    provider: 'MANUAL',
    priority: 1,
    enabled: true,
    conditions: { channel: 'OWN_STORE' },
  });
  const sale = await s.insert(RESOURCES.sales, {
    id: 'engine-manual-spec',
    empresa_id: 2,
    status: 'PENDING',
    amount_cents: 5000,
    currency: 'BRL',
    channel: 'BROBOND',
    usuario_id: 1,
    external_order_id: 'manual-spec',
  });
  const order = await s.insert(RESOURCES.commerce_pedidos, {
    empresa_id: 2,
    canal: 'BROBOND',
    sale_id: sale.id,
    pedido_externo: 'manual-spec',
    chave_checkout: 'manual-spec-cart',
    estado: 'AGUARDANDO_PAGAMENTO',
    total: 50,
    comprador: { nome: 'Manual', email: 'manual@example.invalid' },
    expira_em: new Date(Date.now() + 600000).toISOString(),
  });
  const created = await paymentEngine.createForOrder(2, Number(order.id), 'MANUAL_PAYMENT', 'manual-checkout-key');
  const id = Number(created.intent.id);
  assert.equal(created.intent.status, 'PENDING_MANUAL_CONFIRMATION');
  assert.equal((await s.findOneWhere(RESOURCES.sales, { empresa_id: 2, id: sale.id }))?.status, 'PENDING');
  await paymentEngine.mutate(2, id, 'manual-confirm', 'manual-confirm-key');
  await paymentEngine.mutate(2, id, 'manual-confirm', 'manual-confirm-key');
  assert.equal((await paymentEngine.intent(2, id)).status, 'PAID');
  assert.equal((await s.list(R_OPERATIONS, { page: 1, pageSize: 20, filter: { empresa_id: 2, payment_intent_id: id } })).total, 1);
});
test('Payment Engine: actual orchestrated fallback records both attempts; business declines and ambiguous writes never fall back', async (t) => {
  const s = getStore();
  await s.insert(R_GATEWAY_CONFIGS, {
    empresa_id: 3,
    provider: 'stripe',
    ativo: true,
    ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(
      JSON.stringify({ secret_key: 'sk_fixture', enabled_methods: 'PIX', return_url: 'https://example.invalid/order' })
    ),
    webhook_segredo_cifrado: cifrarSegredo('wh_fixture'),
  });
  await s.insert(R_GATEWAY_CONFIGS, {
    empresa_id: 3,
    provider: 'mercadopago',
    ativo: true,
    ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'mp_fixture' })),
    webhook_segredo_cifrado: cifrarSegredo('wh_fixture'),
  });
  await s.insert(R_ROUTING, {
    empresa_id: 3,
    method: 'PIX',
    provider: 'STRIPE',
    priority: 1,
    enabled: true,
    conditions: { channel: 'OWN_STORE' },
  });
  await s.insert(R_ROUTING, {
    empresa_id: 3,
    method: 'PIX',
    provider: 'MERCADO_PAGO',
    priority: 2,
    enabled: true,
    conditions: { channel: 'OWN_STORE', fallback: true },
  });
  let stripeStatus = 429,
    mpCalls = 0;
  const keys: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (String(url).includes('stripe.com')) {
      keys.push((init.headers as Record<string, string>)['Idempotency-Key']);
      return new Response(JSON.stringify(stripeStatus === 200 ? { id: 'cs_recovered', url: 'https://checkout.stripe.com/fixture' } : {}), {
        status: stripeStatus,
      });
    }
    mpCalls++;
    return new Response(JSON.stringify({ id: `mp_fallback_${mpCalls}`, status: 'pending', transaction_amount: 10, currency_id: 'BRL' }));
  });
  async function order(suffix: string) {
    const id = `fallback-${suffix}`;
    await s.insert(RESOURCES.sales, {
      id,
      empresa_id: 3,
      status: 'PENDING',
      amount_cents: 1000,
      currency: 'BRL',
      channel: 'BROBOND',
      usuario_id: 1,
      external_order_id: id,
    });
    return s.insert(RESOURCES.commerce_pedidos, {
      empresa_id: 3,
      canal: 'BROBOND',
      sale_id: id,
      pedido_externo: id,
      chave_checkout: id,
      estado: 'AGUARDANDO_PAGAMENTO',
      total: 10,
      comprador: { nome: 'Fixture', email: 'fallback@example.invalid' },
      expira_em: new Date(Date.now() + 600000).toISOString(),
    });
  }
  const a = await order('eligible');
  const result = await paymentEngine.createForOrder(3, Number(a.id), 'PIX', 'fallback-eligible-key');
  assert.equal(result.intent.provider, 'MERCADO_PAGO');
  assert.equal(mpCalls, 1);
  const attempts = await s.list(R_ATTEMPTS, {
    page: 1,
    pageSize: 10,
    sort: 'id',
    dir: 'asc',
    filter: { empresa_id: 3, payment_intent_id: result.intent.id },
  });
  assert.equal(attempts.total, 2);
  assert.equal(attempts.rows[0].failure_code, 'RATE_LIMITED');
  assert.equal(attempts.rows[1].safe_reference.fallback_from, 'STRIPE');
  stripeStatus = 402;
  const b = await order('decline');
  await assert.rejects(() => paymentEngine.createForOrder(3, Number(b.id), 'PIX', 'fallback-decline-key'));
  assert.equal(mpCalls, 1);
  stripeStatus = 500;
  const c = await order('uncertain');
  const pending = await paymentEngine.createForOrder(3, Number(c.id), 'PIX', 'fallback-uncertain-key');
  assert.equal(pending.intent.status, 'PENDING');
  assert.equal(mpCalls, 1);
  const uncertainKey = keys.at(-1);
  stripeStatus = 200;
  await paymentEngine.synchronize(3, Number(pending.intent.id));
  assert.equal(keys.at(-1), uncertainKey);
  assert.equal(mpCalls, 1);
  assert.equal((await paymentEngine.intent(3, Number(pending.intent.id))).status, 'REQUIRES_ACTION');
  const published = await s.list(R_ROUTING, { page: 1, pageSize: 10, filter: { empresa_id: 3 } });
  for (const rule of published.rows) await s.update(R_ROUTING, Number(rule.id), { enabled: false });
  const { candidates } = await import('../../modules/payments/application/configuration');
  assert.equal(
    (await candidates({ empresaId: 3, method: 'PIX', channel: 'OWN_STORE', country: 'BR', currency: 'BRL', amount: 1000, installments: 1 }))
      .length,
    0,
    'Disabled explicit rules cannot silently reactivate the compatibility route'
  );
});
test('Payment Engine: provider configuration preserves environment credentials only on explicit authenticated admin save', async () => {
  const { registrarReautenticacao, limparReautenticacao } = await import('../src/auth');
  const env = {
    company: process.env.COMMERCE_LOJA_EMPRESA_ID,
    token: process.env.MERCADOPAGO_ACCESS_TOKEN,
    webhook: process.env.MERCADOPAGO_WEBHOOK_SECRET,
  };
  process.env.COMMERCE_LOJA_EMPRESA_ID = '4';
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'fixture-env-no-leak';
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'fixture-env-webhook';
  const actor = { id: 909, name: 'Admin save fixture', perfil: 'admin', empresa_id: 4 };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = actor;
    next();
  });
  app.use('/payments', paymentsRouter);
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  try {
    const body = { enabled: true, environment: 'teste' };
    await request(app).put('/payments/providers/MERCADO_PAGO').send(body).expect(403);
    registrarReautenticacao(actor.id);
    await request(app)
      .put('/payments/providers/MERCADO_PAGO')
      .send({ ...body, credentials: { pan: 'forbidden-card' } })
      .expect(400);
    await request(app).put('/payments/providers/MERCADO_PAGO').send(body).expect(200);
    const { account } = await import('../../modules/payments/application/configuration');
    const a = await account(4, 'MERCADO_PAGO');
    assert.equal(a.context.credentials.access_token, 'fixture-env-no-leak');
    assert.ok(a.config?.id);
    const r = await request(app).get('/payments/providers').expect(200);
    assert.doesNotMatch(JSON.stringify(r.body), /fixture-env-no-leak|fixture-env-webhook/);
  } finally {
    limparReautenticacao(actor.id);
    for (const [key, value] of [
      ['COMMERCE_LOJA_EMPRESA_ID', env.company],
      ['MERCADOPAGO_ACCESS_TOKEN', env.token],
      ['MERCADOPAGO_WEBHOOK_SECRET', env.webhook],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Stripe e PagBank não projetam pagamento integral quando captura externa é parcial ou desconhecida', async (t) => {
  let amountReceived: number | undefined = 4000; let pagPaid = 4000;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).includes('stripe.com') && String(url).includes('/charges/')) return new Response(JSON.stringify({ id: 'ch-test', payment_intent: 'pi-test', currency: 'brl', amount_captured: 10000, amount_refunded: 0 }));
    if (String(url).includes('stripe.com')) return new Response(JSON.stringify({ id: 'cs-test', amount_total: 10000, currency: 'brl', payment_status: 'paid', payment_intent: { id: 'pi-test', status: 'succeeded', amount_received: amountReceived, latest_charge: 'ch-test' } }));
    return new Response(JSON.stringify({ id: 'ORDE-test', items: [{ unit_amount: 10000, quantity: 1 }], charges: [{ id: 'CHAR-test', status: 'PAID', amount: { currency: 'BRL', summary: { paid: pagPaid, refunded: 0 } } }] }));
  });
  const stripe = new StripeProvider(); const sc = { ...ctx, credentials: { secret_key: 'test-only' } };
  await assert.rejects(() => stripe.getPayment(sc, 'cs-test'), (e: any) => e instanceof PaymentError);
  amountReceived = undefined; await assert.rejects(() => stripe.getPayment(sc, 'cs-test'), (e: any) => e instanceof PaymentError);
  amountReceived = 10000; assert.equal((await stripe.getPayment(sc, 'cs-test')).status, 'PAID');
  const pagbank = new PagBankProvider(); const pc = { ...ctx, credentials: { access_token: 'test-only' } };
  await assert.rejects(() => pagbank.getPayment(pc, 'ORDE-test'), (e: any) => e instanceof PaymentError);
  pagPaid = 10000; assert.equal((await pagbank.getPayment(pc, 'ORDE-test')).status, 'PAID');
});

test('Mercado Pago não projeta pagamento com referência, total ou estorno remoto desconhecidos', async (t) => {
  const { MercadoPagoProvider } = await import('../../modules/payments/providers/mercado-pago');
  let payload: Record<string, unknown> = { id: 'mp-proof', status: 'approved', transaction_amount: 100, currency_id: 'BRL', transaction_amount_refunded: 0 };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
  const provider = new MercadoPagoProvider(); const pc = { ...ctx, credentials: { access_token: 'fixture-only' } };
  for (const bad of [
    { ...payload, id: 'other' }, { ...payload, id: null }, { ...payload, transaction_amount: null },
    { ...payload, currency_id: null }, { ...payload, transaction_amount_refunded: null },
    { ...payload, transaction_amount_refunded: undefined }, { ...payload, transaction_amount_refunded: -1 },
    { ...payload, transaction_amount_refunded: 101 }, { ...payload, transaction_amount: 100.001 },
    { ...payload, transaction_amount_refunded: 0.001 },
  ]) { payload = bad; await assert.rejects(() => provider.getPayment(pc, 'mp-proof'), (e: any) => e instanceof PaymentError && e.ambiguous); }
  payload = { id: 'mp-proof', status: 'approved', transaction_amount: 100, currency_id: 'BRL', transaction_amount_refunded: 0 };
  assert.equal((await provider.getPayment(pc, 'mp-proof')).status, 'PAID');
});

test('Stripe e PagBank rejeitam identidade e valor de refund ausentes, divergentes ou impossíveis', async (t) => {
  let session: Record<string, any> = { id: 'cs-proof', amount_total: 10000, currency: 'brl', payment_status: 'paid',
    payment_intent: { id: 'pi-proof', status: 'succeeded', amount_received: 10000, latest_charge: 'ch-proof' } };
  let charge: Record<string, any> = { id: 'ch-proof', payment_intent: 'pi-proof', currency: 'brl', amount_captured: 10000, amount_refunded: 0 };
  let order: Record<string, any> = { id: 'ORDE-proof', items: [{ unit_amount: 10000, quantity: 1 }],
    charges: [{ id: 'CHAR-proof', status: 'PAID', amount: { currency: 'BRL', summary: { paid: 10000, refunded: 0 } } }] };
  t.mock.method(globalThis, 'fetch', async (url: unknown) => new Response(JSON.stringify(String(url).includes('/charges/') ? charge : String(url).includes('stripe.com') ? session : order)));
  const stripe = new StripeProvider(); const sc = { ...ctx, credentials: { secret_key: 'test-only' } };
  for (const bad of [null, undefined, -1, 10001, '0']) {
    charge = { ...charge, amount_refunded: bad };
    await assert.rejects(() => stripe.getPayment(sc, 'cs-proof'), (e: any) => e instanceof PaymentError && e.ambiguous);
  }
  charge = { id: 'outro', payment_intent: 'pi-proof', currency: 'brl', amount_captured: 10000, amount_refunded: 0 };
  await assert.rejects(() => stripe.getPayment(sc, 'cs-proof'), (e: any) => e instanceof PaymentError);
  charge.id = 'ch-proof'; session = { ...session, id: 'outra' };
  await assert.rejects(() => stripe.getPayment(sc, 'cs-proof'), (e: any) => e instanceof PaymentError);
  session.id = 'cs-proof'; assert.equal((await stripe.getPayment(sc, 'cs-proof')).status, 'PAID');
  const pag = new PagBankProvider(); const pc = { ...ctx, credentials: { access_token: 'test-only' } };
  for (const bad of [null, undefined, -1, 10001, '0']) {
    order.charges[0].amount.summary.refunded = bad;
    await assert.rejects(() => pag.getPayment(pc, 'ORDE-proof'), (e: any) => e instanceof PaymentError && e.ambiguous);
  }
  order.charges[0].amount.summary.refunded = 0; order.id = 'ORDE-other';
  await assert.rejects(() => pag.getPayment(pc, 'ORDE-proof'), (e: any) => e instanceof PaymentError);
  order.id = 'ORDE-proof'; order.charges[0].amount.currency = 'USD';
  await assert.rejects(() => pag.getPayment(pc, 'ORDE-proof'), (e: any) => e instanceof PaymentError);
  order.charges[0].amount.currency = 'BRL'; assert.equal((await pag.getPayment(pc, 'ORDE-proof')).status, 'PAID');
  order.charges[0].amount.summary.paid = 5000;
  order.charges.push({ ...order.charges[0], amount: { ...order.charges[0].amount, summary: { paid: 5000, refunded: 0 } } });
  await assert.rejects(() => pag.getPayment(pc, 'ORDE-proof'), (e: any) => e instanceof PaymentError && e.ambiguous);

});

test('refund Stripe só retorna evidência individual se identidade, pagamento e valor coincidirem', async (t) => {
  let refund: Record<string, unknown> = { id: 're-proof', payment_intent: 'pi-proof', amount: 2500, currency: 'brl', status: 'succeeded' };
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url);
    if (path.endsWith('/refunds') || path.endsWith('/refunds/re-proof')) return new Response(JSON.stringify(refund));
    if (path.includes('/charges/')) return new Response(JSON.stringify({ id: 'ch-proof', payment_intent: 'pi-proof', currency: 'brl', amount_captured: 10000, amount_refunded: 2500 }));
    if (path.includes('?expand')) return new Response(JSON.stringify({ id: 'cs-proof', amount_total: 10000, currency: 'brl', payment_status: 'paid',
      payment_intent: { id: 'pi-proof', status: 'succeeded', amount_received: 10000, latest_charge: 'ch-proof' } }));
    return new Response(JSON.stringify({ id: 'cs-proof', payment_intent: 'pi-proof' }));
  });
  const stripe = new StripeProvider(); const sc = { ...ctx, credentials: { secret_key: 'test-only' } };
  let response = await stripe.refund(sc, 'cs-proof', 2500);
  assert.deepEqual(response.refundEvidence, { reference: 're-proof', paymentReference: 'cs-proof', amount: 2500, status: 'SUCCEEDED' });
  assert.equal((await stripe.getRefund(sc, 'cs-proof', 're-proof')).amount, 2500);
  for (const bad of [{ ...refund, id: null }, { ...refund, id: ' re-proof ' }, { ...refund, payment_intent: 'pi-other' }, { ...refund, currency: 'usd' }, { ...refund, amount: null }, { ...refund, amount: 2400 }]) {
    refund = bad; response = await stripe.refund(sc, 'cs-proof', 2500); assert.equal(response.refundEvidence, undefined);
  }
});

test('Mercado Pago não liquida resposta de criação sem leitura autoritativa', async (t) => {
  let read = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'created-mp', status: 'approved' }));
    read = true; return new Response(JSON.stringify({ id: 'created-mp', status: 'approved', transaction_amount: 100, currency_id: 'BRL', transaction_amount_refunded: 0 }));
  });
  const mp = new MercadoPagoProvider(); const mc = { ...ctx, credentials: { access_token: 'fixture-only' }, webhookSecret: 'fixture-only' };
  const created = await mp.createPaymentIntent(mc, { amount: 10000, currency: 'BRL', method: 'PIX', reference: 'create-test', email: 'fixture@example.invalid', installments: 1 }); assert.equal(created.reference, 'created-mp');
  assert.equal(created.status, 'PENDING'); assert.equal(read, false);
  assert.equal((await mp.getPayment(mc, 'created-mp')).status, 'PAID'); assert.equal(read, true);
});

test('Mercado Pago preserva refund individual só com identidade, pagamento, valor exato e status conhecidos', async (t) => {
  let refund: Record<string, unknown> = { id: 'refund-123', payment_id: 'pay-123', amount: 25, status: 'approved' }; let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const path = String(url);
    if (init.method === 'POST' && path.endsWith('/refunds')) { writes++; return new Response(JSON.stringify(refund)); }
    if (path.endsWith('/refunds/refund-123')) return new Response(JSON.stringify(refund));
    return new Response(JSON.stringify({ id: 'pay-123', status: 'approved', transaction_amount: 100, currency_id: 'BRL', transaction_amount_refunded: 25 }));
  });
  const mp = new MercadoPagoProvider(); const mc = { ...ctx, credentials: { access_token: 'fixture-only' } };
  assert.deepEqual((await mp.refund(mc, 'pay-123', 2500)).refundEvidence, { reference: 'refund-123', paymentReference: 'pay-123', amount: 2500, status: 'SUCCEEDED' });
  assert.equal((await mp.getRefund(mc, 'pay-123', 'refund-123')).amount, 2500);
  for (const invalid of [{ ...refund, id: null }, { ...refund, id: ' refund-123 ' }, { ...refund, payment_id: 'wrong' },
    { ...refund, amount: 24 }, { ...refund, amount: 25.001 }, { ...refund, status: 'unknown' }]) {
    refund = invalid; assert.equal((await mp.refund(mc, 'pay-123', 2500)).refundEvidence, undefined);
  }
  assert.equal(writes, 7);
});

test('Stripe não captura nem cancela PaymentIntent de uma sessão com identidade diferente', async (t) => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'POST') writes++;
    return new Response(JSON.stringify({ id: 'other-session', status: 'open', payment_intent: { id: 'pi-other', status: 'requires_capture' } }));
  });
  const stripe = new StripeProvider(); const sc = { ...ctx, credentials: { secret_key: 'fixture-only' } };
  await assert.rejects(() => stripe.capture(sc, 'cs-expected', 10000), (e: any) => e instanceof PaymentError && e.ambiguous);
  await assert.rejects(() => stripe.cancel(sc, 'cs-expected'), (e: any) => e instanceof PaymentError && e.ambiguous);
  assert.equal(writes, 0);
});
