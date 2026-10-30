import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.env.DATABASE_URL) throw new Error('Closure bank exige PostgreSQL real');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate();
const { getStore } = await import('../../src/services');
const { RESOURCES } = await import('../../src/resources');
const { efetuarBaixa } = await import('../../src/financeiro');
const { importarExtrato, conciliarLinhaManual, R_EXTRATO } = await import('../../src/extrato');
const { importPayout, matchPayout } = await import('../../../modules/payments/application/payouts');
const s = getStore(); const q = pool!;
const req = (actor: any, body: object, params: object = {}) => ({ user: actor, body, params, query: {}, get: () => '' } as any);
function response() { let body: any; const out: any = { json(x: any) { body = x; return out; }, status() { return out; }, setHeader() {} }; return { out, body: () => body }; }
async function fixture(label: string) {
  const ref = `${label}-${randomUUID().slice(0, 12)}`;
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [ref])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES($1,$2,'admin',true,$3) RETURNING id", [ref, `${ref}@example.invalid`, company])).rows[0].id);
  const account = Number((await q.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [company, ref])).rows[0].id);
  return { ref, company, account, actor: { id: user, name: ref, perfil: 'admin', empresa_id: company, empresas: [company] } };
}
async function title(f: Awaited<ReturnType<typeof fixture>>, amount = 100, type = 'receita') {
  return Number((await q.query("INSERT INTO lancamentos_financeiros(empresa_id,conta_id,data,tipo,descricao,valor,status) VALUES($1,$2,'2035-05-10',$3,$4,$5,'pendente') RETURNING id", [f.company, f.account, type, f.ref, amount])).rows[0].id);
}
async function bank(f: Awaited<ReturnType<typeof fixture>>, amount = 100, direction = 'entrada') {
  return Number((await q.query("INSERT INTO fin_extrato_transacoes(empresa_id,conta_id,linha_hash,data,valor,direcao,status) VALUES($1,$2,$3,'2035-05-10',$4,$5,'importada') RETURNING id", [f.company, f.account, randomUUID(), amount, direction])).rows[0].id);
}
async function reconcile(f: Awaited<ReturnType<typeof fixture>>, bid: number, tid: number, actor = f.actor) {
  const r = response(); await conciliarLinhaManual(req(actor, { lancamento_id: tid }, { id: bid }), r.out); return r.body();
}
const ofx = (fitid: string, amount: number) => `<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20350510<TRNAMT>${amount}<FITID>${fitid}<NAME>Entrada</STMTTRN></BANKTRANLIST></OFX>`;

test('PG extrato: importação concorrente é idempotente; FITID divergente reverte arquivo inteiro e não baixa', async () => {
  const f = await fixture('bank-import'); const tid = await title(f);
  const call = async (content: string) => { const r = response(); await importarExtrato(req(f.actor, { conta_id: f.account, conteudo: content }), r.out); return r.body(); };
  const outputs = await Promise.all(Array.from({ length: 4 }, () => call(ofx(f.ref, 100))));
  assert.equal(outputs.reduce((n, x) => n + x.importadas, 0), 1);
  assert.equal(outputs.reduce((n, x) => n + x.duplicadas, 0), 3);
  assert.equal(outputs.reduce((n, x) => n + x.conciliadas, 0), 0);
  const newLine = ofx(`${f.ref}-new`, 33).replace('</BANKTRANLIST></OFX>', '') + ofx(f.ref, 101).replace('<OFX><BANKTRANLIST>', '');
  await assert.rejects(() => call(newLine), (e: any) => e.status === 409 && e.code === 'EXTRATO_IDENTIFICADOR_DIVERGENTE');
  const count = await q.query('SELECT count(*)::int AS n FROM fin_extrato_transacoes WHERE empresa_id=$1', [f.company]);
  assert.equal(count.rows[0].n, 1, 'a primeira linha do arquivo rejeitado também foi revertida');
  assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [tid])).rows[0].status, 'pendente');
});

test('PG extrato: três processos competem pela mesma linha; só um título baixa e replay é idempotente', async () => {
  const f = await fixture('bank-process'); const bid = await bank(f); const titles = await Promise.all([title(f), title(f), title(f)]);
  const worker = fileURLToPath(new URL('./_extrato-worker.ts', import.meta.url));
  const children = titles.map((tid) => fork(worker, [], { execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, CLOSURE_EXTRATO_FIXTURE: JSON.stringify({ actor: f.actor, bank: bid, title: tid }), PG_IDLE_TIMEOUT: '1000' } }));
  try {
    await Promise.all(children.map((c) => new Promise<void>((resolve, reject) => { c.on('message', (m: any) => { if (m?.type === 'ready') resolve(); }); c.once('error', reject); c.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); }); })));
    const outputs = children.map((c) => new Promise<any>((resolve, reject) => { c.on('message', (m: any) => { if (m?.type === 'result') resolve(m); }); c.once('error', reject); c.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); }); }));
    children.forEach((c) => c.send('go')); const result = await Promise.all(outputs);
    assert.equal(result.filter((r) => r.ok).length, 1); assert.ok(result.filter((r) => !r.ok).every((r) => r.status === 409));
    const rows = await q.query('SELECT id,status FROM lancamentos_financeiros WHERE id=ANY($1::int[])', [titles]);
    assert.equal(rows.rows.filter((r) => r.status === 'confirmado').length, 1);
    const line = (await q.query('SELECT lancamento_id,baixa_lancamento_id,status FROM fin_extrato_transacoes WHERE id=$1', [bid])).rows[0];
    assert.equal(line.status, 'conciliada'); assert.equal(line.lancamento_id, line.baixa_lancamento_id);
    assert.equal((await reconcile(f, bid, Number(line.lancamento_id))).idempotente, true);
  } finally { children.forEach((c) => { if (c.connected) c.disconnect(); if (!c.killed) c.kill(); }); }
});

test('PG extrato: falha de vínculo reverte baixa parcial, filho e auditoria', async () => {
  const f = await fixture('bank-rollback'); const tid = await title(f); const bid = await bank(f, 30);
  const trigger = `closure_fail_${bid}`;
  await q.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha de teste'; END $$`);
  await q.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON fin_extrato_transacoes FOR EACH ROW WHEN (OLD.id = ${bid}) EXECUTE FUNCTION ${trigger}()`);
  try { await assert.rejects(() => reconcile(f, bid, tid)); }
  finally { await q.query(`DROP TRIGGER ${trigger} ON fin_extrato_transacoes`); await q.query(`DROP FUNCTION ${trigger}()`); }
  const titleRow = (await q.query('SELECT valor,status FROM lancamentos_financeiros WHERE id=$1', [tid])).rows[0];
  assert.equal(Number(titleRow.valor), 100); assert.equal(titleRow.status, 'pendente');
  const children = await q.query("SELECT COUNT(*)::int AS n FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='baixa' AND referencia_id=$2", [f.company, tid]);
  assert.equal(children.rows[0].n, 0);
  const line = (await q.query('SELECT status,lancamento_id,baixa_lancamento_id FROM fin_extrato_transacoes WHERE id=$1', [bid])).rows[0];
  assert.equal(line.status, 'importada'); assert.equal(line.lancamento_id, null); assert.equal(line.baixa_lancamento_id, null);
  const aud = await q.query("SELECT COUNT(*)::int AS n FROM auditoria WHERE empresa_id=$1 AND recurso IN ('lancamentos_financeiros','fin_extrato_transacoes')", [f.company]);
  assert.equal(aud.rows[0].n, 0);
});

test('PG baixa: duas parciais simultâneas não perdem atualização do saldo', async () => {
  const f = await fixture('partial-race'); const tid = await title(f);
  const trigger = `closure_sleep_${tid}`;
  await q.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`);
  await q.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON lancamentos_financeiros FOR EACH ROW WHEN (OLD.id = ${tid}) EXECUTE FUNCTION ${trigger}()`);
  let result: PromiseSettledResult<any>[];
  try { result = await Promise.allSettled([efetuarBaixa(f.actor, tid, { valor: 30 }), efetuarBaixa(f.actor, tid, { valor: 30 })]); }
  finally { await q.query(`DROP TRIGGER ${trigger} ON lancamentos_financeiros`); await q.query(`DROP FUNCTION ${trigger}()`); }
  assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
  assert.ok(result.some((x) => x.status === 'rejected' && x.reason.status === 409));
  assert.equal(Number((await q.query('SELECT valor FROM lancamentos_financeiros WHERE id=$1', [tid])).rows[0].valor), 70);
  const children = await q.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(valor),0) AS amount FROM lancamentos_financeiros WHERE referencia_tipo='baixa' AND referencia_id=$1 AND empresa_id=$2", [tid, f.company]);
  assert.equal(children.rows[0].n, 1); assert.equal(Number(children.rows[0].amount), 30);
});

test('PG extrato: repasse e título competem pela linha; isolamento, direção e limites', async () => {
  const f = await fixture('bank-payout'); const other = await fixture('bank-tenant'); const bid = await bank(f, 98); const tid = await title(f, 98);
  const order = (await q.query("INSERT INTO commerce_pedidos(empresa_id,canal,pedido_externo) VALUES($1,'BROBOND',$2) RETURNING id", [f.company, f.ref])).rows[0];
  const intent = (await q.query("INSERT INTO payment_intents(empresa_id,order_id,channel,currency,amount,method,provider,status,idempotency_key,correlation_id) VALUES($1,$2,'OWN_STORE','BRL',10000,'PIX','PAGBANK','PAID',$3,$3) RETURNING id", [f.company, order.id, f.ref])).rows[0];
  await q.query("INSERT INTO payment_settlements(empresa_id,payment_intent_id,provider,provider_reference,gross_amount,status) VALUES($1,$2,'PAGBANK',$3,10000,'UNRECONCILED')", [f.company, intent.id, f.ref]);
  const report = { provider: 'PAGBANK', payout_reference: f.ref, settlement_date: '2035-05-10', net_amount: 9800, transactions: [{ provider_reference: f.ref, gross_amount: 10000, provider_fee: 200, net_amount: 9800 }] };
  const p = response(); await importPayout(req(f.actor, report), p.out); const pid = Number(p.body().payout.id);
  const result = await Promise.allSettled([reconcile(f, bid, tid), matchPayout(req(f.actor, { bank_transaction_id: bid }, { id: pid }), response().out)]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(result.some((r) => r.status === 'rejected' && r.reason.status === 409));
  const row = (await q.query('SELECT status,lancamento_id FROM fin_extrato_transacoes WHERE id=$1', [bid])).rows[0];
  const payout = (await q.query('SELECT bank_transaction_id FROM payment_payouts WHERE id=$1', [pid])).rows[0];
  assert.notEqual(Boolean(row.lancamento_id), Boolean(payout.bank_transaction_id));
  await assert.rejects(() => reconcile(f, bid, tid, other.actor), (e: any) => e.status === 404);
  const wrongDirection = await bank(f, 20, 'saida'); const foreignTitle = await title(other, 20);
  await assert.rejects(() => reconcile(f, wrongDirection, foreignTitle), (e: any) => e.status === 404);
  const receipt = await title(f, 20); await assert.rejects(() => reconcile(f, wrongDirection, receipt), (e: any) => e.status === 409);
  const high = await bank(f, 21); await assert.rejects(() => reconcile(f, high, receipt), (e: any) => e.status === 409);
});

test('PG extrato: cada parcial aponta a efeito único, FK de empresa e check são impostos pelo banco', async () => {
  const f = await fixture('bank-constraint'); const other = await fixture('bank-fk'); const tid = await title(f); const a = await bank(f, 30); const b = await bank(f, 40);
  const ar = await reconcile(f, a, tid); const br = await reconcile(f, b, tid);
  assert.ok(ar.parcial && br.parcial); assert.notEqual(ar.baixa_lancamento_id, br.baixa_lancamento_id);
  assert.equal(Number((await q.query('SELECT valor FROM lancamentos_financeiros WHERE id=$1', [tid])).rows[0].valor), 30);
  const c = await bank(f, 10); const foreign = await title(other, 10);
  await assert.rejects(() => q.query("UPDATE fin_extrato_transacoes SET status='conciliada',lancamento_id=$2,baixa_lancamento_id=$3 WHERE id=$1", [c, tid, ar.baixa_lancamento_id]), (e: any) => e.code === '23505');
  await assert.rejects(() => q.query("UPDATE fin_extrato_transacoes SET status='conciliada',lancamento_id=$2,baixa_lancamento_id=$3 WHERE id=$1", [c, tid, foreign]), (e: any) => e.code === '23503');
  await assert.rejects(() => q.query('UPDATE fin_extrato_transacoes SET baixa_lancamento_id=$2 WHERE id=$1', [c, tid]), (e: any) => e.code === '23514');
  assert.equal((await s.get(R_EXTRATO, c))?.status, 'importada');
});

test('PG extrato: CSV legado sem direção não duplica; saída histórica com direção errada é divergente', async () => {
  const { hashLinhaExtrato } = await import('../../src/extrato'); const f = await fixture('legacy-csv');
  for (const description of ['entrada antiga', 'saida antiga']) {
    const hash = hashLinhaExtrato({ data: '2035-05-10', valor: 25, descricao: description });
    await q.query("INSERT INTO fin_extrato_transacoes(empresa_id,conta_id,linha_hash,data,valor,direcao,descricao,status) VALUES($1,$2,$3,'2035-05-10',25,'entrada',$4,'importada')", [f.company, f.account, hash, description]);
  }
  const call = async (content: string) => { const r = response(); await importarExtrato(req(f.actor, { conta_id: f.account, conteudo: content }), r.out); return r.body(); };
  await assert.rejects(() => call('2035-05-10;25.00;entrada antiga'), (e: any) => e.status === 409 && e.code === 'EXTRATO_SEM_IDENTIFICADOR_AMBIGUO');
  await assert.rejects(() => call('2035-05-10;-25.00;saida antiga'), (e: any) => e.status === 409 && e.code === 'EXTRATO_IDENTIFICADOR_DIVERGENTE');
  assert.equal(Number((await q.query('SELECT count(*) FROM fin_extrato_transacoes WHERE empresa_id=$1', [f.company])).rows[0].count), 2);
});

test('PG + HTTP extrato: sessão, perfil e empresa são impostos antes da baixa e detalhe', async () => {
  const { default: express } = await import('express'); const { default: request } = await import('supertest');
  const { requireAuth, signToken } = await import('../../src/auth'); const { abrirSessao } = await import('../../src/sessoes');
  const { detalheExtrato, listarExtrato, marcarDivergencia } = await import('../../src/extrato');
  const app = express(); app.use(express.json()); app.use('/api', (r, s, next) => { void requireAuth(r, s, next).catch(next); });
  const wrap = (fn: any) => (r: any, s: any, next: any) => { void fn(r, s).catch(next); };
  app.get('/api/financeiro/extrato', wrap(listarExtrato)); app.get('/api/financeiro/extrato/:id', wrap(detalheExtrato));
  app.post('/api/financeiro/extrato/:id/conciliar', wrap(conciliarLinhaManual)); app.post('/api/financeiro/extrato/:id/divergir', wrap(marcarDivergencia));
  app.use((e: any, _r: any, s: any, _n: any) => s.status(e.status || 500).json({ error: e.message }));
  const f = await fixture('bank-http-a'); const b = await fixture('bank-http-b'); const tid = await title(f); const bid = await bank(f); const foreignTitle = await title(b);
  const operator = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Operador',$1,'operador',true,$2) RETURNING id", [`operator-${randomUUID()}@example.invalid`, f.company])).rows[0].id);
  async function token(uid: number, profile: 'admin' | 'operador', company: number) {
    const sid = await abrirSessao({ usuarioId: uid, lembrar: false, req: { headers: {}, socket: {} } as any });
    return signToken({ id: uid, name: 'Teste', perfil: profile }, { sid, emp: company });
  }
  const a = await token(f.actor.id, 'admin', f.company); const outsider = await token(b.actor.id, 'admin', b.company); const op = await token(operator, 'operador', f.company);
  const url = `/api/financeiro/extrato/${bid}`;
  await request(app).get(url).expect(401);
  await request(app).post(`${url}/conciliar`).set('Authorization', `Bearer ${op}`).send({ lancamento_id: tid }).expect(403);
  await request(app).get(url).set('Authorization', `Bearer ${outsider}`).expect(404);
  await request(app).post(`${url}/conciliar`).set('Authorization', `Bearer ${a}`).send({ lancamento_id: foreignTitle }).expect(404);
  const first = await request(app).post(`${url}/conciliar`).set('Authorization', `Bearer ${a}`).send({ lancamento_id: tid }).expect(200);
  assert.equal(first.body.baixa_lancamento_id, tid);
  const replay = await request(app).post(`${url}/conciliar`).set('Authorization', `Bearer ${a}`).send({ lancamento_id: tid }).expect(200);
  assert.equal(replay.body.idempotente, true);
  const detail = await request(app).get(url).set('Authorization', `Bearer ${a}`).expect(200);
  assert.equal(detail.headers['cache-control'], 'private, no-store'); assert.equal(detail.body.linha.status, 'conciliada');
  const list = await request(app).get('/api/financeiro/extrato?page=1&pageSize=2').set('Authorization', `Bearer ${a}`).expect(200);
  assert.equal(list.headers['cache-control'], 'private, no-store'); assert.equal(list.body.linhas.length, 1);
  await request(app).get('/api/financeiro/extrato?page=NaN').set('Authorization', `Bearer ${a}`).expect(400);
  const divergent = await bank(f, 5); const durl = `/api/financeiro/extrato/${divergent}/divergir`;
  await request(app).post(durl).set('Authorization', `Bearer ${a}`).send({ motivo: 'Revisão necessária' }).expect(200);
  const repeated = await request(app).post(durl).set('Authorization', `Bearer ${a}`).send({ motivo: 'Revisão necessária' }).expect(200);
  assert.equal(repeated.body.idempotente, true);
  await request(app).post(durl).set('Authorization', `Bearer ${a}`).send({ motivo: 'Motivo diferente' }).expect(409);
});

test('PG extrato: dado inválido, linhas idênticas sem ID e FITIDs que só diferem em caixa não são importados silenciosamente', async () => {
  const f = await fixture('bank-parse');
  const call = async (content: string) => { const r = response(); await importarExtrato(req(f.actor, { conta_id: f.account, conteudo: content }), r.out); return r.body(); };
  const count = async () => Number((await q.query('SELECT count(*) FROM fin_extrato_transacoes WHERE empresa_id=$1', [f.company])).rows[0].count);
  await assert.rejects(() => call('2035-05-10;12,34;Válido\n2035-02-30;1;Inválido'), (e: any) => e.status === 400); assert.equal(await count(), 0);
  await assert.rejects(() => call('2035-05-10;12,34;Idêntica\n2035-05-10;12,34;Idêntica'), (e: any) => e.status === 409 && e.code === 'EXTRATO_ARQUIVO_AMBIGUO'); assert.equal(await count(), 0);
  const inserted = await call('2035-05-10;12,34;Real'); assert.equal(inserted.importadas, 1);
  assert.equal(Number((await q.query('SELECT valor FROM fin_extrato_transacoes WHERE empresa_id=$1', [f.company])).rows[0].valor), 12.34);
  await assert.rejects(() => call('2035-05-10;12,34;Real'), (e: any) => e.status === 409 && e.code === 'EXTRATO_SEM_IDENTIFICADOR_AMBIGUO'); assert.equal(await count(), 1);
  await call(ofx('AbC-Bank', 10));
  await assert.rejects(() => call(ofx('abc-bank', 10)), (e: any) => e.status === 409 && e.code === 'EXTRATO_IDENTIFICADOR_DIVERGENTE'); assert.equal(await count(), 2);
});

test('PG financeiro: referências de outra empresa não alteram conta, origem ou categorias na baixa e criação manual', async () => {
  const { baixarLancamento, criarLancamentoManual, syncLancamentoVenda } = await import('../../src/financeiro');
  const a = await fixture('fin-tenant-a'); const b = await fixture('fin-tenant-b'); const id = await title(a);
  const catB = Number((await q.query("INSERT INTO categorias_financeiras(empresa_id,nome,tipo,classificacao_dre) VALUES($1,$2,'receita','receitas_financeiras') RETURNING id", [b.company, b.ref])).rows[0].id);
  const catA = Number((await q.query("INSERT INTO categorias_financeiras(empresa_id,nome,tipo,classificacao_dre) VALUES($1,$2,'receita','receitas_financeiras') RETURNING id", [a.company, a.ref])).rows[0].id);
  await assert.rejects(() => baixarLancamento(req(a.actor, { conta_id: b.account }, { id }), response().out), (e: any) => e.status === 404);
  assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [id])).rows[0].status, 'pendente');
  for (const data of [{ conta_id: b.account }, { categoria_id: catB }])
    await assert.rejects(() => criarLancamentoManual(req(a.actor, { ...data, descricao: 'manual', tipo: 'receita', valor: 10 }), response().out), (e: any) => e.status === 404);
  const saleB = Number((await q.query("INSERT INTO vendas(empresa_id,status,total,fin_status,data) VALUES($1,'faturada',50,'a_receber','2035-05-10') RETURNING id", [b.company])).rows[0].id);
  await assert.rejects(() => criarLancamentoManual(req(a.actor, { descricao: 'forjado', tipo: 'receita', valor: 10, referencia_tipo: 'venda', referencia_id: saleB }), response().out), (e: any) => e.status === 400);
  const forged = Number((await q.query("INSERT INTO lancamentos_financeiros(empresa_id,conta_id,data,tipo,descricao,valor,status,referencia_tipo,referencia_id) VALUES($1,$2,'2035-05-10','receita','forjado',50,'pendente','venda',$3) RETURNING id", [a.company, a.account, saleB])).rows[0].id);
  await assert.rejects(() => efetuarBaixa(a.actor, forged, {}), (e: any) => e.status === 409);
  assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [forged])).rows[0].status, 'pendente');
  assert.equal((await q.query('SELECT fin_status FROM vendas WHERE id=$1', [saleB])).rows[0].fin_status, 'a_receber');
  const saleRow = await s.get(RESOURCES.vendas, saleB); await s.transaction((tx) => syncLancamentoVenda(null, saleRow!, {}, b.actor, tx));
  const titleB = await q.query("SELECT id FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='venda' AND referencia_id=$2", [b.company, saleB]);
  assert.equal(titleB.rowCount, 1, 'título forjado da empresa A não interfere na origem da empresa B');
  const low = await efetuarBaixa(a.actor, id, { juros: 3 });
  const child = (await q.query('SELECT empresa_id,categoria_id FROM lancamentos_financeiros WHERE id=$1', [low.filhos[0]])).rows[0];
  assert.equal(Number(child.empresa_id), a.company); assert.equal(Number(child.categoria_id), catA);
});

test('PG financeiro: caixa usa data da baixa comprovada, preserva data original e não inventa data ausente', async () => {
  const { resumoFinanceiro, baixarLancamento } = await import('../../src/financeiro');
  const f = await fixture('bank-date'); const tid = await title(f); const bid = await bank(f); const today = new Date().toISOString().slice(0, 10);
  await q.query("UPDATE lancamentos_financeiros SET data='2000-01-01' WHERE id=$1", [tid]);
  await q.query('UPDATE fin_extrato_transacoes SET data=$1 WHERE id=$2', [today, bid]);
  await reconcile(f, bid, tid);
  const saved = (await q.query('SELECT data::text,data_baixa::text FROM lancamentos_financeiros WHERE id=$1', [tid])).rows[0];
  assert.equal(saved.data, '2000-01-01'); assert.equal(saved.data_baixa, today);
  const responseSummary = response(); await resumoFinanceiro(req(f.actor, {}), responseSummary.out);
  assert.equal(responseSummary.body().receitasMes, 100); assert.equal(responseSummary.body().recentes[0].data, today);
  assert.equal((await reconcile(f, bid, tid)).idempotente, true);
  await q.query("UPDATE lancamentos_financeiros SET data_baixa='2001-01-01' WHERE id=$1", [tid]);
  await assert.rejects(() => reconcile(f, bid, tid), (e: any) => e.status === 409);
  const undated = await bank(f, 10); const second = await title(f, 10);
  await q.query('UPDATE fin_extrato_transacoes SET data=NULL WHERE id=$1', [undated]);
  await assert.rejects(() => reconcile(f, undated, second), (e: any) => e.status === 409 && /sem data/.test(e.message));
  await assert.rejects(() => baixarLancamento(req(f.actor, { data: '2035-02-31' }, { id: second }), response().out), (e: any) => e.status === 400);
  assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [second])).rows[0].status, 'pendente');
});
