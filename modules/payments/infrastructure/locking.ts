import { getStore } from '../../../server/src/services';
import type { Tx } from '../../../server/src/store';
/** Cross-process PostgreSQL lock. Memory queue is exclusively for repository's test/demo store. */
const queues = new Map<string, Promise<unknown>>();
export async function locked<T>(empresaId: number, key: string, fn: (tx: Tx) => Promise<T>, isolation: 'serializable' | 'read committed' = 'serializable'): Promise<T> {
  const name = `payments:${empresaId}:${key}`;
  const execute = () =>
    getStore().transaction(async (tx) => {
      // Global order: financial-period fence before payment-specific locks and rows.
      // The DB triggers are the final defense; acquiring it here prevents a
      // payout row lock ↔ period-fence deadlock with dispute/refund writers.
      if (tx) {
        await tx.query('SELECT fin_travar_empresa_periodo($1)', [empresaId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [name]);
      }
      return fn(tx);
    }, { isolation });
  const previous = queues.get(name) || Promise.resolve();
  const next = previous.catch(() => {}).then(execute);
  queues.set(name, next);
  try {
    return await next;
  } finally {
    if (queues.get(name) === next) queues.delete(name);
  }
}

/** Retry database-only serializable transactions, never an external provider write. */
export async function retrySerialization<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error: unknown) {
      if ((error as { code?: unknown } | null)?.code !== '40001' || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}
