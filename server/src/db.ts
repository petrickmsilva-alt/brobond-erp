import { Pool, type PoolClient, type QueryResult } from 'pg';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>, isolation: 'read committed' | 'repeatable read' | 'serializable' = 'serializable'): Promise<T> {
  if (!pool) throw new Error('NO_DB');
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
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
  // Boots simultâneos (processos de teste em paralelo, várias réplicas) não
  // podem aplicar o bootstrap ao MESMO tempo: schema.sql e as migrações têm
  // blocos DO $$ (ADD CONSTRAINT) e INSERT de registro que, corridos, matam o
  // boot do perdedor à toa. Um advisory lock de sessão serializa tudo; o
  // segundo processo espera e, quando entra, encontra tudo já aplicado
  // (IF NOT EXISTS / ON CONFLICT DO NOTHING).
  const lockClient = await pool.connect();
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('brobond_schema_bootstrap'))`);
    await lockClient.query(sql);
    await aplicarMigrationsVersionadas(lockClient);
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('brobond_schema_bootstrap'))`).catch(() => undefined);
    lockClient.release();
  }
  ready = true;
  console.log('🗄️  Schema verificado/migrado (db/schema.sql + db/migrations).');
}

/** Caminhos possíveis de `db/<rel>` a partir de server/src, do build ou do repositório. */
function candidatosDb(rel: string): string[] {
  return [
    path.resolve(__dirname, '../../db', rel),
    path.resolve(process.cwd(), 'db', rel),
    path.resolve(process.cwd(), '../db', rel),
  ];
}

function existe(caminho: string): boolean {
  try {
    return statSync(caminho).isFile() || statSync(caminho).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Migrações versionadas (db/migrations/*.sql), aplicadas em ordem léxica e uma
 * única vez por banco: o nome do arquivo fica registrado em `schema_migrations`.
 *
 * É isso que faltava para uma correção de schema chegar a quem JÁ tem banco: sem
 * registro, só existia o db/schema.sql "aplique e reze", e coluna nova vinha com
 * ALTER TABLE ... IF NOT EXISTS solto no fim do arquivo. Cada arquivo roda dentro
 * da própria transação; se um falhar o boot aborta em vez de subir com o banco
 * pela metade.
 */
async function aplicarMigrationsVersionadas(client: PoolClient): Promise<void> {
  if (!pool) return;
  const dir = candidatosDb('migrations').find(existe);
  if (!dir) return;
  const nomes = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (!nomes.length) return;
  // O chamador (migrate) já segura o advisory lock de bootstrap — não há
  // corrida aqui. ON CONFLICT é apenas cinto e suspensório.
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    aplicado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const aplicadas = new Set(
    (await client.query('SELECT id FROM schema_migrations')).rows.map((r: { id: string }) => r.id)
  );
  for (const nome of nomes) {
    if (aplicadas.has(nome)) continue;
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(path.join(dir, nome), 'utf8'));
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [nome]);
      await client.query('COMMIT');
      console.log(`🗄️  Migração aplicada: ${nome}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migração ${nome} falhou — o serviço não sobe com o banco pela metade: ${(e as Error).message}`);
    }
  }
}
