import { efetuarBaixa } from '../../../server/src/financeiro';
import { cifrarSegredo, decifrarSegredo } from '../../../server/src/segredos';
import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { HttpError } from '../../../server/src/errors';
import { R_GATEWAY_COBRANCAS, reverterFinanceiroDaCobranca } from '../../../server/src/gateway';
import type { Row, Tx } from '../../../server/src/store';
import {
  PaymentError,
  METHODS,
  canFallback,
  minorUnits,
  transition,
  type PaymentMethod,
  type PaymentStatus,
  type ProviderCode,
} from '../domain/payment';
import type { PaymentInput, PaymentResult, RefundEvidence } from '../providers/payment-provider';
import { account, candidates } from '../application/configuration';
import { recordLatePayment, resolveLateRefund } from '../application/late-reviews';
import { R_INTENTS, R_ATTEMPTS, R_OPERATIONS, R_REFUNDS, R_SETTLEMENTS, R_DISPUTES, R_PAYOUTS } from '../infrastructure/resources';
import { locked, retrySerialization } from '../infrastructure/locking';
const now = () => new Date().toISOString();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const requireKey = (key: string) => {
  if (!/^[\w:.-]{8,120}$/.test(key)) throw new HttpError(400, 'Chave de idempotência inválida.');
  return key;
};
export class PaymentOrchestrator {
  async intent(empresaId: number, id: number, tx?: Tx): Promise<Row> {
    const r = await getStore().findOneWhere(R_INTENTS, { empresa_id: empresaId, id }, tx);
    if (!r) throw new HttpError(404, 'Pagamento não encontrado.');
    return r;
  }
  async createForOrder(empresaId: number, orderId: number, method: PaymentMethod, key: string, customer: { taxId?: string } = {}) {
    requireKey(key);
    if (!METHODS.includes(method)) throw new HttpError(400, 'Método inválido.');
    const s = getStore();
    const claim = await retrySerialization(() => locked(empresaId, `order:${orderId}`, async (tx) => {
      const order = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, id: orderId }, tx);
      if (!order) throw new HttpError(404, 'Pedido não encontrado.');
      const existing = await s.findOneWhere(R_INTENTS, { empresa_id: empresaId, order_id: orderId }, tx);
      if (existing) {
        if (existing.method !== method || existing.idempotency_key !== key)
          throw new HttpError(409, 'Pedido já possui intenção de pagamento.');
        return { intent: existing, fresh: false, order };
      }
      if (!['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO'].includes(String(order.estado)))
        throw new HttpError(409, 'Pedido não está disponível para pagamento.');
      // Total is the immutable server-calculated checkout snapshot, not request amount.
      const sale = await s.findOneWhere(getResource('sales')!, { empresa_id: empresaId, id: String(order.sale_id) }, tx);
      const amount = minorUnits(Number(order.total));
      if (!sale || Number(sale.amount_cents) !== amount || sale.status !== 'PENDING')
        throw new HttpError(409, 'Total do pedido divergente.');
      if (order.expira_em && new Date(order.expira_em).getTime() <= Date.now()) throw new HttpError(409, 'Pedido expirado.');
      const intent = await s.insert(
        R_INTENTS,
        {
          empresa_id: empresaId,
          order_id: orderId,
          customer_ref: String(order.sale_id),
          channel: 'OWN_STORE',
          currency: String(sale.currency || 'BRL'),
          minor_units: 2,
          amount,
          method,
          status: 'CREATED',
          idempotency_key: key,
          correlation_id: randomUUID(),
          metadata: {},
          created_at: now(),
          updated_at: now(),
        },
        tx
      );
      return { intent, fresh: true, order };
    }));
    if (!claim.fresh) return { intent: claim.intent, idempotent: true };
    const i = claim.intent;
    // Period fence precedes the row lock even for short, local-only status
    // updates. A late webhook must not be overwritten by a failed create.
    const updatePendingIntent = async (patch: Record<string, unknown>) => retrySerialization(() => locked(empresaId, `intent:${i.id}`, async (tx) => {
      const current = await this.intent(empresaId, Number(i.id), tx);
      if (!['CREATED', 'PENDING'].includes(String(current.status))) return current;
      return getStore().update(R_INTENTS, Number(i.id), patch, tx);
    }, 'read committed'));
    const routes = await candidates({
      empresaId,
      method,
      amount: Number(i.amount),
      currency: i.currency,
      country: 'BR',
      channel: i.channel,
      installments: 1,
    });
    if (!routes.length) {
      await updatePendingIntent({ status: 'FAILED', updated_at: now() });
      throw new HttpError(409, 'Método indisponível no Payment Engine.');
    }
    const payer = claim.order.comprador || {};
    for (let n = 0; n < routes.length; n++) {
      const route = routes[n];
      if (n > 0 && route.conditions.fallback !== true) break;
      const operationKey = hash(`${empresaId}:create:${i.id}:${n}:${route.provider.code}`);
      const attempt = await s.insert(R_ATTEMPTS, {
        empresa_id: empresaId,
        payment_intent_id: i.id,
        provider: route.provider.code,
        method,
        requested_amount: i.amount,
        authorized_amount: 0,
        captured_amount: 0,
        refunded_amount: 0,
        status: 'CREATED',
        started_at: now(),
        idempotency_key: operationKey,
        correlation_id: i.correlation_id,
        safe_reference: { rule_id: route.ruleId, fallback_from: n > 0 ? routes[n - 1].provider.code : null },
      });
      await updatePendingIntent({ provider: route.provider.code, status: 'PENDING', updated_at: now() });
      try {
        const input: PaymentInput = {
          amount: Number(i.amount),
          currency: i.currency,
          method,
          reference: `payment:${empresaId}:${i.id}`,
          email: String(payer.email || ''),
          customerName: String(payer.nome || ''),
          taxId: route.capability.requiredCustomerFields.includes('tax_id') ? customer.taxId : undefined,
          installments: 1,
          expiresAt: claim.order.expira_em ? new Date(claim.order.expira_em).toISOString() : undefined,
        };
        await s.update(R_ATTEMPTS, Number(attempt.id), { request_cifradas: cifrarSegredo(JSON.stringify(input)) });
        const result =
          route.context.credentials.capture_mode === 'manual' && route.capability.authorize
            ? await route.provider.authorize({ ...route.context, operationKey }, input)
            : await route.provider.createPaymentIntent({ ...route.context, operationKey }, input);
        // Persist reference before applying state. No provider payload/card/token is retained.
        await s.update(R_ATTEMPTS, Number(attempt.id), {
          provider_transaction_id: result.reference,
          status: 'PENDING',
          safe_reference: { ...attempt.safe_reference, action: result.action || null },
        });
        await this.bridge(empresaId, i, attempt, route.provider.legacyId, result);
        await this.apply(empresaId, Number(i.id), result);
        return { intent: await this.intent(empresaId, Number(i.id)), action: result.action, idempotent: false };
      } catch (e) {
        const ambiguous = !(e instanceof PaymentError) || e.ambiguous;
        const persisted = await s.findOneWhere(R_ATTEMPTS, { empresa_id: empresaId, id: Number(attempt.id) });
        await s.update(R_ATTEMPTS, Number(attempt.id), {
          status: persisted?.provider_transaction_id ? persisted.status : ambiguous ? 'PENDING' : 'FAILED',
          failure_code: e instanceof PaymentError ? e.code : 'UNKNOWN_PROVIDER_ERROR',
          failure_message: 'Falha normalizada; consultar correlação.',
          completed_at: persisted?.provider_transaction_id ? persisted.completed_at : ambiguous ? null : now(),
        });
        await this.audit(empresaId, Number(i.id), ambiguous ? 'payment uncertain' : 'payment attempt failed', {
          attempt_id: attempt.id,
          provider: route.provider.code,
          correlation_id: i.correlation_id,
        });
        if (!canFallback(e) || n === routes.length - 1) {
          if (!ambiguous) await updatePendingIntent({ status: 'FAILED', updated_at: now() });
          // Unknown writes are retained pending. Do NOT release stock or start another provider.
          if (ambiguous) return { intent: await this.intent(empresaId, Number(i.id)), idempotent: false };
          throw new HttpError(502, 'Provider recusou o pagamento. Consulte a transação.');
        }
      }
    }
    await updatePendingIntent({ status: 'FAILED', updated_at: now() });
    throw new HttpError(502, 'Nenhuma rota elegível para pagamento.');
  }
  private async bridge(empresaId: number, i: Row, a: Row, provider: string, r: PaymentResult) {
    const s = getStore();
    await retrySerialization(() => locked(empresaId, `intent:${i.id}`, async (tx) => {
      const current = await this.intent(empresaId, Number(i.id), tx);
      if (current.cobranca_id) return;
      const charge = await s.insert(
        R_GATEWAY_COBRANCAS,
        {
          empresa_id: empresaId,
          provider,
          metodo:
            ({ PIX: 'pix', BOLETO: 'boleto', CREDIT_CARD: 'cartao_credito', DEBIT_CARD: 'cartao_debito' } as Record<string, string>)[
              i.method
            ] || 'manual',
          valor: Number(i.amount) / 100,
          valor_liquido: Number(i.amount) / 100,
          taxa_pct: 0,
          parcelas: 1,
          status: 'pendente',
          provider_ref: r.reference,
          idempotency_key: i.idempotency_key,
          copia_cola: r.action?.type === 'PIX' ? r.action.code : null,
          qr_code: r.action?.qrCode || null,
          linha_digitavel: r.action?.type === 'BOLETO' ? r.action.code : null,
          expires_em: r.action?.expiresAt || null,
          payload: null,
        },
        tx
      );
      await s.update(R_INTENTS, Number(i.id), { cobranca_id: charge.id }, tx);
      await s.update(getResource('commerce_pedidos')!, Number(i.order_id), { cobranca_id: charge.id }, tx);
    }));
  }
  async apply(empresaId: number, intentId: number, result: PaymentResult, source: 'event' | 'provider-refresh' = 'event') {
    const s = getStore();
    // Flush a previously captured payment before its reversal can overtake the
    // Commerce/financial delivery. The provider write is never retried here.
    if (Number(result.refunded || 0) > 0) {
      const before = await this.intent(empresaId, intentId);
      if (before.status === 'PAID' && before.cobranca_id) await this.deliverToCommerce(empresaId, intentId);
    }
    await retrySerialization(() => locked(empresaId, `intent:${intentId}`, async (tx) => {
      const i = await this.intent(empresaId, intentId, tx);
      const attempts = await s.list(
        R_ATTEMPTS,
        { page: 1, pageSize: 2, filter: { empresa_id: empresaId, payment_intent_id: intentId, provider_transaction_id: result.reference } },
        tx
      );
      const a = attempts.rows[0];
      if (!a) throw new HttpError(409, 'Referência não pertence à intenção.');
      if ((result.amount != null && result.amount !== Number(i.amount)) || (result.currency && result.currency !== i.currency))
        throw new HttpError(409, 'Valor/moeda do provider diverge do pedido.');
      let status: PaymentStatus;
      let lateRecovery = false;
      try {
        status = transition(i.status, result.status);
      } catch {
        // A terminal intent cannot be resurrected by an event. Only a direct,
        // authenticated provider refresh with exact money and a CLOSED order
        // can establish that funds arrived after cancellation/expiration.
        const order = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, id: Number(i.order_id) }, tx);
        if (source !== 'provider-refresh' || !['EXPIRED', 'CANCELED'].includes(String(i.status)) ||
            result.status !== 'PAID' || result.amount !== Number(i.amount) || result.currency !== i.currency ||
            !order || !['EXPIRADO', 'CANCELADO'].includes(String(order.estado))) return;
        status = 'PAID';
        lateRecovery = true;
      }
      const total = Number(i.amount);
      const previousRefund = Number(a.refunded_amount || 0);
      // A terminal label alone is not proof of the amount refunded. Providers
      // must return the cumulative amount, even when claiming a full refund.
      const refunded = result.refunded ?? previousRefund;
      if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(previousRefund) || previousRefund < 0 ||
          !Number.isSafeInteger(refunded) || refunded < previousRefund || refunded > total ||
          (status === 'REFUNDED' && (result.refunded == null || refunded !== total)) ||
          (status === 'PARTIALLY_REFUNDED' && (result.refunded == null || refunded <= 0 || refunded >= total)) ||
          (['PAID', 'CAPTURED'].includes(status) && refunded > 0))
        throw new HttpError(409, 'Reembolso divergente ou sem valor suficiente para conciliação.');
      const priorSettlement = await s.findOneWhere(R_SETTLEMENTS, { empresa_id: empresaId, payment_intent_id: intentId, provider_reference: result.reference }, tx);
      if (refunded + Number(priorSettlement?.chargeback_amount || 0) > total) throw new HttpError(409, 'Refund e chargeback excedem o valor capturado.');
      const refundDelta = refunded - previousRefund;
      if (refundDelta > 0 && i.cobranca_id) {
        const charge = await s.findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: empresaId, id: Number(i.cobranca_id) }, tx);
        if (charge) await reverterFinanceiroDaCobranca(charge, refundDelta / 100, { id: null, name: 'Payment Engine' }, tx);
      }
      await s.update(
        R_ATTEMPTS,
        Number(a.id),
        {
          status,
          authorized_amount: ['AUTHORIZED', 'CAPTURED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(status)
            ? i.amount
            : a.authorized_amount,
          captured_amount: ['CAPTURED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(status) ? i.amount : a.captured_amount,
          refunded_amount: refunded,
          completed_at: ['PAID', 'REFUNDED', 'FAILED', 'CANCELED'].includes(status) ? now() : null,
        },
        tx
      );
      await s.update(R_INTENTS, intentId, { status, updated_at: now() }, tx);
      // Disputes/chargebacks have no equivalent legacy gateway status. Preserve
      // the last charge state instead of falsely resetting it to 'pendente'.
      const legacyStatus: Partial<Record<PaymentStatus, string>> = {
        CREATED: 'pendente', PENDING: 'pendente', PENDING_MANUAL_CONFIRMATION: 'pendente', REQUIRES_ACTION: 'pendente',
        AUTHORIZED: 'autorizada', CAPTURE_PENDING: 'autorizada', CAPTURED: 'paga', PAID: 'paga', PARTIALLY_REFUNDED: 'paga',
        REFUNDED: 'estornada', CANCELED: 'cancelada', EXPIRED: 'expirada', FAILED: 'falhou',
      };
      if (i.cobranca_id && legacyStatus[status])
        await s.update(R_GATEWAY_COBRANCAS, Number(i.cobranca_id), { status: legacyStatus[status] }, tx);
      if (['CAPTURED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK'].includes(status)) {
        const existing = await s.findOneWhere(
          R_SETTLEMENTS,
          { empresa_id: empresaId, provider: i.provider, provider_reference: result.reference },
          tx
        );
        const recordedDispute = await s.findOneWhere(R_DISPUTES, { empresa_id: empresaId, payment_intent_id: intentId, provider_reference: result.reference }, tx);
        const resolvedDispute = recordedDispute && ['WON', 'LOST', 'CLOSED'].includes(String(recordedDispute.status)) && Number(recordedDispute.amount) > 0;
        const needsReview = (!!recordedDispute || ['DISPUTED', 'CHARGEBACK'].includes(status)) && !resolvedDispute;
        if (!existing)
          await s.insert(
            R_SETTLEMENTS,
            {
              empresa_id: empresaId,
              payment_intent_id: intentId,
              provider: i.provider,
              provider_reference: result.reference,
              gross_amount: i.amount,
              refund_amount: refunded,
              chargeback_amount: 0, // nenhuma quantia de chargeback foi comprovada pelo status
              dispute_review_required: needsReview,
              status: needsReview ? 'DIVERGENT' : 'UNRECONCILED',
              evidence: {},
              created_at: now(),
              updated_at: now(),
            },
            tx
          );
        else {
          const chargedBack = Number(existing.chargeback_amount ?? 0);
          // Mesmo uma disputa sem débito confirmado impede conciliação automática.
          const reviewRequired = existing.dispute_review_required === true || needsReview;
          const changed = refunded !== Number(existing.refund_amount || 0) || reviewRequired !== (existing.dispute_review_required === true);
          if (changed) {
            // A later refund/chargeback invalidates the imported reconciliation;
            // preserve the historical bank link, but never claim it is still matched.
            if (existing.payout_id) {
              const payout = await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, id: Number(existing.payout_id) }, tx);
              if (payout) {
                // Sempre bloqueia/atualiza o repasse antes da liquidação, até se
                // já estava divergente: uma correção concorrente pode ter
                // acabado de torná-lo conciliável desde a leitura anterior.
                await s.update(R_PAYOUTS, Number(payout.id), { status: 'DIVERGENT', updated_at: now() }, tx);
                await s.audit({ empresa_id: empresaId, usuario_id: null, usuario: 'Payment Engine', acao: 'ajuste', recurso: 'payment_payouts', registro_id: Number(payout.id),
                  descricao: 'Repasse divergente após reembolso ou chargeback', dados: { antes: { status: payout.status }, depois: { status: 'DIVERGENT' } } }, tx);
              }
            }
            await s.update(R_SETTLEMENTS, Number(existing.id), {
              refund_amount: refunded, chargeback_amount: chargedBack, dispute_review_required: reviewRequired,
              status: existing.payout_id || reviewRequired ? 'DIVERGENT' : 'UNRECONCILED', updated_at: now(),
            }, tx);
          }
        }
      }
      if (['DISPUTED', 'CHARGEBACK'].includes(status)) {
        const d = await s.findOneWhere(R_DISPUTES, { empresa_id: empresaId, provider_reference: result.reference }, tx);
        if (!d)
          await s.insert(
            R_DISPUTES,
            {
              empresa_id: empresaId,
              payment_intent_id: intentId,
              provider_reference: result.reference,
              provider: a.provider,
              origin: 'ENGINE',
              version: 0,
              status: 'DISPUTE_OPENED',
              amount: null,
              amount_source: 'UNKNOWN',
              reason: 'Provider sinalizou disputa ou chargeback; valor e resultado requerem revisão.',
              created_at: now(),
              updated_at: now(),
            },
            tx
          );
      }
      // Persist the exception in the same transaction as the provider fact.
      // Do not rely on the later asynchronous Commerce delivery: a refund can
      // race that delivery, and a crash must not lose the review.
      if ((status === 'PAID' || status === 'REFUNDED') && i.cobranca_id) {
        const order = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, id: Number(i.order_id) }, tx);
        if (order && ['EXPIRADO', 'CANCELADO'].includes(String(order.estado))) {
          if (status === 'PAID') await recordLatePayment(empresaId, order, Number(i.cobranca_id), tx);
          else await resolveLateRefund(empresaId, order, tx);
        }
      }
      if (lateRecovery) await this.audit(empresaId, intentId, 'late payment confirmed by provider refresh',
        { previous_status: i.status, correlation_id: i.correlation_id }, tx);
      await this.audit(
        empresaId,
        intentId,
        `payment ${status.toLowerCase()}`,
        { attempt_id: a.id, provider: i.provider, correlation_id: i.correlation_id },
        tx
      );
    }));
    await this.deliverToCommerce(empresaId, intentId);
  }
  async deliverToCommerce(empresaId: number, intentId: number) {
    const i = await this.intent(empresaId, intentId);
    const intention = ({ PAID: 'paga', PARTIALLY_REFUNDED: 'paga', CANCELED: 'cancelada', EXPIRED: 'expirada', REFUNDED: 'estornada' } as const)[i.status as 'PAID'];
    if (!intention || !i.cobranca_id) return;
    const { confirmarPagamentoCobranca } = await import('../../../server/src/commerce/pedidos');
    await confirmarPagamentoCobranca({ empresaId, cobrancaId: Number(i.cobranca_id), intencao: intention });
    if (['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(String(i.status)))
      await retrySerialization(() => locked(empresaId, `finance:${intentId}`, async (tx) => {
        // The callback may have been overtaken by a refund. Re-read the intent
        // and charge in the same serializable transaction as the financial
        // posting; never settle a title from a stale PAID snapshot.
        const current = await this.intent(empresaId, intentId, tx);
        const charge = await getStore().findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: empresaId, id: Number(i.cobranca_id) }, tx);
        if (!['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(String(current.status)) || !['paga', 'estornada'].includes(String(charge?.status))) return;
        const attempt = await getStore().findOneWhere(R_ATTEMPTS, { empresa_id: empresaId, payment_intent_id: intentId, provider: current.provider }, tx);
        // A terminal intent label alone is not evidence of captured/refunded
        // money. Late callback delivery must not turn an unproved label into AR.
        if (!attempt || Number(attempt.captured_amount) !== Number(current.amount) ||
            (current.status === 'REFUNDED' && Number(attempt.refunded_amount) !== Number(current.amount)) ||
            (current.status === 'PARTIALLY_REFUNDED' && !(Number(attempt.refunded_amount) > 0 && Number(attempt.refunded_amount) < Number(current.amount)))) return;
        const order = await getStore().findOneWhere(
          getResource('commerce_pedidos')!,
          { empresa_id: empresaId, id: Number(i.order_id) },
          tx
        );
        if (!order?.venda_id) return;
        const title = await getStore().findOneWhere(
          getResource('lancamentos_financeiros')!,
          { empresa_id: empresaId, referencia_tipo: 'venda', referencia_id: Number(order.venda_id) },
          tx
        );
        if (!title) return;
        if (minorUnits(Number(title.valor)) !== Number(i.amount)) throw new HttpError(409, 'Financeiro divergente: revisão necessária.');
        await getStore().update(
          R_GATEWAY_COBRANCAS,
          Number(i.cobranca_id),
          { venda_id: Number(order.venda_id), lancamento_id: Number(title.id) },
          tx
        );
        if (title.status === 'pendente')
          await efetuarBaixa(
            { id: null, name: 'Payment Engine' },
            Number(title.id),
            { valor: Number(i.amount) / 100, origem: 'webhook', nota: `Payment Intent ${intentId} / ${i.correlation_id}` },
            tx
          );
        const expenses = await getStore().list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 1000,
          filter: { empresa_id: empresaId, referencia_tipo: 'estorno', referencia_id: Number(title.id), status: 'confirmado' } }, tx);
        if (expenses.total !== expenses.rows.length) throw new HttpError(409, 'Reversões excedem limite seguro de conciliação.');
        const reversed = expenses.rows.reduce((n, e) => n + Math.round(Number(e.valor) * 100), 0);
        const missing = Number(attempt?.refunded_amount || 0) - reversed;
        if (missing > 0 && charge) await reverterFinanceiroDaCobranca(charge, missing / 100, { id: null, name: 'Payment Engine' }, tx);
      }));
  }
  /** Persiste a evidência do refund específico antes de concluir qualquer operação local. */
  private async recordRefundEvidence(empresaId: number, id: number, operationId: number, provider: string,
    paymentReference: string, expectedAmount: number, proof: RefundEvidence | undefined): Promise<boolean> {
    if (!proof || typeof proof.reference !== 'string' || !proof.reference.trim() || proof.reference !== proof.reference.trim() ||
        proof.reference.length > 160 || Array.from(proof.reference).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || proof.paymentReference !== paymentReference ||
        !Number.isSafeInteger(proof.amount) || proof.amount !== expectedAmount || !['PENDING', 'SUCCEEDED'].includes(proof.status)) return false;
    const s = getStore();
    return retrySerialization(() => locked(empresaId, `intent:${id}`, async (tx) => {
      const current = await this.intent(empresaId, id, tx);
      const op = await s.findOneWhere(R_OPERATIONS, { empresa_id: empresaId, id: operationId, payment_intent_id: id, operation: 'refund' }, tx);
      const refund = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, operation_id: operationId, payment_intent_id: id }, tx);
      if (!op || !refund || current.provider !== provider || Number(op.amount) !== expectedAmount ||
          (!['PROCESSING', 'UNCERTAIN', 'SUCCEEDED'].includes(String(op.status))) ||
          (op.status !== 'SUCCEEDED' && Number(current.active_operation) !== operationId))
        throw new HttpError(409, 'Operação de refund mudou durante a confirmação.');
      if (refund.provider_refund_id && (refund.provider_refund_id !== proof.reference || refund.provider !== provider))
        throw new HttpError(409, 'Identidade do refund mudou; requer revisão.');
      const used = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, provider, provider_refund_id: proof.reference }, tx);
      if (used && Number(used.id) !== Number(refund.id)) throw new HttpError(409, 'Refund do provider já vinculado a outra operação.');
      const proofStatus = refund.provider_refund_status === 'SUCCEEDED' ? 'SUCCEEDED' : proof.status;
      if (refund.provider_refund_id !== proof.reference || refund.provider_refund_status !== proofStatus) {
        await s.update(R_REFUNDS, Number(refund.id), { provider, provider_refund_id: proof.reference, provider_refund_status: proofStatus, updated_at: now() }, tx);
        await this.audit(empresaId, id, 'refund evidence recorded', { operation_id: operationId, provider, proof_status: proofStatus }, tx);
      }
      return true;
    }, 'read committed'));
  }

  /** A conclusão só limpa a operação que ainda possui o claim deste pagamento. */
  private async finishOperation(empresaId: number, id: number, operationId: number, status: string, paymentReference: string): Promise<boolean> {
    const s = getStore();
    return retrySerialization(() => locked(empresaId, `intent:${id}`, async (tx) => {
      const current = await this.intent(empresaId, id, tx);
      const op = await s.findOneWhere(R_OPERATIONS, { empresa_id: empresaId, id: operationId, payment_intent_id: id }, tx);
      if (!op) throw new HttpError(409, 'Operação não encontrada.');
      if (op.status === 'SUCCEEDED') return true;
      if (!['PROCESSING', 'UNCERTAIN'].includes(String(op.status)) || Number(current.active_operation) !== operationId) return false;
      if (op.operation === 'refund') {
        const refund = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, operation_id: operationId, payment_intent_id: id }, tx);
        const attempt = await s.findOneWhere(R_ATTEMPTS, { empresa_id: empresaId, payment_intent_id: id, provider_transaction_id: paymentReference }, tx);
        if (!refund || refund.provider !== current.provider || !refund.provider_refund_id || refund.provider_refund_status !== 'SUCCEEDED' ||
            !attempt || Number(attempt.refunded_amount) < Number(op.result?.baseline_refunded || 0) + Number(op.amount)) return false;
        await s.update(R_REFUNDS, Number(refund.id), { status: 'COMPLETED', updated_at: now() }, tx);
      }
      const released = await s.tryUpdateIf(R_INTENTS, id, { empresa_id: empresaId, active_operation: operationId }, { active_operation: null }, tx);
      if (!released) throw new HttpError(409, 'Operação mudou durante a confirmação.');
      await s.update(R_OPERATIONS, operationId, { status: 'SUCCEEDED', result: { ...op.result, status }, updated_at: now() }, tx);
      await this.audit(empresaId, id, `${op.operation} confirmed`, { operation_id: operationId }, tx);
      return true;
    }, 'read committed'));
  }

  async mutate(empresaId: number, id: number, operation: 'refund' | 'capture' | 'cancel' | 'manual-confirm', key: string, amount?: number) {
    requireKey(key);
    const s = getStore();
    const claim = await locked(empresaId, `intent:${id}`, async (tx) => {
      const i = await this.intent(empresaId, id, tx);
      const requested = amount ?? Number(i.amount);
      if (!Number.isSafeInteger(requested) || requested <= 0) throw new HttpError(400, 'Valor em unidades mínimas inválido.');
      const requestHash = hash(`${operation}:${requested}`);
      const old = await s.findOneWhere(R_OPERATIONS, { empresa_id: empresaId, payment_intent_id: id, operation, idempotency_key: key }, tx);
      if (old) {
        if (old.request_hash !== requestHash) throw new HttpError(409, 'Chave reutilizada com dados diferentes.');
        if (old.status !== 'SUCCEEDED') throw new HttpError(409, 'Operação já solicitada; aguarde reconciliação.');
        if (operation === 'refund') {
          const evidence = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, payment_intent_id: id, operation_id: old.id }, tx);
          if (!evidence || evidence.provider !== i.provider || !evidence.provider_refund_id || evidence.provider_refund_status !== 'SUCCEEDED')
            throw new HttpError(409, 'Refund histórico sem prova individual; exige revisão e não será repetido.');
        }
        return { i, op: old, fresh: false, attempt: null };
      }
      if (i.active_operation) throw new HttpError(409, 'Pagamento possui operação em andamento.');
      const attempts = await s.list(
        R_ATTEMPTS,
        { page: 1, pageSize: 1, sort: 'id', dir: 'desc', filter: { empresa_id: empresaId, payment_intent_id: id } },
        tx
      );
      const a = attempts.rows[0];
      if (!a?.provider_transaction_id) throw new HttpError(409, 'Referência do provider indisponível.');
      const settlement = await s.findOneWhere(R_SETTLEMENTS, { empresa_id: empresaId, payment_intent_id: id, provider_reference: a.provider_transaction_id }, tx);
      if (
        operation === 'refund' &&
        (!['PAID', 'CAPTURED', 'PARTIALLY_REFUNDED'].includes(i.status) ||
          requested > Number(a.captured_amount) - Number(a.refunded_amount) - Number(settlement?.chargeback_amount || 0))
      )
        throw new HttpError(409, 'Valor excede saldo reembolsável.');
      if (operation === 'capture' && i.status !== 'AUTHORIZED') throw new HttpError(409, 'Pagamento não autorizado.');
      if (operation === 'capture' && requested !== Number(i.amount)) throw new HttpError(409, 'Captura parcial não é suportada para este pedido.');
      if ((operation === 'cancel' || operation === 'manual-confirm') && requested !== Number(i.amount)) throw new HttpError(400, 'Esta operação não aceita valor parcial.');
      if (operation === 'cancel' && !['PENDING', 'AUTHORIZED', 'REQUIRES_ACTION', 'PENDING_MANUAL_CONFIRMATION'].includes(i.status))
        throw new HttpError(409, 'Pagamento não cancelável.');
      if (operation === 'manual-confirm' && (i.provider !== 'MANUAL' || i.status !== 'PENDING_MANUAL_CONFIRMATION'))
        throw new HttpError(409, 'Pagamento não aguarda confirmação manual.');
      const op = await s.insert(
        R_OPERATIONS,
        {
          empresa_id: empresaId,
          payment_intent_id: id,
          operation,
          idempotency_key: key,
          request_hash: requestHash,
          amount: requested,
          status: 'PROCESSING',
          result: { baseline_refunded: Number(a.refunded_amount || 0) },
          created_at: now(),
          updated_at: now(),
        },
        tx
      );
      await s.update(R_INTENTS, id, { active_operation: op.id }, tx);
      if (operation === 'refund')
        await s.insert(
          R_REFUNDS,
          {
            empresa_id: empresaId,
            payment_intent_id: id,
            operation_id: op.id,
            amount: requested,
            status: 'REQUESTED',
            created_at: now(),
            updated_at: now(),
          },
          tx
        );
      await this.audit(empresaId, id, `${operation} requested`, { operation_id: op.id, amount: requested }, tx);
      return { i, op, fresh: true, attempt: a };
    }, 'read committed');
    if (!claim.fresh) return claim.op.result;
    const { i, op, attempt } = claim;
    let effectStarted = false;
    try {
      const ctx = await account(empresaId, i.provider as ProviderCode, hash(`${empresaId}:${operation}:${id}:${op.id}`));
      const cap = ctx.capabilities.find((c) => c.method === i.method);
      if (operation === 'refund' && (!cap?.refund || (Number(op.amount) < Number(i.amount) && !cap.partialRefund)))
        throw new PaymentError('INVALID_PAYMENT_METHOD');
      if (operation === 'capture' && !cap?.capture) throw new PaymentError('INVALID_PAYMENT_METHOD');
      if (operation === 'cancel' && i.provider !== 'MANUAL' && !cap?.cancel) throw new PaymentError('INVALID_PAYMENT_METHOD');
      const ref = String(attempt!.provider_transaction_id);
      // From here an external write (or local manual confirmation) may have
      // happened. Errors must stay UNCERTAIN until reconciled.
      effectStarted = true;
      const result: PaymentResult =
        operation === 'manual-confirm'
          ? { reference: ref, status: 'PAID', amount: Number(i.amount), currency: i.currency }
          : operation === 'refund'
            ? await ctx.provider.refund(ctx.context, ref, Number(op.amount))
            : operation === 'capture'
              ? await ctx.provider.capture(ctx.context, ref, Number(op.amount))
              : i.provider === 'MANUAL'
                ? { reference: ref, status: 'CANCELED' }
                : await ctx.provider.cancel(ctx.context, ref);
      if (operation === 'refund') {
        // O total cumulativo pode incluir outro refund externo. Só a resposta
        // individual do mesmo POST, com pagamento e valor, identifica esta operação.
        await this.recordRefundEvidence(empresaId, id, Number(op.id), String(i.provider), ref, Number(op.amount), result.refundEvidence);
        if (!['REFUNDED', 'PARTIALLY_REFUNDED'].includes(result.status)) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      }
      if (operation === 'cancel' && !['CANCELED', 'EXPIRED'].includes(result.status))
        throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      if (operation === 'capture' && !['CAPTURED', 'PAID'].includes(result.status)) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      await this.apply(empresaId, id, result);
      if (operation === 'refund' && (!Number.isSafeInteger(result.refunded) ||
          Number(result.refunded) < Number(op.result?.baseline_refunded || 0) + Number(op.amount))) {
        // Record any confirmed partial amount above, but do not declare the
        // requested operation complete or repeat its external write.
        throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      }
      if (!await this.finishOperation(empresaId, id, Number(op.id), result.status, ref))
        throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      return { status: result.status };
    } catch (e) {
      const uncertain = effectStarted && (!(e instanceof PaymentError) || e.ambiguous);
      const completed = await retrySerialization(() => locked(empresaId, `intent:${id}`, async (tx) => {
        const current = await this.intent(empresaId, id, tx);
        const actual = await s.findOneWhere(R_OPERATIONS, { empresa_id: empresaId, id: Number(op.id), payment_intent_id: id }, tx);
        if (actual?.status === 'SUCCEEDED') return actual.result;
        if (!actual || !['PROCESSING', 'UNCERTAIN'].includes(String(actual.status)) || Number(current.active_operation) !== Number(op.id))
          throw new HttpError(409, 'Operação mudou durante o processamento; atualize e revise.');
        await s.update(R_OPERATIONS, Number(op.id), {
          status: uncertain ? 'UNCERTAIN' : 'FAILED',
          result: { ...actual.result, code: e instanceof PaymentError ? e.code : 'UNKNOWN_PROVIDER_ERROR' },
          updated_at: now(),
        }, tx);
        if (!uncertain) await s.tryUpdateIf(R_INTENTS, id, { empresa_id: empresaId, active_operation: Number(op.id) }, { active_operation: null }, tx);
        if (operation === 'refund') {
          const refund = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, operation_id: op.id }, tx);
          if (refund) await s.update(R_REFUNDS, Number(refund.id), { status: uncertain ? 'UNCERTAIN' : 'FAILED', updated_at: now() }, tx);
        }
        await this.audit(empresaId, id, `${operation} ${uncertain ? 'uncertain' : 'failed'}`, { operation_id: op.id }, tx);
        return null;
      }, 'read committed'));
      if (completed) return completed;
      throw new HttpError(
        uncertain ? 409 : 422,
        uncertain ? 'Operação pendente de confirmação pelo provider.' : 'Operação não suportada ou recusada.'
      );
    }
  }
  async synchronize(empresaId: number, id: number) {
    const s = getStore();
    const i = await this.intent(empresaId, id);
    if (i.provider === 'MANUAL') return;
    const attempts = await s.list(R_ATTEMPTS, {
      page: 1,
      pageSize: 1,
      sort: 'id',
      dir: 'desc',
      filter: { empresa_id: empresaId, payment_intent_id: id },
    });
    const a = attempts.rows[0];
    if (!a) return;
    const ctx = await account(empresaId, i.provider as ProviderCode, String(a.idempotency_key));
    if (!ctx.capabilities.some((c) => c.method === i.method)) return;
    if (!a.provider_transaction_id) {
      // Recover an interrupted create only on the SAME adapter with the SAME provider idempotency key.
      // Never replay beyond 20h (provider idempotency retention is finite).
      if (!a.request_cifradas || Date.now() - new Date(a.started_at).getTime() > 20 * 3600_000) return;
      const input = JSON.parse(decifrarSegredo(a.request_cifradas) || 'null') as PaymentInput | null;
      if (!input) return;
      const replay = await ctx.provider.createPaymentIntent(ctx.context, input);
      await s.update(R_ATTEMPTS, Number(a.id), {
        provider_transaction_id: replay.reference,
        safe_reference: { ...a.safe_reference, action: replay.action || null },
      });
      await this.bridge(empresaId, i, a, ctx.provider.legacyId, replay);
      await this.apply(empresaId, id, replay);
      return;
    }
    const result = await ctx.provider.getPayment(ctx.context, String(a.provider_transaction_id));
    await this.apply(empresaId, id, result, 'provider-refresh');
    // Uma mudança do total de estornos, por si só, não identifica o refund
    // solicitado: outro operador/provider pode ter estornado em paralelo.
    const current = await this.intent(empresaId, id);
    if (current.active_operation) {
      const op = await s.findOneWhere(R_OPERATIONS, { empresa_id: empresaId, id: Number(current.active_operation), payment_intent_id: id });
      if (!op || !['PROCESSING', 'UNCERTAIN'].includes(String(op.status))) return;
      if (op.operation === 'refund') {
        const refund = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, operation_id: op.id, payment_intent_id: id });
        if (!refund?.provider_refund_id || refund.provider !== current.provider) return;
        if (refund.provider_refund_status === 'PENDING' && ctx.provider.getRefund) {
          const proof = await ctx.provider.getRefund(ctx.context, String(a.provider_transaction_id), String(refund.provider_refund_id));
          await this.recordRefundEvidence(empresaId, id, Number(op.id), String(current.provider), String(a.provider_transaction_id), Number(op.amount), proof);
        }
        if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(result.status) && Number.isSafeInteger(result.refunded) &&
            Number(result.refunded) >= Number(op.result?.baseline_refunded || 0) + Number(op.amount))
          await this.finishOperation(empresaId, id, Number(op.id), result.status, String(a.provider_transaction_id));
      } else {
        const confirmed = op.operation === 'capture' ? ['PAID', 'CAPTURED'].includes(result.status) :
          op.operation === 'cancel' ? result.status === 'CANCELED' : false;
        if (confirmed) await this.finishOperation(empresaId, id, Number(op.id), result.status, String(a.provider_transaction_id));
      }
    }
  }
  async audit(empresaId: number, id: number, event: string, data: Record<string, unknown>, tx?: Tx) {
    await getStore().audit(
      {
        empresa_id: empresaId,
        usuario_id: null,
        usuario: 'Payment Engine',
        acao: 'ajuste',
        recurso: 'payment_intents',
        registro_id: id,
        descricao: event,
        dados: data,
      },
      tx
    );
  }
}
export const paymentEngine = new PaymentOrchestrator();
