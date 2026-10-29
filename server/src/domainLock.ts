import { getStore } from './services';
import type { Tx } from './store';

/** Lock transacional entre processos; fila somente para Store de demonstração. */
const queues = new Map<string, Promise<unknown>>();
export async function domainLock<T>(empresaId: number, domain: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const name = `domain:${empresaId}:${domain}`;
  const execute = () => getStore().transaction(async (tx) => {
    if (tx) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [name]);
    return fn(tx);
  }, { isolation: 'read committed' });
  const previous = queues.get(name) || Promise.resolve();
  const next = previous.catch(() => {}).then(execute);
  queues.set(name, next);
  try { return await next; } finally { if (queues.get(name) === next) queues.delete(name); }
}
