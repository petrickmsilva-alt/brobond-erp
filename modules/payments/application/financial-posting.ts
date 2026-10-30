// Settlement amounts in cents reconcile the existing financial book, not a new ledger.
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { HttpError } from '../../../server/src/errors';
import type { Row, Tx } from '../../../server/src/store';
import { R_INTENTS, R_DISPUTES } from '../infrastructure/resources';
import { R_GATEWAY_COBRANCAS } from '../../../server/src/gateway';

export async function aplicarTaxasSettlement(company: number, settlement: Row, bank: Row, tx: Tx) {
  const s = getStore();
  const intent = await s.findOneWhere(R_INTENTS, { empresa_id: company, id: Number(settlement.payment_intent_id) }, tx);
  if (!intent) throw new HttpError(409, 'Liquidação sem pagamento.');
  const order = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: company, id: Number(intent.order_id) }, tx);
  // Unconverted/historical provider imports remain operational evidence only;
  // the period gate still requires an unequivocal financial link.
  if (!order?.venda_id) return;
  const charge = intent.cobranca_id && await s.findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: company, id: Number(intent.cobranca_id) }, tx);
  const title = charge?.lancamento_id && await s.findOneWhere(getResource('lancamentos_financeiros')!, { empresa_id: company, id: Number(charge.lancamento_id) }, tx);
  if (!title || title.referencia_tipo !== 'venda' || Number(title.referencia_id) !== Number(order.venda_id) ||
      title.tipo !== 'receita' || title.status !== 'confirmado' || Math.round(Number(title.valor) * 100) !== Number(settlement.gross_amount) || !bank.data || !bank.conta_id)
    throw new HttpError(409, 'Conciliação exige título confirmado, valor bruto, conta e data bancária comprovados.');
  if (!await s.findOneWhere(getResource('contas_financeiras')!, { empresa_id: company, id: Number(bank.conta_id) }, tx))
    throw new HttpError(404, 'Conta financeira do extrato não pertence à empresa.');
  const fees = ['provider_fee','gateway_fee','installment_fee','antifraud_fee'].reduce((n, k) => n + Number(settlement[k]), 0);
  if (!Number.isSafeInteger(fees) || fees < 0 || fees > Number(settlement.gross_amount)) throw new HttpError(409, 'Taxas de liquidação inválidas.');
  const netBeforeReversals = (Number(settlement.gross_amount) - fees) / 100;
  const reversals = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 1000,
    filter: { empresa_id: company, referencia_tipo: 'estorno', referencia_id: Number(title.id), status: 'confirmado' } }, tx);
  if (reversals.total !== reversals.rows.length) throw new HttpError(409, 'Reversões excedem limite seguro.');
  const totalRefund = reversals.rows.reduce((n, r) => n + Math.round(Number(r.valor) * 100), 0);
  if (totalRefund !== Number(settlement.refund_amount)) throw new HttpError(409, 'Refund financeiro não corresponde ao valor da liquidação.');
  for (const reversal of reversals.rows) {
    if (Number(reversal.conta_id) !== Number(bank.conta_id) || String(reversal.data_baixa).slice(0, 10) !== String(bank.data).slice(0, 10))
      await s.update(getResource('lancamentos_financeiros')!, Number(reversal.id), { conta_id: bank.conta_id, data_baixa: String(bank.data).slice(0, 10) }, tx);
  }

  const disputes = await s.list(R_DISPUTES, { page: 1, pageSize: 1000, filter: { empresa_id: company, payment_intent_id: Number(intent.id) } }, tx);
  if (disputes.total !== disputes.rows.length) throw new HttpError(409, 'Disputas excedem limite seguro.');
  let chargebacks = 0;
  for (const dispute of disputes.rows) {
    const expense = await s.findOneWhere(getResource('lancamentos_financeiros')!, { empresa_id: company, referencia_tipo: 'chargeback_dispute', referencia_id: Number(dispute.id), status: 'confirmado' }, tx);
    if (!expense) continue;
    chargebacks += Math.round(Number(expense.valor) * 100);
    if (Number(expense.conta_id) !== Number(bank.conta_id) || String(expense.data_baixa).slice(0, 10) !== String(bank.data).slice(0, 10))
      await s.update(getResource('lancamentos_financeiros')!, Number(expense.id), { conta_id: bank.conta_id, data_baixa: String(bank.data).slice(0, 10) }, tx);
  }
  if (chargebacks !== Number(settlement.chargeback_amount)) throw new HttpError(409, 'Chargeback financeiro não corresponde à liquidação.');
  if (Math.round(Number(title.valor_liquido) * 100) === Math.round(netBeforeReversals * 100) && Number(title.conta_id) === Number(bank.conta_id) && String(title.data_baixa).slice(0, 10) === String(bank.data).slice(0, 10)) return;
  await s.update(getResource('lancamentos_financeiros')!, Number(title.id), {
    valor_liquido: netBeforeReversals, taxa_pct: fees * 100 / Number(settlement.gross_amount),
    conta_id: bank.conta_id, data_baixa: String(bank.data).slice(0, 10),
  }, tx);
  await s.update(R_GATEWAY_COBRANCAS, Number(charge.id), { conta_id: bank.conta_id }, tx);
  // Refund/chargeback expenses are separate canonical entries; do NOT deduct
  // them twice from the revenue. Their references are assigned by their engine.
  await s.audit({ empresa_id: company, usuario_id: null, usuario: 'Payment Engine', acao: 'ajuste', recurso: 'lancamentos_financeiros',
    registro_id: Number(title.id), descricao: 'MDR e data de repasse comprovados por extrato',
    dados: { settlement_id: settlement.id, gross_amount: settlement.gross_amount, fees, net_before_reversals: netBeforeReversals } }, tx);
}
