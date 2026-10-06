/**
 * Motor de vendas multicanal — upsert IDEMPOTENTE em `sales` +
 * `sale_items`.
 *
 * Fonte: `modules/sales/sales.service.ts` (PR013/PR014) do
 * brobond-ai-commerce. ADAPTAÇÕES DESTA FASE:
 *
 *   • `organizationId` → `usuarioId` (FK → `usuarios.id`): é o operador
 *     do ERP que aparece como responsável pela receita importada, e é
 *     nele que a auditoria de faturamento bate.
 *   • A venda deixa de ser "um produto" e passa a ter ITENS: cada linha
 *     de `sale_items` é resolvida contra `produtos`/`tamanhos` pelo
 *     casador de catálogo.
 *   • Persistência em SQL puro sobre o pool do ERP.
 *
 * IDEMPOTÊNCIA: webhooks são "at-least-once". O upsert aterrissa na
 * chave única `(usuario_id, channel, external_order_id)` criada na Fase 1
 * em vez de inserir às cegas — a mesma reentrega atualiza a linha, nunca
 * duplica receita. Os itens são reescritos em bloco dentro da MESMA
 * transação (uma venda nunca fica sem itens no meio do caminho).
 */

import { runInTransaction, type ConnectorDatabase } from '../core/database';
import { connectorCuid } from '../core/id';
import { notifySaleIngested } from '../core/sale-events';
import type { SaleChannelName, SaleStatusName } from '../core/providers';
import type { SaleRow } from '../core/types';
import { matchCatalogItem } from './catalog-matcher';

export interface IngestedSaleItemInput {
  /** SKU informado pelo marketplace. */
  sku?: string | null;
  title: string;
  /** Nome literal da variação no marketplace. */
  variacaoExterna?: string | null;
  /** Rótulo de tamanho extraído da variação. */
  sizeLabel?: string | null;
  quantity: number;
  unitPriceCents: number;
  discountCents?: number;
}

export interface IngestedSaleInput {
  channel: SaleChannelName;
  externalOrderId: string;
  amountCents: number;
  currency: string;
  status: SaleStatusName;
  quantity: number;
  occurredAt: Date;
  items: IngestedSaleItemInput[];
}

export type SaleUpsertOutcome = 'created' | 'updated' | 'unchanged';

export interface SaleUpsertResult {
  sale: SaleRow;
  outcome: SaleUpsertOutcome;
  /** Itens gravados (reescritos) nesta operação. */
  itemCount: number;
}

interface SaleRawRow extends Record<string, unknown> {
  id: string;
  reference: string;
  quantity: number;
  amount_cents: number;
  currency: string;
  status: string;
  occurred_at: Date | string;
  channel: string;
  external_order_id: string | null;
  usuario_id: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapSale(row: SaleRawRow): SaleRow {
  return {
    id: String(row.id),
    reference: String(row.reference),
    quantity: Number(row.quantity),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    status: String(row.status) as SaleStatusName,
    occurredAt: toDate(row.occurred_at),
    channel: String(row.channel) as SaleChannelName,
    externalOrderId: row.external_order_id === null ? null : String(row.external_order_id),
    usuarioId: Number(row.usuario_id),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

const SALE_COLUMNS = `
  id, reference, quantity, amount_cents, currency, status, occurred_at, channel,
  external_order_id, usuario_id, created_at, updated_at`;

/** Moeda normalizada (3 letras maiúsculas); qualquer lixo vira BRL. */
export function normalizeSaleCurrency(currency?: string | null): string {
  const value = (currency ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : 'BRL';
}

function positiveInt(value: number, fallback = 0): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Referência canônica e DETERMINÍSTICA de uma venda de marketplace. Ela é
 * única no banco: derivá-la do canal + pedido externo é o que permite o
 * upsert repetido não colidir com a unicidade de `reference`.
 */
export function marketplaceSaleReference(channel: SaleChannelName, externalOrderId: string): string {
  return `${channel.toLowerCase()}:${externalOrderId}`;
}

export function createSalesService(resolveDb: () => ConnectorDatabase) {
  return {
    /**
     * Cria ou atualiza a venda de um pedido externo, com os itens casados
     * no catálogo do ERP. Seguro para chamar N vezes com o mesmo pedido.
     */
    async upsertIngestedSale(usuarioId: number, input: IngestedSaleInput): Promise<SaleUpsertResult> {
      const db = resolveDb();
      const currency = normalizeSaleCurrency(input.currency);
      const amountCents = Math.max(0, Math.trunc(input.amountCents) || 0);
      const quantity = positiveInt(input.quantity, 1);
      const reference = marketplaceSaleReference(input.channel, input.externalOrderId);

      const result = await runInTransaction(db, async (tx) => {
        const { rows: existingRows } = await tx.query<SaleRawRow>(
          `SELECT ${SALE_COLUMNS} FROM sales
           WHERE usuario_id = $1 AND channel = $2::sale_channel AND external_order_id = $3
           LIMIT 1`,
          [usuarioId, input.channel, input.externalOrderId]
        );
        const existing = existingRows[0] ? mapSale(existingRows[0]) : null;

        // Reentrega idêntica: nada muda no banco e nenhum item é
        // reescrito — é o caminho mais comum de um webhook "at-least-once".
        if (
          existing &&
          existing.status === input.status &&
          existing.amountCents === amountCents &&
          existing.quantity === quantity &&
          existing.currency === currency
        ) {
          return { sale: existing, outcome: 'unchanged' as const, itemCount: 0 };
        }

        const { rows } = await tx.query<SaleRawRow>(
          `INSERT INTO sales (
             id, reference, quantity, amount_cents, currency, status, occurred_at,
             channel, external_order_id, usuario_id, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6::sale_status, $7, $8::sale_channel, $9, $10, now(), now()
           )
           ON CONFLICT (usuario_id, channel, external_order_id) DO UPDATE SET
             quantity    = EXCLUDED.quantity,
             amount_cents= EXCLUDED.amount_cents,
             currency    = EXCLUDED.currency,
             status      = EXCLUDED.status,
             occurred_at = EXCLUDED.occurred_at,
             updated_at  = now()
           RETURNING ${SALE_COLUMNS}`,
          [
            existing?.id ?? connectorCuid(),
            existing?.reference ?? reference,
            quantity,
            amountCents,
            currency,
            input.status,
            input.occurredAt,
            input.channel,
            input.externalOrderId,
            usuarioId,
          ]
        );
        const sale = mapSale(rows[0] as SaleRawRow);

        // Itens: reescrita em bloco dentro da transação. Reprocessar um
        // pedido corrigido (quantidade alterada, item cancelado) nunca
        // deixa linha órfã nem duplicada.
        await tx.query(`DELETE FROM sale_items WHERE sale_id = $1`, [sale.id]);
        let itemCount = 0;
        for (const item of input.items) {
          const itemQuantity = positiveInt(item.quantity, 1);
          const unitPriceCents = Math.max(0, Math.trunc(item.unitPriceCents) || 0);
          const discountCents = Math.max(0, Math.trunc(item.discountCents ?? 0) || 0);
          const subtotalCents = Math.max(0, itemQuantity * unitPriceCents - discountCents);
          const match = await matchCatalogItem(tx, {
            sku: item.sku,
            title: item.title,
            sizeLabel: item.sizeLabel,
            variacaoExterna: item.variacaoExterna,
          });
          await tx.query(
            `INSERT INTO sale_items (
               id, sale_id, product_id, size_id, variacao_externa, quantity,
               unit_price_cents, discount_cents, subtotal_cents, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
            [
              connectorCuid(),
              sale.id,
              match.productId,
              match.sizeId,
              item.variacaoExterna ?? item.title,
              itemQuantity,
              unitPriceCents,
              discountCents,
              subtotalCents,
            ]
          );
          itemCount += 1;
        }

        return { sale, outcome: existing ? ('updated' as const) : ('created' as const), itemCount };
      });

      // Motor analítico "1. MEU NEGÓCIOS": avisa o servidor que a venda
      // mudou (fora da transação — o recálculo de margem/ABC é best
      // effort e jamais pode reverter uma ingestão confirmada).
      // Reentrega idêntica (`unchanged`) não precisa de recálculo.
      if (result.outcome !== 'unchanged') {
        await notifySaleIngested({ saleId: result.sale.id, outcome: result.outcome, channel: result.sale.channel });
      }
      return result;
    },

    /** Vendas recentes de um canal (tela de detalhe do conector). */
    async listRecentSales(usuarioId: number, channel: SaleChannelName, limit = 20): Promise<SaleRow[]> {
      const db = resolveDb();
      const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
      const { rows } = await db.query<SaleRawRow>(
        `SELECT ${SALE_COLUMNS} FROM sales
         WHERE usuario_id = $1 AND channel = $2::sale_channel
         ORDER BY occurred_at DESC
         LIMIT $3`,
        [usuarioId, channel, take]
      );
      return rows.map(mapSale);
    },
  };
}

export type SalesService = ReturnType<typeof createSalesService>;
