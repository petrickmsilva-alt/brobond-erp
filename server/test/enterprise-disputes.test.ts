import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { R_INTENTS, R_ATTEMPTS, R_DISPUTES, R_DISPUTE_EVIDENCE, R_DISPUTE_EVENTS, R_SETTLEMENTS } = await import('../../modules/payments/infrastructure/resources');
const { registerDispute, disputeDetail, addDisputeEvidence, transitionDispute } = await import('../../modules/payments/application/disputes');
const actor = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1, empresas: [1] };
const req = (body: object = {}, params: object = {}, key = 'testing-key-0001', user: any = actor) => ({ body, params, user, query: {}, get: () => key } as any);
function res() {
  let body: any, status = 200; const headers: any = {};
  const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader(k: string, v: string) { headers[k] = v; } };
  return { out, get: () => ({ body, status, headers }) };
}
async function fixture(ref: string, company = 1) {
  const s = getStore();
  const intent = await s.insert(R_INTENTS, { empresa_id: company, order_id: 1, currency: 'BRL', amount: 10000, method: 'CREDIT_CARD', provider: 'STRIPE', status: 'PAID', idempotency_key: ref, correlation_id: ref });
  await s.insert(R_ATTEMPTS, { empresa_id: company, payment_intent_id: intent.id, provider: 'STRIPE', provider_transaction_id: ref, requested_amount: 10000, authorized_amount: 10000, captured_amount: 10000, refunded_amount: 0, status: 'PAID' });
  await s.insert(R_SETTLEMENTS, { empresa_id: company, payment_intent_id: intent.id, provider: 'STRIPE', provider_reference: ref, gross_amount: 10000, refund_amount: 0, chargeback_amount: 0, status: 'UNRECONCILED' });
  return { intent, data: { payment_intent_id: intent.id, provider_reference: ref, external_dispute_id: `DIS-${ref}`, reason: 'Motivo informado pelo provedor', amount: 3000, due_date: '2029-05-10' } };
}

test('disputas: registro, evidência, envio externo declarado e desfecho auditados e idempotentes', async () => {
  const s = getStore(); const { intent, data } = await fixture('dispute-flow');
  const first = res(); await registerDispute(req(data), first.out);
  assert.equal(first.get().status, 201); const d = first.get().body.dispute;
  assert.equal(d.origin, 'MANUAL'); assert.equal(d.status, 'DISPUTE_OPENED');
  assert.equal((await s.get(R_INTENTS, intent.id))?.status, 'PAID', 'registro humano não simula webhook');
  const replay = res(); await registerDispute(req(data), replay.out);
  assert.equal(replay.get().body.idempotente, true); assert.equal(replay.get().body.dispute.id, d.id);
  await assert.rejects(() => registerDispute(req({ ...data, amount: 3500 }), res().out), (e: any) => e.status === 409);
  const evidence = { kind: 'NOTE', description: 'Comprovante de entrega', content: 'Conteúdo interno confidencial' };
  const e = res(); await addDisputeEvidence(req(evidence, { id: d.id }, 'evidence-key-01'), e.out);
  assert.equal(e.get().status, 201);
  const eReplay = res(); await addDisputeEvidence(req(evidence, { id: d.id }, 'evidence-key-01'), eReplay.out);
  assert.equal(eReplay.get().body.idempotente, true);
  await assert.rejects(() => addDisputeEvidence(req({ ...evidence, content: 'outro' }, { id: d.id }, 'evidence-key-01'), res().out), (err: any) => err.status === 409);
  const submitted = { status: 'EVIDENCE_SUBMITTED', note: 'Enviado pelo portal do provedor', external_reference: 'recibo-123', confirm_external: true, expected_version: 0 };
  const tr = res(); await transitionDispute(req(submitted, { id: d.id }, 'transition-key-01'), tr.out);
  assert.equal(tr.get().body.dispute.status, 'EVIDENCE_SUBMITTED'); assert.equal(tr.get().body.dispute.version, 1);
  const trReplay = res(); await transitionDispute(req(submitted, { id: d.id }, 'transition-key-01'), trReplay.out);
  assert.equal(trReplay.get().body.idempotente, true);
  await assert.rejects(() => transitionDispute(req({ status: 'WON', note: 'Resultado confirmado externamente', external_reference: 'resultado', confirm_external: true, expected_version: 0 }, { id: d.id }, 'transition-key-02'), res().out), (err: any) => err.status === 409);
  const winner = res(); await transitionDispute(req({ status: 'WON', note: 'Resultado confirmado externamente', external_reference: 'resultado', confirm_external: true, expected_version: 1 }, { id: d.id }, 'transition-key-03'), winner.out);
  assert.equal(winner.get().body.dispute.status, 'WON');
  await assert.rejects(() => addDisputeEvidence(req(evidence, { id: d.id }, 'evidence-key-02'), res().out), (err: any) => err.status === 409);
  const detail = res(); await disputeDetail(req({}, { id: d.id }), detail.out);
  assert.equal(detail.get().headers['Cache-Control'], 'private, no-store');
  assert.equal(detail.get().body.provider_submission, 'NAO_SUPORTADO');
  assert.equal(detail.get().body.evidence.total, 1); assert.equal(detail.get().body.events.total, 3);
  assert.equal(detail.get().body.evidence.rows[0].content, evidence.content);
  assert.equal(detail.get().body.evidence.rows[0].request_hash, undefined);
  const audit = await s.list((await import('../src/resources')).RESOURCES.auditoria, { page: 1, pageSize: 100, filter: { recurso: 'payment_disputes', registro_id: d.id } });
  assert.ok(audit.total >= 3); assert.ok(!JSON.stringify(audit.rows).includes(evidence.content));
});

test('disputas: autorização, tenant, transações, máquina de estados e prazo falham fechados', async () => {
  const { data } = await fixture('dispute-sec');
  await assert.rejects(() => registerDispute(req(data, {}, 'test-key-2222', null), res().out), (e: any) => e.status === 401);
  await assert.rejects(() => registerDispute(req(data, {}, 'test-key-2222', { ...actor, perfil: 'operador' }), res().out), (e: any) => e.status === 403);
  await assert.rejects(() => registerDispute(req(data, {}, 'test-key-2222', { ...actor, empresa_id: 2, empresas: [2] }), res().out), (e: any) => e.status === 404);
  await assert.rejects(() => registerDispute(req({ ...data, provider_reference: 'outra' }, {}, 'test-key-2222'), res().out), (e: any) => e.status === 422);
  await assert.rejects(() => registerDispute(req({ ...data, amount: 10001 }, {}, 'test-key-2222'), res().out), (e: any) => e.status === 409);
  await assert.rejects(() => registerDispute(req({ ...data, due_date: '2029-02-30' }, {}, 'test-key-2222'), res().out), (e: any) => e.status === 400);
  await assert.rejects(() => registerDispute(req(data, {}, 'x'), res().out), (e: any) => e.status === 400);
  const r = res(); await registerDispute(req(data, {}, 'test-key-2222'), r.out); const id = r.get().body.dispute.id;
  await assert.rejects(() => disputeDetail(req({}, { id }, '', { ...actor, empresa_id: 2, empresas: [2] }), res().out), (e: any) => e.status === 404);
  await assert.rejects(() => transitionDispute(req({ status: 'WON', note: 'Resultado informado externamente', expected_version: 0 }, { id }, 'test-key-2223'), res().out), (e: any) => e.status === 400);
  await assert.rejects(() => transitionDispute(req({ status: 'EVIDENCE_SUBMITTED', note: 'Enviado externamente', external_reference: '123', confirm_external: true, expected_version: 0 }, { id }, 'test-key-2224'), res().out), (e: any) => e.status === 409);
  assert.equal((await getStore().list(R_DISPUTE_EVIDENCE, { page: 1, pageSize: 50, filter: { empresa_id: 1, dispute_id: id } })).total, 0);
});

test('disputas: webhook anterior é enriquecido sem duplicação nem reescrita de estado', async () => {
  const s = getStore(); const { intent, data } = await fixture('engine-dispute');
  const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');
  await paymentEngine.apply(1, Number(intent.id), { reference: 'engine-dispute', status: 'DISPUTED' });
  const existing = await s.findOneWhere(R_DISPUTES, { empresa_id: 1, provider_reference: 'engine-dispute' }); assert.ok(existing);
  assert.equal(existing.origin, 'ENGINE'); assert.equal(existing.version, 0);
  assert.equal(existing.amount, null); assert.equal(existing.amount_source, 'UNKNOWN');
  const r = res(); await registerDispute(req(data, {}, 'register-engine-01'), r.out);
  assert.equal(r.get().body.dispute.id, existing.id); assert.equal(r.get().body.dispute.version, 1);
  assert.equal(r.get().body.dispute.origin, 'ENGINE'); assert.equal(r.get().body.dispute.status, 'DISPUTE_OPENED');
  assert.equal(r.get().body.dispute.amount_source, 'MANUAL_REPORTED');
  assert.equal((await s.list(R_DISPUTES, { page: 1, pageSize: 20, filter: { empresa_id: 1, provider_reference: 'engine-dispute' } })).total, 1);
  assert.equal((await s.list(R_DISPUTE_EVENTS, { page: 1, pageSize: 20, filter: { empresa_id: 1, dispute_id: existing.id } })).total, 1);
});

test('disputas HTTP: sessões reais, RBAC, tenant e idempotência antes de acessar dados', async () => {
  const { default: express } = await import('express'); const { default: request } = await import('supertest');
  const { requireAuth, signToken } = await import('../src/auth'); const { abrirSessao } = await import('../src/sessoes');
  const { RESOURCES } = await import('../src/resources'); const { paymentsRouter } = await import('../../modules/payments/api/routes');
  const s = getStore(); const app = express(); app.use(express.json());
  app.use('/api', (req, res, next) => { void requireAuth(req, res, next).catch(next); });
  app.use('/api/commerce/payments', paymentsRouter);
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  async function token(perfil: 'gerente' | 'operador', company: number) {
    const u = await s.insert(RESOURCES.usuarios, { nome: `Disputas ${perfil} ${company}`, email: `disputas-${perfil}-${company}@test.invalid`, perfil, ativo: true, empresa_id: company });
    if (company !== 1) await s.insert(RESOURCES.usuario_empresas, { usuario_id: Number(u.id), empresa_id: company });
    const sid = await abrirSessao({ usuarioId: Number(u.id), lembrar: false, req: { headers: {}, socket: {} } as any });
    return signToken({ id: Number(u.id), name: String(u.nome), email: String(u.email), perfil }, { sid, emp: company });
  }
  const another = await s.insert(RESOURCES.empresas, { nome: 'Empresa HTTP separada', ativo: true });
  const manager = await token('gerente', 1); const operator = await token('operador', 1); const foreign = await token('gerente', Number(another.id));
  const { data } = await fixture('dispute-http');
  await request(app).get('/api/commerce/payments/disputes').expect(401);
  await request(app).post('/api/commerce/payments/disputes').set('Authorization', `Bearer ${operator}`).set('Idempotency-Key', 'http-test-key-01').send(data).expect(403);
  await request(app).post('/api/commerce/payments/disputes').set('Authorization', `Bearer ${foreign}`).set('Idempotency-Key', 'http-test-key-01').send(data).expect(404);
  const created = await request(app).post('/api/commerce/payments/disputes').set('Authorization', `Bearer ${manager}`).set('Idempotency-Key', 'http-test-key-01').send({ ...data, empresa_id: 2 }).expect(201);
  assert.equal(Number(created.body.dispute.empresa_id), 1); const disputeId = created.body.dispute.id;
  const replay = await request(app).post('/api/commerce/payments/disputes').set('Authorization', `Bearer ${manager}`).set('Idempotency-Key', 'http-test-key-01').send(data).expect(200);
  assert.equal(replay.body.idempotente, true);
  await request(app).get(`/api/commerce/payments/disputes/${disputeId}`).set('Authorization', `Bearer ${foreign}`).expect(404);
  await request(app).get(`/api/commerce/payments/disputes/${disputeId}`).set('Authorization', `Bearer ${operator}`).expect(403);
  const list = await request(app).get('/api/commerce/payments/disputes?page=1&pageSize=25').set('Authorization', `Bearer ${manager}`).expect(200);
  assert.equal(list.headers['cache-control'], 'private, no-store');
  await request(app).get('/api/commerce/payments/disputes?page=1.5').set('Authorization', `Bearer ${manager}`).expect(400);
  await request(app).get('/api/commerce/payments/disputes?pageSize=101').set('Authorization', `Bearer ${manager}`).expect(400);
  const detail = await request(app).get(`/api/commerce/payments/disputes/${disputeId}`).set('Authorization', `Bearer ${manager}`).expect(200);
  assert.equal(detail.headers['cache-control'], 'private, no-store');
});
