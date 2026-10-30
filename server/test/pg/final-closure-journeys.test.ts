import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('Final journeys require real PostgreSQL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate(); const db = pool!;
const { getStore, createRecord, updateRecord } = await import('../../src/services');
const { RESOURCES } = await import('../../src/resources');
const { reqDe, resFake } = await import('../_p1util');
const { R_INTENTS, R_ATTEMPTS, R_SETTLEMENTS } = await import('../../../modules/payments/infrastructure/resources');
const { R_GATEWAY_CONFIGS, R_GATEWAY_COBRANCAS } = await import('../../src/gateway');
const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
const { cifrarSegredo } = await import('../../src/segredos');
const { importPayout, matchPayout } = await import('../../../modules/payments/application/payouts');
const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
const exp = await import('../../src/expedicao');
const { processarRefundDevolucao } = await import('../../src/devolucaoRefund');
const { processarOutbox } = await import('../../src/commerce/outbox');
const s = getStore();
const date = new Date().toISOString().slice(0, 10);
async function fixture() {
  const key = randomUUID().slice(0, 12);
  const company = Number((await db.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`Final closure ${key}`])).rows[0].id);
  const user = Number((await db.query("INSERT INTO usuarios(nome,email,perfil,empresa_id,ativo) VALUES('Closure',$1,'admin',$2,true) RETURNING id", [`${key}@example.invalid`, company])).rows[0].id);
  const actor = { id: user, name: 'Closure', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  const scope = { kind: 'empresa' as const, empresaId: company };
  const create = (r: any, b: any) => createRecord(r, b, actor, { escopo: scope });
  const local = Number((await db.query("INSERT INTO locais(empresa_id,nome,tipo,padrao,ativo) VALUES($1,'Closure','loja',true,true) RETURNING id", [company])).rows[0].id);
  const account = Number((await db.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [company, `Settlement-${key}`])).rows[0].id);
  const customer = await create(RESOURCES.clientes, { nome: 'Closure customer', pessoa: 'pf', documento: '52998224725' });
  const product = await create(RESOURCES.produtos, { sku: `CL-${key}`, nome: 'Closure product', preco_venda: 50, custo: 10 });
  const size = await create(RESOURCES.tamanhos, { nome: `Closure ${key}`, codigo: key.slice(0, 8) });
  await create(RESOURCES.movimentacoes, { tamanho_id: size.id, produto_id: product.id, tipo: 'entrada', quantidade: 2, local_id: local, motivo: 'Test stock receipt' });
  const sale = await create(RESOURCES.vendas, { cliente_id: customer.id, status: 'aberta', data: date, total: 100 });
  const { createItem } = await import('../../src/itens');
  await createItem({ ...reqDe({ produto_id: product.id, tamanho_id: size.id, quantidade: 2, preco_unitario: 50 }, { params: { id: sale.id }, user: actor }), path: `/vendas/${sale.id}/itens` }, resFake().res);
  await updateRecord(RESOURCES.vendas, Number(sale.id), { status: 'faturada' }, actor, { escopo: scope });
  const title = (await db.query("SELECT * FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='venda' AND referencia_id=$2", [company, sale.id])).rows[0];
  const charge = await s.insert(R_GATEWAY_COBRANCAS, { empresa_id: company, provider: 'mercadopago', provider_ref: key, metodo: 'pix', status: 'paga', valor: 100,
    venda_id: sale.id, lancamento_id: title.id, conta_id: account });
  const order = (await db.query("INSERT INTO commerce_pedidos(empresa_id,canal,pedido_externo,venda_id,cobranca_id,estado,pagamento_estado) VALUES($1,'BROBOND',$2,$3,$4,'CONVERTIDO','APPROVED') RETURNING id", [company, key, sale.id, charge.id])).rows[0];
  const intent = await s.insert(R_INTENTS, { empresa_id: company, order_id: order.id, cobranca_id: charge.id, channel: 'OWN_STORE', currency: 'BRL', amount: 10000,
    method: 'PIX', provider: 'MERCADO_PAGO', status: 'PAID', idempotency_key: key, correlation_id: key });
  await s.insert(R_ATTEMPTS, { empresa_id: company, payment_intent_id: intent.id, provider: 'MERCADO_PAGO', provider_transaction_id: key, method: 'PIX', requested_amount: 10000,
    captured_amount: 10000, authorized_amount: 10000, refunded_amount: 0, status: 'PAID', idempotency_key: key, correlation_id: key });
  await s.insert(R_GATEWAY_CONFIGS, { empresa_id: company, provider: 'mercadopago', ativo: true, ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'contract-fixture-only' })), webhook_segredo_cifrado: cifrarSegredo('contract-fixture-only') });
  await paymentEngine.apply(company, Number(intent.id), { reference: key, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
  return { company, actor, local, account, customer, product, sale, title, charge, intent, key };
}
async function invoke(fn: any, f: Awaited<ReturnType<typeof fixture>>, id: any, body: any = {}, actor = f.actor) {
  const r = resFake(); const req = reqDe(body, { params: { id }, user: actor });
  (req as any).get = () => `closure-${f.key}`;
  await fn(req, r.res); return r.saida.json;
}
// Only the external HTTP boundary is substituted. Real provider adapter,
// orchestrator, transactions, stock, finance, outbox and RBAC run unchanged.
function providerContract(t: any, f: Awaited<ReturnType<typeof fixture>>) {
  let refunded = 0, posts = 0;
  const refunds = new Map<string, { amount: number; id: string }>();
  t.mock.method(globalThis, 'fetch', async (url: any, init: any = {}) => {
    assert.match(String(url), /api\.mercadopago\.com/);
    if (init.method === 'POST') {
      assert.match(String(url), new RegExp(`/payments/${f.key}/refunds$`));
      const operationKey = String(init.headers['X-Idempotency-Key'] || init.headers['x-idempotency-key']);
      assert.notEqual(operationKey, 'undefined');
      let r = refunds.get(operationKey);
      if (!r) { const amount = Number(JSON.parse(init.body).amount); r = { amount, id: `refund-${++posts}` }; refunds.set(operationKey, r); refunded += amount; }
      return new Response(JSON.stringify({ id: r.id, payment_id: f.key, amount: r.amount, status: 'approved' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: f.key, status: refunded === 100 ? 'refunded' : 'approved', transaction_amount: 100, currency_id: 'BRL', transaction_amount_refunded: refunded }), { status: 200 });
  });
  return { posts: () => posts };
}

test('PG Journey D: capture → individual refund → MDR/settlement → deterministic bank match → canonical book → close; replay and closed-period protection', async (t) => {
  const f = await fixture(); const provider = providerContract(t, f);
  const refund = () => paymentEngine.mutate(f.company, Number(f.intent.id), 'refund', `refund-${f.key}`, 5000);
  await refund(); await refund(); assert.equal(provider.posts(), 1);
  const body = { provider: 'MERCADO_PAGO', currency: 'BRL', payout_reference: `payout-${f.key}`, settlement_date: date, net_amount: 4800,
    transactions: [{ provider_reference: f.key, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 5000, chargeback_amount: 0, net_amount: 4800 }] };
  const report = await invoke(importPayout, f, null, body);
  const replay = await invoke(importPayout, f, null, body); assert.equal(replay.payout.id, report.payout.id);
  const bank = (await db.query("INSERT INTO fin_extrato_transacoes(empresa_id,conta_id,linha_hash,data,valor,direcao,status) VALUES($1,$2,$3,$4,48,'entrada','importada') RETURNING id", [f.company, f.account, f.key, date])).rows[0];
  await Promise.all([invoke(matchPayout, f, report.payout.id, { bank_transaction_id: bank.id }), invoke(matchPayout, f, report.payout.id, { bank_transaction_id: bank.id })]);
  const title = (await db.query('SELECT * FROM lancamentos_financeiros WHERE id=$1', [f.title.id])).rows[0];
  assert.equal(Number(title.valor), 100); assert.equal(Number(title.valor_liquido), 98);
  const book = (await db.query("SELECT sum(CASE WHEN tipo='receita' THEN valor_liquido ELSE -valor_liquido END) saldo FROM lancamentos_financeiros WHERE empresa_id=$1 AND status='confirmado'", [f.company])).rows[0]; assert.equal(Number(book.saldo), 48);
  assert.equal((await db.query('SELECT fin_repasse_comprovado($1,$2) ok', [f.company, report.payout.id])).rows[0].ok, true);
  const close = async (actor = f.actor) => { const r = resFake(); await alterarPeriodo(reqDe({ motivo: 'Financial proof confirmed' }, { params: { competencia: date.slice(0, 7), acao: 'fechar' }, user: actor }), r.res); return r.saida.json; };
  await assert.rejects(() => close({ ...f.actor, perfil: 'operador' as any }), (e: any) => e.status === 403);
  await close(); await close();
  await assert.rejects(() => db.query("INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor,status) VALUES($1,$2,'receita','Late posting',1,'confirmado')", [f.company, date]), (e: any) => e.code === 'P2001');
  await assert.rejects(() => paymentEngine.mutate(f.company, Number(f.intent.id), 'refund', `closed-${f.key}`, 5000));
  assert.equal(provider.posts(), 1, 'closed period rejects before external write');
});

test('PG Journey E: request → manager approval → receipt → canonical stock → durable outbox → real Payment Engine refund/finance; duplicate, retry and tenant', async (t) => {
  const f = await fixture(); const provider = providerContract(t, f);
  const request = await invoke(exp.criarDevolucao, f, null, { venda_id: f.sale.id, motivo: 'Return all purchased units', idempotency_key: `return-${f.key}` });
  const dev = request.devolucao ?? request; const id = Number(dev.id);
  assert.ok(id);
  await assert.rejects(() => invoke(exp.autorizarDevolucao, f, id, {}, { ...f.actor, perfil: 'operador' as any }), (e: any) => e.status === 403);
  await invoke(exp.autorizarDevolucao, f, id, {});
  await invoke(exp.registrarRastreamento, f, id, { codigo_rastreamento: `RET-${f.key}` });
  const received = await Promise.allSettled([invoke(exp.receberDevolucao, f, id), invoke(exp.receberDevolucao, f, id)]);
  assert.equal(received.filter((r) => r.status === 'fulfilled').length, 1);
  const pending = (await db.query('SELECT * FROM devolucoes WHERE id=$1', [id])).rows[0];
  assert.equal(pending.refund_estado, 'PENDENTE'); assert.equal(Number(pending.refund_amount), 10000);
  assert.equal(provider.posts(), 0, 'receipt never makes network writes within stock transaction');
  await processarOutbox(100);
  await processarRefundDevolucao(f.company, id); // retry after delivery/ack loss
  assert.equal(provider.posts(), 1);
  const complete = (await db.query('SELECT refund_estado FROM devolucoes WHERE id=$1', [id])).rows[0]; assert.equal(complete.refund_estado, 'CONCLUIDO');
  const stock = (await db.query('SELECT sum(quantidade) n FROM estoques WHERE empresa_id=$1 AND produto_id=$2', [f.company, f.product.id])).rows[0]; assert.equal(Number(stock.n), 2);
  const effects = (await db.query("SELECT count(*)::int n,sum(valor) v FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='estorno'", [f.company])).rows[0]; assert.equal(effects.n, 1); assert.equal(Number(effects.v), 100);
  await assert.rejects(() => processarRefundDevolucao(1, id), (e: any) => e.status === 409);
  assert.equal((await s.get(R_INTENTS, Number(f.intent.id)))?.status, 'REFUNDED');
  assert.equal((await s.findOneWhere(R_SETTLEMENTS, { empresa_id: f.company, payment_intent_id: Number(f.intent.id) }))?.refund_amount, '10000');
});

test('PG chargeback: proven loss posts exactly one canonical expense and bounds later refunds', async () => {
  const f = await fixture();
  const { registerDispute, transitionDispute } = await import('../../../modules/payments/application/disputes');
  const d = await invoke(registerDispute, f, null, { payment_intent_id: Number(f.intent.id), provider_reference: f.key,
    external_dispute_id: `cb-${f.key}`, reason: 'Confirmed provider dispute report', amount: 3000 });
  const body = { status: 'LOST', expected_version: 0, note: 'Provider report confirms debit', confirm_external: true, external_reference: `loss-${f.key}` };
  const lose = async () => { const r = resFake(); const req = reqDe(body, { params: { id: d.dispute.id }, user: f.actor }); req.get = () => `loss-${f.key}`; await transitionDispute(req, r.res); return r.saida.json; };
  await Promise.all([lose(), lose()]);
  const effects = (await db.query("SELECT count(*)::int n,sum(valor) v FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='chargeback_dispute'", [f.company])).rows[0];
  assert.equal(effects.n, 1); assert.equal(Number(effects.v), 30);
  const settlement = await s.findOneWhere(R_SETTLEMENTS, { empresa_id: f.company, payment_intent_id: Number(f.intent.id) });
  assert.equal(Number(settlement?.chargeback_amount), 3000); assert.equal(settlement?.dispute_review_required, false);
  await assert.rejects(() => paymentEngine.mutate(f.company, Number(f.intent.id), 'refund', `over-refund-${f.key}`, 8000), (e: any) => e.status === 409);
  const report = await invoke(importPayout, f, null, { provider: 'MERCADO_PAGO', currency: 'BRL', payout_reference: `loss-payout-${f.key}`, settlement_date: date, net_amount: 7000,
    transactions: [{ provider_reference: f.key, gross_amount: 10000, provider_fee: 0, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 3000, net_amount: 7000 }] });
  const bank = (await db.query("INSERT INTO fin_extrato_transacoes(empresa_id,conta_id,linha_hash,data,valor,direcao,status) VALUES($1,$2,$3,$4,70,'entrada','importada') RETURNING id", [f.company, f.account, f.key, date])).rows[0];
  await invoke(matchPayout, f, report.payout.id, { bank_transaction_id: bank.id });
  assert.equal((await db.query('SELECT fin_repasse_comprovado($1,$2) ok', [f.company, report.payout.id])).rows[0].ok, true);

});

test('PG capture delivery racing refund never loses the gross receipt or duplicates the reversal', async () => {
  const f = await fixture();
  // Simulate a committed capture whose asynchronous financial delivery has not
  // completed yet, then race delivery with the provider reversal fact.
  await db.query("UPDATE lancamentos_financeiros SET status='pendente',data_baixa=NULL WHERE id=$1", [f.title.id]);
  await Promise.all([
    paymentEngine.deliverToCommerce(f.company, Number(f.intent.id)),
    paymentEngine.apply(f.company, Number(f.intent.id), { reference: f.key, amount: 10000, currency: 'BRL', status: 'PARTIALLY_REFUNDED', refunded: 5000 }),
  ]);
  const rows = (await db.query("SELECT referencia_tipo,status,valor FROM lancamentos_financeiros WHERE empresa_id=$1", [f.company])).rows;
  assert.equal(rows.filter((r) => r.referencia_tipo === 'venda' && r.status === 'confirmado').length, 1);
  assert.equal(rows.filter((r) => r.referencia_tipo === 'estorno').length, 1);
  assert.equal(Number(rows.find((r) => r.referencia_tipo === 'estorno')?.valor), 50);
});


test('PG fulfillment: duplicated SKU lines require aggregate canonical stock proof', async () => {
  const f = await fixture();
  const line = (await db.query('SELECT * FROM itens_venda WHERE venda_id=$1', [f.sale.id])).rows[0];
  await db.query('INSERT INTO itens_venda(empresa_id,venda_id,produto_id,tamanho_id,quantidade,preco_unitario) VALUES($1,$2,$3,$4,2,50)', [f.company, f.sale.id, line.produto_id, line.tamanho_id]);
  // Original canonical output is two, while duplicated demand is four.
  await assert.rejects(() => invoke(exp.separarPedido, f, f.sale.id), (e: any) => e.status === 409);
  assert.equal((await db.query('SELECT expedicao_etapa FROM vendas WHERE id=$1', [f.sale.id])).rows[0].expedicao_etapa, null);
});
