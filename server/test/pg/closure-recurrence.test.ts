import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.env.DATABASE_URL) throw new Error('Closure recorrência exige PostgreSQL real');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate(); const q = pool!;
const { processarRecorrencias, resumoFinanceiro } = await import('../../src/financeiro');
async function fixture() {
  const ref = `rec-${randomUUID().slice(0,12)}`;
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [ref])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES($1,$2,'admin',true,$3) RETURNING id", [ref, `${ref}@example.invalid`, company])).rows[0].id);
  const account = Number((await q.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [company, ref])).rows[0].id);
  return { company, account, actor: { id: user, name: ref, perfil: 'admin', empresa_id: company, empresas: [company] }, scope: { empresaId: company, permitidas: [company], consolidado: false } };
}
async function recurrence(f: Awaited<ReturnType<typeof fixture>>, due: string, frequency = 'mensal', day = Number(due.slice(8,10)), account = f.account) {
  return Number((await q.query("INSERT INTO recorrencias_financeiras(empresa_id,descricao,tipo,valor,frequencia,dia,proxima_geracao,status,conta_id) VALUES($1,'Fixture','despesa',10,$2,$3,$4,'ativo',$5) RETURNING id", [f.company, frequency, day, due, account])).rows[0].id);
}
const due = new Date().toISOString().slice(0,10);

test('PG jobs: dois processos geram uma única recorrência do dia e preservam outra empresa', async () => {
  const f = await fixture(); const other = await fixture(); const id = await recurrence(f, due); const otherId = await recurrence(other, due);
  const worker = fileURLToPath(new URL('./_recorrencia-worker.ts', import.meta.url));
  const children = [0,1].map(() => fork(worker, [], { execArgv: ['--import','tsx'], silent: true,
    env: { ...process.env, CLOSURE_REC_FIXTURE: JSON.stringify({ actor: f.actor, scope: f.scope }), PG_IDLE_TIMEOUT: '1000' } }));
  try {
    await Promise.all(children.map((c) => new Promise<void>((resolve, reject) => { c.on('message', (m: any) => { if (m?.type === 'ready') resolve(); }); c.once('error', reject); c.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); }); })));
    const outputs = children.map((c) => new Promise<any>((resolve, reject) => { c.on('message', (m: any) => { if (m?.type === 'result') resolve(m); }); c.once('error', reject); c.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); }); }));
    children.forEach((c) => c.send('go')); const result = await Promise.all(outputs);
    assert.ok(result.every((r) => r.ok)); assert.equal(result.reduce((n,r) => n+r.result.gerados,0), 1);
    assert.equal(Number((await q.query('SELECT count(*) FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_recorrencia_id=$2', [f.company,id])).rows[0].count), 1);
    assert.equal(Number((await q.query('SELECT count(*) FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_recorrencia_id=$2', [other.company,otherId])).rows[0].count), 0);
  } finally { children.forEach((c) => { if (c.connected) c.disconnect(); if (!c.killed) c.kill(); }); }
});

test('PG jobs: rollback atômico, replay e recuperação de agenda histórica', async () => {
  const f = await fixture(); const id = await recurrence(f, due); const trigger = `rec_fail_${id}`;
  await q.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha de teste'; END $$`);
  await q.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON recorrencias_financeiras FOR EACH ROW WHEN (OLD.id=${id}) EXECUTE FUNCTION ${trigger}()`);
  try { await assert.rejects(() => processarRecorrencias(f.actor, f.scope)); } finally { await q.query(`DROP TRIGGER ${trigger} ON recorrencias_financeiras`); await q.query(`DROP FUNCTION ${trigger}()`); }
  assert.equal(Number((await q.query('SELECT count(*) FROM lancamentos_financeiros WHERE referencia_recorrencia_id=$1', [id])).rows[0].count), 0);
  assert.equal((await q.query('SELECT proxima_geracao::text FROM recorrencias_financeiras WHERE id=$1', [id])).rows[0].proxima_geracao, due);
  assert.equal((await processarRecorrencias(f.actor, f.scope)).gerados, 1); assert.equal((await processarRecorrencias(f.actor, f.scope)).gerados, 0);
  const legacy = await fixture(); const oldId = await recurrence(legacy, '2000-01-31');
  await q.query("INSERT INTO lancamentos_financeiros(empresa_id,conta_id,data,tipo,descricao,valor,status,vencimento,referencia_tipo,referencia_id,referencia_recorrencia_id) VALUES($1,$2,'2000-01-31','despesa','legado',10,'pendente','2000-01-31','recorrencia',$3,$3)", [legacy.company, legacy.account, oldId]);
  assert.equal((await processarRecorrencias(legacy.actor, legacy.scope)).gerados, 0);
  assert.equal((await q.query('SELECT proxima_geracao::text FROM recorrencias_financeiras WHERE id=$1', [oldId])).rows[0].proxima_geracao, '2000-02-29');
  assert.equal(Number((await q.query('SELECT count(*) FROM lancamentos_financeiros WHERE referencia_recorrencia_id=$1', [oldId])).rows[0].count), 1);
});

test('PG jobs: agenda semanal e anual avançam; referência de conta alheia é rejeitada', async () => {
  const f = await fixture(); const weekly = await recurrence(f,'2000-01-03','semanal',1); const annual = await recurrence(f,'2000-05-15','anual',15);
  const out = await processarRecorrencias(f.actor, f.scope); assert.equal(out.gerados, 2);
  const dates = await q.query('SELECT id,proxima_geracao::text FROM recorrencias_financeiras WHERE id=ANY($1::int[])', [[weekly,annual]]);
  const byId = new Map(dates.rows.map((x) => [Number(x.id),x.proxima_geracao]));
  assert.equal(byId.get(weekly), '2000-01-10'); assert.equal(byId.get(annual), '2001-05-15');
  const a = await fixture(); const b = await fixture(); const bad = await recurrence(a, due, 'mensal', Number(due.slice(8,10)), b.account);
  await assert.rejects(() => processarRecorrencias(a.actor, a.scope), (e: any) => e.status === 404);
  assert.equal(Number((await q.query('SELECT count(*) FROM lancamentos_financeiros WHERE referencia_recorrencia_id=$1', [bad])).rows[0].count), 0);
});

test('PG financeiro: resumo soma mais de 10 mil títulos sem misturar empresas', async () => {
  const a = await fixture(); const b = await fixture();
  await q.query("INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor,status) SELECT $1,'2035-01-01','receita','volume',1,'pendente' FROM generate_series(1,10001)", [a.company]);
  await q.query("INSERT INTO lancamentos_financeiros(empresa_id,data,tipo,descricao,valor,status) SELECT $1,'2035-01-01','receita','outra empresa',1,'pendente' FROM generate_series(1,10)", [b.company]);
  let result: any; await resumoFinanceiro({ user: a.actor, query: {}, params: {} } as any, { json(x: any) { result = x; return this; } } as any);
  assert.equal(result.aReceber, 10001); assert.equal(result.aReceberLista.length, 10001);
});

test('PG auditoria: gravações autônomas concorrentes não bifurcam nem falham após esperar a trava', async () => {
  const { getStore } = await import('../../src/services'); const store = getStore(); const a = await fixture(); const b = await fixture();
  const marker = `audit-concurrent-${randomUUID()}`; const prior = (await q.query('SELECT hash FROM auditoria WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1')).rows[0]?.hash || '';
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.audit({ empresa_id: i % 2 ? a.company : b.company, usuario_id: null,
    usuario: 'teste', acao: 'ajuste', recurso: marker, registro_id: i + 1, descricao: 'Auditoria concorrente', dados: { indice: i } })));
  const rows = (await q.query('SELECT hash,hash_anterior FROM auditoria WHERE recurso=$1 ORDER BY id', [marker])).rows;
  assert.equal(rows.length, 20); let expected = prior;
  for (const row of rows) { assert.equal(row.hash_anterior, expected); assert.ok(row.hash); expected = row.hash; }
});
