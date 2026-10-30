import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.env.DATABASE_URL) throw new Error('Closure CNAB exige PostgreSQL real');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate(); const q = pool!;
const { importarCnab } = await import('../../src/cnab');
function line(fields: [number, number, string][]) { const arr = ' '.repeat(240).split(''); for (const [a,b,v] of fields) { const text = v.padEnd(b-a+1).slice(0,b-a+1); for (let n=0; n<text.length; n++) arr[a-1+n] = text[n]; } return arr.join(''); }
function file(nn: string, value = 100, includeU = true, accountDocument = '') {
  const header = line([[1,3,'237'],[8,8,'0']]);
  const t = line([[8,8,'3'],[14,14,'T'],[16,17,'06'],[38,57,nn.padStart(20)], [59,73,accountDocument.padStart(15,'0')], [82,96,String(value*100).padStart(15,'0')]]);
  const u = line([[8,8,'3'],[14,14,'U'],[16,17,'06'],[78,92,String(value*100).padStart(15,'0')],[138,145,'10052035'],[146,153,'10052035']]);
  return [header, t, ...(includeU ? [u] : []), line([[8,8,'9']])].join('\n');
}
async function fixture() {
  const ref = `cnab-${randomUUID().slice(0,12)}`;
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [ref])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES($1,$2,'admin',true,$3) RETURNING id", [ref, `${ref}@example.invalid`, company])).rows[0].id);
  const account = Number((await q.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [company, ref])).rows[0].id);
  const title = Number((await q.query("INSERT INTO lancamentos_financeiros(empresa_id,conta_id,data,tipo,descricao,valor,status) VALUES($1,$2,'2035-05-10','receita',$3,100,'pendente') RETURNING id", [company, account, ref])).rows[0].id);
  await q.query("INSERT INTO gateway_cobrancas(empresa_id,provider,metodo,lancamento_id,conta_id,valor,status,nosso_numero) VALUES($1,'mock','boleto',$2,$3,100,'pendente',$4)", [company, title, account, ref]);
  return { company, account, title, ref, actor: { id: user, name: ref, perfil: 'admin', empresa_id: company, empresas: [company] } };
}
async function call(f: Awaited<ReturnType<typeof fixture>>, content: string) { let result: any; await importarCnab({ user: f.actor, body: { conta_id: f.account, conteudo: content }, query: {}, params: {} } as any, { json(x: any) { result = x; return this; } } as any); return result; }

test('PG CNAB: dois processos importam a mesma liquidação; um efeito, uma linha e replay idempotente', async () => {
  const f = await fixture(); const content = file(f.ref); const worker = fileURLToPath(new URL('./_cnab-worker.ts', import.meta.url));
  const children = [0,1].map(() => fork(worker, [], { execArgv: ['--import','tsx'], silent: true,
    env: { ...process.env, CLOSURE_CNAB_FIXTURE: JSON.stringify({ actor: f.actor, account: f.account, content }), PG_IDLE_TIMEOUT: '1000' } }));
  try {
    await Promise.all(children.map((c) => new Promise<void>((resolve, reject) => { c.on('message', (m: any) => { if (m?.type === 'ready') resolve(); }); c.once('error', reject); c.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); }); })));
    const outputs = children.map((c) => new Promise<any>((resolve, reject) => { c.on('message', (m: any) => { if (m?.type === 'result') resolve(m); }); c.once('error', reject); c.once('exit', (code) => { if (code) reject(new Error(`Worker saiu ${code}`)); }); }));
    children.forEach((c) => c.send('go')); const result = await Promise.all(outputs);
    assert.ok(result.every((r) => r.ok), JSON.stringify(result)); assert.equal(result.reduce((n,r) => n + r.result.liquidadas, 0), 1); assert.equal(result.reduce((n,r) => n + r.result.duplicadas, 0), 1);
    const rows = await q.query('SELECT status,lancamento_id,baixa_lancamento_id FROM fin_extrato_transacoes WHERE empresa_id=$1', [f.company]);
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].status, 'conciliada'); assert.equal(Number(rows.rows[0].baixa_lancamento_id), f.title);
    assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [f.title])).rows[0].status, 'confirmado');
    const replay = await call(f, content); assert.equal(replay.duplicadas, 1); assert.equal(replay.liquidadas, 0);
  } finally { children.forEach((c) => { if (c.connected) c.disconnect(); if (!c.killed) c.kill(); }); }
});

test('PG CNAB: erro entre baixa e vínculo reverte título e inserção; somente divergência auditada persiste', async () => {
  const f = await fixture(); const trigger = `cnab_fail_${f.company}`;
  await q.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha de teste'; END $$`);
  await q.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON fin_extrato_transacoes FOR EACH ROW WHEN (NEW.empresa_id = ${f.company} AND NEW.status = 'conciliada') EXECUTE FUNCTION ${trigger}()`);
  let out: any; try { out = await call(f, file(f.ref)); } finally { await q.query(`DROP TRIGGER ${trigger} ON fin_extrato_transacoes`); await q.query(`DROP FUNCTION ${trigger}()`); }
  assert.equal(out.liquidadas, 0); assert.equal(out.divergentes, 1);
  const title = (await q.query('SELECT status,valor FROM lancamentos_financeiros WHERE id=$1', [f.title])).rows[0]; assert.equal(title.status, 'pendente'); assert.equal(Number(title.valor), 100);
  const rows = await q.query('SELECT status,lancamento_id,baixa_lancamento_id FROM fin_extrato_transacoes WHERE empresa_id=$1', [f.company]);
  assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].status, 'divergente'); assert.equal(rows.rows[0].lancamento_id, null);
  assert.equal(Number((await q.query("SELECT count(*) FROM auditoria WHERE empresa_id=$1 AND recurso='fin_extrato_transacoes' AND registro_id=$2", [f.company, (await q.query('SELECT id FROM fin_extrato_transacoes WHERE empresa_id=$1', [f.company])).rows[0].id])).rows[0].count), 1);
});

test('PG CNAB: segmento U ausente e conta de cobrança divergente não produzem baixa', async () => {
  const f = await fixture(); const incomplete = await call(f, file(f.ref, 100, false));
  assert.equal(incomplete.divergentes, 1); assert.equal(incomplete.liquidadas, 0);
  const other = Number((await q.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [f.company, `outra-${f.ref}`])).rows[0].id);
  await q.query('UPDATE gateway_cobrancas SET conta_id=$1 WHERE empresa_id=$2', [other, f.company]);
  const wrongAccount = await call(f, file(f.ref)); assert.equal(wrongAccount.divergentes, 1); assert.equal(wrongAccount.liquidadas, 0);
  assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [f.title])).rows[0].status, 'pendente');
});
