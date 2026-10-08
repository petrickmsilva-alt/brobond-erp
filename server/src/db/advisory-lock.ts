// ============================================================================
// Advisory lock do Postgres — serializa as migrações concorrentes do boot.
//
// O PROBLEMA
// ----------
// A Render sobe mais de uma réplica, o `tsx watch` reinicia em cima do processo
// anterior, e os testes rodam em paralelo: vários processos chamam `migrate()`
// ao mesmo tempo. `db/schema.sql` e `db/migrations/*.sql` têm blocos
// `DO $$ ... ADD CONSTRAINT ... $$` e `INSERT` de registro que, corridos dois a
// dois, fazem o boot do perdedor morrer com "constraint já existe" — e, no pior
// caso, deixam o schema pela metade.
//
// A SOLUÇÃO
// ---------
// Um advisory lock do Postgres com chave fixa. Ele é um mutex mantido pelo
// próprio servidor: quem pega, roda a migração; quem não pega, ESPERA. Quando o
// primeiro solta, o segundo entra e encontra tudo já aplicado (o SQL do boot é
// idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING).
//
// A chave é um número, não um nome: `727272` está em
// `ADVISORY_LOCK_KEYS.SCHEMA_MIGRATION` para que TODO o código aponte para o
// mesmo lugar e ninguém invente uma segunda chave por engano (duas chaves
// diferentes = dois locks que não se excluem = bug silencioso).
//
// POR QUE `pg_try_advisory_lock` EM LOOP E NÃO `pg_advisory_lock` DIRETO?
// ----------------------------------------------------------------------
// `pg_advisory_lock` bloqueia para sempre. Se o processo que segura o lock
// travar, todo boot seguinte fica pendurado e a Render mata o serviço por
// timeout sem deixar diagnóstico nenhum. `lock_timeout` NÃO ajuda aqui: o
// Postgres ignora esse parâmetro para advisory locks. Por isso o helper tenta
// com `pg_try_advisory_lock` num loop com prazo — ao estourar o prazo ele lança
// `AdvisoryLockTimeoutError` com o PID de quem está segurando o lock, que é a
// informação que faltava para resolver o incidente.
//
// ⚠️  CONTRATO: MESMA CONEXÃO
// ---------------------------
// Advisory lock é de SESSÃO. `pg_advisory_lock` e `pg_advisory_unlock` precisam
// rodar na MESMA conexão, senão o unlock acontece em outro backend e o lock fica
// preso até aquela sessão morrer. Por isso `withAdvisoryLock` recebe algo cujo
// `$queryRaw` sempre atinge uma única conexão:
//
//   • o `tx` de um `prisma.$transaction(async (tx) => ...)` — a transação
//     interativa prende uma conexão só, então `tx.$queryRaw` é seguro; ou
//   • um `PoolClient` do `pg` já "checado" — use `pgClientAsQueryable`.
//
// NUNCA passe o `PrismaClient`/`Pool` cru: cada `$queryRaw` pode cair numa
// conexão diferente do pool e o lock vaza.
// ============================================================================
import type { Pool, PoolClient } from 'pg';

/**
 * Chaves de advisory lock do sistema. Uma por recurso protegido.
 *
 * O valor é arbitrário, mas é CONTRATUAL: mudar o número de
 * `SCHEMA_MIGRATION` faz com que réplicas rodando versões diferentes do código
 * usem chaves distintas e parem de se excluir durante um deploy. Se um dia
 * precisar trocar, troque sabendo disso.
 */
export const ADVISORY_LOCK_KEYS = {
  /** Serializa `migrate()` no boot (schema.sql + db/migrations). */
  SCHEMA_MIGRATION: 727272,
} as const;

export type AdvisoryLockKey = (typeof ADVISORY_LOCK_KEYS)[keyof typeof ADVISORY_LOCK_KEYS];

/**
 * Porta estreita sobre o que este módulo precisa do Prisma: só `$queryRaw`.
 *
 * É estrutural de propósito (como `PrismaOrderTransactionClient` em
 * packages/infra): o servidor não carrega o `@prisma/client` em runtime — ele
 * fala SQL pelo pool `pg` (server/src/db.ts). Uma porta estrutural aceita os
 * dois mundos e mantém o helper testável sem banco nenhum.
 *
 * Um `PrismaClient` real e o `tx` de `$transaction` satisfazem esta assinatura.
 */
export interface PrismaQueryable {
  /**
   * CONTRACTO DE RETORNO: resolve com o ARRAY DE LINHAS.
   *
   * É o que o `$queryRaw` do Prisma faz. O `pg` NÃO faz isso — `client.query`
   * resolve com um `QueryResult` (`{ rows, rowCount, … }`). Quem adaptar um
   * cliente `pg` para esta porta PRECISA desempacotar `.rows` (é o que
   * `pgClientAsQueryable` faz). Se não desempacotar, `lockAdquirido` lê um
   * objeto em vez de um array, conclui "lock não adquirido" e o boot fica
   * girando até o timeout — falha silenciosa, exatamente a que este módulo
   * existe para evitar.
   */
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** Estourou o prazo esperando o lock: melhor abortar o boot do que pendurar. */
export class AdvisoryLockTimeoutError extends Error {
  constructor(
    readonly key: number,
    readonly timeoutMs: number,
    readonly detentor: string | null
  ) {
    super(
      `Advisory lock ${key} não liberado em ${timeoutMs} ms` +
        (detentor ? ` — quem segura é a sessão/PID ${detentor}` : '') +
        '. Uma migração anterior travou ou ainda está rodando.'
    );
    this.name = 'AdvisoryLockTimeoutError';
  }
}

export interface WithAdvisoryLockOptions {
  /** Chave do lock. Padrão: SCHEMA_MIGRATION (727272). */
  key?: number;
  /** Quanto esperar pelo lock antes de desistir. Padrão: 120 s. */
  timeoutMs?: number;
  /** Intervalo entre tentativas. Padrão: 100 ms. */
  pollIntervalMs?: number;
  /** Rótulo para o log (aparece no console do boot). */
  label?: string;
  /** Injeção de relógio — só os testes usam. */
  now?: () => number;
  /** Injeção de espera — só os testes usam. */
  sleep?: (ms: number) => Promise<void>;
  /** Injeção de log — só os testes usam. */
  log?: (mensagem: string) => void;
}

const dormirPadrao = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    // Não segura o event loop aberto só por causa da espera do lock.
    (t as { unref?: () => void }).unref?.();
  });

/**
 * Extrai as linhas de um resultado, tolerando os dois formatos do ecossistema:
 * o array do Prisma e o `QueryResult` do `pg`.
 *
 * É cinto e suspensórios em cima do contrato de `PrismaQueryable`: se alguém
 * plugar um adaptador que esqueceu de desempacotar `.rows`, o lock continua
 * funcionando em vez de o boot travar sem explicação.
 */
function linhasDe(resultado: unknown): unknown[] {
  if (Array.isArray(resultado)) return resultado;
  if (resultado && typeof resultado === 'object' && Array.isArray((resultado as { rows?: unknown }).rows)) {
    return (resultado as { rows: unknown[] }).rows;
  }
  return [];
}

/**
 * Normaliza o retorno de `pg_try_advisory_lock`.
 *
 * O Postgres devolve boolean, mas o valor chega diferente conforme o driver:
 * `pg` entrega `true`/`false`, alguns proxies entregam `'t'`/`'f'` e quem faz
 * `::int` recebe `1`/`0`. Interpretar os quatro formatos evita que um "lock não
 * adquirido" seja lido como adquirido por um `'f'` truthy.
 */
function lockAdquirido(resultado: unknown): boolean {
  const linha = linhasDe(resultado)[0] as Record<string, unknown> | undefined;
  if (!linha || typeof linha !== 'object') return false;
  const valor = Object.values(linha)[0];
  return valor === true || valor === 1 || valor === '1' || valor === 't';
}

/**
 * Descobre quem está segurando o lock, para a mensagem de timeout ser útil.
 * Falha de diagnóstico nunca pode derrubar o caminho de erro — por isso o
 * try/catch que engole tudo.
 */
async function detentorDoLock(db: PrismaQueryable, key: number): Promise<string | null> {
  try {
    const linhas = (await db.$queryRaw`
      SELECT a.pid::text AS pid
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory'
         AND l.classid = 0
         AND l.objid = ${key}
       LIMIT 1`);
    const linha = linhasDe(linhas)[0] as { pid?: string } | undefined;
    return linha?.pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Executa `work` segurando o advisory lock `key`.
 *
 * O lock é SEMPRE liberado, inclusive se `work` lançar — e o erro original é
 * propagado sem ser mascarado pelo unlock.
 *
 * Advisory locks são reentrantes por sessão: chamadas aninhadas na mesma
 * conexão adquirem e liberam em pares, então o aninhamento funciona.
 */
export async function withAdvisoryLock<T>(
  db: PrismaQueryable,
  work: (db: PrismaQueryable) => Promise<T>,
  options: WithAdvisoryLockOptions = {}
): Promise<T> {
  const key = options.key ?? ADVISORY_LOCK_KEYS.SCHEMA_MIGRATION;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const label = options.label ?? 'migrations';
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? dormirPadrao;
  const log = options.log ?? (() => undefined);

  if (!Number.isInteger(key)) throw new TypeError(`chave de advisory lock precisa ser inteira (veio: ${String(key)})`);
  if (timeoutMs < 0) throw new TypeError(`timeoutMs não pode ser negativo (veio: ${timeoutMs})`);
  if (pollIntervalMs <= 0) throw new TypeError(`pollIntervalMs precisa ser > 0 (veio: ${pollIntervalMs})`);

  const inicio = now();
  let aguardando = false;

  // --- aquisição -----------------------------------------------------------
  for (;;) {
    const resultado = await db.$queryRaw`SELECT pg_try_advisory_lock(${key}::bigint) AS adquirido`;
    if (lockAdquirido(resultado)) break;

    if (!aguardando) {
      aguardando = true;
      log(`⏳ ${label}: aguardando o advisory lock ${key} (outra migração em andamento)…`);
    }
    if (now() - inicio >= timeoutMs) {
      throw new AdvisoryLockTimeoutError(key, timeoutMs, await detentorDoLock(db, key));
    }
    await sleep(pollIntervalMs);
  }

  if (aguardando) {
    log(`🔓 ${label}: advisory lock ${key} adquirido após ${now() - inicio} ms de espera.`);
  }

  // --- seção crítica -------------------------------------------------------
  try {
    return await work(db);
  } finally {
    // Libera sempre. Se o unlock falhar (conexão caiu), o log avisa mas não
    // esconde o erro real que `work` possa ter lançado.
    try {
      await db.$queryRaw`SELECT pg_advisory_unlock(${key}::bigint)`;
    } catch (e) {
      log(`⚠️  ${label}: não consegui liberar o advisory lock ${key}: ${(e as Error)?.message ?? e}`);
    }
  }
}

// ----------------------------------------------------------------------------
// Ponte para o mundo `pg` (o que o servidor usa de fato em runtime)
// ----------------------------------------------------------------------------

/**
 * Adapta um `PoolClient` do `pg` à porta `PrismaQueryable`.
 *
 * O `PoolClient` é UMA conexão fixa — exatamente o contrato que o advisory lock
// de sessão exige. O tagged template é traduzido para o `query(text, values)`
// do pg: os `${}` viram `$1, $2…`, então continua tudo parametrizado (nada de
// concatenação de SQL).
 */
export function pgClientAsQueryable(client: PoolClient): PrismaQueryable {
  return {
    async $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
      const texto = query.reduce(
        (acumulado, parte, i) => acumulado + (i === 0 ? parte : `$${i}` + parte),
        ''
      );
      // Desempacota `.rows`: o `pg` resolve com QueryResult, e a porta
      // PrismaQueryable promete o array de linhas. Sem isto, o lock nunca é
      // reconhecido como adquirido (ver o comentário da interface).
      const resultado = await client.query(texto, values as unknown[]);
      return resultado?.rows ?? [];
    },
  };
}

export interface WithSchemaMigrationLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: (mensagem: string) => void;
}

/**
 * Conveniência para o boot: pega UMA conexão do pool, roda `work` sob o lock de
 * migração (727272) e devolve a conexão.
 *
 * É isto que `migrate()` usa. `work` recebe o `PoolClient` já sob lock — é nele
 * que o schema.sql e as migrações versionadas devem ser aplicados.
 */
export async function withSchemaMigrationLock<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: WithSchemaMigrationLockOptions = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    return await withAdvisoryLock(
      pgClientAsQueryable(client),
      () => work(client),
      {
        key: ADVISORY_LOCK_KEYS.SCHEMA_MIGRATION,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        label: 'migrate',
        log: options.log ?? ((m: string) => console.log(m)),
      }
    );
  } finally {
    client.release();
  }
}
