import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';

delete process.env.DATABASE_URL;
process.env.NODE_ENV = 'test';

const {
  aplicarMigrationsVersionadas,
  bootFailure,
  calcularBackoffMs,
  classificarErroConexao,
  dbBootState,
  lerConfigBootBanco,
  migrate,
  migrationError,
  sanitizarMensagemErro,
} = await import('../src/db');

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const TEST_ADMIN_PWD = 'Br0bond!TestAdmin#2026';
const TEST_JWT_SECRET = 'jwt-secreto-forte-de-teste-startup-resilience-0123456789';

function createFakePgClient(opts: {
  onQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> | { rows: any[] };
  onRelease?: (destroy?: boolean | Error) => void;
} = {}): PoolClient {
  const client: any = {
    query: async (sql: string, params?: unknown[]) => {
      if (opts.onQuery) return await opts.onQuery(sql, params);
      return { rows: [] };
    },
    release: (destroy?: boolean | Error) => {
      opts.onRelease?.(destroy);
    },
    on: () => client,
    off: () => client,
    removeListener: () => client,
  };
  return client as PoolClient;
}

function createMemoryMigrationClient() {
  const executedSql: string[] = [];
  const applied = new Set<string>();
  let txSnapshots: Set<string> | null = null;
  let inTx = false;

  const client = createFakePgClient({
    onQuery: async (sql: string, params?: unknown[]) => {
      const trimmed = sql.trim();
      if (/^BEGIN$/i.test(trimmed)) {
        inTx = true;
        txSnapshots = new Set(applied);
        return { rows: [] };
      }
      if (/^COMMIT$/i.test(trimmed)) {
        inTx = false;
        txSnapshots = null;
        return { rows: [] };
      }
      if (/^ROLLBACK$/i.test(trimmed)) {
        if (inTx && txSnapshots) {
          applied.clear();
          for (const item of txSnapshots) applied.add(item);
        }
        inTx = false;
        txSnapshots = null;
        return { rows: [] };
      }
      if (/^SELECT 1$/i.test(trimmed) || /pg_advisory_(?:un)?lock/i.test(trimmed)) {
        return { rows: [] };
      }
      if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(trimmed)) {
        return { rows: [] };
      }
      if (/^SELECT id FROM schema_migrations$/i.test(trimmed)) {
        return { rows: [...applied].sort().map((id) => ({ id })) };
      }
      if (/^INSERT INTO schema_migrations/i.test(trimmed)) {
        applied.add(String(params?.[0] ?? ''));
        return { rows: [] };
      }
      if (/FAIL_MIGRATION/i.test(trimmed)) {
        throw new Error('erro SQL simulado na migration');
      }
      executedSql.push(trimmed);
      return { rows: [] };
    },
  });

  return { client, applied, executedSql };
}

function createSilentLogger() {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    warns,
    errors,
    logger: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => warns.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
    },
  };
}

function pgWireErrorPacket(sqlState: string, message: string): Buffer {
  const body = Buffer.concat([
    Buffer.from('SFATAL\0', 'utf8'),
    Buffer.from(`C${sqlState}\0`, 'utf8'),
    Buffer.from(`M${message}\0`, 'utf8'),
    Buffer.from('\0', 'utf8'),
  ]);
  const header = Buffer.alloc(5);
  header[0] = 'E'.charCodeAt(0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

async function startPgErrorTcpServer(handler: (attempt: number, socket: net.Socket) => void) {
  let attempts = 0;
  const server = net.createServer((socket) => {
    attempts += 1;
    const current = attempts;
    socket.on('error', () => undefined);
    socket.once('data', (chunk) => {
      // Handle SSLRequest ('\x00\x00\x00\x08\x04\xd2\x16\x2f') by replying 'N' so pg continues with StartupMessage
      if (chunk.length === 8 && chunk.readInt32BE(4) === 80877103) {
        socket.write('N');
        socket.once('data', () => handler(current, socket));
        return;
      }
      handler(current, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    getAttempts: () => attempts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function getFreePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function spawnBackend(port: number, env: Record<string, string | undefined>) {
  const mergedEnv: Record<string, string> = {
    PATH: process.env.PATH || '',
    PORT: String(port),
    JWT_SECRET: TEST_JWT_SECRET,
    ADMIN_PASSWORD: TEST_ADMIN_PWD,
    CRON_SECRET: 'cron-secret-resilience-test',
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete mergedEnv[k];
    else mergedEnv[k] = v;
  }

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function stopBackend(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<{ status: number; body: any }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      const body = await res.json();
      return { status: res.status, body };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`Health endpoint unreachable within ${timeoutMs}ms`);
}

describe('PostgreSQL startup resilience (10 cenarios)', () => {
  test('1. PostgreSQL disponivel na 1a tentativa conclui boot e registra sucesso', async () => {
    const queries: string[] = [];
    let releasedDestroy: boolean | Error | undefined;
    const { logger, logs, warns, errors } = createSilentLogger();

    const client = createFakePgClient({
      onQuery: (sql) => {
        queries.push(sql.trim());
        return { rows: [] };
      },
      onRelease: (d) => { releasedDestroy = d; },
    });

    await migrate({
      clientFactory: async () => client,
      bootstrapFn: async () => { queries.push('BOOTSTRAP'); },
      migrationsFn: async () => { queries.push('MIGRATIONS'); },
      logger,
    });

    const defaultCfg = lerConfigBootBanco();
    assert.equal(defaultCfg.connectTimeoutMs, 10_000);
    assert.equal(defaultCfg.startupTimeoutMs, 60_000);
    assert.equal(defaultCfg.retryBaseMs, 500);
    assert.equal(defaultCfg.retryMaxMs, 8_000);
    assert.equal(defaultCfg.maxAttempts, 20);

    const state = dbBootState();
    assert.equal(state.connected, true);
    assert.equal(state.ready, true);
    assert.equal(state.stage, 'ready');
    assert.equal(state.failure, null);
    assert.equal(bootFailure(), null);
    assert.equal(migrationError(), null);
    assert.equal(warns.length, 0);
    assert.equal(errors.length, 0);
    assert.ok(logs.some((l) => /tentativa 1/i.test(l)));
    assert.equal(releasedDestroy, false);
    assert.deepEqual(queries, [
      'SELECT 1',
      "SELECT pg_advisory_lock(hashtext('brobond_schema_bootstrap'))",
      'BOOTSTRAP',
      'MIGRATIONS',
      "SELECT pg_advisory_unlock(hashtext('brobond_schema_bootstrap'))",
    ]);
  });

  test('2. PostgreSQL indisponivel nas 2 primeiras tentativas e disponivel na 3a recupera com backoff progressivo', async () => {
    const sleeps: number[] = [];
    let fakeNow = 1000;
    let calls = 0;
    const { logger, logs, warns, errors } = createSilentLogger();

    await migrate({
      clientFactory: async () => {
        calls += 1;
        fakeNow += 25;
        if (calls === 1) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
        if (calls === 2) throw Object.assign(new Error('the database system is starting up'), { code: '57P03' });
        return createFakePgClient();
      },
      bootstrapFn: async () => {},
      migrationsFn: async () => {},
      startupConfig: { connectTimeoutMs: 1000, startupTimeoutMs: 10_000, retryBaseMs: 200, retryMaxMs: 1000, maxAttempts: 10 },
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
      now: () => fakeNow,
      logger,
    });

    const state = dbBootState();
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [200, 400]);
    assert.equal(state.connected, true);
    assert.equal(state.ready, true);
    assert.equal(state.stage, 'ready');
    assert.equal(state.failure, null);
    assert.equal(warns.length, 2);
    assert.equal(errors.length, 0);
    assert.match(warns[0], /tentativa 1\/10/i);
    assert.match(warns[1], /tentativa 2\/10/i);
    assert.ok(logs.some((l) => /recuperada na tentativa 3\/10/i.test(l)));
  });

  test('3. Erros transitorios (AggregateError, drop no SELECT 1/lock, timeout de socket) sao retentados com backoff limitado', async () => {
    // 3a. Classificacao explicita de erros transitorios inclusive AggregateError do Node 22/24
    const agg = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      ],
      ''
    );
    assert.equal(classificarErroConexao(agg).transitorio, true);
    assert.equal(classificarErroConexao(agg).codigo, 'ECONNREFUSED');
    assert.match(sanitizarMensagemErro(agg), /ECONNREFUSED/);

    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', '57P01', '57P03', '53300', '08006']) {
      const cls = classificarErroConexao(Object.assign(new Error('transient'), { code }));
      assert.equal(cls.transitorio, true, `${code} deve ser transitorio`);
    }
    assert.equal(calcularBackoffMs(1, 500, 3000), 500);
    assert.equal(calcularBackoffMs(2, 500, 3000), 1000);
    assert.equal(calcularBackoffMs(3, 500, 3000), 2000);
    assert.equal(calcularBackoffMs(4, 500, 3000), 3000);

    // 3b. Drop durante SELECT 1 e tentativa lenta que excede connectTimeoutMs devem destruir o cliente e recuperar na tentativa 3
    let attempt = 0;
    const destroyed: Array<boolean | Error | undefined> = [];
    const { logger } = createSilentLogger();

    await migrate({
      clientFactory: async () => {
        attempt += 1;
        if (attempt === 1) {
          // Conexao abre mas cai no SELECT 1
          return createFakePgClient({
            onQuery: async () => {
              throw new Error('Connection terminated unexpectedly');
            },
            onRelease: (d) => destroyed.push(d),
          });
        }
        if (attempt === 2) {
          // Conexao trava alem do connectTimeoutMs (60ms) e resolve tarde: cliente tardio precisa ser destruido
          return new Promise<PoolClient>((resolve) => {
            setTimeout(() => resolve(createFakePgClient({ onRelease: (d) => destroyed.push(d) })), 150);
          });
        }
        return createFakePgClient({ onRelease: (d) => destroyed.push(d) });
      },
      bootstrapFn: async () => {},
      migrationsFn: async () => {},
      startupConfig: { connectTimeoutMs: 60, startupTimeoutMs: 3000, retryBaseMs: 20, retryMaxMs: 50, maxAttempts: 5 },
      logger,
    });

    // Aguarda eventual resolucao tardia da tentativa 2
    await new Promise((r) => setTimeout(r, 180));
    assert.equal(attempt, 3);
    assert.equal(dbBootState().ready, true);
    assert.ok(destroyed.filter((d) => d === true).length >= 2, 'clientes com erro/timeout devem ser destruidos (release(true))');
  });

  test('4. Erro permanente falha rapido na 1a tentativa sem retry infinito e mascara credenciais', async () => {
    for (const code of ['28P01', '28000', '3D000', '3F000', '42501', 'ERR_INVALID_URL', 'CERT_HAS_EXPIRED']) {
      assert.equal(classificarErroConexao(Object.assign(new Error('perm'), { code })).transitorio, false, `${code} deve ser permanente`);
    }
    assert.equal(classificarErroConexao(new Error('compute is starting up')).transitorio, true);

    let attempts = 0;
    let slept = false;
    const { logger, errors } = createSilentLogger();

    await migrate({
      clientFactory: async () => {
        attempts += 1;
        throw Object.assign(
          new Error('password authentication failed for user "brobond" at postgresql://admin:SuperSecret123@db.internal:5432/erp password=KvSecret999'),
          { code: '28P01' }
        );
      },
      startupConfig: { connectTimeoutMs: 1000, startupTimeoutMs: 60_000, retryBaseMs: 100, retryMaxMs: 1000, maxAttempts: 10 },
      sleep: async () => { slept = true; },
      logger,
    });

    const state = dbBootState();
    assert.equal(attempts, 1, 'falha permanente nao deve ser retentada');
    assert.equal(slept, false);
    assert.equal(state.connected, false);
    assert.equal(state.ready, false);
    assert.equal(state.stage, 'degraded');
    assert.equal(state.failure?.fase, 'conexao');
    assert.equal(state.failure?.tipo, 'permanente');
    assert.equal(state.failure?.tentativas, 1);
    assert.ok(state.failure?.mensagem.includes('28P01'));
    assert.equal(state.failure?.mensagem.includes('SuperSecret123'), false, 'credenciais nunca vazam na mensagem de boot');
    assert.equal(state.failure?.mensagem.includes('KvSecret999'), false, 'password= key-value nunca vaza na mensagem de boot');
    assert.equal(errors.some((e) => e.includes('SuperSecret123') || e.includes('KvSecret999')), false, 'credenciais nunca vazam no log');

    // Tambem testa via servidor PG-wire real no socket TCP com processo de producao (exit 1 imediato, sem retry)
    const pgErrSrv = await startPgErrorTcpServer((_n, socket) => {
      socket.write(pgWireErrorPacket('28P01', 'password authentication failed for user "bad"'));
      socket.end();
    });
    const apiPort = await getFreePort();
    const srv = spawnBackend(apiPort, {
      NODE_ENV: 'production',
      PGSSL: 'false',
      DATABASE_URL: `postgresql://bad:secret@127.0.0.1:${pgErrSrv.port}/brobond`,
      PG_CONNECT_TIMEOUT: '1000',
      PG_STARTUP_TIMEOUT_MS: '15000',
      PG_STARTUP_RETRY_BASE_MS: '100',
    });
    try {
      const code = await new Promise<number | null>((resolve) => srv.child.once('exit', (c) => resolve(c)));
      assert.equal(code, 1);
      assert.equal(pgErrSrv.getAttempts(), 1, 'producao falha na 1a tentativa diante de 28P01 real');
      assert.match(srv.getStderr(), /fase=conexao tipo=permanente/);
      assert.equal(/fase=desconhecida|\(null\)/.test(srv.getStderr()), false);
    } finally {
      await stopBackend(srv.child);
      await pgErrSrv.close();
    }
  });

  test('5. Startup timeout encerra retentativas dentro do limite configurado sem loop infinito', async () => {
    let fakeNow = 0;
    let attempts = 0;
    const sleeps: number[] = [];
    const { logger } = createSilentLogger();

    await migrate({
      clientFactory: async () => {
        attempts += 1;
        fakeNow += 50;
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      },
      startupConfig: { connectTimeoutMs: 500, startupTimeoutMs: 1000, retryBaseMs: 200, retryMaxMs: 500, maxAttempts: 20 },
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
      now: () => fakeNow,
      logger,
    });

    const state = dbBootState();
    assert.ok(attempts >= 2 && attempts <= 5, `tentativas limitadas pelo timeout (obtido ${attempts})`);
    assert.ok(fakeNow <= 1000, `duracao (${fakeNow}ms) respeita startupTimeoutMs=1000ms`);
    assert.equal(state.stage, 'degraded');
    assert.equal(state.connected, false);
    assert.equal(state.ready, false);
    assert.equal(state.failure?.fase, 'conexao');
    assert.equal(state.failure?.tipo, 'timeout');
    assert.ok(sleeps.length >= 1);

    // Tambem valida limite maxAttempts (para antes do startupTimeoutMs se maxAttempts for menor)
    let maxAttCalls = 0;
    await migrate({
      clientFactory: async () => {
        maxAttCalls += 1;
        throw Object.assign(new Error('the database system is starting up'), { code: '57P03' });
      },
      startupConfig: { connectTimeoutMs: 500, startupTimeoutMs: 60_000, retryBaseMs: 10, retryMaxMs: 20, maxAttempts: 3 },
      sleep: async () => {},
      logger,
    });
    assert.equal(maxAttCalls, 3);
    assert.equal(dbBootState().failure?.tentativas, 3);
    assert.equal(dbBootState().failure?.tipo, 'timeout');

    // Processo real em NODE_ENV=production contra porta fechada encerra com exit 1 ao estourar PG_STARTUP_TIMEOUT_MS
    const closedPort = await getFreePort();
    const apiPort = await getFreePort();
    const t0 = Date.now();
    const srv = spawnBackend(apiPort, {
      NODE_ENV: 'production',
      PGSSL: 'false',
      DATABASE_URL: `postgresql://u:p@127.0.0.1:${closedPort}/db`,
      PG_CONNECT_TIMEOUT: '200',
      PG_STARTUP_TIMEOUT_MS: '700',
      PG_STARTUP_RETRY_BASE_MS: '100',
      PG_STARTUP_RETRY_MAX_MS: '250',
      PG_STARTUP_MAX_ATTEMPTS: '10',
    });
    try {
      const code = await new Promise<number | null>((resolve) => srv.child.once('exit', (c) => resolve(c)));
      const elapsed = Date.now() - t0;
      assert.equal(code, 1);
      assert.ok(elapsed < 10_000, `encerramento limitado no tempo (${elapsed}ms)`);
      assert.match(srv.getStderr(), /fase=conexao tipo=timeout/);
      assert.equal(/fase=desconhecida|\(null\)/.test(srv.getStderr()), false);
    } finally {
      await stopBackend(srv.child);
    }
  });

  test('6, 7 e 8. Migrations pendentes, ja aplicadas (idempotentes) e falha com rollback e recuperacao', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brobond-mig-test-'));
    try {
      writeFileSync(path.join(tmpDir, '0002_segunda.sql'), 'CREATE TABLE t2 (id int);');
      writeFileSync(path.join(tmpDir, '0001_primeira.sql'), 'CREATE TABLE t1 (id int);');
      writeFileSync(path.join(tmpDir, '0003_terceira.sql'), 'FAIL_MIGRATION;');
      writeFileSync(path.join(tmpDir, '0004_quarta.sql'), 'CREATE TABLE t4 (id int);');

      const { client, applied, executedSql } = createMemoryMigrationClient();
      const { logger } = createSilentLogger();

      // 7 & 8: 0001 e 0002 rodam em ordem lexica; 0003 falha e interrompe antes da 0004
      await migrate({
        clientFactory: async () => client,
        bootstrapFn: async () => {},
        migrationsFn: async (c) => aplicarMigrationsVersionadas(c, { migrationsDir: tmpDir, logger }),
        logger,
      });

      const failState = dbBootState();
      assert.equal(failState.connected, true, 'banco conectou antes das migrations');
      assert.equal(failState.ready, false, 'migration falhou entao ready segue false');
      assert.equal(failState.stage, 'degraded');
      assert.equal(failState.failure?.fase, 'migrations');
      assert.match(failState.failure?.mensagem || '', /0003_terceira\.sql/);
      assert.deepEqual([...applied], ['0001_primeira.sql', '0002_segunda.sql']);
      assert.deepEqual(executedSql, ['CREATE TABLE t1 (id int);', 'CREATE TABLE t2 (id int);']);

      // Corrige 0003 e reexecuta: 0001 e 0002 ja aplicadas sao puladas (6); 0003 e 0004 rodam (7)
      writeFileSync(path.join(tmpDir, '0003_terceira.sql'), 'CREATE TABLE t3 (id int);');
      executedSql.length = 0;

      await migrate({
        clientFactory: async () => client,
        bootstrapFn: async () => {},
        migrationsFn: async (c) => aplicarMigrationsVersionadas(c, { migrationsDir: tmpDir, logger }),
        logger,
      });

      assert.equal(dbBootState().ready, true);
      assert.equal(dbBootState().failure, null);
      assert.deepEqual([...applied], [
        '0001_primeira.sql',
        '0002_segunda.sql',
        '0003_terceira.sql',
        '0004_quarta.sql',
      ]);
      assert.deepEqual(executedSql, ['CREATE TABLE t3 (id int);', 'CREATE TABLE t4 (id int);']);

      // 6: Reexecutar com todas ja aplicadas e totalmente idempotente
      executedSql.length = 0;
      await migrate({
        clientFactory: async () => client,
        bootstrapFn: async () => {},
        migrationsFn: async (c) => aplicarMigrationsVersionadas(c, { migrationsDir: tmpDir, logger }),
        logger,
      });
      assert.equal(dbBootState().ready, true);
      assert.deepEqual(executedSql, []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('9. /api/health distingue processo iniciado, banco indisponivel, banco conectado (migrando/falho) e pronto para trafego', async () => {
    // 9a. Transicoes internas de estado (connecting -> migrating -> ready) observaveis em dbBootState()
    const observedStages: Array<{ connected: boolean; ready: boolean; stage: string }> = [];
    const { logger } = createSilentLogger();
    await migrate({
      clientFactory: async () => {
        const s = dbBootState();
        observedStages.push({ connected: s.connected, ready: s.ready, stage: s.stage });
        return createFakePgClient();
      },
      bootstrapFn: async () => {
        const s = dbBootState();
        observedStages.push({ connected: s.connected, ready: s.ready, stage: s.stage });
      },
      migrationsFn: async () => {},
      logger,
    });
    {
      const s = dbBootState();
      observedStages.push({ connected: s.connected, ready: s.ready, stage: s.stage });
    }

    assert.deepEqual(observedStages, [
      { connected: false, ready: false, stage: 'connecting' },
      { connected: true, ready: false, stage: 'migrating' },
      { connected: true, ready: true, stage: 'ready' },
    ]);

    // 9b. Servidor HTTP real com banco obrigatorio indisponivel: processo iniciado + banco indisponivel + NUNCA 200
    const closedPort = await getFreePort();
    const apiPort = await getFreePort();
    const srvDegraded = spawnBackend(apiPort, {
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://u:p@127.0.0.1:${closedPort}/db`,
      PG_CONNECT_TIMEOUT: '300',
      PG_STARTUP_TIMEOUT_MS: '600',
      PG_STARTUP_RETRY_BASE_MS: '100',
    });
    try {
      const h = await waitForHealth(srvDegraded.baseUrl);
      assert.equal(h.status, 503, 'health nunca retorna 200 quando banco obrigatorio esta indisponivel');
      assert.equal(h.body.ok, false);
      assert.equal(h.body.processo, 'iniciado');
      assert.equal(h.body.banco, 'indisponivel');
      assert.equal(h.body.pronto, false);
      assert.equal(h.body.db, 'postgres-degraded');
      assert.equal(h.body.fase, 'conexao');

      // Mesmo apos estourar timeout de startup, segue 503 (nao 200) e cron/negocio retornam 503
      await new Promise((r) => setTimeout(r, 750));
      const hAfter = await fetch(`${srvDegraded.baseUrl}/api/health`).then(async (r) => ({ status: r.status, body: await r.json() }));
      assert.equal(hAfter.status, 503);
      assert.equal(hAfter.body.banco, 'indisponivel');
      assert.equal(hAfter.body.pronto, false);
      assert.equal(hAfter.body.erroTipo, 'timeout');
    } finally {
      await stopBackend(srvDegraded.child);
    }

    // 9c. Servidor HTTP real em modo demonstracao (sem DATABASE_URL): pronto = true -> HTTP 200
    const demoPort = await getFreePort();
    const srvDemo = spawnBackend(demoPort, {
      NODE_ENV: 'test',
      DATABASE_URL: undefined,
    });
    try {
      const deadline = Date.now() + 15_000;
      let h = { status: 0, body: null as any };
      while (Date.now() < deadline) {
        h = await waitForHealth(srvDemo.baseUrl);
        if (h.status === 200) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(h.status, 200);
      assert.equal(h.body.ok, true);
      assert.equal(h.body.processo, 'iniciado');
      assert.equal(h.body.banco, 'memoria');
      assert.equal(h.body.pronto, true);
      assert.equal(h.body.estado, 'pronto');
      assert.equal(h.body.db, 'memory');
    } finally {
      await stopBackend(srvDemo.child);
    }
  });

  test('10. Workers, cron e rotas de negocio nao iniciam nem executam antes da prontidao obrigatoria', async () => {
    // 10a. Guardas diretas nos modulos cron/outbox/negocios quando DATABASE_URL existe mas !isDbConnected()
    const closedPort = await getFreePort();
    const checkScript = `
      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:${closedPort}/db';
      process.env.NODE_ENV = 'test';
      const db = await import('./src/db.ts');
      const sched = await import('./src/scheduled.ts');
      const outbox = await import('./src/commerce/outbox.ts');
      const neg = await import('./src/negocios.ts');

      let executorChamado = false;
      sched.processosCron.crm = async () => { executorChamado = true; return { itens: 1, detalhes: [], falhas: [] }; };

      const rCron = await sched.executarProcessoCron('crm');
      const rOutbox = await outbox.processarComercioAgendado();
      const rMotor = await neg.atualizarMotorNegocios();
      neg.initNegociosEngine();
      neg.agendarRecalculo(['s1'], 1);
      neg.agendarProjecaoVendasErp(1);

      console.log('__GATES__' + JSON.stringify({
        connected: db.isDbConnected(),
        degraded: db.isDbDegraded(),
        executorChamado,
        rCronStatus: rCron.status,
        rCronOk: rCron.ok,
        rOutboxFalhas: rOutbox.falhas,
        rMotor,
      }));
      await db.pool?.end().catch(() => {});
    `;
    const gateRes = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', checkScript], {
        cwd: SERVER_DIR,
        env: { PATH: process.env.PATH || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += String(d); });
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('close', (code) => resolve({ code, out, err }));
    });

    assert.equal(gateRes.code, 0, gateRes.err);
    const gateLine = gateRes.out.split('\n').find((l) => l.startsWith('__GATES__'));
    assert.ok(gateLine, gateRes.out);
    const gates = JSON.parse(gateLine.slice('__GATES__'.length));
    assert.equal(gates.connected, false);
    assert.equal(gates.degraded, true);
    assert.equal(gates.executorChamado, false, 'cron nao executa o processo antes da prontidao');
    assert.equal(gates.rCronStatus, 503);
    assert.equal(gates.rCronOk, false);
    assert.deepEqual(gates.rOutboxFalhas, ['banco_indisponivel']);
    assert.deepEqual(gates.rMotor, { margens: 0, abc: 0 });

    // 10b. Rotas HTTP de cron e negocio bloqueadas com 503 enquanto banco obrigatorio nao esta pronto
    const apiPort = await getFreePort();
    const srv = spawnBackend(apiPort, {
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://u:p@127.0.0.1:${closedPort}/db`,
      PG_CONNECT_TIMEOUT: '300',
      PG_STARTUP_TIMEOUT_MS: '600',
      PG_STARTUP_RETRY_BASE_MS: '100',
    });
    try {
      await waitForHealth(srv.baseUrl);
      const cronRes = await fetch(`${srv.baseUrl}/api/admin/scheduled/cron/crm`, {
        method: 'POST',
        headers: { authorization: 'Bearer cron-secret-resilience-test' },
      });
      assert.equal(cronRes.status, 503);

      const cronLegacyRes = await fetch(`${srv.baseUrl}/api/admin/scheduled/cron`, {
        method: 'POST',
        headers: { authorization: 'Bearer cron-secret-resilience-test' },
      });
      assert.equal(cronLegacyRes.status, 503);

      const vendasRes = await fetch(`${srv.baseUrl}/api/vendas`);
      assert.equal(vendasRes.status, 503);
    } finally {
      await stopBackend(srv.child);
    }
  });
});
