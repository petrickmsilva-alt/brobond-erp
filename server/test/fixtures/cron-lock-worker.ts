// Processo separado usado apenas pela suíte PostgreSQL local.
import { acquireCronLease, releaseCronLease, executeCronUnit, type CronLease } from '../../src/cronLock';
import { pool } from '../../src/db';
process.send?.({ kind: 'ready' });
process.on('message', async (m: { command: string; job?: string; lease?: CronLease; leaseMs?: number }) => {
  try {
    if (m.command === 'acquire') {
      const lease = await acquireCronLease(m.job!, m.leaseMs);
      process.send?.({ kind: 'acquired', lease });
    } else if (m.command === 'unit') {
      const r = await executeCronUnit(m.lease!, 'unit:42', '42', async (c) => {
        await c.query('INSERT INTO cron_lock_test_effects (id) VALUES (42)');
        return true;
      });
      process.send?.({ kind: 'unit', completed: r.completed });
    } else if (m.command === 'release') {
      process.send?.({ kind: 'released', ok: await releaseCronLease(m.lease!) });
    } else if (m.command === 'end') {
      await pool?.end();
      process.disconnect();
    }
  } catch {
    process.send?.({ kind: 'error' });
  }
});
