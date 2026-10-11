// ============================================================================
// ERP-03 — ONBOARDING SEM SQL MANUAL (fecha o P0-04, lado do banco novo).
//
// A evidência que abriu o ciclo: `smoke 126/126` em memória × `92/117` num
// PostgreSQL recém-migrado, com 25 falhas `409 A empresa ativa não possui um
// local de estoque ativo`. O modo demonstração tem `locais.mock`
// (loja/expedicao/faccao); o PostgreSQL tem ZERO locais numa instalação nova —
// então receber compra, faturar venda, movimentar estoque e abrir OP davam 409
// até alguém rodar INSERT na mão.
//
// Este arquivo cria um BANCO NOVO do zero (sem nenhuma semeadura), sobe o
// servidor de verdade sobre ele e prova a regra de provisionamento:
//
//   empresa sem NENHUM local  → a primeira operação de estoque cria o Local
//                               padrão "Loja" (ativo) e segue o fluxo;
//   empresa COM locais        → nada é criado; se nenhum estiver ativo, a
//                               resposta continua sendo o 409 explicativo
//                               (a decisão de não ter local ativo é do admin).
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
  throw new Error('e03-onboarding-local-padrao.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e03${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Banco NOVO, criado por este teste — a instalação limpa que o ciclo exige. */
function nomeDoBancoNovo(): string {
  return `brobond_e03_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRealServer(port: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl, // banco novo, VIRGEM
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e03-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E03-${randomUUID()}-OnlyForTest`,
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
        const h = await r.json() as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch {
      // schema/migrations do banco novo em andamento
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

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (corpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

test('ERP-03: banco novo provisiona o Local padrão na primeira operação (sem SQL manual)', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  // O teste fala com o banco NOVO por conta própria (é onde estão as provas).
  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();
  const contar = async (sql: string, params: unknown[] = []) => Number((await cliente.query(sql, params)).rows[0].count);
  const locais = async () => (await cliente.query(`SELECT id, nome, ativo, padrao, empresa_id FROM locais ORDER BY id`)).rows as any[];

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    // WITH (FORCE) derruba conexões remanescentes do servidor recém-parado.
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  const empresa = Number((await cliente.query(`SELECT id FROM empresas ORDER BY id LIMIT 1`)).rows[0]?.id);
  assert.equal(empresa, 1, 'o schema cria a empresa padrão (BROBOND id 1) sem interação manual');
  assert.equal(await contar(`SELECT count(*) FROM locais`), 0, 'banco novo: nenhum local (os locais de exemplo só existem no modo demonstração)');

  // Usuário por SQL (fixture do teste, não do produto): o login de `perfil:
  // 'admin'` exige MFA cadastrado — o que exigiria o fluxo TOTP inteiro (o
  // smoke cobre esse caminho). Aqui o foco é o provisionamento do local, e o
  // gerente tem permissão para os cadastros e as movimentações deste teste.
  const email = `${RODADA}@example.test`;
  const senha = `E03-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, 1, false, false, false, now())`,
    [`Admin ${RODADA}`, email, await hashPassword(senha)],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email]);

  const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(login.status, 200, `login precisa funcionar num banco novo: ${login.texto}`);
  const token = String(login.body?.token || '');
  assert.ok(token.length > 20, 'login precisa emitir JWT');

  // Cadastros mínimos pela API (produto e tamanho), ainda SEM nenhum local.
  const produto = await req(baseUrl, 'POST', '/produtos', { sku: `E03-${RODADA}`.toUpperCase(), nome: `Produto ${RODADA}`, preco_venda: 50, custo: 20 }, token);
  assert.equal(produto.status, 201, `produto: ${produto.texto}`);
  const tamanho = await req(baseUrl, 'POST', '/tamanhos', { codigo: RODADA.slice(-5).toUpperCase(), descricao: 'E03', ordem: 950 }, token);
  assert.ok([200, 201].includes(tamanho.status), `tamanho: ${tamanho.texto}`);
  assert.equal(await contar(`SELECT count(*) FROM locais`), 0, 'cadastrar produto/tamanho não cria local nenhum');

  // ---- A PRIMEIRA OPERAÇÃO DE ESTOQUE: aqui estava o 409 do banco novo ----
  const entrada = await req(
    baseUrl,
    'POST',
    '/movimentacoes',
    { tipo: 'entrada', produto_id: Number(produto.body.id), tamanho_id: Number(tamanho.body.id), quantidade: 5, motivo: 'Saldo inicial E03' },
    token,
  );
  assert.ok([200, 201].includes(entrada.status), `a primeira movimentação precisa funcionar sem local cadastrado: ${entrada.texto}\n--- log do servidor ---\n${logs().slice(-4000)}`);
  assert.equal(String(entrada.body?.local || ''), 'Loja', `a movimentação precisa apontar o local provisionado: ${entrada.texto}`);

  const criados = await locais();
  assert.equal(criados.length, 1, 'exatamente UM local foi provisionado');
  assert.equal(String(criados[0].nome), 'Loja');
  assert.equal(criados[0].ativo, true);
  assert.equal(criados[0].padrao, true);
  assert.equal(Number(criados[0].empresa_id), empresa);
  assert.equal(Number(entrada.body.local_id), Number(criados[0].id), 'a movimentação usa o ID canônico do local provisionado');
  assert.equal(await contar(`SELECT count(*) FROM estoques WHERE produto_id = $1`, [Number(produto.body.id)]), 1, 'o saldo ficou gravado no local provisionado');

  // Trilha de auditoria: provisionar é um ato do sistema, registrado.
  assert.equal(
    await contar(`SELECT count(*) FROM auditoria WHERE recurso = 'locais' AND usuario = 'sistema' AND dados->>'provisionado' = 'true'`),
    1,
    'o provisionamento fica na trilha de auditoria',
  );

  // Idempotência: a segunda operação reusa o local.
  const saida = await req(
    baseUrl,
    'POST',
    '/movimentacoes',
    { tipo: 'saida', produto_id: Number(produto.body.id), tamanho_id: Number(tamanho.body.id), quantidade: 2, motivo: 'Saída E03' },
    token,
  );
  assert.ok([200, 201].includes(saida.status), `segunda movimentação: ${saida.texto}`);
  assert.equal((await locais()).length, 1, 'nenhum local novo na segunda operação');

  // ---- A regra NÃO sequestra a decisão do administrador -------------------
  // A desativação é FIXTURE (SQL direto): desativar o último local ativo é
  // decisão do administrador, e o login de admin exige MFA (fora do escopo
  // deste teste). O que se prova aqui é a reação do provisionamento a isso.
  await cliente.query(`UPDATE locais SET ativo = false WHERE id = $1`, [Number(criados[0].id)]);

  const bloqueado = await req(
    baseUrl,
    'POST',
    '/movimentacoes',
    { tipo: 'entrada', produto_id: Number(produto.body.id), tamanho_id: Number(tamanho.body.id), quantidade: 1, motivo: 'Deve falhar' },
    token,
  );
  assert.equal(bloqueado.status, 409, `com local inativo a resposta é o 409 explicativo: ${bloqueado.status} ${bloqueado.texto}`);
  assert.match(String(bloqueado.body?.error || ''), /local/i, 'a mensagem diz o que falta (local ativo)');
  assert.doesNotMatch(String(bloqueado.body?.error || ''), /SQLSTATE|constraint|estoques_|viola/i, 'e não vaza detalhe de banco');
  assert.equal((await locais()).length, 1, 'empresa COM local (inativo) não ganha outro: a decisão do admin é respeitada');

  // O servidor não pode ter registrado erro interno em nenhum momento.
  assert.doesNotMatch(logs(), /Erro interno do servidor/, 'nenhuma operação deste teste pode virar erro interno');
});
