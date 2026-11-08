import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { R_EXTRATO } = await import('../src/extrato');
const { R_SETTLEMENTS, R_PAYOUTS, R_INTENTS } = await import('../../modules/payments/infrastructure/resources');
const { normalizePayout, importPayout, matchPayout } = await import('../../modules/payments/application/payouts');
const {
  configConciliacaoAutomatica,
  definirConciliacaoAutomatica,
  empresasComConciliacaoAutomatica,
  executarConciliacaoAutomatica,
  executarConciliacaoAutomaticaGlobal,
} = await import('../../modules/payments/application/conciliacaoRepasses');

const admin = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1, empresas: [1] };
const req = (body: object, params: object = {}, user = admin) => ({ body, params, user, query: {} } as any);
function res() { let body: any, status = 200; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} }; return { out, get: () => ({ body, status }) }; }
const report = (payout_reference: string, gross_amount: number) => ({ provider: 'PAGBANK', payout_reference, currency: 'BRL', settlement_date: '2028-06-10', net_amount: gross_amount - 200,
  transactions: [{ provider_reference: `T-${payout_reference}`, gross_amount, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: gross_amount - 200 }] });

/** Cria um repasse IMPORTADO (evidência + liquidação) com valor líquido conhecido. */
async function repasseImportado(ref: string, gross: number) {
  const s = getStore();
  const intent = await s.insert(R_INTENTS, { empresa_id: 1, order_id: 8000, amount: gross, status: 'PAID', provider: 'PAGBANK' });
  await s.insert(R_SETTLEMENTS, { empresa_id: 1, payment_intent_id: intent.id, provider: 'PAGBANK', provider_reference: `T-${ref}`, gross_amount: gross, refund_amount: 0, chargeback_amount: 0, status: 'UNRECONCILED', evidence: {} });
  const r = res(); await importPayout(req(report(ref, gross)), r.out);
  assert.equal(r.get().status, 201);
  assert.equal(r.get().body.payout.status, 'IMPORTED');
  return r.get().body.payout;
}

test('conciliação automática: desligada por padrão e por empresa', async () => {
  assert.deepEqual(await configConciliacaoAutomatica(4242), { habilitado: false });
  await definirConciliacaoAutomatica(4242, true, 'Admin');
  assert.deepEqual(await configConciliacaoAutomatica(4242), { habilitado: true });
  const empresas = await empresasComConciliacaoAutomatica();
  assert.ok(empresas.includes(4242));
  assert.ok(!empresas.includes(4243));
  await definirConciliacaoAutomatica(4242, false, 'Admin');
  assert.deepEqual(await configConciliacaoAutomatica(4242), { habilitado: false });
});

test('conciliação automática: casa repasse com a única linha de extrato de mesmo líquido', async () => {
  const s = getStore();
  const payout = await repasseImportado('AUTO-001', 10000);
  await s.insert(R_EXTRATO, { empresa_id: 1, valor: 98, direcao: 'entrada', status: 'importada', linha_hash: 'auto-001' });
  const r = await executarConciliacaoAutomatica(1);
  assert.equal(r.conciliados, 1);
  assert.equal(r.falhas, 0);
  const atual = await s.get(R_PAYOUTS, payout.id);
  assert.equal(atual?.status, 'MATCHED');
  assert.ok(atual?.bank_transaction_id, 'repasse vinculado à linha de extrato');
  // Idempotência: rodar de novo não concilia nada (já saiu de IMPORTED) e não duplica efeito.
  const again = await executarConciliacaoAutomatica(1);
  assert.equal(again.conciliados, 0);
});

test('conciliação automática: casamento ambíguo NÃO é decidido — fica para revisão', async () => {
  const s = getStore();
  const payout = await repasseImportado('AUTO-002', 20000);
  // Duas linhas idênticas no valor: escolher uma seria inventar evidência.
  await s.insert(R_EXTRATO, { empresa_id: 1, valor: 198, direcao: 'entrada', status: 'importada', linha_hash: 'auto-002a' });
  await s.insert(R_EXTRATO, { empresa_id: 1, valor: 198, direcao: 'entrada', status: 'importada', linha_hash: 'auto-002b' });
  const r = await executarConciliacaoAutomatica(1);
  assert.equal(r.conciliados, 0);
  assert.equal(r.ambiguos, 1);
  assert.equal((await s.get(R_PAYOUTS, payout.id))?.status, 'IMPORTED', 'repasse ambíguo permanece pendente');
});

test('conciliação automática: sem extrato correspondente, nada acontece', async () => {
  const s = getStore();
  const payout = await repasseImportado('AUTO-003', 30000);
  const r = await executarConciliacaoAutomatica(1);
  assert.equal(r.conciliados, 0);
  assert.ok(r.sem_extrato >= 1);
  assert.equal((await s.get(R_PAYOUTS, payout.id))?.status, 'IMPORTED');
});

test('conciliação automática: só enxerga extratos da própria empresa', async () => {
  const s = getStore();
  const payout = await repasseImportado('AUTO-004', 40000);
  // Extrato com o valor exato, mas de OUTRA empresa — não pode ser usado.
  await s.insert(R_EXTRATO, { empresa_id: 2, valor: 398, direcao: 'entrada', status: 'importada', linha_hash: 'auto-004-outra' });
  const r = await executarConciliacaoAutomatica(1);
  assert.equal(r.conciliados, 0);
  assert.equal((await s.get(R_PAYOUTS, payout.id))?.status, 'IMPORTED');
});

test('conciliação automática: varredura global respeita empresas habilitadas', async () => {
  const s = getStore();
  const payout = await repasseImportado('AUTO-005', 50000);
  await s.insert(R_EXTRATO, { empresa_id: 1, valor: 498, direcao: 'entrada', status: 'importada', linha_hash: 'auto-005' });
  // Sem a empresa 1 habilitada, a varredura global não concilia.
  await definirConciliacaoAutomatica(1, false, 'Admin');
  const desligada = await executarConciliacaoAutomaticaGlobal();
  assert.equal(desligada.conciliados, 0);
  assert.equal((await s.get(R_PAYOUTS, payout.id))?.status, 'IMPORTED');
  await definirConciliacaoAutomatica(1, true, 'Admin');
  const ligada = await executarConciliacaoAutomaticaGlobal();
  assert.ok(ligada.conciliados >= 1);
  assert.equal((await s.get(R_PAYOUTS, payout.id))?.status, 'MATCHED');
  await definirConciliacaoAutomatica(1, false, 'Admin');
});

test('conciliação automática: manual e automático usam o MESMO núcleo (endpoint segue funcionando)', async () => {
  const s = getStore();
  const payout = await repasseImportado('AUTO-006', 60000);
  const bank = await s.insert(R_EXTRATO, { empresa_id: 1, valor: 598, direcao: 'entrada', status: 'importada', linha_hash: 'auto-006' });
  const r = res(); await matchPayout(req({ bank_transaction_id: bank.id }, { id: payout.id }), r.out);
  assert.equal(r.get().body.payout.status, 'MATCHED');
  assert.equal(r.get().body.idempotente, false);
  assert.equal((await s.get(R_EXTRATO, bank.id))?.status, 'importada', 'conciliação não altera a escrituração bancária');
  // O validador de evidência continua o mesmo do import.
  assert.equal(normalizePayout(report('X', 10000)).hash.length, 64);
  assert.throws(() => normalizePayout(report('X', 100)));
});
