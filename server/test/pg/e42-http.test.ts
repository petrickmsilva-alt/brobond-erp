// E4.2 acceptance gate: real HTTP -> real JWT/session auth -> Express routes ->
// production handlers/services -> PostgreSQL. There is no injected req.user,
// direct handler call, in-memory store, external credential or remote service.
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { test } from 'node:test';
import ExcelJS from 'exceljs';

if (!process.env.DATABASE_URL) {
  throw new Error('pg-e42-http.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular o gate HTTP.');
}

process.env.NODE_ENV = 'test';
const { migrate, pool, query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));

type HttpResult = {
  status: number;
  body: any;
  bytes: Buffer;
  text: string;
  headers: Headers;
};

type Child = ChildProcessByStdio<null, Readable, Readable>;

const httpEvidence: string[] = [];
const expectedStatusEvidence: string[] = [];
const zeroWriteEvidence: string[] = [];
const postgresEvidence: string[] = [];
const localEvidence: string[] = [];
const inventoryEvidence: string[] = [];
const importEvidence: string[] = [];
const reportEvidence: string[] = [];
const integrationEvidence: string[] = [];
let gateCompleted = false;

async function appendGitHubSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  await appendFile(summaryPath, `\n${markdown}\n`, 'utf8');
}

function summaryLines(title: string, values: string[]): string {
  return `### ${title}\n${values.length ? values.map((value) => `- ${value}`).join('\n') : '- Nenhum resultado registrado.'}`;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar uma porta TCP para o harness HTTP.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

async function waitForPostgresHttp(baseUrl: string, child: Child, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`O servidor HTTP de aceite encerrou antes do health check.\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = await response.json() as { ok?: boolean; db?: string };
        if (health.ok === true && health.db === 'postgres') {
          httpEvidence.push(`GET /api/health -> HTTP ${response.status}; db=${health.db}`);
          return;
        }
      }
    } catch {
      // O servidor pode ainda estar executando bootstrap/migrations. Continua
      // aguardando, mas nunca aceita a resposta "memory" como gate PostgreSQL.
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 60 s.\n${logs()}`);
}

async function startRealServer(port: number, empresaWooId: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e42-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E42-${randomUUID()}-OnlyForTest`,
  };
  // O gate exercita somente os caminhos locais/sem conta externa. Não herda
  // credenciais eventualmente presentes no ambiente do runner.
  for (const key of Object.keys(env)) {
    if (/^(WOOCOMMERCE_(URL|CK|CS)|MERCADOLIVRE|MERCADO_PAGO|NUVEMSHOP|INSTAGRAM|META_)/i.test(key)) delete env[key];
  }
  env.WOOCOMMERCE_EMPRESA_ID = String(empresaWooId);

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: string | Buffer) => { output = appendLog(output, chunk); });
  child.stderr.on('data', (chunk: string | Buffer) => { output = appendLog(output, chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForPostgresHttp(baseUrl, child, () => output);
  } catch (error) {
    await stopServer(child);
    throw error;
  }
  return { child, baseUrl, logs: () => output };
}

async function http(baseUrl: string, method: string, route: string, token?: string, body?: unknown): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${route}`, init);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  const contentType = response.headers.get('content-type') || '';
  let parsed: any = null;
  if (contentType.includes('application/json') && text) parsed = JSON.parse(text);
  httpEvidence.push(`${method} /api${route} -> HTTP ${response.status}`);
  return { status: response.status, body: parsed, bytes, text, headers: response.headers };
}

function statusIs(response: HttpResult, expected: number, context: string): void {
  assert.equal(response.status, expected, `${context}: HTTP ${response.status}, esperado ${expected}; body=${response.text.slice(0, 1200)}`);
  expectedStatusEvidence.push(`${context}: observado ${response.status}, esperado ${expected}`);
}

async function create(baseUrl: string, route: string, token: string, body: unknown, context: string): Promise<any> {
  const response = await http(baseUrl, 'POST', route, token, body);
  statusIs(response, 201, context);
  return response.body;
}

async function switchCompany(baseUrl: string, token: string, empresaId: number): Promise<string> {
  const response = await http(baseUrl, 'POST', '/empresas/ativa', token, { empresa_id: empresaId });
  statusIs(response, 200, `trocar empresa ativa para ${empresaId}`);
  assert.equal(Number(response.body?.empresa_id), empresaId);
  assert.equal(typeof response.body?.token, 'string');
  return response.body.token as string;
}

async function snapshotE42(ids: {
  empresas: number[];
  produtos: number[];
  skus: string[];
  locais: number[];
  nomesLocais: string[];
  inventarios: number[];
  caixas: number[];
  numerosCaixa: string[];
  usuarioId: number;
}): Promise<Record<string, unknown>> {
  const aggregate = async (sql: string, params: unknown[]) => {
    const result = await query(sql, params);
    return result.rows[0]?.snapshot ?? [];
  };
  const [locais, produtos, estoques, movimentacoes, inventarios, itens, caixas, caixaMovimentos, pagamentos, auditoria] = await Promise.all([
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM locais t WHERE t.empresa_id = ANY($1::int[]) OR t.id = ANY($2::int[]) OR t.nome = ANY($3::text[])', [ids.empresas, ids.locais, ids.nomesLocais]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM produtos t WHERE t.empresa_id = ANY($1::int[]) OR t.id = ANY($2::int[]) OR t.sku = ANY($3::text[])', [ids.empresas, ids.produtos, ids.skus]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM estoques t WHERE t.empresa_id = ANY($1::int[]) OR t.produto_id = ANY($2::int[])', [ids.empresas, ids.produtos]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM movimentacoes t WHERE t.empresa_id = ANY($1::int[]) OR t.produto_id = ANY($2::int[])', [ids.empresas, ids.produtos]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM inventarios t WHERE t.empresa_id = ANY($1::int[]) OR t.id = ANY($2::int[]) OR t.local_id = ANY($3::int[])', [ids.empresas, ids.inventarios, ids.locais]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM itens_inventario t WHERE t.empresa_id = ANY($1::int[]) OR t.inventario_id = ANY($2::int[]) OR t.produto_id = ANY($3::int[])', [ids.empresas, ids.inventarios, ids.produtos]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM pdv_caixas t WHERE t.empresa_id = ANY($1::int[]) OR t.id = ANY($2::int[]) OR t.numero = ANY($3::text[])', [ids.empresas, ids.caixas, ids.numerosCaixa]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM pdv_caixa_movimentos t WHERE t.empresa_id = ANY($1::int[]) OR t.caixa_id = ANY($2::int[]) OR t.caixa_id IN (SELECT id FROM pdv_caixas WHERE numero = ANY($3::text[]))', [ids.empresas, ids.caixas, ids.numerosCaixa]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM pdv_pagamentos t WHERE t.empresa_id = ANY($1::int[]) OR t.caixa_id = ANY($2::int[]) OR t.caixa_id IN (SELECT id FROM pdv_caixas WHERE numero = ANY($3::text[]))', [ids.empresas, ids.caixas, ids.numerosCaixa]),
    aggregate('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), \'[]\'::jsonb) AS snapshot FROM auditoria t WHERE t.usuario_id = $1', [ids.usuarioId]),
  ]);
  return { locais, produtos, estoques, movimentacoes, inventarios, itens, caixas, caixaMovimentos, pagamentos, auditoria };
}

async function assertNoPartialWrite(
  ids: Parameters<typeof snapshotE42>[0],
  action: () => Promise<HttpResult>,
  expectedStatus: number,
  context: string,
  forbiddenText: string[] = [],
): Promise<void> {
  const before = await snapshotE42(ids);
  const response = await action();
  statusIs(response, expectedStatus, context);
  for (const forbidden of forbiddenText) assert.ok(!response.text.includes(forbidden), `${context}: a resposta revelou ${forbidden}`);
  const after = await snapshotE42(ids);
  assert.deepEqual(after, before, `${context}: uma tentativa rejeitada alterou estado PostgreSQL ou gerou escrita/auditoria parcial`);
  const rowCounts = Object.entries(before)
    .map(([table, rows]) => `${table}=${Array.isArray(rows) ? rows.length : 'n/a'}`)
    .join(',');
  zeroWriteEvidence.push(`${context}: HTTP ${response.status}; snapshot PostgreSQL antes==depois; linhas antes: ${rowCounts}`);
}

test('E4.2 aceite real: HTTP + autenticação + middleware + Express + serviços + PostgreSQL', async (t) => {
  t.after(async () => {
    const summary = [
      '## E4.2 — evidência do harness HTTP + PostgreSQL',
      `- Resultado do teste: **${gateCompleted ? 'PASS — matriz concluída' : 'INCOMPLETO — revisar falha do teste'}**.`,
      `- Requisições HTTP registradas: **${httpEvidence.length}**.`,
      `- Zero-write confirmados: **${zeroWriteEvidence.length}** snapshots PostgreSQL antes==depois.`,
      summaryLines('PostgreSQL/bootstrap', postgresEvidence),
      summaryLines('HTTP observado (rota/status)', httpEvidence),
      summaryLines('HTTP esperado vs observado', expectedStatusEvidence),
      summaryLines('Zero-write PostgreSQL', zeroWriteEvidence),
      summaryLines('Locais/defaults/rename', localEvidence),
      summaryLines('Inventário/saldos', inventoryEvidence),
      summaryLines('Importação', importEvidence),
      summaryLines('Relatórios/exportações', reportEvidence),
      summaryLines('WooCommerce/conectores', integrationEvidence),
    ].join('\n\n');
    await appendGitHubSummary(summary);
  });

  await migrate();
  assert.ok(pool, 'DATABASE_URL precisa criar um pool PostgreSQL real');
  const pg = await query('SELECT current_database() AS database_name, current_setting(\'server_version\') AS server_version, version() AS server_version_full');
  assert.match(String(pg.rows[0]?.server_version_full), /PostgreSQL/i, 'o gate não aceita SQLite, MemStore ou constraint simulada');
  const migrations = await query('SELECT id FROM schema_migrations ORDER BY id');
  const migrationIds = migrations.rows.map((row: any) => String(row.id));
  assert.ok(migrationIds.includes('0030_e42_locais_estoque_multempresa.sql'), 'bootstrap deve registrar a migration 0030');
  const requiredTables = ['locais', 'produtos', 'tamanhos', 'grades', 'estoques', 'movimentacoes', 'inventarios', 'itens_inventario', 'pdv_caixas', 'schema_migrations'];
  const tables = await query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\' AND table_name = ANY($1::text[]) ORDER BY table_name',
    [requiredTables],
  );
  assert.deepEqual(tables.rows.map((row: any) => String(row.table_name)), [...requiredTables].sort());
  const requiredConstraints = [
    'fk_e42_estoques_empresa_produto', 'fk_e42_estoques_empresa_local',
    'fk_e42_mov_empresa_produto', 'fk_e42_mov_empresa_local',
    'fk_e42_inventarios_empresa_local', 'fk_e42_pdv_caixas_empresa_local',
    'fk_e42_itens_inv_empresa_inventario', 'fk_e42_itens_inv_empresa_produto',
  ];
  const constraints = await query('SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname', [requiredConstraints]);
  assert.deepEqual(constraints.rows.map((row: any) => String(row.conname)), [...requiredConstraints].sort());
  const requiredIndexes = [
    'uq_e42_locais_empresa_nome', 'uq_e42_locais_padrao_empresa',
    'uq_e42_estoques_empresa_prod_tam_local_id', 'uq_e42_estoques_empresa_prod_sem_tam_local_id',
    'uq_e42_itens_inv_empresa_prod_tam', 'uq_e42_itens_inv_empresa_prod_sem_tam',
  ];
  const indexes = await query('SELECT indexname FROM pg_indexes WHERE schemaname = \'public\' AND indexname = ANY($1::text[]) ORDER BY indexname', [requiredIndexes]);
  assert.deepEqual(indexes.rows.map((row: any) => String(row.indexname)), [...requiredIndexes].sort());
  postgresEvidence.push(`PostgreSQL ${pg.rows[0]?.server_version}; banco=${pg.rows[0]?.database_name}; migrations=${migrationIds.length} [${migrationIds.join(', ')}]; tabelas verificadas=${requiredTables.join(', ')}; FKs E4.2=${constraints.rows.map((row: any) => row.conname).join(', ')}; índices únicos E4.2=${indexes.rows.map((row: any) => row.indexname).join(', ')}`);

  // O upgrade versionado e a preservação de caixas legadas são exercitados
  // pelo teste PostgreSQL complementar e42-tenant.test.ts via migrate(), o
  // runner já existente. Este arquivo concentra a matriz HTTP autenticada.
  const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 6)}`;
  const suffixCompact = suffix.replace(/[^a-z0-9]/gi, '').slice(-15);
  const empresaAResult = await query(
    'INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id',
    [`E42 HTTP A ${suffix}`, `E42 HTTP A ${suffix}`],
  );
  const empresaBResult = await query(
    'INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id',
    [`E42 HTTP B ${suffix}`, `E42 HTTP B ${suffix}`],
  );
  const empresaA = Number(empresaAResult.rows[0]?.id);
  const empresaB = Number(empresaBResult.rows[0]?.id);
  assert.ok(empresaA > 1 && empresaB > 1 && empresaA !== empresaB);
  const empresaANome = `E42 HTTP A ${suffix}`;
  const empresaBNome = `E42 HTTP B ${suffix}`;
  const email = `e42-http-${suffixCompact}@example.test`;
  const senha = `E42-http-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);
  const usuarioResult = await query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now()) RETURNING id`,
    [`Gerente E42 ${suffix}`, email, senhaHash, empresaA],
  );
  const usuarioId = Number(usuarioResult.rows[0]?.id);
  await query(
    'INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, $2), ($1, $3) ON CONFLICT (usuario_id, empresa_id) DO NOTHING',
    [usuarioId, empresaA, empresaB],
  );

  const port = await reservePort();
  const { child, baseUrl } = await startRealServer(port, empresaA);
  t.after(async () => stopServer(child));

  // Sem token: confirma que a requisição atravessa o middleware de autenticação
  // real; login abaixo emite sessão/JWT real para o usuário persistido no PG.
  statusIs(await http(baseUrl, 'GET', '/locais'), 401, 'GET protegido sem sessão');
  const login = await http(baseUrl, 'POST', '/auth/login', undefined, { email, password: senha });
  statusIs(login, 200, 'login HTTP com usuário e hash persistidos no PostgreSQL');
  assert.equal(Number(login.body?.user?.id), usuarioId);
  assert.equal(login.body?.user?.perfil, 'gerente');
  let tokenA = String(login.body?.token || '');
  assert.ok(tokenA.length > 20, 'login precisa emitir JWT de sessão');

  const empresaAtivaA = await http(baseUrl, 'GET', '/empresas/ativa', tokenA);
  statusIs(empresaAtivaA, 200, 'empresa ativa A');
  assert.equal(Number(empresaAtivaA.body?.empresa_id), empresaA);

  const tamanhoCode = `E${Date.now().toString(36).slice(-5)}${randomUUID().slice(0, 3).toUpperCase()}`.slice(0, 10);
  const tamanho = await create(baseUrl, '/tamanhos', tokenA, { codigo: tamanhoCode, descricao: 'Tamanho E4.2 HTTP', ordem: 990 }, 'criar tamanho global de teste');
  const grade = await create(baseUrl, '/grades', tokenA, { nome: `E42 HTTP Grade ${suffix}`, tamanhos: [Number(tamanho.id)] }, 'criar grade com tamanho');
  const localNome = `Loja Centro E42 ${suffix}`;
  const localA = await create(baseUrl, '/locais', tokenA, {
    nome: localNome, tipo: 'loja', ativo: true, padrao: true, empresa_id: empresaB,
  }, 'criar local A com empresa_id falsificado');
  const localAId = Number(localA.id);
  assert.equal(Number(localA.empresa_id), empresaA, 'empresa_id de criação precisa vir do ator, não do body');
  const metaA = await http(baseUrl, 'GET', '/meta', tokenA);
  statusIs(metaA, 200, 'default local A');
  assert.equal(Number(metaA.body?.defaultLocal?.id), localAId);
  assert.equal(String(metaA.body?.defaultLocal?.nome), localNome);

  const skuA = `E42A${suffixCompact}`;
  const produtoA = await create(baseUrl, '/produtos', tokenA, {
    sku: skuA, nome: `Produto HTTP A ${suffix}`, grade_id: Number(grade.id), custo: 10, preco_venda: 20, empresa_id: empresaB,
  }, 'criar produto A com empresa_id falsificado');
  const produtoAId = Number(produtoA.id);
  assert.equal(Number(produtoA.empresa_id), empresaA);
  const forgeryUpdate = await http(baseUrl, 'PUT', `/produtos/${produtoAId}`, tokenA, { empresa_id: empresaB });
  statusIs(forgeryUpdate, 200, 'tentar alterar empresa_id por PUT');
  assert.equal(Number(forgeryUpdate.body?.empresa_id), empresaA);
  const productOwner = await query('SELECT empresa_id FROM produtos WHERE id = $1', [produtoAId]);
  assert.equal(Number(productOwner.rows[0]?.empresa_id), empresaA, 'PUT não pode transferir a propriedade do produto');

  // A -> B: cria um local homônimo e mantém default independente; a mesma
  // sessão recebe JWT novo pela rota do seletor, sem req.user montado no teste.
  let tokenB = await switchCompany(baseUrl, tokenA, empresaB);
  const empresaAtivaB = await http(baseUrl, 'GET', '/empresas/ativa', tokenB);
  statusIs(empresaAtivaB, 200, 'empresa ativa B');
  assert.equal(Number(empresaAtivaB.body?.empresa_id), empresaB);
  const localB = await create(baseUrl, '/locais', tokenB, {
    nome: localNome, tipo: 'loja', ativo: true, padrao: true, empresa_id: empresaA,
  }, 'criar local homônimo B com empresa_id falsificado');
  const localBId = Number(localB.id);
  assert.notEqual(localAId, localBId);
  assert.equal(Number(localB.empresa_id), empresaB);
  const metaB = await http(baseUrl, 'GET', '/meta', tokenB);
  statusIs(metaB, 200, 'default local B');
  assert.equal(Number(metaB.body?.defaultLocal?.id), localBId);
  assert.equal(String(metaB.body?.defaultLocal?.nome), localNome);
  const homonimos = await query('SELECT id, empresa_id, nome, padrao FROM locais WHERE id = ANY($1::int[]) ORDER BY empresa_id', [[localAId, localBId]]);
  assert.equal(homonimos.rowCount, 2, 'PostgreSQL precisa aceitar nomes homônimos entre empresas');
  assert.deepEqual(homonimos.rows.map((row: any) => Number(row.empresa_id)), [empresaA, empresaB]);

  // O gerente pode renomear um local ainda sem uso. Faça isso antes de B criar
  // saldo/movimento/inventário: para local em uso a regra de produção exige
  // administrador, independentemente do tenant.
  const nomeRenomeadoB = `${localNome} RENOMEADO B`;
  const renameB = await http(baseUrl, 'PUT', `/locais/${localBId}`, tokenB, { nome: nomeRenomeadoB, empresa_id: empresaA });
  statusIs(renameB, 200, 'renomear somente o local B ainda sem uso');
  assert.equal(Number(renameB.body?.empresa_id), empresaB);
  assert.equal(String(renameB.body?.nome), nomeRenomeadoB);
  const metaBRenomeado = await http(baseUrl, 'GET', '/meta', tokenB);
  statusIs(metaBRenomeado, 200, 'default B após rename antes do uso');
  assert.equal(Number(metaBRenomeado.body?.defaultLocal?.id), localBId);
  assert.equal(String(metaBRenomeado.body?.defaultLocal?.nome), nomeRenomeadoB);
  const locaisAposRenameB = await query('SELECT id, empresa_id, nome, padrao FROM locais WHERE id = ANY($1::int[]) ORDER BY empresa_id', [[localAId, localBId]]);
  assert.deepEqual(locaisAposRenameB.rows.map((row: any) => ({ id: Number(row.id), empresa_id: Number(row.empresa_id), nome: String(row.nome), padrao: row.padrao })), [
    { id: localAId, empresa_id: empresaA, nome: localNome, padrao: true },
    { id: localBId, empresa_id: empresaB, nome: nomeRenomeadoB, padrao: true },
  ]);
  localEvidence.push(`B renomeou seu local ainda sem uso para ${nomeRenomeadoB}; PostgreSQL preservou A=${localNome}, empresa_id/default de B e defaultLocal B=${localBId}.`);

  const skuB = `E42B${suffixCompact}`;
  const produtoB = await create(baseUrl, '/produtos', tokenB, {
    sku: skuB, nome: `Produto HTTP B ${suffix}`, grade_id: Number(grade.id), custo: 15, preco_venda: 30, empresa_id: empresaA,
  }, 'criar produto B com empresa_id falsificado');
  const produtoBId = Number(produtoB.id);
  assert.equal(Number(produtoB.empresa_id), empresaB);
  inventoryEvidence.push(`Referência tamanho/grade: a grade ${Number(grade.id)} e o tamanho ${Number(tamanho.id)} são cadastros globais no schema; produtos A=${produtoAId} e B=${produtoBId} usam a mesma grade global (não há ownership tenant a falsificar).`);

  // PDV fora do gate funcional de ciclo de vida (P2), mas cobre ownership:
  // mesmo terminal pode existir em A e B, e cada caixa persiste o ID local do
  // próprio tenant enquanto o texto legado permanece armazenado.
  const caixaNumero = `E42-${Date.now()}-${process.pid}`;
  const caixaB = await create(baseUrl, '/pdv/caixas', tokenB, {
    numero: caixaNumero, valor_abertura: 0, local_id: localBId, empresa_id: empresaA,
  }, 'abrir caixa B no local B');
  const caixaBId = Number(caixaB.id);
  assert.equal(Number(caixaB.empresa_id), empresaB);
  assert.equal(Number(caixaB.local_id), localBId);
  assert.equal(String(caixaB.local), nomeRenomeadoB);

  const movimentoB = await create(baseUrl, '/movimentacoes', tokenB, {
    tipo: 'entrada', produto_id: produtoBId, tamanho_id: null, quantidade: 8, empresa_id: empresaA,
  }, 'entrada B sem tamanho e com empresa_id falsificado');
  const saldoB = await query(
    'SELECT empresa_id, produto_id, tamanho_id, local_id, quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id IS NULL AND local_id = $3',
    [empresaB, produtoBId, localBId],
  );
  assert.equal(saldoB.rowCount, 1);
  assert.equal(Number(saldoB.rows[0]?.quantidade), 8);
  assert.equal(Number(saldoB.rows[0]?.empresa_id), empresaB);
  assert.equal(Number(saldoB.rows[0]?.local_id), localBId);
  const movimentoBNoBanco = await query('SELECT empresa_id, produto_id FROM movimentacoes WHERE id = $1', [Number(movimentoB.id)]);
  assert.equal(Number(movimentoBNoBanco.rows[0]?.empresa_id), empresaB);

  const inventarioB = await create(baseUrl, '/inventarios', tokenB, {
    local_id: localBId, empresa_id: empresaA, observacoes: 'E4.2 HTTP B',
  }, 'abrir inventário B');
  const inventarioBId = Number(inventarioB.id);
  assert.equal(Number(inventarioB.empresa_id), empresaB);
  assert.equal(Number(inventarioB.local_id), localBId);
  const inventarioBItens = await http(baseUrl, 'GET', `/inventarios/${inventarioBId}/itens`, tokenB);
  statusIs(inventarioBItens, 200, 'itens do inventário B');
  assert.ok(inventarioBItens.body.some((item: any) => Number(item.produto_id) === produtoBId && item.tamanho_id == null));
  assert.ok(inventarioBItens.body.every((item: any) => Number(item.empresa_id) === empresaB));

  // A -> B -> A: renomeia A depois do rename independente de B; o default e
  // os vínculos existentes de B não podem mudar.
  tokenA = await switchCompany(baseUrl, tokenB, empresaA);
  const empresaAtivaARetorno = await http(baseUrl, 'GET', '/empresas/ativa', tokenA);
  statusIs(empresaAtivaARetorno, 200, 'retorno à empresa A');
  assert.equal(Number(empresaAtivaARetorno.body?.empresa_id), empresaA);
  const nomeRenomeadoA = `${localNome} RENOMEADO A`;
  const renameA = await http(baseUrl, 'PUT', `/locais/${localAId}`, tokenA, { nome: nomeRenomeadoA, empresa_id: empresaB });
  statusIs(renameA, 200, 'renomear somente o local A');
  assert.equal(Number(renameA.body?.empresa_id), empresaA);
  assert.equal(String(renameA.body?.nome), nomeRenomeadoA);
  const metaARenomeado = await http(baseUrl, 'GET', '/meta', tokenA);
  statusIs(metaARenomeado, 200, 'default A após rename');
  assert.equal(Number(metaARenomeado.body?.defaultLocal?.id), localAId);
  assert.equal(String(metaARenomeado.body?.defaultLocal?.nome), nomeRenomeadoA);
  const localsAfterRename = await query('SELECT id, empresa_id, nome, padrao FROM locais WHERE id = ANY($1::int[]) ORDER BY empresa_id', [[localAId, localBId]]);
  assert.deepEqual(localsAfterRename.rows.map((row: any) => ({ id: Number(row.id), empresa_id: Number(row.empresa_id), nome: String(row.nome), padrao: row.padrao })), [
    { id: localAId, empresa_id: empresaA, nome: nomeRenomeadoA, padrao: true },
    { id: localBId, empresa_id: empresaB, nome: nomeRenomeadoB, padrao: true },
  ]);
  localEvidence.push(`A/B homônimos em PostgreSQL: A local_id=${localAId}, B local_id=${localBId}; defaults A=${localAId}, B=${localBId}; rename A=${nomeRenomeadoA} preservou B=${nomeRenomeadoB}`);

  const caixaA = await create(baseUrl, '/pdv/caixas', tokenA, {
    numero: caixaNumero, valor_abertura: 0, local_id: localAId, empresa_id: empresaB,
  }, 'abrir mesmo terminal na empresa A');
  const caixaAId = Number(caixaA.id);
  assert.equal(Number(caixaA.empresa_id), empresaA);
  assert.equal(Number(caixaA.local_id), localAId);
  assert.equal(String(caixaA.local), nomeRenomeadoA);
  const caixasNoBanco = await query('SELECT id, empresa_id, local_id, local FROM pdv_caixas WHERE id = ANY($1::int[]) ORDER BY empresa_id', [[caixaAId, caixaBId]]);
  assert.deepEqual(caixasNoBanco.rows.map((row: any) => ({ id: Number(row.id), empresa_id: Number(row.empresa_id), local_id: Number(row.local_id), local: String(row.local) })), [
    { id: caixaAId, empresa_id: empresaA, local_id: localAId, local: nomeRenomeadoA },
    { id: caixaBId, empresa_id: empresaB, local_id: localBId, local: nomeRenomeadoB },
  ]);

  const produtoImportacaoA = await create(baseUrl, '/produtos', tokenA, {
    sku: `E42I${suffixCompact}`, nome: `Produto importado HTTP A ${suffix}`, grade_id: Number(grade.id), custo: 7, preco_venda: 18, empresa_id: empresaB,
  }, 'criar produto A para importação');
  const produtoImportacaoAId = Number(produtoImportacaoA.id);

  // Saldo sem tamanho e saldo com tamanho preenchido passam pela rota HTTP de
  // movimentação. A tentativa de falsificar empresa_id é ignorada nos dois.
  const entradaSemTamanho1 = await create(baseUrl, '/movimentacoes', tokenA, {
    tipo: 'entrada', produto_id: produtoAId, tamanho_id: null, quantidade: 5, empresa_id: empresaB,
  }, 'entrada A sem tamanho 1');
  await create(baseUrl, '/movimentacoes', tokenA, {
    tipo: 'entrada', produto_id: produtoAId, tamanho_id: null, quantidade: 2, empresa_id: empresaB,
  }, 'entrada A sem tamanho 2');
  await create(baseUrl, '/movimentacoes', tokenA, {
    tipo: 'entrada', produto_id: produtoAId, tamanho_id: Number(tamanho.id), quantidade: 2, empresa_id: empresaB,
  }, 'entrada A com tamanho preenchido');
  const celulasA = await query(
    'SELECT empresa_id, produto_id, tamanho_id, local_id, quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2 ORDER BY tamanho_id NULLS FIRST',
    [empresaA, produtoAId],
  );
  assert.equal(celulasA.rowCount, 2, 'PostgreSQL precisa manter uma célula NULL e outra com tamanho');
  assert.equal(celulasA.rows.filter((row: any) => row.tamanho_id === null).length, 1);
  assert.equal(Number(celulasA.rows.find((row: any) => row.tamanho_id === null)?.quantidade), 7);
  assert.equal(Number(celulasA.rows.find((row: any) => Number(row.tamanho_id) === Number(tamanho.id))?.quantidade), 2);
  assert.ok(celulasA.rows.every((row: any) => Number(row.empresa_id) === empresaA && Number(row.local_id) === localAId));
  inventoryEvidence.push(`Saldo PostgreSQL produto A=${produtoAId}: exatamente uma célula tamanho_id IS NULL quantidade=7 e uma célula tamanho_id=${Number(tamanho.id)} quantidade=2.`);

  // Importação bem-sucedida: preview e confirmação HTTP, referências resolvidas
  // na empresa ativa, empresa_id persistido e célula/tamanho conferidos no PG.
  const csv = `produto;tamanho;local;quantidade\n${String(produtoImportacaoA.sku)};${tamanhoCode};${nomeRenomeadoA};11`;
  const preview = await http(baseUrl, 'POST', '/importar/preview', tokenA, { tipo: 'estoque', nome: 'saldo-e42.csv', conteudo: csv });
  statusIs(preview, 200, 'preview HTTP da importação de saldo A');
  assert.equal(Number(preview.body?.validas), 1);
  assert.equal(preview.body?.erros?.length, 0);
  const linhaImportada = preview.body?.amostra?.[0];
  assert.equal(Number(linhaImportada?.empresa_id), empresaA);
  assert.equal(Number(linhaImportada?.produto_id), produtoImportacaoAId);
  assert.equal(Number(linhaImportada?.local_id), localAId);
  assert.equal(Number(linhaImportada?.tamanho_id), Number(tamanho.id));
  const confirmacao = await http(baseUrl, 'POST', '/importar/confirmar', tokenA, {
    tipo: 'estoque', linhas: preview.body.amostra,
  });
  statusIs(confirmacao, 200, 'confirmar importação de saldo A');
  assert.equal(Number(confirmacao.body?.importados), 1);
  assert.equal(Number(confirmacao.body?.pulados), 0);
  const importadoNoBanco = await query(
    'SELECT empresa_id, produto_id, tamanho_id, local_id, quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id = $3 AND local_id = $4',
    [empresaA, produtoImportacaoAId, Number(tamanho.id), localAId],
  );
  assert.equal(importadoNoBanco.rowCount, 1);
  assert.equal(Number(importadoNoBanco.rows[0]?.empresa_id), empresaA);
  assert.equal(Number(importadoNoBanco.rows[0]?.quantidade), 11);
  const importMovement = await query(
    "SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id = $1 AND produto_id = $2 AND tipo = 'ajuste' AND motivo = 'Importação de saldo inicial'",
    [empresaA, produtoImportacaoAId],
  );
  assert.equal(Number(importMovement.rows[0]?.n), 1, 'importação também deve persistir seu movimento no mesmo tenant');
  importEvidence.push(`HTTP preview/confirm importou 1 linha; PostgreSQL confirmou empresa_id=${Number(importadoNoBanco.rows[0]?.empresa_id)} (autenticada A=${empresaA}), produto_id=${produtoImportacaoAId}, tamanho_id=${Number(importadoNoBanco.rows[0]?.tamanho_id)}, local_id=${localAId}, quantidade=${Number(importadoNoBanco.rows[0]?.quantidade)}; rejeições estrangeiras ficam cobertas por snapshots zero-write.`);

  const inventarioA = await create(baseUrl, '/inventarios', tokenA, {
    local_id: localAId, empresa_id: empresaB, observacoes: 'E4.2 HTTP A',
  }, 'abrir inventário A');
  const inventarioAId = Number(inventarioA.id);
  assert.equal(Number(inventarioA.empresa_id), empresaA);
  assert.equal(Number(inventarioA.local_id), localAId);
  const itensInventarioA = await http(baseUrl, 'GET', `/inventarios/${inventarioAId}/itens`, tokenA);
  statusIs(itensInventarioA, 200, 'snapshot HTTP do inventário A');
  assert.ok(itensInventarioA.body.some((item: any) => Number(item.produto_id) === produtoAId && item.tamanho_id == null && Number(item.saldo_sistema) === 7));
  assert.ok(itensInventarioA.body.some((item: any) => Number(item.produto_id) === produtoAId && Number(item.tamanho_id) === Number(tamanho.id) && Number(item.saldo_sistema) === 2));
  assert.ok(itensInventarioA.body.some((item: any) => Number(item.produto_id) === produtoImportacaoAId && Number(item.tamanho_id) === Number(tamanho.id) && Number(item.saldo_sistema) === 11));
  assert.ok(itensInventarioA.body.every((item: any) => Number(item.empresa_id) === empresaA));

  const ids = {
    empresas: [empresaA, empresaB],
    produtos: [produtoAId, produtoBId, produtoImportacaoAId],
    skus: [String(produtoA.sku), String(produtoB.sku), String(produtoImportacaoA.sku)],
    locais: [localAId, localBId],
    nomesLocais: [localNome, nomeRenomeadoA, nomeRenomeadoB],
    inventarios: [inventarioAId, inventarioBId],
    caixas: [caixaAId, caixaBId],
    numerosCaixa: [caixaNumero, `${caixaNumero}-X`],
    usuarioId,
  };

  // B pode ler/escrever somente B. As rejeições incluem reads, mutações,
  // referências compostas, inventário, PDV e importação; cada tentativa compara
  // o estado real do PostgreSQL antes/depois, inclusive auditoria, para detectar
  // qualquer write parcial.
  tokenB = await switchCompany(baseUrl, tokenA, empresaB);
  const ownProdutoB = await http(baseUrl, 'GET', `/produtos/${produtoBId}`, tokenB);
  statusIs(ownProdutoB, 200, 'B lê seu produto');
  const ownCaixaB = await http(baseUrl, 'GET', `/pdv/caixas/${caixaBId}/resumo`, tokenB);
  statusIs(ownCaixaB, 200, 'B lê seu caixa');
  const caixaAbertoB = await http(baseUrl, 'GET', `/pdv/caixas/aberto?numero=${encodeURIComponent(caixaNumero)}`, tokenB);
  statusIs(caixaAbertoB, 200, 'B consulta caixa aberto');
  assert.equal(Number(caixaAbertoB.body?.caixa?.id), caixaBId);
  const filtroB = await http(baseUrl, 'GET', `/locais?f.empresa_id=${empresaA}`, tokenB);
  statusIs(filtroB, 200, 'B tenta forjar filtro de empresa A');
  assert.ok(filtroB.body.rows.every((row: any) => Number(row.empresa_id) === empresaB));
  assert.ok(filtroB.body.rows.some((row: any) => Number(row.id) === localBId));

  const noForeignText = [empresaANome, String(produtoA.sku), nomeRenomeadoA];
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/produtos/${produtoAId}`, tokenB), 404, 'B lê ID de produto A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/locais/${localAId}`, tokenB), 404, 'B lê ID de local A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/inventarios/${inventarioAId}`, tokenB), 404, 'B lê inventário A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/pdv/caixas/${caixaAId}/resumo`, tokenB), 404, 'B lê caixa PDV A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'PUT', `/produtos/${produtoAId}`, tokenB, { nome: 'tentativa estrangeira', empresa_id: empresaB }), 404, 'B altera produto A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'PUT', `/locais/${localAId}`, tokenB, { nome: 'tentativa estrangeira', empresa_id: empresaB }), 404, 'B altera local A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', '/movimentacoes', tokenB, {
    tipo: 'entrada', produto_id: produtoAId, tamanho_id: null, quantidade: 3, local_id: localBId, empresa_id: empresaB,
  }), 404, 'B referencia produto A na escrita');
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', '/movimentacoes', tokenB, {
    tipo: 'entrada', produto_id: produtoBId, tamanho_id: null, quantidade: 3, local_id: localAId, empresa_id: empresaB,
  }), 404, 'B referencia local A na escrita', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', `/inventarios/${inventarioAId}/fechar`, tokenB, {}), 404, 'B fecha inventário A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', '/pdv/caixas', tokenB, {
    numero: `${caixaNumero}-X`, valor_abertura: 0, local_id: localAId, empresa_id: empresaB,
  }), 404, 'B abre caixa em local A', noForeignText);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', '/importar/confirmar', tokenB, {
    tipo: 'estoque', linhas: [{ empresa_id: empresaA, produto_id: produtoAId, tamanho_id: null, local_id: localBId, local: nomeRenomeadoB, quantidade: 3 }],
  }), 404, 'importação B rejeita produto estrangeiro sem escrita parcial', noForeignText);

  const gradeB = await http(baseUrl, 'GET', '/estoques/grade?f.empresa_id=' + empresaA, tokenB);
  statusIs(gradeB, 200, 'grade de estoque B ignora f.empresa_id estrangeiro');
  const gradeBText = JSON.stringify(gradeB.body);
  assert.ok(gradeBText.includes(String(produtoB.sku)));
  assert.ok(!gradeBText.includes(String(produtoA.sku)));
  const relatorioB = await http(baseUrl, 'GET', '/relatorios/estoque-posicao?grupo=produto&f.empresa_id=' + empresaA, tokenB);
  statusIs(relatorioB, 200, 'relatório de estoque B ignora empresa forjada');
  assert.ok(JSON.stringify(relatorioB.body).includes(String(produtoB.sku)));
  assert.ok(!JSON.stringify(relatorioB.body).includes(String(produtoA.sku)));
  for (const format of ['csv', 'xlsx']) {
    const exportedB = await http(baseUrl, 'GET', `/estoques/export?format=${format}&f.empresa_id=${empresaA}`, tokenB);
    statusIs(exportedB, 200, `exportação de estoque B ${format}`);
    let exportTextB: string;
    if (format === 'csv') {
      exportTextB = exportedB.bytes.toString('utf8');
    } else {
      assert.match(exportedB.headers.get('content-type') || '', /spreadsheetml/);
      const workbookB = new ExcelJS.Workbook();
      await workbookB.xlsx.load(exportedB.bytes as any);
      exportTextB = JSON.stringify(workbookB.worksheets[0]?.getSheetValues());
    }
    assert.ok(exportTextB.includes(String(produtoB.sku)), `export ${format} precisa incluir B`);
    assert.ok(!exportTextB.includes(String(produtoA.sku)), `export ${format} não pode incluir A`);
  }
  const conectoresB = await http(baseUrl, 'GET', '/connectors', tokenB);
  statusIs(conectoresB, 200, 'status dos conectores oficiais sem credencial externa');
  assert.ok(Array.isArray(conectoresB.body?.connectors));

  // Volta à empresa A. Rejeita referências e IDs B, incluindo importação, e
  // comprova que os mesmos registros A continuam legíveis após A -> B -> A.
  tokenA = await switchCompany(baseUrl, tokenB, empresaA);
  const ownProdutoA = await http(baseUrl, 'GET', `/produtos/${produtoAId}`, tokenA);
  statusIs(ownProdutoA, 200, 'A lê seu produto após retornar de B');
  const ownCaixaA = await http(baseUrl, 'GET', `/pdv/caixas/${caixaAId}/resumo`, tokenA);
  statusIs(ownCaixaA, 200, 'A lê seu caixa após retornar de B');
  const caixaAbertoA = await http(baseUrl, 'GET', `/pdv/caixas/aberto?numero=${encodeURIComponent(caixaNumero)}`, tokenA);
  statusIs(caixaAbertoA, 200, 'A consulta seu caixa aberto');
  assert.equal(Number(caixaAbertoA.body?.caixa?.id), caixaAId);
  const filtroA = await http(baseUrl, 'GET', `/locais?f.empresa_id=${empresaB}`, tokenA);
  statusIs(filtroA, 200, 'A tenta forjar filtro de empresa B');
  assert.ok(filtroA.body.rows.every((row: any) => Number(row.empresa_id) === empresaA));
  assert.ok(filtroA.body.rows.some((row: any) => Number(row.id) === localAId && String(row.nome) === nomeRenomeadoA));
  const noForeignTextB = [empresaBNome, String(produtoB.sku), localNome, nomeRenomeadoB];
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/produtos/${produtoBId}`, tokenA), 404, 'A lê ID de produto B', noForeignTextB);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/locais/${localBId}`, tokenA), 404, 'A lê ID de local B', noForeignTextB);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/inventarios/${inventarioBId}`, tokenA), 404, 'A lê inventário B', noForeignTextB);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'GET', `/pdv/caixas/${caixaBId}/resumo`, tokenA), 404, 'A lê caixa PDV B', noForeignTextB);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', '/movimentacoes', tokenA, {
    tipo: 'entrada', produto_id: produtoBId, tamanho_id: null, quantidade: 3, local_id: localAId, empresa_id: empresaA,
  }), 404, 'A referencia produto B na escrita', noForeignTextB);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', '/movimentacoes', tokenA, {
    tipo: 'entrada', produto_id: produtoAId, tamanho_id: null, quantidade: 3, local_id: localBId, empresa_id: empresaA,
  }), 404, 'A referencia local B na escrita', noForeignTextB);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'PUT', `/produtos/${produtoBId}`, tokenA, { nome: 'tentativa estrangeira', empresa_id: empresaA }), 404, 'A altera produto B', noForeignTextB);
  await assertNoPartialWrite(ids, () => http(baseUrl, 'POST', '/importar/confirmar', tokenA, {
    tipo: 'estoque', linhas: [{ empresa_id: empresaB, produto_id: produtoBId, tamanho_id: null, local_id: localAId, local: nomeRenomeadoA, quantidade: 4 }],
  }), 404, 'importação A rejeita produto estrangeiro sem escrita parcial', noForeignTextB);

  const itemsUrl = `/inventarios/${inventarioAId}/itens`;
  const itemSemTamanho = itensInventarioA.body.find((item: any) => Number(item.produto_id) === produtoAId && item.tamanho_id == null);
  assert.ok(itemSemTamanho?.id, 'snapshot A precisa conter célula sem tamanho');
  const contagem = await http(baseUrl, 'PUT', itemsUrl, tokenA, { itens: [{ id: Number(itemSemTamanho.id), contado: 8 }] });
  statusIs(contagem, 200, 'contagem HTTP do inventário A');
  assert.equal(Number(contagem.body?.alterados), 1);
  const fechamento = await http(baseUrl, 'POST', `/inventarios/${inventarioAId}/fechar`, tokenA, {});
  statusIs(fechamento, 200, 'fechar inventário A');
  assert.equal(fechamento.body?.ok, true);
  assert.equal(Number(fechamento.body?.ajustes), 1);
  const saldoFinal = await query(
    'SELECT empresa_id, produto_id, tamanho_id, local_id, quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = ANY($2::int[]) ORDER BY produto_id, tamanho_id NULLS FIRST',
    [empresaA, [produtoAId, produtoImportacaoAId]],
  );
  assert.equal(saldoFinal.rows.length, 3);
  assert.equal(Number(saldoFinal.rows.find((row: any) => Number(row.produto_id) === produtoAId && row.tamanho_id === null)?.quantidade), 8);
  assert.equal(Number(saldoFinal.rows.find((row: any) => Number(row.produto_id) === produtoAId && Number(row.tamanho_id) === Number(tamanho.id))?.quantidade), 2);
  assert.equal(Number(saldoFinal.rows.find((row: any) => Number(row.produto_id) === produtoImportacaoAId)?.quantidade), 11);
  assert.ok(saldoFinal.rows.every((row: any) => Number(row.empresa_id) === empresaA && Number(row.local_id) === localAId));
  const saldoBFinal = await query('SELECT quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id IS NULL AND local_id = $3', [empresaB, produtoBId, localBId]);
  assert.equal(Number(saldoBFinal.rows[0]?.quantidade), 8, 'fechar inventário A não pode alterar saldo B');
  inventoryEvidence.push(`Inventários HTTP A=${inventarioAId}, B=${inventarioBId}; A alterado/fechado por HTTP; PG saldo A sem tamanho=${Number(saldoFinal.rows.find((row: any) => Number(row.produto_id) === produtoAId && row.tamanho_id === null)?.quantidade)}, A com tamanho=${Number(saldoFinal.rows.find((row: any) => Number(row.produto_id) === produtoAId && Number(row.tamanho_id) === Number(tamanho.id))?.quantidade)}, importado=${Number(saldoFinal.rows.find((row: any) => Number(row.produto_id) === produtoImportacaoAId)?.quantidade)}, B inalterado=${Number(saldoBFinal.rows[0]?.quantidade)}.`);

  // Relatórios e exportações reais, ainda sem permitir f.empresa_id do cliente.
  // Também verificam que nome/SKU/saldo de B não aparecem nos artefatos de A.
  const posicao = await http(baseUrl, 'GET', '/relatorios/estoque-posicao?grupo=produto&f.empresa_id=' + empresaB, tokenA);
  statusIs(posicao, 200, 'relatório JSON de posição A');
  assert.ok(JSON.stringify(posicao.body).includes(String(produtoA.sku)));
  assert.ok(JSON.stringify(posicao.body).includes(String(produtoImportacaoA.sku)));
  assert.ok(!JSON.stringify(posicao.body).includes(String(produtoB.sku)));
  const movRelatorio = await http(baseUrl, 'GET', '/relatorios/movimentacoes-periodo?f.empresa_id=' + empresaB, tokenA);
  statusIs(movRelatorio, 200, 'relatório JSON de movimentações A');
  assert.ok(JSON.stringify(movRelatorio.body).includes(String(produtoA.sku)));
  assert.ok(!JSON.stringify(movRelatorio.body).includes(String(produtoB.sku)));

  for (const format of ['csv', 'xlsx']) {
    const exported = await http(baseUrl, 'GET', `/estoques/export?format=${format}&f.empresa_id=${empresaB}`, tokenA);
    statusIs(exported, 200, `exportação de estoque A ${format}`);
    let exportText: string;
    if (format === 'csv') {
      exportText = exported.bytes.toString('utf8');
    } else {
      assert.match(exported.headers.get('content-type') || '', /spreadsheetml/);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(exported.bytes as any);
      exportText = JSON.stringify(workbook.worksheets[0]?.getSheetValues());
    }
    assert.ok(exportText.includes(String(produtoA.sku)), `export ${format} precisa incluir A`);
    assert.ok(exportText.includes(String(produtoImportacaoA.sku)), `export ${format} precisa incluir o produto importado de A`);
    assert.ok(!exportText.includes(String(produtoB.sku)), `export ${format} não pode incluir B`);
  }

  const gradeA = await http(baseUrl, 'GET', '/estoques/grade?f.empresa_id=' + empresaB, tokenA);
  statusIs(gradeA, 200, 'grade de estoque A');
  const gradeAText = JSON.stringify(gradeA.body);
  assert.ok(gradeAText.includes(String(produtoA.sku)));
  assert.ok(!gradeAText.includes(String(produtoB.sku)));
  reportEvidence.push(`Empresa B: grade, relatório JSON e exportações CSV/XLSX continham SKU B e não SKU A (filtro empresa forjado ignorado). Empresa A: relatórios JSON de posição/movimentação e exportações CSV/XLSX continham SKU A e produto importado, sem SKU B; saldos conferidos diretamente no PostgreSQL.`);

  // WooCommerce fica sem URL/CK/CS reais: GET/status e leitura local não fazem
  // chamada externa; mutations exigem credencial e B é recusada por tenant.
  const wooStatusA = await http(baseUrl, 'GET', '/marketplace/loja/status', tokenA);
  statusIs(wooStatusA, 200, 'status Woo A sem credenciais');
  assert.equal(wooStatusA.body?.configurado, false);
  const wooProductsA = await http(baseUrl, 'GET', '/marketplace/loja/produtos', tokenA);
  statusIs(wooProductsA, 200, 'diagnóstico local de produtos Woo A sem credenciais');
  assert.ok(JSON.stringify(wooProductsA.body).includes(String(produtoA.sku).toUpperCase()));
  assert.ok(!JSON.stringify(wooProductsA.body).includes(String(produtoB.sku).toUpperCase()));
  statusIs(await http(baseUrl, 'POST', '/marketplace/loja/pedidos', tokenA, {}), 409, 'importação Woo exige credenciais reais');
  statusIs(await http(baseUrl, 'POST', '/marketplace/loja/estoque', tokenA, {}), 409, 'sincronização Woo exige credenciais reais');
  const wooStatusB = await http(baseUrl, 'GET', '/marketplace/loja/status', tokenB);
  statusIs(wooStatusB, 404, 'B não pode usar integração Woo vinculada a A');
  statusIs(await http(baseUrl, 'GET', '/marketplace/loja/produtos', tokenB), 404, 'B não pode ler diagnóstico Woo de A');
  statusIs(await http(baseUrl, 'POST', '/marketplace/loja/pedidos', tokenB, {}), 404, 'B não pode importar pedidos de A');
  statusIs(await http(baseUrl, 'POST', '/marketplace/loja/estoque', tokenB, {}), 404, 'B não pode sincronizar estoque de A');
  const conectoresA = await http(baseUrl, 'GET', '/connectors', tokenA);
  statusIs(conectoresA, 200, 'status autenticado dos conectores oficiais sem credenciais');
  assert.ok(Array.isArray(conectoresA.body?.connectors));
  integrationEvidence.push('Woo A: status/diagnóstico local HTTP sem credenciais; operações POST 409. Woo B: status/diagnóstico/import/sync 404 para integração de A. /connectors: HTTP 200 autenticado; nenhuma credencial nem homologação externa usada.');

  // O PG confirma a propriedade final em ambos os tenants, o ID/texto do PDV,
  // e que o fluxo A -> B -> A não deixou estoque, inventário ou registro parcial
  // em B. Nenhuma regra de devolução/ciclo P2 é exercitada por este gate.
  const pdvFinal = await query('SELECT id, empresa_id, local_id, local FROM pdv_caixas WHERE id = ANY($1::int[]) ORDER BY empresa_id', [[caixaAId, caixaBId]]);
  assert.deepEqual(pdvFinal.rows.map((row: any) => ({ id: Number(row.id), empresa_id: Number(row.empresa_id), local_id: Number(row.local_id), local: String(row.local) })), [
    { id: caixaAId, empresa_id: empresaA, local_id: localAId, local: nomeRenomeadoA },
    { id: caixaBId, empresa_id: empresaB, local_id: localBId, local: nomeRenomeadoB },
  ]);
  const movA = await query('SELECT id, empresa_id, produto_id, tamanho_id, local_id FROM movimentacoes WHERE empresa_id = $1 AND produto_id = ANY($2::int[]) ORDER BY id', [empresaA, [produtoAId, produtoImportacaoAId]]);
  assert.ok(movA.rows.length >= 5);
  assert.ok(movA.rows.every((row: any) => Number(row.empresa_id) === empresaA && [produtoAId, produtoImportacaoAId].includes(Number(row.produto_id))));
  assert.ok(movA.rows.some((row: any) => row.tamanho_id === null));
  assert.ok(movA.rows.some((row: any) => Number(row.tamanho_id) === Number(tamanho.id)));

  // Confirma no fim que o rename B feito antes de qualquer uso persistiu após
  // os fluxos de estoque/inventário, sem alterar o nome/default de A.
  tokenB = await switchCompany(baseUrl, tokenA, empresaB);
  const localBFinal = await http(baseUrl, 'GET', `/locais/${localBId}`, tokenB);
  statusIs(localBFinal, 200, 'B consulta seu local após os fluxos');
  assert.equal(String(localBFinal.body?.nome), nomeRenomeadoB);
  const metaBFinal = await http(baseUrl, 'GET', '/meta', tokenB);
  statusIs(metaBFinal, 200, 'default B após os fluxos');
  assert.equal(Number(metaBFinal.body?.defaultLocal?.id), localBId);
  assert.equal(String(metaBFinal.body?.defaultLocal?.nome), nomeRenomeadoB);
  const locaisFinais = await query('SELECT id, empresa_id, nome, padrao FROM locais WHERE id = ANY($1::int[]) ORDER BY empresa_id', [[localAId, localBId]]);
  assert.deepEqual(locaisFinais.rows.map((row: any) => ({ id: Number(row.id), empresa_id: Number(row.empresa_id), nome: String(row.nome), padrao: row.padrao })), [
    { id: localAId, empresa_id: empresaA, nome: nomeRenomeadoA, padrao: true },
    { id: localBId, empresa_id: empresaB, nome: nomeRenomeadoB, padrao: true },
  ]);
  const defaultsFinais = await query('SELECT empresa_id, count(*)::int AS n FROM locais WHERE empresa_id = ANY($1::int[]) AND padrao IS TRUE GROUP BY empresa_id ORDER BY empresa_id', [[empresaA, empresaB]]);
  assert.deepEqual(defaultsFinais.rows.map((row: any) => ({ empresa_id: Number(row.empresa_id), n: Number(row.n) })), [
    { empresa_id: empresaA, n: 1 },
    { empresa_id: empresaB, n: 1 },
  ]);

  tokenA = await switchCompany(baseUrl, tokenB, empresaA);
  const localAAposRenameB = await http(baseUrl, 'GET', `/locais/${localAId}`, tokenA);
  statusIs(localAAposRenameB, 200, 'A verifica seu nome após rename de B');
  assert.equal(String(localAAposRenameB.body?.nome), nomeRenomeadoA);
  const metaAAposRenameB = await http(baseUrl, 'GET', '/meta', tokenA);
  statusIs(metaAAposRenameB, 200, 'default A após rename de B');
  assert.equal(Number(metaAAposRenameB.body?.defaultLocal?.id), localAId);
  assert.equal(String(metaAAposRenameB.body?.defaultLocal?.nome), nomeRenomeadoA);
  localEvidence.push(`PostgreSQL final: A local_id=${localAId}, nome=${nomeRenomeadoA}, default=true; B local_id=${localBId}, nome=${nomeRenomeadoB}, default=true. Ambos os renames foram por HTTP em locais ainda sem uso e cada default permaneceu no tenant correto durante os fluxos; há exatamente um default por empresa.`);

  gateCompleted = true;
});
