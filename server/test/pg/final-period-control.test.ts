import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const skip = process.env.DATABASE_URL ? false : 'requer PostgreSQL real';
const req = (company: number, competencia: string, acao: string, perfil = 'admin') => ({
  user: { id: 0, name: 'Teste período', perfil, empresa_id: company, empresas: [company] },
  params: { competencia, acao }, body: { motivo: 'Fechamento validado para teste' }, query: {},
}) as any;
function res() { let body: any; const out: any = { json(v: any) { body = v; return out; } }; return { out, get: () => body }; }
async function fixture() {
  const db = await import('../../src/db'); await db.migrate();
  const row = (await db.query("INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id", [`Período PG ${Date.now()}-${Math.random()}`])).rows[0];
  return { ...db, company: Number(row.id) };
}
async function waitForLock(query: any, pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid]);
    if (r.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('A segunda sessão não aguardou a trava do período.');
}

test('PG período financeiro: pendências bloqueiam; baixa canônica, reabertura, isolamento e auditoria', { skip }, async () => {
  const { query, company } = await fixture();
  const { alterarPeriodo, obterPeriodo } = await import('../../src/financeiroPeriodos');
  const { conciliarExtratoComLancamento } = await import('../../src/extrato');
  const other = (await query("INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id", [`Outra empresa período ${company}`])).rows[0].id;
  const account = (await query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [company, `Conta período ${company}`])).rows[0].id;
  const entry = (await query(`INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor,status,conta_id)
    VALUES($1,'2037-03-05','receita','Título real da prova',100,'pendente',$2) RETURNING id`, [company, account])).rows[0].id;
  const bank = (await query(`INSERT INTO fin_extrato_transacoes(empresa_id,conta_id,linha_hash,data,valor,direcao,status)
    VALUES($1,$2,'period-test','2037-03-06',100,'entrada','importada') RETURNING id`, [company, account])).rows[0].id;
  const blocked = await assert.rejects(() => alterarPeriodo(req(company, '2037-03', 'fechar'), res().out), (e: any) => e.status === 409 && e.code === 'CLOSE_BLOCKED' && e.details.pendencias.extratos === 1);
  assert.equal(blocked, undefined);
  const details = res(); await obterPeriodo(req(company, '2037-03', 'fechar'), details.out);
  assert.equal(details.get().estado, 'aberto'); assert.equal(details.get().pendencias.extratos, 1);
  await conciliarExtratoComLancamento(company, Number(bank), Number(entry), { id: null, name: 'Teste período' }, 'extrato', 'conciliação de teste');
  const close = res(); await alterarPeriodo(req(company, '2037-03', 'fechar'), close.out);
  assert.equal(close.get().periodo.estado, 'fechado'); assert.equal(close.get().periodo.abrangencia, 'financeiro');
  const replay = res(); await alterarPeriodo(req(company, '2037-03', 'fechar'), replay.out); assert.equal(replay.get().idempotente, true);
  for (const [sql, args] of [
    ["INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor) VALUES($1,'2037-03-07','receita','Fechado',1)", [company]],
    ["UPDATE lancamentos_financeiros SET valor=99 WHERE empresa_id=$1 AND id=$2", [company, entry]],
    ["DELETE FROM lancamentos_financeiros WHERE empresa_id=$1 AND id=$2", [company, entry]],
    ["UPDATE fin_extrato_transacoes SET data='2037-04-01' WHERE empresa_id=$1 AND id=$2", [company, bank]],
  ] as [string, any[]][]) await assert.rejects(() => query(sql, args), (e: any) => e.code === 'P2001');
  await query("INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor) VALUES($1,'2037-03-07','receita','Outra empresa',1)", [other]);
  await query("INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor) VALUES($1,'2037-04-07','receita','Outro mês',1)", [company]);
  await assert.rejects(() => alterarPeriodo(req(company, '2037-03', 'reabrir', 'gerente'), res().out), (e: any) => e.status === 403);
  await alterarPeriodo(req(company, '2037-03', 'reabrir'), res().out);
  await query("UPDATE lancamentos_financeiros SET descricao='Revisado após reabertura' WHERE id=$1 AND empresa_id=$2", [entry, company]);
  const audits = await query("SELECT dados FROM auditoria WHERE empresa_id=$1 AND recurso='fin_periodos_contabeis' ORDER BY id", [company]);
  assert.deepEqual(audits.rows.map((r: any) => r.dados.depois.estado), ['fechando', 'fechado', 'aberto']);
});

test('PG período financeiro: movimento que espera fechamento não é gravado', { skip, timeout: 30000 }, async () => {
  const { pool, query, company } = await fixture();
  const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const { getStore } = await import('../../src/services');
  const store = getStore(); const originalAudit = store.audit.bind(store);
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  store.audit = async (event, tx) => {
    await originalAudit(event, tx);
    if (event.recurso === 'fin_periodos_contabeis' && (event.dados as any)?.depois?.estado === 'fechando') { entered(); await gate; }
  };
  const client = await pool.connect();
  try {
    const closing = alterarPeriodo(req(company, '2037-04', 'fechar'), res().out);
    await started;
    const writer = client.query("INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor) VALUES($1,'2037-04-03','receita','Corrida',1)", [company]);
    const outcome = writer.then(() => null, (e: any) => e);
    await waitForLock(query, client.processID);
    release(); await closing;
    const error = await outcome; assert.equal(error?.code, 'P2001');
    const n = await query("SELECT count(*)::int AS n FROM lancamentos_financeiros WHERE empresa_id=$1", [company]); assert.equal(n.rows[0].n, 0);
  } finally { release(); store.audit = originalAudit; client.release(); }
});

test('PG período financeiro: snapshot SERIALIZABLE antigo aborta, sem gravar após o fechamento', { skip }, async () => {
  const { pool, query, company } = await fixture(); const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT count(*) FROM fin_periodos_contabeis WHERE empresa_id=$1', [company]);
    await alterarPeriodo(req(company, '2037-05', 'fechar'), res().out);
    await assert.rejects(() => client.query("INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor) VALUES($1,'2037-05-03','receita','Snapshot',1)", [company]), (e: any) => e.code === '40001' || e.code === 'P2001');
    await client.query('ROLLBACK');
    assert.equal((await query('SELECT count(*)::int AS n FROM lancamentos_financeiros WHERE empresa_id=$1', [company])).rows[0].n, 0);
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
});

test('PG período financeiro: escritor anterior em outro processo é visto; rollback não gera pendência', { skip, timeout: 60000 }, async () => {
  const { fork } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const { query, company } = await fixture(); const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const worker = fileURLToPath(new URL('./_period-writer-worker.ts', import.meta.url));
  for (const [month, action] of [['06', 'commit'], ['07', 'rollback']] as const) {
    const child = fork(worker, [], { execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, PERIOD_WRITER_FIXTURE: JSON.stringify({ company, hash: `writer-${month}`, date: `2037-${month}-02` }) } });
    try {
      const pid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout iniciando escritor')), 10000);
        child.once('error', reject); child.once('exit', (code) => { if (code) reject(new Error(`Escritor encerrou: ${code}`)); });
        child.on('message', (m: any) => { if (m.type === 'ready') { clearTimeout(timer); resolve(m.pid); } });
      });
      const close = alterarPeriodo(req(company, `2037-${month}`, 'fechar'), res().out).then(() => null, (e: any) => e);
      const until = Date.now() + 5000; let waiting = false;
      while (Date.now() < until) {
        const r = await query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting', [pid]);
        if (r.rows[0].waiting) { waiting = true; break; }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(waiting, 'fechamento deve esperar a transação do outro processo');
      child.send(action); const outcome = await close;
      if (action === 'commit') {
        assert.equal(outcome?.code, 'CLOSE_BLOCKED'); assert.equal(outcome?.details?.pendencias?.extratos, 1);
      } else assert.equal(outcome, null);
      const bank = await query('SELECT count(*)::int AS n FROM fin_extrato_transacoes WHERE empresa_id=$1 AND linha_hash=$2', [company, `writer-${month}`]);
      assert.equal(bank.rows[0].n, action === 'commit' ? 1 : 0);
    } finally { if (child.connected) child.disconnect(); if (!child.killed) child.kill(); }
  }
});

test('PG período financeiro: estorno legado reserva antes do provider e fecha somente após conclusão', { skip, timeout: 30000 }, async (t) => {
  const { query, company } = await fixture();
  const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const gateway = await import('../../src/gateway'); const { reqDe, resFake } = await import('../_p1util');
  await query("INSERT INTO gateway_configs(empresa_id,provider,ambiente,ativo) VALUES($1,'mock','teste',true)", [company]);
  const title = (await query(`INSERT INTO lancamentos_financeiros(empresa_id,data,data_baixa,tipo,descricao,valor,status)
    VALUES($1,'2037-08-02','2037-08-02','receita','Estorno legado',20,'confirmado') RETURNING id`, [company])).rows[0].id;
  const charge = (await query(`INSERT INTO gateway_cobrancas(empresa_id,provider,metodo,lancamento_id,valor,status,provider_ref)
    VALUES($1,'mock','pix',$2,20,'paga',$3) RETURNING id`, [company, title, `legacy-${company}`])).rows[0].id;
  let entered!: () => void; const started = new Promise<void>((r) => { entered = r; });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let calls = 0;
  t.mock.method(gateway.mockProvider, 'estornaCobranca', async () => { calls++; entered(); await gate; return { status: 'estornada' }; });
  const actor = { id: 0, name: 'Admin', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  const request = () => reqDe({}, { params: { id: charge }, user: actor });
  try {
    const refund = gateway.estornarCobranca(request(), resFake().res); await started;
    await assert.rejects(() => gateway.estornarCobranca(request(), resFake().res), (e: any) => e.status === 409);
    await assert.rejects(() => alterarPeriodo(req(company, '2037-08', 'fechar'), res().out), (e: any) => e.code === 'CLOSE_BLOCKED' && e.details.pendencias.operacoes === 1);
    release(); await refund;
    assert.equal(calls, 1);
    const stored = await query('SELECT status,estorno_operacao_estado FROM gateway_cobrancas WHERE id=$1', [charge]);
    assert.equal(stored.rows[0].status, 'estornada'); assert.equal(stored.rows[0].estorno_operacao_estado, 'SUCCEEDED');
    await alterarPeriodo(req(company, '2037-08', 'fechar'), res().out);
  } finally { release(); }
});

test('PG período financeiro: estorno legado não chama provider de período fechado nem em data sem comprovação', { skip }, async (t) => {
  const { query, company } = await fixture(); const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const gateway = await import('../../src/gateway'); const { reqDe, resFake } = await import('../_p1util');
  await query("INSERT INTO gateway_configs(empresa_id,provider,ambiente,ativo) VALUES($1,'mock','teste',true)", [company]);
  const title = (await query(`INSERT INTO lancamentos_financeiros(empresa_id,data,data_baixa,tipo,descricao,valor,status)
    VALUES($1,'2037-09-02','2037-09-02','receita','Título',20,'confirmado') RETURNING id`, [company])).rows[0].id;
  const c = await query(`INSERT INTO gateway_cobrancas(empresa_id,provider,metodo,lancamento_id,valor,status,provider_ref)
    VALUES($1,'mock','pix',$2,20,'paga',$3),($1,'mock','pix',NULL,20,'paga',$4) RETURNING id`, [company, title, `g1-${company}`, `g2-${company}`]);
  let calls = 0; t.mock.method(gateway.mockProvider, 'estornaCobranca', async () => { calls++; return { status: 'estornada' }; });
  await alterarPeriodo(req(company, '2037-09', 'fechar'), res().out);
  const actor = { id: 0, name: 'Admin', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  for (const charge of c.rows) await assert.rejects(() => gateway.estornarCobranca(reqDe({}, { params: { id: charge.id }, user: actor }), resFake().res), (e: any) => e.status === 409);
  assert.equal(calls, 0);
});

test('PG criação legada: reserva bloqueia fechamento e duplicata; replay com dados alterados é recusado', { skip, timeout: 30000 }, async (t) => {
  const { query, company } = await fixture(); const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const gateway = await import('../../src/gateway'); const { reqDe, resFake } = await import('../_p1util');
  await query("INSERT INTO gateway_configs(empresa_id,provider,ambiente,ativo) VALUES($1,'mock','teste',true)", [company]);
  let entered!: () => void; const started = new Promise<void>((r) => { entered = r; });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let calls = 0;
  t.mock.method(gateway.mockProvider, 'criaCobranca', async () => { calls++; entered(); await gate; return { provider_ref: `create-${company}`, status: 'pendente' as const, bruto: { card: 'not stored' } }; });
  const actor = { id: 0, name: 'Admin', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  const request = (valor = 50) => reqDe({ provider: 'mock', metodo: 'pix', valor, idempotency_key: 'legacy-create-pg' }, { user: actor });
  try {
    const first = gateway.criarCobranca(request(), resFake().res); await started;
    await assert.rejects(() => gateway.criarCobranca(request(), resFake().res), (e: any) => e.status === 409);
    await assert.rejects(() => alterarPeriodo(req(company, '2037-10', 'fechar'), res().out), (e: any) => e.code === 'CLOSE_BLOCKED' && e.details.pendencias.operacoes === 1);
    release(); await first;
    const replay = resFake(); await gateway.criarCobranca(request(), replay.res); assert.equal(replay.saida.json.idempotente, true);
    await assert.rejects(() => gateway.criarCobranca(request(51), resFake().res), (e: any) => e.status === 409);
    assert.equal(calls, 1);
    const stored = (await query("SELECT criacao_operacao_estado,payload FROM gateway_cobrancas WHERE empresa_id=$1 AND idempotency_key='legacy-create-pg'", [company])).rows[0];
    assert.equal(stored.criacao_operacao_estado, 'SUCCEEDED'); assert.equal(stored.payload, null);
  } finally { release(); }
});

test('PG criação legada: crash em outro processo conserva PROCESSING e impede reenvio e fechamento', { skip, timeout: 30000 }, async (t) => {
  const { fork } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const { query, company } = await fixture(); const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const gateway = await import('../../src/gateway'); const { escopoDeSistema } = await import('../../src/empresa');
  await query("INSERT INTO gateway_configs(empresa_id,provider,ambiente,ativo) VALUES($1,'mock','teste',true)", [company]);
  const child = fork(fileURLToPath(new URL('./_legacy-create-crash-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], silent: true, env: { ...process.env, CRASH_COMPANY: String(company), PG_IDLE_TIMEOUT: '1000' },
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); assert.equal(code, 73);
  let calls = 0; t.mock.method(gateway.mockProvider, 'criaCobranca', async () => { calls++; throw new Error('não deveria reenviar'); });
  const params = { provider: 'mock', metodo: 'pix' as const, valor: 27, idempotencyKey: 'legacy-create-crash-pg', actor: { id: null, name: 'Worker PG' } };
  await assert.rejects(() => gateway.criarCobrancaGateway(escopoDeSistema(company), params), (e: any) => e.status === 409);
  await assert.rejects(() => alterarPeriodo(req(company, '2037-11', 'fechar'), res().out), (e: any) => e.code === 'CLOSE_BLOCKED' && e.details.pendencias.operacoes === 1);
  const state = (await query("SELECT criacao_operacao_estado FROM gateway_cobrancas WHERE empresa_id=$1 AND idempotency_key=$2", [company, params.idempotencyKey])).rows[0];
  assert.equal(state.criacao_operacao_estado, 'PROCESSING'); assert.equal(calls, 0);
});

test('PG operações legadas incertas nunca repetem cancelamento ou estorno às cegas', { skip }, async (t) => {
  const { query, company } = await fixture(); const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const gateway = await import('../../src/gateway'); const { reqDe, resFake } = await import('../_p1util');
  await query("INSERT INTO gateway_configs(empresa_id,provider,ambiente,ativo) VALUES($1,'mock','teste',true)", [company]);
  const charges = (await query(`INSERT INTO gateway_cobrancas(empresa_id,provider,metodo,valor,status,provider_ref)
    VALUES($1,'mock','pix',30,'pendente',$2),($1,'mock','pix',40,'paga',$3) RETURNING id`, [company, `cancel-${company}`, `refund-${company}`])).rows;
  let cancels = 0, refunds = 0;
  t.mock.method(gateway.mockProvider, 'cancelaCobranca', async () => { cancels++; throw new Error('timeout'); });
  t.mock.method(gateway.mockProvider, 'estornaCobranca', async () => { refunds++; throw new Error('timeout'); });
  const actor = { id: 0, name: 'Admin', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  const request = (id: number) => reqDe({}, { user: actor, params: { id } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => gateway.cancelarCobranca(request(charges[0].id), resFake().res), (e: any) => e.status === 409);
    await assert.rejects(() => gateway.estornarCobranca(request(charges[1].id), resFake().res), (e: any) => e.status === 409);
  }
  assert.equal(cancels, 1); assert.equal(refunds, 1);
  const rows = (await query('SELECT status,cancelamento_operacao_estado,estorno_operacao_estado FROM gateway_cobrancas WHERE empresa_id=$1 ORDER BY id', [company])).rows;
  assert.equal(rows[0].status, 'pendente'); assert.equal(rows[0].cancelamento_operacao_estado, 'UNCERTAIN');
  assert.equal(rows[1].status, 'paga'); assert.equal(rows[1].estorno_operacao_estado, 'UNCERTAIN');
  await assert.rejects(() => alterarPeriodo(req(company, '2037-12', 'fechar'), res().out), (e: any) => e.code === 'CLOSE_BLOCKED' && e.details.pendencias.operacoes === 2);
});

test('PG período: webhook legado e cancelamento não alteram cobrança com título fechado', { skip }, async (t) => {
  const { query, company } = await fixture(); const { alterarPeriodo } = await import('../../src/financeiroPeriodos');
  const gateway = await import('../../src/gateway'); const { reqDe, resFake } = await import('../_p1util');
  const { getStore } = await import('../../src/services');
  await query("INSERT INTO gateway_configs(empresa_id,provider,ambiente,ativo) VALUES($1,'mock','teste',true)", [company]);
  const title = Number((await query(`INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor,status)
    VALUES($1,'2040-02-02','receita','Título pendente',20,'pendente') RETURNING id`, [company])).rows[0].id);
  const ref = `webhook-close-${company}`;
  const charge = Number((await query(`INSERT INTO gateway_cobrancas(empresa_id,provider,metodo,lancamento_id,valor,status,provider_ref)
    VALUES($1,'mock','pix',$2,20,'pendente',$3) RETURNING id`, [company, title, ref])).rows[0].id);
  const event = await getStore().insert(gateway.R_GATEWAY_WEBHOOK_EVENTS, { empresa_id: company, provider: 'mock', evento_id: `event-${company}`,
    evento: 'payment.paid', payload: { event: 'payment.paid', data: { id: ref }, status: 'pago' }, assinatura_ok: true, status: 'recebido', tentativas: 0 });
  await alterarPeriodo(req(company, '2040-02', 'fechar'), res().out);
  let calls = 0; t.mock.method(gateway.mockProvider, 'cancelaCobranca', async () => { calls++; return { status: 'cancelada' }; });
  const actor = { id: 0, name: 'Admin', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  await assert.rejects(() => gateway.cancelarCobranca(reqDe({}, { user: actor, params: { id: charge } }), resFake().res), (e: any) => e.status === 409);
  await assert.rejects(() => gateway.processarEvento(event), (e: any) => e.status === 409);
  const stored = (await query('SELECT c.status AS charge,l.status AS title FROM gateway_cobrancas c JOIN lancamentos_financeiros l ON l.id=c.lancamento_id WHERE c.id=$1', [charge])).rows[0];
  assert.equal(stored.charge, 'pendente'); assert.equal(stored.title, 'pendente'); assert.equal(calls, 0);
  assert.equal((await getStore().get(gateway.R_GATEWAY_WEBHOOK_EVENTS, Number(event.id)))?.status, 'erro');
});
