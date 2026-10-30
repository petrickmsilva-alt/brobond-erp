import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
if (!process.env.DATABASE_URL) throw new Error('Payment Engine PostgreSQL requires DATABASE_URL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db');
await migrate();
const { getStore } = await import('../../src/services');
const { RESOURCES } = await import('../../src/resources');
const { cifrarSegredo } = await import('../../src/segredos');
const { R_GATEWAY_CONFIGS, R_GATEWAY_WEBHOOK_EVENTS, publicGatewayRouter } = await import('../../src/gateway');
const { R_INTENTS, R_ATTEMPTS, R_OPERATIONS, R_REFUNDS } = await import('../../../modules/payments/infrastructure/resources');
const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');

test('Payment Engine PostgreSQL: concurrent checkout, signed inbox, duplicate webhook/refund, tenant FK and financial invariants', async (t) => {
  assert.ok(pool);
  const s = getStore();
  const suffix = randomUUID();
  const company = await pool.query(`INSERT INTO empresas(nome,razao_social,ativo) VALUES($1,$1,true) RETURNING id`, [
    `Payment Spec ${suffix}`,
  ]);
  const empresaId = Number(company.rows[0].id);
  await s.insert(R_GATEWAY_CONFIGS, {
    empresa_id: empresaId,
    provider: 'mercadopago',
    ativo: true,
    ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'spec-fixture-only' })),
    webhook_segredo_cifrado: cifrarSegredo('spec-webhook'),
  });
  const u = await pool.query(
    `INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Payment Spec',$1,'admin',true,$2) RETURNING id`,
    [`payment-${suffix}@example.invalid`, empresaId]
  );
  const userId = Number(u.rows[0].id);
  const saleId = `payment-spec-${suffix}`;
  await s.insert(RESOURCES.sales, {
    id: saleId,
    reference: saleId,
    empresa_id: empresaId,
    usuario_id: userId,
    quantity: 1,
    status: 'PENDING',
    amount_cents: 10000,
    currency: 'BRL',
    channel: 'BROBOND',
    external_order_id: saleId,
    occurred_at: new Date().toISOString(),
  });
  const order = await s.insert(RESOURCES.commerce_pedidos, {
    empresa_id: empresaId,
    canal: 'BROBOND',
    sale_id: saleId,
    pedido_externo: saleId,
    chave_checkout: `spec-${suffix}`,
    estado: 'AGUARDANDO_PAGAMENTO',
    total: 100,
    comprador: { nome: 'Spec', email: 'spec@example.invalid' },
    expira_em: new Date(Date.now() + 600000).toISOString(),
  });
  let creates = 0,
    refunded = 0;
  const reference = `spec-ref-${suffix}`;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith('/refunds')) {
      const amount = Number(JSON.parse(String(init.body)).amount);
      refunded += amount;
      return new Response(JSON.stringify({ id: `pg-refund-${suffix}`, payment_id: reference, amount, status: 'approved' }));
    }
    if (init.method === 'POST') {
      creates++;
      return new Response(JSON.stringify({ id: reference, status: 'pending', transaction_amount: 100, currency_id: 'BRL' }));
    }
    return new Response(
      JSON.stringify({
        id: reference,
        status: refunded >= 100 ? 'refunded' : 'approved',
        transaction_amount: 100,
        currency_id: 'BRL',
        transaction_amount_refunded: refunded,
      })
    );
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => paymentEngine.createForOrder(empresaId, Number(order.id), 'PIX', 'postgres-create-spec'))
  );
  const id = Number(results[0].intent.id);
  assert.equal(new Set(results.map((r) => r.intent.id)).size, 1);
  assert.equal(creates, 1);
  assert.equal((await s.list(R_ATTEMPTS, { page: 1, pageSize: 20, filter: { empresa_id: empresaId, payment_intent_id: id } })).total, 1);
  assert.equal((await paymentEngine.intent(empresaId, id)).status, 'PENDING');
  await assert.rejects(
    () => paymentEngine.intent(1, id),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    () =>
      pool!.query(
        `INSERT INTO payment_attempts(empresa_id,payment_intent_id,provider,method,requested_amount,status,idempotency_key,correlation_id) VALUES(1,$1,'STRIPE','PIX',100,'CREATED',$2,$2)`,
        [id, suffix]
      ),
    (e: any) => e.code === '23503'
  );
  const app = express();
  app.use(publicGatewayRouter);
  const event = {
    id: `evt-${suffix}`,
    type: 'payment',
    data: { id: reference },
    card: { number: 'forbidden-fixture-pan', security_code: 'fixture-cvv' },
    access_token: 'forbidden-fixture-token',
  };
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = 'postgres-webhook-spec';
  const signature = createHmac('sha256', 'spec-webhook')
    .update(`id:${reference.toLowerCase()};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  await request(app).post('/api/gateway/webhooks/mercadopago').send(event).expect(401);
  const send = () =>
    request(app)
      .post('/api/gateway/webhooks/mercadopago')
      .set('x-request-id', requestId)
      .set('x-signature', `ts=${ts},v1=${signature}`)
      .send(event);
  const first = await send().expect(200);
  assert.equal(first.body.resultado, 'payment_engine');
  const duplicate = await send().expect(200);
  assert.equal(duplicate.body.duplicado, true);
  const events = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 20, filter: { empresa_id: empresaId } });
  assert.equal(events.total, 1);
  assert.equal(events.rows[0].assinatura_ok, true);
  assert.match(events.rows[0].payload_hash, /^[a-f\d]{64}$/);
  assert.doesNotMatch(JSON.stringify(events.rows), /forbidden-fixture/);
  assert.equal((await paymentEngine.intent(empresaId, id)).status, 'PAID');
  const refundResults = await Promise.allSettled([
    paymentEngine.mutate(empresaId, id, 'refund', 'postgres-refund-A', 6000),
    paymentEngine.mutate(empresaId, id, 'refund', 'postgres-refund-B', 6000),
  ]);
  assert.equal(refundResults.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(refunded, 60);
  const op = (await s.list(R_OPERATIONS, { page: 1, pageSize: 10, filter: { empresa_id: empresaId, status: 'SUCCEEDED' } })).rows[0];
  await paymentEngine.mutate(empresaId, id, 'refund', String(op.idempotency_key), 6000);
  assert.equal(refunded, 60);
  assert.equal((await s.list(R_REFUNDS, { page: 1, pageSize: 10, filter: { empresa_id: empresaId } })).total, 1);
  assert.equal((await s.list(R_INTENTS, { page: 1, pageSize: 10, filter: { empresa_id: empresaId } })).total, 1);
  assert.equal((await paymentEngine.intent(empresaId, id)).status, 'PARTIALLY_REFUNDED');
});
