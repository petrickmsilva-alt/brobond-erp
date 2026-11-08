// ============================================================================
// PROD-DB-03 — resiliencia de startup e prontidao contra PostgreSQL REAL.
//
// Cobre os 10 cenarios em PostgreSQL 16.14 real (bancos descartaveis + servidor
// HTTP real + proxy TCP real):
//   1. PG disponivel na 1a tentativa;
//   2. PG indisponivel nas primeiras tentativas e disponivel depois;
//   3. Erro transitorio de conexao recuperado via backoff;
//   4. Erro permanente (3D000 banco inexistente) falha rapido na 1a tentativa;
//   5. Startup timeout encerra dentro do limite sem loop infinito;
//   6. Migration ja aplicada (idempotencia);
//   7. Migration pendente;
//   8. Falha de migration (0030/E4.2): /api/health 503 com banco conectado e pronto=false;
//   9. /api/health antes e depois da conexao/prontidao;
//  10. Workers, cron e negocio bloqueados (503) antes da prontidao.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import net, { type AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SERVER_DIR,
  aplicarArquivo,
  aplicarCadeia,
  BOOTSTRAP_FILE,
  conectar,
  criarBancoDescartavel,
  destruirBancoDescartavel,
  migrationsRegistradas,
  nomesDasMigrations,
  rodarBoot,
} from './_boot-harness';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { aplicarMigrationsVersionadas } from '../../src/db';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/prod-db-03-startup-resilience.test.ts exige DATABASE_URL e PostgreSQL real; nao e permitido pular esta prova.');
}

const BOOTSTRAP = readFileSync(BOOTSTRAP_FILE, 'utf8');
const ADMIN_PASSWORD = `Test-${randomUUID()}-aA!`;
const JWT_SECRET = `${randomUUID()}${randomUUID()}`;
const CRON_SECRET = `cron-${randomUUID()}`;
type Child = ChildProcessByStdio<null, Readable, Readable>;

async function reservarPorta(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
  return port;
}

async function criarProxyTcp(targetDbUrl: string, falharPrimeiras: number) {
  const u = new URL(targetDbUrl);
  const targetHost = u.hostname;
  const targetPort = Number(u.port) || 5432;
  let tentativas = 0;

  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    tentativas += 1;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);

    if (tentativas <= falharPrimeiras) {
      client.destroy();
      return;
    }

    const upstream = net.connect(targetPort, targetHost);
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const proxyPort = (server.address() as AddressInfo).port;
  const proxyUrl = new URL(targetDbUrl);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String(proxyPort);

  return {
    proxyDbUrl: proxyUrl.toString(),
    getAttempts: () => tentativas,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function spawnBackend(port: number, env: NodeJS.ProcessEnv) {
  const child: Child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET,
      ADMIN_PASSWORD,
      CRON_SECRET,
      PG_IDLE_TIMEOUT: '200',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += String(c); });
  child.stderr.on('data', (c) => { stderr += String(c); });
  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function stopBackend(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

async function waitHealth(
  baseUrl: string,
  child: Child,
  predicate: (r: { status: number; body: any }) => boolean,
  timeoutMs = 60_000
): Promise<{ status: number; body: any }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: number; body: any } | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`processo encerrou prematuramente com code=${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const body = await res.json();
      last = { status: res.status, body };
      if (predicate(last)) return last;
    } catch {
      /* porta ainda abrindo */
    }
    await delay(50);
  }
  throw new Error(`timeout esperando /api/health em ${baseUrl} (ultimo=${JSON.stringify(last)})`);
}

test('PROD-DB-03 (1, 9, 10) PostgreSQL real disponivel na 1a tentativa em modo production', { timeout: 120_000 }, async (t) => {
  const banco = await criarBancoDescartavel('res_ok');
  t.after(() => destruirBancoDescartavel(banco));

  const porta = await reservarPorta();
  const srv = spawnBackend(porta, {
    NODE_ENV: 'production',
    PGSSL: 'false',
    DATABASE_URL: banco.url,
  });
  t.after(() => stopBackend(srv.child));

  const h = await waitHealth(srv.baseUrl, srv.child, (x) => x.status === 200);
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.processo, 'iniciado');
  assert.equal(h.body.banco, 'conectado');
  assert.equal(h.body.pronto, true);
  assert.equal(h.body.estado, 'pronto');
  assert.equal(h.body.db, 'postgres');
  assert.match(srv.stdout(), /PostgreSQL conectado na tentativa 1/);

  const cronRes = await fetch(`${srv.baseUrl}/api/admin/scheduled/cron/crm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  assert.equal(cronRes.status, 200, 'cron executa apos prontidao');
});

test('PROD-DB-03 (2, 3, 9, 10) Indisponibilidade transitoria inicial recupera sem exit 1 via backoff progressivo', { timeout: 120_000 }, async (t) => {
  const banco = await criarBancoDescartavel('res_retry');
  t.after(() => destruirBancoDescartavel(banco));

  const proxy = await criarProxyTcp(banco.url, 3);
  t.after(() => proxy.close());

  const porta = await reservarPorta();
  const srv = spawnBackend(porta, {
    NODE_ENV: 'production',
    PGSSL: 'false',
    DATABASE_URL: proxy.proxyDbUrl,
    PG_CONNECT_TIMEOUT: '2000',
    PG_STARTUP_TIMEOUT_MS: '30000',
    PG_STARTUP_RETRY_BASE_MS: '400',
    PG_STARTUP_RETRY_MAX_MS: '1500',
    PG_STARTUP_MAX_ATTEMPTS: '10',
  });
  t.after(() => stopBackend(srv.child));

  // Antes da recuperacao: processo iniciado, banco indisponivel, health=503, cron=503, negocio=503
  const hAntes = await waitHealth(srv.baseUrl, srv.child, (x) => x.status === 503);
  assert.equal(hAntes.status, 503);
  assert.equal(hAntes.body.ok, false);
  assert.equal(hAntes.body.processo, 'iniciado');
  assert.equal(hAntes.body.banco, 'indisponivel');
  assert.equal(hAntes.body.pronto, false);
  assert.equal(hAntes.body.db, 'postgres-degraded');

  const [cronAntes, vendasAntes] = await Promise.all([
    fetch(`${srv.baseUrl}/api/admin/scheduled/cron/crm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    fetch(`${srv.baseUrl}/api/vendas`),
  ]);
  assert.equal(cronAntes.status, 503, 'cron nao executa antes da prontidao');
  assert.equal(vendasAntes.status, 503, 'negocio bloqueado antes da prontidao');

  // Apos as 3 falhas iniciais, a 4a tentativa passa pelo proxy e completa todas as migrations
  const hDepois = await waitHealth(srv.baseUrl, srv.child, (x) => x.status === 200);
  assert.equal(hDepois.status, 200);
  assert.equal(hDepois.body.ok, true);
  assert.equal(hDepois.body.banco, 'conectado');
  assert.equal(hDepois.body.pronto, true);
  assert.equal(hDepois.body.estado, 'pronto');
  assert.equal(hDepois.body.db, 'postgres');
  assert.ok(proxy.getAttempts() >= 4, `esperava >=4 tentativas no proxy; houve ${proxy.getAttempts()}`);
  assert.match(srv.stderr(), /PostgreSQL indisponível na tentativa 1/);
  assert.match(srv.stdout(), /Conexão com PostgreSQL recuperada na tentativa 4/);

  const c = await conectar(banco);
  try {
    const aplicadas = await migrationsRegistradas(c);
    const esperadas = await nomesDasMigrations();
    assert.deepEqual(aplicadas, esperadas, 'todas migrations aplicadas apos recuperacao');
    assert.ok(aplicadas.includes('0109_payments_oms_estado_pedido.sql'));
  } finally {
    await c.end();
  }

  const cronDepois = await fetch(`${srv.baseUrl}/api/admin/scheduled/cron/crm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  assert.equal(cronDepois.status, 200, 'cron liberado apos prontidao');
});

test('PROD-DB-03 (4, 5) Erro permanente (3D000) falha na 1a tentativa e startup timeout evita loop infinito', { timeout: 120_000 }, async (t) => {
  // 4. Banco inexistente (3D000)
  const badUrl = new URL(process.env.DATABASE_URL!);
  badUrl.pathname = `/inexistente_${Date.now().toString(36)}`;
  const portaPerm = await reservarPorta();
  const t0Perm = Date.now();
  const srvPerm = spawnBackend(portaPerm, {
    NODE_ENV: 'production',
    PGSSL: 'false',
    DATABASE_URL: badUrl.toString(),
    PG_CONNECT_TIMEOUT: '2000',
    PG_STARTUP_TIMEOUT_MS: '20000',
    PG_STARTUP_RETRY_BASE_MS: '500',
  });
  t.after(() => stopBackend(srvPerm.child));

  const codePerm = await new Promise<number | null>((resolve) => srvPerm.child.once('exit', (c) => resolve(c)));
  const elapsedPerm = Date.now() - t0Perm;
  assert.equal(codePerm, 1);
  assert.ok(elapsedPerm < 10_000, `erro permanente deve falhar rapido sem esperar 20s (levou ${elapsedPerm}ms)`);
  assert.match(srvPerm.stderr(), /fase=conexao tipo=permanente/);
  assert.equal(/fase=desconhecida|\(null\)/.test(srvPerm.stderr()), false);

  // 5. Timeout de startup limitado (sem loop infinito)
  const closedPort = await reservarPorta();
  const portaTo = await reservarPorta();
  const closedUrl = new URL(process.env.DATABASE_URL!);
  closedUrl.hostname = '127.0.0.1';
  closedUrl.port = String(closedPort);
  const t0To = Date.now();
  const srvTo = spawnBackend(portaTo, {
    NODE_ENV: 'production',
    PGSSL: 'false',
    DATABASE_URL: closedUrl.toString(),
    PG_CONNECT_TIMEOUT: '250',
    PG_STARTUP_TIMEOUT_MS: '800',
    PG_STARTUP_RETRY_BASE_MS: '150',
    PG_STARTUP_RETRY_MAX_MS: '300',
  });
  t.after(() => stopBackend(srvTo.child));

  const codeTo = await new Promise<number | null>((resolve) => srvTo.child.once('exit', (c) => resolve(c)));
  const elapsedTo = Date.now() - t0To;
  assert.equal(codeTo, 1);
  assert.ok(elapsedTo < 10_000, `timeout deve encerrar no limite configurado (levou ${elapsedTo}ms)`);
  assert.match(srvTo.stderr(), /fase=conexao tipo=timeout/);
  assert.equal(/fase=desconhecida|\(null\)/.test(srvTo.stderr()), false);
});

test('PROD-DB-03 (6, 7, 8, 9, 10) Idempotencia de migrations e falha de migration deixa health 503 com banco conectado e pronto=false', { timeout: 120_000 }, async (t) => {
  // 6 & 7: pendentes -> aplicadas -> reaplicacao idempotente
  const bancoIdemp = await criarBancoDescartavel('res_idemp');
  t.after(() => destruirBancoDescartavel(bancoIdemp));
  const r1 = await rodarBoot(bancoIdemp);
  assert.equal(r1.estado?.status, 'ready');
  const r2 = await rodarBoot(bancoIdemp);
  assert.equal(r2.estado?.status, 'ready');
  assert.equal(r2.stdout.includes('Migração aplicada:'), false, 'migrations ja aplicadas nao sao reaplicadas');

  // 8 (transacao): migration com erro sofre ROLLBACK completo sem registro em schema_migrations
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brobond-pg-mig-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
  writeFileSync(path.join(tmpDir, '9001_ok.sql'), 'CREATE TABLE IF NOT EXISTS _tmp_resil_ok (id INT PRIMARY KEY);', 'utf8');
  writeFileSync(path.join(tmpDir, '9002_fail.sql'), 'CREATE TABLE _tmp_resil_fail (id INT); SELECT 1 / 0;', 'utf8');
  const clientMig = new Client({ connectionString: bancoIdemp.url });
  await clientMig.connect();
  try {
    await assert.rejects(
      () => aplicarMigrationsVersionadas(clientMig, { migrationsDir: tmpDir }),
      /9002_fail\.sql/
    );
    const { rows: okRows } = await clientMig.query(`SELECT to_regclass('public._tmp_resil_ok') AS t`);
    const { rows: failRows } = await clientMig.query(`SELECT to_regclass('public._tmp_resil_fail') AS t`);
    assert.notEqual(okRows[0].t, null, '9001_ok foi comitada antes da falha');
    assert.equal(failRows[0].t, null, '9002_fail sofreu rollback total');
    const reg = await migrationsRegistradas(clientMig);
    assert.equal(reg.includes('9001_ok.sql'), true);
    assert.equal(reg.includes('9002_fail.sql'), false);
  } finally {
    await clientMig.end();
  }

  // 8, 9, 10: dado legado bloqueando 0030 em HTTP real (NODE_ENV=test para inspecionar /api/health 503)
  const bancoFalho = await criarBancoDescartavel('res_mig_fail');
  t.after(() => destruirBancoDescartavel(bancoFalho));
  const c = await conectar(bancoFalho);
  try {
    await aplicarArquivo(c, BOOTSTRAP);
    await aplicarCadeia(c, '0029_estoque_reservas_transferencias.sql');
    const emp = await c.query(`INSERT INTO empresas (nome) VALUES ('Empresa Legada') RETURNING id`);
    const empId = Number(emp.rows[0].id);
    await c.query(`INSERT INTO locais (empresa_id, nome, tipo, padrao) VALUES ($1, 'Deposito Duplicado', 'armazem', false)`, [empId]);
    await c.query(`INSERT INTO locais (empresa_id, nome, tipo, padrao) VALUES ($1, 'Deposito Duplicado', 'armazem', false)`, [empId]);
  } finally {
    await c.end();
  }

  const porta = await reservarPorta();
  const srv = spawnBackend(porta, {
    NODE_ENV: 'test',
    DATABASE_URL: bancoFalho.url,
  });
  t.after(() => stopBackend(srv.child));

  const h = await waitHealth(
    srv.baseUrl,
    srv.child,
    (x) => x.status === 503 && x.body?.fase === 'migrations'
  );
  assert.equal(h.status, 503, 'nunca 200 quando migration falha');
  assert.equal(h.body.ok, false);
  assert.equal(h.body.processo, 'iniciado');
  assert.equal(h.body.banco, 'conectado', 'banco conectou, mas migrations falharam');
  assert.equal(h.body.pronto, false);
  assert.equal(h.body.db, 'postgres-degraded');
  assert.equal(h.body.fase, 'migrations');

  const cronRes = await fetch(`${srv.baseUrl}/api/admin/scheduled/cron/crm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  assert.equal(cronRes.status, 503);
});
