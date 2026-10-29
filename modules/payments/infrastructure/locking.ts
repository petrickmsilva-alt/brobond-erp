import { getStore } from '../../../server/src/services';
import type { Tx } from '../../../server/src/store';
/** Cross-process PostgreSQL lock. Memory queue is exclusively for repository's test/demo store. */
const queues = new Map<string, Promise<unknown>>();
export async function locked<T>(empresaId: number, key: string, fn: (tx: Tx) => Promise<T>, isolation: 'serializable' | 'read committed' = 'serializable'): Promise<T> {
  const name = `payments:${empresaId}:${key}`;
  const execute = () =>
    getStore().transaction(async (tx) => {
      if (tx) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [name]);
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
