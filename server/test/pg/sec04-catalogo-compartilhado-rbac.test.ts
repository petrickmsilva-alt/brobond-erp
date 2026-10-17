// ============================================================================
// SEC-04 / P1-01 — CATÁLOGO COMPARTILHADO + RBAC (HTTP real + PostgreSQL).
//
// O catálogo `categorias`, `cores`, `grades`, `tamanhos` é GLOBAL (tabelas sem
// `empresa_id`). O finding: um OPERADOR autenticado conseguia incluir/alterar
// esses cadastros pela API genérica (`POST/PUT /api/:resource`), reescrevendo
// nomenclatura que vale para todas as empresas.
//
// Esta prova sobe o servidor de VERDADE contra um BANCO NOVO e percorre o
// caminho real `HTTP → requireAuth → checkAccess (guard da rota) → handler →
// PostgreSQL`, sem `req.user` injetado, sem memória:
//
//   A) ADMIN   → CRUD completo no catálogo compartilhado → 2xx
//   B) GERENTE → CRUD completo no catálogo compartilhado → 2xx
//   C) OPERADOR → create/update/delete → 403; read/options → 200 (não regride)
//   D) ANÔNIMO → 401
//   E) spoofing (role/perfil/empresa_id/headers/query/corpo) → não eleva
//   F) cross-tenant: operador da empresa B também não escreve o global; e o
//      ADMIN global mantém o comportamento legítimo
//   G) regressão: rotas não administrativas seguem funcionando
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
  throw new Error('sec04-catalogo-compartilhado-rbac.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');
const { codigoTOTP } = await import('../../src/totp');
const { decifrarSegredoMfa } = await import('../../src/mfa');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `sec04${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_sec04_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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

const ADMIN_EMAIL_TESTE = `sec04-bootstrap-${RODADA}@example.test`;
const ADMIN_SENHA_TESTE = `SEC04-${randomUUID()}-OnlyForTest`;

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

/** Cria um recurso do catálogo com um sufixo único (para não colidir no unique). */
function payloadCatalogo(recurso: string, sufixo: string, tamanhoId?: number): Record<string, unknown> {
  if (recurso === 'tamanhos') return { codigo: `S${sufixo}`.slice(0, 10), descricao: `SEC-04 ${sufixo}`, ordem: 99 };
  if (recurso === 'cores') return { nome: `Cor SEC-04 ${sufixo}`, hex: '#123456' };
  if (recurso === 'grades') return { nome: `Grade SEC-04 ${sufixo}`, tamanhos: tamanhoId ? [tamanhoId] : [] };
  return { nome: `Categoria SEC-04 ${sufixo}` };
}

const CATALOGO = ['categorias', 'cores', 'grades', 'tamanhos'] as const;

test('SEC-04/P1-01: catálogo compartilhado exige gerente+ para ESCREVER (HTTP real + PostgreSQL)', async (t) => {
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
  const emailG = `sec04-g-${RODADA}@example.test`;
  const senhaG = `SEC04-G-${randomUUID()}!`;
  const emailO = `sec04-o-${RODADA}@example.test`;
  const senhaO = `SEC04-O-${randomUUID()}!`;
  for (const [nomeU, email, senha, perfil] of [
    [`Gerente SEC-04`, emailG, senhaG, 'gerente'],
    [`Operador SEC-04`, emailO, senhaO, 'operador'],
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
  // pela rota real para exercitar as ESCRITAS com um admin "normal" — sem isso,
  // bloquearSenhaProvisoria derrubaria o POST antes do handler e mascararia o
  // comportamento do guard. A sessão atual continua válida após a troca.
  const novaSenhaAdmin = `SEC04-Adm-${randomUUID()}!X`;
  const troca = await req(baseUrl, 'POST', '/auth/change-password', { senha_atual: ADMIN_SENHA_TESTE, senha_nova: novaSenhaAdmin }, adminToken);
  assert.equal(troca.status, 200, `troca de senha do admin: ${troca.texto}`);
  const gerenteToken = await loginSemMfa(baseUrl, emailG, senhaG);
  const operadorToken = await loginSemMfa(baseUrl, emailO, senhaO);
  registra('logins reais: ADMIN (MFA) + GERENTE + OPERADOR (sem MFA)');

  // ------------------------------------------------------------------------
  // A/B) ADMIN e GERENTE → CRUD completo (comportamento legítimo, 2xx).
  // ------------------------------------------------------------------------
  // `grades` exige um multiref de tamanhos: criamos um tamanho de apoio por
  // perfil e reutilizamos o id no payload da grade (o catálogo é global).
  for (const [perfil, token] of [['ADMIN', adminToken], ['GERENTE', gerenteToken]] as const) {
    const tag = perfil === 'ADMIN' ? 'a' : 'g';
    const tamanho = await req(baseUrl, 'POST', '/tamanhos', payloadCatalogo('tamanhos', `${RODADA.slice(-4)}T${tag}`.toUpperCase()), token);
    assert.equal(tamanho.status, 201, `${perfil} POST /tamanhos (apoio) deveria incluir: ${tamanho.texto}`);
    const tamanhoId = Number(tamanho.body.id);

    for (const recurso of CATALOGO) {
      const sufixo = `${RODADA.slice(-4)}${recurso.slice(0, 3)}${tag}`.toUpperCase();
      const criarPayload = payloadCatalogo(recurso, sufixo, tamanhoId);
      const criado = await req(baseUrl, 'POST', `/${recurso}`, criarPayload, token);
      assert.equal(criado.status, 201, `${perfil} POST /${recurso} deveria incluir: ${criado.texto}`);
      const id = Number(criado.body?.id);
      assert.ok(id > 0, `${perfil} POST /${recurso} precisa devolver id: ${criado.texto}`);
      const alterado = await req(baseUrl, 'PUT', `/${recurso}/${id}`, payloadCatalogo(recurso, `${sufixo}X`, tamanhoId), token);
      assert.equal(alterado.status, 200, `${perfil} PUT /${recurso}/${id} deveria alterar: ${alterado.texto}`);
      const excluido = await req(baseUrl, 'DELETE', `/${recurso}/${id}`, undefined, token);
      assert.equal(excluido.status, 200, `${perfil} DELETE /${recurso}/${id} deveria excluir: ${excluido.texto}`);
      registra(`${perfil === 'ADMIN' ? 'A' : 'B'}) ${perfil} CRUD /${recurso} → 201/200/200`);
    }
  }

  // ------------------------------------------------------------------------
  // C) OPERADOR → escrita 403; leitura e /options continuam 200.
  // ------------------------------------------------------------------------
  for (const recurso of CATALOGO) {
    const sufixo = `OP${RODADA.slice(-4)}${recurso.slice(0, 3)}`.toUpperCase();
    const criado = await req(baseUrl, 'POST', `/${recurso}`, payloadCatalogo(recurso, sufixo), operadorToken);
    assert.equal(criado.status, 403, `OPERADOR POST /${recurso} deve ser 403: ${criado.texto}`);
    assert.match(String(criado.body?.error || ''), /gerentes e administradores/i, `mensagem canônica: ${criado.texto}`);
    registra(`C) OPERADOR POST /${recurso} → 403`);

    // A leitura operacional NÃO regride: listagem e /options respondem 200.
    const lista = await req(baseUrl, 'GET', `/${recurso}?page=1&pageSize=5`, undefined, operadorToken);
    assert.equal(lista.status, 200, `OPERADOR GET /${recurso} deve ler: ${lista.texto}`);
    const options = await req(baseUrl, 'GET', `/${recurso}/options`, undefined, operadorToken);
    assert.equal(options.status, 200, `OPERADOR GET /${recurso}/options deve ler: ${options.texto}`);
    registra(`C) OPERADOR GET /${recurso} e /${recurso}/options → 200 (leitura preservada)`);
  }
  // Update/delete de um registro existente (criado pelo gerente) também 403.
  const alvoGerente = payloadCatalogo('cores', `G${RODADA.slice(-4)}`.toUpperCase());
  const corGerente = await req(baseUrl, 'POST', '/cores', alvoGerente, gerenteToken);
  assert.equal(corGerente.status, 201, `gerente cria cor para o teste de update/delete: ${corGerente.texto}`);
  const corId = Number(corGerente.body.id);
  const upd = await req(baseUrl, 'PUT', `/cores/${corId}`, { nome: `Cor hack ${RODADA}` }, operadorToken);
  assert.equal(upd.status, 403, `OPERADOR PUT /cores/${corId} deve ser 403: ${upd.texto}`);
  const del = await req(baseUrl, 'DELETE', `/cores/${corId}`, undefined, operadorToken);
  assert.equal(del.status, 403, `OPERADOR DELETE /cores/${corId} deve ser 403: ${del.texto}`);
  registra('C) OPERADOR PUT/DELETE /cores/:id → 403');

  // ------------------------------------------------------------------------
  // D) ANÔNIMO → 401 (barrado pelo requireAuth, antes do guard).
  // ------------------------------------------------------------------------
  for (const recurso of CATALOGO) {
    const lista = await req(baseUrl, 'GET', `/${recurso}?page=1&pageSize=5`);
    assert.equal(lista.status, 401, `ANÔNIMO GET /${recurso} deve ser 401: ${lista.texto}`);
    const criar = await req(baseUrl, 'POST', `/${recurso}`, payloadCatalogo(recurso, `ANON${RODADA.slice(-4)}`));
    assert.equal(criar.status, 401, `ANÔNIMO POST /${recurso} deve ser 401: ${criar.texto}`);
  }
  registra('D) ANÔNIMO GET/POST no catálogo → 401');

  // ------------------------------------------------------------------------
  // E) SPOOFING — role/perfil/empresa_id/headers/query/corpo não elevam.
  // ------------------------------------------------------------------------
  const tentativas: Array<[string, Record<string, string>]> = [
    ['header x-perfil=admin', { 'x-perfil': 'admin' }],
    ['header x-role=admin', { 'x-role': 'admin' }],
    ['header role=admin', { role: 'admin' }],
    ['header x-admin=true', { 'x-admin': 'true' }],
  ];
  for (const [nomeT, headers] of tentativas) {
    const r = await req(
      baseUrl,
      'POST',
      '/categorias?perfil=admin&role=admin&is_admin=true&empresa_id=1&consolidado=1',
      { ...payloadCatalogo('categorias', `SPF${RODADA.slice(-4)}`), perfil: 'admin', role: 'admin', is_admin: true, empresa_id: 1 },
      operadorToken,
      headers
    );
    assert.equal(r.status, 403, `spoofing (${nomeT}) não pode elevar privilégio: ${r.texto}`);
    registra(`E) OPERADOR ${nomeT} + query/corpo forjados → 403`);
  }

  // ------------------------------------------------------------------------
  // F) CROSS-TENANT — operador de OUTRA empresa também não escreve o global.
  // ------------------------------------------------------------------------
  const empresaB = await cliente.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Filial SEC-04 ${RODADA}`]);
  const empresaBId = Number(empresaB.rows[0].id);
  const emailOB = `sec04-ob-${RODADA}@example.test`;
  const senhaOB = `SEC04-OB-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'operador', true, $4, false, false, false, now())`,
    [`Operador B SEC-04`, emailOB, await hashPassword(senhaOB), empresaBId]
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [emailOB, empresaBId]);
  const operadorBToken = await loginSemMfa(baseUrl, emailOB, senhaOB);
  for (const sufixo of ['', '?empresa_id=1', `?empresa_id=${empresaBId}`, '?consolidado=1']) {
    const r = await req(baseUrl, 'POST', `/categorias${sufixo}`, payloadCatalogo('categorias', `XB${RODADA.slice(-4)}`), operadorBToken);
    assert.equal(r.status, 403, `operador da empresa B ${sufixo || '(limpo)'} deve continuar 403: ${r.texto}`);
  }
  // Leitura do catálogo global pelo operador da empresa B continua 200.
  const lerB = await req(baseUrl, 'GET', '/tamanhos/options', undefined, operadorBToken);
  assert.equal(lerB.status, 200, `operador B precisa LER o catálogo global: ${lerB.texto}`);
  registra('F) OPERADOR da empresa B: POST /categorias (com/sem empresa_id/consolidado) → 403; leitura → 200');

  // ADMIN global segue escrevendo (a operação é global por natureza).
  const adminGlobal = await req(baseUrl, 'POST', '/cores', payloadCatalogo('cores', `GA${RODADA.slice(-4)}`), adminToken);
  assert.equal(adminGlobal.status, 201, `ADMIN continua escrevendo o global: ${adminGlobal.texto}`);
  registra('F) ADMIN POST /cores (global, legítimo) → 201');

  // ------------------------------------------------------------------------
  // G) REGRESSÃO — rotas não administrativas seguem funcionando para operador.
  // ------------------------------------------------------------------------
  const meta = await req(baseUrl, 'GET', '/meta', undefined, operadorToken);
  assert.equal(meta.status, 200, `OPERADOR /meta deve funcionar: ${meta.texto}`);
  const produtos = await req(baseUrl, 'GET', '/produtos?page=1&pageSize=5', undefined, operadorToken);
  assert.equal(produtos.status, 200, `OPERADOR /produtos deve funcionar: ${produtos.texto}`);
  const clientesOptions = await req(baseUrl, 'GET', '/clientes/options', undefined, operadorToken);
  assert.equal(clientesOptions.status, 200, `OPERADOR /clientes/options deve funcionar: ${clientesOptions.texto}`);
  registra('G) OPERADOR /meta, /produtos, /clientes/options → 200 (regressão verde)');

  await t.test('evidência SEC-04', () => {
    for (const linha of evidencia) console.log(`  • ${linha}`);
    void logs;
  });
});
