// ============================================================================
// PROD-DB-01.3 — AUDITORIA DO TOKEN DE EMERGÊNCIA (PostgreSQL REAL + HTTP real).
//
// A revisão independente apontou que o token de emergência (id 0, perfil
// 'admin', emitido só quando o banco está indisponível) atravessa caminhos de
// autenticação que normalmente revalidam o usuário no banco. Como o requireAuth
// PULA toda revalidação para id <= 0 (sem sid, sem token_versao, sem linha em
// `usuarios`, sem MFA), um token emitido durante a queda continua sendo aceito
// como ADMIN depois que o banco volta — e não há como revogá-lo.
//
// Esta prova sobe o servidor REAL (processo, porta, JWT e PostgreSQL reais) e
// demonstra:
//
//   A) DEGRADADO — login de emergência 200 (id 0); capacidades estritamente de
//      diagnóstico/leitura; rotas de escrita/administrativas NEGADAS; negócio
//      bloqueado pela prontidão.
//   B) RECUPERAÇÃO — o MESMO token emitido na queda (mesmo JWT_SECRET, dois
//      processos) NÃO pode voltar a valer como admin depois que o banco volta.
//   C) REGRESSÃO — login normal (com sessão) continua funcionando.
//   D) loginFailed seguro — senha errada com banco OK responde 401 controlado.
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
  throw new Error('pg/prod-db-013-emergency-token.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
const { migrate, query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@brobond.com.br').trim().toLowerCase();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'brobond123').trim();

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
  const append = (c: string | Buffer) => { output = `${output}${String(c)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
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

/** Handshake WebSocket (Socket.IO) com o token no query — devolve se conectou. */
async function wsHandshake(baseUrl: string, token: string): Promise<{ connected: boolean; detail: string }> {
  const { default: WebSocket } = await import('ws');
  const url = `${baseUrl.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket&token=${encodeURIComponent(token)}`;
  return await new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (r: { connected: boolean; detail: string }) => { if (!settled) { settled = true; try { ws.close(); } catch { /* ignore */ } resolve(r); } };
    ws.on('message', (data: any) => {
      const s = String(data);
      if (s.startsWith('0')) { try { ws.send('40'); } catch { /* ignore */ } }
      else if (s.startsWith('40')) done({ connected: true, detail: s.slice(0, 80) });
      else if (s.startsWith('44')) done({ connected: false, detail: s.slice(0, 120) });
    });
    ws.on('error', (e: any) => done({ connected: false, detail: String(e?.message || e) }));
    setTimeout(() => done({ connected: false, detail: 'timeout' }), 8_000);
  });
}

// Rotas administrativas/escrita que o token de emergência NUNCA deve alcançar.
const ROTAS_NEGADAS_EMERGENCIA: Array<[string, string, unknown]> = [
  ['GET', '/admin/notificacoes/status', undefined],
  ['GET', '/admin/auditoria/verificar', undefined],
  ['GET', '/usuarios/resumo', undefined],
  ['POST', '/usuarios/1/desativar', { motivo: 'tentativa de emergência' }],
  ['GET', '/vendas', undefined],
  ['POST', '/vendas', { cliente_id: 1, data: '2026-01-01' }],
  ['GET', '/financeiro/resumo', undefined],
  ['GET', '/meta', undefined],
  ['GET', '/dashboard', undefined],
  ['GET', '/auth/sessoes', undefined],
  ['GET', '/auth/preferences', undefined],
  ['PUT', '/auth/preferences', { preferencias: { x: 1 } }],
  ['POST', '/auth/change-password', { senha_atual: 'a', senha_nova: 'b' }],
  ['POST', '/auth/mfa/setup', {}],
];

test('PROD-DB-01.3 — token de emergência limitado a diagnóstico (HTTP real + PostgreSQL)', async (t) => {
  const suffix = randomUUID().slice(0, 8);
  await migrate(); // banco de teste pronto

  const email = `proddb013-${suffix}@example.test`;
  const senha = `PRODDB013-${randomUUID()}!`;
  const emp = await query(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`, [`PRODDB013 ${suffix}`, `PRODDB013 ${suffix}`]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now()) RETURNING id`,
    [`PRODDB013 ${suffix}`, email, await hashPassword(senha), empresaId]
  );
  const usuarioId = Number(usr.rows[0].id);
  t.after(async () => {
    await query(`DELETE FROM usuarios WHERE id = $1`, [usuarioId]).catch(() => undefined);
    await query(`DELETE FROM empresas WHERE id = $1`, [empresaId]).catch(() => undefined);
  });

  // ---------------------------------------------------------------------
  // A. DEGRADADO: DATABASE_URL presente, PostgreSQL indisponível.
  //    O login de emergência emite um token (id 0). Provamos as capacidades.
  // ---------------------------------------------------------------------
  const segredoCompartilhado = randomUUID();
  const portaA = await reservarPorta();
  const a = await startServer(portaA, {
    DATABASE_URL: 'postgresql://nao_existe:nao_existe@127.0.0.1:1/nao_existe',
    PG_CONNECT_TIMEOUT: '1000',
    JWT_SECRET: segredoCompartilhado,
  });
  t.after(async () => stopServer(a.child));
  const hA = await esperarHealth(a.baseUrl, (h) => h.status === 503);
  assert.equal(hA.status, 503, `A: health deveria ser 503; veio ${hA.status}`);
  assert.equal(hA.body.db, 'postgres-degraded');

  const loginEmergencia = await http(a.baseUrl, 'POST', '/auth/login', undefined, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(loginEmergencia.status, 200, `A: emergência deveria logar; veio ${loginEmergencia.status} ${loginEmergencia.text.slice(0, 200)}`);
  assert.equal(Number(loginEmergencia.body?.user?.id), 0, 'A: emergência usa id 0');
  const tokenEmergencia = String(loginEmergencia.body?.token || '');
  assert.ok(tokenEmergencia.length > 20, 'A: emergência emite JWT');
  evidence.push(`A degradado: health ${hA.status} db=${hA.body.db}; login emergência ${loginEmergencia.status} (id=0)`);

  // Leitura de diagnóstico permitida: /auth/me devolve o ator.
  const meA = await http(a.baseUrl, 'GET', '/auth/me', tokenEmergencia);
  assert.equal(meA.status, 200, `A: /auth/me de diagnóstico deveria ser 200; veio ${meA.status}`);
  assert.equal(Number(meA.body?.user?.id), 0);

  // O conjunto ALCANÇÁVEL é exatamente a allowlist: nada além de /auth/me,
  // /auth/politica-senha e /auth/logout. Isto trava a expansão acidental de
  // privilégio caso alguém adicione rotas sem revisar o guard de emergência.
  for (const [metodo, rota, corpo] of [
    ['GET', '/auth/politica-senha', undefined],
    ['POST', '/auth/logout', {}],
  ] as Array<[string, string, unknown]>) {
    const r = await http(a.baseUrl, metodo, rota, tokenEmergencia, corpo);
    assert.equal(r.status, 200, `A: ${metodo} ${rota} (diagnóstico) deveria ser 200; veio ${r.status} ${r.text.slice(0, 160)}`);
  }

  // Todas as demais rotas (escrita, admin, negócio, sessões, MFA, preferências)
  // devem ser NEGADAS — nunca 200, nunca 500 não controlado.
  for (const [metodo, rota, corpo] of ROTAS_NEGADAS_EMERGENCIA) {
    const r = await http(a.baseUrl, metodo, rota, tokenEmergencia, corpo);
    assert.notEqual(r.status, 200, `A: ${metodo} ${rota} NÃO pode ser 200 com token de emergência (${r.text.slice(0, 160)})`);
    assert.ok(r.status === 403 || r.status === 503, `A: ${metodo} ${rota} deveria ser 403/503; veio ${r.status} (${r.text.slice(0, 160)})`);
    evidence.push(`A degradado: ${metodo} ${rota} → ${r.status}`);
  }
  // WebSocket: o token de emergência pode abrir o canal (diagnóstico), mas não
  // entra nas salas globais — coberto pelo fix em websocket.ts.
  const wsA = await wsHandshake(a.baseUrl, tokenEmergencia);
  evidence.push(`A degradado: WebSocket handshake emergência → ${wsA.connected ? 'conectado' : `recusado (${wsA.detail})`}`);
  await stopServer(a.child);

  // ---------------------------------------------------------------------
  // B. RECUPERAÇÃO: banco pronto (mesmo JWT_SECRET). O token emitido na queda
  //    NÃO pode voltar a valer — nem como admin, nem para negócio.
  // ---------------------------------------------------------------------
  const portaB = await reservarPorta();
  const b = await startServer(portaB, { JWT_SECRET: segredoCompartilhado });
  t.after(async () => stopServer(b.child));
  const hB = await esperarHealth(b.baseUrl, (h) => h.status === 200 && h.body?.db === 'postgres');
  assert.equal(hB.status, 200, `B: banco recuperado deveria ser 200; veio ${hB.status}`);
  evidence.push(`B recuperado: health ${hB.status} db=${hB.body.db}`);

  const meB = await http(b.baseUrl, 'GET', '/auth/me', tokenEmergencia);
  assert.equal(meB.status, 401, `B: token de emergência NÃO pode valer após a recuperação; /auth/me veio ${meB.status} ${meB.text.slice(0, 160)}`);
  const adminB = await http(b.baseUrl, 'GET', '/admin/notificacoes/status', tokenEmergencia);
  assert.equal(adminB.status, 401, `B: token de emergência NÃO pode alcançar /admin/* após a recuperação; veio ${adminB.status}`);
  const desativarB = await http(b.baseUrl, 'POST', `/usuarios/${usuarioId}/desativar`, tokenEmergencia, { motivo: 'x' });
  assert.equal(desativarB.status, 401, `B: token de emergência NÃO pode desativar usuário após a recuperação; veio ${desativarB.status}`);
  const vendasB = await http(b.baseUrl, 'GET', '/vendas', tokenEmergencia);
  assert.equal(vendasB.status, 401, `B: token de emergência NÃO pode ver negócio após a recuperação; veio ${vendasB.status}`);
  const wsB = await wsHandshake(b.baseUrl, tokenEmergencia);
  assert.equal(wsB.connected, false, `B: WebSocket NÃO pode aceitar o token de emergência após a recuperação (${wsB.detail})`);
  evidence.push(`B recuperado: token da queda → /auth/me ${meB.status}; /admin/notificacoes/status ${adminB.status}; /usuarios/:id/desativar ${desativarB.status}; /vendas ${vendasB.status}; WebSocket ${wsB.connected ? 'aceito' : 'recusado'}`);

  // ---------------------------------------------------------------------
  // C. REGRESSÃO: login normal (sessão real) continua funcionando.
  // ---------------------------------------------------------------------
  const loginNormal = await http(b.baseUrl, 'POST', '/auth/login', undefined, { email, password: senha });
  assert.equal(loginNormal.status, 200, `C: login normal deveria ser 200; veio ${loginNormal.status}`);
  const tokenNormal = String(loginNormal.body?.token || '');
  const vendasNormal = await http(b.baseUrl, 'GET', '/vendas', tokenNormal);
  assert.equal(vendasNormal.status, 200, `C: /vendas com sessão real deveria ser 200; veio ${vendasNormal.status}`);
  evidence.push(`C regressão: login normal ${loginNormal.status}; GET /vendas ${vendasNormal.status}`);

  // ---------------------------------------------------------------------
  // D. loginFailed seguro: senha errada com banco OK → 401 controlado.
  // ---------------------------------------------------------------------
  const senhaErrada = await http(b.baseUrl, 'POST', '/auth/login', undefined, { email, password: `${senha}-errada` });
  assert.equal(senhaErrada.status, 401, `D: senha errada deveria ser 401; veio ${senhaErrada.status} ${senhaErrada.text.slice(0, 160)}`);
  evidence.push(`D loginFailed: senha errada ${senhaErrada.status} (controlado)`);
  await stopServer(b.child);

  console.log('\n=== PROD-DB-01.3 (token de emergência) evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});
