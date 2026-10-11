// ============================================================================
// ERP-07 — ADMINISTRAÇÃO DE EMPRESAS POR HTTP, EM POSTGRESQL (P1-04).
//
// A prova de rota: a alçada de administrador não é uma declaração bonita no
// recurso — é o que a API responde. Um gerente com token válido recebe **403**
// nos quatro verbos do CRUD de `empresas` (antes do ERP-07 recebia 200/201: o
// recurso não tinha `adminOnly` e o menu nem expunha a tela — ponto cego do
// `audit:menu`, P2-05).
//
// E a prova de não-regressão que importa: o SELETOR continua funcionando. A
// troca da empresa ativa (`/api/empresas/ativa`) é outro caminho, autorizado
// pela concessão do usuário — `adminOnly` no CRUD genérico não pode tê-la
// fechado por acidente.
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
  throw new Error('empresas-admin-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e07${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_e07_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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

async function startRealServer(port: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e07-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E07-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => {
    output = `${output}${String(chunk)}`.slice(-40_000);
  };
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
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (corpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(texto);
  } catch {
    body = null;
  }
  return { status: r.status, body, texto };
}

test('ERP-07/P1-04: gerente não administra empresas por HTTP, e o seletor de empresa ativa continua funcionando', async (t) => {
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

  const email = `e07-${RODADA}@example.test`;
  const senha = `E07-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, 1, false, false, false, now())`,
    [`Gerente ${RODADA}`, email, await hashPassword(senha)],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email]);

  const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(login.status, 200, `login do gerente: ${login.texto}`);
  const token = String(login.body?.token || '');
  assert.ok(token.length > 20, 'login emite JWT');

  const empresasAntes = Number((await cliente.query(`SELECT count(*)::int AS n FROM empresas`)).rows[0].n);

  // ---- O CRUD de empresas é do ADMINISTRADOR ------------------------------
  const lista = await req(baseUrl, 'GET', '/empresas', undefined, token);
  assert.equal(lista.status, 403, `GERENTE lendo a lista de empresas: ${lista.texto}`);
  assert.match(String(lista.body?.error || ''), /administradores/i);

  const criar = await req(baseUrl, 'POST', '/empresas', { nome: `Filial do Gerente ${RODADA}` }, token);
  assert.equal(criar.status, 403, `GERENTE criando empresa (antes do ERP-07: 201): ${criar.texto}`);

  const editar = await req(baseUrl, 'PUT', '/empresas/1', { nome: 'Renomeada pelo Gerente' }, token);
  assert.equal(editar.status, 403, `GERENTE editando a empresa padrão (antes: 200): ${editar.texto}`);

  const excluir = await req(baseUrl, 'DELETE', '/empresas/1', undefined, token);
  assert.equal(excluir.status, 403, `GERENTE excluindo a empresa padrão (antes: passava da checagem): ${excluir.texto}`);

  // Nada foi criado nem renomeado.
  const empresasDepois = await cliente.query(`SELECT id, nome FROM empresas ORDER BY id`);
  assert.equal(Number((await cliente.query(`SELECT count(*)::int AS n FROM empresas`)).rows[0].n), empresasAntes, 'nenhuma empresa foi criada');
  assert.equal(String(empresasDepois.rows[0].nome), 'BROBOND', 'a empresa padrão mantém o nome');

  // ---- O SELETOR continua funcionando para o gerente ----------------------
  const ativa = await req(baseUrl, 'GET', '/empresas/ativa', undefined, token);
  assert.equal(ativa.status, 200, `o seletor precisa continuar abrindo para o gerente: ${ativa.texto}`);
  assert.equal(Number(ativa.body?.empresa_id), 1);
  assert.ok(Array.isArray(ativa.body?.empresas) && ativa.body.empresas.length >= 1, 'o seletor lista as empresas concedidas');

  const trocar = await req(baseUrl, 'POST', '/empresas/ativa', { empresa_id: 1 }, token);
  assert.equal(trocar.status, 200, `trocar para a empresa concedida continua permitido: ${trocar.texto}`);
  assert.ok(String(trocar.body?.token || '').length > 20, 'a troca devolve token novo (sessão assinada)');

  assert.doesNotMatch(logs(), /Erro interno do servidor/, 'nenhuma operação pode virar 500');
});
