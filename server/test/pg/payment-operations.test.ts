import { test } from 'node:test';
import assert from 'node:assert/strict';
const skip = process.env.DATABASE_URL ? false : 'requer PostgreSQL real';
process.env.NODE_ENV = 'test';
const req = (body: object = {}, params: object = {}, key = 'postgres-key-01', user: any) => ({ body, params, user, query: {}, get: () => key } as any);
function res() { let body: any, status = 200; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} }; return { out, get: () => ({ body, status }) }; }
async function boot() { const db = await import('../../src/db'); await db.migrate(); assert.equal(db.isDbConnected(), true, String(db.bootFailure()?.mensagem)); return db; }
async function fixture(ref: string) {
  const { query } = await boot();
  const user = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('Operação PG',$1,'admin',1) RETURNING id", [`${ref}@test.invalid`])).rows[0];
  const order = (await query("INSERT INTO commerce_pedidos (empresa_id,canal,pedido_externo) VALUES (1,'BROBOND',$1) RETURNING id", [ref])).rows[0];
  const intent = (await query(`INSERT INTO payment_intents (empresa_id,order_id,channel,currency,amount,method,provider,status,idempotency_key,correlation_id)
    VALUES (1,$1,'OWN_STORE','BRL',10000,'PIX','PAGBANK','PAID',$2,$2) RETURNING id`, [order.id, ref])).rows[0];
  await query(`INSERT INTO payment_attempts (empresa_id,payment_intent_id,provider,provider_transaction_id,method,requested_amount,authorized_amount,captured_amount,refunded_amount,status,idempotency_key,correlation_id)
    VALUES (1,$1,'PAGBANK',$2,'PIX',10000,10000,10000,0,'PAID',$2,$2)`, [intent.id, ref]);
  await query("INSERT INTO payment_settlements (empresa_id,payment_intent_id,provider,provider_reference,gross_amount,status) VALUES (1,$1,'PAGBANK',$2,10000,'UNRECONCILED')", [intent.id, ref]);
  return { intent: Number(intent.id), actor: { id: Number(user.id), name: 'Operação PG', perfil: 'admin', empresa_id: 1, empresas: [1] } };
}

test('PG disputas: registro/evidência concorrentes, transições CAS e FK de empresa', { skip }, async () => {
  const { query } = await boot(); const { registerDispute, addDisputeEvidence, transitionDispute, disputeDetail } = await import('../../../modules/payments/application/disputes');
  const ref = `dispute-pg-${Date.now()}-${process.pid}`; const { intent, actor } = await fixture(ref);
  const data = { payment_intent_id: intent, provider_reference: ref, external_dispute_id: `external-${ref}`, reason: 'Razão informada no provedor', amount: 5000 };
  const registrations = await Promise.all(Array.from({ length: 5 }, async () => { const r = res(); await registerDispute(req(data, {}, 'pg-register-key', actor), r.out); return r.get(); }));
  assert.equal(registrations.filter((x) => x.status === 201).length, 1); assert.equal(new Set(registrations.map((x) => String(x.body.dispute.id))).size, 1);
  const disputeId = Number(registrations[0].body.dispute.id);
  const evidence = { kind: 'NOTE', description: 'Comprovante', content: 'Prova interna de teste' };
  const saved = await Promise.all(Array.from({ length: 5 }, async () => { const r = res(); await addDisputeEvidence(req(evidence, { id: disputeId }, 'pg-evidence-key', actor), r.out); return r.get(); }));
  assert.equal(saved.filter((x) => x.status === 201).length, 1);
  const transition = (status: string, key: string) => transitionDispute(req({ status, note: 'Mudança operacional confirmada', expected_version: 0 }, { id: disputeId }, key, actor), res().out);
  const results = await Promise.allSettled([transition('UNDER_REVIEW', 'pg-transition-1'), transition('EVIDENCE_REQUIRED', 'pg-transition-2')]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.ok(results.some((x) => x.status === 'rejected' && (x.reason.status === 409 || x.reason.code === '40001')));
  const d = res(); await disputeDetail(req({}, { id: disputeId }, '', actor), d.out);
  assert.equal(d.get().body.dispute.version, 1); assert.equal(d.get().body.evidence.total, 1); assert.equal(d.get().body.events.total, 2);
  const company = (await query('INSERT INTO empresas (nome,ativo) VALUES ($1,true) RETURNING id', [`PG empresa ${ref}`])).rows[0];
  await assert.rejects(() => query(`INSERT INTO payment_dispute_evidence (empresa_id,dispute_id,kind,description,content,idempotency_key,request_hash)
    VALUES ($1,$2,'NOTE','Prova','texto','wrong-company-key',$3)`, [company.id, disputeId, 'a'.repeat(64)]), (e: any) => e.code === '23503');
  await assert.rejects(() => disputeDetail(req({}, { id: disputeId }, '', { ...actor, empresa_id: Number(company.id), empresas: [Number(company.id)] }), res().out), (e: any) => e.status === 404);
});

test('PG pagamentos: correção de repasse, JSON preservado, desvinculação e extrato divergente', { skip }, async () => {
  const { query } = await boot(); const { importPayout, correctPayout, matchPayout, unlinkPayout, payoutDetail } = await import('../../../modules/payments/application/payouts');
  const { marcarDivergencia } = await import('../../src/extrato');
  const ref = `payout-correct-pg-${Date.now()}-${process.pid}`; const { actor } = await fixture(ref);
  const original = { provider: 'PAGBANK', payout_reference: ref, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 8800,
    transactions: [{ provider_reference: ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 1000, chargeback_amount: 0, net_amount: 8800 }] };
  const r = res(); await importPayout(req(original, {}, '', actor), r.out); const payout = r.get().body.payout; assert.equal(payout.status, 'DIVERGENT');
  const corrected = { ...original, net_amount: 9800, transactions: [{ ...original.transactions[0], refund_amount: 0, net_amount: 9800 }] };
  const body = { expected_hash: payout.content_hash, reason: 'Valor transcrito incorretamente', report: corrected };
  const ops = await Promise.all(Array.from({ length: 4 }, async () => { const rr = res(); await correctPayout(req(body, { id: payout.id }, 'pg-correction-key', actor), rr.out); return rr.get(); }));
  assert.equal(ops.filter((x) => !x.body.idempotente).length, 1); assert.equal(ops[0].body.payout.status, 'IMPORTED');
  const bank = (await query("INSERT INTO fin_extrato_transacoes (empresa_id,linha_hash,valor,direcao,status) VALUES (1,$1,98,'entrada','importada') RETURNING id", [ref])).rows[0];
  await matchPayout(req({ bank_transaction_id: Number(bank.id) }, { id: payout.id }, '', actor), res().out);
  await marcarDivergencia(req({ motivo: 'Divergência bancária de teste' }, { id: bank.id }, '', actor), res().out);
  assert.equal((await query('SELECT status FROM payment_payouts WHERE id=$1', [payout.id])).rows[0].status, 'DIVERGENT');
  const u = res(); await unlinkPayout(req({ bank_transaction_id: Number(bank.id), reason: 'Substituir extrato divergente' }, { id: payout.id }, 'pg-unlink-key', actor), u.out);
  assert.equal(u.get().body.payout.status, 'IMPORTED');
  await assert.rejects(() => matchPayout(req({ bank_transaction_id: Number(bank.id) }, { id: payout.id }, '', actor), res().out), (e: any) => e.status === 409);
  const detail = res(); await payoutDetail(req({}, { id: payout.id }, '', actor), detail.out);
  assert.equal(detail.get().body.revisions.total, 2); assert.equal(detail.get().body.unlinks.total, 1); assert.equal(detail.get().body.report.net_amount, 9800);
  const versions = (await query('SELECT revision,report FROM payment_payout_revisions WHERE payout_id=$1 ORDER BY revision', [payout.id])).rows;
  assert.equal(Number(versions[0].report.net_amount), 8800); assert.equal(Number(versions[1].report.net_amount), 9800);
});

test('PG pagamentos: correção concorrente com novo estorno não termina conciliável por engano', { skip }, async () => {
  const { query } = await boot(); const { importPayout, correctPayout } = await import('../../../modules/payments/application/payouts');
  const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
  for (let run = 0; run < 5; run++) {
    const ref = `correction-refund-pg-${Date.now()}-${process.pid}-${run}`; const { intent, actor } = await fixture(ref);
    const original = { provider: 'PAGBANK', payout_reference: ref, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 8800,
      transactions: [{ provider_reference: ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 1000, chargeback_amount: 0, net_amount: 8800 }] };
    const r = res(); await importPayout(req(original, {}, '', actor), r.out); const payout = r.get().body.payout;
    const corrected = { ...original, net_amount: 9800, transactions: [{ ...original.transactions[0], refund_amount: 0, net_amount: 9800 }] };
    const [correction, refund] = await Promise.allSettled([
      correctPayout(req({ expected_hash: payout.content_hash, reason: 'Transcrição inicialmente incorreta', report: corrected }, { id: payout.id }, `corr-race-${run}`, actor), res().out),
      paymentEngine.apply(1, intent, { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 2000 }),
    ]);
    if (correction.status === 'rejected') assert.ok(correction.reason.status === 409 || correction.reason.code === '40001');
    if (refund.status === 'rejected') { assert.equal(refund.reason.code, '40001'); await paymentEngine.apply(1, intent, { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 2000 }); }
    const p = (await query('SELECT status FROM payment_payouts WHERE id=$1', [payout.id])).rows[0];
    const settlement = (await query('SELECT status,refund_amount FROM payment_settlements WHERE payment_intent_id=$1', [intent])).rows[0];
    assert.equal(p.status, 'DIVERGENT'); assert.equal(settlement.status, 'DIVERGENT'); assert.equal(Number(settlement.refund_amount), 2000);
  }
});

test('PG disputas: advisory lock e idempotência entre processos independentes', { skip, timeout: 60000 }, async (t) => {
  const { fork } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const { query } = await boot(); const ref = `multiprocess-${Date.now()}-${process.pid}`; const { intent, actor } = await fixture(ref);
  const worker = fileURLToPath(new URL('../fixtures/dispute-process-worker.ts', import.meta.url));
  const children = Array.from({ length: 3 }, () => fork(worker, [], { execArgv: ['--import', 'tsx'], env: { ...process.env, NODE_ENV: 'test', PG_IDLE_TIMEOUT: '1000' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); });
  const nextMessage = (child: (typeof children)[number]) => new Promise<any>((resolve, reject) => {
    let errors = ''; child.stderr?.on('data', (chunk) => { errors += String(chunk); });
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout do worker: ${errors}`)); }, 30000);
    const message = (value: unknown) => { cleanup(); resolve(value); };
    const exit = (code: number | null) => { cleanup(); reject(new Error(`Worker encerrou ${code}: ${errors}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
    child.once('message', message); child.once('exit', exit);
  });
  assert.ok((await Promise.all(children.map(nextMessage))).every((m) => m.ready));
  const pending = children.map(nextMessage);
  const data = { payment_intent_id: intent, provider_reference: ref, external_dispute_id: `external-${ref}`, reason: 'Informação externa verificada', amount: 1500 };
  for (const child of children) child.send({ data, actor, key: `cross-process-${ref}` });
  const results = await Promise.all(pending);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(results.filter((r) => r.status === 201).length, 1); assert.equal(results.filter((r) => r.idempotente).length, 2);
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  const counts = (await query('SELECT count(*)::int AS n FROM payment_dispute_events WHERE empresa_id=1 AND idempotency_key=$1', [`cross-process-${ref}`])).rows[0];
  assert.equal(counts.n, 1);
});

test('PG + HTTP pagamentos: sessão, RBAC, isolamento, disputa, correção e desvinculação', { skip }, async () => {
  const { query } = await boot(); const { default: express } = await import('express'); const { default: request } = await import('supertest');
  const { requireAuth, signToken } = await import('../../src/auth'); const { abrirSessao } = await import('../../src/sessoes');
  const { paymentsRouter } = await import('../../../modules/payments/api/routes');
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => { void requireAuth(req, res, next).catch(next); });
  app.use('/api/commerce/payments', paymentsRouter); app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  const ref = `http-payment-pg-${Date.now()}-${process.pid}`; const { intent, actor } = await fixture(ref);
  const company = (await query('INSERT INTO empresas (nome,ativo) VALUES ($1,true) RETURNING id', [ref])).rows[0];
  const operator = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('Operador PG',$1,'operador',1) RETURNING id", [`op-${ref}@test.invalid`])).rows[0];
  const outsider = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('Gerente externo',$1,'gerente',$2) RETURNING id", [`b-${ref}@test.invalid`, company.id])).rows[0];
  async function token(id: number, perfil: 'admin' | 'gerente' | 'operador', empresa: number) {
    const sid = await abrirSessao({ usuarioId: id, lembrar: false, req: { headers: {}, socket: {} } as any });
    return signToken({ id, name: 'Teste', perfil }, { sid, emp: empresa });
  }
  const a = await token(actor.id, 'admin', 1); const op = await token(Number(operator.id), 'operador', 1); const b = await token(Number(outsider.id), 'gerente', Number(company.id));
  const base = '/api/commerce/payments'; const dispute = { payment_intent_id: intent, provider_reference: ref, external_dispute_id: `external-${ref}`, reason: 'Disputa real para exercício HTTP PG', amount: 1000 };
  await request(app).post(`${base}/disputes`).set('Idempotency-Key', `${ref}-dispute`).send(dispute).expect(401);
  await request(app).post(`${base}/disputes`).set('Authorization', `Bearer ${op}`).set('Idempotency-Key', `${ref}-dispute`).send(dispute).expect(403);
  await request(app).post(`${base}/disputes`).set('Authorization', `Bearer ${b}`).set('Idempotency-Key', `${ref}-dispute`).send(dispute).expect(404);
  const first = await request(app).post(`${base}/disputes`).set('Authorization', `Bearer ${a}`).set('Idempotency-Key', `${ref}-dispute`).send(dispute).expect(201);
  const replay = await request(app).post(`${base}/disputes`).set('Authorization', `Bearer ${a}`).set('Idempotency-Key', `${ref}-dispute`).send(dispute).expect(200);
  assert.equal(replay.body.idempotente, true); const disputeId = first.body.dispute.id;
  await request(app).get(`${base}/disputes/${disputeId}`).set('Authorization', `Bearer ${b}`).expect(404);
  await request(app).post(`${base}/disputes/${disputeId}/evidence`).set('Authorization', `Bearer ${a}`).set('Idempotency-Key', `${ref}-evidence`).send({ kind: 'NOTE', description: 'Comprovante', content: 'Evidência interna' }).expect(201);
  await request(app).post(`${base}/disputes/${disputeId}/transition`).set('Authorization', `Bearer ${a}`).set('Idempotency-Key', `${ref}-transition`).send({ status: 'UNDER_REVIEW', note: 'Revisão interna iniciada', expected_version: 0 }).expect(200);
  const detail = await request(app).get(`${base}/disputes/${disputeId}`).set('Authorization', `Bearer ${a}`).expect(200);
  assert.equal(detail.body.dispute.version, 1); assert.equal(detail.body.evidence.total, 1); assert.equal(detail.headers['cache-control'], 'private, no-store');
  const payoutRef = `${ref}-independent`; await fixture(payoutRef);
  const report = { provider: 'PAGBANK', payout_reference: payoutRef, currency: 'BRL', settlement_date: '2036-01-02', net_amount: 8800, transactions: [{ provider_reference: payoutRef, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 1000, chargeback_amount: 0, net_amount: 8800 }] };
  await request(app).post(`${base}/payouts/import`).set('Authorization', `Bearer ${a}`).send({ ...report, currency: undefined }).expect(400);
  await request(app).post(`${base}/payouts/import`).set('Authorization', `Bearer ${a}`).send({ ...report, transactions: [{ ...report.transactions[0], refund_amount: undefined }] }).expect(400);
  await request(app).post(`${base}/payouts/import`).set('Authorization', `Bearer ${op}`).send(report).expect(403);
  await request(app).post(`${base}/payouts/import`).set('Authorization', `Bearer ${b}`).send(report).expect(422);
  const imported = await request(app).post(`${base}/payouts/import`).set('Authorization', `Bearer ${a}`).send(report).expect(201);
  const payoutId = imported.body.payout.id; assert.equal(imported.body.payout.status, 'DIVERGENT');
  const corrected = { ...report, net_amount: 9800, transactions: [{ ...report.transactions[0], refund_amount: 0, net_amount: 9800 }] };
  await request(app).post(`${base}/payouts/${payoutId}/correct`).set('Authorization', `Bearer ${a}`).set('Idempotency-Key', `${ref}-correction`).send({ expected_hash: imported.body.payout.content_hash, reason: 'Corrigir transcrição do relatório', report: corrected }).expect(200);
  const bank = (await query("INSERT INTO fin_extrato_transacoes (empresa_id,linha_hash,valor,direcao,status) VALUES (1,$1,98,'entrada','importada') RETURNING id", [ref])).rows[0];
  await request(app).post(`${base}/payouts/${payoutId}/match`).set('Authorization', `Bearer ${a}`).send({ bank_transaction_id: Number(bank.id) }).expect(200);
  await request(app).post(`${base}/payouts/${payoutId}/unlink`).set('Authorization', `Bearer ${a}`).set('Idempotency-Key', `${ref}-unlink`).send({ bank_transaction_id: Number(bank.id), reason: 'Corrigir vínculo ao extrato' }).expect(200);
  const payoutDetail = await request(app).get(`${base}/payouts/${payoutId}`).set('Authorization', `Bearer ${a}`).expect(200);
  assert.equal(payoutDetail.body.revisions.total, 2); assert.equal(payoutDetail.body.unlinks.total, 1); assert.equal(payoutDetail.body.payout.status, 'IMPORTED');
  await request(app).get(`${base}/payouts/${payoutId}`).set('Authorization', `Bearer ${b}`).expect(404);
});
