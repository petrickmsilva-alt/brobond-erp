// Processo separado: executa o cron real contra PostgreSQL local descartável.
import { migrate, pool } from '../../src/db';
await migrate();
const { executarProcessoCron, definirHoldDeTesteCron } = await import('../../src/scheduled');
definirHoldDeTesteCron(400);
process.send?.({ kind: 'ready' });
process.on('message', async (m: { command: string; job?: 'relatorios' | 'pagamentos' | 'publicacoes' | 'pedidos' | 'crm' }) => {
  try {
    if (m.command === 'run') {
      const r = await executarProcessoCron(m.job!);
      process.send?.({ kind: 'result', status: r.status, motivo: r.motivo, ok: r.ok });
    } else if (m.command === 'end') {
      await pool?.end();
      process.disconnect();
    }
  } catch {
    process.send?.({ kind: 'error' });
  }
});
