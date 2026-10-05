/**
 * Superfície de plug-in da camada de conectores: o contrato
 * `ProviderConnector` que todo adaptador de plataforma implementa, a
 * forma normalizada do catálogo que eles devolvem e a sonda de saúde.
 *
 * Fonte: `modules/connectors/core/connector.interface.ts` do
 * brobond-ai-commerce (PR005/PR012). ADAPTAÇÕES:
 *
 *   • `organizationId?: string` → `usuarioId: number` em
 *     `FetchCatalogOptions` (tenancy do ERP).
 *   • O enum `ConnectorPlatform` do Prisma deu lugar ao
 *     `ConnectorProviderName` puro (`core/providers.ts`) — sem import de
 *     cliente de banco em arquivo de contrato.
 *   • `MOCK` e `INSTAGRAM` saíram do contrato: restaram os QUATRO
 *     provedores core.
 */

import type { ConnectorProviderName } from './providers';

/** Tipos de conteúdo que um conector pode trazer do provedor. */
export const EXTERNAL_CONTENT_TYPES = ['PRODUCT', 'ORDER', 'POST', 'VIDEO'] as const;

export type ExternalContentTypeName = (typeof EXTERNAL_CONTENT_TYPES)[number];

/**
 * A forma NORMALIZADA que todo conector devolve — a razão de ser do
 * framework. O adaptador mapeia o payload do provedor para este contrato,
 * e nada rio abaixo (contadores, KPIs, painel) precisa saber de onde veio.
 *
 * `externalId` é a chave de deduplicação.
 */
export interface NormalizedContent {
  /** Id estável do item na plataforma de origem (chave de dedupe). */
  externalId: string;
  type: ExternalContentTypeName;
  title: string;
  url?: string;
  thumbnailUrl?: string;
  caption?: string;
  /** Preço unitário em CENTAVOS, quando o item for um produto. */
  priceCents?: number;
  currency?: string;
  /** SKU do item no provedor — usado no casamento com `produtos`. */
  sku?: string;
  /** Publicação na plataforma de origem (NÃO a hora da importação). */
  publishedAt?: Date;
  /** Payload literal do provedor, guardado para reprocessamento. */
  raw?: Record<string, unknown>;
}

/** Opções aceitas por `fetchCatalog()`. */
export interface FetchCatalogOptions {
  /** Escopo de responsável — injetado pelo servidor, nunca pelo cliente. */
  usuarioId: number;
  /** Teto de itens. O adaptador DEVE respeitar. */
  limit?: number;
}

/** Resultado de `testConnection()` — nunca lança, sempre reporta. */
export interface ConnectorHealth {
  provider: ConnectorProviderName;
  /** `true` só quando o adaptador consegue mesmo servir conteúdo. */
  ok: boolean;
  /** Variáveis de ambiente da aplicação faltando. */
  missingEnv: string[];
  /** Explicação pt-BR mostrada no painel. */
  message: string;
}

/**
 * Um conector de plataforma. As implementações são livres de efeito
 * colateral na construção (o mapeador central as instancia de forma
 * preguiçosa e as mantém em cache) e são resolvidas EXCLUSIVAMENTE por
 * `getConnector(provider)` (`connector.factory.ts`) — nunca instanciadas
 * à mão e nunca escolhidas por um `switch` fora do mapeador.
 */
export interface ProviderConnector {
  /** Com qual plataforma este conector conversa. */
  readonly provider: ConnectorProviderName;
  /** Nome legível exibido no painel. */
  readonly name: string;
  /**
   * Busca o catálogo/feed da plataforma, já normalizado.
   * @throws {ConnectorError} quando a conta não está autorizada.
   */
  fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]>;
  /**
   * Sonda o conector. NUNCA lança — reporta prontidão de ambiente e de
   * conectividade para que a UI mostre isso com calma.
   */
  testConnection(): Promise<ConnectorHealth>;
}
