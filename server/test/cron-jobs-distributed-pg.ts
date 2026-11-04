import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

const testUrl = process.env.CRON_JOBS_TEST_DATABASE_URL;
if (!testUrl) throw new Error('CRON_JOBS_TEST_DATABASE_URL exige banco local descartável vazio');
const url = new URL(testUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !url.pathname.startsWith('/brobond_test_')) {
  throw new Error('CRON_JOBS_TEST_DATABASE_URL deve apontar a banco local brobond_test_*');
}
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.CRON_SECRET = 'segredo-local-cron-jobs';
delete process.env.NOTIFICAR_CRM_LEMBRETE;

const { migrate, pool } = await import('../src/db');
const lock = await import('../src/cronLock');
const root = fileURLToPath(new URL('../../', import.meta.url));
const workerFile = fileURLToPath(new URL('./fixtures/cron-job-worker.ts', import.meta.url));
const JOBS = ['relatorios', 'pagamentos', 'publicacoes', 'pedidos', 'crm'] as const;
type Message = { kind: string; status?: number; motivo?: string; ok?: boolean };

function next(child: ChildProcess): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timeout')), 120_000);
    child.once('message', (m) => { clearTimeout(timer); resolve(m as Message); });
    child.once('error', reject);
  });
}

async function spawnWorkers(n: number): Promise<ChildProcess[]> {
  const workers = Array.from({ length: n }, () => fork(workerFile, [], {
    cwd: root,
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: 'test', CRON_SECRET: process.env.CRON_SECRET },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }));
  assert.deepEqual((await Promise.all(workers.map(next))).map((m) => m.kind), Array(n).fill('ready'));
  return workers;
}

async function stop(workers: ChildProcess[]) {
  await Promise.all(workers.map((c) => new Promise<void>((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once('exit', () => resolve());
    c.send({ command: 'end' });
  })));
}

test('PostgreSQL real: executarProcessoCron exclusivo entre processos para os cinco jobs', { timeout: 240000 }, async () => {
  const setup = new pg.Client({ connectionString: testUrl });
  await setup.connect();
  try {
    const { rows } = await setup.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','f')");
    assert.equal(rows[0].n, 0, 'banco de teste deve estar vazio');
  } finally { await setup.end(); }
  await migrate();

  for (const job of JOBS) {
    const workers = await spawnWorkers(4);
    try {
      const responses = workers.map(next);
      workers.forEach((c) => c.send({ command: 'run', job }));
      const results = await Promise.all(responses);
      const ok = results.filter((m) => m.kind === 'result' && m.status === 200);
      const recusados = results.filter((m) => m.kind === 'result' && m.status === 409 && m.motivo === 'ja_em_execucao');
      assert.equal(ok.length, 1, `uma execução de ${job}: ${JSON.stringify(results)}`);
      assert.equal(recusados.length, 3, `três recusas de ${job}`);
    } finally { await stop(workers); }
  }

  const parallel = await spawnWorkers(5);
  try {
    const responses = parallel.map(next);
    JOBS.forEach((job, i) => parallel[i].send({ command: 'run', job }));
    const results = await Promise.all(responses);
    assert.equal(results.filter((m) => m.kind === 'result' && m.status === 200).length, 5, 'cinco jobs distintos em paralelo');
  } finally { await stop(parallel); }

  const { executarProcessoCron } = await import('../src/scheduled');
  const { getStore } = await import('../src/services');
  const { getResource } = await import('../src/resources');
  const s = getStore();
  const empresas = getResource('empresas')!;
  const antes = await s.list(empresas, { page: 1, pageSize: 1 });
  assert.ok(antes.rows[0], 'bootstrap criou empresa');
  const id = Number(antes.rows[0].id);
  const nome = String(antes.rows[0].nome);

  const stale = (await lock.acquireCronLease('crm', 200))!;
  await delay(350);
  await lock.runWithCronLease(stale, async () => {
    await assert.rejects(s.update(empresas, id, { nome: `${nome}-nao` }), (e: Error) => e.name === 'CronLeaseLostError');
  });
  const atual = await s.get(empresas, id);
  assert.equal(String(atual?.nome), nome, 'fencing impediu a escrita do token expirado');

  const held = (await lock.acquireCronLease('crm', 30_000))!;
  await lock.runWithCronLease(held, async () => {
    const row = await s.update(empresas, id, { nome });
    assert.ok(row, 'token vigente escreve');
  });
  assert.equal(await lock.releaseCronLease(held), true);

  const primeira = await executarProcessoCron('crm');
  const segunda = await executarProcessoCron('crm');
  assert.equal(primeira.status, 200);
  assert.equal(segunda.status, 200, 'depois de liberar, nova execução é aceita');
  await pool?.end();
});
