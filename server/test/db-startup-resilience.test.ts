import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PoolClient, QueryResult } from 'pg';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const SERVER_DIR = fileURLToPath(new URL('../', import.meta.url));

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

const SEGREDO_JWT_TESTE = 'jwt-segredo-forte-teste-resiliencia-db-1234567890';
const SENHA_ADMIN_TESTE = 'Senha!Forte#2026Resil';
const SEGREDO_CRON_TESTE = 'cron-segredo-teste-resiliencia-123456';

function criarLoggerMudo() {
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

function criarFakeClient(
  onQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> | { rows: any[] }
): { client: PoolClient; queries: Array<{ sql: string; params?: unknown[] }>; released: boolean[]; destroyed: boolean[] } {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const released: boolean[] = [];
  const destroyed: boolean[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (onQuery) {
        const res = await onQuery(sql, params);
        return res as QueryResult;
      }
      return { rows: [] } as unknown as QueryResult;
    },
    release: (destroy?: boolean | Error) => {
      released.push(true);
      destroyed.push(Boolean(destroy));
    },
    on: () => client,
    off: () => client,
  } as unknown as PoolClient;
  return { client, queries, released, destroyed };
}

function criarPgErrorPacket(sqlstate: string, message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from(`S`, 'ascii'),
    Buffer.from('FATAL\0', 'utf8'),
    Buffer.from(`C`, 'ascii'),
    Buffer.from(`${sqlstate}\0`, 'ascii'),
    Buffer.from(`M`, 'ascii'),
    Buffer.from(`${message}\0`, 'utf8'),
    Buffer.from([0]),
  ]);
  const packet = Buffer.alloc(1 + 4 + fields.length);
  packet[0] = 'E'.charCodeAt(0);
  packet.writeInt32BE(4 + fields.length, 1);
  fields.copy(packet, 5);
  return packet;
}

async function portaLivre(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as net.AddressInfo;
      s.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

async function esperarHttp(
  url: string,
  predicado: (status: number, body: any) => boolean,
  timeoutMs = 15_000
): Promise<{ status: number; body: any }> {
  const fim = Date.now() + timeoutMs;
  while (Date.now() < fim) {
    try {
      const r = await fetch(url);
      const body = await r.json().catch(() => null);
      if (predicado(r.status, body)) return { status: r.status, body };
    } catch {
      // servidor ainda abrindo porta
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timeout aguardando ${url}`);
}

const processosAtivos = new Set<ChildProcess>();
after(async () => {
  for (const child of processosAtivos) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  processosAtivos.clear();
});

function iniciarApiFilha(
  porta: number,
  extraEnv: NodeJS.ProcessEnv
): { child: ChildProcess; saida: () => string; exitPromise: Promise<number> } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(porta),
    JWT_SECRET: SEGREDO_JWT_TESTE,
    ADMIN_PASSWORD: SENHA_ADMIN_TESTE,
    CRON_SECRET: SEGREDO_CRON_TESTE,
    PGSSL: 'false',
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processosAtivos.add(child);
  let buf = '';
  child.stdout.on('data', (d) => { buf += String(d); });
  child.stderr.on('data', (d) => { buf += String(d); });
  const exitPromise = new Promise<number>((resolve) => {
    child.once('close', (code) => {
      processosAtivos.delete(child);
      resolve(code ?? -1);
    });
  });
  return { child, saida: () => buf, exitPromise };
}

describe('Resiliência de startup e conexão PostgreSQL', () => {
  test('1) PostgreSQL disponível na 1a tentativa: conecta, adquire advisory lock, migra e conclui sem sleep', async () => {
    const cap = criarLoggerMudo();
    const { client, queries, released, destroyed } = criarFakeClient();
    const sleeps: number[] = [];
    const ordem: string[] = [];

    await migrate({
      clientFactory: async () => client,
      sleep: async (ms) => { sleeps.push(ms); },
      bootstrapFn: async () => { ordem.push('bootstrap'); },
      migrationsFn: async () => { ordem.push('migrations'); },
      logger: cap.logger,
    });

    assert.equal(sleeps.length, 0);
    assert.deepEqual(ordem, ['bootstrap', 'migrations']);
    assert.equal(queries[0]?.sql, 'SELECT 1');
    assert.match(queries[1]?.sql || '', /pg_advisory_lock/);
    assert.match(queries[2]?.sql || '', /pg_advisory_unlock/);
    assert.deepEqual(released, [true]);
    assert.deepEqual(destroyed, [false]);
    assert.equal(dbBootState().stage, 'ready');
    assert.equal(dbBootState().connected, true);
    assert.equal(dbBootState().ready, true);
    assert.equal(bootFailure(), null);
    assert.equal(migrationError(), null);
    assert.ok(cap.logs.some((l) => l.includes('tentativa 1')));
  });

  test('2) PostgreSQL indisponível na 1a tentativa, depois disponível: backoff progressivo e recuperação registrada', async () => {
    const cap = criarLoggerMudo();
    const { client } = criarFakeClient();
    const sleeps: number[] = [];
    let t = 0;
    let tentativas = 0;

    await migrate({
      clientFactory: async () => {
        tentativas += 1;
        t += 40;
        if (tentativas === 1) {
          throw new AggregateError(
            [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })],
            ''
          );
        }
        if (tentativas === 2) {
          throw Object.assign(new Error('the database system is starting up'), { code: '57P03' });
        }
        return client;
      },
      startupConfig: { connectTimeoutMs: 1000, startupTimeoutMs: 10_000, retryBaseMs: 100, retryMaxMs: 500, maxAttempts: 6 },
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
      bootstrapFn: async () => undefined,
      migrationsFn: async () => undefined,
      logger: cap.logger,
    });

    assert.equal(tentativas, 3);
    assert.deepEqual(sleeps, [100, 200]);
    assert.equal(dbBootState().stage, 'ready');
    assert.equal(dbBootState().ready, true);
    assert.equal(bootFailure(), null);
    assert.equal(cap.warns.length, 2);
    assert.match(cap.warns[0], /tentativa 1\/6.*\[ECONNREFUSED\].*100ms/);
    assert.match(cap.warns[1], /tentativa 2\/6.*\[57P03\].*200ms/);
    assert.ok(cap.logs.some((l) => l.includes('recuperada na tentativa 3')));
  });

  test('3) Classificação de erros transitórios e backoff exponencial com teto + sanitização de credenciais', () => {
    assert.equal(calcularBackoffMs(1, 500, 8000), 500);
    assert.equal(calcularBackoffMs(2, 500, 8000), 1000);
    assert.equal(calcularBackoffMs(3, 500, 8000), 2000);
    assert.equal(calcularBackoffMs(4, 500, 8000), 4000);
    assert.equal(calcularBackoffMs(5, 500, 8000), 8000);
    assert.equal(calcularBackoffMs(6, 500, 8000), 8000);

    for (const err of [
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('getaddrinfo EAI_AGAIN db.internal'), { code: 'EAI_AGAIN' }),
      Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
      Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
      Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' }),
      new Error('Connection terminated unexpectedly'),
      new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' })], ''),
    ]) {
      assert.equal(classificarErroConexao(err).transitorio, true, `esperado transitório: ${String(err)}`);
    }

    const msgSanitizada = sanitizarMensagemErro(
      new Error('Falha ao conectar em postgresql://usuario_secreto:SenhaSuperSecreta@db.render.com:5432/prod')
    );
    assert.equal(msgSanitizada.includes('SenhaSuperSecreta'), false);
    assert.equal(msgSanitizada.includes('usuario_secreto'), false);
    assert.match(msgSanitizada, /postgres:\/\/\*\*\*@db\.render\.com:5432\/prod/);
  });

  test('4) Erro permanente de conexão (28P01/3D000/ERR_INVALID_URL): falha rápida sem retry e sem fase=desconhecida', async () => {
    for (const cod of ['28P01', '3D000', 'ERR_INVALID_URL'] as const) {
      const cap = criarLoggerMudo();
      const sleeps: number[] = [];
      let tentativas = 0;

      await migrate({
        clientFactory: async () => {
          tentativas += 1;
          throw Object.assign(new Error(`erro permanente simulado ${cod}`), { code: cod });
        },
        startupConfig: { connectTimeoutMs: 1000, startupTimeoutMs: 30_000, retryBaseMs: 100, retryMaxMs: 1000, maxAttempts: 10 },
        sleep: async (ms) => { sleeps.push(ms); },
        bootstrapFn: async () => { throw new Error('não deveria executar bootstrap'); },
        migrationsFn: async () => { throw new Error('não deveria executar migrations'); },
        logger: cap.logger,
      });

      assert.equal(tentativas, 1, `${cod} não deve entrar em retry`);
      assert.equal(sleeps.length, 0);
      assert.equal(dbBootState().stage, 'degraded');
      assert.equal(dbBootState().connected, false);
      assert.equal(bootFailure()?.fase, 'conexao');
      assert.equal(bootFailure()?.tipo, 'permanente');
      assert.ok(migrationError()?.includes(cod));
      assert.equal(cap.errors.length, 1);
    }

    // Prova real em processo filho NODE_ENV=production com servidor wire PG emitindo 28P01:
    // falha rápida na 1a tentativa e exit 1 com [fase=conexao tipo=permanente] (nunca fase=desconhecida).
    const pgPort = await portaLivre();
    let conexoes = 0;
    const wireSrv = net.createServer((socket) => {
      conexoes += 1;
      socket.once('data', () => {
        socket.write(criarPgErrorPacket('28P01', 'password authentication failed for user "brobond"'));
        socket.end();
      });
    });
    await new Promise<void>((ok) => wireSrv.listen(pgPort, '127.0.0.1', () => ok()));

    try {
      const appPort = await portaLivre();
      const p = iniciarApiFilha(appPort, {
        NODE_ENV: 'production',
        DATABASE_URL: `postgresql://brobond:errada@127.0.0.1:${pgPort}/brobond_test`,
        PG_STARTUP_TIMEOUT_MS: '10000',
        PG_STARTUP_RETRY_BASE_MS: '50',
      });
      const code = await p.exitPromise;
      const log = p.saida();
      assert.equal(code, 1);
      assert.equal(conexoes, 1, 'erro permanente 28P01 não faz retentativa');
      assert.match(log, /fase=conexao/);
      assert.match(log, /tipo=permanente/);
      assert.match(log, /28P01|password authentication failed/);
      assert.equal(log.includes('fase=desconhecida'), false);
    } finally {
      await new Promise<void>((ok) => wireSrv.close(() => ok()));
    }
  });

  test('5) Timeout no startup: respeita PG_STARTUP_TIMEOUT_MS, encerra sem loop infinito e reporta fase=conexao', async () => {
    const cap = criarLoggerMudo();
    const sleeps: number[] = [];
    let t = 0;
    let tentativas = 0;

    await migrate({
      clientFactory: async () => {
        tentativas += 1;
        t += 120;
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      },
      startupConfig: { connectTimeoutMs: 500, startupTimeoutMs: 1000, retryBaseMs: 200, retryMaxMs: 800, maxAttempts: 20 },
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
      logger: cap.logger,
    });

    assert.ok(tentativas >= 2 && tentativas <= 5);
    assert.ok(t <= 1150, `duração (${t}ms) deve respeitar o teto do startup`);
    assert.equal(dbBootState().stage, 'degraded');
    assert.equal(bootFailure()?.fase, 'conexao');
    assert.equal(bootFailure()?.tipo, 'timeout');
    assert.match(migrationError() || '', /ETIMEDOUT|indisponível/i);

    // Também garante que uma tentativa travada (que nunca resolve) é interrompida pelo timeout da janela.
    const capHang = criarLoggerMudo();
    const t0 = Date.now();
    await migrate({
      clientFactory: () => new Promise<PoolClient>(() => undefined),
      startupConfig: { connectTimeoutMs: 250, startupTimeoutMs: 250, retryBaseMs: 50, retryMaxMs: 100, maxAttempts: 3 },
      logger: capHang.logger,
    });
    const elapsedHang = Date.now() - t0;
    assert.ok(elapsedHang < 2000, `socket travado não pode bloquear startup (${elapsedHang}ms)`);
    assert.equal(bootFailure()?.fase, 'conexao');
    assert.equal(bootFailure()?.tipo, 'timeout');

    // Processo filho real em NODE_ENV=production contra wire server 57P03 persistente:
    // faz retries controlados dentro de PG_STARTUP_TIMEOUT_MS e encerra com exit 1 sem loop infinito.
    const pgPort = await portaLivre();
    let conexoes57P03 = 0;
    const wireSrv = net.createServer((socket) => {
      conexoes57P03 += 1;
      socket.once('data', () => {
        socket.write(criarPgErrorPacket('57P03', 'the database system is starting up'));
        socket.end();
      });
    });
    await new Promise<void>((ok) => wireSrv.listen(pgPort, '127.0.0.1', () => ok()));

    try {
      const appPort = await portaLivre();
      const p = iniciarApiFilha(appPort, {
        NODE_ENV: 'production',
        DATABASE_URL: `postgresql://brobond:senha@127.0.0.1:${pgPort}/brobond_test`,
        PG_CONNECT_TIMEOUT: '300',
        PG_STARTUP_TIMEOUT_MS: '650',
        PG_STARTUP_RETRY_BASE_MS: '80',
        PG_STARTUP_RETRY_MAX_MS: '160',
        PG_STARTUP_MAX_ATTEMPTS: '10',
      });
      const code = await p.exitPromise;
      const log = p.saida();
      assert.equal(code, 1);
      assert.ok(conexoes57P03 >= 2, `esperava múltiplas tentativas antes do timeout (houve ${conexoes57P03})`);
      assert.match(log, /fase=conexao/);
      assert.match(log, /tipo=timeout/);
      assert.equal(log.includes('fase=desconhecida'), false);
      assert.equal(log.includes('(null)'), false);
    } finally {
      await new Promise<void>((ok) => wireSrv.close(() => ok()));
    }
  });

  test('6, 7 e 8) Migrations: já aplicada (idempotente), pendente (ordem + transação) e falha (ROLLBACK + fase=migrations)', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brobond-mig-'));
    try {
      writeFileSync(path.join(tmpDir, '0001_init.sql'), 'CREATE TABLE t1 (id INT);', 'utf8');
      writeFileSync(path.join(tmpDir, '0002_add.sql'), 'CREATE TABLE t2 (id INT);', 'utf8');
      writeFileSync(path.join(tmpDir, '0003_bad.sql'), 'FAIL_ON_PURPOSE;', 'utf8');
      writeFileSync(path.join(tmpDir, '0004_after.sql'), 'CREATE TABLE t4 (id INT);', 'utf8');

      const registradas = new Set<string>(['0001_init.sql']);
      let pendentesSnapshot = new Set(registradas);
      let emTx = false;
      const executadasSql: string[] = [];

      const { client } = criarFakeClient(async (sql, params) => {
        if (sql.startsWith('SELECT id FROM schema_migrations')) {
          return { rows: [...registradas].map((id) => ({ id })) };
        }
        if (sql === 'BEGIN') {
          emTx = true;
          pendentesSnapshot = new Set(registradas);
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          emTx = false;
          for (const id of pendentesSnapshot) registradas.add(id);
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          emTx = false;
          pendentesSnapshot = new Set(registradas);
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
          const id = String(params?.[0]);
          if (emTx) pendentesSnapshot.add(id);
          else registradas.add(id);
          return { rows: [] };
        }
        if (
          sql === 'SELECT 1' ||
          sql.includes('pg_advisory_') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')
        ) {
          return { rows: [] };
        }
        if (sql.includes('FAIL_ON_PURPOSE')) {
          throw new Error('erro de sintaxe simulado em 0003_bad.sql');
        }
        executadasSql.push(sql);
        return { rows: [] };
      });

      // Cenário 6 + 7 + 8 em uma cadeia:
      // - 0001 já aplicada -> pulada;
      // - 0002 pendente -> aplicada em transação e registrada;
      // - 0003 falha -> ROLLBACK, não registrada, 0004 não roda, boot fica em fase='migrations'.
      const capFalha = criarLoggerMudo();
      await migrate({
        clientFactory: async () => client,
        bootstrapFn: async () => undefined,
        migrationsFn: async (c) => aplicarMigrationsVersionadas(c, { migrationsDir: tmpDir, logger: capFalha.logger }),
        logger: capFalha.logger,
      });

      assert.equal(executadasSql.some((s) => s.includes('t1')), false, 'migration já aplicada foi pulada');
      assert.equal(executadasSql.some((s) => s.includes('t2')), true, 'migration pendente 0002 executou');
      assert.equal(executadasSql.some((s) => s.includes('t4')), false, 'parou na primeira falha antes da 0004');
      assert.deepEqual([...registradas], ['0001_init.sql', '0002_add.sql']);
      assert.equal(dbBootState().stage, 'degraded');
      assert.equal(bootFailure()?.fase, 'migrations');
      assert.match(migrationError() || '', /0003_bad\.sql/);

      // Corrige 0003 e reexecuta migrate(): 0001 e 0002 seguem puladas, 0003 e 0004 aplicam e boot fica pronto.
      writeFileSync(path.join(tmpDir, '0003_bad.sql'), 'CREATE TABLE t3 (id INT);', 'utf8');
      executadasSql.length = 0;

      const capOk = criarLoggerMudo();
      await migrate({
        clientFactory: async () => client,
        bootstrapFn: async () => undefined,
        migrationsFn: async (c) => aplicarMigrationsVersionadas(c, { migrationsDir: tmpDir, logger: capOk.logger }),
        logger: capOk.logger,
      });

      assert.equal(executadasSql.some((s) => s.includes('t1')), false);
      assert.equal(executadasSql.some((s) => s.includes('t2')), false);
      assert.equal(executadasSql.some((s) => s.includes('t3')), true);
      assert.equal(executadasSql.some((s) => s.includes('t4')), true);
      assert.deepEqual([...registradas], ['0001_init.sql', '0002_add.sql', '0003_bad.sql', '0004_after.sql']);
      assert.equal(dbBootState().stage, 'ready');
      assert.equal(bootFailure(), null);

      // Reexecução idempotente com tudo já aplicado: nenhuma migration pendente roda.
      executadasSql.length = 0;
      await migrate({
        clientFactory: async () => client,
        bootstrapFn: async () => undefined,
        migrationsFn: async (c) => aplicarMigrationsVersionadas(c, { migrationsDir: tmpDir, logger: capOk.logger }),
        logger: capOk.logger,
      });
      assert.equal(executadasSql.length, 0);
      assert.equal(dbBootState().stage, 'ready');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('9 e 10) /api/health e bloqueio de rotas, workers e cron antes da prontidão obrigatória', async () => {
    // 9a: durante retries ativos (status === 'connecting'), /api/health já responde 503 com processo='iniciado',
    // banco='indisponivel', pronto=false (nunca 200), e rotas de negócio/cron respondem 503.
    const portaConectando = await portaLivre();
    const portaBancoMorto = await portaLivre();
    const srvConectando = iniciarApiFilha(portaConectando, {
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://nao_existe:nao_existe@127.0.0.1:${portaBancoMorto}/nao_existe`,
      PG_CONNECT_TIMEOUT: '200',
      PG_STARTUP_TIMEOUT_MS: '5000',
      PG_STARTUP_RETRY_BASE_MS: '400',
      PG_STARTUP_RETRY_MAX_MS: '800',
      PG_STARTUP_MAX_ATTEMPTS: '10',
    });

    try {
      const hConectando = await esperarHttp(`http://127.0.0.1:${portaConectando}/api/health`, (s) => s === 503);
      assert.equal(hConectando.status, 503);
      assert.equal(hConectando.body.ok, false);
      assert.equal(hConectando.body.status, 'connecting');
      assert.equal(hConectando.body.processo, 'iniciado');
      assert.equal(hConectando.body.banco, 'indisponivel');
      assert.equal(hConectando.body.pronto, false);
      assert.equal(hConectando.body.db, 'postgres-degraded');
      assert.equal(hConectando.body.fase, 'conexao');

      const rCron = await fetch(`http://127.0.0.1:${portaConectando}/api/admin/scheduled/cron/crm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SEGREDO_CRON_TESTE}` },
      });
      assert.equal(rCron.status, 503, 'rota de cron não executa sem prontidão do banco');

      const rNegocio = await fetch(`http://127.0.0.1:${portaConectando}/api/vendas`);
      assert.equal(rNegocio.status, 503, 'rota de negócio bloqueada com 503');
    } finally {
      srvConectando.child.kill('SIGTERM');
      await srvConectando.exitPromise;
    }

    // 9b: após esgotar startup em non-prod, /api/health transiciona para status='degraded' (503).
    const portaIndisp = await portaLivre();
    const srv = iniciarApiFilha(portaIndisp, {
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://nao_existe:nao_existe@127.0.0.1:${portaBancoMorto}/nao_existe`,
      PG_CONNECT_TIMEOUT: '150',
      PG_STARTUP_TIMEOUT_MS: '300',
      PG_STARTUP_RETRY_BASE_MS: '50',
      PG_STARTUP_RETRY_MAX_MS: '100',
      PG_STARTUP_MAX_ATTEMPTS: '2',
    });

    try {
      const hDegradado = await esperarHttp(
        `http://127.0.0.1:${portaIndisp}/api/health`,
        (s, b) => s === 503 && b?.status === 'degraded'
      );
      assert.equal(hDegradado.status, 503);
      assert.equal(hDegradado.body.ok, false);
      assert.equal(hDegradado.body.processo, 'iniciado');
      assert.equal(hDegradado.body.banco, 'indisponivel');
      assert.equal(hDegradado.body.pronto, false);
      assert.equal(hDegradado.body.db, 'postgres-degraded');
      assert.equal(hDegradado.body.fase, 'conexao');
    } finally {
      srv.child.kill('SIGTERM');
      await srv.exitPromise;
    }

    // 10a: ordem estática de inicialização em index.ts garante workers/intervals só após appReady = true.
    const indexFonte = readFileSync(path.join(SERVER_DIR, 'src/index.ts'), 'utf8');
    const posMigrate = indexFonte.indexOf('await migrate()');
    const posAppReady = indexFonte.indexOf('appReady = true;');
    const posInitNegocios = indexFonte.indexOf('initNegociosEngine();');
    const posFilaCommerce = indexFonte.indexOf('const filaCommerce = setInterval(');
    const posLimpeza = indexFonte.indexOf('const limpeza = setInterval(');
    assert.ok(posMigrate > 0 && posAppReady > posMigrate, 'appReady só após migrate()');
    assert.ok(posInitNegocios > posAppReady, 'initNegociosEngine() só inicia após appReady');
    assert.ok(posFilaCommerce > posAppReady, 'filaCommerce só inicia após appReady');
    assert.ok(posLimpeza > posAppReady, 'limpeza periódica só inicia após appReady');

    // 9b: modo memória (sem DATABASE_URL): pronto=true + 200 após inicialização.
    const portaMem = await portaLivre();
    const mem = iniciarApiFilha(portaMem, {
      NODE_ENV: 'test',
      DATABASE_URL: '',
    });
    try {
      const hMem = await esperarHttp(`http://127.0.0.1:${portaMem}/api/health`, (s, b) => s === 200 && b?.pronto === true);
      assert.equal(hMem.status, 200);
      assert.equal(hMem.body.ok, true);
      assert.equal(hMem.body.processo, 'iniciado');
      assert.equal(hMem.body.banco, 'memoria');
      assert.equal(hMem.body.pronto, true);
      assert.equal(hMem.body.db, 'memory');
    } finally {
      mem.child.kill('SIGTERM');
      await mem.exitPromise;
    }

    // 10b: Prova direta em processo isolado com DATABASE_URL configurada (sem migrate()):
    // executarProcessoCron, processarComercioAgendado e atualizarMotorNegocios recusam execução!
    const scriptGate = `
      const { executarProcessoCron, processosCron } = await import('./src/scheduled.ts');
      const { processarComercioAgendado } = await import('./src/commerce/outbox.ts');
      const { atualizarMotorNegocios } = await import('./src/negocios.ts');
      const { isDbConnected, isDbDegraded } = await import('./src/db.ts');
      let cronExecutou = false;
      processosCron.crm = async () => { cronExecutou = true; return { itens: 1, detalhes: [], falhas: [] }; };
      const cronRes = await executarProcessoCron('crm');
      const outboxRes = await processarComercioAgendado();
      const motorRes = await atualizarMotorNegocios();
      console.log('__GATE__' + JSON.stringify({
        connected: isDbConnected(),
        degraded: isDbDegraded(),
        cronExecutou,
        cronStatus: cronRes.status,
        cronOk: cronRes.ok,
        outboxFalhas: outboxRes.falhas,
        motorRes,
      }));
    `;
    const gateOut = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', scriptGate], {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://nao_existe:nao_existe@127.0.0.1:1/nao_existe',
          PG_IDLE_TIMEOUT: '200',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => { stdout += String(d); });
      p.stderr.on('data', (d) => { stderr += String(d); });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    assert.equal(gateOut.code, 0, gateOut.stderr);
    const linhaGate = gateOut.stdout.split('\n').find((l) => l.startsWith('__GATE__'));
    assert.ok(linhaGate, `saída esperada não encontrada: ${gateOut.stdout}`);
    const gate = JSON.parse(linhaGate.slice('__GATE__'.length));
    assert.equal(gate.connected, false);
    assert.equal(gate.degraded, true);
    assert.equal(gate.cronExecutou, false, 'executor do cron não pode rodar antes da prontidão');
    assert.equal(gate.cronStatus, 503);
    assert.equal(gate.cronOk, false);
    assert.deepEqual(gate.outboxFalhas, ['banco_indisponivel']);
    assert.deepEqual(gate.motorRes, { margens: 0, abc: 0 });
  });

  test('Configuração de startup via ambiente segue limites coerentes', () => {
    const anterior = {
      PG_CONNECT_TIMEOUT: process.env.PG_CONNECT_TIMEOUT,
      PG_STARTUP_TIMEOUT_MS: process.env.PG_STARTUP_TIMEOUT_MS,
      PG_STARTUP_RETRY_BASE_MS: process.env.PG_STARTUP_RETRY_BASE_MS,
      PG_STARTUP_RETRY_MAX_MS: process.env.PG_STARTUP_RETRY_MAX_MS,
      PG_STARTUP_MAX_ATTEMPTS: process.env.PG_STARTUP_MAX_ATTEMPTS,
    };
    try {
      delete process.env.PG_CONNECT_TIMEOUT;
      delete process.env.PG_STARTUP_TIMEOUT_MS;
      delete process.env.PG_STARTUP_RETRY_BASE_MS;
      delete process.env.PG_STARTUP_RETRY_MAX_MS;
      delete process.env.PG_STARTUP_MAX_ATTEMPTS;

      const padrao = lerConfigBootBanco();
      assert.deepEqual(padrao, {
        connectTimeoutMs: 10_000,
        startupTimeoutMs: 60_000,
        retryBaseMs: 500,
        retryMaxMs: 8_000,
        maxAttempts: 20,
      });

      process.env.PG_CONNECT_TIMEOUT = '2500';
      process.env.PG_STARTUP_TIMEOUT_MS = '25000';
      process.env.PG_STARTUP_RETRY_BASE_MS = '250';
      process.env.PG_STARTUP_RETRY_MAX_MS = '4000';
      process.env.PG_STARTUP_MAX_ATTEMPTS = '12';
      assert.deepEqual(lerConfigBootBanco(), {
        connectTimeoutMs: 2500,
        startupTimeoutMs: 25_000,
        retryBaseMs: 250,
        retryMaxMs: 4000,
        maxAttempts: 12,
      });
    } finally {
      for (const [k, v] of Object.entries(anterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
