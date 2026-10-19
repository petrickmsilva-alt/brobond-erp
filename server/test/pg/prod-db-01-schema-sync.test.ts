// ============================================================================
// PROD-DB-01 — sincronização do schema do banco de produção (PostgreSQL REAL).
//
// Sintoma em produção: /vendas responde
//   'Coluna "t.local_saida_id" não encontrada no banco. Execute db/schema.sql…'
// mesmo o código já tendo a coluna (schema.sql + migração 0031).
//
// Causa-raiz provada aqui: o `pg` roda o arquivo inteiro do db/schema.sql como
// UMA transação implícita. Um preflight de dado legado (E4.2 recusa dois locais
// com o mesmo nome na mesma empresa) lança, o lote TODO volta atrás e o
// `aplicarMigrationsVersionadas` — que vem logo depois — NUNCA era alcançado.
// Resultado: a cadeia versionada (incl. 0031) ficava parada e a coluna nova
// nunca chegava ao banco.
//
// Este teste reproduz o estado "produção atrás" e prova que, DEPOIS DA CORREÇÃO,
// as migrações versionadas são aplicadas mesmo com o bootstrap do schema.sql
// falhando — a coluna aparece e a rota /api/vendas volta a funcionar.
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
  throw new Error('pg/prod-db-01-schema-sync.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
const { migrate, query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));

type Child = ChildProcessByStdio<null, Readable, Readable>;

const evidence: string[] = [];

async function colunaExiste(tabela: string, coluna: string): Promise<boolean> {
  const r = await query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tabela, coluna]
  );
  return Number(r.rows[0].n) === 1;
}

async function migracoesAplicadasDesde(id: string): Promise<number> {
  const r = await query(`SELECT count(*)::int AS n FROM schema_migrations WHERE id >= $1`, [id]);
  return Number(r.rows[0].n);
}

async function reservarPorta(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar uma porta TCP.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function appendLog(current: string, chunk: string | Buffer): string {
  return `${current}${String(chunk)}`.slice(-40_000);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startServer(port: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `proddb01-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `PRODDB01-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: string | Buffer) => { output = appendLog(output, chunk); });
  child.stderr.on('data', (chunk: string | Buffer) => { output = appendLog(output, chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  return { child, baseUrl, logs: () => output };
}

async function esperarServidor(baseUrl: string, child: Child, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`O servidor HTTP encerrou antes do health check.\n${logs()}`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) return; // db=memory é aceito aqui: a rota responde e o erro 42703 é o que provamos.
    } catch {
      /* ainda subindo */
    }
    await delay(200);
  }
  throw new Error(`Servidor não respondeu ao health check em 60 s.\n${logs()}`);
}

async function http(baseUrl: string, method: string, route: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${route}`, init);
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
  return { status: response.status, body: parsed, text };
}

test('PROD-DB-01: /api/vendas falha sem a coluna; migrate() a cria mesmo com o bootstrap do schema.sql bloqueado por dado legado', async (t) => {
  const suffix = randomUUID().slice(0, 8);

  // -------------------------------------------------------------------------
  // 0) Estado inicial: banco já migrado, coluna presente.
  // -------------------------------------------------------------------------
  await migrate();
  assert.equal(await colunaExiste('vendas', 'local_saida_id'), true, 'pré-condição: vendas.local_saida_id deve existir após migrate()');
  evidence.push('estado inicial: vendas.local_saida_id EXISTE; migrações >= 0031 = ' + (await migracoesAplicadasDesde('0031')));

  // Usuário/empresa reais para autenticar por HTTP.
  const email = `proddb01-${suffix}@example.test`;
  const senha = `PRODDB01-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);
  const emp = await query(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`, [`PRODDB01 ${suffix}`, `PRODDB01 ${suffix}`]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now()) RETURNING id`,
    [`PRODDB01 ${suffix}`, email, senhaHash, empresaId]
  );
  const usuarioId = Number(usr.rows[0].id);

  const port = await reservarPorta();
  const { child, baseUrl, logs } = await startServer(port);
  t.after(async () => stopServer(child));

  try {
    await esperarServidor(baseUrl, child, logs);
    const login = await http(baseUrl, 'POST', '/auth/login', undefined, { email, password: senha });
    assert.equal(login.status, 200, `login HTTP: ${login.status} ${login.text.slice(0, 300)}`);
    const token = String(login.body?.token || '');
    assert.ok(token.length > 20, 'login deve emitir JWT de sessão');

    // -----------------------------------------------------------------------
    // 1) Reproduz o estado "produção atrás": coluna ausente + migrações >= 0031
    //    não registradas + dado legado que faz o preflight da E4.2 recusar o DDL.
    // -----------------------------------------------------------------------
    await query(`ALTER TABLE vendas DROP COLUMN IF EXISTS local_saida_id CASCADE`);
    await query(`DELETE FROM schema_migrations WHERE id >= '0031'`);
    // Dois locais homônimos na MESMA empresa: exatamente o que o preflight da
    // E4.2 recusa (duplicatas_locais). O índice de unicidade é removido só para
    // conseguir montar o cenário legado; é restaurado na limpeza.
    await query(`DROP INDEX IF EXISTS uq_e42_locais_empresa_nome`);
    await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, `Loja ${suffix}`]);
    await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, `Loja ${suffix}`]);
    t.after(async () => {
      await query(`DELETE FROM locais WHERE empresa_id = $1 AND nome = $2`, [empresaId, `Loja ${suffix}`]).catch(() => undefined);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_nome ON locais (empresa_id, nome)`).catch(() => undefined);
      await query(`DELETE FROM usuarios WHERE id = $1`, [usuarioId]).catch(() => undefined);
      await query(`DELETE FROM empresas WHERE id = $1`, [empresaId]).catch(() => undefined);
    });

    assert.equal(await colunaExiste('vendas', 'local_saida_id'), false, 'cenário: a coluna deve estar ausente (produção atrás)');
    evidence.push('cenário montado: local_saida_id AUSENTE; migrações >= 0031 = ' + (await migracoesAplicadasDesde('0031')) + '; locais homônimos = 2');

    // -----------------------------------------------------------------------
    // 2) A rota /api/vendas falha exatamente como em produção (42703).
    // -----------------------------------------------------------------------
    const antes = await http(baseUrl, 'GET', '/vendas', token);
    assert.equal(antes.status, 500, `GET /api/vendas sem a coluna deveria falhar 500; veio ${antes.status}`);
    assert.match(
      String(antes.body?.error || ''),
      /local_saida_id.*não encontrada|Coluna "t\.local_saida_id"/i,
      `a mensagem deve citar a coluna ausente; veio: ${antes.text.slice(0, 300)}`
    );
    evidence.push(`GET /api/vendas antes: HTTP ${antes.status} — "${String(antes.body?.error).slice(0, 90)}…"`);

    // -----------------------------------------------------------------------
    // 3) O deploy/reboot roda migrate(): mesmo com o schema.sql bloqueado pelo
    //    dado legado, as migrações versionadas (0031) PRECISAM ser aplicadas.
    // -----------------------------------------------------------------------
    await migrate(); // não deve lançar
    assert.equal(
      await colunaExiste('vendas', 'local_saida_id'),
      true,
      'migrate() deve criar vendas.local_saida_id via cadeia versionada mesmo com o schema.sql bloqueado por dado legado'
    );
    assert.ok((await migracoesAplicadasDesde('0031')) > 0, 'a cadeia versionada deve estar registrada em schema_migrations');
    evidence.push('após migrate(): local_saida_id EXISTE; migrações >= 0031 = ' + (await migracoesAplicadasDesde('0031')));

    // FK composta exigida pela 0031 (multiempresa no próprio banco).
    const fk = await query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'public.vendas'::regclass AND conname = 'fk_e421_vendas_empresa_local_saida'`
    );
    assert.equal(Number(fk.rows[0].n), 1, 'a FK composta fk_e421_vendas_empresa_local_saida deve existir após a 0031');

    // -----------------------------------------------------------------------
    // 4) A rota /api/vendas volta a responder.
    // -----------------------------------------------------------------------
    const depois = await http(baseUrl, 'GET', '/vendas', token);
    assert.equal(depois.status, 200, `GET /api/vendas após migrate() deveria ser 200; veio ${depois.status}: ${depois.text.slice(0, 300)}`);
    evidence.push(`GET /api/vendas depois: HTTP ${depois.status}`);

    // -----------------------------------------------------------------------
    // 5) Teste de venda: cria e lê de volta pelo CRUD real.
    // -----------------------------------------------------------------------
    const produto = await http(baseUrl, 'POST', '/produtos', token, {
      nome: `Produto PRODDB01 ${suffix}`,
      sku: `PRODDB01-${suffix}`,
      preco_venda: 10,
      empresa_id: empresaId,
    });
    assert.equal(produto.status, 201, `criar produto: ${produto.status} ${produto.text.slice(0, 300)}`);
    const cliente = await http(baseUrl, 'POST', '/clientes', token, {
      nome: `Cliente PRODDB01 ${suffix}`,
      empresa_id: empresaId,
    });
    assert.equal(cliente.status, 201, `criar cliente: ${cliente.status} ${cliente.text.slice(0, 300)}`);
    const venda = await http(baseUrl, 'POST', '/vendas', token, {
      cliente_id: cliente.body.id,
      data: new Date().toISOString().slice(0, 10),
      empresa_id: empresaId,
      itens: [{ produto_id: produto.body.id, quantidade: 2, preco_unitario: 10 }],
    });
    assert.equal(venda.status, 201, `criar venda: ${venda.status} ${venda.text.slice(0, 300)}`);
    const vendaId = Number(venda.body?.id);
    const lida = await http(baseUrl, 'GET', `/vendas/${vendaId}`, token);
    assert.equal(lida.status, 200, `ler venda criada: ${lida.status}`);
    assert.equal(Number(lida.body?.id), vendaId);
    evidence.push(`venda criada e lida: id=${vendaId}, HTTP ${venda.status}/${lida.status}`);

    // -----------------------------------------------------------------------
    // 6) Multiempresa: a FK composta recusa local de OUTRA empresa (cross-tenant).
    // -----------------------------------------------------------------------
    const outra = await query(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`, [`PRODDB01 OUTRA ${suffix}`, `PRODDB01 OUTRA ${suffix}`]);
    const outraEmpresa = Number(outra.rows[0].id);
    const localOutra = await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, true) RETURNING id`, [outraEmpresa, `Local OUTRA ${suffix}`]);
    const localOutraId = Number(localOutra.rows[0].id);
    t.after(async () => {
      await query(`DELETE FROM locais WHERE id = $1`, [localOutraId]).catch(() => undefined);
      await query(`DELETE FROM empresas WHERE id = $1`, [outraEmpresa]).catch(() => undefined);
    });
    await assert.rejects(
      () => query(`UPDATE vendas SET local_saida_id = $1 WHERE id = $2`, [localOutraId, vendaId]),
      (e: any) => e.code === '23503',
      'a FK composta deve recusar local_saida_id de outra empresa (23503)'
    );
    // E o local da própria empresa é aceito.
    const localProprio = await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false) RETURNING id`, [empresaId, `Local PRODDB01 ${suffix}`]);
    const localProprioId = Number(localProprio.rows[0].id);
    t.after(async () => { await query(`DELETE FROM locais WHERE id = $1`, [localProprioId]).catch(() => undefined); });
    await query(`UPDATE vendas SET local_saida_id = $1 WHERE id = $2`, [localProprioId, vendaId]);
    evidence.push('multiempresa: local de outra empresa recusado (23503); local da própria empresa aceito');

    console.log('\n=== PROD-DB-01 evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
  } finally {
    await stopServer(child);
  }
});
