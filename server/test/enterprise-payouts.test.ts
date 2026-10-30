import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { R_EXTRATO } = await import('../src/extrato');
const { R_SETTLEMENTS, R_PAYOUTS } = await import('../../modules/payments/infrastructure/resources');
const { normalizePayout, importPayout, matchPayout, payoutDetail } = await import('../../modules/payments/application/payouts');
const admin = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1, empresas: [1] };
const req = (body: object, params: object = {}, user = admin) => ({ body, params, user, query: {} } as any);
function res() { let body: any, status = 200; const headers: Record<string, string> = {}; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader(k: string, v: string) { headers[k] = v; } }; return { out, get: () => ({ body, status, headers }) }; }
const report = (payout_reference = 'REPASSE-001', gross_amount = 10000) => ({ provider: 'PAGBANK', payout_reference, currency: 'BRL', settlement_date: '2028-05-10', net_amount: gross_amount - 200,
  transactions: [{ provider_reference: 'TRANS-001', gross_amount, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: gross_amount - 200 }] });

test('payment: normalização valida centavos, totais, data e linhas duplicadas', () => {
  assert.equal(normalizePayout(report()).hash.length, 64);
  assert.throws(() => normalizePayout({ ...report(), currency: undefined }));
  assert.throws(() => normalizePayout({ ...report(), currency: 'USD' }));
  for (const field of ['provider_fee', 'gateway_fee', 'installment_fee', 'antifraud_fee', 'refund_amount', 'chargeback_amount']) {
    assert.throws(() => normalizePayout({ ...report(), transactions: [{ ...report().transactions[0], [field]: undefined }] }));
    assert.throws(() => normalizePayout({ ...report(), transactions: [{ ...report().transactions[0], [field]: null }] }));
  }
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
  assert.equal(detail.get().headers['Cache-Control'], 'private, no-store');
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

test('payment: estorno total comprovado invalida repasse conciliado', async () => {
  const { R_INTENTS, R_ATTEMPTS } = await import('../../modules/payments/infrastructure/resources');
  const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');
  const s = getStore(); const ref = 'full-refund-fixture';
  const intent = await s.insert(R_INTENTS, { empresa_id: 1, order_id: 998, channel: 'OWN_STORE', currency: 'BRL', amount: 10000, method: 'PIX', provider: 'PAGBANK', status: 'PAID', idempotency_key: ref, correlation_id: ref });
  const attempt = await s.insert(R_ATTEMPTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_transaction_id: ref, method: 'PIX', requested_amount: 10000, authorized_amount: 10000, captured_amount: 10000, refunded_amount: 0, status: 'PAID', idempotency_key: ref, correlation_id: ref });
  const payout = await s.insert(R_PAYOUTS, { empresa_id: 1, provider: 'PAGBANK', payout_reference: ref, net_amount: 9800, status: 'MATCHED' });
  const settlement = await s.insert(R_SETTLEMENTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_reference: ref, gross_amount: 10000, refund_amount: 0, chargeback_amount: 0, payout_id: payout.id, status: 'MATCHED' });
  await paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'REFUNDED', refunded: 10000 });
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
  await assert.rejects(() => paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'REFUNDED' }), (e: any) => e.status === 409);
  await assert.rejects(() => paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'REFUNDED', refunded: 0 }), (e: any) => e.status === 409);
  await assert.rejects(() => paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 1.5 }), (e: any) => e.status === 409);
  assert.equal((await s.get(R_INTENTS, intent.id))?.status, 'PAID');
});

test('payment: correção preserva versões, só libera match coerente e desvincula extrato auditado', async () => {
  const { correctPayout, unlinkPayout } = await import('../../modules/payments/application/payouts');
  const { marcarDivergencia } = await import('../src/extrato');
  const s = getStore(); const ref = 'CORRECTION-TRANSACTION';
  await s.insert(R_SETTLEMENTS, { empresa_id: 1, payment_intent_id: 93, provider: 'PAGBANK', provider_reference: ref, gross_amount: 5000, refund_amount: 0, chargeback_amount: 0, status: 'UNRECONCILED', evidence: {} });
  const incorrect = { provider: 'PAGBANK', payout_reference: 'CORRECTION-PAYOUT', currency: 'BRL', settlement_date: '2028-05-10', net_amount: 9800,
    transactions: [{ provider_reference: ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
  const r = res(); await importPayout(req(incorrect), r.out); const payout = r.get().body.payout;
  assert.equal(payout.status, 'DIVERGENT');
  const corrected = { ...incorrect, net_amount: 4800, transactions: [{ ...incorrect.transactions[0], gross_amount: 5000, net_amount: 4800 }] };
  const body = { expected_hash: payout.content_hash, reason: 'Correção de valor transcrito', report: corrected };
  const request = (data: any, key = 'correct-key-0001', user = admin) => ({ ...req(data, { id: payout.id }, user), get: () => key });
  await assert.rejects(() => correctPayout(request({ ...body, report: { ...corrected, transactions: [{ ...corrected.transactions[0], provider_reference: 'OUTRA' }] } }), res().out), (e: any) => e.status === 409);
  const c = res(); await correctPayout(request(body), c.out);
  assert.equal(c.get().body.payout.status, 'IMPORTED'); assert.equal(c.get().body.revision, 2);
  const replay = res(); await correctPayout(request(body), replay.out); assert.equal(replay.get().body.idempotente, true);
  await assert.rejects(() => correctPayout(request({ ...body, reason: 'Outro motivo de correção' }), res().out), (e: any) => e.status === 409);
  await assert.rejects(() => correctPayout(request(body, 'correct-key-0002'), res().out), (e: any) => e.status === 409);
  await assert.rejects(() => correctPayout(request(body, 'correct-key-0002', { ...admin, empresa_id: 2, empresas: [2] }), res().out), (e: any) => e.status === 404);
  const detail = res(); await payoutDetail(req({}, { id: payout.id }), detail.out);
  assert.equal(detail.get().body.revisions.total, 2); assert.equal(detail.get().body.report.net_amount, 4800);
  const bank = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 48, direcao: 'entrada', status: 'importada', linha_hash: 'bank-correction' });
  await matchPayout(req({ bank_transaction_id: bank.id }, { id: payout.id }), res().out);
  await marcarDivergencia(req({ motivo: 'Banco reportou divergência' }, { id: bank.id }), res().out);
  assert.equal((await s.get(R_PAYOUTS, payout.id))?.status, 'DIVERGENT');
  const unlinkBody = { bank_transaction_id: bank.id, reason: 'Substituição do extrato bancário' };
  const u = res(); await unlinkPayout(request(unlinkBody, 'unlink-key-0001'), u.out);
  assert.equal(u.get().body.payout.status, 'IMPORTED'); assert.equal(u.get().body.payout.bank_transaction_id, null);
  const uReplay = res(); await unlinkPayout(request(unlinkBody, 'unlink-key-0001'), uReplay.out); assert.equal(uReplay.get().body.idempotente, true);
  await assert.rejects(() => matchPayout(req({ bank_transaction_id: bank.id }, { id: payout.id }), res().out), (e: any) => e.status === 409);
  const replacement = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 48, direcao: 'entrada', status: 'importada', linha_hash: 'bank-correction-new' });
  const matched = res(); await matchPayout(req({ bank_transaction_id: replacement.id }, { id: payout.id }), matched.out);
  assert.equal(matched.get().body.payout.status, 'MATCHED');
  assert.equal((await s.get(R_EXTRATO, bank.id))?.status, 'divergente');
  assert.equal((await s.get(R_EXTRATO, replacement.id))?.status, 'importada', 'não altera a escrituração bancária');
  const after = res(); await payoutDetail(req({}, { id: payout.id }), after.out);
  assert.equal(after.get().body.unlinks.total, 1);
});

test('payment: correção após estorno não concilia com valor bancário obsoleto', async () => {
  const { correctPayout, unlinkPayout } = await import('../../modules/payments/application/payouts');
  const { R_INTENTS, R_ATTEMPTS } = await import('../../modules/payments/infrastructure/resources');
  const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');
  const s = getStore(); const ref = 'refund-correction-transaction';
  const intent = await s.insert(R_INTENTS, { empresa_id: 1, order_id: 1004, channel: 'OWN_STORE', currency: 'BRL', amount: 10000, method: 'PIX', provider: 'PAGBANK', status: 'PAID', idempotency_key: ref, correlation_id: ref });
  await s.insert(R_ATTEMPTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_transaction_id: ref, method: 'PIX', requested_amount: 10000, authorized_amount: 10000, captured_amount: 10000, refunded_amount: 0, status: 'PAID', idempotency_key: ref, correlation_id: ref });
  await s.insert(R_SETTLEMENTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_reference: ref, gross_amount: 10000, refund_amount: 0, chargeback_amount: 0, status: 'UNRECONCILED', evidence: {} });
  const original = { provider: 'PAGBANK', payout_reference: 'refund-correction-payout', currency: 'BRL', settlement_date: '2028-05-10', net_amount: 9800,
    transactions: [{ provider_reference: ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
  const r = res(); await importPayout(req(original), r.out); const payout = r.get().body.payout;
  const bank = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 98, direcao: 'entrada', status: 'importada', linha_hash: ref });
  await matchPayout(req({ bank_transaction_id: bank.id }, { id: payout.id }), res().out);
  await paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 2000 });
  const corrected = { ...original, net_amount: 7800, transactions: [{ ...original.transactions[0], refund_amount: 2000, net_amount: 7800 }] };
  const request = (body: any, key: string) => ({ ...req(body, { id: payout.id }), get: () => key });
  const c = res(); await correctPayout(request({ expected_hash: payout.content_hash, reason: 'Relatório corrigido após estorno', report: corrected }, 'refund-correct-01'), c.out);
  assert.equal(c.get().body.payout.status, 'DIVERGENT'); assert.equal(c.get().body.payout.bank_transaction_id, bank.id);
  const u = res(); await unlinkPayout(request({ bank_transaction_id: bank.id, reason: 'Valor do extrato não é mais válido' }, 'refund-unlink-01'), u.out);
  assert.equal(u.get().body.payout.status, 'IMPORTED');
  const newBank = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 78, direcao: 'entrada', status: 'importada', linha_hash: `${ref}-new` });
  const matched = res(); await matchPayout(req({ bank_transaction_id: newBank.id }, { id: payout.id }), matched.out);
  assert.equal(matched.get().body.payout.status, 'MATCHED');
});
