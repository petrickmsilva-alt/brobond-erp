import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { METHODS, STATES, canFallback, PaymentError, transition } from '../modules/payments/domain/payment';
import { providerRegistry } from '../modules/payments/providers/registry';
const read = (p: string) => readFileSync(p, 'utf8');
const results: { area: string; status: string; detail: string }[] = [];
function probe(area: string, fn: () => void, detail: string) {
  try {
    fn();
    results.push({ area, status: 'PASS', detail });
  } catch (e) {
    results.push({ area, status: 'FAIL', detail: e instanceof Error ? e.message : 'Audit failure' });
  }
}
const engine = read('modules/payments/orchestration/payment-orchestrator.ts');
const sql = read('db/migrations/0069_payment_engine.sql');
const checkout = read('server/src/commerce/vitrine.ts');
const api = read('modules/payments/api/routes.ts');
probe(
  'Payment Engine',
  () => {
    assert.ok(engine.includes('class PaymentOrchestrator'));
    assert.ok(checkout.includes('paymentEngine.createForOrder'));
    assert.doesNotMatch(checkout, /from ['"][^'"]*(?:mercado-pago|pagbank|stripe|gateway)/i);
  },
  'Checkout → engine → router/registry → adapter'
);
probe(
  'Providers',
  () => {
    for (const code of ['MERCADO_PAGO', 'PAGBANK', 'STRIPE', 'MANUAL', 'PIX_DIRECT', 'ACQUIRER_GENERIC', 'BOLETO_GENERIC'] as const)
      assert.ok(providerRegistry.get(code));
  },
  'Real adapters; generic slots fail closed'
);
probe(
  'Methods / capabilities',
  () => {
    assert.equal(METHODS.length, 10);
    for (const p of providerRegistry.list()) {
      if (p.code === 'MANUAL') continue;
      assert.deepEqual(
        p.capabilities({ empresaId: 1, credentials: {}, webhookSecret: null, operationKey: 'audit', environment: 'teste' }),
        []
      );
    }
  },
  'Unconfigured external adapters never advertise a method'
);
probe(
  'Routing / fallback',
  () => {
    assert.ok(read('modules/payments/orchestration/provider-router.ts').includes('cap.currencies.includes'));
    assert.ok(canFallback(new PaymentError('RATE_LIMITED')));
    assert.equal(canFallback(new PaymentError('TIMEOUT', true)), false);
    assert.equal(canFallback(new PaymentError('FRAUD_REJECTED')), false);
  },
  'Deterministic, tenant-scoped; ambiguous writes never fall back'
);
probe(
  'Lifecycle',
  () => {
    assert.ok(STATES.includes('DISPUTED'));
    assert.equal(transition('PAID', 'PARTIALLY_REFUNDED'), 'PARTIALLY_REFUNDED');
    assert.throws(() => transition('PAID', 'PENDING'));
  },
  'Async states, manual confirmation, stale-event guard'
);
probe(
  'Idempotency',
  () => {
    assert.match(sql, /UNIQUE\(empresa_id,order_id\)/);
    assert.match(sql, /UNIQUE\(empresa_id,payment_intent_id,operation,idempotency_key\)/);
    assert.ok(engine.includes('request_hash'));
    assert.ok(engine.includes('active_operation'));
  },
  'Persistent claims, request fingerprints, provider keys'
);
probe(
  'Webhooks',
  () => {
    const w = read('server/src/gateway.ts');
    assert.ok(w.includes('payloadSeguroInbox'));
    assert.ok(w.includes('payload_hash'));
    assert.ok(w.includes('processEngineWebhook'));
    assert.ok(read('modules/payments/application/webhooks.ts').includes('assinatura_ok'));
  },
  'Existing authenticated inbox reused; only safe references retained'
);
probe(
  'Refund / reconciliation',
  () => {
    for (const t of ['payment_refunds', 'payment_disputes', 'payment_settlements'])
      assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`));
    assert.ok(engine.includes('refundDelta'));
    // Review can mark several outcomes, so the audit event is "reviewed",
    // not a blanket claim that the financial reconciliation was resolved.
    // An unresolved dispute cannot be cleared by a note and the write is CAS.
    assert.ok(api.includes("'/reconciliation/:id/resolve'"));
    assert.ok(api.includes('reconciliation reviewed'));
    assert.match(api, /b\.status === 'RESOLVED' && old\.dispute_review_required === true/);
    assert.ok(api.includes('tryUpdateIf'));
    assert.ok(read('modules/payments/application/payouts.ts').includes('export async function importPayout'));
    assert.ok(read('db/migrations/0073_payment_payouts.sql').includes('payment_payout_bank_once_uq'));
  },
  'Incremental refunds, persisted disputes and manual payout reports; automated provider ingestion remains absent'
);
probe(
  'ERP / Finance',
  () => {
    for (const symbol of ['confirmarPagamentoCobranca', 'efetuarBaixa', 'reverterFinanceiroDaCobranca']) assert.ok(engine.includes(symbol));
    assert.doesNotMatch(sql, /CREATE TABLE.*(?:ledger|vendas|sales|lancamentos_financeiros)/i);
  },
  'Canonical Commerce conversion + existing Finance; no second ledger'
);
probe(
  'RBAC / tenancy / audit',
  () => {
    assert.ok(api.includes('exigirReautenticacao(req)'));
    assert.ok(api.includes("actor.perfil!=='admin'") || api.includes("actor.perfil !== 'admin'"));
    assert.ok(api.includes('escopoDoAtor'));
    assert.match(sql, /FOREIGN KEY\s*\(empresa_id,payment_intent_id\)/);
    assert.ok(engine.includes('.audit('));
  },
  'Active company, admin step-up for credentials, existing audit'
);
probe(
  'Security',
  () => {
    assert.doesNotMatch(sql, /^\s*(pan|cvv|card_number|security_code)\s/im);
    assert.ok(engine.includes('cifrarSegredo'));
    assert.ok(api.includes('request_cifradas'));
  },
  'No PAN/CVV persistence; encrypted replay request excluded from APIs'
);
probe(
  'UX',
  () => {
    const ui = read('client/src/pages/commerce/PaymentEnginePage.tsx');
    assert.doesNotMatch(ui, /<(?:Dialog|Modal|Drawer|Sheet)\b/);
    assert.doesNotMatch(ui, /em breve|mock data|placeholder/i);
    assert.ok(read('client/src/App.tsx').includes('commerce/pagamentos/transacoes/:id'));
  },
  'Dedicated routes, no business overlays, loading/error/empty states'
);
probe(
  'Validation sources',
  () => {
    for (const f of [
      'server/test/payment-engine.test.ts',
      'server/test/pg/payment-engine.test.ts',
      'client/src/pages/commerce/PaymentEnginePage.test.tsx',
      'docs/architecture/payment-engine.md',
    ])
      assert.ok(existsSync(f));
  },
  'This checks test presence, NOT execution or external homologation'
);
let database = 'NOT_EXECUTED';
if (process.env.DATABASE_URL) {
  const { pool } = await import('../server/src/db');
  try {
    assert.ok(pool);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='empresa_id' AND table_name LIKE 'payment_%'`
    );
    const found = new Set(tables.rows.map((row: { table_name: string }) => row.table_name));
    for (const name of ['payment_intents', 'payment_attempts', 'payment_operations', 'payment_methods', 'payment_routing_rules', 'payment_refunds', 'payment_disputes', 'payment_settlements', 'payment_payouts']) assert.ok(found.has(name), `Tabela empresarial ausente: ${name}`);
    database = 'PASS';
  } catch (e) {
    database = 'FAIL';
    results.push({ area: 'Database', status: 'FAIL', detail: e instanceof Error ? e.message : 'Database audit failed' });
  } finally {
    await pool?.end();
  }
}
for (const r of results) console.log(`${r.status} ${r.area} — ${r.detail}`);
console.log(`DATABASE: ${database}`);
console.log(`CODE_STRUCTURE_READY: ${results.every((r) => r.status === 'PASS') ? 'YES' : 'NO'}`);
console.log('PROVIDER_CONFIGURED: inspect enterprise account readiness via /api/commerce/payments');
console.log('EXTERNAL_HOMOLOGATION: NO — EXTERNAL CONFIGURATION PENDING');
console.log('FULL_GO_LIVE: NO');
console.log(
  'SCOPE_GAPS: PagBank card/debit/boleto; automatic payout/fee statement ingestion; provider-specific dispute evidence submission.'
);
console.log('Structural audit does not certify these unimplemented items or replace test/build/PG gates.');
if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
