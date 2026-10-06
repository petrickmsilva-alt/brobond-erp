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
 * É SOMENTE LEITURA e sempre escopado ao `usuarioId` do responsável: nada
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

export interface ConnectorPanelDTO {
  provider: ConnectorProviderName;
  /** Receita acumulada do canal, em CENTAVOS, exceto pedidos cancelados. */
  revenueCents: number;
  /** Quantidade de vendas do canal (mesmo recorte da receita). */
  salesCount: number;
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
    async getPanel(usuarioId: number, provider: ConnectorProviderName, limit = 10): Promise<ConnectorPanelDTO> {
      const db = resolveDb();
      const channel = saleChannelFromConnectorProvider(provider);
      const take = clampLimit(limit);

      const [totals, sales, content, events] = await Promise.all([
        db.query<{ revenue_cents: string | number | null; sales_count: string | number | null; event_count: string | number | null }>(
          `SELECT
             COALESCE((SELECT SUM(amount_cents) FROM sales
                        WHERE usuario_id = $1 AND channel = $2::sale_channel AND status <> 'CANCELLED'), 0) AS revenue_cents,
             COALESCE((SELECT COUNT(*) FROM sales
                        WHERE usuario_id = $1 AND channel = $2::sale_channel), 0) AS sales_count,
             COALESCE((SELECT COUNT(*) FROM connector_events
                        WHERE usuario_id = $1 AND provider = $3::connector_provider), 0) AS event_count`,
          [usuarioId, channel, provider]
        ),
        db.query<Record<string, unknown>>(
          `SELECT id, reference, external_order_id, status, quantity, amount_cents, currency, occurred_at
             FROM sales
            WHERE usuario_id = $1 AND channel = $2::sale_channel
            ORDER BY occurred_at DESC
            LIMIT $3`,
          [usuarioId, channel, take]
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
             LEFT JOIN produtos p ON p.id = si.product_id
             LEFT JOIN tamanhos t ON t.id = si.size_id
            WHERE s.usuario_id = $1 AND s.channel = $2::sale_channel
            ORDER BY s.occurred_at DESC, si.id ASC
            LIMIT $3`,
          [usuarioId, channel, take]
        ),
        repository.listRecentEvents(usuarioId, provider, take),
      ]);

      const totalsRow = totals.rows[0] ?? {};

      return {
        provider,
        revenueCents: Number(totalsRow.revenue_cents ?? 0) || 0,
        salesCount: Number(totalsRow.sales_count ?? 0) || 0,
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
