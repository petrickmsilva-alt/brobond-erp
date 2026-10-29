import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { R_EXTRATO } = await import('../src/extrato');
const { R_SETTLEMENTS, R_PAYOUTS } = await import('../../modules/payments/infrastructure/resources');
const { normalizePayout, importPayout, matchPayout, payoutDetail } = await import('../../modules/payments/application/payouts');
const admin = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1, empresas: [1] };
const req = (body: object, params: object = {}, user = admin) => ({ body, params, user, query: {} } as any);
function res() { let body: any, status = 200; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; } }; return { out, get: () => ({ body, status }) }; }
const report = (payout_reference = 'REPASSE-001', gross_amount = 10000) => ({ provider: 'PAGBANK', payout_reference, settlement_date: '2028-05-10', net_amount: gross_amount - 200,
  transactions: [{ provider_reference: 'TRANS-001', gross_amount, provider_fee: 200, net_amount: gross_amount - 200 }] });

test('payment: normalização valida centavos, totais, data e linhas duplicadas', () => {
  assert.equal(normalizePayout(report()).hash.length, 64);
  assert.throws(() => normalizePayout({ ...report(), net_amount: 1 }));
  assert.throws(() => normalizePayout({ ...report(), settlement_date: '2028-02-30' }));
  assert.throws(() => normalizePayout({ ...report(), transactions: [{ ...report().transactions[0], gross_amount: 100.5 }] }));
  assert.throws(() => normalizePayout({ ...report(), transactions: [...report().transactions, ...report().transactions] }));
});

test('payment: importação é idempotente e conciliação exige linha bancária exata da empresa', async () => {
  const s = getStore();
  await s.insert(R_SETTLEMENTS, { empresa_id: 1, payment_intent_id: 91, provider: 'PAGBANK', provider_reference: 'TRANS-001', gross_amount: 10000, refund_amount: 0, chargeback_amount: 0, status: 'UNRECONCILED', evidence: {} });
  const r = res(); await importPayout(req(report()), r.out);
  assert.equal(r.get().status, 201); const payoutId = r.get().body.payout.id;
  const replay = res(); await importPayout(req(report()), replay.out);
  assert.equal(replay.get().body.idempotente, true); assert.equal(replay.get().body.payout.id, payoutId);
  await assert.rejects(() => importPayout(req(report('REPASSE-001', 10100)), res().out), (e: any) => e.status === 409);
  const wrong = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 99, direcao: 'entrada', status: 'importada', linha_hash: 'wrong' });
  await assert.rejects(() => matchPayout(req({ bank_transaction_id: wrong.id }, { id: payoutId }), res().out), (e: any) => e.status === 409);
  const foreign = await s.insert(R_EXTRATO, { empresa_id: 2, valor: 98, direcao: 'entrada', status: 'importada', linha_hash: 'foreign' });
  await assert.rejects(() => matchPayout(req({ bank_transaction_id: foreign.id }, { id: payoutId }), res().out), (e: any) => e.status === 404);
  const bank = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 98, direcao: 'entrada', status: 'importada', linha_hash: 'right' });
  const matched = res(); await matchPayout(req({ bank_transaction_id: bank.id }, { id: payoutId }), matched.out);
  assert.equal(matched.get().body.payout.status, 'MATCHED');
  const replayMatch = res(); await matchPayout(req({ bank_transaction_id: bank.id }, { id: payoutId }), replayMatch.out);
  assert.equal(replayMatch.get().body.idempotente, true);
  const detail = res(); await payoutDetail(req({}, { id: payoutId }), detail.out);
  assert.equal(detail.get().body.settlements[0].status, 'MATCHED');
  assert.equal((await s.get(R_EXTRATO, bank.id))?.status, 'importada', 'reconciliação payment não altera o livro financeiro');
  await assert.rejects(() => payoutDetail(req({}, { id: payoutId }, { ...admin, empresa_id: 2, empresas: [2] }), res().out), (e: any) => e.status === 404);
  await assert.rejects(() => importPayout(req(report('OTHER'), {}, { ...admin, perfil: 'operador' }), res().out), (e: any) => e.status === 403);
});

test('payment: valor divergente é evidência, não MATCHED', async () => {
  const s = getStore();
  await s.insert(R_SETTLEMENTS, { empresa_id: 1, payment_intent_id: 92, provider: 'PAGBANK', provider_reference: 'DIVERGENT-TRANS', gross_amount: 5000, refund_amount: 0, chargeback_amount: 0, status: 'UNRECONCILED', evidence: {} });
  const body = { ...report('DIVERGENT-PAYOUT'), transactions: [{ ...report().transactions[0], provider_reference: 'DIVERGENT-TRANS' }] };
  const r = res(); await importPayout(req(body), r.out);
  assert.equal(r.get().body.payout.status, 'DIVERGENT');
  const bank = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 98, direcao: 'entrada', status: 'importada', linha_hash: 'divergent' });
  await assert.rejects(() => matchPayout(req({ bank_transaction_id: bank.id }, { id: r.get().body.payout.id }), res().out), (e: any) => e.status === 409);
  assert.equal((await s.get(R_PAYOUTS, r.get().body.payout.id))?.bank_transaction_id, null);
});

test('payment: estorno total sem valor explícito invalida repasse conciliado', async () => {
  const { R_INTENTS, R_ATTEMPTS } = await import('../../modules/payments/infrastructure/resources');
  const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');
  const s = getStore(); const ref = 'full-refund-fixture';
  const intent = await s.insert(R_INTENTS, { empresa_id: 1, order_id: 998, channel: 'OWN_STORE', currency: 'BRL', amount: 10000, method: 'PIX', provider: 'PAGBANK', status: 'PAID', idempotency_key: ref, correlation_id: ref });
  const attempt = await s.insert(R_ATTEMPTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_transaction_id: ref, method: 'PIX', requested_amount: 10000, authorized_amount: 10000, captured_amount: 10000, refunded_amount: 0, status: 'PAID', idempotency_key: ref, correlation_id: ref });
  const payout = await s.insert(R_PAYOUTS, { empresa_id: 1, provider: 'PAGBANK', payout_reference: ref, net_amount: 9800, status: 'MATCHED' });
  const settlement = await s.insert(R_SETTLEMENTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_reference: ref, gross_amount: 10000, refund_amount: 0, chargeback_amount: 0, payout_id: payout.id, status: 'MATCHED' });
  await paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'REFUNDED' });
  assert.equal((await s.get(R_ATTEMPTS, attempt.id))?.refunded_amount, 10000);
  assert.equal((await s.get(R_SETTLEMENTS, settlement.id))?.refund_amount, 10000);
  assert.equal((await s.get(R_SETTLEMENTS, settlement.id))?.status, 'DIVERGENT');
  assert.equal((await s.get(R_PAYOUTS, payout.id))?.status, 'DIVERGENT');
});

test('payment: estorno parcial sem centavos ou total com valor contraditório falha fechado', async () => {
  const { R_INTENTS, R_ATTEMPTS } = await import('../../modules/payments/infrastructure/resources');
  const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');
  const s = getStore(); const ref = 'ambiguous-refund-fixture';
  const intent = await s.insert(R_INTENTS, { empresa_id: 1, order_id: 999, channel: 'OWN_STORE', currency: 'BRL', amount: 10000, method: 'PIX', provider: 'PAGBANK', status: 'PAID', idempotency_key: ref, correlation_id: ref });
  await s.insert(R_ATTEMPTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_transaction_id: ref, method: 'PIX', requested_amount: 10000, authorized_amount: 10000, captured_amount: 10000, refunded_amount: 0, status: 'PAID', idempotency_key: ref, correlation_id: ref });
  await assert.rejects(() => paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'PARTIALLY_REFUNDED' }), (e: any) => e.status === 409);
  await assert.rejects(() => paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'REFUNDED', refunded: 0 }), (e: any) => e.status === 409);
  await assert.rejects(() => paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 1.5 }), (e: any) => e.status === 409);
  assert.equal((await s.get(R_INTENTS, intent.id))?.status, 'PAID');
});
