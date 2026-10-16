// ============================================================================
// SEC-03 / P1-02 — /api/admin/* PROTEGIDAS NO SERVIDOR (PostgreSQL real).
//
// A auditoria forense provou que um GERENTE autenticado alcançava DADOS GLOBAIS
// de administração (ex.: /api/admin/auditoria/verificar) mesmo sem privilégio
// administrativo. O prefixo `admin` no caminho não autorizava nada por si.
//
// Esta prova sobe o servidor de VERDADE contra um BANCO NOVO e percorre o
// caminho real `HTTP → requireAuth → requireRole('admin') → rota → handler →
// PostgreSQL`, sem `req.user` injetado, sem memória e sem serviço externo:
//
//   A) ADMIN → cada endpoint /api/admin/* → comportamento legítimo (não 401/403)
//   B) GERENTE → cada endpoint exclusivamente ADMIN → 403
//   C) OPERADOR → cada endpoint exclusivamente ADMIN → 403
//   D) ANÔNIMO → cada endpoint /api/admin/* → 401
//   E) spoofing (role/perfil/empresa_id/headers/query) → não eleva privilégio
//   F) cross-tenant: gerente da empresa A não usa parâmetros para ganhar acesso
//      global (a tentativa continua 403, independente de empresa_id)
//   G) regressão: rotas NÃO administrativas seguem funcionando para gerente
//
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import type { Readable } from 'node:stream';
import { test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('sec03-admin-routes-authorization.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');
const { codigoTOTP } = await import('../../src/totp');
const { decifrarSegredoMfa } = await import('../../src/mfa');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `sec03${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_sec03_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
}
function urlDoBanco(nome: string): string {
  const url = new URL(String(process.env.DATABASE_URL));
  url.pathname = `/${nome}`;
  return url.toString();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP para o harness.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

const ADMIN_EMAIL_TESTE = `sec03-bootstrap-${RODADA}@example.test`;
const ADMIN_SENHA_TESTE = `SEC03-${randomUUID()}-OnlyForTest`;

async function startRealServer(port: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: ADMIN_EMAIL_TESTE,
    ADMIN_PASSWORD: ADMIN_SENHA_TESTE,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch {
      // migrações do banco novo em andamento
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 120 s.\n${output}`);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Resposta> {
  const h: Record<string, string> = { accept: 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (corpo !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

/** Loga sem MFA (operador/gerente criados por SQL, sem mfa_ativado_em). */
async function loginSemMfa(baseUrl: string, email: string, senha: string): Promise<string> {
  const r = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(r.status, 200, `login de ${email}: ${r.texto}`);
  assert.ok(r.body?.token, `login de ${email} precisa emitir JWT: ${r.texto}`);
  return String(r.body.token);
}

/** Loga o ADMIN com MFA (cadastro guiado na 1ª vez, desafio depois). */
async function loginAdmin(baseUrl: string, cliente: Client, email: string, senha: string): Promise<string> {
  let r = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(r.status, 200, `login admin: ${r.texto}`);
  const ticket = String(r.body?.mfa_ticket || '');
  assert.ok(ticket, 'admin precisa receber mfa_ticket');
  let segredo: string;
  if (r.body?.mfa_setup_required) {
    const d = await req(baseUrl, 'POST', '/auth/mfa/desafio', { mfa_ticket: ticket });
    assert.equal(d.status, 200, `desafio MFA: ${d.texto}`);
    segredo = String(d.body.segredo);
  } else {
    const cifrado = String((await cliente.query(`SELECT mfa_secret FROM usuarios WHERE email = $1`, [email])).rows[0].mfa_secret);
    segredo = String(decifrarSegredoMfa(cifrado));
    assert.ok(segredo, 'segredo MFA do admin precisa ser decifrável para o desafio');
  }
  const r2 = await req(baseUrl, 'POST', '/auth/login/mfa', { mfa_ticket: ticket, codigo: codigoTOTP(segredo) });
  assert.equal(r2.status, 200, `login/mfa: ${r2.texto}`);
  return String(r2.body.token);
}

// ----------------------------------------------------------------------------
// Inventário de rotas /api/admin/* — guard atual (ANTES) e classificação.
// ----------------------------------------------------------------------------
type RotaAdmin = { metodo: string; rota: string; adminOnly: boolean; nota: string };

const ROTAS_ADMIN: RotaAdmin[] = [
  { metodo: 'GET', rota: '/admin/auditoria/verificar', adminOnly: true, nota: 'dados globais de auditoria (o finding P1-02)' },
  { metodo: 'GET', rota: '/admin/config/endereco-publico', adminOnly: true, nota: 'config self-service do admin (já tinha exigirAdmin)' },
  { metodo: 'PUT', rota: '/admin/config/endereco-publico', adminOnly: true, nota: 'grava configuração do sistema' },
  { metodo: 'DELETE', rota: '/admin/config/endereco-publico', adminOnly: true, nota: 'apaga configuração do sistema' },
  { metodo: 'GET', rota: '/admin/scheduled/status', adminOnly: true, nota: 'config de agendamentos/destinatários' },
  { metodo: 'GET', rota: '/admin/scheduled/run', adminOnly: true, nota: 'dispara relatórios/rotinas (handler já exigia admin)' },
  { metodo: 'POST', rota: '/admin/scheduled/cron', adminOnly: true, nota: 'cron externo (CRON_SECRET opcional)' },
  { metodo: 'GET', rota: '/admin/notificacoes/status', adminOnly: true, nota: 'status/infra de notificações' },
  { metodo: 'GET', rota: '/admin/ws/status', adminOnly: true, nota: 'status do WebSocket/salas' },
  { metodo: 'GET', rota: '/admin/backup/info', adminOnly: true, nota: 'resumo do banco/backup' },
  { metodo: 'GET', rota: '/admin/backup', adminOnly: true, nota: 'dump SQL (handler já exigia admin)' },
  { metodo: 'GET', rota: '/admin/backup/xlsx', adminOnly: true, nota: 'planilha completa (handler já exigia admin)' },
  { metodo: 'POST', rota: '/admin/financeiro/recorrencias', adminOnly: true, nota: 'cron financeiro' },
  { metodo: 'POST', rota: '/admin/financeiro/gateway/webhooks/processar', adminOnly: true, nota: 'cron de retry de webhooks' },
];

test('SEC-03/P1-02: /api/admin/* exige administrador (HTTP real + PostgreSQL)', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  const evidencia: string[] = [];
  const registra = (texto: string) => evidencia.push(texto);

  // ---- Atores: ADMIN (bootstrap), GERENTE e OPERADOR (via SQL) --------------
  const emailG = `sec03-g-${RODADA}@example.test`;
  const senhaG = `SEC03-G-${randomUUID()}!`;
  const emailO = `sec03-o-${RODADA}@example.test`;
  const senhaO = `SEC03-O-${randomUUID()}!`;
  for (const [nomeU, email, senha, perfil] of [
    [`Gerente SEC-03`, emailG, senhaG, 'gerente'],
    [`Operador SEC-03`, emailO, senhaO, 'operador'],
  ] as const) {
    await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
       VALUES ($1, $2, $3, $4, true, 1, false, false, false, now())`,
      [nomeU, email, await hashPassword(senha), perfil]
    );
    await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email]);
  }

  const adminToken = await loginAdmin(baseUrl, cliente, ADMIN_EMAIL_TESTE, ADMIN_SENHA_TESTE);
  // O admin de bootstrap nasce com senha provisória (só lê). Trocamos a senha
  // pela rota real para exercitar as escritas administrativas com um admin
  // "normal" — sem isso, bloquearSenhaProvisoria derrubaria POSTs antes do
  // handler e mascararia o comportamento do guard.
  const novaSenhaAdmin = `SEC03-Adm-${randomUUID()}!X`;
  const troca = await req(baseUrl, 'POST', '/auth/change-password', { senha_atual: ADMIN_SENHA_TESTE, senha_nova: novaSenhaAdmin }, adminToken);
  assert.equal(troca.status, 200, `troca de senha do admin: ${troca.texto}`);
  const gerenteToken = await loginSemMfa(baseUrl, emailG, senhaG);
  const operadorToken = await loginSemMfa(baseUrl, emailO, senhaO);
  registra('logins reais: ADMIN (MFA) + GERENTE + OPERADOR (sem MFA)');

  // Pré-aquece a reautenticação do admin na janela do servidor? Não: cada rota
  // sensível que exige reauth só é exercitada para provar o bloqueio pelo guard
  // (403 do guard, não 403 de reauth) — o guard roda ANTES do handler.

  // ------------------------------------------------------------------------
  // A) ADMIN → cada endpoint alcança o handler (comportamento legítimo).
  // ------------------------------------------------------------------------
  for (const { metodo, rota } of ROTAS_ADMIN) {
    const r = await req(baseUrl, metodo, rota, metodo === 'GET' ? undefined : {}, adminToken);
    // Legítimo = o guard deixou passar. Handlers podem responder 200/409/400/
    // 403-de-reauth (config) — o que NÃO pode é 401/403 de autorização do guard.
    assert.notEqual(r.status, 401, `ADMIN ${metodo} ${rota} não pode ser 401: ${r.texto}`);
    if (rota.startsWith('/admin/config/') && metodo !== 'GET') {
      // As gravações passam pelo guard (admin) e caem em regras do HANDLER:
      // reautenticação recente (reauth_necessaria) ou senha provisória do
      // bootstrap (SENHA_PROVISORIA). O que importa é que NÃO é o 403 de
      // autorização do guard ("permiss").
      assert.equal(r.status, 403, `ADMIN ${metodo} ${rota} (config) → 403 do handler esperado: ${r.texto}`);
      assert.doesNotMatch(String(r.body?.error || ''), /permiss/i, `o 403 do config não pode ser o do guard: ${r.texto}`);
    } else {
      assert.equal(r.status, 200, `ADMIN ${metodo} ${rota} deveria funcionar: ${r.texto}`);
    }
    registra(`A) ADMIN ${metodo} ${rota} → ${r.status}${r.body?.code ? ` (${r.body.code})` : ''}`);
  }

  // ------------------------------------------------------------------------
  // B) GERENTE → cada endpoint exclusivamente ADMIN → 403.
  // ------------------------------------------------------------------------
  for (const { metodo, rota } of ROTAS_ADMIN) {
    const r = await req(baseUrl, metodo, rota, metodo === 'GET' ? undefined : {}, gerenteToken);
    assert.equal(r.status, 403, `GERENTE ${metodo} ${rota} deve ser 403 (era o finding): ${r.texto}`);
    assert.match(String(r.body?.error || ''), /permiss/i, `mensagem canônica de autorização: ${r.texto}`);
    registra(`B) GERENTE ${metodo} ${rota} → 403`);
  }

  // ------------------------------------------------------------------------
  // C) OPERADOR → cada endpoint exclusivamente ADMIN → 403.
  // ------------------------------------------------------------------------
  for (const { metodo, rota } of ROTAS_ADMIN) {
    const r = await req(baseUrl, metodo, rota, metodo === 'GET' ? undefined : {}, operadorToken);
    assert.equal(r.status, 403, `OPERADOR ${metodo} ${rota} deve ser 403: ${r.texto}`);
    registra(`C) OPERADOR ${metodo} ${rota} → 403`);
  }

  // ------------------------------------------------------------------------
  // D) ANÔNIMO → 401 (barrado pelo requireAuth, antes do guard).
  // ------------------------------------------------------------------------
  for (const { metodo, rota } of ROTAS_ADMIN) {
    const r = await req(baseUrl, metodo, rota, metodo === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `ANÔNIMO ${metodo} ${rota} deve ser 401: ${r.texto}`);
    registra(`D) ANÔNIMO ${metodo} ${rota} → 401`);
  }

  // ------------------------------------------------------------------------
  // E) SPOOFING — role/perfil/empresa_id/headers/query não elevam privilégio.
  // ------------------------------------------------------------------------
  const alvo = '/admin/auditoria/verificar';
  const tentativas: Array<[string, Record<string, string>, unknown, unknown]> = [
    ['header x-perfil=admin', { 'x-perfil': 'admin' }, undefined, undefined],
    ['header x-role=admin', { 'x-role': 'admin' }, undefined, undefined],
    ['header role=admin', { role: 'admin' }, undefined, undefined],
    ['header x-empresa-consolidado=1', { 'x-empresa-consolidado': '1' }, undefined, undefined],
    ['query ?perfil=admin', { 'x-spoof': '1' }, undefined, undefined],
  ];
  for (const [nomeT, headers] of tentativas) {
    const r = await req(baseUrl, 'GET', `${alvo}?perfil=admin&role=admin&is_admin=true&consolidado=1&empresa_id=1`, undefined, gerenteToken, headers);
    assert.equal(r.status, 403, `spoofing (${nomeT}) não pode elevar privilégio: ${r.texto}`);
    registra(`E) GERENTE ${nomeT} → 403`);
  }
  // O mesmo token de gerente forjando o corpo numa rota POST administrativa.
  const spoofPost = await req(baseUrl, 'POST', '/admin/scheduled/cron', { perfil: 'admin', role: 'admin', empresa_id: 1, is_admin: true, consolidado: 1 }, gerenteToken, { 'x-perfil': 'admin', 'x-role': 'admin' });
  assert.equal(spoofPost.status, 403, `POST admin com corpo forjado continua 403: ${spoofPost.texto}`);
  registra('E) GERENTE POST /admin/scheduled/cron com corpo+headers forjados → 403');

  // ------------------------------------------------------------------------
  // F) CROSS-TENANT — gerente de outra empresa não ganha o endpoint global.
  // ------------------------------------------------------------------------
  const empresaB = await cliente.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Filial SEC-03 ${RODADA}`]);
  const empresaBId = Number(empresaB.rows[0].id);
  const emailGB = `sec03-gb-${RODADA}@example.test`;
  const senhaGB = `SEC03-GB-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, true, false, false, now())`,
    [`Gerente B SEC-03`, emailGB, await hashPassword(senhaGB), empresaBId]
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [emailGB, empresaBId]);
  const gerenteBToken = await loginSemMfa(baseUrl, emailGB, senhaGB);
  for (const sufixo of ['', '?empresa_id=1', '?consolidado=1', `?empresa_id=${empresaBId}&consolidado=1`]) {
    const r = await req(baseUrl, 'GET', `${alvo}${sufixo}`, undefined, gerenteBToken);
    assert.equal(r.status, 403, `cross-tenant ${sufixo || '(limpo)'} deve continuar 403: ${r.texto}`);
  }
  registra('F) GERENTE de outra empresa (B) em /admin/auditoria/verificar (com e sem empresa_id/consolidado) → 403');

  // ADMIN global segue com o comportamento legítimo (a política global é do admin).
  const adminGlobal = await req(baseUrl, 'GET', alvo, undefined, adminToken);
  assert.equal(adminGlobal.status, 200, `ADMIN continua acessando o global: ${adminGlobal.texto}`);
  registra('F) ADMIN /admin/auditoria/verificar (global, legítimo) → 200');

  // ------------------------------------------------------------------------
  // G) REGRESSÃO — rotas NÃO administrativas seguem funcionando para gerente.
  // ------------------------------------------------------------------------
  const meta = await req(baseUrl, 'GET', '/meta', undefined, gerenteToken);
  assert.equal(meta.status, 200, `GERENTE /meta (não-admin) deve funcionar: ${meta.texto}`);
  const dashboard = await req(baseUrl, 'GET', '/dashboard', undefined, gerenteToken);
  assert.equal(dashboard.status, 200, `GERENTE /dashboard deve funcionar: ${dashboard.texto}`);
  const produtos = await req(baseUrl, 'GET', '/produtos?page=1&pageSize=5', undefined, gerenteToken);
  assert.equal(produtos.status, 200, `GERENTE /produtos deve funcionar: ${produtos.texto}`);
  // /api/usuarios NÃO é /api/admin/* (adminOnly do recurso cuida do RBAC) — não
  // foi alterado por este guard; o smoke cobre o contrato.
  registra('G) GERENTE /meta, /dashboard, /produtos → 200 (regressão verde)');

  // ---- Prova negativa na origem: SEM o guard, o gerente alcançava o global ----
  // (documentada no relatório; aqui confirmamos que o handler NÃO foi executado:
  // a resposta é a do guard e o corpo não traz o payload de auditoria.)
  const bloqueado = await req(baseUrl, 'GET', alvo, undefined, gerenteToken);
  assert.equal(bloqueado.status, 403);
  assert.equal(bloqueado.body?.ok, undefined, 'a resposta de bloqueio não pode conter o resultado da auditoria');

  await t.test('evidência SEC-03', () => {
    for (const linha of evidencia) console.log(`  • ${linha}`);
    void logs;
  });
});
