/**
 * Repositório canônico das tabelas `connectors` e `connector_events`.
 * O tenant é sempre a empresa confiável resolvida na sessão ou no state
 * OAuth de uso único. `usuarioId` também é obrigatório, mas nunca substitui
 * `empresaId`. A resolução de webhook por loja é a única leitura sem tenant
 * de entrada: exige identidade de loja única e devolve a empresa persistida.
 */

import { getConnectorDatabase, type ConnectorDatabase } from './database';
import { connectorCuid } from './id';
import type { ConnectionStatusName, ConnectorProviderName } from './providers';
import type { ConnectorCredentialsPayload, ConnectorEventRow, ConnectorRow, ConnectorSyncCounters, JsonObject } from './types';

/** Recusa qualquer acesso sem tenant explícito, válido e confiável. */
export function assertEmpresaId(empresaId: number): number {
  if (!Number.isSafeInteger(empresaId) || empresaId <= 0) {
    throw new Error('Escopo empresarial (empresaId) ausente ou inválido.');
  }
  return empresaId;
}

/** Recusa operações sem o responsável autenticado/estabelecido pelo OAuth. */
export function assertUsuarioId(usuarioId: number): number {
  if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0) {
    throw new Error('Escopo de responsável (usuarioId) ausente ou inválido.');
  }
  return usuarioId;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toJson(value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as JsonObject;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as JsonObject) : null;
    } catch {
      return null;
    }
  }
  return null;
}

type RawRow = Record<string, unknown>;

function mapConnector(row: RawRow): ConnectorRow {
  return {
    id: String(row.id),
    empresaId: toInt(row.empresa_id),
    usuarioId: toInt(row.usuario_id),
    provider: String(row.provider) as ConnectorProviderName,
    status: String(row.status) as ConnectionStatusName,
    shopId: row.shop_id === null || row.shop_id === undefined ? null : String(row.shop_id),
    shopName: row.shop_name === null || row.shop_name === undefined ? null : String(row.shop_name),
    accessToken: row.access_token === null || row.access_token === undefined ? null : String(row.access_token),
    refreshToken: row.refresh_token === null || row.refresh_token === undefined ? null : String(row.refresh_token),
    clientSecret: row.client_secret === null || row.client_secret === undefined ? null : String(row.client_secret),
    publicKey: row.public_key === null || row.public_key === undefined ? null : String(row.public_key),
    expiresAt: toDate(row.expires_at),
    importedCount: toInt(row.imported_count),
    duplicatedCount: toInt(row.duplicated_count),
    failedCount: toInt(row.failed_count),
    syncCount: toInt(row.sync_count),
    lastSyncAt: toDate(row.last_sync_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    metadata: toJson(row.metadata),
    createdAt: toDate(row.created_at) ?? new Date(0),
    updatedAt: toDate(row.updated_at) ?? new Date(0),
  };
}

function mapEvent(row: RawRow): ConnectorEventRow {
  return {
    id: String(row.id),
    empresaId: toInt(row.empresa_id),
    usuarioId: toInt(row.usuario_id),
    connectorId: row.connector_id === null || row.connector_id === undefined ? null : String(row.connector_id),
    provider: String(row.provider) as ConnectorProviderName,
    externalEventId: String(row.external_event_id),
    topic: row.topic === null || row.topic === undefined ? null : String(row.topic),
    payload: toJson(row.payload),
    processedAt: toDate(row.processed_at),
    createdAt: toDate(row.created_at) ?? new Date(0),
  };
}

const CONNECTOR_COLUMNS = `
  id, empresa_id, usuario_id, provider, status, shop_id, shop_name, access_token, refresh_token,
  client_secret, public_key, expires_at, imported_count, duplicated_count, failed_count,
  sync_count, last_sync_at, last_error, metadata, created_at, updated_at`;

const EVENT_COLUMNS = `
  id, empresa_id, usuario_id, connector_id, provider, external_event_id, topic, payload,
  processed_at, created_at`;

export interface ConnectorRepository {
  list(empresaId: number, usuarioId: number): Promise<ConnectorRow[]>;
  findByProvider(empresaId: number, usuarioId: number, provider: ConnectorProviderName): Promise<ConnectorRow | null>;
  upsertConnection(
    empresaId: number,
    usuarioId: number,
    provider: ConnectorProviderName,
    data: ConnectorCredentialsPayload & { status: ConnectionStatusName }
  ): Promise<ConnectorRow>;
  saveTokens(
    empresaId: number,
    usuarioId: number,
    id: string,
    tokens: { accessToken: string; refreshToken?: string | null; expiresAt: Date | null }
  ): Promise<ConnectorRow | null>;
  setStatus(
    empresaId: number,
    usuarioId: number,
    provider: ConnectorProviderName,
    status: ConnectionStatusName,
    lastError?: string | null
  ): Promise<ConnectorRow | null>;
  recordSyncResult(
    empresaId: number,
    usuarioId: number,
    provider: ConnectorProviderName,
    result: {
      status: ConnectionStatusName;
      counters: ConnectorSyncCounters;
      lastError?: string | null;
      syncedAt?: Date;
    }
  ): Promise<ConnectorRow | null>;
  clearCredentials(empresaId: number, usuarioId: number, provider: ConnectorProviderName): Promise<ConnectorRow | null>;
  /**
   * Webhook sem sessão: só retorna uma loja se existir UMA única conexão
   * para a identidade externa; ambiguidades entre tenants são recusadas.
   */
  findByShopId(provider: ConnectorProviderName, shopId: string): Promise<ConnectorRow | null>;
  hasEvent(empresaId: number, usuarioId: number, provider: ConnectorProviderName, externalEventId: string): Promise<boolean>;
  recordEvent(
    empresaId: number,
    usuarioId: number,
    event: {
      provider: ConnectorProviderName;
      externalEventId: string;
      connectorId?: string | null;
      topic?: string | null;
      payload?: JsonObject | null;
    }
  ): Promise<ConnectorEventRow | null>;
  markEventProcessed(empresaId: number, usuarioId: number, provider: ConnectorProviderName, externalEventId: string): Promise<void>;
  findEvent(empresaId: number, usuarioId: number, provider: ConnectorProviderName, externalEventId: string): Promise<ConnectorEventRow | null>;
  listRecentEvents(empresaId: number, usuarioId: number, provider: ConnectorProviderName, limit: number): Promise<ConnectorEventRow[]>;
  /** Worker global: retorna tenant junto com cada chave; cada linha é revalidada no processamento. */
  listPendingSaleEvents(input: {
    providers: readonly ConnectorProviderName[];
    before: Date;
    after?: Date;
    limit: number;
  }): Promise<Array<Pick<ConnectorEventRow, 'empresaId' | 'usuarioId' | 'provider' | 'externalEventId'>>>;
  incrementIngestionCounters(
    empresaId: number,
    usuarioId: number,
    provider: ConnectorProviderName,
    counters: Partial<ConnectorSyncCounters>
  ): Promise<ConnectorRow | null>;
}

export function createConnectorRepository(db: ConnectorDatabase): ConnectorRepository {
  async function connectorByProvider(empresaId: number, usuarioId: number, provider: ConnectorProviderName): Promise<ConnectorRow | null> {
    const { rows } = await db.query<RawRow>(
      `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3 LIMIT 1`,
      [empresaId, usuarioId, provider]
    );
    return rows[0] ? mapConnector(rows[0]) : null;
  }

  return {
    async list(empresaId, usuarioId) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE empresa_id = $1 AND usuario_id = $2 ORDER BY provider ASC`,
        [empresaId, usuarioId]
      );
      return rows.map(mapConnector);
    },

    async findByProvider(empresaId, usuarioId, provider) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      return connectorByProvider(empresaId, usuarioId, provider);
    },

    async upsertConnection(empresaId, usuarioId, provider, data) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { status, ...credentials } = data;
      const { rows } = await db.query<RawRow>(
        `INSERT INTO connectors (
           id, empresa_id, usuario_id, provider, status, shop_id, shop_name, access_token, refresh_token,
           client_secret, public_key, expires_at, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now(), now())
         ON CONFLICT (empresa_id, usuario_id, provider) DO UPDATE SET
           status        = EXCLUDED.status,
           shop_id       = COALESCE(EXCLUDED.shop_id, connectors.shop_id),
           shop_name     = COALESCE(EXCLUDED.shop_name, connectors.shop_name),
           access_token  = COALESCE(EXCLUDED.access_token, connectors.access_token),
           refresh_token = COALESCE(EXCLUDED.refresh_token, connectors.refresh_token),
           client_secret = COALESCE(EXCLUDED.client_secret, connectors.client_secret),
           public_key    = COALESCE(EXCLUDED.public_key, connectors.public_key),
           expires_at    = EXCLUDED.expires_at,
           metadata      = COALESCE(EXCLUDED.metadata, connectors.metadata),
           last_error    = NULL,
           updated_at    = now()
         RETURNING ${CONNECTOR_COLUMNS}`,
        [
          connectorCuid(),
          empresaId,
          usuarioId,
          provider,
          status,
          credentials.shopId ?? null,
          credentials.shopName ?? null,
          credentials.accessToken ?? null,
          credentials.refreshToken ?? null,
          credentials.clientSecret ?? null,
          credentials.publicKey ?? null,
          credentials.expiresAt ?? null,
          credentials.metadata ? JSON.stringify(credentials.metadata) : null,
        ]
      );
      return mapConnector(rows[0] as RawRow);
    },

    async saveTokens(empresaId, usuarioId, id, tokens) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET
           access_token  = $4,
           refresh_token = CASE WHEN $5::boolean THEN $6 ELSE refresh_token END,
           expires_at    = $7,
           status        = 'CONNECTED',
           last_error    = NULL,
           updated_at    = now()
         WHERE empresa_id = $1 AND usuario_id = $2 AND id = $3
         RETURNING ${CONNECTOR_COLUMNS}`,
        [empresaId, usuarioId, id, tokens.accessToken, tokens.refreshToken !== undefined, tokens.refreshToken ?? null, tokens.expiresAt]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async setStatus(empresaId, usuarioId, provider, status, lastError = null) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET status = $4, last_error = $5, updated_at = now()
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3
         RETURNING ${CONNECTOR_COLUMNS}`,
        [empresaId, usuarioId, provider, status, lastError]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async recordSyncResult(empresaId, usuarioId, provider, result) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const syncedAt = result.syncedAt ?? new Date();
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET
           status           = $4,
           last_sync_at     = $5,
           last_error       = $6,
           imported_count   = imported_count + $7,
           duplicated_count = duplicated_count + $8,
           failed_count     = failed_count + $9,
           sync_count       = sync_count + 1,
           updated_at       = now()
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3
         RETURNING ${CONNECTOR_COLUMNS}`,
        [
          empresaId,
          usuarioId,
          provider,
          result.status,
          syncedAt,
          result.lastError ?? null,
          Math.max(0, result.counters.imported),
          Math.max(0, result.counters.duplicated),
          Math.max(0, result.counters.failed),
        ]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async clearCredentials(empresaId, usuarioId, provider) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET
           status        = 'DISCONNECTED',
           access_token  = NULL,
           refresh_token = NULL,
           client_secret = NULL,
           public_key    = NULL,
           expires_at    = NULL,
           shop_id       = NULL,
           shop_name     = NULL,
           last_error    = NULL,
           updated_at    = now()
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3
         RETURNING ${CONNECTOR_COLUMNS}`,
        [empresaId, usuarioId, provider]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async findByShopId(provider, shopId) {
      if (!shopId) return null;
      const { rows } = await db.query<RawRow>(
        `SELECT ${CONNECTOR_COLUMNS} FROM connectors
         WHERE provider = $1 AND shop_id = $2
         ORDER BY updated_at DESC, id ASC
         LIMIT 2`,
        [provider, shopId]
      );
      // A identidade externa não pode escolher entre empresas. Se houver
      // mais de um dono, recusamos o webhook em vez de atribuí-lo por ordem.
      return rows.length === 1 ? mapConnector(rows[0]) : null;
    },

    async hasEvent(empresaId, usuarioId, provider, externalEventId) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `SELECT 1 AS ok FROM connector_events
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3 AND external_event_id = $4
         LIMIT 1`,
        [empresaId, usuarioId, provider, externalEventId]
      );
      return rows.length > 0;
    },

    async recordEvent(empresaId, usuarioId, event) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `INSERT INTO connector_events (
           id, empresa_id, usuario_id, connector_id, provider, external_event_id, topic, payload, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
         ON CONFLICT (empresa_id, usuario_id, provider, external_event_id) DO UPDATE SET
           payload      = COALESCE(EXCLUDED.payload, connector_events.payload),
           topic        = COALESCE(EXCLUDED.topic, connector_events.topic),
           connector_id = COALESCE(EXCLUDED.connector_id, connector_events.connector_id)
         RETURNING ${EVENT_COLUMNS}`,
        [
          connectorCuid(),
          empresaId,
          usuarioId,
          event.connectorId ?? null,
          event.provider,
          event.externalEventId,
          event.topic ?? null,
          event.payload ? JSON.stringify(event.payload) : null,
        ]
      );
      return rows[0] ? mapEvent(rows[0]) : null;
    },

    async markEventProcessed(empresaId, usuarioId, provider, externalEventId) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      await db.query(
        `UPDATE connector_events SET processed_at = now()
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3 AND external_event_id = $4 AND processed_at IS NULL`,
        [empresaId, usuarioId, provider, externalEventId]
      );
    },

    async findEvent(empresaId, usuarioId, provider, externalEventId) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `SELECT ${EVENT_COLUMNS} FROM connector_events
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3 AND external_event_id = $4
         LIMIT 1`,
        [empresaId, usuarioId, provider, externalEventId]
      );
      return rows[0] ? mapEvent(rows[0]) : null;
    },

    async listRecentEvents(empresaId, usuarioId, provider, limit) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
      const { rows } = await db.query<RawRow>(
        `SELECT ${EVENT_COLUMNS} FROM connector_events
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3
         ORDER BY created_at DESC
         LIMIT $4`,
        [empresaId, usuarioId, provider, take]
      );
      return rows.map(mapEvent);
    },

    async listPendingSaleEvents(input) {
      if (input.providers.length === 0) return [];
      const take = Math.min(Math.max(Math.trunc(input.limit) || 50, 1), 500);
      const { rows } = await db.query<RawRow>(
        `SELECT empresa_id, usuario_id, provider, external_event_id FROM connector_events
         WHERE processed_at IS NULL
           AND provider = ANY($1::connector_provider[])
           AND created_at <= $2
           AND ($3::timestamptz IS NULL OR created_at >= $3)
         ORDER BY created_at ASC
         LIMIT $4`,
        [input.providers, input.before, input.after ?? null, take]
      );
      return rows.map((row) => ({
        empresaId: toInt(row.empresa_id),
        usuarioId: toInt(row.usuario_id),
        provider: String(row.provider) as ConnectorProviderName,
        externalEventId: String(row.external_event_id),
      }));
    },

    async incrementIngestionCounters(empresaId, usuarioId, provider, counters) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET
           imported_count   = imported_count + $4,
           duplicated_count = duplicated_count + $5,
           failed_count     = failed_count + $6,
           updated_at       = now()
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3
         RETURNING ${CONNECTOR_COLUMNS}`,
        [empresaId, usuarioId, provider, Math.max(0, counters.imported ?? 0), Math.max(0, counters.duplicated ?? 0), Math.max(0, counters.failed ?? 0)]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },
  };
}

/** Repositório padrão, preso ao pool do ERP (resolução preguiçosa). */
export const connectorRepository: ConnectorRepository = createConnectorRepository({
  query: (text, params) => getConnectorDatabase().query(text, params),
});
