import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { pool } from './db';

/**
 * Coordenação distribuída dos cinco processos de cron.
 *
 * A posse do lease NÃO implica exatamente-uma-vez em provedor externo.
 * Fencing só vale para escritas que consultam o token (store PostgreSQL com
 * lease no AsyncLocalStorage, ou `executeCronUnit` no mesmo cliente).
 */
export const PROCESSOS_CRON_LOCK = ['relatorios', 'pagamentos', 'publicacoes', 'pedidos', 'crm'] as const;
export type ProcessoCronLock = (typeof PROCESSOS_CRON_LOCK)[number];

export const CRON_UNIT_STATES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETRYABLE', 'ABANDONED', 'UNKNOWN'] as const;
export type CronUnitState = (typeof CRON_UNIT_STATES)[number];

export const CRON_UNIT_MAX_ATTEMPTS = 8;

export interface CronLease {
  job: string;
  owner: string;
  execution: string;
  token: string;
  leaseMs: number;
}

export class CronLeaseLostError extends Error {
  constructor() {
    super('Lease obsoleto');
    this.name = 'CronLeaseLostError';
  }
}

export class CronCoordinationError extends Error {
  constructor(message = 'Coordenação distribuída indisponível') {
    super(message);
    this.name = 'CronCoordinationError';
  }
}

const owner = randomUUID();
const storage = new AsyncLocalStorage<CronLease>();

function evento(name: string, lease: Pick<CronLease, 'job' | 'owner' | 'execution'>, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ evento: name, job: lease.job, instancia: lease.owner, execucao: lease.execution, ...extra }));
}

export function currentCronLease(): CronLease | undefined {
  return storage.getStore();
}

export function runWithCronLease<T>(lease: CronLease, fn: () => Promise<T>): Promise<T> {
  return storage.run(lease, fn);
}

export function isProcessoCronLock(nome: string): nome is ProcessoCronLock {
  return (PROCESSOS_CRON_LOCK as readonly string[]).includes(nome);
}

function exigirPool() {
  if (!pool) throw new Error('PostgreSQL obrigatório para lock distribuído');
  return pool;
}

function exigirIdentidade(key: string, entity: string) {
  if (!key || !entity) throw new Error('Identidade da unidade obrigatória');
}

/** Cláusula atômica: a escrita só ocorre se o lease ainda for o dono vigente. */
export function leaseHeldSql(paramStart: number, lease = currentCronLease()): { sql: string; params: unknown[] } | null {
  if (!lease) return null;
  return {
    sql: `EXISTS (SELECT 1 FROM cron_job_locks WHERE job_id = $${paramStart} AND owner_id = $${paramStart + 1}::uuid AND execution_id = $${paramStart + 2}::uuid AND fencing_token = $${paramStart + 3} AND state = 'HELD' AND expires_at > clock_timestamp())`,
    params: [lease.job, lease.owner, lease.execution, lease.token],
  };
}

export async function assertLeaseHeld(client: PoolClient, lease = currentCronLease()): Promise<void> {
  if (!lease) return;
  const r = await client.query(
    `SELECT 1 FROM cron_job_locks
      WHERE job_id = $1 AND owner_id = $2 AND execution_id = $3 AND fencing_token = $4
        AND state = 'HELD' AND expires_at > clock_timestamp() FOR UPDATE`,
    [lease.job, lease.owner, lease.execution, lease.token],
  );
  if (!r.rowCount) {
    evento('cron_fencing_rejeitado', lease);
    throw new CronLeaseLostError();
  }
}

export async function assertCurrentLeaseAlive(lease = currentCronLease()): Promise<void> {
  if (!lease) return;
  const db = exigirPool();
  const r = await db.query(
    `SELECT 1 FROM cron_job_locks
      WHERE job_id = $1 AND owner_id = $2 AND execution_id = $3 AND fencing_token = $4
        AND state = 'HELD' AND expires_at > clock_timestamp()`,
    [lease.job, lease.owner, lease.execution, lease.token],
  );
  if (!r.rowCount) {
    evento('cron_fencing_rejeitado', lease);
    throw new CronLeaseLostError();
  }
}

/** INSERT/UPDATE único: o banco arbitra as aquisições simultâneas. */
export async function acquireCronLease(job: string, leaseMs = 30_000): Promise<CronLease | null> {
  const db = exigirPool();
  if (!isProcessoCronLock(job)) throw new Error('Job de cron desconhecido');
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 1_800_000) throw new Error('Lease inválido');
  const candidate = { job, owner, execution: randomUUID(), leaseMs };
  const r = await db.query<{ fencing_token: string }>(
    `
    INSERT INTO cron_job_locks (job_id, owner_id, execution_id, fencing_token, acquired_at, heartbeat_at, expires_at, state)
    VALUES ($1, $2, $3, 1, clock_timestamp(), clock_timestamp(), clock_timestamp() + $4 * interval '1 millisecond', 'HELD')
    ON CONFLICT (job_id) DO UPDATE SET
      owner_id = EXCLUDED.owner_id, execution_id = EXCLUDED.execution_id,
      fencing_token = cron_job_locks.fencing_token + 1,
      acquired_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
      expires_at = clock_timestamp() + $4 * interval '1 millisecond', released_at = NULL, state = 'HELD'
    WHERE cron_job_locks.state = 'RELEASED' OR cron_job_locks.expires_at <= clock_timestamp()
    RETURNING fencing_token`,
    [job, owner, candidate.execution, leaseMs],
  );
  if (!r.rows[0]) {
    evento('cron_lock_recusado', candidate);
    return null;
  }
  evento('cron_lock_adquirido', candidate, { fencing_token: String(r.rows[0].fencing_token) });
  return { ...candidate, token: String(r.rows[0].fencing_token) };
}

export async function renewCronLease(lease: CronLease): Promise<boolean> {
  const db = exigirPool();
  const r = await db.query(
    `UPDATE cron_job_locks SET heartbeat_at = clock_timestamp(),
      expires_at = clock_timestamp() + $5 * interval '1 millisecond'
    WHERE job_id = $1 AND owner_id = $2 AND execution_id = $3 AND fencing_token = $4
      AND state = 'HELD' AND expires_at > clock_timestamp()`,
    [lease.job, lease.owner, lease.execution, lease.token, lease.leaseMs],
  );
  const ok = r.rowCount === 1;
  if (!ok) evento('cron_lock_perdido', lease);
  return ok;
}

export async function releaseCronLease(lease: CronLease): Promise<boolean> {
  const db = exigirPool();
  const r = await db.query(
    `UPDATE cron_job_locks SET state = 'RELEASED', released_at = clock_timestamp(), expires_at = clock_timestamp()
    WHERE job_id = $1 AND owner_id = $2 AND execution_id = $3 AND fencing_token = $4
      AND state = 'HELD' AND expires_at > clock_timestamp()`,
    [lease.job, lease.owner, lease.execution, lease.token],
  );
  const ok = r.rowCount === 1;
  evento(ok ? 'cron_lock_liberado' : 'cron_lock_liberacao_recusada', lease);
  return ok;
}

export function startCronHeartbeat(lease: CronLease, onLost: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const beat = async () => {
    if (stopped) return;
    try {
      if (!(await renewCronLease(lease))) {
        stopped = true;
        onLost();
        return;
      }
    } catch {
      if (!stopped) {
        stopped = true;
        evento('cron_lock_heartbeat_falhou', lease);
        onLost();
      }
      return;
    }
    if (!stopped) {
      timer = setTimeout(beat, Math.max(25, Math.floor(lease.leaseMs / 3)));
      timer.unref();
    }
  };
  timer = setTimeout(beat, Math.max(25, Math.floor(lease.leaseMs / 3)));
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Unidade exclusivamente interna: operação de banco e conclusão no mesmo
 * cliente. O callback DEVE usar somente `client` e NÃO deve chamar provedores
 * externos.
 */
export async function executeCronUnit<T>(
  lease: CronLease,
  key: string,
  entity: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<{ completed: boolean; result?: T }> {
  const db = exigirPool();
  exigirIdentidade(key, entity);
  const client = await db.connect();
  const validar = () => assertLeaseHeld(client, lease);
  try {
    await client.query('BEGIN');
    await validar();
    const claimed = await client.query(
      `INSERT INTO cron_work_items
      (job_id, idempotency_key, entity_id, state, owner_id, execution_id, fencing_token, attempts, started_at)
      VALUES ($1, $2, $3, 'PROCESSING', $4, $5, $6, 1, clock_timestamp())
      ON CONFLICT (job_id, idempotency_key) DO UPDATE SET state = 'PROCESSING', owner_id = EXCLUDED.owner_id,
        execution_id = EXCLUDED.execution_id, fencing_token = EXCLUDED.fencing_token,
        attempts = cron_work_items.attempts + 1, started_at = clock_timestamp(), error_code = NULL
      WHERE cron_work_items.entity_id = EXCLUDED.entity_id
        AND (cron_work_items.state IN ('PENDING', 'RETRYABLE', 'ABANDONED')
          OR (cron_work_items.state = 'PROCESSING' AND cron_work_items.fencing_token < EXCLUDED.fencing_token))
      RETURNING idempotency_key`,
      [lease.job, key, entity, lease.owner, lease.execution, lease.token],
    );
    if (!claimed.rowCount) {
      const existing = await client.query('SELECT state, entity_id FROM cron_work_items WHERE job_id=$1 AND idempotency_key=$2', [lease.job, key]);
      if (existing.rows[0]?.state !== 'COMPLETED' || existing.rows[0]?.entity_id !== entity) throw new Error('Unidade não reivindicável');
      await client.query('COMMIT');
      evento('cron_trabalho_ja_concluido', lease, { chave: key });
      return { completed: false };
    }
    evento('cron_trabalho_reivindicado', lease, { chave: key });
    const result = await fn(client);
    await validar();
    const updated = await client.query(
      `UPDATE cron_work_items SET state = 'COMPLETED', completed_at = clock_timestamp()
      WHERE job_id=$1 AND idempotency_key=$2 AND execution_id=$3 AND owner_id=$4 AND fencing_token=$5 AND state='PROCESSING'`,
      [lease.job, key, lease.execution, lease.owner, lease.token],
    );
    if (updated.rowCount !== 1) throw new Error('Conclusão recusada');
    await client.query('COMMIT');
    evento('cron_trabalho_concluido', lease, { chave: key });
    return { completed: true, result };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    evento('cron_trabalho_falhou', lease, { chave: key });
    if (!(e instanceof CronLeaseLostError) && !(e instanceof Error && e.message === 'Unidade não reivindicável')) {
      await persistUnitOutcome(lease, key, entity, 'RETRYABLE', e).catch(() => undefined);
    }
    throw e;
  } finally {
    client.release();
  }
}

export type CronClaimResult = 'claimed' | 'completed' | 'busy';

/** Reivindica a unidade numa transação curta. Trabalho externo ocorre DEPOIS. */
export async function claimCronUnit(lease: CronLease, key: string, entity: string): Promise<CronClaimResult> {
  const db = exigirPool();
  exigirIdentidade(key, entity);
  const r = await db.query<{ state: string }>(
    `INSERT INTO cron_work_items
      (job_id, idempotency_key, entity_id, state, owner_id, execution_id, fencing_token, attempts, started_at)
      SELECT $1, $2, $3, 'PROCESSING', $4, $5, $6, 1, clock_timestamp()
      WHERE EXISTS (SELECT 1 FROM cron_job_locks WHERE job_id = $1 AND owner_id = $4::uuid AND execution_id = $5::uuid AND fencing_token = $6 AND state = 'HELD' AND expires_at > clock_timestamp())
      ON CONFLICT (job_id, idempotency_key) DO UPDATE SET state = 'PROCESSING', owner_id = EXCLUDED.owner_id,
        execution_id = EXCLUDED.execution_id, fencing_token = EXCLUDED.fencing_token,
        attempts = cron_work_items.attempts + 1, started_at = clock_timestamp(), error_code = NULL
      WHERE cron_work_items.entity_id = EXCLUDED.entity_id
        AND (cron_work_items.state IN ('PENDING', 'RETRYABLE', 'ABANDONED')
          OR (cron_work_items.state = 'PROCESSING' AND cron_work_items.fencing_token < EXCLUDED.fencing_token))
      RETURNING state`,
    [lease.job, key, entity, lease.owner, lease.execution, lease.token],
  );
  if (r.rowCount) {
    evento('cron_trabalho_reivindicado', lease, { chave: key });
    return 'claimed';
  }
  const existing = await db.query('SELECT state, entity_id FROM cron_work_items WHERE job_id=$1 AND idempotency_key=$2', [lease.job, key]);
  const estado = existing.rows[0]?.state;
  if ((estado === 'COMPLETED' || estado === 'UNKNOWN') && existing.rows[0]?.entity_id === entity) {
    evento(estado === 'UNKNOWN' ? 'cron_trabalho_desconhecido' : 'cron_trabalho_ja_concluido', lease, { chave: key });
    return 'completed';
  }
  await assertCurrentLeaseAlive(lease);
  return 'busy';
}

export async function completeCronUnit(lease: CronLease, key: string): Promise<boolean> {
  const db = exigirPool();
  const r = await db.query(
    `UPDATE cron_work_items SET state = 'COMPLETED', completed_at = clock_timestamp(), error_code = NULL
      WHERE job_id=$1 AND idempotency_key=$2 AND execution_id=$3 AND owner_id=$4 AND fencing_token=$5 AND state='PROCESSING'
        AND EXISTS (SELECT 1 FROM cron_job_locks WHERE job_id = $1 AND owner_id = $4::uuid AND execution_id = $3::uuid AND fencing_token = $5 AND state = 'HELD' AND expires_at > clock_timestamp())`,
    [lease.job, key, lease.execution, lease.owner, lease.token],
  );
  const ok = r.rowCount === 1;
  evento(ok ? 'cron_trabalho_concluido' : 'cron_trabalho_conclusao_recusada', lease, { chave: key });
  if (!ok) await assertCurrentLeaseAlive(lease);
  return ok;
}

export async function failCronUnit(lease: CronLease, key: string, entity: string, error: unknown, retryable = true): Promise<void> {
  const state: CronUnitState = retryable ? 'RETRYABLE' : 'FAILED';
  await persistUnitOutcome(lease, key, entity, state, error);
}

async function persistUnitOutcome(lease: CronLease, key: string, entity: string, state: CronUnitState, error: unknown): Promise<void> {
  if (!pool) return;
  const code = error instanceof CronLeaseLostError ? 'LEASE_LOST' : 'UNIT_ERROR';
  const r = await pool.query<{ attempts: number }>(
    `INSERT INTO cron_work_items
      (job_id, idempotency_key, entity_id, state, owner_id, execution_id, fencing_token, attempts, started_at, error_code)
      SELECT $1, $2, $3, $7, $4, $5, $6, 1, clock_timestamp(), $8
      WHERE EXISTS (SELECT 1 FROM cron_job_locks WHERE job_id = $1 AND owner_id = $4::uuid AND execution_id = $5::uuid AND fencing_token = $6 AND state = 'HELD' AND expires_at > clock_timestamp())
      ON CONFLICT (job_id, idempotency_key) DO UPDATE SET
        state = CASE WHEN cron_work_items.attempts + 1 >= $9 THEN 'ABANDONED' ELSE EXCLUDED.state END,
        owner_id = EXCLUDED.owner_id, execution_id = EXCLUDED.execution_id, fencing_token = EXCLUDED.fencing_token,
        attempts = cron_work_items.attempts + 1, error_code = EXCLUDED.error_code
      WHERE cron_work_items.entity_id = EXCLUDED.entity_id
        AND EXISTS (SELECT 1 FROM cron_job_locks WHERE job_id = $1 AND owner_id = $4::uuid AND execution_id = $5::uuid AND fencing_token = $6 AND state = 'HELD' AND expires_at > clock_timestamp())
      RETURNING attempts, state`,
    [lease.job, key, entity, lease.owner, lease.execution, lease.token, state, code, CRON_UNIT_MAX_ATTEMPTS],
  );
  if (r.rowCount) evento('cron_trabalho_estado', lease, { chave: key, estado: r.rows[0] ? state : null });
}

/**
 * Idempotência por unidade estável. Sem lease (modo demonstração / testes em
 * memória) executa o trabalho direto. Com lease, a chave concluída ou UNKNOWN
 * não reenvia. Efeito externo permanece no máximo at-least-once se o processo
 * cair depois do envio e antes de COMPLETED.
 */
export async function withCronIdempotency<T>(key: string, entity: string, fn: () => Promise<T>): Promise<T | undefined> {
  const lease = currentCronLease();
  if (!lease) return fn();
  const claim = await claimCronUnit(lease, key, entity);
  if (claim === 'completed' || claim === 'busy') return undefined;
  try {
    await assertCurrentLeaseAlive(lease);
    const result = await fn();
    await completeCronUnit(lease, key);
    return result;
  } catch (e) {
    if (!(e instanceof CronLeaseLostError)) await failCronUnit(lease, key, entity, e, true).catch(() => undefined);
    throw e;
  }
}

export type CronBusyPolicy = 'skip' | 'fail' | 'retry';

function demoSemPostgresPermitido(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return !pool;
}

async function adquirirComPolitica(job: string, leaseMs: number, busy: CronBusyPolicy): Promise<CronLease | null> {
  const tentativas = busy === 'retry' ? 40 : 1;
  for (let i = 0; i < tentativas; i += 1) {
    const lease = await acquireCronLease(job, leaseMs);
    if (lease) return lease;
    if (busy === 'fail') throw new CronCoordinationError('Lock do job já detido');
    if (busy === 'skip') return null;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/**
 * Garante o lease do job. Sem PostgreSQL em produção recusa. Em demonstração
 * isolada (sem pool) executa sem lock distribuído — sem efeitos de provedor.
 * NODE_ENV sozinho NÃO dispensa o lock quando o banco existe.
 */
export async function requireJobLease<T>(
  job: string,
  fn: () => Promise<T>,
  opcoes: { leaseMs?: number; busy?: CronBusyPolicy } = {},
): Promise<{ skipped: boolean; result?: T }> {
  if (!isProcessoCronLock(job)) throw new CronCoordinationError('Job de cron desconhecido');
  const atual = currentCronLease();
  if (atual?.job === job) return { skipped: false, result: await fn() };
  if (atual) throw new CronCoordinationError('Lease de outro job vigente');
  if (!pool) {
    if (!demoSemPostgresPermitido()) {
      evento('cron_operacao_bloqueada_sem_postgres', { job, owner, execution: 'n/a' });
      throw new CronCoordinationError('PostgreSQL obrigatório para operação coordenada');
    }
    evento('cron_coordenacao_memoria', { job, owner, execution: 'n/a' });
    return { skipped: false, result: await fn() };
  }
  const leaseMs = opcoes.leaseMs ?? 30_000;
  const lease = await adquirirComPolitica(job, leaseMs, opcoes.busy ?? 'fail');
  if (!lease) return { skipped: true };
  const stop = startCronHeartbeat(lease, () => undefined);
  try {
    return { skipped: false, result: await runWithCronLease(lease, fn) };
  } finally {
    stop();
    await releaseCronLease(lease).catch(() => undefined);
  }
}

/** Drenagem oportunista: se o job já está com outro dono, não executa. */
export async function withOptionalJobLease<T>(job: string, leaseMs: number, fn: () => Promise<T>): Promise<{ skipped: boolean; result?: T }> {
  return requireJobLease(job, fn, { leaseMs, busy: 'skip' });
}

export async function markUnknownCronUnit(lease: CronLease, key: string, entity: string): Promise<void> {
  await persistUnitOutcome(lease, key, entity, 'UNKNOWN', new Error('PROVIDER_UNKNOWN'));
}

/** Escrita bruta no mesmo cliente, com o lease travado até o commit. */
export async function fencedPoolQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const db = exigirPool();
  const lease = currentCronLease();
  if (!lease) return db.query(text, params as never);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertLeaseHeld(client, lease);
    const r = await client.query<T>(text, params as never);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export function leaseMsForTimeout(limiteMs: number): number {
  if (!Number.isInteger(limiteMs)) return 30_000;
  return Math.max(100, Math.min(30_000, limiteMs));
}
