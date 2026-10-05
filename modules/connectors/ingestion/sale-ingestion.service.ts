/**
 * Ingestão de pedidos dos marketplaces → `sales` / `sale_items`.
 *
 * Fonte: `modules/marketplace/ingestion/sale-ingestion.service.ts` do
 * brobond-ai-commerce (PR014 — Motor Financeiro Unificado). ADAPTAÇÕES
 * DESTA FASE:
 *
 *   • Tenancy `usuarioId` em todo o caminho (o responsável é resolvido
 *     pelo `shop_id` guardado no conector, nunca por entrada do chamador).
 *   • Os QUATRO provedores alimentam o motor — o commerce só ingeria
 *     Mercado Livre e Mercado Pago; Shopee e TikTok Shop entram agora,
 *     com o detalhe de pedido buscado na API oficial de cada um.
 *   • A venda passa a ter ITENS casados com `produtos`/`tamanhos`.
 *   • Sem BullMQ/Redis: o ERP é um processo só. O webhook grava o evento
 *     (durável, idempotente) e processa em seguida; o que falhar fica com
 *     `processed_at = NULL` e é recuperado pela varredura
 *     `processPendingSaleEvents()` (chamada pelo cron de agendados).
 *
 * Contrato de exceção preservado: só falha TRANSITÓRIA (rede, 5xx do
 * provedor) propaga — estado permanente é RESULTADO terminal, nunca
 * exceção.
 */

import { connectorRepository, type ConnectorRepository } from '../core/connector.repository';
import { connectorService, type ConnectorService } from '../core/connector.service';
import { getConnectorDatabase } from '../core/database';
import { connectorErrorMessage, requiresReauthentication } from '../core/errors';
import { saleChannelFromConnectorProvider, type ConnectorProviderName, type SaleStatusName } from '../core/providers';
import type { JsonObject } from '../core/types';
import {
  fetchMercadoLivreOrder,
  meliOrderStatusToSaleStatus,
  resolveMercadoLivreNotificationOrderId,
} from '../mercadolivre/mercadolivre.service';
import { fetchMercadoPagoPayment, mercadoPagoStatusToSaleStatus } from '../mercadopago/mercadopago.service';
import { fetchShopeeOrder, shopeeOrderStatusToSaleStatus } from '../shopee/shopee.service';
import { fetchTikTokOrder, tiktokOrderStatusToSaleStatus } from '../tiktok/tiktok.service';
import { createSalesService, type IngestedSaleItemInput, type SalesService } from './sales.service';

// ------------------------------------------------------------------
// Tópicos que carregam venda
// ------------------------------------------------------------------

/**
 * Notificações do Mercado Livre habilitadas no DevCenter. `items` é
 * reconhecido e encerrado pelo worker, mas NUNCA fabrica uma venda:
 * mudança de anúncio não é receita.
 */
export const MERCADOLIVRE_SALE_TOPICS = ['orders', 'orders_v2', 'payments', 'shipments', 'items'] as const;

/** Tipos de notificação do Mercado Pago que carregam pagamento. */
export const MERCADOPAGO_SALE_TOPICS = ['payment'] as const;

/** Códigos de push da Shopee ligados a pedido (3 = order status update). */
export const SHOPEE_SALE_TOPICS = ['3', '4', '15'] as const;

/** Tópicos de webhook do TikTok Shop ligados a pedido. */
export const TIKTOK_SALE_TOPICS = ['1', 'order_status_change'] as const;

/** Provedores cujos webhooks alimentam o motor financeiro. */
export const SALE_INGESTION_PROVIDERS: readonly ConnectorProviderName[] = ['MERCADOLIVRE', 'MERCADOPAGO', 'SHOPEE', 'TIKTOK'];

/** Este par (provedor, tópico) carrega dado de venda? */
export function isSaleIngestionEvent(provider: ConnectorProviderName, topic: string | null): boolean {
  if (!topic) return false;
  const normalized = topic.trim().toLowerCase();
  switch (provider) {
    case 'MERCADOLIVRE':
      return (MERCADOLIVRE_SALE_TOPICS as readonly string[]).includes(normalized);
    case 'MERCADOPAGO':
      return (MERCADOPAGO_SALE_TOPICS as readonly string[]).includes(normalized);
    case 'SHOPEE':
      return (SHOPEE_SALE_TOPICS as readonly string[]).includes(normalized);
    case 'TIKTOK':
      return (TIKTOK_SALE_TOPICS as readonly string[]).includes(normalized);
    default:
      return false;
  }
}

// ------------------------------------------------------------------
// Rascunho de venda
// ------------------------------------------------------------------

/** Rascunho de uma venda externa, resolvido pela API oficial. */
interface IngestedSaleDraft {
  externalOrderId: string;
  amountCents: number;
  currency: string;
  status: SaleStatusName;
  quantity: number;
  occurredAt: Date;
  items: IngestedSaleItemInput[];
}

function asRecord(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : {};
}

function totalQuantity(items: IngestedSaleItemInput[], fallback = 1): number {
  const total = items.reduce((sum, item) => sum + Math.max(1, Math.trunc(item.quantity) || 1), 0);
  return total > 0 ? total : fallback;
}

export interface SaleIngestionResult {
  provider: ConnectorProviderName;
  externalEventId: string;
  /** Como a entrega foi tratada. */
  status:
    | 'processed' /** Venda criada/atualizada. */
    | 'duplicate' /** Evento já processado — reentrega. */
    | 'ignored' /** Estado irrelevante para receita. */
    | 'skipped'; /** Sem evento durável ou sem recurso buscável. */
  outcome?: 'created' | 'updated' | 'unchanged';
  saleId?: string;
  amountCents?: number;
}

export interface SaleIngestionDependencies {
  repository?: ConnectorRepository;
  service?: ConnectorService;
  sales?: SalesService;
}

export function createSaleIngestionService(deps: SaleIngestionDependencies = {}) {
  const repository = deps.repository ?? connectorRepository;
  const service = deps.service ?? connectorService;
  const sales = deps.sales ?? createSalesService(() => getConnectorDatabase());

  async function resolveMercadoLivreDraft(usuarioId: number, topic: string | null, payload: JsonObject): Promise<IngestedSaleDraft | null> {
    const resource = typeof payload.resource === 'string' ? payload.resource : '';
    if (!topic || !resource) return null;

    const { accessToken } = await service.getValidAccessToken(usuarioId, 'MERCADOLIVRE');
    const orderId = await resolveMercadoLivreNotificationOrderId(accessToken, topic, resource);
    if (!orderId) return null;
    const order = await fetchMercadoLivreOrder(accessToken, orderId);

    const items: IngestedSaleItemInput[] = order.items.map((item) => ({
      sku: item.sku,
      title: item.title,
      variacaoExterna: item.variacaoExterna,
      sizeLabel: item.sizeLabel,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    }));

    return {
      externalOrderId: order.id,
      amountCents: order.totalAmountCents,
      currency: order.currencyId,
      status: meliOrderStatusToSaleStatus(order.status),
      quantity: totalQuantity(items, order.itemCount),
      occurredAt: order.dateClosed ?? order.dateCreated,
      items,
    };
  }

  async function resolveMercadoPagoDraft(usuarioId: number, payload: JsonObject): Promise<IngestedSaleDraft | null> {
    const data = asRecord(payload.data);
    const paymentId = data.id !== undefined ? String(data.id) : '';
    if (!paymentId) return null;

    const { accessToken } = await service.getValidAccessToken(usuarioId, 'MERCADOPAGO');
    const payment = await fetchMercadoPagoPayment(accessToken, paymentId);

    const items: IngestedSaleItemInput[] = payment.items.length
      ? payment.items.map((item) => ({
          sku: item.sku,
          title: item.title,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
        }))
      : [
          {
            sku: null,
            title: `Pagamento ${payment.id}`,
            quantity: 1,
            unitPriceCents: payment.amountCents,
          },
        ];

    return {
      externalOrderId: payment.externalOrderId,
      amountCents: payment.amountCents,
      currency: payment.currencyId,
      status: mercadoPagoStatusToSaleStatus(payment.status),
      quantity: totalQuantity(items),
      occurredAt: payment.dateApproved ?? payment.dateCreated,
      items,
    };
  }

  async function resolveShopeeDraft(usuarioId: number, payload: JsonObject): Promise<IngestedSaleDraft | null> {
    const data = asRecord(payload.data);
    const orderSn = typeof data.ordersn === 'string' ? data.ordersn : typeof data.order_sn === 'string' ? data.order_sn : '';
    if (!orderSn) return null;

    const { accessToken, shopId } = await service.getValidAccessToken(usuarioId, 'SHOPEE');
    if (!shopId) return null;
    const order = await fetchShopeeOrder(accessToken, shopId, orderSn);

    const items: IngestedSaleItemInput[] = order.items.map((item) => ({
      sku: item.sku,
      title: item.title,
      variacaoExterna: item.variacaoExterna,
      sizeLabel: item.sizeLabel,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    }));

    return {
      externalOrderId: order.orderSn,
      amountCents: order.totalAmountCents,
      currency: order.currency,
      status: shopeeOrderStatusToSaleStatus(order.status),
      quantity: totalQuantity(items),
      occurredAt: order.createdAt,
      items,
    };
  }

  async function resolveTikTokDraft(usuarioId: number, payload: JsonObject): Promise<IngestedSaleDraft | null> {
    const data = asRecord(payload.data);
    const orderId = typeof data.order_id === 'string' ? data.order_id : data.order_id !== undefined ? String(data.order_id) : '';
    if (!orderId) return null;

    const { accessToken, shopId } = await service.getValidAccessToken(usuarioId, 'TIKTOK');
    const order = await fetchTikTokOrder(accessToken, orderId, shopId);

    const items: IngestedSaleItemInput[] = order.items.map((item) => ({
      sku: item.sku,
      title: item.title,
      variacaoExterna: item.variacaoExterna,
      sizeLabel: item.sizeLabel,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    }));

    return {
      externalOrderId: order.id,
      amountCents: order.totalAmountCents,
      currency: order.currency,
      status: tiktokOrderStatusToSaleStatus(order.status),
      quantity: totalQuantity(items),
      occurredAt: order.createdAt,
      items,
    };
  }

  async function resolveDraft(
    usuarioId: number,
    provider: ConnectorProviderName,
    topic: string | null,
    payload: JsonObject
  ): Promise<IngestedSaleDraft | null> {
    switch (provider) {
      case 'MERCADOLIVRE':
        return resolveMercadoLivreDraft(usuarioId, topic, payload);
      case 'MERCADOPAGO':
        return resolveMercadoPagoDraft(usuarioId, payload);
      case 'SHOPEE':
        return resolveShopeeDraft(usuarioId, payload);
      case 'TIKTOK':
        return resolveTikTokDraft(usuarioId, payload);
      default:
        return null;
    }
  }

  return {
    /**
     * Processa UMA entrega de webhook de ponta a ponta. Seguro para
     * chamar repetidamente: o evento só é carimbado `processed_at` depois
     * de um desfecho terminal, e o upsert da venda é guardado pela chave
     * única de idempotência.
     */
    async processSaleIngestionEvent(input: {
      usuarioId: number;
      provider: ConnectorProviderName;
      externalEventId: string;
    }): Promise<SaleIngestionResult> {
      const { usuarioId, provider, externalEventId } = input;

      const event = await repository.findEvent(usuarioId, provider, externalEventId);
      if (!event) return { provider, externalEventId, status: 'skipped' };
      if (event.processedAt) return { provider, externalEventId, status: 'duplicate' };

      const payload = asRecord(event.payload);
      let draft: IngestedSaleDraft | null;
      try {
        draft = await resolveDraft(usuarioId, provider, event.topic, payload);
      } catch (error) {
        if (requiresReauthentication(error)) {
          // A credencial guardada não abre mais (ex.: token gravado ANTES
          // de uma troca da CONNECTOR_ENCRYPTION_KEY — o serviço já
          // estacionou o canal em REAUTH_REQUIRED). Nada aqui conserta
          // isso e NADA disso pode derrubar o servidor: a entrega fica
          // pendente na caixa e a varredura retoma quando o operador
          // reconectar a conta.
          console.warn(`⚠️  Ingestão adiada (reconexão necessária) — ${provider}/${externalEventId}:`, connectorErrorMessage(error));
          return { provider, externalEventId, status: 'skipped' };
        }
        throw error;
      }

      if (!draft) {
        // Sem recurso buscável (payload malformado ou tópico que não gera
        // receita, como `items`): terminal, para a entrega nunca travar a
        // caixa de entrada.
        await repository.markEventProcessed(usuarioId, provider, externalEventId);
        return { provider, externalEventId, status: 'skipped' };
      }

      const { sale, outcome } = await sales.upsertIngestedSale(usuarioId, {
        channel: saleChannelFromConnectorProvider(provider),
        externalOrderId: draft.externalOrderId,
        amountCents: draft.amountCents,
        currency: draft.currency,
        status: draft.status,
        quantity: draft.quantity,
        occurredAt: draft.occurredAt,
        items: draft.items,
      });

      // Contadores reais do cartão do conector — mesma convenção de uma
      // sincronização, menos a semântica de "rodada" (sem syncCount, sem
      // carimbo de lastSyncAt).
      const counters =
        outcome === 'created' || outcome === 'updated'
          ? { imported: 1, duplicated: 0, failed: 0 }
          : { imported: 0, duplicated: 1, failed: 0 };
      await repository.incrementIngestionCounters(usuarioId, provider, counters);
      await repository.markEventProcessed(usuarioId, provider, externalEventId);

      return {
        provider,
        externalEventId,
        status: outcome === 'unchanged' ? 'ignored' : 'processed',
        outcome,
        saleId: sale.id,
        amountCents: sale.amountCents,
      };
    },

    /**
     * Varredura de recuperação: reprocessa as entregas que ficaram
     * pendentes (provedor fora do ar, token em renovação, reinício do
     * processo no meio da ingestão). Cada linha é re-escopada ao próprio
     * `usuarioId` — a varredura em si não é escopada, por projeto.
     */
    async processPendingSaleEvents(
      options: { limit?: number; olderThanMs?: number; maxAgeMs?: number } = {}
    ): Promise<{ processed: number; failed: number; results: SaleIngestionResult[] }> {
      const now = Date.now();
      const pending = await repository.listPendingSaleEvents({
        providers: SALE_INGESTION_PROVIDERS,
        // Pequena carência: o próprio webhook já tentou processar.
        before: new Date(now - (options.olderThanMs ?? 60_000)),
        // Entregas antigas demais viram carta morta e saem da varredura.
        after: new Date(now - (options.maxAgeMs ?? 7 * 24 * 3600_000)),
        limit: options.limit ?? 50,
      });

      const results: SaleIngestionResult[] = [];
      let failed = 0;
      for (const item of pending) {
        try {
          results.push(
            await this.processSaleIngestionEvent({
              usuarioId: item.usuarioId,
              provider: item.provider,
              externalEventId: item.externalEventId,
            })
          );
        } catch (error) {
          failed += 1;
          console.warn(`⚠️  Falha ao reprocessar evento ${item.provider}/${item.externalEventId}:`, connectorErrorMessage(error));
        }
      }
      return {
        processed: results.filter((result) => result.status === 'processed').length,
        failed,
        results,
      };
    },
  };
}

/** Serviço padrão de ingestão (repositório + pool do ERP). */
export const saleIngestionService = createSaleIngestionService();

export type SaleIngestionService = ReturnType<typeof createSaleIngestionService>;
