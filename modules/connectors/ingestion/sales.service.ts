/**
 * Motor de vendas multicanal — upsert IDEMPOTENTE em `sales` +
 * `sale_items`.
 *
 * Fonte: `modules/sales/sales.service.ts` (PR013/PR014) do
 * brobond-ai-commerce. ADAPTAÇÕES DESTA FASE:
 *
 *   • Cada venda grava a `empresaId` confiável e o `usuarioId` responsável;
 *     ambos são escopos explícitos e entram na chave de idempotência.
 *   • A venda deixa de ser "um produto" e passa a ter ITENS: cada linha
 *     de `sale_items` é resolvida contra `produtos`/`tamanhos` pelo
 *     casador de catálogo.
 *   • Persistência em SQL puro sobre o pool do ERP.
 *
 * IDEMPOTÊNCIA: webhooks são "at-least-once". O upsert aterrissa na
 * chave única `(empresa_id, usuario_id, channel, external_order_id)`
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
  /**
   * Comprador do pedido externo, quando o provedor o expõe. Preservado para
   * que a ponte GOLIVE-03 resolva o cliente do ERP de forma determinística
   * (e-mail → nome) em vez de criar um cliente novo a cada retry.
   */
  buyerName?: string | null;
  buyerEmail?: string | null;
}

/** Texto opcional normalizado (trim; vazio → null). */
function optionalText(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text ? text.slice(0, 320) : null;
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
  empresa_id: number;
  was_inserted?: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapSale(row: SaleRawRow): SaleRow {
  return {
    empresaId: Number(row.empresa_id),
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
  external_order_id, usuario_id, empresa_id, created_at, updated_at`;

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
export function marketplaceSaleReference(empresaId: number, usuarioId: number, channel: SaleChannelName, externalOrderId: string): string {
  const tenant = positiveInt(empresaId);
  const actor = positiveInt(usuarioId);
  if (!tenant || !actor) throw new Error('A referência de venda exige empresaId e usuarioId explícitos e válidos.');
  return `empresa:${tenant}:usuario:${actor}:${channel.toLowerCase()}:${externalOrderId}`;
}

/**
 * Índices únicos que uma reentrega SIMULTÂNEA do mesmo pedido pode violar.
 *
 * O `ON CONFLICT` arbitra UM índice, e o PostgreSQL verifica os índices únicos
 * na ordem de criação da tabela. Duas entregas concorrentes do mesmo pedido
 * podem, portanto, estourar `23505` no índice composto ANTES de chegar ao
 * árbitro (`reference`) — era a causa do 23505 intermitente que derrubava o
 * gate de PostgreSQL (`pg-p0-commerce-tenant`).
 */
const CORRIDA_NA_REENTREGA =
  /^sales_(reference_key|usuario_id_channel_external_order_id_key|empresa_usuario_channel_external_order_id_key)$/;

/**
 * `true` quando o erro é a corrida conhecida entre duas reentregas do pedido:
 * violação de unicidade nos índices acima, ou o deadlock/serialização que o
 * PostgreSQL levanta quando várias inserções especulativas disputam as mesmas
 * chaves. Nenhum dos dois gravou nada — a transação inteira foi desfeita —,
 * então repetir é seguro e é a resposta correta do lado da ingestão.
 */
function ehCorridaDeReentrega(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  if (e?.code === '40001' || e?.code === '40P01') return true;
  return e?.code === '23505' && CORRIDA_NA_REENTREGA.test(String(e.constraint ?? ''));
}

/**
 * Executa o upsert com retentativa CURTA quando a transação perde a corrida
 * para outra reentrega do mesmo pedido (unicidade, deadlock ou serialização).
 *
 * A violação de unicidade só aparece depois que a transação concorrente
 * COMITA (o PostgreSQL espera por ela antes de decidir), então a tentativa
 * seguinte enxerga a venda gravada e cai no caminho idempotente — nunca
 * duplica receita. Não é laço infinito: sem a corrida conhecida, o erro
 * original sobe intacto.
 */
async function runInTransactionComCorrida<T>(
  db: ConnectorDatabase,
  fn: (db: ConnectorDatabase) => Promise<T>,
  tentativas = 3
): Promise<T> {
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      return await runInTransaction(db, fn);
    } catch (error) {
      if (!ehCorridaDeReentrega(error) || tentativa >= tentativas) throw error;
      // Espera crescente e curta: o commit concorrente já está a caminho.
      await new Promise((resolve) => setTimeout(resolve, 5 * tentativa));
    }
  }
}

/** Item casado, pronto para gravar (mesma forma nos dois caminhos). */
type ItemCasado = {
  productId: number | null;
  sizeId: number | null;
  variacaoExterna: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  subtotalCents: number;
};

/** Casa um item da ingestão com o catálogo do ERP (produto + tamanho). */
async function casarItem(tx: ConnectorDatabase, tenantId: number, item: IngestedSaleItemInput): Promise<ItemCasado> {
  const itemQuantity = positiveInt(item.quantity, 1);
  const unitPriceCents = Math.max(0, Math.trunc(item.unitPriceCents) || 0);
  const discountCents = Math.max(0, Math.trunc(item.discountCents ?? 0) || 0);
  const subtotalCents = Math.max(0, itemQuantity * unitPriceCents - discountCents);
  const match = await matchCatalogItem(tx, tenantId, {
    sku: item.sku,
    title: item.title,
    sizeLabel: item.sizeLabel,
    variacaoExterna: item.variacaoExterna,
  });
  return {
    productId: match.productId,
    sizeId: match.sizeId,
    variacaoExterna: item.variacaoExterna ?? item.title,
    quantity: itemQuantity,
    unitPriceCents,
    discountCents,
    subtotalCents,
  };
}

/** Reescreve os itens de uma venda (bloco) — nunca deixa linha órfã/duplicada. */
async function gravarItensDaIngestao(
  tx: ConnectorDatabase,
  tenantId: number,
  saleId: string,
  itens: IngestedSaleItemInput[]
): Promise<number> {
  await tx.query(`DELETE FROM sale_items WHERE sale_id = $1`, [saleId]);
  let itemCount = 0;
  for (const item of itens) {
    const casado = await casarItem(tx, tenantId, item);
    await tx.query(
      `INSERT INTO sale_items (
         id, sale_id, product_id, size_id, variacao_externa, quantity,
         unit_price_cents, discount_cents, subtotal_cents, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        connectorCuid(),
        saleId,
        casado.productId,
        casado.sizeId,
        casado.variacaoExterna,
        casado.quantity,
        casado.unitPriceCents,
        casado.discountCents,
        casado.subtotalCents,
      ]
    );
    itemCount += 1;
  }
  return itemCount;
}

/**
 * A06-08 — rematch de itens com o cabeçalho INALTERADO.
 *
 * Recalcula a associação de cada item com o catálogo e compara com o que está
 * gravado. Só reescreve quando o vínculo (produto/tamanho) ou os valores
 * divergem — então uma reentrega idêntica continua `unchanged` (idempotência) e
 * um item que antes não casava (SKU cadastrado depois) é REMATCHADO. Devolve o
 * número de itens reescritos (0 = nada mudou).
 */
async function reconciliarItensDaIngestao(
  tx: ConnectorDatabase,
  tenantId: number,
  saleId: string,
  itens: IngestedSaleItemInput[]
): Promise<number> {
  const { rows: atuais } = await tx.query<{
    product_id: number | null;
    size_id: number | null;
    variacao_externa: string | null;
    quantity: number;
    unit_price_cents: number;
    discount_cents: number;
    subtotal_cents: number;
  }>(
    `SELECT product_id, size_id, variacao_externa, quantity, unit_price_cents, discount_cents, subtotal_cents
       FROM sale_items WHERE sale_id = $1 ORDER BY id`,
    [saleId]
  );
  const casados: ItemCasado[] = [];
  for (const item of itens) casados.push(await casarItem(tx, tenantId, item));

  const igual =
    atuais.length === casados.length &&
    atuais.every((a, i) => {
      const c = casados[i];
      return (
        (a.product_id == null ? null : Number(a.product_id)) === c.productId &&
        (a.size_id == null ? null : Number(a.size_id)) === c.sizeId &&
        String(a.variacao_externa ?? '') === c.variacaoExterna &&
        Number(a.quantity) === c.quantity &&
        Number(a.unit_price_cents) === c.unitPriceCents &&
        Number(a.discount_cents) === c.discountCents &&
        Number(a.subtotal_cents) === c.subtotalCents
      );
    });
  if (igual) return 0;
  return gravarItensDaIngestao(tx, tenantId, saleId, itens);
}

export function createSalesService(resolveDb: () => ConnectorDatabase) {
  return {
    /**
     * Cria ou atualiza a venda de um pedido externo, com os itens casados
     * no catálogo do ERP. Seguro para chamar N vezes com o mesmo pedido.
     */
    async upsertIngestedSale(empresaId: number, usuarioId: number, input: IngestedSaleInput): Promise<SaleUpsertResult> {
      const tenantId = positiveInt(empresaId);
      const actorId = positiveInt(usuarioId);
      if (!tenantId || !actorId) throw new Error('A ingestão de venda exige empresaId e usuarioId explícitos e válidos.');
      const db = resolveDb();
      const currency = normalizeSaleCurrency(input.currency);
      const amountCents = Math.max(0, Math.trunc(input.amountCents) || 0);
      const quantity = positiveInt(input.quantity, 1);
      const reference = marketplaceSaleReference(tenantId, actorId, input.channel, input.externalOrderId);

      const result = await runInTransactionComCorrida(db, async (tx) => {
        const { rows: existingRows } = await tx.query<SaleRawRow>(
          `SELECT ${SALE_COLUMNS} FROM sales
           WHERE empresa_id = $1 AND usuario_id = $2 AND channel = $3::sale_channel AND external_order_id = $4
           LIMIT 1`,
          [tenantId, actorId, input.channel, input.externalOrderId]
        );
        const existing = existingRows[0] ? mapSale(existingRows[0]) : null;

        // Cabeçalho idêntico: a linha de `sales` não precisa ser reescrita.
        // MAS a associação de itens com o catálogo do ERP pode ter mudado desde
        // a primeira ingestão (SKU cadastrado depois, produto corrigido). O
        // rematch é separado da detecção de alteração do cabeçalho (A06-08):
        // quando os itens casados divergem do que está gravado, reescrevemos os
        // itens (outcome `updated`); quando nada muda, `unchanged` de verdade.
        const cabecalhoIgual =
          existing &&
          existing.status === input.status &&
          existing.amountCents === amountCents &&
          existing.quantity === quantity &&
          existing.currency === currency;
        if (cabecalhoIgual) {
          const reconciliado = await reconciliarItensDaIngestao(tx, tenantId, existing!.id, input.items);
          return reconciliado
            ? { sale: existing!, outcome: 'updated' as const, itemCount: reconciliado }
            : { sale: existing!, outcome: 'unchanged' as const, itemCount: 0 };
        }

        // O árbitro do ON CONFLICT precisa ser o índice que a corrida viola.
        // `reference` é DERIVADA de (empresa, usuario, canal, pedido externo),
        // então os índices de unicidade expressam o mesmo fato para vendas de
        // marketplace e arbitrar por `reference` resolve o caso SEQUENCIAL.
        // O caso SIMULTÂNEO continua possível: o PostgreSQL checa os índices
        // únicos na ordem de criação e pode acusar o composto antes de chegar
        // ao árbitro — por isso a transação é envolvida em
        // `runInTransactionComCorrida`, que repete o upsert uma vez que a
        // entrega concorrente comita (o resultado continua idempotente).
        const { rows } = await tx.query<SaleRawRow>(
          `INSERT INTO sales (
             id, reference, quantity, amount_cents, currency, status, occurred_at,
             channel, external_order_id, usuario_id, empresa_id, buyer_name, buyer_email,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6::sale_status, $7, $8::sale_channel, $9, $10, $11, $12, $13, now(), now()
           )
           ON CONFLICT (reference) DO UPDATE SET
             quantity    = EXCLUDED.quantity,
             amount_cents= EXCLUDED.amount_cents,
             currency    = EXCLUDED.currency,
             status      = EXCLUDED.status,
             occurred_at = EXCLUDED.occurred_at,
             buyer_name  = COALESCE(EXCLUDED.buyer_name, sales.buyer_name),
             buyer_email = COALESCE(EXCLUDED.buyer_email, sales.buyer_email),
             updated_at  = now()
           RETURNING ${SALE_COLUMNS}, (xmax = 0) AS was_inserted`,
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
            actorId,
            tenantId,
            optionalText(input.buyerName),
            optionalText(input.buyerEmail),
          ]
        );
        const sale = mapSale(rows[0] as SaleRawRow);

        // Itens: reescrita em bloco dentro da transação. Reprocessar um
        // pedido corrigido (quantidade alterada, item cancelado) nunca
        // deixa linha órfã nem duplicada.
        const itemCount = await gravarItensDaIngestao(tx, tenantId, sale.id, input.items);

        return { sale, outcome: rows[0]?.was_inserted === true ? ('created' as const) : ('updated' as const), itemCount };
      });

      // Motor analítico "1. MEU NEGÓCIOS": avisa o servidor que a venda
      // mudou (fora da transação — o recálculo de margem/ABC é best
      // effort e jamais pode reverter uma ingestão confirmada).
      // Reentrega idêntica (`unchanged`) não precisa de recálculo.
      if (result.outcome !== 'unchanged') {
        await notifySaleIngested({ empresaId: result.sale.empresaId, saleId: result.sale.id, outcome: result.outcome, channel: result.sale.channel });
      }
      return result;
    },

    /** Vendas recentes de um canal (tela de detalhe do conector). */
    async listRecentSales(empresaId: number, usuarioId: number, channel: SaleChannelName, limit = 20): Promise<SaleRow[]> {
      const tenantId = positiveInt(empresaId);
      const actorId = positiveInt(usuarioId);
      if (!tenantId || !actorId) throw new Error('A leitura de vendas exige empresaId e usuarioId explícitos e válidos.');
      const db = resolveDb();
      const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
      const { rows } = await db.query<SaleRawRow>(
        `SELECT ${SALE_COLUMNS} FROM sales
         WHERE empresa_id = $1 AND usuario_id = $2 AND channel = $3::sale_channel
         ORDER BY occurred_at DESC
         LIMIT $4`,
        [tenantId, actorId, channel, take]
      );
      return rows.map(mapSale);
    },
  };
}

export type SalesService = ReturnType<typeof createSalesService>;
