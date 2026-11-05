/**
 * Painel analítico de um conector — a camada de leitura que alimenta o
 * GABARITO visual herdado do `brobond-ai-commerce`:
 *
 *   • KPIs superiores (importados · ignorados · falhas · receita do canal ·
 *     última sincronização);
 *   • "Vendas do canal" — últimas vendas realmente ingeridas em `sales`;
 *   • "Webhooks — eventos recebidos" — caixa de entrada `connector_events`;
 *   • "Conteúdo importado desta plataforma" — as linhas de `sale_items`
 *     já casadas (ou não) com o catálogo real do ERP.
 *
 * É SOMENTE LEITURA e sempre escopado a `empresaId` + `usuarioId`: nada
 * aqui escreve, nenhuma credencial é lida e nenhum segredo trafega — o
 * painel recebe contadores e rótulos, jamais material sensível.
 */

import { getConnectorDatabase, type ConnectorDatabase } from './database';
import { connectorRepository, type ConnectorRepository } from './connector.repository';
import { saleChannelFromConnectorProvider, type ConnectorProviderName } from './providers';

// ------------------------------------------------------------------
// DTOs do painel (o cliente consome exatamente estas formas)
// ------------------------------------------------------------------

export interface ConnectorPanelSaleDTO {
  id: string;
  reference: string;
  externalOrderId: string | null;
  status: string;
  quantity: number;
  amountCents: number;
  currency: string;
  occurredAt: string;
}

export interface ConnectorPanelEventDTO {
  id: string;
  externalEventId: string;
  topic: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface ConnectorPanelContentDTO {
  id: string;
  /** Nome do produto do catálogo ERP quando houve casamento. */
  produto: string | null;
  sku: string | null;
  /** Rótulo literal da variação no marketplace. */
  variacao: string | null;
  tamanho: string | null;
  quantity: number;
  subtotalCents: number;
  occurredAt: string;
  /** `true` quando a linha foi casada com um produto do catálogo. */
  matched: boolean;
}

export interface ConnectorStoreSalesDTO {
  /** Pagamentos da BroBond Store (loja própria) processados por este provedor. */
  count: number;
  /** Pagos/conciliados (PAID ou parcialmente estornado). */
  paidCount: number;
  /** Receita CONFIRMADA (pagos/conciliados, líquida de estornos), em centavos. */
  paidRevenueCents: number;
  /** Aguardando pagamento (PIX gerado, ainda sem confirmação). */
  pendingCount: number;
}

export interface ConnectorReconciliationDTO {
  settlementCount: number;
  reconciledCount: number;
  pendingSettlementCount: number;
  divergentSettlementCount: number;
  openDisputeCount: number;
  pendingPayoutCount: number;
  /** Líquido apenas de liquidações MATCHED/RESOLVED; não é receita de vendas. */
  reconciledNetCents: number;
}

export interface ConnectorPanelDTO {
  provider: ConnectorProviderName;
  /**
   * Receita CONFIRMADA do canal, em CENTAVOS: somente vendas PAGAS
   * (status PAID). Pendentes, estornadas e canceladas não são receita.
   */
  revenueCents: number;
  /** Quantidade de vendas/pedidos sincronizados do canal (qualquer status). */
  salesCount: number;
  /** Quantidade de vendas pagas (mesmo recorte da receita). */
  paidSalesCount: number;
  /**
   * Somente Mercado Pago: vendas da loja própria (BroBond Store) cujo
   * pagamento passou pelo Payment Engine — separadas dos pagamentos
   * importados da conta Mercado Pago (`sales`). `null` nos demais canais.
   */
  storeSales: ConnectorStoreSalesDTO | null;
  /** Conciliação financeira do provedor, separada de conta MP e BroBond Store. */
  reconciliation: ConnectorReconciliationDTO | null;
  /** Eventos de webhook recebidos no total. */
  eventCount: number;
  sales: ConnectorPanelSaleDTO[];
  events: ConnectorPanelEventDTO[];
  importedContent: ConnectorPanelContentDTO[];
}

// ------------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------------

function clampLimit(limit: number, fallback = 10, max = 50): number {
  const parsed = Math.trunc(Number(limit));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

// ------------------------------------------------------------------
// Serviço
// ------------------------------------------------------------------

export interface ConnectorPanelDependencies {
  resolveDb?: () => ConnectorDatabase;
  repository?: ConnectorRepository;
}

export function createConnectorPanelService(deps: ConnectorPanelDependencies = {}) {
  const resolveDb = deps.resolveDb ?? (() => getConnectorDatabase());
  const repository = deps.repository ?? connectorRepository;

  return {
    /**
     * Snapshot analítico de um canal. Nunca lança por ausência de dados:
     * um conector recém-criado devolve zeros e listas vazias — é
     * exatamente isso que alimenta os "empty states" do painel.
     */
    async getPanel(empresaId: number, usuarioId: number, provider: ConnectorProviderName, limit = 10): Promise<ConnectorPanelDTO> {
      const db = resolveDb();
      const channel = saleChannelFromConnectorProvider(provider);
      const take = clampLimit(limit);

      const [totals, sales, content, events, store, reconciliation] = await Promise.all([
        db.query<{ revenue_cents: string | number | null; sales_count: string | number | null; paid_count: string | number | null; event_count: string | number | null }>(
          `SELECT
             COALESCE((SELECT SUM(amount_cents) FROM sales
                        WHERE empresa_id = $1 AND usuario_id = $2 AND channel = $3::sale_channel AND status = 'PAID'), 0) AS revenue_cents,
             COALESCE((SELECT COUNT(*) FROM sales
                        WHERE empresa_id = $1 AND usuario_id = $2 AND channel = $3::sale_channel), 0) AS sales_count,
             COALESCE((SELECT COUNT(*) FROM sales
                        WHERE empresa_id = $1 AND usuario_id = $2 AND channel = $3::sale_channel AND status = 'PAID'), 0) AS paid_count,
             COALESCE((SELECT COUNT(*) FROM connector_events
                        WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $4::connector_provider), 0) AS event_count`,
          [empresaId, usuarioId, channel, provider]
        ),
        db.query<Record<string, unknown>>(
          `SELECT id, reference, external_order_id, status, quantity, amount_cents, currency, occurred_at
             FROM sales
            WHERE empresa_id = $1 AND usuario_id = $2 AND channel = $3::sale_channel
            ORDER BY occurred_at DESC
            LIMIT $4`,
          [empresaId, usuarioId, channel, take]
        ),
        db.query<Record<string, unknown>>(
          `SELECT si.id,
                  p.nome  AS produto,
                  p.sku   AS sku,
                  t.codigo AS tamanho,
                  si.variacao_externa,
                  si.quantity,
                  si.subtotal_cents,
                  si.product_id,
                  s.occurred_at
             FROM sale_items si
             JOIN sales s     ON s.id = si.sale_id
             LEFT JOIN produtos p ON p.id = si.product_id AND p.empresa_id = s.empresa_id
             LEFT JOIN tamanhos t ON t.id = si.size_id
            WHERE s.empresa_id = $1 AND s.usuario_id = $2 AND s.channel = $3::sale_channel
            ORDER BY s.occurred_at DESC, si.id ASC
            LIMIT $4`,
          [empresaId, usuarioId, channel, take]
        ),
        repository.listRecentEvents(empresaId, usuarioId, provider, take),
        provider === 'MERCADOPAGO'
          ? db.query<{ total: string | number | null; pagos: string | number | null; receita: string | number | null; pendentes: string | number | null }>(
              `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE pi.status IN ('PAID','PARTIALLY_REFUNDED')) AS pagos,
                      COALESCE(SUM(CASE WHEN pi.status IN ('PAID','PARTIALLY_REFUNDED')
                                        THEN pi.amount - COALESCE((SELECT MAX(pa.refunded_amount) FROM payment_attempts pa
                                                                    WHERE pa.empresa_id = pi.empresa_id AND pa.payment_intent_id = pi.id), 0)
                                        ELSE 0 END), 0) AS receita,
                      COUNT(*) FILTER (WHERE pi.status IN ('CREATED','PENDING','REQUIRES_ACTION','AUTHORIZED','CAPTURE_PENDING')) AS pendentes
                 FROM payment_intents pi
                WHERE pi.empresa_id = $1 AND pi.provider = 'MERCADO_PAGO' AND pi.channel = 'OWN_STORE'`,
              [empresaId]
            )
          : Promise.resolve(null),
        provider === 'MERCADOPAGO'
          ? db.query<Record<string, unknown>>(
              `SELECT
                 (SELECT COUNT(*) FROM payment_settlements ps
                   WHERE ps.empresa_id = $1 AND ps.provider = 'MERCADO_PAGO') AS settlements,
                 (SELECT COUNT(*) FROM payment_settlements ps
                   WHERE ps.empresa_id = $1 AND ps.provider = 'MERCADO_PAGO' AND ps.status IN ('MATCHED','RESOLVED')) AS reconciliadas,
                 (SELECT COUNT(*) FROM payment_settlements ps
                   WHERE ps.empresa_id = $1 AND ps.provider = 'MERCADO_PAGO' AND ps.status IN ('UNRECONCILED','PARTIAL')) AS pendentes,
                 (SELECT COUNT(*) FROM payment_settlements ps
                   WHERE ps.empresa_id = $1 AND ps.provider = 'MERCADO_PAGO' AND ps.status = 'DIVERGENT') AS divergentes,
                 (SELECT COUNT(*) FROM payment_disputes pd
                   JOIN payment_intents pi ON pi.empresa_id = pd.empresa_id AND pi.id = pd.payment_intent_id
                   WHERE pd.empresa_id = $1 AND pi.provider = 'MERCADO_PAGO'
                     AND pd.status NOT IN ('WON','LOST','CLOSED')) AS disputas_abertas,
                 (SELECT COUNT(*) FROM payment_payouts pp
                   WHERE pp.empresa_id = $1 AND pp.provider = 'MERCADO_PAGO' AND pp.status <> 'MATCHED') AS repasses_pendentes,
                 (SELECT COALESCE(SUM(ps.net_amount), 0) FROM payment_settlements ps
                   WHERE ps.empresa_id = $1 AND ps.provider = 'MERCADO_PAGO' AND ps.status IN ('MATCHED','RESOLVED')) AS liquido_conciliado`,
              [empresaId]
            )
          : Promise.resolve(null),
      ]);

      const totalsRow = totals.rows[0] ?? {};
      const storeRow = store?.rows?.[0];
      const reconciliationRow = reconciliation?.rows?.[0];

      return {
        provider,
        revenueCents: Number(totalsRow.revenue_cents ?? 0) || 0,
        salesCount: Number(totalsRow.sales_count ?? 0) || 0,
        paidSalesCount: Number(totalsRow.paid_count ?? 0) || 0,
        storeSales: storeRow
          ? {
              count: Number(storeRow.total ?? 0) || 0,
              paidCount: Number(storeRow.pagos ?? 0) || 0,
              paidRevenueCents: Number(storeRow.receita ?? 0) || 0,
              pendingCount: Number(storeRow.pendentes ?? 0) || 0,
            }
          : null,
        reconciliation: reconciliationRow
          ? {
              settlementCount: Number(reconciliationRow.settlements ?? 0) || 0,
              reconciledCount: Number(reconciliationRow.reconciliadas ?? 0) || 0,
              pendingSettlementCount: Number(reconciliationRow.pendentes ?? 0) || 0,
              divergentSettlementCount: Number(reconciliationRow.divergentes ?? 0) || 0,
              openDisputeCount: Number(reconciliationRow.disputas_abertas ?? 0) || 0,
              pendingPayoutCount: Number(reconciliationRow.repasses_pendentes ?? 0) || 0,
              reconciledNetCents: Number(reconciliationRow.liquido_conciliado ?? 0) || 0,
            }
          : null,
        eventCount: Number(totalsRow.event_count ?? 0) || 0,
        sales: sales.rows.map((row) => ({
          id: String(row.id),
          reference: String(row.reference ?? ''),
          externalOrderId: toText(row.external_order_id),
          status: String(row.status ?? 'PENDING'),
          quantity: Number(row.quantity ?? 0) || 0,
          amountCents: Number(row.amount_cents ?? 0) || 0,
          currency: String(row.currency ?? 'BRL'),
          occurredAt: toIso(row.occurred_at as Date | string | null),
        })),
        events: events.map((event) => ({
          id: event.id,
          externalEventId: event.externalEventId,
          topic: event.topic,
          processedAt: toIsoOrNull(event.processedAt),
          createdAt: toIso(event.createdAt),
        })),
        importedContent: content.rows.map((row) => ({
          id: String(row.id),
          produto: toText(row.produto),
          sku: toText(row.sku),
          variacao: toText(row.variacao_externa),
          tamanho: toText(row.tamanho),
          quantity: Number(row.quantity ?? 0) || 0,
          subtotalCents: Number(row.subtotal_cents ?? 0) || 0,
          occurredAt: toIso(row.occurred_at as Date | string | null),
          matched: row.product_id !== null && row.product_id !== undefined,
        })),
      };
    },
  };
}

export type ConnectorPanelService = ReturnType<typeof createConnectorPanelService>;

/** Serviço padrão, preso ao banco e ao repositório do módulo. */
export const connectorPanelService: ConnectorPanelService = createConnectorPanelService();
