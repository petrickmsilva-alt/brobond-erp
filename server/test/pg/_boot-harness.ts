// ============================================================================
// PROD-DB-02 — harness compartilhado dos testes de ciclo de vida do boot.
//
// Cada cenário precisa de um PostgreSQL REAL em estado controlado (banco novo,
// banco parcial, bootstrap já aplicado...). O banco da suíte é único e
// compartilhado por todos os arquivos; para não interferir nele, os cenários
// PROD-DB-02 rodam em BANCOS DESCARTÁVEIS próprios e o boot é executado num
// PROCESSO FILHO isolado (o pool de src/db.ts é um singleton ligado a
// DATABASE_URL no import — não dá para reapontá-lo no processo do teste).
//
// Este arquivo NÃO é um *.test.ts: o runner (`test/pg/*.test.ts`) não o coleta.
// ============================================================================
import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const DB_DIR = fileURLToPath(new URL('../../../db', import.meta.url));
export const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');
export const BOOTSTRAP_FILE = path.join(DB_DIR, 'bootstrap.sql');

export interface BancoDescartavel {
  nome: string;
  url: string;
}

/** Deriva a URL do banco descartável a partir da DATABASE_URL base. */
export function urlDoBanco(base: string, nome: string): string {
  const u = new URL(base);
  u.pathname = `/${nome}`;
  return u.toString();
}

/** Cria um banco vazio e descartável. */
export async function criarBancoDescartavel(prefixo: string): Promise<BancoDescartavel> {
  const nome = `pdb02_${prefixo}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);
  const admin = new Client({ connectionString: process.env.DATABASE_URL! });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${nome}`);
  await admin.end();
  return { nome, url: urlDoBanco(process.env.DATABASE_URL!, nome) };
}

/** Remove o banco descartável. */
export async function destruirBancoDescartavel(banco: BancoDescartavel): Promise<void> {
  const admin = new Client({ connectionString: process.env.DATABASE_URL! });
  await admin.connect().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${banco.nome} WITH (FORCE)`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}

/** Abre um cliente direto no banco descartável (para inspeção/DDL de setup). */
export async function conectar(banco: BancoDescartavel): Promise<Client> {
  const c = new Client({ connectionString: banco.url });
  await c.connect();
  return c;
}

export interface EstadoDoBoot {
  status: 'demo' | 'ready' | 'degraded';
  degraded: boolean;
  falha: { fase: 'bootstrap' | 'migrations'; mensagem: string } | null;
  erro: string | null;
}

export interface ResultadoBoot {
  code: number;
  estado: EstadoDoBoot | null;
  stdout: string;
  stderr: string;
}

const SCRIPT_BOOT = `
const m = await import('./src/db.ts');
await m.migrate();
console.log('__BOOT__' + JSON.stringify({
  status: m.dbStatus(), degraded: m.isDbDegraded(), falha: m.bootFailure(), erro: m.migrationError(),
}));
await m.pool?.end().catch(() => undefined);
`;

/** Executa o boot REAL (migrate()) num processo filho isolado apontado ao banco. */
export function rodarBoot(banco: BancoDescartavel, extraEnv: NodeJS.ProcessEnv = {}): Promise<ResultadoBoot> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SCRIPT_BOOT], {
      cwd: SERVER_DIR,
      env: { ...process.env, NODE_ENV: 'test', PG_IDLE_TIMEOUT: '200', ...extraEnv, DATABASE_URL: banco.url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => resolve({ code: -1, estado: null, stdout, stderr: `${stderr}\n${e.message}` }));
    child.on('close', (code) => {
      const linha = stdout.split('\n').find((l) => l.startsWith('__BOOT__'));
      let estado: EstadoDoBoot | null = null;
      if (linha) {
        try { estado = JSON.parse(linha.slice('__BOOT__'.length)); } catch { estado = null; }
      }
      resolve({ code: code ?? -1, estado, stdout, stderr });
    });
  });
}

/** Aplica um arquivo SQL (sem transação explícita) no banco descartável. */
export async function aplicarArquivo(cliente: Client, sql: string): Promise<void> {
  await cliente.query(sql);
}

/** Aplica as migrations versionadas em ordem lexical, até `ate` (inclusive) ou todas. */
export async function aplicarCadeia(cliente: Client, ate?: string): Promise<string[]> {
  const { readFileSync, readdirSync } = await import('node:fs');
  const nomes = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const aplicados: string[] = [];
  await cliente.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  for (const nome of nomes) {
    if (ate && nome > ate) break;
    await cliente.query('BEGIN');
    await cliente.query(readFileSync(path.join(MIGRATIONS_DIR, nome), 'utf8'));
    await cliente.query(`INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [nome]);
    await cliente.query('COMMIT');
    aplicados.push(nome);
  }
  return aplicados;
}

/** Nomes das migrations versionadas, em ordem lexical (= ordem de execução). */
export async function nomesDasMigrations(): Promise<string[]> {
  const { readdirSync } = await import('node:fs');
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** Inventário estrutural do banco (tabelas, colunas, índices e constraints). */
export async function inventario(cliente: Client): Promise<string[]> {
  const { rows } = await cliente.query(`
    SELECT 'table' AS kind, table_name AS obj FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
    UNION ALL
    SELECT 'column', table_name||'.'||column_name FROM information_schema.columns WHERE table_schema='public'
    UNION ALL
    SELECT 'index', indexname FROM pg_indexes WHERE schemaname='public'
    UNION ALL
    SELECT 'constraint', conrelid::regclass::text||'::'||conname FROM pg_constraint
      WHERE connamespace='public'::regnamespace
    ORDER BY 1,2`);
  return rows.map((r: { kind: string; obj: string }) => `${r.kind}:${r.obj}`);
}

export async function migrationsRegistradas(cliente: Client): Promise<string[]> {
  const { rows } = await cliente.query(`SELECT id FROM schema_migrations ORDER BY id`);
  return rows.map((r: { id: string }) => String(r.id));
}

export async function existeTabela(cliente: Client, tabela: string): Promise<boolean> {
  const { rows } = await cliente.query(`SELECT to_regclass($1) AS t`, [`public.${tabela}`]);
  return rows[0].t !== null;
}

export async function existeColuna(cliente: Client, tabela: string, coluna: string): Promise<boolean> {
  const { rows } = await cliente.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [tabela, coluna]
  );
  return Number(rows[0].n) === 1;
}
