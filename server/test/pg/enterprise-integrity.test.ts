import { test } from 'node:test';
import assert from 'node:assert/strict';
const skip = process.env.DATABASE_URL ? false : 'requer PostgreSQL real';
process.env.NODE_ENV = 'test';
const actor = { id: 0, name: 'Teste PG', perfil: 'admin', empresa_id: 1, empresas: [1] };
function req(body: object, params: object = {}, user: object = actor) { return { body, params, user, query: {} } as any; }
function res() { let body: any, status = 200; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; } }; return { out, get: () => ({ body, status }) }; }
async function boot() { const db = await import('../../src/db'); await db.migrate(); return db; }

test('PG foundation: enqueue concorrente único e fencing rejeita worker antigo após nova lease', { skip }, async () => {
  const { query } = await boot(); const { enfileirarOutbox } = await import('../../src/commerce/outbox');
  const { getStore } = await import('../../src/services'); const { RESOURCES } = await import('../../src/resources');
  const key = `pg-fencing-${Date.now()}`;
  const created = await Promise.all(Array.from({ length: 8 }, () => enfileirarOutbox(1, 'alerta', key, { segredo: 'não logar' })));
  assert.equal(new Set(created.map((x) => x.id)).size, 1);
  const id = Number(created[0].id), s = getStore(), r = RESOURCES.commerce_outbox;
  const first = await s.tryUpdateIf(r, id, { estado: 'PENDENTE', claim_versao: 0 }, { estado: 'PROCESSANDO', claim_versao: 1, tentativas: 1 });
  assert.ok(first);
  await query("UPDATE commerce_outbox SET estado='PENDENTE', tentativas=0 WHERE id=$1", [id]);
  const second = await s.tryUpdateIf(r, id, { estado: 'PENDENTE', claim_versao: 1 }, { estado: 'PROCESSANDO', claim_versao: 2, tentativas: 1 });
  assert.ok(second);
  assert.equal(await s.tryUpdateIf(r, id, { estado: 'PROCESSANDO', claim_versao: 1 }, { estado: 'PROCESSADO' }), null);
  assert.ok(await s.tryUpdateIf(r, id, { estado: 'PROCESSANDO', claim_versao: 2 }, { estado: 'PROCESSADO' }));
  await query('DELETE FROM commerce_outbox WHERE id=$1', [id]);
});

test('PG contábil: importações concorrentes idempotentes, período fechado e replay', { skip }, async () => {
  const { query } = await boot(); const { confirmarImportacaoContabil } = await import('../../src/financeiroImportacao');
  const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const codigo = String(Date.now()).slice(-8);
  await query(`INSERT INTO plano_contas (empresa_id, codigo, nome, natureza, tipo) VALUES (1,$1,'PG ativo','ativo','analitica'),(1,$2,'PG receita','receita','analitica')`, [`a${codigo}`, `b${codigo}`]);
  const lote = { competencia: '2034-05', entradas: [{ data: '2034-05-02', historico: `PG ${codigo}`, partidas: [{ conta: `a${codigo}`, natureza: 'debito', valor: 11 }, { conta: `b${codigo}`, natureza: 'credito', valor: 11 }] }] };
  const runs = await Promise.all(Array.from({ length: 4 }, async () => { const r = res(); await confirmarImportacaoContabil(req(lote), r.out); return r.get(); }));
  assert.equal(runs.filter((x) => x.status === 201).length, 1);
  assert.equal(new Set(runs.map((x) => x.body.importacao_id)).size, 1);
  await alterarPeriodo(req({ motivo: 'Fechamento de teste' }, { competencia: '2034-05', acao: 'fechar' }), res().out);
  const replay = res(); await confirmarImportacaoContabil(req(lote), replay.out); assert.equal(replay.get().body.idempotente, true);
  await assert.rejects(() => confirmarImportacaoContabil(req({ ...lote, entradas: [{ ...lote.entradas[0], historico: 'outro' }] }), res().out), (e: any) => e.status === 409);
});

test('PG WMS: FK composta rejeita local pai de outra empresa', { skip }, async () => {
  const { query } = await boot(); const suf = `${Date.now()}-${process.pid}`;
  const company = (await query('INSERT INTO empresas (nome, ativo) VALUES ($1,true) RETURNING id', [`WMS ${suf}`])).rows[0];
  const parent = (await query("INSERT INTO locais (empresa_id,nome,tipo,nivel_wms) VALUES ($1,$2,'loja','armazem') RETURNING id", [company.id, `WMS ${suf}`])).rows[0];
  await assert.rejects(() => query("INSERT INTO locais (empresa_id,nome,tipo,nivel_wms,local_pai_id) VALUES (1,$1,'loja','zona',$2)", [`WMS cross ${suf}`, parent.id]), (e: any) => e.code === '23503');
  await query('DELETE FROM locais WHERE id=$1', [parent.id]); await query('DELETE FROM empresas WHERE id=$1', [company.id]);
});

test('PG payment: repasse idempotente e extrato conciliado sem alterar livro financeiro', { skip }, async () => {
  const { query } = await boot(); const { importPayout, matchPayout } = await import('../../../modules/payments/application/payouts');
  const k = `pg-${Date.now()}-${process.pid}`;
  const order = (await query("INSERT INTO commerce_pedidos (empresa_id,canal,pedido_externo) VALUES (1,'BROBOND',$1) RETURNING id", [k])).rows[0];
  const intent = (await query(`INSERT INTO payment_intents (empresa_id,order_id,channel,currency,amount,method,provider,status,idempotency_key,correlation_id) VALUES (1,$1,'OWN_STORE','BRL',10000,'PIX','PAGBANK','PAID',$2,$2) RETURNING id`, [order.id, k])).rows[0];
  await query("INSERT INTO payment_settlements (empresa_id,payment_intent_id,provider,provider_reference,gross_amount,status) VALUES (1,$1,'PAGBANK',$2,10000,'UNRECONCILED')", [intent.id, k]);
  const body = { provider: 'PAGBANK', payout_reference: k, currency: 'BRL', settlement_date: '2034-05-02', net_amount: 9800, transactions: [{ provider_reference: k, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
  const results = await Promise.all(Array.from({ length: 4 }, async () => { const r = res(); await importPayout(req(body), r.out); return r.get(); }));
  assert.equal(results.filter((x) => x.status === 201).length, 1); assert.equal(new Set(results.map((x) => x.body.payout.id)).size, 1);
  const payoutId = results[0].body.payout.id;
  const bank = (await query("INSERT INTO fin_extrato_transacoes (empresa_id,linha_hash,valor,direcao,status) VALUES (1,$1,98,'entrada','importada') RETURNING id", [k])).rows[0];
  const matched = res(); await matchPayout(req({ bank_transaction_id: Number(bank.id) }, { id: payoutId }), matched.out);
  assert.equal(matched.get().body.payout.status, 'MATCHED');
  assert.equal((await query('SELECT status FROM fin_extrato_transacoes WHERE id=$1', [bank.id])).rows[0].status, 'importada');
  assert.equal((await query('SELECT status FROM payment_settlements WHERE payment_intent_id=$1', [intent.id])).rows[0].status, 'MATCHED');
});

test('PG outbox: leitura genérica esconde payload mas worker interno ainda o recebe', { skip }, async () => {
  const { query } = await boot(); const { enfileirarOutbox } = await import('../../src/commerce/outbox');
  const { listRecords, getRecord, getStore } = await import('../../src/services'); const { RESOURCES } = await import('../../src/resources');
  const row = await enfileirarOutbox(1, 'alerta', `redact-${Date.now()}-${process.pid}`, { segredo: 'fixture-privada' });
  const scope = { kind: 'empresa', empresaId: 1 } as const;
  const list = await listRecords(RESOURCES.commerce_outbox, { page: 1, pageSize: 100, filter: { id: Number(row.id) } }, scope);
  assert.equal(list.rows[0]?.payload, undefined);
  assert.equal((await getRecord(RESOURCES.commerce_outbox, Number(row.id), scope)).payload, undefined);
  assert.equal((await getStore().findOneWhere(RESOURCES.commerce_outbox, { empresa_id: 1, id: Number(row.id) }))?.payload.segredo, 'fixture-privada');
  await query('DELETE FROM commerce_outbox WHERE id=$1', [row.id]);
});

test('PG auditoria: verifica além de 100 mil eventos, sem falso OK por truncamento', { skip }, async () => {
  const { query } = await boot(); const { getStore } = await import('../../src/services');
  const marker = `teste-volume-${process.pid}-${Date.now()}`;
  const before = Number((await query('SELECT COUNT(*) AS n FROM auditoria')).rows[0].n);
  try {
    await query(`INSERT INTO auditoria (usuario, acao, recurso, descricao, empresa_id, hash_versao)
      SELECT 'Fixture', 'ajuste', $1, 'teste não assinado', 1, 1 FROM generate_series(1, 100001)`, [marker]);
    const result = await getStore().verificarAuditoria();
    assert.equal(result.total, before + 100001);
    assert.equal(result.ok, false);
    assert.ok(result.quebras.length >= 100001);
  } finally {
    await query('DELETE FROM auditoria WHERE recurso = $1', [marker]);
  }
});

async function seedPayoutPayment(ref: string) {
  const { query } = await boot(); const { importPayout } = await import('../../../modules/payments/application/payouts');
  const order = (await query("INSERT INTO commerce_pedidos (empresa_id,canal,pedido_externo) VALUES (1,'BROBOND',$1) RETURNING id", [ref])).rows[0];
  const intent = (await query(`INSERT INTO payment_intents (empresa_id,order_id,channel,currency,amount,method,provider,status,idempotency_key,correlation_id)
    VALUES (1,$1,'OWN_STORE','BRL',10000,'PIX','PAGBANK','PAID',$2,$2) RETURNING id`, [order.id, ref])).rows[0];
  await query(`INSERT INTO payment_attempts (empresa_id,payment_intent_id,provider,provider_transaction_id,method,requested_amount,authorized_amount,captured_amount,refunded_amount,status,idempotency_key,correlation_id)
    VALUES (1,$1,'PAGBANK',$2,'PIX',10000,10000,10000,0,'PAID',$2,$2)`, [intent.id, ref]);
  await query("INSERT INTO payment_settlements (empresa_id,payment_intent_id,provider,provider_reference,gross_amount,status) VALUES (1,$1,'PAGBANK',$2,10000,'UNRECONCILED')", [intent.id, ref]);
  const report = { provider: 'PAGBANK', payout_reference: ref, currency: 'BRL', settlement_date: '2035-01-02', net_amount: 9800,
    transactions: [{ provider_reference: ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
  const r = res(); await importPayout(req(report), r.out);
  const bank = (await query("INSERT INTO fin_extrato_transacoes (empresa_id,linha_hash,valor,direcao,status) VALUES (1,$1,98,'entrada','importada') RETURNING id", [ref])).rows[0];
  return { intentId: Number(intent.id), payoutId: Number(r.get().body.payout.id), bankId: Number(bank.id) };
}

test('PG payment: estorno integral comprovado invalida repasse e mantém vínculo histórico', { skip }, async () => {
  const { query } = await boot(); const { matchPayout } = await import('../../../modules/payments/application/payouts');
  const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
  const ref = `pg-total-refund-${Date.now()}-${process.pid}`; const x = await seedPayoutPayment(ref);
  await matchPayout(req({ bank_transaction_id: x.bankId }, { id: x.payoutId }), res().out);
  await paymentEngine.apply(1, x.intentId, { reference: ref, status: 'REFUNDED', refunded: 10000 });
  const payout = (await query('SELECT status, bank_transaction_id FROM payment_payouts WHERE id=$1', [x.payoutId])).rows[0];
  const settlement = (await query('SELECT status, refund_amount FROM payment_settlements WHERE payment_intent_id=$1', [x.intentId])).rows[0];
  const attempt = (await query('SELECT status, refunded_amount FROM payment_attempts WHERE payment_intent_id=$1', [x.intentId])).rows[0];
  assert.equal(payout.status, 'DIVERGENT'); assert.equal(Number(payout.bank_transaction_id), x.bankId);
  assert.equal(settlement.status, 'DIVERGENT'); assert.equal(Number(settlement.refund_amount), 10000);
  assert.equal(attempt.status, 'REFUNDED'); assert.equal(Number(attempt.refunded_amount), 10000);
});

test('PG payment: conciliação concorrente com estorno parcial nunca termina falsamente MATCHED', { skip }, async () => {
  const { query } = await boot(); const { matchPayout } = await import('../../../modules/payments/application/payouts');
  const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
  for (let run = 0; run < 5; run++) {
    const ref = `pg-race-${Date.now()}-${process.pid}-${run}`; const x = await seedPayoutPayment(ref);
    const [match, refund] = await Promise.allSettled([
      matchPayout(req({ bank_transaction_id: x.bankId }, { id: x.payoutId }), res().out),
      paymentEngine.apply(1, x.intentId, { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 2000 }),
    ]);
    if (match.status === 'rejected') assert.ok(match.reason?.status === 409 || match.reason?.code === '40001', `falha inesperada no match: ${match.reason}`);
    if (refund.status === 'rejected') {
      assert.equal(refund.reason?.code, '40001');
      // Como o worker de webhook faz após aborto de serialização, reprocessar.
      await paymentEngine.apply(1, x.intentId, { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 2000 });
    }
    const payout = (await query('SELECT status FROM payment_payouts WHERE id=$1', [x.payoutId])).rows[0];
    const settlement = (await query('SELECT status, refund_amount FROM payment_settlements WHERE payment_intent_id=$1', [x.intentId])).rows[0];
    assert.equal(payout.status, 'DIVERGENT'); assert.equal(settlement.status, 'DIVERGENT'); assert.equal(Number(settlement.refund_amount), 2000);
  }
});

test('PG payment: importação concorrente com estorno não conserva repasse não divergente', { skip }, async () => {
  const { query } = await boot(); const { importPayout } = await import('../../../modules/payments/application/payouts');
  const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
  for (let run = 0; run < 5; run++) {
    const ref = `pg-import-refund-${Date.now()}-${process.pid}-${run}`;
    const order = (await query("INSERT INTO commerce_pedidos (empresa_id,canal,pedido_externo) VALUES (1,'BROBOND',$1) RETURNING id", [ref])).rows[0];
    const intent = (await query(`INSERT INTO payment_intents (empresa_id,order_id,channel,currency,amount,method,provider,status,idempotency_key,correlation_id)
      VALUES (1,$1,'OWN_STORE','BRL',10000,'PIX','PAGBANK','PAID',$2,$2) RETURNING id`, [order.id, ref])).rows[0];
    await query(`INSERT INTO payment_attempts (empresa_id,payment_intent_id,provider,provider_transaction_id,method,requested_amount,authorized_amount,captured_amount,refunded_amount,status,idempotency_key,correlation_id)
      VALUES (1,$1,'PAGBANK',$2,'PIX',10000,10000,10000,0,'PAID',$2,$2)`, [intent.id, ref]);
    await query("INSERT INTO payment_settlements (empresa_id,payment_intent_id,provider,provider_reference,gross_amount,status) VALUES (1,$1,'PAGBANK',$2,10000,'UNRECONCILED')", [intent.id, ref]);
    const report = { provider: 'PAGBANK', payout_reference: ref, currency: 'BRL', settlement_date: '2035-01-02', net_amount: 9800,
      transactions: [{ provider_reference: ref, gross_amount: 10000, provider_fee: 200, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 9800 }] };
    const [imported, refunded] = await Promise.allSettled([
      importPayout(req(report), res().out),
      paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 2000 }),
    ]);
    if (imported.status === 'rejected') assert.ok(imported.reason?.status === 409 || imported.reason?.code === '40001');
    if (refunded.status === 'rejected') {
      assert.equal(refunded.reason?.code, '40001');
      await paymentEngine.apply(1, Number(intent.id), { reference: ref, status: 'PARTIALLY_REFUNDED', refunded: 2000 });
    }
    const settlement = (await query('SELECT status, refund_amount, payout_id FROM payment_settlements WHERE payment_intent_id=$1', [intent.id])).rows[0];
    assert.equal(Number(settlement.refund_amount), 2000);
    if (settlement.payout_id) {
      assert.equal(settlement.status, 'DIVERGENT');
      assert.equal((await query('SELECT status FROM payment_payouts WHERE id=$1', [settlement.payout_id])).rows[0].status, 'DIVERGENT');
    }
  }
});
