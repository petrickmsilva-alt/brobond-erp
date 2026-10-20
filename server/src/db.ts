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

// ---------------------------------------------------------------------------
// PROD-DB-02 — estado do bootstrap/migração em FASES explícitas.
//
// Antes existia só `ready: boolean` + `erroDeMigracao: string`. Isso colapsava
// situações distintas ("o bootstrap estrutural falhou" vs "uma migration
// versionada falhou") num único estado, e não dava para saber em que ponto o
// boot parou. Agora cada fase é registrada:
//
//   'bootstrap'  — DDL estrutural (db/bootstrap.sql) não pôde ser aplicado;
//   'migrations' — a cadeia versionada (db/migrations/*.sql) falhou.
//
// A separação é o coração do PROD-DB-02: o bootstrap estrutural NÃO contém
// preflight que aborta (nunca é bloqueado por dado legado) e a cadeia
// versionada é a autoridade de regra de dado (E4.2 e seguintes). Uma falha da
// cadeia NUNCA pode ser confundida com sucesso do bootstrap.
// ---------------------------------------------------------------------------
export type FaseDeBoot = 'bootstrap' | 'migrations';

export interface FalhaDeBoot {
  fase: FaseDeBoot;
  mensagem: string;
}

let ready = false;
let falhaDeBoot: FalhaDeBoot | null = null;

/** Falha de boot (fase + causa). Null quando o banco está pronto ou é demo. */
export function bootFailure(): FalhaDeBoot | null {
  return falhaDeBoot;
}

/**
 * Causa da última falha de boot. Mantido para health/log; use `bootFailure()`
 * quando precisar saber em qual FASE o boot parou.
 */
export function migrationError(): string | null {
  return falhaDeBoot?.mensagem ?? null;
}

/**
 * PROD-DB-01.1 — prontidão do banco obrigatório.
 *
 * `ready` só é verdadeiro quando o banco está REALMENTE pronto para atender
 * negócio: DATABASE_URL presente E bootstrap estrutural aplicado E cadeia
 * versionada registrada. Enquanto `ready` for falso e houver DATABASE_URL, a
 * aplicação está degradada e as rotas de negócio são
 * bloqueadas (ver `bloqueioDeProntidao` em index.ts).
 */
export function isDbConnected(): boolean {
  return !!pool && ready;
}

/**
 * Falso quando DATABASE_URL existe mas o banco NÃO está pronto (migração falhou,
 * bootstrap incompleto). É o sinal canônico de degradação: nunca deixar o
 * PgStore operar nem cair silenciosamente para memória.
 */
export function isDbDegraded(): boolean {
  return !!pool && !ready;
}

/**
 * PROD-DB-01.2 — estado explícito do banco, para o /api/health distinguir três
 * situações que antes colapsavam em `db:"memory"`:
 *
 *   • 'demo'     — sem DATABASE_URL: modo demonstração (dados em memória);
 *   • 'ready'    — PostgreSQL conectado E bootstrap/migrações concluídos;
 *   • 'degraded' — DATABASE_URL configurada, mas o banco NÃO está pronto.
 *
 * O health continua respondendo 200 apenas em 'ready' (a Render só promove a
 * instância nesse estado) e 503 em 'degraded'.
 */
export type DbStatus = 'demo' | 'ready' | 'degraded';

export function dbStatus(): DbStatus {
  if (!pool) return 'demo';
  return ready ? 'ready' : 'degraded';
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

// ---------------------------------------------------------------------------
// PROD-DB-02 — ciclo de vida do boot, em FASES separadas.
//
// O boot tem quatro responsabilidades distintas, e cada uma falha de forma
// própria:
//
//   1. BOOTSTRAP ESTRUTURAL (db/bootstrap.sql)
//      Só DDL idempotente (CREATE/ALTER aditivo). Nunca é bloqueado por dado
//      legado: não contém DML nem preflight que aborta. Se falhar, é defeito de
//      estrutura (arquivo ausente, DDL inválido) — não é dado sujo.
//
//   2. CRIAÇÃO/CONTROLE DE schema_migrations
//      É criada pela própria cadeia (fase 3). É o registro transacional de cada
//      migration aplicada; é a única fonte de verdade do que já rodou.
//
//   3. MIGRAÇÕES VERSIONADAS (db/migrations/*.sql)
//      Autoridade de regra de dado (E4.2 e seguintes). Rodam em ordem LÉXICA,
//      cada uma na própria transação, registradas em schema_migrations. Um
//      preflight que recusa dado legado (ex.: 0030/E4.2) faz a cadeia parar:
//      a migration não é registrada, o banco fica DEGRADADO e nenhum DML
//      corretivo é executado.
//
//   4. READINESS / DEGRADED
//      `ready = true` exige as fases 1 e 3 concluídas. Qualquer falha registra
//      a FASE em `bootFailure()`; a aplicação sobe com o pool real, responde
//      503 no /api/health e bloqueia as rotas de negócio.
//
// A separação é o que impede a confusão central do PROD-DB-02: uma falha de
// migration versionada nunca pode ser lida como sucesso de bootstrap.
// ---------------------------------------------------------------------------

/**
 * Aplica o BOOTSTRAP ESTRUTURAL (db/bootstrap.sql), idempotente. Não executa
 * DML e não contém preflight que aborta — é o que permite a um banco de
 * produção híbrido (com dados legados) receber a estrutura-base sem ser
 * bloqueado nem corrigido automaticamente.
 */
export async function aplicarBootstrapEstrutural(client: PoolClient): Promise<void> {
  const file = candidatosDb('bootstrap.sql').find(existe);
  if (!file) {
    // Sem o arquivo, um banco novo não sobe — mas não inventamos `ready`:
    // a ausência é reportada como falha de bootstrap.
    throw new Error('db/bootstrap.sql não encontrado (estrutura-base ausente).');
  }
  await client.query(readFileSync(file, 'utf8'));
}

/**
 * Boot do banco: bootstrap estrutural + cadeia versionada, sob um advisory lock
 * de sessão. Idempotente: reexecutar num banco pronto não altera nada.
 *
 * Nunca lança por falha de dado: registra a FASE que falhou em `bootFailure()`
 * e deixa `ready = false` (degradado). Lança apenas se a conexão/lock falhar.
 */
export async function migrate(): Promise<void> {
  if (!pool) return;
  // Enquanto o boot roda, o banco não está pronto. Se algo falhar daqui pra
  // frente, `ready` fica falso e a instância segue degradada — inclusive quando
  // migrate() é chamado de novo depois de um estado pronto.
  ready = false;
  falhaDeBoot = null;

  // Boots simultâneos (processos de teste, várias réplicas) não podem aplicar a
  // estrutura ao MESMO tempo: os blocos DO $$ (ADD CONSTRAINT) e os INSERT de
  // registro, corridos, matam o boot do perdedor à toa. Um advisory lock de
  // sessão serializa tudo; o segundo processo espera e, quando entra, encontra
  // tudo já aplicado (IF NOT EXISTS / ON CONFLICT DO NOTHING).
  const lockClient = await pool.connect();
  let erroDeBootstrap: unknown = null;
  let erroDeMigracao: unknown = null;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('brobond_schema_bootstrap'))`);
    try {
      await aplicarBootstrapEstrutural(lockClient);
    } catch (e) {
      erroDeBootstrap = e;
    }
    // A cadeia versionada roda MESMO com o bootstrap tendo falhado: ela é a
    // autoridade para bancos que já existem e não pode ser bloqueada por um
    // defeito de bootstrap. (E, ao contrário, uma falha dela não é mascarada
    // por um bootstrap bem-sucedido.)
    try {
      await aplicarMigrationsVersionadas(lockClient);
    } catch (e) {
      erroDeMigracao = e;
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('brobond_schema_bootstrap'))`).catch(() => undefined);
    lockClient.release();
  }

  // Falha da cadeia versionada é a mais grave: o schema realmente não
  // corresponde ao código. Degradado, sem tráfego de negócio.
  if (erroDeMigracao) {
    falhaDeBoot = {
      fase: 'migrations',
      mensagem: `Migração versionada falhou: ${(erroDeMigracao as Error)?.message || String(erroDeMigracao)}`,
    };
    console.error(
      `❌ ${falhaDeBoot.mensagem} — a aplicação NÃO vai atender negócio até o banco estar pronto ` +
        '(corrija a causa e reinicie).'
    );
    return;
  }
  if (erroDeBootstrap) {
    falhaDeBoot = {
      fase: 'bootstrap',
      mensagem: `db/bootstrap.sql incompleto: ${(erroDeBootstrap as Error)?.message || String(erroDeBootstrap)}`,
    };
    console.error(
      '⚠️  db/bootstrap.sql não pôde ser aplicado por inteiro (estrutura). ' +
        'As migrações versionadas foram aplicadas mesmo assim; corrija a causa e reinicie para ' +
        `completar o bootstrap. Causa: ${(erroDeBootstrap as Error)?.message || erroDeBootstrap}`
    );
    // Sem `ready = true`: isDbConnected() continua false, o /api/health responde
    // 503 e as rotas de negócio são bloqueadas (ver bloqueioDeProntidao).
    return;
  }
  ready = true;
  console.log('🗄️  Bootstrap estrutural + migrações versionadas aplicados.');
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
 * Migrações versionadas (db/migrations/*.sql), aplicadas em ORDEM LÉXICA e uma
 * única vez por banco: o nome do arquivo fica registrado em `schema_migrations`.
 *
 * Garantias:
 *   • ordem lexical (`.sort()`) — determinística e igual em todo ambiente;
 *   • registro TRANSACIONAL: o INSERT em schema_migrations roda na MESMA
 *     transação do DDL/DML da migration. Ou tudo é aplicado e registrado, ou
 *     nada (ROLLBACK) — nunca uma migration "aplicada pela metade";
 *   • a migration NÃO é registrada quando falha, então o retry a reexecuta;
 *   • parada no primeiro erro: as migrations seguintes não rodam sobre um
 *     estado inconsistente, e o banco fica degradado.
 *
 * É isso que faltava para uma correção de schema chegar a quem JÁ tem banco: sem
 * registro, só existia o db/schema.sql "aplique e reze", e coluna nova vinha com
 * ALTER TABLE ... IF NOT EXISTS solto no fim do arquivo.
 */
export async function aplicarMigrationsVersionadas(client: PoolClient): Promise<void> {
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
