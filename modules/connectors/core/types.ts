/**
 * Tipos das linhas das tabelas da fusão (Fase 1) em TypeScript estrito.
 *
 * O ERP fala com o Postgres pelo driver `pg` (server/src/db.ts) — não há
 * cliente Prisma em runtime. Estes tipos são o espelho fiel dos modelos
 * `Connector`, `ConnectorEvent`, `ConnectorOAuthState`, `Sale` e
 * `SaleItem` do `prisma/schema.prisma`, em camelCase, já convertidos a
 * partir das colunas snake_case do banco.
 *
 * TENANCY: `usuarioId: number` (FK → `usuarios.id`) substitui o
 * `organizationId: string` do brobond-ai-commerce em TODOS os modelos.
 */

import type { ConnectionStatusName, ConnectorProviderName, SaleChannelName, SaleStatusName } from './providers';

/** JSON cru guardado em colunas `jsonb`. */
export type JsonObject = Record<string, unknown>;

/** Linha de `connectors` — uma integração ativa de um responsável. */
export interface ConnectorRow {
  id: string;
  /** FUSÃO: era `organizationId` no commerce. */
  usuarioId: number;
  provider: ConnectorProviderName;
  status: ConnectionStatusName;
  /** Identidade no provedor (shop id, user id, collector id). */
  shopId: string | null;
  shopName: string | null;
  /** Cifras AES-256-GCM (`v1.iv.tag.valor`) — jamais texto puro. */
  accessToken: string | null;
  refreshToken: string | null;
  clientSecret: string | null;
  publicKey: string | null;
  expiresAt: Date | null;
  importedCount: number;
  duplicatedCount: number;
  failedCount: number;
  syncCount: number;
  lastSyncAt: Date | null;
  lastError: string | null;
  metadata: JsonObject | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Linha de `connector_events` — evento bruto de webhook/polling. */
export interface ConnectorEventRow {
  id: string;
  usuarioId: number;
  connectorId: string | null;
  provider: ConnectorProviderName;
  externalEventId: string;
  topic: string | null;
  payload: JsonObject | null;
  processedAt: Date | null;
  createdAt: Date;
}

/** Linha de `sales` — receita multicanal (valores em CENTAVOS). */
export interface SaleRow {
  id: string;
  reference: string;
  quantity: number;
  amountCents: number;
  currency: string;
  status: SaleStatusName;
  occurredAt: Date;
  channel: SaleChannelName;
  externalOrderId: string | null;
  usuarioId: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Linha de `sale_items` — item casado com o catálogo real do ERP. */
export interface SaleItemRow {
  id: string;
  saleId: string;
  productId: number | null;
  sizeId: number | null;
  variacaoExterna: string | null;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  subtotalCents: number;
  createdAt: Date;
}

/** Credenciais cifradas gravadas num upsert de conexão. */
export interface ConnectorCredentialsPayload {
  accessToken?: string | null;
  refreshToken?: string | null;
  clientSecret?: string | null;
  publicKey?: string | null;
  expiresAt?: Date | null;
  shopId?: string | null;
  shopName?: string | null;
  metadata?: JsonObject | null;
}

/** Contadores reais de uma execução de sincronização. */
export interface ConnectorSyncCounters {
  imported: number;
  duplicated: number;
  failed: number;
}

/**
 * Projeção segura de um conector para o painel: ZERO material secreto.
 * Os campos cifrados viram apenas booleanos/prévias mascaradas.
 */
export interface ConnectorStatusDTO {
  provider: ConnectorProviderName;
  label: string;
  description: string;
  authModel: 'oauth2' | 'credentials';
  status: ConnectionStatusName;
  statusLabel: string;
  connected: boolean;
  /** `true` quando as variáveis de ambiente da aplicação estão presentes. */
  configured: boolean;
  /** Variáveis de ambiente faltando (vazio quando `configured`). */
  missingEnv: string[];
  shopId: string | null;
  shopName: string | null;
  expiresAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  importedCount: number;
  duplicatedCount: number;
  failedCount: number;
  syncCount: number;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  /** Há um par Mercado Pago no ambiente que pode ser ativado sem expor segredos ao navegador. */
  environmentCredentialsAvailable: boolean;
  /** Prévia mascarada da public key do Mercado Pago, quando houver. */
  publicKeyPreview: string | null;
  requiresReauth: boolean;
  updatedAt: string | null;
}
