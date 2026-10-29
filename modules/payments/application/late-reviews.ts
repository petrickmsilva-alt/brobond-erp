import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import type { Row, Tx } from '../../../server/src/store';
import { R_INTENTS, R_LATE_REVIEWS } from '../infrastructure/resources';

/** Called in the same transaction as the verified payment or legacy callback.
 * It never changes the order's fulfillment state, stock, sale or financial ledger. */
export async function recordLatePayment(empresaId: number, order: Row, cobrancaId: number, tx: Tx): Promise<void> {
  if (!['EXPIRADO', 'CANCELADO'].includes(String(order.estado))) return;
  const s = getStore();
  const orderId = Number(order.id);
  const existing = await s.findOneWhere(R_LATE_REVIEWS, { empresa_id: empresaId, order_id: orderId }, tx);
  // A replay must not reopen a completed refund or duplicate its audit trail.
  if (existing?.status === 'REFUNDED') return;
  const intent = await s.findOneWhere(R_INTENTS, { empresa_id: empresaId, order_id: orderId }, tx);
  const timestamp = new Date().toISOString();
  // Updating the order also serializes concurrent detection against expiry,
  // cancellation and another callback in the surrounding SERIALIZABLE tx.
  await s.update(getResource('commerce_pedidos')!, orderId, {
    pagamento_estado: 'APPROVED', pago_em: order.pago_em || timestamp,
    erro: 'Pagamento confirmado após expiração/cancelamento; revisão manual necessária.', atualizado_em: timestamp,
  }, tx);
  if (!existing) {
    const review = await s.insert(R_LATE_REVIEWS, {
      empresa_id: empresaId, order_id: orderId, cobranca_id: cobrancaId,
      payment_intent_id: intent?.id ?? null, status: 'OPEN', created_at: timestamp, resolved_at: null,
    }, tx);
    await s.audit({ empresa_id: empresaId, usuario_id: null, usuario: 'Payment Engine', acao: 'ajuste',
      recurso: 'payment_late_reviews', registro_id: Number(review.id),
      descricao: 'Pagamento confirmado após encerramento; revisão necessária, sem reabrir a venda',
      dados: { order_id: orderId, cobranca_id: cobrancaId, payment_intent_id: intent?.id ?? null, estado: order.estado } }, tx);
  }
}

/** Only a confirmed full refund resolves the exception; partial/uncertain is OPEN. */
export async function resolveLateRefund(empresaId: number, order: Row, tx: Tx): Promise<void> {
  const s = getStore();
  const orderId = Number(order.id);
  const review = await s.findOneWhere(R_LATE_REVIEWS, { empresa_id: empresaId, order_id: orderId }, tx);
  if (!review || review.status !== 'OPEN') return;
  const timestamp = new Date().toISOString();
  await s.update(R_LATE_REVIEWS, Number(review.id), { status: 'REFUNDED', resolved_at: timestamp }, tx);
  await s.update(getResource('commerce_pedidos')!, orderId, {
    pagamento_estado: 'REFUNDED', erro: 'Pagamento tardio estornado; pedido permanece encerrado.', atualizado_em: timestamp,
  }, tx);
  await s.audit({ empresa_id: empresaId, usuario_id: null, usuario: 'Payment Engine', acao: 'ajuste',
    recurso: 'payment_late_reviews', registro_id: Number(review.id),
    descricao: 'Estorno integral confirmado; revisão de pagamento tardio encerrada',
    dados: { order_id: orderId, payment_intent_id: review.payment_intent_id ?? null } }, tx);
}
