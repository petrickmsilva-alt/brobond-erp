import { getStore } from '../../../server/src/services';
import { processarEvento, R_GATEWAY_WEBHOOK_EVENTS } from '../../../server/src/gateway';
import { R_INTENTS } from '../infrastructure/resources';
import { paymentEngine } from '../orchestration/payment-orchestrator';
import { requireJobLease, withCronIdempotency } from '../../../server/src/cronLock';
/** Bounded, scheduled reconciliation. Only reads provider state; never retries a business decline. */
export async function runPaymentJobs() {
  const r = await requireJobLease('pagamentos', () => executarPaymentJobs(), { busy: 'retry' });
  return r.result ?? { synchronized: 0, failed: 0 };
}

async function executarPaymentJobs() {
  const s = getStore();
  let synchronized = 0,
    failed = 0;
  // Round-robin by updated_at avoids starvation. Each update records the last inspection.
  const intents = await s.list(R_INTENTS, { page: 1, pageSize: 100, sort: 'updated_at', dir: 'asc' });
  for (const i of intents.rows) {
    if (
      // An expired/canceled provider payment can still settle late; a refund
      // operation may also be uncertain after its intent became REFUNDED.
      (['CREATED', 'PENDING', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURE_PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'DISPUTED', 'EXPIRED', 'CANCELED'].includes(
        i.status
      ) || Boolean(i.active_operation)) &&
      Date.now() - new Date(i.updated_at).getTime() > 60_000
    ) {
      try {
        const feito = await withCronIdempotency(`pagamentos:intent:${i.id}:${i.status}`, String(i.id), async () => {
          await paymentEngine.synchronize(Number(i.empresa_id), Number(i.id));
          await paymentEngine.deliverToCommerce(Number(i.empresa_id), Number(i.id));
          return true;
        });
        if (feito) synchronized++;
      } catch {
        failed++;
      }
    }
    await s.update(R_INTENTS, Number(i.id), { updated_at: new Date().toISOString() });
  }
  for (const status of ['recebido', 'erro']) {
    const events = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 50, filter: { status } });
    for (const e of events.rows) {
      if (
        e.assinatura_ok !== true ||
        Number(e.tentativas) >= 10 ||
        (e.proxima_tentativa_em && new Date(e.proxima_tentativa_em).getTime() > Date.now())
      )
        continue;
      try {
        await withCronIdempotency(`pagamentos:webhook:${e.id}:${e.tentativas}`, String(e.id), async () => {
          await processarEvento(e);
          return true;
        });
      } catch {
        failed++;
      }
    }
  }
  return { synchronized, failed };
}
