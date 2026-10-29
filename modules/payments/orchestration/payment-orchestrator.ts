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
import type { PaymentInput, PaymentResult } from '../providers/payment-provider';
import { account, candidates } from '../application/configuration';
import { R_INTENTS, R_ATTEMPTS, R_OPERATIONS, R_REFUNDS, R_SETTLEMENTS, R_DISPUTES, R_PAYOUTS } from '../infrastructure/resources';
import { locked } from '../infrastructure/locking';
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
    const claim = await locked(empresaId, `order:${orderId}`, async (tx) => {
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
    });
    if (!claim.fresh) return { intent: claim.intent, idempotent: true };
    const i = claim.intent;
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
      await s.update(R_INTENTS, Number(i.id), { status: 'FAILED', updated_at: now() });
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
      await s.update(R_INTENTS, Number(i.id), { provider: route.provider.code, status: 'PENDING', updated_at: now() });
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
          if (!ambiguous) await s.update(R_INTENTS, Number(i.id), { status: 'FAILED', updated_at: now() });
          // Unknown writes are retained pending. Do NOT release stock or start another provider.
          if (ambiguous) return { intent: await this.intent(empresaId, Number(i.id)), idempotent: false };
          throw new HttpError(502, 'Provider recusou o pagamento. Consulte a transação.');
        }
      }
    }
    await s.update(R_INTENTS, Number(i.id), { status: 'FAILED', updated_at: now() });
    throw new HttpError(502, 'Nenhuma rota elegível para pagamento.');
  }
  private async bridge(empresaId: number, i: Row, a: Row, provider: string, r: PaymentResult) {
    const s = getStore();
    await locked(empresaId, `intent:${i.id}`, async (tx) => {
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
    });
  }
  async apply(empresaId: number, intentId: number, result: PaymentResult) {
    const s = getStore();
    await locked(empresaId, `intent:${intentId}`, async (tx) => {
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
      try {
        status = transition(i.status, result.status);
      } catch {
        return;
      } // stale async notification cannot regress state
      const total = Number(i.amount);
      const previousRefund = Number(a.refunded_amount || 0);
      // REFUNDED means the entire amount was refunded. Some webhook adapters
      // provide only that terminal status; a partial refund, in contrast, needs
      // an explicit amount and cannot safely be inferred.
      const refunded = result.refunded ?? (status === 'REFUNDED' ? total : previousRefund);
      if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(previousRefund) || previousRefund < 0 ||
          !Number.isSafeInteger(refunded) || refunded < previousRefund || refunded > total ||
          (status === 'REFUNDED' && refunded !== total) ||
          (status === 'PARTIALLY_REFUNDED' && (result.refunded == null || refunded <= 0 || refunded >= total)))
        throw new HttpError(409, 'Reembolso divergente ou sem valor suficiente para conciliação.');
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
      if (i.cobranca_id)
        await s.update(
          R_GATEWAY_COBRANCAS,
          Number(i.cobranca_id),
          {
            status: ['PAID', 'CAPTURED', 'PARTIALLY_REFUNDED'].includes(status)
              ? 'paga'
              : status === 'REFUNDED'
                ? 'estornada'
                : status === 'CANCELED'
                  ? 'cancelada'
                  : status === 'EXPIRED'
                    ? 'expirada'
                    : status === 'AUTHORIZED'
                      ? 'autorizada'
                      : 'pendente',
          },
          tx
        );
      if (['CAPTURED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CHARGEBACK'].includes(status)) {
        const existing = await s.findOneWhere(
          R_SETTLEMENTS,
          { empresa_id: empresaId, provider: i.provider, provider_reference: result.reference },
          tx
        );
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
              chargeback_amount: status === 'CHARGEBACK' ? i.amount : 0,
              status: 'UNRECONCILED',
              evidence: {},
              created_at: now(),
              updated_at: now(),
            },
            tx
          );
        else {
          const chargedBack = Number(status === 'CHARGEBACK' ? i.amount : existing.chargeback_amount ?? 0);
          const changed = refunded !== Number(existing.refund_amount || 0) || chargedBack !== Number(existing.chargeback_amount || 0);
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
              refund_amount: refunded, chargeback_amount: chargedBack,
              status: existing.payout_id ? 'DIVERGENT' : 'UNRECONCILED', updated_at: now(),
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
              status: status === 'CHARGEBACK' ? 'LOST' : 'DISPUTE_OPENED',
              amount: i.amount,
              reason: 'Provider confirmation',
              created_at: now(),
              updated_at: now(),
            },
            tx
          );
      }
      await this.audit(
        empresaId,
        intentId,
        `payment ${status.toLowerCase()}`,
        { attempt_id: a.id, provider: i.provider, correlation_id: i.correlation_id },
        tx
      );
    });
    await this.deliverToCommerce(empresaId, intentId);
  }
  async deliverToCommerce(empresaId: number, intentId: number) {
    const i = await this.intent(empresaId, intentId);
    const intention = ({ PAID: 'paga', CANCELED: 'cancelada', EXPIRED: 'expirada', REFUNDED: 'estornada' } as const)[i.status as 'PAID'];
    if (!intention || !i.cobranca_id) return;
    const { confirmarPagamentoCobranca } = await import('../../../server/src/commerce/pedidos');
    await confirmarPagamentoCobranca({ empresaId, cobrancaId: Number(i.cobranca_id), intencao: intention });
    if (i.status === 'PAID')
      await locked(empresaId, `finance:${intentId}`, async (tx) => {
        const order = await getStore().findOneWhere(
          getResource('commerce_pedidos')!,
          { empresa_id: empresaId, id: Number(i.order_id) },
          tx
        );
        if (!order?.venda_id) return; // Conversion pending correction stays in existing Commerce outbox.
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
      });
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
      if (
        operation === 'refund' &&
        (!['PAID', 'CAPTURED', 'PARTIALLY_REFUNDED'].includes(i.status) ||
          requested > Number(a.captured_amount) - Number(a.refunded_amount))
      )
        throw new HttpError(409, 'Valor excede saldo reembolsável.');
      if (operation === 'capture' && i.status !== 'AUTHORIZED') throw new HttpError(409, 'Pagamento não autorizado.');
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
    });
    if (!claim.fresh) return claim.op.result;
    const { i, op, attempt } = claim;
    const ctx = await account(empresaId, i.provider as ProviderCode, hash(`${empresaId}:${operation}:${id}:${op.id}`));
    const cap = ctx.capabilities.find((c) => c.method === i.method);
    try {
      if (operation === 'refund' && (!cap?.refund || (Number(op.amount) < Number(i.amount) && !cap.partialRefund)))
        throw new PaymentError('INVALID_PAYMENT_METHOD');
      if (operation === 'capture' && !cap?.capture) throw new PaymentError('INVALID_PAYMENT_METHOD');
      if (operation === 'cancel' && i.provider !== 'MANUAL' && !cap?.cancel) throw new PaymentError('INVALID_PAYMENT_METHOD');
      const ref = String(attempt!.provider_transaction_id);
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
      if (operation === 'refund' && !['REFUNDED', 'PARTIALLY_REFUNDED'].includes(result.status))
        throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      if (operation === 'cancel' && !['CANCELED', 'EXPIRED'].includes(result.status))
        throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      if (operation === 'capture' && !['CAPTURED', 'PAID'].includes(result.status)) throw new PaymentError('UNKNOWN_PROVIDER_ERROR', true);
      await this.apply(empresaId, id, result);
      await locked(empresaId, `intent:${id}`, async (tx) => {
        await s.update(R_OPERATIONS, Number(op.id), { status: 'SUCCEEDED', result: { status: result.status }, updated_at: now() }, tx);
        await s.update(R_INTENTS, id, { active_operation: null }, tx);
        if (operation === 'refund') {
          const r = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, operation_id: op.id }, tx);
          if (r) await s.update(R_REFUNDS, Number(r.id), { status: 'COMPLETED', updated_at: now() }, tx);
        }
      });
      return { status: result.status };
    } catch (e) {
      const uncertain = !(e instanceof PaymentError) || e.ambiguous;
      await s.update(R_OPERATIONS, Number(op.id), {
        status: uncertain ? 'UNCERTAIN' : 'FAILED',
        result: { ...op.result, code: e instanceof PaymentError ? e.code : 'UNKNOWN_PROVIDER_ERROR' },
        updated_at: now(),
      });
      if (!uncertain) await s.update(R_INTENTS, id, { active_operation: null });
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
    await this.apply(empresaId, id, result);
    if (i.active_operation) {
      await locked(empresaId, `intent:${id}`, async (tx) => {
        const current = await this.intent(empresaId, id, tx);
        if (!current.active_operation) return;
        const op = await s.findOneWhere(R_OPERATIONS, { empresa_id: empresaId, id: Number(current.active_operation) }, tx);
        if (!op || !['PROCESSING', 'UNCERTAIN'].includes(op.status)) return;
        const confirmed =
          op.operation === 'refund'
            ? Number(result.refunded || 0) >= Number(op.result?.baseline_refunded || 0) + Number(op.amount)
            : op.operation === 'capture'
              ? ['PAID', 'CAPTURED'].includes(result.status)
              : op.operation === 'cancel'
                ? result.status === 'CANCELED'
                : false;
        if (!confirmed) return;
        await s.update(R_OPERATIONS, Number(op.id), { status: 'SUCCEEDED', result: { status: result.status }, updated_at: now() }, tx);
        await s.update(R_INTENTS, id, { active_operation: null }, tx);
        if (op.operation === 'refund') {
          const refund = await s.findOneWhere(R_REFUNDS, { empresa_id: empresaId, operation_id: op.id }, tx);
          if (refund) await s.update(R_REFUNDS, Number(refund.id), { status: 'COMPLETED', updated_at: now() }, tx);
        }
      });
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
