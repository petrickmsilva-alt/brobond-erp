import { Pool, type PoolClient, type QueryResult } from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Normaliza o sslmode da URL do Postgres.
//
// A DATABASE_URL injetada pela Render traz `sslmode=require`. O driver `pg`
// trata require/prefer/verify-ca como alias de verify-full e emite o
// SECURITY WARNING no boot:
//
//   "The SSL modes 'prefer', 'require', and 'verify-ca' are treated as
//    aliases for 'verify-full'..."
//
// Tornar `verify-full` explícito:
//   • mantém EXATAMENTE o comportamento atual (conexão com certificado e
//     host verificados — o modo mais seguro);
//   • silencia o aviso no boot;
//   • deixa a conexão imune à mudança de semântica da próxima versão do
//     pg (v9), que passará a tratar `require` como o modo fraco do libpq.
//
// Se a URL não tiver sslmode, nada é alterado e o fallback `ssl` abaixo
// continua valendo como antes.
// ---------------------------------------------------------------------------
const databaseUrl = (process.env.DATABASE_URL || '').replace(
  /sslmode=(require|prefer|verify-ca)(&|$)/,
  'sslmode=verify-full$2'
);

// Se DATABASE_URL não existir (ex.: dev local sem Postgres), o pool fica nulo
// e a API funciona em MODO DEMONSTRAÇÃO com um banco em memória (memdb.ts):
// tudo cadastra/edita/exclui normalmente, mas os dados somem ao reiniciar.
export const pool: Pool | null = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl:
        process.env.NODE_ENV === 'production' || process.env.PGSSL === 'true'
          ? { rejectUnauthorized: false }
          : undefined,
      max: Number(process.env.PG_POOL_MAX) || 10,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT) || 5000,
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT) || 30000,
    })
  : null;

// Handler global de erros do pool (evita crash do processo quando uma conexão idle é derrubada)
if (pool) {
  pool.on('error', (err) => {
    console.error('⚠️  Erro inesperado no pool do Postgres (conexão idle):', err?.message || err);
  });
}

let ready = false;

export function isDbConnected(): boolean {
  return !!pool && ready;
}

export function hasDatabaseUrl(): boolean {
  return !!pool;
}

export async function query<T extends Record<string, any> = any>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  if (!pool) throw new Error('NO_DB');
  return pool.query<T>(text, params as any[]);
}

/** Executa `fn` dentro de uma transação. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('NO_DB');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Aplica db/schema.sql (idempotente) ao iniciar. Assim um banco novo na Render
 * já sobe com todas as tabelas, e bancos antigos recebem as colunas novas.
 */
export async function migrate(): Promise<void> {
  if (!pool) return;
  const candidates = [
    path.resolve(__dirname, '../../db/schema.sql'),
    path.resolve(process.cwd(), 'db/schema.sql'),
    path.resolve(process.cwd(), '../db/schema.sql'),
  ];
  const file = candidates.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!file) {
    console.warn('⚠️  db/schema.sql não encontrado — migração automática ignorada.');
    ready = true;
    return;
  }
  const sql = readFileSync(file, 'utf8');
  await pool.query(sql);
  ready = true;
  console.log('🗄️  Schema verificado/migrado (db/schema.sql).');
}
