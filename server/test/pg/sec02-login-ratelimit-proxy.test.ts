// ============================================================================
// SEC-02 / P1-04 — BYPASS DO RATE LIMIT DE LOGIN VIA X-FORWARDED-FOR
//
// A auditoria forense (PR #63) mostrou que o rate limit do login derivava a
// identidade diretamente do cabeçalho `X-Forwarded-For`:
//
//   clientIp(req) = (req.headers['x-forwarded-for'] || '').split(',')[0]
//
// Um atacante trocava o valor a cada tentativa e obtinha um "bucket" novo,
// escapando do bloqueio por IP. Agravante: `app.set('trust proxy', 1)` era
// FIXO, inclusive fora de proxy.
//
// Correção (este ciclo):
//   • confiança de proxy EXPLÍCITA por ambiente (`TRUST_PROXY`, padrão = não
//     confiar em encaminhamento);
//   • `clientIp` usa `req.ip`, que o Express resolve segundo essa confiança.
//
// Esta prova sobe o servidor de VERDADE contra um BANCO NOVO e exercita o
// caminho real `HTTP → Express (trust proxy) → rota → login/reset → PostgreSQL`,
// sem `req.user` injetado, sem memória e sem serviço externo.
//
// A verificação é MECANISMO-PRECISA: além do status HTTP, conta quantos buckets
// de rate limit existem NO POSTGRES para cada e-mail/IP. A correção é provada
// pela AUSÊNCIA de proliferação de buckets — não apenas pelo status.
//
//   SEM proxy confiável (padrão):
//     A) login: XFF 1.1.1.1 e depois 2.2.2.2 → MESMO bucket (1 só no Postgres)
//     B) login: XFF variando em 100 valores             → 1 só bucket
//     C) login: formatos hostis de XFF (lista/inválido/vazio/múltiplos) → 1 bucket
//     G) reset (limiter SÓ por IP, sem bloqueio por usuário): variar XFF a cada
//        tentativa continua bloqueando no 6º hit
//     F) login LEGÍTIMO não é bloqueado indevidamente
//
//   COM proxy confiável (TRUST_PROXY=1):
//     D) requisição feita por `127.0.0.1` (proxy) com XFF = cliente real →
//        o IP do CLIENTE vira a chave (prova a cadeia cliente→proxy→app) e dois
//        clientes do mesmo proxy têm buckets separados
//     E) toda a prova é uma execução HTTP real através do Express
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
  throw new Error('sec02-login-ratelimit-proxy.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `sec02${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_sec02_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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

async function startRealServer(port: number, databaseUrl: string, extraEnv: Record<string, string>): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `sec02-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `SEC02-${randomUUID()}-OnlyForTest`,
    ...extraEnv,
  };
  // Não herda um TRUST_PROXY da máquina de CI a menos que o caso peça.
  if (!('TRUST_PROXY' in extraEnv)) delete env.TRUST_PROXY;

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

type Resposta = { status: number; body: any; texto: string; retryAfter: string | null };

async function post(baseUrl: string, rota: string, corpo: unknown, xff?: string): Promise<Resposta> {
  const h: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (xff !== undefined) h['x-forwarded-for'] = xff;
  const r = await fetch(`${baseUrl}/api${rota}`, { method: 'POST', headers: h, body: JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto, retryAfter: r.headers.get('retry-after') };
}

const login = (baseUrl: string, email: string, senha: string, xff?: string): Promise<Resposta> =>
  post(baseUrl, '/auth/login', { email, password: senha }, xff);

async function criarUsuario(cliente: Client, email: string, senha: string): Promise<void> {
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, 1, false, false, false, now())`,
    [`Usuário SEC-02 ${RODADA}`, email, await hashPassword(senha)],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email]);
}

/** Buckets de rate limit do login para um e-mail (prova de não-proliferação). */
async function bucketsLogin(cliente: Client, email: string): Promise<string[]> {
  const r = await cliente.query(`SELECT chave FROM login_tentativas WHERE chave LIKE $1 ORDER BY chave`, [`login|%|${email.toLowerCase()}`]);
  return r.rows.map((row: any) => String(row.chave));
}
/** Buckets de rate limit do reset (chave = só IP). */
async function bucketsReset(cliente: Client): Promise<string[]> {
  const r = await cliente.query(`SELECT chave FROM login_tentativas WHERE chave LIKE 'reset|%' ORDER BY chave`);
  return r.rows.map((row: any) => String(row.chave));
}

test('SEC-02/P1-04: sem proxy confiável, X-Forwarded-For NÃO permite trocar de bucket (A/B/C/G/F + D/E com proxy)', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const portaSemProxy = await reservePort();
  const semProxy = await startRealServer(portaSemProxy, databaseUrl, {});
  const portaComProxy = await reservePort();
  const comProxy = await startRealServer(portaComProxy, databaseUrl, { TRUST_PROXY: '1' });

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(semProxy.child);
    await stopServer(comProxy.child);
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  const evidencia: string[] = [];
  const registra = (texto: string) => evidencia.push(texto);
  // Bloqueado = 429 (rate limit por IP) OU 403 (bloqueio por usuário). O que a
  // correção garante é que trocar o XFF NÃO reabre um bucket por IP.
  const bloqueado = (s: number) => s === 429 || s === 403;

  // ------------------------------------------------------------------------
  // TESTE A — mesma conexão (127.0.0.1), XFF 1.1.1.1 e depois 2.2.2.2.
  // ------------------------------------------------------------------------
  const emailA = `sec02-a-${RODADA}@example.test`;
  const senhaA = `SEC02-${randomUUID()}!`;
  await criarUsuario(cliente, emailA, senhaA);
  for (let i = 0; i < 5; i++) {
    const r = await login(semProxy.baseUrl, emailA, 'senha-errada', '1.1.1.1');
    assert.equal(r.status, 401, `A: tentativa ${i + 1} deve ser 401, veio ${r.status}`);
  }
  const r6 = await login(semProxy.baseUrl, emailA, 'senha-errada', '2.2.2.2');
  assert.ok(bloqueado(r6.status), `A: 6ª tentativa com XFF DIFERENTE deve seguir bloqueada (429/403), veio ${r6.status}: ${r6.texto}`);
  const bucketsA = await bucketsLogin(cliente, emailA);
  assert.equal(bucketsA.length, 1, `A: os dois XFF devem cair no MESMO bucket; vieram ${bucketsA.length}: ${bucketsA.join(', ')}`);
  assert.match(bucketsA[0]!, /^login\|127\.0\.0\.1\|/, `A: a chave deve usar o IP real (127.0.0.1), veio ${bucketsA[0]}`);
  assert.ok(!bucketsA[0]!.includes('1.1.1.1') && !bucketsA[0]!.includes('2.2.2.2'), 'A: nenhum IP do header pode virar chave');
  registra(`A → login: 5x XFF=1.1.1.1 + XFF=2.2.2.2 → ${r6.status}; buckets=${bucketsA.join(', ')}`);

  // ------------------------------------------------------------------------
  // TESTE B — 100 valores de XFF distintos (10.0.0.x) para o mesmo e-mail.
  // Sem a correção surgiriam dezenas de buckets; com a correção, UM.
  // ------------------------------------------------------------------------
  const emailC = `sec02-c-${RODADA}@example.test`;
  const senhaC = `SEC02-${randomUUID()}!`;
  await criarUsuario(cliente, emailC, senhaC);
  const statusB: number[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await login(semProxy.baseUrl, emailC, 'senha-errada', `10.0.0.${(i % 254) + 1}`);
    statusB.push(r.status);
  }
  const primeiroBloqueioB = statusB.findIndex(bloqueado);
  assert.ok(primeiroBloqueioB > 0, `B: o rate limit precisa disparar apesar de 100 XFF distintos; status=${statusB.slice(0, 8).join(',')}`);
  assert.equal(primeiroBloqueioB, 5, `B: o bloqueio deve ocorrer na 6ª tentativa (5 falhas), veio na ${primeiroBloqueioB + 1}`);
  const bucketsB = await bucketsLogin(cliente, emailC);
  assert.equal(bucketsB.length, 1, `B: 100 XFF diferentes devem gerar 1 só bucket; vieram ${bucketsB.length}: ${bucketsB.join(', ')}`);
  assert.match(bucketsB[0]!, /^login\|127\.0\.0\.1\|/, `B: chave pelo IP real, veio ${bucketsB[0]}`);
  registra(`B → login: 100 tentativas com XFF=10.0.0.x → 1º bloqueio na ${primeiroBloqueioB + 1}ª; buckets=${bucketsB.length}`);

  // ------------------------------------------------------------------------
  // TESTE C — formatos hostis de XFF. Cada formato parte de um e-mail NOVO;
  // após 5 falhas, um 6º hit com XFF TROCADO tem de seguir bloqueado, e o
  // e-mail tem de continuar com UM único bucket.
  // ------------------------------------------------------------------------
  const formatos: Array<[string, string]> = [
    ['simples', '1.1.1.1'],
    ['lista com espaços', '1.1.1.1, 2.2.2.2'],
    ['lista invertida', '8.8.8.8, 1.1.1.1'],
    ['inválido', 'invalid'],
    ['vazio', ''],
  ];
  for (const [rotulo, xff] of formatos) {
    const email = `sec02-fmt-${rotulo.replace(/[^a-z0-9]+/gi, '')}-${RODADA}@example.test`;
    const senha = `SEC02-${randomUUID()}!`;
    await criarUsuario(cliente, email, senha);
    for (let i = 0; i < 5; i++) await login(semProxy.baseUrl, email, 'senha-errada', xff);
    const r = await login(semProxy.baseUrl, email, 'senha-errada', '9.9.9.9');
    assert.ok(bloqueado(r.status), `C(${rotulo}): após 5 falhas, XFF trocado ainda deve bloquear (429/403), veio ${r.status}`);
    const buckets = await bucketsLogin(cliente, email);
    assert.equal(buckets.length, 1, `C(${rotulo}): deve haver 1 bucket, vieram ${buckets.length}: ${buckets.join(', ')}`);
    registra(`C(${rotulo}) → login 5x XFF=${JSON.stringify(xff)} + XFF=9.9.9.9 → ${r.status}; buckets=${buckets.length}`);
  }

  // Cabeçalho X-Forwarded-For repetido: o Node combina em "a, b"; tratado como
  // lista não confiável.
  {
    const email = `sec02-multi-${RODADA}@example.test`;
    const senha = `SEC02-${randomUUID()}!`;
    await criarUsuario(cliente, email, senha);
    for (let i = 0; i < 5; i++) await login(semProxy.baseUrl, email, 'senha-errada', '1.1.1.1, 2.2.2.2');
    const r = await login(semProxy.baseUrl, email, 'senha-errada', '2.2.2.2, 1.1.1.1');
    assert.ok(bloqueado(r.status), `C(múltiplos): deve seguir bloqueado, veio ${r.status}`);
    assert.equal((await bucketsLogin(cliente, email)).length, 1, 'C(múltiplos): 1 bucket');
    registra(`C(múltiplos) → login XFF "1.1.1.1, 2.2.2.2" e depois invertido → ${r.status}`);
  }

  // ------------------------------------------------------------------------
  // TESTE G — /api/auth/reset: limiter keyed SÓ por IP (sem bloqueio por
  // usuário). É a prova limpa de que o limiter por IP não pode ser burlado com
  // X-Forwarded-For: variando o header a CADA tentativa, o 6º hit ainda 429.
  // ------------------------------------------------------------------------
  const statusG: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await post(semProxy.baseUrl, '/auth/reset', { token: `invalido-${i}`, senha: 'NovaSenha123!' }, `172.16.0.${i + 1}`);
    statusG.push(r.status);
  }
  assert.ok(statusG.slice(0, 5).every((s) => s === 400), `G: as 5 primeiras devem ser 400 (token inválido), veio ${statusG.slice(0, 5).join(',')}`);
  assert.equal(statusG[5], 429, `G: 6ª com XFF DIFERENTE deve ser 429, veio ${statusG[5]}`);
  const bucketsG = await bucketsReset(cliente);
  assert.equal(bucketsG.length, 1, `G: reset deve ter 1 bucket (pelo IP real), vieram ${bucketsG.join(', ')}`);
  assert.equal(bucketsG[0], 'reset|127.0.0.1', `G: chave do reset deve ser o IP real, veio ${bucketsG[0]}`);
  registra(`G → reset: 6 tentativas com XFF=172.16.0.x → status=[${statusG.join(',')}]; buckets=${bucketsG.join(', ')}`);

  // ------------------------------------------------------------------------
  // TESTE F — login legítimo NÃO é bloqueado pela configuração de proxy.
  // ------------------------------------------------------------------------
  const emailF = `sec02-f-${RODADA}@example.test`;
  const senhaF = `SEC02-${randomUUID()}!`;
  await criarUsuario(cliente, emailF, senhaF);
  const legit = await login(semProxy.baseUrl, emailF, senhaF, '203.0.113.7');
  assert.equal(legit.status, 200, `F: login correto deve ser 200, veio ${legit.status}: ${legit.texto}`);
  assert.ok(String(legit.body?.token || '').length > 20, 'F: login deve emitir JWT');
  registra(`F → login correto com XFF=203.0.113.7 → 200 (token emitido)`);

  // ------------------------------------------------------------------------
  // TESTE D/E — COM proxy confiável (TRUST_PROXY=1): a conexão chega de
  // 127.0.0.1 (o proxy) e o IP do CLIENTE vem no X-Forwarded-For. A chave deve
  // ser o IP DO CLIENTE — prova a cadeia cliente→proxy→app. Dois clientes do
  // mesmo proxy têm buckets SEPARADOS.
  // ------------------------------------------------------------------------
  const emailD = `sec02-d-${RODADA}@example.test`;
  const senhaD = `SEC02-${randomUUID()}!`;
  await criarUsuario(cliente, emailD, senhaD);
  const cliente1 = '198.51.100.10';
  const cliente2 = '198.51.100.20';
  for (let i = 0; i < 5; i++) {
    const r = await login(comProxy.baseUrl, emailD, 'senha-errada', cliente1);
    assert.equal(r.status, 401, `D: cliente1 tentativa ${i + 1} deve ser 401, veio ${r.status}`);
  }
  const d6 = await login(comProxy.baseUrl, emailD, 'senha-errada', cliente1);
  assert.equal(d6.status, 429, `D: cliente1 deve estar bloqueado (429 = rate limit por IP), veio ${d6.status}`);
  // cliente2, mesmo proxy, e-mail distinto (evita o bloqueio por usuário):
  // bucket de IP PRÓPRIO → não foi arrastado pelo de cliente1.
  const emailD2 = `sec02-d2-${RODADA}@example.test`;
  const senhaD2 = `SEC02-${randomUUID()}!`;
  await criarUsuario(cliente, emailD2, senhaD2);
  const dOutro = await login(comProxy.baseUrl, emailD2, 'senha-errada', cliente2);
  assert.equal(dOutro.status, 401, `D: cliente2 (mesmo proxy) deve ter bucket próprio (401), veio ${dOutro.status}`);
  const chavesD = await bucketsLogin(cliente, emailD);
  assert.ok(chavesD.some((k) => k.includes(cliente1)), `D: deve existir bucket do cliente1 (${cliente1}); chaves=${chavesD.join(', ')}`);
  assert.ok(!chavesD.some((k) => k.includes('127.0.0.1')), `D: o IP do proxy não pode ser a chave; chaves=${chavesD.join(', ')}`);
  registra(`D → TRUST_PROXY=1: cliente1 esgotado (429), cliente2 ainda 401; buckets=${chavesD.join(', ')}`);

  // ------------------------------------------------------------------------
  // Prova PostgreSQL direta: todas as chaves são de login/reset e existem.
  // ------------------------------------------------------------------------
  const todos = (await cliente.query(`SELECT chave FROM login_tentativas ORDER BY chave`)).rows.map((r: any) => String(r.chave));
  assert.ok(todos.length >= 1, 'prova: deve haver buckets persistidos');
  assert.ok(todos.every((k) => k.startsWith('login|') || k.startsWith('reset|')), 'prova: só chaves de login/reset');
  registra(`Postgres: ${todos.length} chave(s) de rate limit persistidas`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### SEC-02 — rate limit de login / X-Forwarded-For\n${evidencia.map((e) => `- ${e}`).join('\n')}\n`, 'utf8');
  }
  console.log(`\nSEC-02 evidência:\n${evidencia.map((e) => `  • ${e}`).join('\n')}\n`);
});
