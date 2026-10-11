// ============================================================================
// ERP-05 — P1-03: INUTILIZAÇÃO DE NUMERAÇÃO, PONTA A PONTA EM POSTGRESQL.
//
// O defeito (provado antes da correção, em `server/test/fiscal.test.ts` e aqui):
// `inutilizarNumeracao` chamava `checkAccess(R_INUT(), actor, 'create')` sobre um
// recurso com `ops.create = false` → **405** em TODA solicitação, de qualquer
// perfil, antes de chegar ao provedor. A rota existia e nunca funcionou; e
// `inutilizacoes_fiscais` não tinha entrada navegável (o `audit:menu` acusava
// `[RECURSO_SEM_MENU]`).
//
// Este arquivo roda num BANCO NOVO com o servidor de verdade e prova o caminho
// que o operador percorre:
//   1. solicitar a inutilização pela API (como a tela faz);
//   2. o pedido é PERSISTIDO com empresa, faixa, justificativa e autor (FK real);
//   3. o status gravado é o resultado REAL do provedor — sem provedor
//      configurado ele não homologa, e a resposta não finge que homologou;
//   4. o histórico que a tela lista devolve o registro;
//   5. as validações da SEFAZ barram antes de gravar;
//   6. operador não tem alçada (403) — a autorização é do servidor.
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
  throw new Error('fiscal-inutilizacao-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e05${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_e05_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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
    ADMIN_EMAIL: `e05-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E05-${randomUUID()}-OnlyForTest`,
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

test('ERP-05/P1-03: inutilização de numeração funciona ponta a ponta em PostgreSQL (antes: 405 sempre)', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();
  const escalar = async (sql: string, params: unknown[] = []) => (await cliente.query(sql, params)).rows[0];

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  const empresa = Number((await escalar(`SELECT id FROM empresas ORDER BY id LIMIT 1`))?.id);
  assert.equal(empresa, 1, 'o schema cria a empresa padrão sem interação manual');

  // ---- Usuários (fixture do teste): gerente que opera e operador sem alçada
  const emailGerente = `gerente-${RODADA}@example.test`;
  const emailOperador = `operador-${RODADA}@example.test`;
  const senha = `E05-${randomUUID()}!`;
  const senhaOperador = `E05-${randomUUID()}!`;
  const criarUsuario = async (nomeUsuario: string, email: string, perfil: string, senhaTexto: string) => {
    const { rows } = await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
       VALUES ($1, $2, $3, $4, true, 1, false, false, false, now()) RETURNING id`,
      [nomeUsuario, email, await hashPassword(senhaTexto), perfil],
    );
    await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, 1) ON CONFLICT DO NOTHING`, [Number(rows[0].id)]);
    return Number(rows[0].id);
  };
  const idGerente = await criarUsuario(`Gerente ${RODADA}`, emailGerente, 'gerente', senha);
  await criarUsuario(`Operador ${RODADA}`, emailOperador, 'operador', senhaOperador);

  const loginGerente = await req(baseUrl, 'POST', '/auth/login', { email: emailGerente, password: senha });
  assert.equal(loginGerente.status, 200, `login do gerente: ${loginGerente.texto}`);
  const tokenGerente = String(loginGerente.body?.token || '');
  assert.ok(tokenGerente.length > 20);

  const loginOperador = await req(baseUrl, 'POST', '/auth/login', { email: emailOperador, password: senhaOperador });
  assert.equal(loginOperador.status, 200, `login do operador: ${loginOperador.texto}`);
  const tokenOperador = String(loginOperador.body?.token || '');

  // Estado inicial: nenhuma inutilização, configuração fiscal ainda sem provedor.
  assert.equal(Number((await escalar(`SELECT count(*)::int AS n FROM inutilizacoes_fiscais`))?.n), 0, 'banco novo: nenhuma inutilização');
  assert.equal(
    String((await escalar(`SELECT provider FROM empresa_fiscal_config WHERE empresa_id = $1`, [empresa]))?.provider ?? 'nenhum'),
    'nenhum',
    'banco novo: nenhum provedor externo configurado (é esse estado que o teste exercita)',
  );

  // ---- 1) A SOLICITAÇÃO (o caminho da tela). Antes da correção: 405.
  const faixa = { modelo: '55', serie: 3, numero_inicial: 100, numero_final: 110 };
  const justificativa = 'Quebra de sequência por falha de energia no servidor';
  const solicitacao = await req(baseUrl, 'POST', '/fiscal/inutilizar', { ...faixa, justificativa }, tokenGerente);

  assert.notEqual(solicitacao.status, 405, `405 era o defeito do P1-03 (ops.create=false): ${solicitacao.texto}`);
  assert.equal(solicitacao.status, 202, `sem provedor configurado o pedido é registrado e aguarda transmissão: ${solicitacao.texto}\n${logs().slice(-3000)}`);
  assert.equal(solicitacao.body.homologado, false, 'NÃO homologa sem provedor — a resposta não finge');
  assert.equal(solicitacao.body.status, 'erro', 'o status real do provedor nulo é gravado');
  const idRegistro = Number(solicitacao.body.id);
  assert.ok(idRegistro > 0, 'o registro existe');

  // ---- 2) PERSISTÊNCIA com empresa, faixa, justificativa e AUTOR (FK real).
  const gravado = await escalar(
    `SELECT empresa_id, modelo, serie, numero_inicial, numero_final, justificativa, ambiente, status, protocolo, provider, criado_por, xml
       FROM inutilizacoes_fiscais WHERE id = $1`,
    [idRegistro],
  );
  assert.ok(gravado, 'o pedido ficou em inutilizacoes_fiscais');
  assert.equal(Number(gravado.empresa_id), empresa, 'escopado à empresa ativa');
  assert.equal(String(gravado.modelo), '55');
  assert.equal(Number(gravado.serie), 3);
  assert.equal(Number(gravado.numero_inicial), 100);
  assert.equal(Number(gravado.numero_final), 110);
  assert.equal(String(gravado.justificativa), justificativa);
  assert.equal(String(gravado.ambiente), 'homologacao', 'nasce em homologação — não emite em produção por acidente');
  assert.equal(Number(gravado.criado_por), idGerente, 'quem pediu fica gravado (FK para usuarios satisfeita)');
  assert.equal(gravado.protocolo, null, 'sem protocolo não existe homologação');

  // ---- 3) O HISTÓRICO que a tela lista devolve o registro.
  const lista = await req(baseUrl, 'GET', '/inutilizacoes_fiscais?page=1&pageSize=50&sort=id&dir=desc', undefined, tokenGerente);
  assert.equal(lista.status, 200, `lista de inutilizações: ${lista.texto}`);
  const linha = (lista.body?.rows || []).find((r: any) => Number(r.id) === idRegistro);
  assert.ok(linha, 'a tela (e a API) enxergam o pedido recém-criado');
  assert.equal(Number(linha.serie), 3);
  assert.equal(String(linha.justificativa), justificativa);

  // ---- 4) Validações da SEFAZ barram ANTES de gravar (nada novo no banco).
  const curta = await req(baseUrl, 'POST', '/fiscal/inutilizar', { ...faixa, serie: 4, justificativa: 'curta' }, tokenGerente);
  assert.equal(curta.status, 400);
  assert.match(String(curta.body?.error || ''), /15 caracteres/);

  const faixaInvalida = await req(baseUrl, 'POST', '/fiscal/inutilizar', { ...faixa, serie: 4, numero_inicial: 500, numero_final: 400 }, tokenGerente);
  assert.equal(faixaInvalida.status, 400);
  assert.match(String(faixaInvalida.body?.error || ''), /Faixa de numeração inválida/);

  assert.equal(Number((await escalar(`SELECT count(*)::int AS n FROM inutilizacoes_fiscais`))?.n), 1, 'pedido inválido não deixa registro');

  // ---- 5) Operador não tem alçada — e a recusa é do SERVIDOR, não do menu.
  const recusado = await req(baseUrl, 'POST', '/fiscal/inutilizar', { ...faixa, serie: 5 }, tokenOperador);
  assert.equal(recusado.status, 403, `operador não solicita inutilização: ${recusado.texto}`);
  assert.match(String(recusado.body?.error || ''), /gerentes e administradores/i);
  assert.equal(Number((await escalar(`SELECT count(*)::int AS n FROM inutilizacoes_fiscais`))?.n), 1, 'a recusa não grava nada');

  // ---- 6) O CHECK do banco continua sendo a última palavra (prova direta).
  await assert.rejects(
    () =>
      cliente.query(
        `INSERT INTO inutilizacoes_fiscais (empresa_id, modelo, serie, numero_inicial, numero_final, justificativa)
         VALUES ($1, '55', 6, 10, 20, 'curta')`,
        [empresa],
      ),
    (e: any) => e.code === '23514',
    'justificativa curta é recusada pelo banco, não só pela tela',
  );

  // Nenhuma operação deste teste pode ter virado erro interno do servidor.
  assert.doesNotMatch(logs(), /Erro interno do servidor/, 'nenhuma solicitação legítima pode virar 500');
});
