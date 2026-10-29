import { getStore } from '../../../server/src/services';
import { R_GATEWAY_WEBHOOK_EVENTS } from '../../../server/src/gateway';
import type { Row } from '../../../server/src/store';
import { R_ATTEMPTS } from '../infrastructure/resources';
import { providerRegistry } from '../providers/registry';
import { paymentEngine } from '../orchestration/payment-orchestrator';
export async function processEngineWebhook(event: Row, legacyId: string, reference: string) {
  const provider = providerRegistry.list().find((p) => p.legacyId === legacyId);
  if (!provider) return null;
  const s = getStore();
  const attempt = await s.findOneWhere(R_ATTEMPTS, {
    empresa_id: Number(event.empresa_id),
    provider: provider.code,
    provider_transaction_id: reference,
  });
  if (!attempt) return null;
  if (legacyId === 'mock' && process.env.NODE_ENV === 'test') {
    const { mockProvider, lerPayloadWebhook } = await import('../../../server/src/gateway');
    const intention = await mockProvider.resolveWebhook!(
      { empresaId: Number(event.empresa_id), config: null, credenciais: null, webhookSegredo: null },
      { evento_id: String(event.evento_id), evento: null, provider_ref: reference },
      lerPayloadWebhook(event.payload)
    );
    if (intention) {
      await paymentEngine.apply(Number(event.empresa_id), Number(attempt.payment_intent_id), {
        reference,
        status: intention === 'paga' ? 'PAID' : intention === 'estornada' ? 'REFUNDED' : intention === 'expirada' ? 'EXPIRED' : 'CANCELED',
      });
      await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(event.id), { status: 'processado', processado_em: new Date().toISOString() });
      return { resultado: intention };
    }
    return null;
  }
  if (event.assinatura_ok !== true) throw new Error('Webhook signature required');
  await paymentEngine.synchronize(Number(event.empresa_id), Number(attempt.payment_intent_id));
  await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(event.id), {
    status: 'processado',
    processado_em: new Date().toISOString(),
    tentativas: Number(event.tentativas || 0) + 1,
    erro: null,
  });
  return { resultado: 'payment_engine' };
}
