// ============================================================================
// PROD-DB-01.1 — prontidão de produção (PostgreSQL REAL + HTTP real).
//
// Prova, de ponta a ponta (processo real, porta real, JWT/sessão real):
//
//   A. Banco pronto: /api/health 200 com db=postgres e /api/vendas funciona.
//   B. Bootstrap incompleto (dado legado que o preflight da E4.2 recusa):
//      /api/health 503, GET/POST /api/vendas 503 — NÃO atende negócio.
//   C. DATABASE_URL definido mas PostgreSQL indisponível: /api/health 503 e
//      /api/vendas 503 — nunca aceitar escrita em memória como persistência.
//   D. Recuperação: corrigida a pré-condição e reiniciado, volta ao estado
//      pronto e /api/vendas responde de novo.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/prod-db-01-readiness.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
const { migrate, query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const evidence: string[] = [];

async function reservarPorta(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('sem porta TCP');
  const port = addr.port;
  await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
  return port;
}

function appendLog(cur: string, chunk: string | Buffer): string {
  return `${cur}${String(chunk)}`.slice(-40_000);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const to = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(to); resolve(); });
    child.kill('SIGTERM');
  });
}

async function startServer(port: number, env: NodeJS.ProcessEnv): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), JWT_SECRET: randomUUID(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c: string | Buffer) => { output = appendLog(output, c); });
  child.stderr.on('data', (c: string | Buffer) => { output = appendLog(output, c); });
  const baseUrl = `http://127.0.0.1:${port}`;
  // Espera a porta abrir (o servidor escuta ANTES de migrar, por desenho).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`servidor encerrou no boot:\n${output}`);
    try {
      await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      return { child, baseUrl, logs: () => output };
    } catch {
      await delay(200);
    }
  }
  throw new Error(`porta não abriu em 60s:\n${output}`);
}

async function health(baseUrl: string) {
  const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
  let body: any = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

async function http(baseUrl: string, method: string, route: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(`${baseUrl}/api${route}`, init);
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: r.status, body: parsed, text };
}

async function esperarHealth(baseUrl: string, pred: (h: { status: number; body: any }) => boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: number; body: any } = { status: 0, body: null };
  while (Date.now() < deadline) {
    try { last = await health(baseUrl); if (pred(last)) return last; } catch { /* ignore */ }
    await delay(300);
  }
  return last;
}

test('PROD-DB-01.1 — prontidão: pronto, bootstrap incompleto, banco indisponível e recuperação', async (t) => {
  const suffix = randomUUID().slice(0, 8);
  await migrate(); // banco de teste pronto

  const email = `proddb011-${suffix}@example.test`;
  const senha = `PRODDB011-${randomUUID()}!`;
  const emp = await query(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`, [`PRODDB011 ${suffix}`, `PRODDB011 ${suffix}`]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now()) RETURNING id`,
    [`PRODDB011 ${suffix}`, email, await hashPassword(senha), empresaId]
  );
  const usuarioId = Number(usr.rows[0].id);
  t.after(async () => {
    await query(`DELETE FROM usuarios WHERE id = $1`, [usuarioId]).catch(() => undefined);
    await query(`DELETE FROM empresas WHERE id = $1`, [empresaId]).catch(() => undefined);
  });

  // ---------------------------------------------------------------------
  // A. Banco pronto.
  // ---------------------------------------------------------------------
  const portaA = await reservarPorta();
  const a = await startServer(portaA, {});
  t.after(async () => stopServer(a.child));
  const hA = await esperarHealth(a.baseUrl, (h) => h.status === 200 && h.body?.db === 'postgres');
  assert.equal(hA.status, 200, `A: health deveria ser 200; veio ${hA.status}`);
  assert.equal(hA.body.db, 'postgres');
  const loginA = await http(a.baseUrl, 'POST', '/auth/login', undefined, { email, password: senha });
  assert.equal(loginA.status, 200, `A: login deveria ser 200; veio ${loginA.status} ${loginA.text.slice(0, 200)}`);
  const tokenA = String(loginA.body?.token || '');
  const vendasA = await http(a.baseUrl, 'GET', '/vendas', tokenA);
  assert.equal(vendasA.status, 200, `A: GET /api/vendas deveria ser 200; veio ${vendasA.status}`);
  evidence.push(`A pronto: health ${hA.status} db=${hA.body.db}; GET /api/vendas ${vendasA.status}`);
  await stopServer(a.child);

  // ---------------------------------------------------------------------
  // B. Bootstrap incompleto: dado legado que o preflight da E4.2 recusa.
  // ---------------------------------------------------------------------
  const nomeLocal = `Loja ${suffix}`;
  await query(`DROP INDEX IF EXISTS uq_e42_locais_empresa_nome`);
  await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, nomeLocal]);
  await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, nomeLocal]);
  const limparLegado = async () => {
    await query(`DELETE FROM locais WHERE empresa_id = $1 AND nome = $2`, [empresaId, nomeLocal]).catch(() => undefined);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_nome ON locais (empresa_id, nome)`).catch(() => undefined);
  };
  t.after(limparLegado);

  const portaB = await reservarPorta();
  const b = await startServer(portaB, {});
  t.after(async () => stopServer(b.child));
  const hB = await esperarHealth(b.baseUrl, (h) => h.status === 503);
  assert.equal(hB.status, 503, `B: health deveria ser 503 (degradado); veio ${hB.status} ${JSON.stringify(hB.body)}`);
  assert.equal(hB.body.db, 'memory', 'B: db deve refletir o estado não-pronto');
  const loginB = await http(b.baseUrl, 'POST', '/auth/login', undefined, { email, password: senha });
  const tokenB = String(loginB.body?.token || '');
  const getB = await http(b.baseUrl, 'GET', '/vendas', tokenB);
  assert.equal(getB.status, 503, `B: GET /api/vendas deveria ser 503; veio ${getB.status} ${getB.text.slice(0, 200)}`);
  const postB = await http(b.baseUrl, 'POST', '/vendas', tokenB, { cliente_id: 1, data: '2026-01-01' });
  assert.equal(postB.status, 503, `B: POST /api/vendas deveria ser 503 (sem escrita em memória); veio ${postB.status}`);
  evidence.push(`B bootstrap incompleto: health ${hB.status} db=${hB.body.db}; GET /api/vendas ${getB.status}; POST /api/vendas ${postB.status}`);
  await stopServer(b.child);

  // ---------------------------------------------------------------------
  // C. DATABASE_URL definido, PostgreSQL indisponível.
  // ---------------------------------------------------------------------
  const portaC = await reservarPorta();
  const urlMorta = 'postgresql://nao_existe:nao_existe@127.0.0.1:1/nao_existe';
  const c = await startServer(portaC, { DATABASE_URL: urlMorta, PG_CONNECT_TIMEOUT: '1000' });
  t.after(async () => stopServer(c.child));
  const hC = await esperarHealth(c.baseUrl, (h) => h.status === 503);
  assert.equal(hC.status, 503, `C: health deveria ser 503 (banco indisponível); veio ${hC.status} ${JSON.stringify(hC.body)}`);
  const getC = await http(c.baseUrl, 'GET', '/vendas');
  assert.equal(getC.status, 503, `C: GET /api/vendas deveria ser 503; veio ${getC.status}`);
  const postC = await http(c.baseUrl, 'POST', '/vendas', undefined, { cliente_id: 1, data: '2026-01-01' });
  assert.equal(postC.status, 503, `C: POST /api/vendas deveria ser 503 (nunca memória); veio ${postC.status}`);
  evidence.push(`C banco indisponível: health ${hC.status}; GET /api/vendas ${getC.status}; POST /api/vendas ${postC.status}`);
  await stopServer(c.child);

  // ---------------------------------------------------------------------
  // D. Recuperação: corrigida a pré-condição e reiniciado, volta a pronto.
  // ---------------------------------------------------------------------
  await limparLegado();
  const portaD = await reservarPorta();
  const d = await startServer(portaD, {});
  t.after(async () => stopServer(d.child));
  const hD = await esperarHealth(d.baseUrl, (h) => h.status === 200 && h.body?.db === 'postgres');
  assert.equal(hD.status, 200, `D: após corrigir a causa, health deveria ser 200; veio ${hD.status}`);
  assert.equal(hD.body.db, 'postgres');
  const loginD = await http(d.baseUrl, 'POST', '/auth/login', undefined, { email, password: senha });
  const tokenD = String(loginD.body?.token || '');
  const vendasD = await http(d.baseUrl, 'GET', '/vendas', tokenD);
  assert.equal(vendasD.status, 200, `D: GET /api/vendas deveria voltar a 200; veio ${vendasD.status}`);
  evidence.push(`D recuperação: health ${hD.status} db=${hD.body.db}; GET /api/vendas ${vendasD.status}`);
  await stopServer(d.child);

  console.log('\n=== PROD-DB-01.1 (readiness HTTP) evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});
