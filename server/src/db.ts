import { Pool, TypeOverrides, type PoolClient, type QueryResult } from 'pg';
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

// ---------------------------------------------------------------------------
// DATE como dia civil "YYYY-MM-DD" — não como `Date` JavaScript.
//
// O driver `pg` registra, por padrão, o parser da OID 1082 (`DATE`) que converte
// a coluna em um `Date` JS (o mesmo tipo usado para TIMESTAMP/TIMESTAMPTZ). Isso
// quebra o contrato de DIA CIVIL do domínio: `String(date).slice(0, 10)` produz
// "Sat Jan 31" em vez de "2026-01-31" (representantes.desligamento, por
// exemplo), e a data passa a depender do fuso do processo — exatamente o que a
// separação DATE × TIMESTAMP existe para evitar.
//
// O modo demonstração (memdb.ts) entrega DATE como string "YYYY-MM-DD"; esta é
// a MESMA semântica no PostgreSQL. A correção fica no ponto COMPARTILHADO que
// transforma/retorna dados do banco (o pool do PgStore e de todo o serviço), e
// não em um campo isolado: TODA coluna DATE passa a voltar como a data de
// negócio textual.
//
// Alcance: só a OID 1082. TIMESTAMP (1114) e TIMESTAMPTZ (1184) seguem
// intocados (continuam `Date`, como o restante do código espera), assim como
// numéricos, booleanos, JSON, arrays, nullable e os demais tipos. O override é
// do pool da aplicação — nenhum outro cliente `pg` do processo é afetado.
// ---------------------------------------------------------------------------
const tiposPg = new TypeOverrides();
tiposPg.setTypeParser(1082, (valor: string) => valor); // DATE → "YYYY-MM-DD"

const parseEnvInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, Math.floor(parsed));
};

// Se DATABASE_URL não existir (ex.: dev local sem Postgres), o pool fica nulo
// e a API funciona em MODO DEMONSTRAÇÃO com um banco em memória (memdb.ts):
// tudo cadastra/edita/exclui normalmente, mas os dados somem ao reiniciar.
export const pool: Pool | null = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      types: tiposPg,
      ssl:
        process.env.PGSSL === 'false' || /(?:^|[?&])sslmode=disable(?:&|$)/i.test(databaseUrl)
          ? undefined
          : process.env.NODE_ENV === 'production' || process.env.PGSSL === 'true'
            ? { rejectUnauthorized: false }
            : undefined,
      max: Number(process.env.PG_POOL_MAX) || 10,
      connectionTimeoutMillis: parseEnvInt('PG_CONNECT_TIMEOUT', 10_000, 50, 120_000),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT) || 30000,
    })
  : null;

// Handler global de erros do pool (evita crash do processo quando uma conexão idle é derrubada)
if (pool) {
  pool.on('error', (err) => {
    console.error('⚠️  Erro inesperado no pool do Postgres (conexão idle):', sanitizarMensagemErro(err));
  });
}

// ---------------------------------------------------------------------------
// PROD-DB-02 / BOOT RESILIENCE — estado do boot e migração em FASES explícitas.
//
// Cada fase do boot é registrada explicitamente (nunca `fase=desconhecida`):
//
//   'conexao'    — falha ao conectar / validar SELECT 1 / obter lock após
//                  retentativas controladas (ou imediatamente se permanente);
//   'bootstrap'  — DDL estrutural (db/bootstrap.sql) não pôde ser aplicado;
//   'migrations' — a cadeia versionada (db/migrations/*.sql) falhou.
// ---------------------------------------------------------------------------
export type FaseDeBoot = 'conexao' | 'bootstrap' | 'migrations';
export type TipoFalhaConexao = 'permanente' | 'timeout';
export type BootStage = 'idle' | 'connecting' | 'migrating' | 'ready' | 'degraded';

export interface FalhaDeBoot {
  fase: FaseDeBoot;
  mensagem: string;
  tipo?: TipoFalhaConexao;
  tentativas?: number;
  duracaoMs?: number;
}

export interface DbBootState {
  configured: boolean;
  connected: boolean;
  ready: boolean;
  stage: BootStage;
  failure: FalhaDeBoot | null;
}

export interface StartupConfig {
  connectTimeoutMs: number;
  startupTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
}

export interface ClassificacaoErroConexao {
  transitorio: boolean;
  codigo: string | null;
  motivo: string;
}

export interface MigrateOptions {
  clientFactory?: () => Promise<PoolClient>;
  startupConfig?: Partial<StartupConfig>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  bootstrapFn?: (client: PoolClient) => Promise<void>;
  migrationsFn?: (client: PoolClient) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

let ready = false;
let connected = false;
let bootStage: BootStage = 'idle';
let falhaDeBoot: FalhaDeBoot | null = null;
let bootUsaPoolExterno = false;

export function lerConfigBootBanco(overrides: Partial<StartupConfig> = {}): StartupConfig {
  const connectTimeoutMs = overrides.connectTimeoutMs ?? parseEnvInt('PG_CONNECT_TIMEOUT', 10_000, 50, 120_000);
  const startupTimeoutMs = overrides.startupTimeoutMs ?? parseEnvInt('PG_STARTUP_TIMEOUT_MS', 60_000, 100, 600_000);
  const retryBaseMs = overrides.retryBaseMs ?? parseEnvInt('PG_STARTUP_RETRY_BASE_MS', 500, 10, 30_000);
  const retryMaxMs = overrides.retryMaxMs ?? parseEnvInt('PG_STARTUP_RETRY_MAX_MS', 8_000, retryBaseMs, 60_000);
  const maxAttempts = overrides.maxAttempts ?? parseEnvInt('PG_STARTUP_MAX_ATTEMPTS', 20, 1, 100);
  return { connectTimeoutMs, startupTimeoutMs, retryBaseMs, retryMaxMs, maxAttempts };
}

export function calcularBackoffMs(tentativa: number, baseMs: number, maxMs: number): number {
  const exp = Math.max(0, tentativa - 1);
  return Math.min(maxMs, Math.max(1, Math.round(baseMs * Math.pow(2, exp))));
}

function extrairDetalhesErro(err: unknown): { codigos: string[]; mensagens: string[] } {
  const codigos: string[] = [];
  const mensagens: string[] = [];
  const visitados = new Set<unknown>();

  const visitar = (atual: unknown, profundidade: number) => {
    if (!atual || profundidade > 6 || visitados.has(atual)) return;
    if (typeof atual === 'string') {
      const limpo = atual.trim();
      if (limpo) mensagens.push(limpo);
      return;
    }
    if (typeof atual !== 'object') return;
    visitados.add(atual);
    const rec = atual as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown; name?: unknown };
    if (typeof rec.code === 'string' && rec.code.trim()) codigos.push(rec.code.trim());
    if (typeof rec.message === 'string' && rec.message.trim()) mensagens.push(rec.message.trim());
    if (Array.isArray(rec.errors)) {
      for (const item of rec.errors) visitar(item, profundidade + 1);
    }
    if (rec.cause !== undefined) visitar(rec.cause, profundidade + 1);
    if (!mensagens.length && typeof rec.name === 'string' && rec.name.trim()) mensagens.push(rec.name.trim());
  };

  visitar(err, 0);
  return { codigos: [...new Set(codigos)], mensagens: [...new Set(mensagens)] };
}

export function sanitizarMensagemErro(err: unknown): string {
  const { codigos, mensagens } = extrairDetalhesErro(err);
  const bruto = mensagens.join('; ') || (codigos.length ? codigos.join(', ') : String(err || 'Erro desconhecido ao conectar ao PostgreSQL'));
  const mascarado = bruto
    .replace(/\b(postgres(?:ql)?:\/\/)([^:@\s]+):([^@\s]+)@/gi, '$1***:***@')
    .replace(/\b(postgres(?:ql)?:\/\/)([^@\s]+)@/gi, '$1***@')
    .replace(/password=[^\s&;]+/gi, 'password=***')
    .trim();
  return mascarado || 'Erro desconhecido ao conectar ao PostgreSQL';
}

const CODIGOS_PERMANENTES = new Set([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name (database does not exist)
  '3F000', // invalid_schema_name
  '42501', // insufficient_privilege
  '08P01', // protocol_violation
  'ERR_INVALID_URL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
]);

const CODIGOS_TRANSITORIOS = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up / recovery)
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNABORTED',
  'ENETDOWN',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const REGEX_PERMANENTE = /password authentication failed|role .* does not exist|database .* does not exist|no pg_hba\.conf entry|does not support ssl|invalid url|invalid connection string/i;
const REGEX_TRANSITORIO = /timeout|timed out|connection terminated|terminating connection|server closed the connection|the database system is starting up|the database system is shutting down|the database system is in recovery mode|remaining connection slots|too many clients|socket hang up|client has encountered a connection error|endpoint is (?:disabled|currently)|compute is (?:starting|waking)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE/i;

export function classificarErroConexao(err: unknown): ClassificacaoErroConexao {
  const { codigos, mensagens } = extrairDetalhesErro(err);
  const texto = mensagens.join(' | ');

  const codigoPerm = codigos.find((c) => CODIGOS_PERMANENTES.has(c));
  if (codigoPerm || REGEX_PERMANENTE.test(texto)) {
    return { transitorio: false, codigo: codigoPerm ?? codigos[0] ?? 'erro_permanente', motivo: 'erro_permanente' };
  }

  const codigoTrans = codigos.find((c) => CODIGOS_TRANSITORIOS.has(c));
  if (codigoTrans || REGEX_TRANSITORIO.test(texto)) {
    return { transitorio: true, codigo: codigoTrans ?? codigos[0] ?? 'erro_transitorio', motivo: 'erro_transitorio' };
  }

  return { transitorio: false, codigo: codigos[0] ?? 'erro_desconhecido', motivo: 'erro_nao_transitorio' };
}

function releaseClientSafe(client: PoolClient | null | undefined, destroy: boolean): void {
  if (!client) return;
  try {
    client.release(destroy);
  } catch {
    try {
      client.release();
    } catch {
      /* cliente já encerrado */
    }
  }
}

async function conectarComTimeout(connectFn: () => Promise<PoolClient>, timeoutMs: number): Promise<PoolClient> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expirou = false;
  const tentativaPromise = Promise.resolve().then(() => connectFn());

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expirou = true;
      tentativaPromise.then((lateClient) => releaseClientSafe(lateClient, true), () => undefined);
      const err = Object.assign(new Error(`Timeout de conexão com PostgreSQL após ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([tentativaPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!expirou) {
      tentativaPromise.catch(() => undefined);
    }
  }
}

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
 * Verdadeiro quando o driver conseguiu abrir sessão e validar `SELECT 1`
 * (pode estar ainda em fase de migração ou ter falhado em bootstrap/migrations).
 */
export function dbConnectionEstablished(): boolean {
  return (!!pool || bootUsaPoolExterno) && connected;
}

/** Estado completo do ciclo de inicialização do banco para `/api/health` e testes. */
export function dbBootState(): DbBootState {
  return {
    configured: !!pool || bootUsaPoolExterno,
    connected: (!!pool || bootUsaPoolExterno) && connected,
    ready: (!!pool || bootUsaPoolExterno) && ready,
    stage: bootStage,
    failure: falhaDeBoot,
  };
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
  if (/^\s*(insert|update|delete)\b/i.test(text)) {
    const { currentCronLease, fencedPoolQuery } = await import('./cronLock');
    if (currentCronLease()) return fencedPoolQuery<T>(text, params) as Promise<QueryResult<T>>;
  }
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
 * Boot do banco: conexão com retry + backoff progressivo, lock de sessão,
 * bootstrap estrutural e cadeia versionada. Idempotente: reexecutar num banco
 * pronto não altera nada.
 *
 * Nunca lança por falha de conexão/bootstrap/migration: registra a FASE e a
 * causa em `bootFailure()` e deixa `ready = false` (degradado).
 */
export async function migrate(opts: MigrateOptions = {}): Promise<void> {
  const usandoFactoryExterna = typeof opts.clientFactory === 'function';
  if (!pool && !usandoFactoryExterna) return;

  bootUsaPoolExterno = !pool && usandoFactoryExterna;
  ready = false;
  connected = false;
  bootStage = 'connecting';
  falhaDeBoot = null;

  const cfg = lerConfigBootBanco(opts.startupConfig);
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowFn = opts.now ?? (() => Date.now());
  const logger = opts.logger ?? console;
  const connectFn = opts.clientFactory ?? (() => pool!.connect());
  const bootstrapFn = opts.bootstrapFn ?? aplicarBootstrapEstrutural;
  const migrationsFn = opts.migrationsFn ?? ((c: PoolClient) => aplicarMigrationsVersionadas(c, { logger }));

  const bootStart = nowFn();
  let lockClient: PoolClient | null = null;
  let onClientError: ((err: Error) => void) | null = null;

  const limparCliente = (client: PoolClient | null, destroy: boolean) => {
    if (!client) return;
    if (onClientError) {
      const target = client as unknown as {
        off?: (e: string, fn: (err: Error) => void) => void;
        removeListener?: (e: string, fn: (err: Error) => void) => void;
      };
      if (typeof target.off === 'function') target.off('error', onClientError);
      else if (typeof target.removeListener === 'function') target.removeListener('error', onClientError);
      onClientError = null;
    }
    releaseClientSafe(client, destroy);
  };

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const attemptStart = nowFn();
    const elapsedBefore = attemptStart - bootStart;
    const remainingBefore = cfg.startupTimeoutMs - elapsedBefore;
    if (attempt > 1 && remainingBefore <= 0) {
      const duracao = nowFn() - bootStart;
      falhaDeBoot = {
        fase: 'conexao',
        tipo: 'timeout',
        tentativas: attempt - 1,
        duracaoMs: duracao,
        mensagem: `Tempo máximo de inicialização (${cfg.startupTimeoutMs}ms) esgotado após ${attempt - 1} tentativa(s).`,
      };
      bootStage = 'degraded';
      logger.error(`❌ Timeout ao conectar ao PostgreSQL após ${attempt - 1} tentativa(s) e ${duracao}ms.`);
      return;
    }

    const perAttemptTimeout = Math.max(
      50,
      Math.min(cfg.connectTimeoutMs, remainingBefore > 0 ? remainingBefore : cfg.connectTimeoutMs)
    );

    let candidate: PoolClient | null = null;
    try {
      candidate = await conectarComTimeout(connectFn, perAttemptTimeout);
      const emitter = candidate as unknown as { on?: (e: string, fn: (err: Error) => void) => void };
      if (typeof emitter.on === 'function') {
        onClientError = (clientErr: Error) => {
          logger.warn('⚠️  Erro assíncrono em cliente PostgreSQL durante o boot:', sanitizarMensagemErro(clientErr));
        };
        emitter.on('error', onClientError);
      }

      await candidate.query('SELECT 1');
      await candidate.query(`SELECT pg_advisory_lock(hashtext('brobond_schema_bootstrap'))`);

      lockClient = candidate;
      connected = true;
      bootStage = 'migrating';
      const attemptMs = nowFn() - attemptStart;
      const totalMs = nowFn() - bootStart;
      if (attempt > 1) {
        logger.log(
          `🗄️  Conexão com PostgreSQL recuperada na tentativa ${attempt}/${cfg.maxAttempts} após ${totalMs}ms (${attemptMs}ms nesta tentativa).`
        );
      } else {
        logger.log(`🗄️  PostgreSQL conectado na tentativa 1 (${attemptMs}ms).`);
      }
      break;
    } catch (err) {
      limparCliente(candidate, true);
      candidate = null;
      connected = false;

      const attemptMs = nowFn() - attemptStart;
      const elapsedMs = nowFn() - bootStart;
      const classif = classificarErroConexao(err);
      const msgSegura = sanitizarMensagemErro(err);

      if (!classif.transitorio) {
        falhaDeBoot = {
          fase: 'conexao',
          tipo: 'permanente',
          tentativas: attempt,
          duracaoMs: elapsedMs,
          mensagem: `Falha permanente ao conectar ao PostgreSQL [${classif.codigo ?? classif.motivo}]: ${msgSegura}`,
        };
        bootStage = 'degraded';
        logger.error(
          `❌ Falha permanente ao conectar ao PostgreSQL na tentativa ${attempt} [${classif.codigo ?? classif.motivo}] (${attemptMs}ms): ${msgSegura}`
        );
        return;
      }

      const remainingAfter = cfg.startupTimeoutMs - elapsedMs;
      const backoffMs = calcularBackoffMs(attempt, cfg.retryBaseMs, cfg.retryMaxMs);
      if (attempt >= cfg.maxAttempts || remainingAfter <= 50) {
        falhaDeBoot = {
          fase: 'conexao',
          tipo: 'timeout',
          tentativas: attempt,
          duracaoMs: elapsedMs,
          mensagem: `PostgreSQL indisponível após ${attempt} tentativa(s) em ${elapsedMs}ms [${classif.codigo ?? classif.motivo}]: ${msgSegura}`,
        };
        bootStage = 'degraded';
        logger.error(
          `❌ Timeout ao conectar ao PostgreSQL após ${attempt} tentativa(s) e ${elapsedMs}ms (limite ${cfg.startupTimeoutMs}ms). Último erro [${classif.codigo ?? classif.motivo}]: ${msgSegura}`
        );
        return;
      }

      const esperaMs = Math.min(backoffMs, Math.max(10, remainingAfter - 50));
      logger.warn(
        `⚠️  PostgreSQL indisponível na tentativa ${attempt}/${cfg.maxAttempts} [${classif.codigo ?? classif.motivo}] (${attemptMs}ms, decorrido ${elapsedMs}ms/${cfg.startupTimeoutMs}ms): ${msgSegura} — nova tentativa em ${esperaMs}ms.`
      );
      await sleepFn(esperaMs);
    }
  }

  if (!lockClient) {
    const elapsedMs = nowFn() - bootStart;
    falhaDeBoot = {
      fase: 'conexao',
      tipo: 'timeout',
      tentativas: cfg.maxAttempts,
      duracaoMs: elapsedMs,
      mensagem: `PostgreSQL indisponível após ${cfg.maxAttempts} tentativa(s) em ${elapsedMs}ms.`,
    };
    bootStage = 'degraded';
    return;
  }

  let erroDeBootstrap: unknown = null;
  let erroDeMigracao: unknown = null;
  try {
    try {
      await bootstrapFn(lockClient);
    } catch (e) {
      erroDeBootstrap = e;
    }
    // A cadeia versionada roda MESMO com o bootstrap tendo falhado: ela é a
    // autoridade para bancos que já existem e não pode ser bloqueada por um
    // defeito de bootstrap. (E, ao contrário, uma falha dela não é mascarada
    // por um bootstrap bem-sucedido.)
    try {
      await migrationsFn(lockClient);
    } catch (e) {
      erroDeMigracao = e;
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('brobond_schema_bootstrap'))`).catch(() => undefined);
    const dropConexao = Boolean(
      (erroDeMigracao && classificarErroConexao(erroDeMigracao).transitorio) ||
        (erroDeBootstrap && classificarErroConexao(erroDeBootstrap).transitorio)
    );
    limparCliente(lockClient, dropConexao);
  }

  // Falha da cadeia versionada é a mais grave: o schema realmente não
  // corresponde ao código. Degradado, sem tráfego de negócio.
  if (erroDeMigracao) {
    bootStage = 'degraded';
    falhaDeBoot = {
      fase: 'migrations',
      mensagem: `Migração versionada falhou: ${sanitizarMensagemErro(erroDeMigracao)}`,
    };
    logger.error(
      `❌ ${falhaDeBoot.mensagem} — a aplicação NÃO vai atender negócio até o banco estar pronto ` +
        '(corrija a causa e reinicie).'
    );
    return;
  }
  if (erroDeBootstrap) {
    bootStage = 'degraded';
    falhaDeBoot = {
      fase: 'bootstrap',
      mensagem: `db/bootstrap.sql incompleto: ${sanitizarMensagemErro(erroDeBootstrap)}`,
    };
    logger.error(
      '⚠️  db/bootstrap.sql não pôde ser aplicado por inteiro (estrutura). ' +
        'As migrações versionadas foram aplicadas mesmo assim; corrija a causa e reinicie para ' +
        `completar o bootstrap. Causa: ${sanitizarMensagemErro(erroDeBootstrap)}`
    );
    // Sem `ready = true`: isDbConnected() continua false, o /api/health responde
    // 503 e as rotas de negócio são bloqueadas (ver bloqueioDeProntidao).
    return;
  }
  ready = true;
  bootStage = 'ready';
  logger.log('🗄️  Bootstrap estrutural + migrações versionadas aplicados.');
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
export async function aplicarMigrationsVersionadas(
  client: PoolClient,
  opts: { migrationsDir?: string; logger?: Pick<Console, 'log' | 'warn' | 'error'> } = {}
): Promise<void> {
  if (!client) return;
  const logger = opts.logger ?? console;
  const dir = opts.migrationsDir ?? candidatosDb('migrations').find(existe);
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
      logger.log(`🗄️  Migração aplicada: ${nome}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migração ${nome} falhou — o serviço não sobe com o banco pela metade: ${(e as Error).message}`);
    }
  }
}
