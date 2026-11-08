// ============================================================================
// PROD-DB-03 — Resiliência de conexão e startup contra PostgreSQL 16.14 REAL.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// Nenhum mock de banco: usa bancos descartáveis reais no PostgreSQL 16.14,
// proxy TCP real simulando indisponibilidade transitória de boot e processos
// reais da API (server/src/index.ts).
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from 'pg';
import {
  SERVER_DIR,
  conectar,
  criarBancoDescartavel,
  destruirBancoDescartavel,
  migrationsRegistradas,
  rodarBoot,
} from './_boot-harness';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-03-startup-resilience.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
  );
}

const SEGREDO_JWT_TESTE = 'jwt-segredo-forte-pg-resiliencia-1234567890abcdef';
const SENHA_ADMIN_TESTE = 'Senha!Forte#2026PgResil';
const SEGREDO_CRON_TESTE = 'cron-segredo-pg-resiliencia-123456';

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

async function criarProxyTcp(
  hostAlvo: string,
  portaAlvo: number,
  falhasIniciais: number
): Promise<{ porta: number; conexoes: () => number; fechar: () => Promise<void> }> {
  let tentativas = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((clientSocket) => {
    tentativas += 1;
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));

    if (tentativas <= falhasIniciais) {
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect({ host: hostAlvo, port: portaAlvo });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);

    const encerrarPar = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    clientSocket.on('error', encerrarPar);
    upstream.on('error', encerrarPar);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as net.AddressInfo;

  return {
    porta: addr.port,
    conexoes: () => tentativas,
    fechar: async () => {
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function iniciarApi(
  porta: number,
  extraEnv: NodeJS.ProcessEnv
): { child: ChildProcess; saida: () => string; exitPromise: Promise<number>; parar: () => Promise<void> } {
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
  let buf = '';
  child.stdout.on('data', (d) => { buf += String(d); });
  child.stderr.on('data', (d) => { buf += String(d); });
  const exitPromise = new Promise<number>((resolve) => {
    child.once('close', (code) => resolve(code ?? -1));
  });
  const parar = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    await exitPromise;
  };
  return { child, saida: () => buf, exitPromise, parar };
}

async function esperarHealth(
  baseUrl: string,
  predicado: (status: number, body: any) => boolean,
  timeoutMs = 45_000
): Promise<{ status: number; body: any; historico: Array<{ status: number; body: any }> }> {
  const historico: Array<{ status: number; body: any }> = [];
  const fim = Date.now() + timeoutMs;
  while (Date.now() < fim) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      const body = await r.json().catch(() => null);
      historico.push({ status: r.status, body });
      if (predicado(r.status, body)) return { status: r.status, body, historico };
    } catch {
      // porta ainda subindo
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timeout aguardando /api/health em ${baseUrl} (historico=${JSON.stringify(historico.slice(-5))})`);
}

describe('PROD-DB-03 — resiliência real com PostgreSQL 16.14', () => {
  test('A) PostgreSQL disponível na 1a tentativa + /api/health + cron liberado só após prontidão', { timeout: 90_000 }, async (t) => {
    const banco = await criarBancoDescartavel('resil_a');
    const porta = await portaLivre();
    const api = iniciarApi(porta, {
      NODE_ENV: 'production',
      DATABASE_URL: banco.url,
    });
    t.after(async () => {
      await api.parar();
      await destruirBancoDescartavel(banco);
    });

    const baseUrl = `http://127.0.0.1:${porta}`;
    const res = await esperarHealth(baseUrl, (s, b) => s === 200 && b?.pronto === true, 60_000);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.processo, 'iniciado');
    assert.equal(res.body.banco, 'conectado');
    assert.equal(res.body.pronto, true);
    assert.equal(res.body.db, 'postgres');

    for (const h of res.historico) {
      if (!h.body?.pronto) {
        assert.equal(h.status, 503, 'enquanto pronto=false, /api/health nunca pode responder 200');
      }
    }

    const cronRes = await fetch(`${baseUrl}/api/admin/scheduled/cron/crm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SEGREDO_CRON_TESTE}` },
    });
    assert.equal(cronRes.status, 200, 'cron responde 200 depois que aplicação e banco estão prontos');
  });

  test('B) Indisponibilidade transitória na 1a e 2a tentativas recupera sem exit 1 e aplica todas as migrations', { timeout: 90_000 }, async (t) => {
    const banco = await criarBancoDescartavel('resil_b');
    const u = new URL(banco.url);
    const targetPort = Number(u.port || 5432);
    const proxy = await criarProxyTcp(u.hostname, targetPort, 2);

    const proxyUrl = new URL(banco.url);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(proxy.porta);

    const portaApi = await portaLivre();
    const api = iniciarApi(portaApi, {
      NODE_ENV: 'production',
      DATABASE_URL: proxyUrl.toString(),
      PG_CONNECT_TIMEOUT: '2000',
      PG_STARTUP_TIMEOUT_MS: '30000',
      PG_STARTUP_RETRY_BASE_MS: '150',
      PG_STARTUP_RETRY_MAX_MS: '600',
      PG_STARTUP_MAX_ATTEMPTS: '10',
    });
    t.after(async () => {
      await api.parar();
      await proxy.fechar();
      await destruirBancoDescartavel(banco);
    });

    const baseUrl = `http://127.0.0.1:${portaApi}`;
    // Primeiro confirma que ainda durante o boot/retry o /api/health já responde 503 (e nunca 200).
    const hReady = await esperarHealth(baseUrl, (s, b) => s === 200 && b?.pronto === true, 60_000);
    assert.equal(hReady.status, 200);
    assert.equal(hReady.body.db, 'postgres');
    assert.equal(api.child.exitCode, null, 'recuperação transitória em produção não encerra processo');
    assert.ok(proxy.conexoes() >= 3, `proxy deve registrar ao menos 3 tentativas (2 falhas + 1 sucesso), houve ${proxy.conexoes()}`);

    const log = api.saida();
    assert.match(log, /indisponível na tentativa 1/);
    assert.match(log, /recuperada na tentativa/);

    const c = await conectar(banco);
    try {
      const aplicadas = await migrationsRegistradas(c);
      assert.ok(aplicadas.length >= 109, `esperava todas as migrations registradas, obteve ${aplicadas.length}`);
    } finally {
      await c.end();
    }
  });

  test('C) Erro permanente real (3D000 banco inexistente): falha rápida sem loop e reporta fase=conexao', { timeout: 30_000 }, async () => {
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = `/inexistente_${Date.now().toString(36)}`;
    const portaApi = await portaLivre();
    const t0 = Date.now();
    const api = iniciarApi(portaApi, {
      NODE_ENV: 'production',
      DATABASE_URL: u.toString(),
      PG_STARTUP_TIMEOUT_MS: '30000',
      PG_STARTUP_RETRY_BASE_MS: '200',
    });
    const code = await api.exitPromise;
    const duracao = Date.now() - t0;
    const log = api.saida();

    assert.equal(code, 1);
    assert.ok(duracao < 10_000, `erro permanente 3D000 deve falhar rápido sem aguardar startup timeout (${duracao}ms)`);
    assert.match(log, /fase=conexao/);
    assert.match(log, /tipo=permanente/);
    assert.match(log, /3D000|does not exist/i);
    assert.equal(log.includes('fase=desconhecida'), false);
    assert.equal(log.includes('(null)'), false);
  });

  test('D) Timeout de startup: encerra em produção após janela configurada e bloqueia cron em non-prod', { timeout: 30_000 }, async (t) => {
    const portaMorta = await portaLivre();
    const deadUrl = `postgresql://brobond:brobond@127.0.0.1:${portaMorta}/brobond_teste`;

    // 1. Produção: encerra com exit 1 após PG_STARTUP_TIMEOUT_MS (sem loop infinito)
    const portaProd = await portaLivre();
    const prod = iniciarApi(portaProd, {
      NODE_ENV: 'production',
      DATABASE_URL: deadUrl,
      PG_CONNECT_TIMEOUT: '200',
      PG_STARTUP_TIMEOUT_MS: '600',
      PG_STARTUP_RETRY_BASE_MS: '80',
      PG_STARTUP_RETRY_MAX_MS: '160',
      PG_STARTUP_MAX_ATTEMPTS: '10',
    });
    const codeProd = await prod.exitPromise;
    const logProd = prod.saida();
    assert.equal(codeProd, 1);
    assert.match(logProd, /fase=conexao/);
    assert.match(logProd, /tipo=timeout/);
    assert.equal(logProd.includes('fase=desconhecida'), false);

    // 2. Non-prod: permanece degradada (503) com banco indisponível e cron bloqueado (503)
    const portaTest = await portaLivre();
    const tst = iniciarApi(portaTest, {
      NODE_ENV: 'test',
      DATABASE_URL: deadUrl,
      PG_CONNECT_TIMEOUT: '200',
      PG_STARTUP_TIMEOUT_MS: '500',
      PG_STARTUP_RETRY_BASE_MS: '80',
      PG_STARTUP_RETRY_MAX_MS: '150',
      PG_STARTUP_MAX_ATTEMPTS: '5',
    });
    t.after(() => tst.parar());

    const baseUrl = `http://127.0.0.1:${portaTest}`;
    const h = await esperarHealth(
      baseUrl,
      (s, b) => s === 503 && b?.status === 'degraded' && b?.fase === 'conexao',
      15_000
    );
    assert.equal(h.status, 503);
    assert.equal(h.body.banco, 'indisponivel');
    assert.equal(h.body.pronto, false);

    const cronRes = await fetch(`${baseUrl}/api/admin/scheduled/cron/crm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SEGREDO_CRON_TESTE}` },
    });
    assert.equal(cronRes.status, 503);
  });

  test('E) Idempotência de migrations já aplicadas, pendência, falha com rollback e bloqueio de workers', { timeout: 90_000 }, async (t) => {
    const banco = await criarBancoDescartavel('resil_e');
    t.after(() => destruirBancoDescartavel(banco));

    // 1. Primeiro boot aplica todas as migrations pendentes.
    const r1 = await rodarBoot(banco);
    assert.equal(r1.code, 0);
    assert.equal(r1.estado?.status, 'ready');
    assert.equal(r1.estado?.falha, null);

    // 2. Segundo boot no banco já migrado é idempotente: nenhuma migration reaplicada.
    const r2 = await rodarBoot(banco);
    assert.equal(r2.code, 0);
    assert.equal(r2.estado?.status, 'ready');
    assert.equal(r2.stdout.includes('Migração aplicada:'), false, 'migrations já aplicadas não são reexecutadas');

    // 3. Migration pendente aplicada sequencialmente + migration com erro sofre ROLLBACK sem registro.
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brobond-pg-mig-'));
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    writeFileSync(path.join(tmpDir, '9001_ok.sql'), 'CREATE TABLE IF NOT EXISTS _tmp_resil_ok (id INT PRIMARY KEY);', 'utf8');
    writeFileSync(path.join(tmpDir, '9002_fail.sql'), 'CREATE TABLE _tmp_resil_fail (id INT); SELECT 1 / 0;', 'utf8');

    const { aplicarMigrationsVersionadas } = await import('../../src/db');
    const c = new Client({ connectionString: banco.url });
    await c.connect();
    try {
      await assert.rejects(
        () => aplicarMigrationsVersionadas(c, { migrationsDir: tmpDir }),
        /9002_fail\.sql/
      );

      const { rows: okRows } = await c.query(`SELECT to_regclass('public._tmp_resil_ok') AS t`);
      const { rows: failRows } = await c.query(`SELECT to_regclass('public._tmp_resil_fail') AS t`);
      assert.notEqual(okRows[0].t, null, '9001_ok foi comitada antes da falha');
      assert.equal(failRows[0].t, null, '9002_fail sofreu rollback total');

      const reg = await migrationsRegistradas(c);
      assert.equal(reg.includes('9001_ok.sql'), true);
      assert.equal(reg.includes('9002_fail.sql'), false);
    } finally {
      await c.end();
    }
  });
});
