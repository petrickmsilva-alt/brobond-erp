/**
 * `InstagramConnectorService` — motor de escuta e processamento do
 * canal Instagram Shopping.
 *
 * INDEPENDÊNCIA ARQUITETURAL (exigência do Diretor): esta classe não
 * importa NADA de `mercadolivre/`, `mercadopago/` ou `nuvemshop/`, não
 * passa pelo despachante genérico de webhooks e não compartilha estado
 * com nenhum outro canal. Ela conversa apenas com:
 *
 *   • `instagram.service.ts` — a API da Meta (assinatura, parsing, OAuth);
 *   • `core/connector.repository.ts` — `connectors` e `connector_events`;
 *   • `ingestion/sales.service.ts` — o upsert IDEMPOTENTE de `sales` /
 *     `sale_items`, que é a implementação de persistência do caso de uso
 *     de ingestão de pedido do ERP (`IngestOrderUseCase` em
 *     `packages/domain` é o mesmo contrato no nível do agregado puro:
 *     pedido → venda + itens + baixa + recebível + auditoria).
 *
 * Desligar o Instagram é apagar esta pasta e três linhas de registro.
 *
 * ──────────────────────────────────────────────────────────────────────
 * HONESTIDADE DO PAINEL — leia antes de mexer nos contadores
 * ──────────────────────────────────────────────────────────────────────
 * A Graph API da Meta NÃO emite evento de compra nem de sacolinha para
 * terceiros (ver o cabeçalho de `instagram.service.ts`). O que entra por
 * este serviço, hoje, é INTERAÇÃO — e é exatamente isso que a caixa
 * "Webhooks — eventos recebidos" mostra.
 *
 * O caminho de receita existe, está testado e é idempotente, mas é
 * DIRIGIDO POR PAYLOAD: só grava em `sales` quando a entrega traz um
 * pedido completo. Enquanto a Meta não entregar pedido, "Pedidos
 * Importados" e "Receita do Canal" mostram ZERO — que é o número
 * verdadeiro. Nenhuma função deste arquivo estima, projeta ou semeia
 * valor.
 */

import { connectorRepository, type ConnectorRepository } from '../core/connector.repository';
import { getConnectorDatabase, type ConnectorDatabase } from '../core/database';
import { connectorErrorMessage, WebhookSignatureError } from '../core/errors';
import type { SaleChannelName } from '../core/providers';
import type { ConnectorEventRow, ConnectorRow, JsonObject } from '../core/types';
import { createSalesService, type IngestedSaleItemInput, type SalesService, type SaleUpsertOutcome } from '../ingestion/sales.service';
import {
  INSTAGRAM_WEBHOOK_SIGNATURE_HEADER,
  isInstagramSaleTopic,
  mapInstagramOrderPayload,
  parseInstagramWebhookPayload,
  verifyInstagramWebhookChallenge,
  verifyInstagramWebhookSignature,
  type InstagramChallengeQuery,
  type InstagramOrder,
  type InstagramWebhookEvent,
} from './instagram.service';

/** Provedor deste conector no enum `connector_provider`. */
export const INSTAGRAM_PROVIDER = 'INSTAGRAM' as const;

/**
 * Canal gravado em `sales.channel`. É `INSTAGRAM_SHOPPING` — o valor do
 * enum `sale_channel` (migração `0015_instagram_shopping_channel`), e o
 * único rótulo que o motor financeiro aceita para este canal.
 */
export const INSTAGRAM_SALE_CHANNEL: SaleChannelName = 'INSTAGRAM_SHOPPING';

// ------------------------------------------------------------------
// Contratos de entrada e saída
// ------------------------------------------------------------------

/** Requisição de webhook, independente de framework (igual ao core). */
export interface InstagramWebhookRequest {
  /** Cabeçalhos em caixa baixa. */
  headers: Record<string, string | undefined>;
  /** Corpo EXATO como chegou — a assinatura é calculada sobre ele. */
  rawBody: string;
  /** Query string já decodificada. */
  query: Record<string, string>;
}

export interface InstagramIngestedOrder {
  saleId: string;
  externalOrderId: string;
  outcome: SaleUpsertOutcome;
  amountCents: number;
}

export interface InstagramWebhookResult {
  received: true;
  /** Entregas novas gravadas em `connector_events`. */
  accepted: number;
  /** Reentregas reconhecidas e descartadas pela chave de idempotência. */
  duplicates: number;
  /** Entradas sem dono (conta do Instagram não conectada por ninguém). */
  ignored: number;
  /** Vendas criadas/atualizadas nesta entrega (vazio é o caso normal). */
  orders: InstagramIngestedOrder[];
}

// ------------------------------------------------------------------
// DTOs do painel analítico
// ------------------------------------------------------------------

export interface InstagramPanelSale {
  id: string;
  reference: string;
  externalOrderId: string | null;
  status: string;
  quantity: number;
  amountCents: number;
  currency: string;
  occurredAt: string;
}

export interface InstagramPanelEvent {
  id: string;
  externalEventId: string;
  topic: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface InstagramPanelContent {
  id: string;
  produto: string | null;
  sku: string | null;
  variacao: string | null;
  tamanho: string | null;
  quantity: number;
  subtotalCents: number;
  occurredAt: string;
  matched: boolean;
}

/**
 * Snapshot que alimenta a `ConectorPage.tsx` do Instagram: a MESMA forma
 * que o painel genérico devolve para os outros canais, porém calculada
 * pelas consultas deste serviço.
 */
export interface InstagramPanelSnapshot {
  provider: typeof INSTAGRAM_PROVIDER;
  /** "Receita do Canal" — SOMA real de `sales`, exceto cancelados. */
  revenueCents: number;
  /** "Pedidos Importados" — CONTAGEM real de `sales` do canal. */
  salesCount: number;
  /** Total de entregas na caixa "Webhooks — eventos recebidos". */
  eventCount: number;
  sales: InstagramPanelSale[];
  events: InstagramPanelEvent[];
  importedContent: InstagramPanelContent[];
}

// ------------------------------------------------------------------
// Utilitários locais
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
  const out = String(value).trim();
  return out ? out : null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface InstagramConnectorServiceDependencies {
  repository?: ConnectorRepository;
  sales?: SalesService;
  resolveDb?: () => ConnectorDatabase;
  now?: () => Date;
}

// ------------------------------------------------------------------
// Serviço
// ------------------------------------------------------------------

export class InstagramConnectorService {
  private readonly repository: ConnectorRepository;
  private readonly sales: SalesService;
  private readonly resolveDb: () => ConnectorDatabase;
  private readonly now: () => Date;

  constructor(deps: InstagramConnectorServiceDependencies = {}) {
    this.repository = deps.repository ?? connectorRepository;
    this.resolveDb = deps.resolveDb ?? (() => getConnectorDatabase());
    this.sales = deps.sales ?? createSalesService(this.resolveDb);
    this.now = deps.now ?? (() => new Date());
  }

  // ----------------------------------------------------------------
  // 1) Escuta — handshake e recepção do webhook da Meta
  // ----------------------------------------------------------------

  /**
   * Handshake `GET` do cadastro do webhook. Devolve o `hub.challenge`
   * que a rota precisa ecoar em TEXTO PURO, ou `null` quando o
   * `hub.verify_token` não confere (a rota responde 403).
   */
  verifySubscription(query: InstagramChallengeQuery): string | null {
    return verifyInstagramWebhookChallenge(query);
  }

  /**
   * Recebe UMA entrega `POST` da Meta de ponta a ponta:
   *
   *   1. VERIFICA o HMAC-SHA256 do corpo cru (`x-hub-signature-256`);
   *      entrega forjada nunca chega ao banco;
   *   2. NORMALIZA o corpo nas entradas que ele carrega (a Meta envia
   *      várias contas e vários eventos num mesmo POST);
   *   3. RESOLVE o dono pela conta do Instagram gravada no conector —
   *      jamais por dado do chamador;
   *   4. GRAVA de forma IDEMPOTENTE em `connector_events`;
   *   5. INGERE em `sales` apenas o que for pedido de verdade.
   *
   * Só `WebhookSignatureError` sobe (a rota mapeia para 401). Falha de
   * ingestão deixa o evento pendente para a varredura de recuperação em
   * vez de devolver erro à Meta — reentrega às cegas só pioraria.
   */
  async handleWebhook(request: InstagramWebhookRequest): Promise<InstagramWebhookResult> {
    const signature = request.headers[INSTAGRAM_WEBHOOK_SIGNATURE_HEADER] ?? null;
    if (!verifyInstagramWebhookSignature(request.rawBody, signature)) {
      throw new WebhookSignatureError(INSTAGRAM_PROVIDER);
    }

    const body = this.parseBody(request.rawBody);
    const events = parseInstagramWebhookPayload(body, this.now());

    const result: InstagramWebhookResult = { received: true, accepted: 0, duplicates: 0, ignored: 0, orders: [] };
    // Cache por entrega: um POST da Meta costuma trazer vários eventos
    // da MESMA conta — uma consulta de dono por conta, não por evento.
    const owners = new Map<string, ConnectorRow | null>();

    for (const event of events) {
      let connector = owners.get(event.igUserId);
      if (connector === undefined) {
        connector = await this.repository.findByShopId(INSTAGRAM_PROVIDER, event.igUserId);
        owners.set(event.igUserId, connector);
      }
      if (!connector) {
        result.ignored += 1;
        continue;
      }

      const outcome = await this.recordAndProcess(connector, event);
      if (outcome.duplicate) result.duplicates += 1;
      else result.accepted += 1;
      if (outcome.order) result.orders.push(outcome.order);
    }

    return result;
  }

  /** Corpo cru → JSON. Corpo inválido vira objeto vazio (0 eventos). */
  private parseBody(rawBody: string): JsonObject {
    try {
      const parsed: unknown = JSON.parse(rawBody || '{}');
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
    } catch {
      return {};
    }
  }

  /** Grava o evento (idempotente) e processa o que for pedido. */
  private async recordAndProcess(
    connector: ConnectorRow,
    event: InstagramWebhookEvent
  ): Promise<{ duplicate: boolean; order?: InstagramIngestedOrder }> {
    const usuarioId = connector.usuarioId;

    const already = await this.repository.hasEvent(usuarioId, INSTAGRAM_PROVIDER, event.externalEventId);
    if (already) return { duplicate: true };

    await this.repository.recordEvent(usuarioId, {
      provider: INSTAGRAM_PROVIDER,
      externalEventId: event.externalEventId,
      connectorId: connector.id,
      topic: event.topic,
      payload: event.payload,
    });

    if (!isInstagramSaleTopic(event.topic)) {
      // Interação (comentário, menção, DM, referral de sacolinha): a
      // entrega está completa aqui. Carimbar evita caixa de entrada
      // acumulando evento que ninguém vai processar.
      await this.repository.markEventProcessed(usuarioId, INSTAGRAM_PROVIDER, event.externalEventId);
      return { duplicate: false };
    }

    try {
      const order = await this.processSaleEvent(usuarioId, event.externalEventId);
      return { duplicate: false, order: order ?? undefined };
    } catch (error) {
      // Falha transitória: o evento fica com `processed_at = NULL` e a
      // varredura retoma. A Meta recebe 200.
      console.warn(`⚠️  Ingestão do Instagram adiada — ${event.externalEventId}:`, connectorErrorMessage(error));
      return { duplicate: false };
    }
  }

  // ----------------------------------------------------------------
  // 2) Processamento — pedido da Meta → agregado `Order` → `sales`
  // ----------------------------------------------------------------

  /**
   * Processa UMA entrega já gravada na caixa de entrada. Seguro para
   * chamar repetidamente: o evento só é carimbado depois de um desfecho
   * terminal e o upsert é guardado pela chave única de idempotência.
   *
   * Devolve `null` quando a entrega não carrega pedido — que é o caso de
   * 100% dos webhooks que a Meta emite hoje.
   */
  async processSaleEvent(usuarioId: number, externalEventId: string): Promise<InstagramIngestedOrder | null> {
    const event = await this.repository.findEvent(usuarioId, INSTAGRAM_PROVIDER, externalEventId);
    if (!event || event.processedAt) return null;

    const order = mapInstagramOrderPayload(event.payload ?? {});
    if (!order) {
      // Sem pedido no corpo: desfecho TERMINAL. Nada é inventado e a
      // entrega não trava a caixa de entrada.
      await this.repository.markEventProcessed(usuarioId, INSTAGRAM_PROVIDER, externalEventId);
      return null;
    }

    const ingested = await this.ingestOrder(usuarioId, order);
    await this.repository.markEventProcessed(usuarioId, INSTAGRAM_PROVIDER, externalEventId);
    return ingested;
  }

  /**
   * Converte o pedido normalizado da Meta no contrato de ingestão de
   * pedido do ERP e grava em `sales` / `sale_items`.
   *
   * IDEMPOTÊNCIA: o upsert aterrissa na chave única
   * `(usuario_id, channel, external_order_id)` com
   * `channel = 'INSTAGRAM_SHOPPING'`. Reprocessar o mesmo pedido
   * ATUALIZA a linha — nunca duplica receita. Os itens são reescritos em
   * bloco dentro da mesma transação.
   */
  async ingestOrder(usuarioId: number, order: InstagramOrder): Promise<InstagramIngestedOrder> {
    const items: IngestedSaleItemInput[] = order.items.map((item) => ({
      sku: item.sku,
      title: item.title,
      variacaoExterna: item.variacaoExterna,
      sizeLabel: item.sizeLabel,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    }));

    const quantity = items.reduce((sum, item) => sum + Math.max(1, Math.trunc(item.quantity) || 1), 0);

    const { sale, outcome } = await this.sales.upsertIngestedSale(usuarioId, {
      channel: INSTAGRAM_SALE_CHANNEL,
      externalOrderId: order.id,
      amountCents: order.totalAmountCents,
      currency: order.currency,
      status: order.status,
      quantity: quantity > 0 ? quantity : 1,
      occurredAt: order.occurredAt,
      items,
    });

    // Contadores reais do cartão do canal — alimentam o KPI "Pedidos
    // Importados" sem nenhuma contagem paralela.
    await this.repository.incrementIngestionCounters(usuarioId, INSTAGRAM_PROVIDER, {
      imported: outcome === 'unchanged' ? 0 : 1,
      duplicated: outcome === 'unchanged' ? 1 : 0,
      failed: 0,
    });

    return { saleId: sale.id, externalOrderId: order.id, outcome, amountCents: sale.amountCents };
  }

  /**
   * Varredura de recuperação do canal: retoma as entregas que ficaram
   * pendentes (processo reiniciado no meio, banco momentaneamente fora).
   */
  async processPendingEvents(options: { limit?: number; olderThanMs?: number; maxAgeMs?: number } = {}): Promise<{
    processed: number;
    failed: number;
  }> {
    const now = this.now().getTime();
    const pending = await this.repository.listPendingSaleEvents({
      providers: [INSTAGRAM_PROVIDER],
      before: new Date(now - (options.olderThanMs ?? 60_000)),
      after: new Date(now - (options.maxAgeMs ?? 7 * 24 * 3600_000)),
      limit: options.limit ?? 50,
    });

    let processed = 0;
    let failed = 0;
    for (const item of pending) {
      try {
        await this.processSaleEvent(item.usuarioId, item.externalEventId);
        processed += 1;
      } catch (error) {
        failed += 1;
        console.warn(`⚠️  Falha ao reprocessar evento do Instagram ${item.externalEventId}:`, connectorErrorMessage(error));
      }
    }
    return { processed, failed };
  }

  // ----------------------------------------------------------------
  // 3) Leitura — funções de banco que alimentam a ConectorPage.tsx
  // ----------------------------------------------------------------

  /** "Pedidos Importados": contagem real de `sales` do canal. */
  async countImportedOrders(usuarioId: number): Promise<number> {
    const { rows } = await this.resolveDb().query<{ total: string | number | null }>(
      `SELECT COUNT(*) AS total FROM sales WHERE usuario_id = $1 AND channel = $2::sale_channel`,
      [usuarioId, INSTAGRAM_SALE_CHANNEL]
    );
    return toNumber(rows[0]?.total);
  }

  /** "Receita do Canal": soma em CENTAVOS, pedidos cancelados fora. */
  async sumChannelRevenueCents(usuarioId: number): Promise<number> {
    const { rows } = await this.resolveDb().query<{ total: string | number | null }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM sales
        WHERE usuario_id = $1 AND channel = $2::sale_channel AND status <> 'CANCELLED'`,
      [usuarioId, INSTAGRAM_SALE_CHANNEL]
    );
    return toNumber(rows[0]?.total);
  }

  /** Total de entregas recebidas da Meta (denominador da caixa). */
  async countWebhookEvents(usuarioId: number): Promise<number> {
    const { rows } = await this.resolveDb().query<{ total: string | number | null }>(
      `SELECT COUNT(*) AS total FROM connector_events WHERE usuario_id = $1 AND provider = $2::connector_provider`,
      [usuarioId, INSTAGRAM_PROVIDER]
    );
    return toNumber(rows[0]?.total);
  }

  /** "Webhooks — eventos recebidos": as entregas mais recentes. */
  async listWebhookEvents(usuarioId: number, limit = 10): Promise<InstagramPanelEvent[]> {
    const rows: ConnectorEventRow[] = await this.repository.listRecentEvents(usuarioId, INSTAGRAM_PROVIDER, clampLimit(limit));
    return rows.map((event) => ({
      id: event.id,
      externalEventId: event.externalEventId,
      topic: event.topic,
      processedAt: toIsoOrNull(event.processedAt),
      createdAt: toIso(event.createdAt),
    }));
  }

  /** "Vendas do canal": as vendas realmente gravadas em `sales`. */
  async listChannelSales(usuarioId: number, limit = 10): Promise<InstagramPanelSale[]> {
    const { rows } = await this.resolveDb().query<Record<string, unknown>>(
      `SELECT id, reference, external_order_id, status, quantity, amount_cents, currency, occurred_at
         FROM sales
        WHERE usuario_id = $1 AND channel = $2::sale_channel
        ORDER BY occurred_at DESC
        LIMIT $3`,
      [usuarioId, INSTAGRAM_SALE_CHANNEL, clampLimit(limit)]
    );
    return rows.map((row) => ({
      id: String(row.id),
      reference: String(row.reference ?? ''),
      externalOrderId: toText(row.external_order_id),
      status: String(row.status ?? 'PENDING'),
      quantity: toNumber(row.quantity),
      amountCents: toNumber(row.amount_cents),
      currency: String(row.currency ?? 'BRL'),
      occurredAt: toIso(row.occurred_at as Date | string | null),
    }));
  }

  /** "Conteúdo importado desta plataforma": itens casados com o catálogo. */
  async listImportedContent(usuarioId: number, limit = 10): Promise<InstagramPanelContent[]> {
    const { rows } = await this.resolveDb().query<Record<string, unknown>>(
      `SELECT si.id,
              p.nome   AS produto,
              p.sku    AS sku,
              t.codigo AS tamanho,
              si.variacao_externa,
              si.quantity,
              si.subtotal_cents,
              si.product_id,
              s.occurred_at
         FROM sale_items si
         JOIN sales s          ON s.id = si.sale_id
         LEFT JOIN produtos p  ON p.id = si.product_id
         LEFT JOIN tamanhos t  ON t.id = si.size_id
        WHERE s.usuario_id = $1 AND s.channel = $2::sale_channel
        ORDER BY s.occurred_at DESC, si.id ASC
        LIMIT $3`,
      [usuarioId, INSTAGRAM_SALE_CHANNEL, clampLimit(limit)]
    );
    return rows.map((row) => ({
      id: String(row.id),
      produto: toText(row.produto),
      sku: toText(row.sku),
      variacao: toText(row.variacao_externa),
      tamanho: toText(row.tamanho),
      quantity: toNumber(row.quantity),
      subtotalCents: toNumber(row.subtotal_cents),
      occurredAt: toIso(row.occurred_at as Date | string | null),
      matched: row.product_id !== null && row.product_id !== undefined,
    }));
  }

  /**
   * Snapshot completo do painel do canal. SOMENTE LEITURA, sempre
   * escopado ao operador e sem nenhum material secreto: o navegador
   * recebe contadores e rótulos, nunca credencial.
   */
  async getPanel(usuarioId: number, limit = 10): Promise<InstagramPanelSnapshot> {
    const take = clampLimit(limit);
    const [revenueCents, salesCount, eventCount, sales, events, importedContent] = await Promise.all([
      this.sumChannelRevenueCents(usuarioId),
      this.countImportedOrders(usuarioId),
      this.countWebhookEvents(usuarioId),
      this.listChannelSales(usuarioId, take),
      this.listWebhookEvents(usuarioId, take),
      this.listImportedContent(usuarioId, take),
    ]);
    return { provider: INSTAGRAM_PROVIDER, revenueCents, salesCount, eventCount, sales, events, importedContent };
  }
}

/** Instância padrão (repositório + pool do ERP). */
export const instagramConnectorService = new InstagramConnectorService();
