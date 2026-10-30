import { getStore } from './services';
import { getResource } from './resources';
import { HttpError } from './errors';
import { listarTodos } from './paginacaoCompleta';
import { enfileirarOutbox } from './commerce/outbox';
import { R_INTENTS, R_OPERATIONS } from '../../modules/payments/infrastructure/resources';
import { paymentEngine } from '../../modules/payments/orchestration/payment-orchestrator';
import type { Row, Tx } from './store';

/** Runs inside receiving transaction, after locking the sale. No provider I/O here. */
export async function agendarRefundDevolucao(dev: Row, tx: Tx): Promise<boolean> {
  const s = getStore(); const company = Number(dev.empresa_id);
  const orders = await listarTodos(getResource('commerce_pedidos')!, { empresa_id: company, venda_id: Number(dev.venda_id) }, tx);
  const intents: Row[] = [];
  for (const order of orders) intents.push(...await listarTodos(R_INTENTS, { empresa_id: company, order_id: Number(order.id) }, tx));
  const paid = intents.filter((i) => ['PAID','PARTIALLY_REFUNDED','REFUNDED'].includes(String(i.status)));
  if (!intents.length) return false; // Historical non-engine sale keeps its existing policy.
  if (paid.length !== 1) throw new HttpError(409, 'Devolução exige um pagamento capturado inequívoco; revise os pagamentos do pedido.');
  const intent = paid[0];
  const items = await listarTodos(getResource('itens_venda')!, { empresa_id: company, venda_id: Number(dev.venda_id) }, tx);
  const returns = await listarTodos(getResource('devolucoes')!, { empresa_id: company, venda_id: Number(dev.venda_id), status: 'recebida' }, tx);
  let weight = 0, returned = 0, alreadyAssigned = 0;
  for (const item of items) {
    const unit = Math.round(Number(item.preco_unitario) * 100);
    if (!Number.isSafeInteger(unit) || unit <= 0 || !Number.isSafeInteger(Number(item.quantidade))) throw new HttpError(409, 'Valor do item insuficiente para calcular o refund.');
    weight += unit * Number(item.quantidade);
    for (const ret of returns) {
      const lines = await listarTodos(getResource('devolucao_itens')!, { empresa_id: company, devolucao_id: Number(ret.id), item_venda_id: Number(item.id) }, tx);
      returned += lines.reduce((sum, line) => sum + unit * Number(line.quantidade_recebida), 0);
    }
  }
  for (const ret of returns) if (Number(ret.id) !== Number(dev.id)) alreadyAssigned += Number(ret.refund_amount || 0);
  // Cumulative allocation avoids rounding loss and refunds shipping/discounts
  // proportionally. The final return reaches exactly the original captured total.
  if (!weight || returned > weight) throw new HttpError(409, 'Quantidades/valores de devolução divergentes.');
  const amount = Math.round(Number(intent.amount) * returned / weight) - alreadyAssigned;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(409, 'Refund sem valor positivo comprovável.');
  await s.update(getResource('devolucoes')!, Number(dev.id), { payment_intent_id: intent.id, refund_amount: amount, refund_estado: 'PENDENTE' }, tx);
  await enfileirarOutbox(company, 'refund_devolucao', `return:${dev.id}`, { devolucao_id: Number(dev.id) }, tx);
  return true;
}

/** Existing at-least-once outbox invokes the existing Payment Engine. */
export async function processarRefundDevolucao(company: number, returnId: number) {
  const s = getStore();
  const dev = await s.findOneWhere(getResource('devolucoes')!, { empresa_id: company, id: returnId });
  if (!dev || dev.status !== 'recebida' || !dev.payment_intent_id || !dev.refund_amount) throw new HttpError(409, 'Devolução sem recebimento e valor comprovados.');
  if (dev.refund_estado === 'CONCLUIDO') return;
  const intentId = Number(dev.payment_intent_id); const key = `return:${returnId}`;
  const old = await s.findOneWhere(R_OPERATIONS, { empresa_id: company, payment_intent_id: intentId, operation: 'refund', idempotency_key: key });
  if (old && ['PROCESSING','UNCERTAIN'].includes(String(old.status))) await paymentEngine.synchronize(company, intentId);
  await paymentEngine.mutate(company, intentId, 'refund', key, Number(dev.refund_amount));
  await s.transaction(async (tx) => {
    await s.update(getResource('devolucoes')!, returnId, { refund_estado: 'CONCLUIDO' }, tx);
    await s.audit({ empresa_id: company, usuario_id: null, usuario: 'Payment Engine', acao: 'ajuste', recurso: 'devolucoes', registro_id: returnId,
      descricao: 'Refund da devolução comprovado pelo Payment Engine', dados: { payment_intent_id: intentId, amount: dev.refund_amount } }, tx);
  });
}
