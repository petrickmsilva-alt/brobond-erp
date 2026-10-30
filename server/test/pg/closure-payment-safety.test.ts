import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('Payment safety requires PostgreSQL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate();
assert.ok(pool); const q = pool;
const { getStore } = await import('../../src/services');
const { cifrarSegredo } = await import('../../src/segredos');
const { R_GATEWAY_CONFIGS } = await import('../../src/gateway');
const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
const { providerRegistry } = await import('../../../modules/payments/providers/registry');
const { importPayout, correctPayout, matchPayout } = await import('../../../modules/payments/application/payouts');
const s = getStore();
function response() { let body: any, status = 200; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} }; return { out, get: () => ({ body, status }) }; }
const request = (body: object, params: object, actor: any, key = 'closure-payment-key') => ({ body, params, user: actor, query: {}, get: () => key } as any);
async function company() {
  const suffix = randomUUID();
  const id = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`Payment safety ${suffix}`])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Payment safety',$1,'admin',true,$2) RETURNING id", [`safety-${suffix}@example.invalid`, id])).rows[0].id);
  await s.insert(R_GATEWAY_CONFIGS, { empresa_id: id, provider: 'mercadopago', ativo: true, ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: 'fixture-only' })), webhook_segredo_cifrado: cifrarSegredo('fixture-only') });
  return { id, actor: { id: user, name: 'Payment safety', perfil: 'admin', empresa_id: id, empresas: [id] } };
}
async function intent(companyId: number) {
  const ref = `safety-${randomUUID()}`;
  const order = Number((await q.query("INSERT INTO commerce_pedidos(empresa_id,canal,pedido_externo) VALUES($1,'BROBOND',$2) RETURNING id", [companyId, ref])).rows[0].id);
  const id = Number((await q.query(`INSERT INTO payment_intents(empresa_id,order_id,channel,currency,amount,method,provider,status,idempotency_key,correlation_id)
    VALUES($1,$2,'OWN_STORE','BRL',10000,'PIX','MERCADO_PAGO','PAID',$3,$3) RETURNING id`, [companyId, order, ref])).rows[0].id);
  await q.query(`INSERT INTO payment_attempts(empresa_id,payment_intent_id,provider,provider_transaction_id,method,requested_amount,authorized_amount,captured_amount,refunded_amount,status,idempotency_key,correlation_id)
    VALUES($1,$2,'MERCADO_PAGO',$3,'PIX',10000,10000,10000,0,'PAID',$3,$3)`, [companyId, id, ref]);
  return { id, ref };
}

test('PG refund: ID específico não pode ser atribuído duas vezes na mesma empresa; tenant e replay', async (t) => {
  const a = await company(), b = await company(); const first = await intent(a.id), second = await intent(a.id), other = await intent(b.id);
  const p = providerRegistry.get('MERCADO_PAGO'); let writes = 0;
  t.mock.method(p, 'refund', async (_ctx, ref, amount) => { writes++; return { reference: ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: amount,
    refundEvidence: { reference: 'same-provider-refund', paymentReference: ref, amount, status: 'SUCCEEDED' as const } }; });
  t.mock.method(p, 'getPayment', async (_ctx, ref) => ({ reference: ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: 3000 }));
  await paymentEngine.mutate(a.id, first.id, 'refund', 'proof-first', 3000);
  await paymentEngine.mutate(a.id, first.id, 'refund', 'proof-first', 3000);
  await assert.rejects(() => paymentEngine.mutate(a.id, second.id, 'refund', 'proof-second', 3000), (e: any) => e.status === 409);
  await paymentEngine.synchronize(a.id, second.id);
  await paymentEngine.mutate(b.id, other.id, 'refund', 'proof-other', 3000);
  assert.equal(writes, 3, 'replay e consulta não emitem novo refund');
  const rows = (await q.query(`SELECT empresa_id,payment_intent_id,status,provider_refund_id,provider_refund_status FROM payment_refunds WHERE payment_intent_id=ANY($1::bigint[])`, [[first.id, second.id, other.id]])).rows;
  assert.equal(rows.find((r: any) => Number(r.payment_intent_id) === first.id).status, 'COMPLETED');
  const uncertain = rows.find((r: any) => Number(r.payment_intent_id) === second.id);
  assert.equal(uncertain.status, 'UNCERTAIN'); assert.equal(uncertain.provider_refund_id, null);
  assert.equal(rows.find((r: any) => Number(r.payment_intent_id) === other.id).status, 'COMPLETED');
  await assert.rejects(() => paymentEngine.intent(b.id, first.id), (e: any) => e.status === 404);
  await assert.rejects(() => q.query(`UPDATE payment_refunds SET provider='MERCADO_PAGO', provider_refund_id='same-provider-refund', provider_refund_status='SUCCEEDED' WHERE payment_intent_id=$1`, [second.id]), (e: any) => e.code === '23505');
  await assert.rejects(() => q.query(`UPDATE payment_refunds SET provider='STRIPE', provider_refund_id='unique-ref', provider_refund_status='SUCCEEDED' WHERE payment_intent_id=$1`, [second.id]), (e: any) => e.code === '23503');
  await assert.rejects(() => q.query(`UPDATE payment_refunds SET provider='MERCADO_PAGO', provider_refund_id='unique-ref', provider_refund_status=NULL WHERE payment_intent_id=$1`, [second.id]), (e: any) => e.code === '23514');
});

test('PG refund: ausência, valor ou identidade divergente nunca viram prova pelo total acumulado', async (t) => {
  const a = await company(); const p = providerRegistry.get('MERCADO_PAGO'); let writes = 0, variant = 0;
  t.mock.method(p, 'refund', async (_ctx, ref, amount) => { writes++; const evidence = [undefined,
    { reference: 'bad-value', paymentReference: ref, amount: amount - 1, status: 'SUCCEEDED' as const },
    { reference: 'bad-payment', paymentReference: 'other', amount, status: 'SUCCEEDED' as const },
    { reference: '', paymentReference: ref, amount, status: 'SUCCEEDED' as const }][variant];
    return { reference: ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: amount, refundEvidence: evidence }; });
  t.mock.method(p, 'getPayment', async (_ctx, ref) => ({ reference: ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: 3000 }));
  for (variant = 0; variant < 4; variant++) {
    const f = await intent(a.id);
    await assert.rejects(() => paymentEngine.mutate(a.id, f.id, 'refund', `bad-proof-${variant}`, 3000), (e: any) => e.status === 409);
    await paymentEngine.synchronize(a.id, f.id); await paymentEngine.synchronize(a.id, f.id);
    const row = (await q.query('SELECT r.status,r.provider_refund_id,o.status AS op_status FROM payment_refunds r JOIN payment_operations o ON o.id=r.operation_id WHERE r.payment_intent_id=$1', [f.id])).rows[0];
    assert.equal(row.status, 'UNCERTAIN'); assert.equal(row.op_status, 'UNCERTAIN'); assert.equal(row.provider_refund_id, null);
  }
  assert.equal(writes, 4);
});

test('PG chargeback sem valor: não fabrica perda integral, bloqueia importação/correção e conciliação', async () => {
  const a = await company(), f = await intent(a.id);
  await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
  await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'CHARGEBACK', amount: 10000, currency: 'BRL', refunded: 0 });
  const d = (await q.query('SELECT amount,amount_source,status FROM payment_disputes WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0];
  assert.equal(d.amount, null); assert.equal(d.amount_source, 'UNKNOWN'); assert.equal(d.status, 'DISPUTE_OPENED');
  const st = (await q.query('SELECT chargeback_amount,status,dispute_review_required FROM payment_settlements WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0];
  assert.equal(Number(st.chargeback_amount), 0, 'não altera valor anteriormente registrado'); assert.equal(st.status, 'DIVERGENT'); assert.equal(st.dispute_review_required, true);
  const report = { provider: 'MERCADO_PAGO', payout_reference: `payout-${f.ref}`, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 10000,
    transactions: [{ provider_reference: f.ref, gross_amount: 10000, provider_fee: 0, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 10000 }] };
  const r = response(); await importPayout(request(report, {}, a.actor), r.out); const payout = r.get().body.payout;
  assert.equal(payout.status, 'DIVERGENT');
  const bank = Number((await q.query("INSERT INTO fin_extrato_transacoes(empresa_id,linha_hash,valor,direcao,status) VALUES($1,$2,100,'entrada','importada') RETURNING id", [a.id, f.ref])).rows[0].id);
  await assert.rejects(() => matchPayout(request({ bank_transaction_id: bank }, { id: payout.id }, a.actor), response().out), (e: any) => e.status === 409);
  const revised = { ...report, net_amount: 9900, transactions: [{ ...report.transactions[0], provider_fee: 100, net_amount: 9900 }] };
  const cr = response(); await correctPayout(request({ expected_hash: payout.content_hash, reason: 'Taxa informada incorretamente', report: revised }, { id: payout.id }, a.actor), cr.out);
  assert.equal(cr.get().body.payout.status, 'DIVERGENT');
  await assert.rejects(() => matchPayout(request({ bank_transaction_id: bank }, { id: payout.id }, a.actor), response().out), (e: any) => e.status === 409);
});

test('PG refund pendente: consultas concorrentes promovem prova específica uma vez e não repetem POST', async (t) => {
  const a = await company(), f = await intent(a.id), p = providerRegistry.get('MERCADO_PAGO'); let writes = 0, ready = false, reads = 0;
  const proof = () => ({ reference: `pending-${f.ref}`, paymentReference: f.ref, amount: 2500, status: ready ? 'SUCCEEDED' as const : 'PENDING' as const });
  t.mock.method(p, 'refund', async () => { writes++; return { reference: f.ref, status: 'PAID' as const, amount: 10000, currency: 'BRL', refunded: 0, refundEvidence: proof() }; });
  t.mock.method(p, 'getPayment', async () => ready
    ? { reference: f.ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: 2500 }
    : { reference: f.ref, status: 'PAID' as const, amount: 10000, currency: 'BRL', refunded: 0 });
  t.mock.method(p, 'getRefund', async (_ctx, ref, refund) => { assert.equal(ref, f.ref); assert.equal(refund, `pending-${f.ref}`); reads++; return proof(); });
  await assert.rejects(() => paymentEngine.mutate(a.id, f.id, 'refund', 'pending-evidence-key', 2500), (e: any) => e.status === 409);
  await paymentEngine.synchronize(a.id, f.id);
  let row = (await q.query('SELECT status,provider_refund_status FROM payment_refunds WHERE payment_intent_id=$1', [f.id])).rows[0];
  assert.equal(row.status, 'UNCERTAIN'); assert.equal(row.provider_refund_status, 'PENDING');
  ready = true;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => paymentEngine.synchronize(a.id, f.id)));
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  for (const r of results) if (r.status === 'rejected') assert.ok(r.reason.status === 409 || r.reason.code === '40001');
  row = (await q.query('SELECT status,provider_refund_status FROM payment_refunds WHERE payment_intent_id=$1', [f.id])).rows[0];
  assert.equal(row.status, 'COMPLETED'); assert.equal(row.provider_refund_status, 'SUCCEEDED');
  const i = await paymentEngine.intent(a.id, f.id); assert.equal(i.active_operation, null);
  await paymentEngine.mutate(a.id, f.id, 'refund', 'pending-evidence-key', 2500);
  assert.equal(writes, 1); assert.ok(reads >= 2);
});

test('PG refund: conclusão atrasada não libera claim de operação mais nova', async (t) => {
  const a = await company(), f = await intent(a.id), p = providerRegistry.get('MERCADO_PAGO');
  const proof = { reference: `stale-${f.ref}`, paymentReference: f.ref, amount: 2000, status: 'PENDING' as const };
  t.mock.method(p, 'refund', async () => ({ reference: f.ref, status: 'PAID' as const, amount: 10000, currency: 'BRL', refunded: 0, refundEvidence: proof }));
  t.mock.method(p, 'getPayment', async () => ({ reference: f.ref, status: 'PAID' as const, amount: 10000, currency: 'BRL', refunded: 0 }));
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
  t.mock.method(p, 'getRefund', async () => { entered(); await gate; return { ...proof, status: 'SUCCEEDED' as const }; });
  await assert.rejects(() => paymentEngine.mutate(a.id, f.id, 'refund', 'stale-first-operation', 2000), (e: any) => e.status === 409);
  const old = (await q.query('SELECT id FROM payment_operations WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0].id;
  const sync = paymentEngine.synchronize(a.id, f.id); await waiting;
  // Interleaving of a completed older operation and a new claim while its
  // provider read was in flight. No external write is performed here.
  await q.query("UPDATE payment_operations SET status='SUCCEEDED' WHERE id=$1", [old]);
  const newer = (await q.query(`INSERT INTO payment_operations(empresa_id,payment_intent_id,operation,idempotency_key,request_hash,status,amount)
    VALUES($1,$2,'cancel',$3,$4,'PROCESSING',10000) RETURNING id`, [a.id, f.id, `new-${f.ref}`, 'b'.repeat(64)])).rows[0].id;
  await q.query('UPDATE payment_intents SET active_operation=$1 WHERE empresa_id=$2 AND id=$3', [newer, a.id, f.id]);
  release(); await sync;
  assert.equal(Number((await paymentEngine.intent(a.id, f.id)).active_operation), Number(newer));
  assert.equal((await q.query('SELECT status FROM payment_operations WHERE id=$1', [newer])).rows[0].status, 'PROCESSING');
});

test('PG refund concorrente: claim e replay não duplicam chamada ao provider', async (t) => {
  const a = await company(), f = await intent(a.id), p = providerRegistry.get('MERCADO_PAGO'); let writes = 0;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
  t.mock.method(p, 'refund', async (_ctx, ref, amount) => { writes++; entered(); await gate; return { reference: ref, status: 'PARTIALLY_REFUNDED' as const, amount: 10000, currency: 'BRL', refunded: amount,
    refundEvidence: { reference: `concurrent-${ref}`, paymentReference: ref, amount, status: 'SUCCEEDED' as const } }; });
  const first = paymentEngine.mutate(a.id, f.id, 'refund', 'concurrent-refund-key', 3000); await waiting;
  const losers = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => paymentEngine.mutate(a.id, f.id, 'refund', n < 4 ? 'concurrent-refund-key' : `another-key-${n}`, 3000)));
  assert.ok(losers.every((r) => r.status === 'rejected' && r.reason.status === 409));
  release(); await first;
  await Promise.all(Array.from({ length: 3 }, () => paymentEngine.mutate(a.id, f.id, 'refund', 'concurrent-refund-key', 3000)));
  assert.equal(writes, 1);
  const counts = await q.query('SELECT count(*)::int AS n FROM payment_operations WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id]);
  assert.equal(counts.rows[0].n, 1);
});

test('PG refund: três processos disputam a mesma operação e emitem um único write externo', { timeout: 60000 }, async () => {
  const { fork } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const a = await company(), f = await intent(a.id);
  const worker = fileURLToPath(new URL('./_refund-worker.ts', import.meta.url));
  const children = Array.from({ length: 3 }, () => fork(worker, [], { execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, CLOSURE_REFUND_FIXTURE: JSON.stringify({ company: a.id, intent: f.id }), PG_IDLE_TIMEOUT: '1000' } }));
  try {
    const outcomes = await new Promise<{ writes: number; results: any[] }>((resolve, reject) => {
      let ready = 0, writes = 0, released = false; const results: any[] = []; let writer: typeof children[number] | null = null;
      const timer = setTimeout(() => reject(new Error('Timeout na disputa entre processos')), 30000);
      const maybeRelease = () => { if (!released && writer && results.length === 2) { released = true; writer.send('release'); } };
      children.forEach((child) => {
        child.once('error', reject); child.once('exit', (code) => { if (code) reject(new Error(`Worker encerrou com ${code}`)); });
        child.on('message', (m: any) => {
          if (m.type === 'ready' && ++ready === children.length) children.forEach((c) => c.send('go'));
          if (m.type === 'write') { writes++; writer = child; maybeRelease(); }
          if (m.type === 'result') { results.push(m); maybeRelease(); if (results.length === 3) { clearTimeout(timer); resolve({ writes, results }); } }
        });
      });
    });
    assert.equal(outcomes.writes, 1); assert.equal(outcomes.results.filter((r) => r.ok).length, 1);
    assert.ok(outcomes.results.filter((r) => !r.ok).every((r) => r.status === 409));
    const row = (await q.query(`SELECT o.status,r.status AS refund_status,r.provider_refund_status
      FROM payment_operations o JOIN payment_refunds r ON r.operation_id=o.id WHERE o.empresa_id=$1 AND o.payment_intent_id=$2`, [a.id, f.id])).rows;
    assert.equal(row.length, 1); assert.equal(row[0].status, 'SUCCEEDED'); assert.equal(row[0].refund_status, 'COMPLETED');
    assert.equal(row[0].provider_refund_status, 'SUCCEEDED');
  } finally { children.forEach((c) => { if (c.connected) c.disconnect(); if (!c.killed) c.kill(); }); }
});

test('PG disputa posterior ao MATCHED invalida repasse preservando vínculo bancário histórico', async () => {
  const a = await company(), f = await intent(a.id);
  await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
  const report = { provider: 'MERCADO_PAGO', payout_reference: `matched-${f.ref}`, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 9800,
    transactions: [{ provider_reference: f.ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
  const imported = response(); await importPayout(request(report, {}, a.actor), imported.out); const payout = imported.get().body.payout;
  const bank = Number((await q.query("INSERT INTO fin_extrato_transacoes(empresa_id,linha_hash,valor,direcao,status) VALUES($1,$2,98,'entrada','importada') RETURNING id", [a.id, f.ref])).rows[0].id);
  await matchPayout(request({ bank_transaction_id: bank }, { id: payout.id }, a.actor), response().out);
  await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'DISPUTED', amount: 10000, currency: 'BRL', refunded: 0 });
  const row = (await q.query('SELECT p.status,p.bank_transaction_id,s.status AS settlement_status,s.dispute_review_required FROM payment_payouts p JOIN payment_settlements s ON s.payout_id=p.id WHERE p.id=$1', [payout.id])).rows[0];
  assert.equal(row.status, 'DIVERGENT'); assert.equal(Number(row.bank_transaction_id), bank);
  assert.equal(row.settlement_status, 'DIVERGENT'); assert.equal(row.dispute_review_required, true);
  await assert.rejects(() => matchPayout(request({ bank_transaction_id: bank }, { id: payout.id }, a.actor), response().out), (e: any) => e.status === 409);
});

test('PG disputa em corrida com importação nunca deixa repasse conciliável', async () => {
  const a = await company();
  for (let n = 0; n < 6; n++) {
    const f = await intent(a.id);
    await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
    const report = { provider: 'MERCADO_PAGO', payout_reference: `race-${f.ref}`, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 9800,
      transactions: [{ provider_reference: f.ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
    const [imported, disputed] = await Promise.allSettled([
      importPayout(request(report, {}, a.actor), response().out),
      paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'DISPUTED', amount: 10000, currency: 'BRL', refunded: 0 }),
    ]);
    if (imported.status === 'rejected') assert.ok(imported.reason.status === 409 || imported.reason.code === '40001');
    if (disputed.status === 'rejected') {
      assert.equal(disputed.reason.code, '40001');
      await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'DISPUTED', amount: 10000, currency: 'BRL', refunded: 0 });
    }
    const row = (await q.query(`SELECT s.status,s.dispute_review_required,p.status AS payout_status FROM payment_settlements s LEFT JOIN payment_payouts p ON p.id=s.payout_id
      WHERE s.empresa_id=$1 AND s.payment_intent_id=$2`, [a.id, f.id])).rows[0];
    assert.equal(row.status, 'DIVERGENT'); assert.equal(row.dispute_review_required, true);
    if (row.payout_status) assert.equal(row.payout_status, 'DIVERGENT');
  }
});

test('PG disputa manual bloqueia repasse conciliado sem alterar valores ou livro financeiro', async () => {
  const { registerDispute } = await import('../../../modules/payments/application/disputes');
  const a = await company(), f = await intent(a.id);
  await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
  const report = { provider: 'MERCADO_PAGO', payout_reference: `manual-${f.ref}`, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 9800,
    transactions: [{ provider_reference: f.ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
  const imported = response(); await importPayout(request(report, {}, a.actor), imported.out); const payout = imported.get().body.payout;
  const bank = Number((await q.query("INSERT INTO fin_extrato_transacoes(empresa_id,linha_hash,valor,direcao,status) VALUES($1,$2,98,'entrada','importada') RETURNING id", [a.id, f.ref])).rows[0].id);
  await matchPayout(request({ bank_transaction_id: bank }, { id: payout.id }, a.actor), response().out);
  const data = { payment_intent_id: f.id, provider_reference: f.ref, external_dispute_id: `external-${f.ref}`, amount: 2700, reason: 'Valor relatado para revisão' };
  const registered = response(); await registerDispute(request(data, {}, a.actor, `manual-${f.ref}`), registered.out);
  assert.equal(registered.get().body.dispute.amount_source, 'MANUAL_REPORTED');
  const replay = response(); await registerDispute(request(data, {}, a.actor, `manual-${f.ref}`), replay.out); assert.equal(replay.get().body.idempotente, true);
  const row = (await q.query(`SELECT p.status,p.bank_transaction_id,s.status AS settlement_status,s.dispute_review_required,s.chargeback_amount,i.status AS intent_status
    FROM payment_payouts p JOIN payment_settlements s ON s.payout_id=p.id JOIN payment_intents i ON i.id=s.payment_intent_id WHERE p.id=$1`, [payout.id])).rows[0];
  assert.equal(row.status, 'DIVERGENT'); assert.equal(Number(row.bank_transaction_id), bank);
  assert.equal(row.settlement_status, 'DIVERGENT'); assert.equal(row.dispute_review_required, true); assert.equal(Number(row.chargeback_amount), 0);
  assert.equal(row.intent_status, 'PAID');
  await assert.rejects(() => matchPayout(request({ bank_transaction_id: bank }, { id: payout.id }, a.actor), response().out), (e: any) => e.status === 409);
  const bankRow = (await q.query('SELECT status,lancamento_id FROM fin_extrato_transacoes WHERE id=$1', [bank])).rows[0];
  assert.equal(bankRow.status, 'importada'); assert.equal(bankRow.lancamento_id, null);
});

test('PG disputa manual anterior ao settlement bloqueia criação posterior', async () => {
  const { registerDispute } = await import('../../../modules/payments/application/disputes');
  const a = await company();
  for (let n = 0; n < 4; n++) {
    const f = await intent(a.id);
    const data = { payment_intent_id: f.id, provider_reference: f.ref, external_dispute_id: `manual-${f.ref}`, amount: 2000, reason: 'Disputa informada por operador' };
    await registerDispute(request(data, {}, a.actor, `register-${f.ref}`), response().out);
    await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
    const settlement = (await q.query('SELECT status,dispute_review_required FROM payment_settlements WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0];
    assert.equal(settlement.status, 'DIVERGENT'); assert.equal(settlement.dispute_review_required, true);
  }
});

test('PG disputa manual e importação simultâneas não deixam repasse conciliável', async () => {
  const { registerDispute } = await import('../../../modules/payments/application/disputes');
  const a = await company();
  for (let n = 0; n < 6; n++) {
    const f = await intent(a.id);
    await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
    const data = { payment_intent_id: f.id, provider_reference: f.ref, external_dispute_id: `concurrent-${f.ref}`, amount: 2000, reason: 'Disputa informada por operador' };
    const report = { provider: 'MERCADO_PAGO', payout_reference: `concurrent-${f.ref}`, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 9800,
      transactions: [{ provider_reference: f.ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
    await Promise.all([registerDispute(request(data, {}, a.actor, `race-${f.ref}`), response().out), importPayout(request(report, {}, a.actor), response().out)]);
    const row = (await q.query('SELECT s.status,s.dispute_review_required,p.status AS payout_status FROM payment_settlements s JOIN payment_payouts p ON p.id=s.payout_id WHERE s.empresa_id=$1 AND s.payment_intent_id=$2', [a.id, f.id])).rows[0];
    assert.equal(row.status, 'DIVERGENT'); assert.equal(row.dispute_review_required, true); assert.equal(row.payout_status, 'DIVERGENT');
  }
});

test('PG disputa manual com snapshot atrasado em outro processo não deixa settlement conciliável', { timeout: 60000 }, async () => {
  const { registerDispute } = await import('../../../modules/payments/application/disputes');
  const { fork } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const a = await company(), f = await intent(a.id);
  const worker = fork(fileURLToPath(new URL('./_apply-payment-worker.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, CLOSURE_APPLY_FIXTURE: JSON.stringify({ company: a.id, intent: f.id, ref: f.ref }), PG_IDLE_TIMEOUT: '1000' } });
  const message = (type: string) => new Promise<any>((resolve, reject) => {
    const handler = (m: any) => { if (m?.type === type) { worker.off('message', handler); resolve(m); } };
    worker.on('message', handler); worker.once('error', reject); worker.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); });
  });
  const data = { payment_intent_id: f.id, provider_reference: f.ref, external_dispute_id: `snapshot-${f.ref}`, amount: 2000, reason: 'Disputa informada por operador' };
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
  const original = s.insert.bind(s); let trapped = false;
  s.insert = async (resource, value, tx) => {
    const row = await original(resource, value, tx);
    if (!trapped && resource.key === 'payment_disputes' && Number(value.payment_intent_id) === f.id) { trapped = true; entered(); await gate; }
    return row;
  };
  try {
    await message('ready');
    const registration = registerDispute(request(data, {}, a.actor, `snapshot-${f.ref}`), response().out); await waiting;
    const applying = message('applying'), result = message('result'); worker.send('go'); await applying;
    await new Promise((resolve) => setTimeout(resolve, 150)); release();
    await registration; const outcome = await result; assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const row = (await q.query('SELECT status,dispute_review_required FROM payment_settlements WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0];
    assert.equal(row.status, 'DIVERGENT'); assert.equal(row.dispute_review_required, true);
  } finally { release(); s.insert = original; if (worker.connected) worker.disconnect(); if (!worker.killed) worker.kill(); }
});

test('PG settlement em andamento e disputa manual atrasada serializam sem falso MATCHED', { timeout: 60000 }, async () => {
  const { registerDispute } = await import('../../../modules/payments/application/disputes');
  const { fork } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const a = await company(), f = await intent(a.id);
  const worker = fork(fileURLToPath(new URL('./_apply-payment-worker.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, CLOSURE_APPLY_FIXTURE: JSON.stringify({ company: a.id, intent: f.id, ref: f.ref, pauseSettlement: true }), PG_IDLE_TIMEOUT: '1000' } });
  const message = (type: string) => new Promise<any>((resolve, reject) => {
    const handler = (m: any) => { if (m?.type === type) { worker.off('message', handler); resolve(m); } };
    worker.on('message', handler); worker.once('error', reject); worker.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); });
  });
  try {
    await message('ready'); const inserted = message('settlement-inserted'), result = message('result'); worker.send('go'); await inserted;
    const data = { payment_intent_id: f.id, provider_reference: f.ref, external_dispute_id: `reverse-${f.ref}`, amount: 2000, reason: 'Disputa informada por operador' };
    const registration = registerDispute(request(data, {}, a.actor, `reverse-${f.ref}`), response().out);
    await new Promise((resolve) => setTimeout(resolve, 150)); worker.send('release');
    assert.equal((await result).ok, true); await registration;
    const row = (await q.query('SELECT status,dispute_review_required FROM payment_settlements WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0];
    assert.equal(row.status, 'DIVERGENT'); assert.equal(row.dispute_review_required, true);
  } finally { if (worker.connected) worker.disconnect(); if (!worker.killed) worker.kill(); }
});

test('PG refund histórico concluído sem evidência não é confirmado nem repetido no replay', async (t) => {
  const { createHash } = await import('node:crypto'); const a = await company(), f = await intent(a.id);
  const hash = createHash('sha256').update('refund:3000').digest('hex');
  const op = (await q.query(`INSERT INTO payment_operations(empresa_id,payment_intent_id,operation,idempotency_key,request_hash,status,amount,result)
    VALUES($1,$2,'refund','legacy-done-key',$3,'SUCCEEDED',3000,'{"status":"PARTIALLY_REFUNDED"}') RETURNING id`, [a.id, f.id, hash])).rows[0].id;
  await q.query("INSERT INTO payment_refunds(empresa_id,payment_intent_id,operation_id,amount,status) VALUES($1,$2,$3,3000,'COMPLETED')", [a.id, f.id, op]);
  let writes = 0; const p = providerRegistry.get('MERCADO_PAGO');
  t.mock.method(p, 'refund', async () => { writes++; throw new Error('nunca deve ser chamado'); });
  await assert.rejects(() => paymentEngine.mutate(a.id, f.id, 'refund', 'legacy-done-key', 3000), (e: any) => e.status === 409 && /histórico sem prova/.test(e.message));
  assert.equal(writes, 0);
  const row = (await q.query('SELECT status,provider_refund_id FROM payment_refunds WHERE operation_id=$1', [op])).rows[0];
  assert.equal(row.status, 'COMPLETED'); assert.equal(row.provider_refund_id, null, 'preserva o legado sem inventar prova');
});

test('PG período: refund do Payment Engine sem data não chama provider depois de um fechamento', async (t) => {
  const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const a = await company(), f = await intent(a.id); const p = providerRegistry.get('MERCADO_PAGO'); let writes = 0;
  t.mock.method(p, 'refund', async () => { writes++; throw new Error('não deveria alcançar o provider'); });
  await alterarPeriodo(request({ motivo: 'Fechamento financeiro validado' }, { competencia: '2039-02', acao: 'fechar' }, a.actor), response().out);
  await assert.rejects(() => paymentEngine.mutate(a.id, f.id, 'refund', 'closed-undated-refund', 1000), (e: any) => e.status === 409 || e.code === 'P2001');
  assert.equal(writes, 0);
  assert.equal(Number((await q.query('SELECT count(*) FROM payment_operations WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0].count), 0);
});

test('PG período: repasse simples só é aceito com baixa canônica comprovada; disputa e refund posteriores são bloqueados', async (t) => {
  const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const a = await company(), f = await intent(a.id), p = providerRegistry.get('MERCADO_PAGO'); let writes = 0;
  t.mock.method(p, 'refund', async () => { writes++; throw new Error('não deveria alcançar o provider'); });
  const account = Number((await q.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [a.id, `Conta payout ${a.id}`])).rows[0].id);
  const sale = Number((await q.query("INSERT INTO vendas(empresa_id,data,status,total) VALUES($1,'2039-01-02','faturada',100) RETURNING id", [a.id])).rows[0].id);
  await q.query('UPDATE commerce_pedidos SET venda_id=$1 WHERE empresa_id=$2 AND id=(SELECT order_id FROM payment_intents WHERE id=$3)', [sale, a.id, f.id]);
  const title = Number((await q.query(`INSERT INTO lancamentos_financeiros(empresa_id,data,data_baixa,tipo,descricao,valor,valor_liquido,status,conta_id,referencia_tipo,referencia_id)
    VALUES($1,'2039-01-02','2039-01-02','receita','Título canônico de venda',100,100,'confirmado',$2,'venda',$3) RETURNING id`, [a.id, account, sale])).rows[0].id);
  const charge = Number((await q.query(`INSERT INTO gateway_cobrancas(empresa_id,provider,metodo,venda_id,lancamento_id,conta_id,valor,valor_liquido,status,provider_ref)
    VALUES($1,'mercadopago','pix',$2,$3,$4,100,100,'paga',$5) RETURNING id`, [a.id, sale, title, account, f.ref])).rows[0].id);
  await q.query('UPDATE payment_intents SET cobranca_id=$1 WHERE empresa_id=$2 AND id=$3', [charge, a.id, f.id]);
  await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
  const report = { provider: 'MERCADO_PAGO', payout_reference: `payout-close-${f.ref}`, currency: 'BRL', settlement_date: '2039-01-02', net_amount: 10000,
    transactions: [{ provider_reference: f.ref, gross_amount: 10000, provider_fee: 0, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 10000 }] };
  const imported = response(); await importPayout(request(report, {}, a.actor), imported.out); const payout = imported.get().body.payout;
  const bank = Number((await q.query(`INSERT INTO fin_extrato_transacoes(empresa_id,conta_id,linha_hash,data,valor,direcao,status)
    VALUES($1,$2,$3,'2039-01-02',100,'entrada','importada') RETURNING id`, [a.id, account, f.ref])).rows[0].id);
  await matchPayout(request({ bank_transaction_id: bank }, { id: payout.id }, a.actor), response().out);
  const close = response(); await alterarPeriodo(request({ motivo: 'Fechamento financeiro validado' }, { competencia: '2039-01', acao: 'fechar' }, a.actor), close.out);
  assert.equal(close.get().body.periodo.estado, 'fechado');
  await assert.rejects(() => paymentEngine.mutate(a.id, f.id, 'refund', 'closed-proven-refund', 1000), (e: any) => e.status === 409 || e.code === 'P2001');
  await assert.rejects(() => paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'DISPUTED', amount: 10000, currency: 'BRL', refunded: 0 }), (e: any) => e.status === 409 || e.code === 'P2001');
  await assert.rejects(() => q.query("UPDATE payment_payouts SET settlement_date='2039-03-01' WHERE empresa_id=$1 AND id=$2", [a.id, payout.id]), (e: any) => e.code === 'P2001');
  assert.equal(writes, 0); assert.equal((await paymentEngine.intent(a.id, f.id)).status, 'PAID');
});

test('PG período: intenção pendente bloqueia fechamento e intenção do mês fechado não muda', async () => {
  const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const a = await company(), f = await intent(a.id); const month = new Date().toISOString().slice(0, 7);
  await q.query("UPDATE payment_intents SET status='PENDING' WHERE empresa_id=$1 AND id=$2", [a.id, f.id]);
  await assert.rejects(() => alterarPeriodo(request({ motivo: 'Fechamento financeiro validado' }, { competencia: month, acao: 'fechar' }, a.actor), response().out),
    (e: any) => e.code === 'CLOSE_BLOCKED' && e.details.pendencias.operacoes === 1);
  await q.query("UPDATE payment_intents SET status='FAILED' WHERE empresa_id=$1 AND id=$2", [a.id, f.id]);
  await alterarPeriodo(request({ motivo: 'Fechamento financeiro validado' }, { competencia: month, acao: 'fechar' }, a.actor), response().out);
  await assert.rejects(() => q.query("UPDATE payment_intents SET status='PAID' WHERE empresa_id=$1 AND id=$2", [a.id, f.id]), (e: any) => e.code === 'P2001');
  assert.equal((await paymentEngine.intent(a.id, f.id)).status, 'FAILED');
});

test('PG revisão: disputa não pode ser resolvida por nota; tenant, RBAC e corrida preservam revisão', async () => {
  const express = (await import('express')).default; const supertest = (await import('supertest')).default;
  const { paymentsRouter } = await import('../../../modules/payments/api/routes');
  const { registerDispute } = await import('../../../modules/payments/application/disputes');
  const a = await company(), b = await company(), f = await intent(a.id);
  await paymentEngine.apply(a.id, f.id, { reference: f.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
  const settlement = (await q.query('SELECT id FROM payment_settlements WHERE empresa_id=$1 AND payment_intent_id=$2', [a.id, f.id])).rows[0];
  const app = express(); app.use(express.json()); app.use((req: any, _res: any, next: any) => {
    req.user = req.headers['x-test-actor'] === 'other' ? b.actor : req.headers['x-test-actor'] === 'operator' ? { ...a.actor, perfil: 'operador' } : a.actor; next();
  }); app.use(paymentsRouter); app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: 'request failed' }));
  const route = `/reconciliation/${settlement.id}/resolve`; const data = { status: 'RESOLVED', note: 'Revisão informada pelo operador' };
  await supertest(app).post(route).set('x-test-actor', 'operator').send(data).expect(403);
  await supertest(app).post(route).set('x-test-actor', 'other').send(data).expect(404);
  const dispute = { payment_intent_id: f.id, provider_reference: f.ref, external_dispute_id: `resolve-race-${f.ref}`, amount: 2000, reason: 'Disputa informada pelo operador' };
  const outcomes = await Promise.allSettled([
    supertest(app).post(route).send(data),
    registerDispute(request(dispute, {}, a.actor, `resolve-race-${f.ref}`), response().out),
  ]);
  if (outcomes[1].status === 'rejected') {
    assert.ok(outcomes[1].reason?.code === '40001' || outcomes[1].reason?.status === 409);
    await registerDispute(request(dispute, {}, a.actor, `resolve-race-${f.ref}`), response().out);
  }
  await supertest(app).post(route).send(data).expect(409);
  await supertest(app).post(route).send({ ...data, status: 'MATCHED' }).expect(409);
  const after = (await q.query('SELECT status,dispute_review_required FROM payment_settlements WHERE empresa_id=$1 AND id=$2', [a.id, settlement.id])).rows[0];
  assert.equal(after.status, 'DIVERGENT'); assert.equal(after.dispute_review_required, true);
});
