import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
if (!process.env.DATABASE_URL) throw new Error('Wave 1 requires PostgreSQL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate();
const { getStore } = await import('../../src/services');
const { RESOURCES } = await import('../../src/resources');
const { cifrarSegredo } = await import('../../src/segredos');
const { R_GATEWAY_CONFIGS } = await import('../../src/gateway');
const { R_LATE_REVIEWS, R_OPERATIONS } = await import('../../../modules/payments/infrastructure/resources');
const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
const { paymentsRouter } = await import('../../../modules/payments/api/routes');

test('PG: confirmação tardia comprovada, conciliação de reembolso parcial/integral, fila e isolamento', async (t) => {
  assert.ok(pool); const s = getStore(); const suffix = randomUUID();
  const company = Number((await pool.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`Late PG ${suffix}`])).rows[0].id);
  const other = Number((await pool.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`Other PG ${suffix}`])).rows[0].id);
  const userId = Number((await pool.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Late PG',$1,'admin',true,$2) RETURNING id", [`late-${suffix}@example.invalid`, company])).rows[0].id);
  await s.insert(R_GATEWAY_CONFIGS, { empresa_id: company, provider: 'mercadopago', ativo: true, ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'fixture-only' })), webhook_segredo_cifrado: cifrarSegredo('fixture-only') });
  const saleId = `late-pg-${suffix}`;
  await s.insert(RESOURCES.sales, { id: saleId, reference: saleId, empresa_id: company, usuario_id: userId, status: 'PENDING',
    quantity: 1, amount_cents: 10000, currency: 'BRL', channel: 'BROBOND', external_order_id: saleId });
  const order = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: company, canal: 'BROBOND', sale_id: saleId, pedido_externo: saleId,
    chave_checkout: saleId, estado: 'AGUARDANDO_PAGAMENTO', total: 100, comprador: { nome: 'PG', email: 'pg@example.invalid' },
    expira_em: new Date(Date.now() + 600000).toISOString() });
  let refunded = 0; let calls = 0; let amount = 100;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith('/refunds')) { calls++; const requested = Number(JSON.parse(String(init.body)).amount); refunded += calls === 1 ? 10 : requested; return new Response(JSON.stringify({ id: `pg-refund-${calls}-${suffix}`, payment_id: saleId, amount: requested, status: 'approved' })); }
    if (init.method === 'POST') return new Response(JSON.stringify({ id: saleId, status: 'pending', transaction_amount: 100, currency_id: 'BRL' }));
    return new Response(JSON.stringify({ id: saleId, status: refunded === 100 ? 'refunded' : 'approved', transaction_amount: amount,
      currency_id: 'BRL', transaction_amount_refunded: refunded }));
  });
  const id = Number((await paymentEngine.createForOrder(company, Number(order.id), 'PIX', `late-key-${suffix}`)).intent.id);
  await paymentEngine.apply(company, id, { reference: saleId, status: 'EXPIRED' });
  amount = 99; await assert.rejects(() => paymentEngine.synchronize(company, id), (e: any) => e.status === 409);
  amount = 100; await Promise.all(Array.from({ length: 4 }, () => paymentEngine.synchronize(company, id)));
  const review = await s.findOneWhere(R_LATE_REVIEWS, { empresa_id: company, order_id: order.id });
  assert.ok(review); assert.equal(review.status, 'OPEN');
  assert.equal((await s.list(R_LATE_REVIEWS, { page: 1, pageSize: 20, filter: { empresa_id: company } })).total, 1);
  await assert.rejects(() => pool!.query(`INSERT INTO payment_late_reviews (empresa_id,order_id,cobranca_id,status)
    VALUES ($1,$2,$3,'OPEN')`, [other, order.id, review.cobranca_id]), (e: any) => e.code === '23503');
  let actor = { id: userId, name: 'PG', perfil: 'admin', empresa_id: company, empresas: [company] };
  const app = express(); app.use((req, _res, next) => { (req as any).user = actor; next(); }); app.use('/payments', paymentsRouter);
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  await request(app).get(`/payments/late-reviews/${review.id}`).expect(200);
  actor = { ...actor, empresa_id: other, empresas: [other] }; await request(app).get(`/payments/late-reviews/${review.id}`).expect(404);
  await assert.rejects(() => paymentEngine.mutate(company, id, 'refund', `partial-${suffix}`, 2500), (e: any) => e.status === 409);
  const operation = await s.findOneWhere(R_OPERATIONS, { empresa_id: company, payment_intent_id: id, idempotency_key: `partial-${suffix}` });
  assert.equal(operation?.status, 'UNCERTAIN'); assert.equal((await s.get(R_LATE_REVIEWS, Number(review.id)))?.status, 'OPEN');
  await paymentEngine.synchronize(company, id); assert.equal((await s.get(R_OPERATIONS, Number(operation?.id)))?.status, 'UNCERTAIN');
  refunded = 25; await paymentEngine.synchronize(company, id);
  assert.equal((await s.get(R_OPERATIONS, Number(operation?.id)))?.status, 'SUCCEEDED');
  await paymentEngine.mutate(company, id, 'refund', `final-${suffix}`, 7500);
  await paymentEngine.mutate(company, id, 'refund', `final-${suffix}`, 7500);
  assert.equal(calls, 2); assert.equal((await s.get(R_LATE_REVIEWS, Number(review.id)))?.status, 'REFUNDED');
  const end = await s.get(RESOURCES.commerce_pedidos, Number(order.id));
  assert.equal(end?.estado, 'EXPIRADO'); assert.equal(end?.pagamento_estado, 'REFUNDED');
  assert.equal((await s.get(RESOURCES.sales, saleId as any))?.status, 'CANCELLED');
  const { confirmarPagamentoCobranca } = await import('../../src/commerce/pedidos');
  await confirmarPagamentoCobranca({ empresaId: company, cobrancaId: Number(review.cobranca_id), intencao: 'paga' });
  assert.equal((await s.get(RESOURCES.commerce_pedidos, Number(order.id)))?.estado, 'EXPIRADO');
  assert.equal((await s.get(R_LATE_REVIEWS, Number(review.id)))?.status, 'REFUNDED');
});

test('PG: CAS impede que conversor atrasado sobrescreva estados terminais', async () => {
  const s = getStore(), q = pool!, suffix = randomUUID();
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`CAS ${suffix}`])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('CAS',$1,'admin',true,$2) RETURNING id", [`cas-${suffix}@example.invalid`, company])).rows[0].id);
  const { converterPedidoSale } = await import('../../src/commerce/pedidos');
  for (const target of ['CONVERTIDO', 'AGUARDANDO_CORRECAO'] as const) {
    const reference = `cas-${target}-${suffix}`;
    await s.insert(RESOURCES.sales, { id: reference, reference, empresa_id: company, usuario_id: user, status: 'PAID', quantity: 1,
      amount_cents: 10000, currency: 'BRL', channel: 'BROBOND', external_order_id: reference });
    const order = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: company, canal: 'BROBOND', sale_id: reference,
      pedido_externo: reference, chave_checkout: reference, estado: 'PAGO', total: 100 });
    if (target === 'CONVERTIDO') {
      const venda = Number((await q.query("INSERT INTO vendas(empresa_id,status,total) VALUES($1,'faturada',100) RETURNING id", [company])).rows[0].id);
      await s.update(RESOURCES.sales, reference as any, { operational_venda_id: venda });
    }
    const original = s.tryUpdateIf.bind(s); let raced = false;
    s.tryUpdateIf = async (resource, id, expected, data, tx) => {
      if (resource.key === 'commerce_pedidos' && Number(id) === Number(order.id) && data.estado === target) {
        raced = true; await q.query('UPDATE commerce_pedidos SET estado=$1 WHERE id=$2 AND empresa_id=$3', [target === 'CONVERTIDO' ? 'CANCELADO' : 'ESTORNADO', order.id, company]);
      }
      return original(resource, id, expected, data, tx);
    };
    try {
      await assert.rejects(() => converterPedidoSale(company, reference), (e: any) => e.status === 409);
      assert.equal(raced, true);
      const state = await q.query('SELECT estado FROM commerce_pedidos WHERE id=$1 AND empresa_id=$2', [order.id, company]);
      assert.equal(state.rows[0].estado, target === 'CONVERTIDO' ? 'CANCELADO' : 'ESTORNADO');
    } finally { s.tryUpdateIf = original; }
  }
});

test('PG: webhook legado pago após expiração abre fila sem baixar financeiro ou reabrir pedido', async () => {
  const s = getStore(), q = pool!, suffix = randomUUID();
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`Legacy late ${suffix}`])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Legacy',$1,'admin',true,$2) RETURNING id", [`legacy-${suffix}@example.invalid`, company])).rows[0].id);
  const gateway = await import('../../src/gateway');
  await s.insert(gateway.R_GATEWAY_CONFIGS, { empresa_id: company, provider: 'mock', ativo: true, ambiente: 'teste', credenciais_cifradas: null, webhook_segredo_cifrado: null });
  const reference = `legacy-late-${suffix}`;
  const title = await s.insert(RESOURCES.lancamentos_financeiros, { empresa_id: company, descricao: 'late fixture', tipo: 'receita', status: 'pendente', valor: 100, data: '2030-01-01' });
  const charge = await s.insert(gateway.R_GATEWAY_COBRANCAS, { empresa_id: company, provider: 'mock', metodo: 'pix', status: 'expirada',
    provider_ref: reference, valor: 100, valor_liquido: 100, taxa_pct: 0, parcelas: 1, idempotency_key: reference, lancamento_id: title.id });
  await s.insert(RESOURCES.sales, { id: reference, reference, empresa_id: company, usuario_id: user, status: 'CANCELLED', quantity: 1,
    amount_cents: 10000, currency: 'BRL', channel: 'BROBOND', external_order_id: reference });
  const order = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: company, canal: 'BROBOND', sale_id: reference, pedido_externo: reference,
    chave_checkout: reference, estado: 'EXPIRADO', cobranca_id: charge.id, total: 100 });
  const evt = await s.insert(gateway.R_GATEWAY_WEBHOOK_EVENTS, { empresa_id: company, provider: 'mock', evento_id: reference, evento: 'payment.paid',
    payload: { event: 'payment.paid', status: 'pago', data: { id: reference } }, assinatura_ok: true, status: 'recebido', tentativas: 0 });
  assert.equal((await gateway.processarEvento(evt)).resultado, 'paga');
  const review = await s.findOneWhere(R_LATE_REVIEWS, { empresa_id: company, order_id: Number(order.id) });
  assert.equal(review?.status, 'OPEN'); assert.equal((await s.get(RESOURCES.commerce_pedidos, Number(order.id)))?.estado, 'EXPIRADO');
  assert.equal((await s.get(RESOURCES.lancamentos_financeiros, Number(title.id)))?.status, 'pendente');
  assert.equal((await s.get(RESOURCES.sales, reference as any))?.status, 'CANCELLED');
});
