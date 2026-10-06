/**
 * Tratadores unificados de webhook dos provedores.
 *
 * Fonte: `modules/marketplace/webhooks/handlers.ts` do
 * brobond-ai-commerce (PR012/PR014). ADAPTAÇÕES DESTA FASE:
 *
 *   • A entrada deixa de ser o `Request` do Next.js e passa a ser um
 *     `WebhookRequest` neutro (cabeçalhos + bytes crus + URL estática +
 *     query), montado pela rota do Express. O módulo não conhece
 *     framework.
 *   • A resolução de inquilino devolve `usuarioId` (operador do ERP).
 *   • Sem fila externa: o evento é gravado (durável, idempotente) e a
 *     ingestão roda logo em seguida; o que não terminar fica pendente
 *     para a varredura de recuperação.
 *
 * Contrato de cada tratador (preservado do commerce):
 *   1. VERIFICA a assinatura do provedor sobre os BYTES CRUS exatos (um
 *      evento forjado jamais chega ao banco);
 *   2. NORMALIZA o payload em `ParsedWebhookEvent` (id de dedupe, tópico,
 *      pista de inquilino);
 *   3. RESOLVE o responsável pela identidade guardada no conector —
 *      nunca por entrada do chamador;
 *   4. INGERE de forma idempotente em `connector_events`.
 */

import { timingSafeEqual } from 'node:crypto';
import { connectorRepository, type ConnectorRepository } from '../core/connector.repository';
import { connectorErrorMessage, WebhookSignatureError } from '../core/errors';
import type { ConnectorProviderName } from '../core/providers';
import type { JsonObject } from '../core/types';
import { verifyMercadoPagoWebhookSignature } from '../mercadopago/mercadopago.service';
import { isSaleIngestionEvent, saleIngestionService, type SaleIngestionService } from '../ingestion/sale-ingestion.service';

/** Requisição de webhook, independente de framework. */
export interface WebhookRequest {
  /** Cabeçalhos em caixa baixa. */
  headers: Record<string, string | undefined>;
  /** Corpo EXATO como chegou (bytes crus) — base de toda assinatura. */
  rawBody: string;
  /**
   * URL absoluta do endpoint, montada a partir do `APP_URL` ESTÁTICO —
   * nunca do `Host` da requisição (o provedor assina a URL cadastrada).
   */
  url: string;
  /** Query string já decodificada. */
  query: Record<string, string>;
}

export interface ParsedWebhookEvent {
  externalEventId: string;
  topic: string | null;
  /** Identidade do provedor usada para resolver o responsável. */
  shopId: string | null;
  payload: JsonObject;
}

export interface WebhookIngestResult {
  received: true;
  /** `ignored` = nenhum responsável é dono dessa identidade de loja. */
  ignored?: boolean;
  /** `duplicate` = chave de entrega já ingerida (reentrega). */
  duplicate?: boolean;
  /** Resultado da ingestão de venda, quando o tópico carrega pedido. */
  sale?: { status: string; outcome?: string; saleId?: string };
}

function asRecord(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : {};
}

function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseJsonBody(rawBody: string): JsonObject {
  try {
    return asRecord(JSON.parse(rawBody || '{}'));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------
// Verificação + normalização por provedor
// ------------------------------------------------------------------

/**
 * Mercado Livre: as notificações não têm HMAC. A integridade é garantida
 * por um segredo compartilhado na própria URL registrada (`?secret=…`).
 * Com `MERCADOLIVRE_WEBHOOK_SECRET` definido, segredo ausente ou errado
 * recusa a entrega.
 */
function parseMercadoLivreEvent(request: WebhookRequest): ParsedWebhookEvent {
  const secret = process.env.MERCADOLIVRE_WEBHOOK_SECRET?.trim();
  if (secret) {
    const presented = request.query.secret ?? '';
    if (!presented || !safeEqual(presented, secret)) {
      throw new WebhookSignatureError('MERCADOLIVRE');
    }
  }
  const body = parseJsonBody(request.rawBody);
  const topic = typeof body.topic === 'string' ? body.topic.trim().toLowerCase() : 'unknown';
  const userId = body.user_id !== undefined ? String(body.user_id) : null;
  const id = typeof body._id === 'string' ? body._id : `${topic}:${String(body.resource ?? '-')}`;
  return { externalEventId: `meli:${id}`, topic, shopId: userId, payload: body };
}

/** Mercado Pago: manifesto HMAC em `x-signature` (ver mercadopago.service). */
function parseMercadoPagoEvent(request: WebhookRequest): ParsedWebhookEvent {
  const body = parseJsonBody(request.rawBody);
  const data = asRecord(body.data);
  const dataId = data.id !== undefined ? String(data.id) : '';
  const verified = verifyMercadoPagoWebhookSignature({
    dataId,
    xSignature: request.headers['x-signature'] ?? null,
    xRequestId: request.headers['x-request-id'] ?? null,
  });
  if (!verified) throw new WebhookSignatureError('MERCADOPAGO');
  const type = typeof body.type === 'string' ? body.type : 'unknown';
  const id = body.id !== undefined ? String(body.id) : `${type}:${dataId}:${String(body.date_created ?? '-')}`;
  const userId = body.user_id !== undefined ? String(body.user_id) : null;
  return { externalEventId: `mp:${id}`, topic: type, shopId: userId, payload: body };
}

/**
 * Nuvemshop (plataforma-ponte): o parser oficial — com verificação de
 * assinatura do webhook — chega junto com o `nuvemshop.service.ts`.
 * Até lá o entry é FAIL-CLOSED: nenhuma entrega é aceita sem a
 * verificação criptográfica, e nenhuma credencial de loja existe para
 * resolver responsável. A rota responde 401 e a plataforma reentrega
 * quando a integração estiver ativa.
 */
function parseNuvemshopEvent(_request: WebhookRequest): ParsedWebhookEvent {
  throw new WebhookSignatureError('NUVEMSHOP');
}

/**
 * Mapa provedor → parser. EXAUSTIVO sobre o trio de produção: o
 * compilador recusa uma chave a mais ou a menos. Não há entrada morta
 * para os conectores desprovisionados (Shopee/TikTok) nem para o
 * Instagram.
 */
const PARSERS: Record<ConnectorProviderName, (request: WebhookRequest) => ParsedWebhookEvent> = {
  MERCADOLIVRE: parseMercadoLivreEvent,
  MERCADOPAGO: parseMercadoPagoEvent,
  NUVEMSHOP: parseNuvemshopEvent,
};

// ------------------------------------------------------------------
// Ingestão
// ------------------------------------------------------------------

export interface WebhookHandlerDependencies {
  repository?: ConnectorRepository;
  ingestion?: SaleIngestionService;
}

export function createWebhookHandlers(deps: WebhookHandlerDependencies = {}) {
  const repository = deps.repository ?? connectorRepository;
  const ingestion = deps.ingestion ?? saleIngestionService;

  return {
    /**
     * Verifica, normaliza e ingere um webhook. NUNCA propaga payload do
     * provedor; só `WebhookSignatureError` sobe (a rota mapeia para 401).
     */
    async handleProviderWebhook(provider: ConnectorProviderName, request: WebhookRequest): Promise<WebhookIngestResult> {
      const parse = PARSERS[provider];
      if (!parse) throw new WebhookSignatureError(provider);

      const event = parse(request);

      // Resolução de inquilino: a identidade guardada no conector é o
      // ÚNICO vínculo confiável entre um evento de entrada e um operador.
      if (!event.shopId) return { received: true, ignored: true };
      const connector = await repository.findByShopId(provider, event.shopId);
      if (!connector) return { received: true, ignored: true };
      const usuarioId = connector.usuarioId;

      const already = await repository.hasEvent(usuarioId, provider, event.externalEventId);
      if (already) return { received: true, duplicate: true };

      await repository.recordEvent(usuarioId, {
        provider,
        externalEventId: event.externalEventId,
        connectorId: connector.id,
        topic: event.topic,
        payload: event.payload,
      });

      if (!isSaleIngestionEvent(provider, event.topic)) {
        // Tópico sem receita: encerrado aqui, a caixa de entrada nunca
        // acumula entrega que ninguém vai processar.
        await repository.markEventProcessed(usuarioId, provider, event.externalEventId);
        return { received: true };
      }

      try {
        const result = await ingestion.processSaleIngestionEvent({
          usuarioId,
          provider,
          externalEventId: event.externalEventId,
        });
        return {
          received: true,
          sale: { status: result.status, outcome: result.outcome, saleId: result.saleId },
        };
      } catch (error) {
        // Falha transitória (rede, 5xx do provedor): o evento está
        // durável com `processed_at = NULL` e a varredura de recuperação
        // retoma. O provedor recebe 200 — reentrega às cegas só pioraria.
        console.warn(`⚠️  Ingestão de venda adiada — ${provider}/${event.externalEventId}:`, connectorErrorMessage(error));
        return { received: true, sale: { status: 'deferred' } };
      }
    },
  };
}

export const webhookHandlers = createWebhookHandlers();

/** Atalho do tratador padrão. */
export function handleProviderWebhook(provider: ConnectorProviderName, request: WebhookRequest): Promise<WebhookIngestResult> {
  return webhookHandlers.handleProviderWebhook(provider, request);
}
