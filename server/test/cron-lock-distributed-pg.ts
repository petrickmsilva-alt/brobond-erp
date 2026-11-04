import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

// Nenhum fallback para DATABASE_URL: um banco explicitamente descartável e local é obrigatório.
const testUrl = process.env.CRON_LOCK_TEST_DATABASE_URL;
if (!testUrl) throw new Error('CRON_LOCK_TEST_DATABASE_URL exige banco local descartável vazio');
const url = new URL(testUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !url.pathname.startsWith('/brobond_test_')) {
  throw new Error('CRON_LOCK_TEST_DATABASE_URL deve apontar a banco local brobond_test_*');
}
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
const lock = await import('../src/cronLock');
const { pool } = await import('../src/db');
const root = fileURLToPath(new URL('../../', import.meta.url));
const workerFile = fileURLToPath(new URL('./fixtures/cron-lock-worker.ts', import.meta.url));
type Message = { kind: string; lease?: import('../src/cronLock').CronLease | null; completed?: boolean; ok?: boolean };
function next(child: ChildProcess): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timeout')), 30000);
    child.once('message', (m) => { clearTimeout(timer); resolve(m as Message); });
    child.once('error', reject);
  });
}
async function spawnWorkers(n: number): Promise<ChildProcess[]> {
  const workers = Array.from({ length: n }, () => fork(workerFile, [], { cwd: root, execArgv: ['--import', 'tsx'], env: { ...process.env, DATABASE_URL: testUrl }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
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

test('PostgreSQL real: aquisição entre processos e fencing transacional de unidade', { timeout: 180000 }, async () => {
  const setup = new pg.Client({ connectionString: testUrl });
  await setup.connect();
  try {
    const { rows } = await setup.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','f')");
    assert.equal(rows[0].n, 0, 'banco de teste deve estar vazio');
    await setup.query(readFileSync(`${root}/db/migrations/0098_cron_job_locks.sql`, 'utf8'));
    await setup.query('CREATE TABLE cron_lock_test_effects (id integer PRIMARY KEY)');
  } finally { await setup.end(); }

  const jobs = ['relatorios', 'pagamentos', 'publicacoes', 'pedidos', 'crm'];
  for (const job of jobs) {
    const workers = await spawnWorkers(4);
    try {
      const responses = workers.map(next);
      workers.forEach((c) => c.send({ command: 'acquire', job, leaseMs: 30000 }));
      const acquired = (await Promise.all(responses)).filter((m) => m.kind === 'acquired' && m.lease);
      assert.equal(acquired.length, 1, `uma aquisição para ${job}`);
      assert.equal(await lock.releaseCronLease(acquired[0].lease!), true);
    } finally { await stop(workers); }
  }
  // Cinco jobs diferentes são adquiridos ao mesmo tempo, sem lock global.
  const independent = await Promise.all(jobs.map((j) => lock.acquireCronLease(j, 30000)));
  assert.equal(independent.filter(Boolean).length, 5);
  for (const l of independent) assert.equal(await lock.releaseCronLease(l!), true);

  // Duas instâncias separadas tentam efetuar a mesma unidade na mesma geração.
  const l = (await lock.acquireCronLease('crm', 30000))!;
  const unitWorkers = await spawnWorkers(2);
  try {
    const responses = unitWorkers.map(next);
    unitWorkers.forEach((c) => c.send({ command: 'unit', lease: l }));
    const results = await Promise.all(responses);
    assert.deepEqual(results.map((m) => m.completed).sort(), [false, true]);
    assert.equal(Number((await pool!.query('SELECT count(*) FROM cron_lock_test_effects')).rows[0].count), 1);
    assert.equal(Number((await pool!.query('SELECT count(*) FROM cron_work_items')).rows[0].count), 1);
    assert.equal(await lock.renewCronLease({ ...l, token: String(BigInt(l.token) + 1n) }), false);
    assert.equal(await lock.releaseCronLease(l), true);
  } finally { await stop(unitWorkers); }

  // Falha após escrita interna: rollback conjunto, retry não encontra efeito parcial.
  const retryLease = (await lock.acquireCronLease('relatorios', 30000))!;
  await assert.rejects(lock.executeCronUnit(retryLease, 'retry:1', '1', async (c) => {
    await c.query('INSERT INTO cron_lock_test_effects VALUES (44)');
    throw new Error('erro simulado');
  }));
  assert.equal((await pool!.query('SELECT 1 FROM cron_lock_test_effects WHERE id=44')).rowCount, 0);
  const retry = await lock.executeCronUnit(retryLease, 'retry:1', '1', async (c) => {
    await c.query('INSERT INTO cron_lock_test_effects VALUES (44)');
    return true;
  });
  assert.equal(retry.completed, true);
  assert.equal(await lock.releaseCronLease(retryLease), true);

  // Heartbeat mantém um lease vivo depois de sua expiração original.
  const heartbeatLease = (await lock.acquireCronLease('pagamentos', 300))!;
  let lost = false;
  const stopHeartbeat = lock.startCronHeartbeat(heartbeatLease, () => { lost = true; });
  await delay(800);
  assert.equal(lost, false);
  assert.equal(await lock.acquireCronLease('pagamentos', 300), null);
  stopHeartbeat();
  assert.equal(await lock.releaseCronLease(heartbeatLease), true);
  let rejected = 0;
  const stopInvalid = lock.startCronHeartbeat(heartbeatLease, () => { rejected++; });
  await delay(250);
  stopInvalid();
  assert.equal(rejected, 1, 'heartbeat de proprietário perdido sinaliza falha uma vez');

  // Processo morre sem liberar; lease expira e token anterior não pode renovar,
  // liberar nem executar callback transacional depois da recuperação.
  const [oldWorker] = await spawnWorkers(1);
  const received = next(oldWorker);
  oldWorker.send({ command: 'acquire', job: 'pedidos', leaseMs: 500 });
  const old = (await received).lease!;
  const exited = new Promise<void>((resolve) => oldWorker.once('exit', () => resolve()));
  oldWorker.kill('SIGKILL');
  await exited;
  await delay(650);
  const recoveryWorkers = await spawnWorkers(2);
  const attempts = recoveryWorkers.map(next);
  recoveryWorkers.forEach((c) => c.send({ command: 'acquire', job: 'pedidos', leaseMs: 30000 }));
  const winners = (await Promise.all(attempts)).filter((m) => m.lease);
  assert.equal(winners.length, 1, 'duas recuperações simultâneas: apenas uma vence');
  const recovered = winners[0].lease!;
  await stop(recoveryWorkers);
  assert.ok(BigInt(recovered.token) > BigInt(old.token));
  assert.equal(await lock.renewCronLease(old), false);
  assert.equal(await lock.releaseCronLease(old), false);
  await assert.rejects(lock.executeCronUnit(old, 'old', 'old', async (c) => { await c.query('INSERT INTO cron_lock_test_effects VALUES (43)'); }));
  assert.equal((await pool!.query('SELECT 1 FROM cron_lock_test_effects WHERE id=43')).rowCount, 0);
  assert.equal(await lock.renewCronLease(recovered), true);
  assert.equal(await lock.releaseCronLease(recovered), true);

  // O lease pode expirar durante o callback; sua transação não pode confirmar.
  const expiring = (await lock.acquireCronLease('publicacoes', 200))!;
  await assert.rejects(lock.executeCronUnit(expiring, 'expired:1', '1', async (c) => {
    await c.query('INSERT INTO cron_lock_test_effects VALUES (45)');
    await delay(300);
  }));
  assert.equal((await pool!.query('SELECT 1 FROM cron_lock_test_effects WHERE id=45')).rowCount, 0);
  const afterExpiry = (await lock.acquireCronLease('publicacoes', 30000))!;
  assert.equal(await lock.releaseCronLease(afterExpiry), true);
  await pool?.end();
  await assert.rejects(lock.acquireCronLease('crm', 300), 'falha de conexão impede adquirir');
});
