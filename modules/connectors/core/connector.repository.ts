/**
 * Repositório dos conectores multicanal — o ÚNICO lugar que fala com as
 * tabelas `connectors`, `connector_events` e `connector_oauth_states`.
 *
 * Fonte: `modules/marketplace/core/connector.repository.ts` do
 * brobond-ai-commerce (PR012). ADAPTAÇÕES DESTA FASE:
 *
 *   • Prisma → SQL puro sobre o pool `pg` do ERP (porta `ConnectorDatabase`).
 *   • CONTRATO DE ISOLAMENTO: onde o commerce recebia `organizationId`
 *     como PRIMEIRO argumento, o ERP recebe `usuarioId: number` (FK →
 *     `usuarios.id`). Nenhuma consulta roda sem esse escopo — a única
 *     exceção documentada é `findByShopId()` (resolução de inquilino de
 *     webhook de entrada: devolve exatamente uma linha candidata e o
 *     CHAMADOR tem de re-escopar tudo pelo `usuarioId` dela) e
 *     `listPendingSaleEvents()` (varredura do worker, que também
 *     re-escopa por linha).
 *   • `createConnectorRepository(db)` continua sendo uma fábrica para que
 *     a segurança de escopo possa ser testada com um executor falso.
 */

import { getConnectorDatabase, type ConnectorDatabase } from './database';
import { connectorCuid } from './id';
import type { ConnectionStatusName, ConnectorProviderName } from './providers';
import type { ConnectorCredentialsPayload, ConnectorEventRow, ConnectorRow, ConnectorSyncCounters, JsonObject } from './types';

// ------------------------------------------------------------------
// Mapeamento linha do banco → tipo do domínio
// ------------------------------------------------------------------

/** Garante que nenhuma consulta rode sem escopo de responsável. */
export function assertUsuarioId(usuarioId: number): number {
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
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
  id, usuario_id, provider, status, shop_id, shop_name, access_token, refresh_token,
  client_secret, public_key, expires_at, imported_count, duplicated_count, failed_count,
  sync_count, last_sync_at, last_error, metadata, created_at, updated_at`;

const EVENT_COLUMNS = `
  id, usuario_id, connector_id, provider, external_event_id, topic, payload,
  processed_at, created_at`;

// ------------------------------------------------------------------
// Contrato
// ------------------------------------------------------------------

export interface ConnectorRepository {
  /** Todas as conexões de um responsável (provedor nunca tocado some). */
  list(usuarioId: number): Promise<ConnectorRow[]>;
  /** Uma conexão, ou `null` quando o provedor nunca foi conectado. */
  findByProvider(usuarioId: number, provider: ConnectorProviderName): Promise<ConnectorRow | null>;
  /** Cria/atualiza a conexão de um provedor para um responsável. */
  upsertConnection(
    usuarioId: number,
    provider: ConnectorProviderName,
    data: ConnectorCredentialsPayload & { status: ConnectionStatusName }
  ): Promise<ConnectorRow>;
  /** Grava tokens rotacionados sem mexer nos contadores. */
  saveTokens(
    usuarioId: number,
    id: string,
    tokens: { accessToken: string; refreshToken?: string | null; expiresAt: Date | null }
  ): Promise<ConnectorRow | null>;
  /** Transiciona o status da conexão (com erro sanitizado opcional). */
  setStatus(
    usuarioId: number,
    provider: ConnectorProviderName,
    status: ConnectionStatusName,
    lastError?: string | null
  ): Promise<ConnectorRow | null>;
  /** Registra o resultado de UMA execução de sincronização. */
  recordSyncResult(
    usuarioId: number,
    provider: ConnectorProviderName,
    result: {
      status: ConnectionStatusName;
      counters: ConnectorSyncCounters;
      lastError?: string | null;
      syncedAt?: Date;
    }
  ): Promise<ConnectorRow | null>;
  /** Revoga a conexão: apaga TODA cifra e marca DISCONNECTED. */
  clearCredentials(usuarioId: number, provider: ConnectorProviderName): Promise<ConnectorRow | null>;
  /**
   * Resolução de inquilino de webhook — NÃO escopada, por projeto. O
   * chamador DEVE tratar o `usuarioId` da linha devolvida como o único
   * escopo confiável.
   */
  findByShopId(provider: ConnectorProviderName, shopId: string): Promise<ConnectorRow | null>;
  /** Este evento já foi ingerido? (sonda de idempotência). */
  hasEvent(usuarioId: number, provider: ConnectorProviderName, externalEventId: string): Promise<boolean>;
  /** Grava um evento de webhook (idempotente na chave de entrega). */
  recordEvent(
    usuarioId: number,
    event: {
      provider: ConnectorProviderName;
      externalEventId: string;
      connectorId?: string | null;
      topic?: string | null;
      payload?: JsonObject | null;
    }
  ): Promise<ConnectorEventRow | null>;
  /** Carimba um evento como processado. */
  markEventProcessed(usuarioId: number, provider: ConnectorProviderName, externalEventId: string): Promise<void>;
  /** Um evento da caixa de entrada pela chave de entrega, ou `null`. */
  findEvent(usuarioId: number, provider: ConnectorProviderName, externalEventId: string): Promise<ConnectorEventRow | null>;
  /** Últimos eventos de um provedor (tela de detalhe do conector). */
  listRecentEvents(usuarioId: number, provider: ConnectorProviderName, limit: number): Promise<ConnectorEventRow[]>;
  /**
   * Varredura do worker — NÃO escopada, por projeto: devolve as chaves de
   * entrega dos eventos ainda pendentes de virar venda. O chamador
   * re-escopa todo o processamento ao `usuarioId` de cada linha.
   */
  listPendingSaleEvents(input: {
    providers: readonly ConnectorProviderName[];
    before: Date;
    after?: Date;
    limit: number;
  }): Promise<Array<Pick<ConnectorEventRow, 'usuarioId' | 'provider' | 'externalEventId'>>>;
  /**
   * Incrementa os contadores de ingestão SEM a semântica de execução de
   * sincronização (`syncCount`/`lastSyncAt`): venda capturada por webhook
   * é dado importado de verdade, mas não é uma "rodada" de sync.
   */
  incrementIngestionCounters(
    usuarioId: number,
    provider: ConnectorProviderName,
    counters: Partial<ConnectorSyncCounters>
  ): Promise<ConnectorRow | null>;
}

// ------------------------------------------------------------------
// Implementação
// ------------------------------------------------------------------

export function createConnectorRepository(db: ConnectorDatabase): ConnectorRepository {
  async function connectorByProvider(usuarioId: number, provider: ConnectorProviderName): Promise<ConnectorRow | null> {
    const { rows } = await db.query<RawRow>(`SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE usuario_id = $1 AND provider = $2 LIMIT 1`, [
      usuarioId,
      provider,
    ]);
    return rows[0] ? mapConnector(rows[0]) : null;
  }

  return {
    async list(usuarioId) {
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(`SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE usuario_id = $1 ORDER BY provider ASC`, [
        usuarioId,
      ]);
      return rows.map(mapConnector);
    },

    async findByProvider(usuarioId, provider) {
      assertUsuarioId(usuarioId);
      return connectorByProvider(usuarioId, provider);
    },

    async upsertConnection(usuarioId, provider, data) {
      assertUsuarioId(usuarioId);
      const { status, ...credentials } = data;
      const { rows } = await db.query<RawRow>(
        `INSERT INTO connectors (
           id, usuario_id, provider, status, shop_id, shop_name, access_token, refresh_token,
           client_secret, public_key, expires_at, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now(), now())
         ON CONFLICT (usuario_id, provider) DO UPDATE SET
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

    async saveTokens(usuarioId, id, tokens) {
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET
           access_token  = $3,
           refresh_token = CASE WHEN $4::boolean THEN $5 ELSE refresh_token END,
           expires_at    = $6,
           status        = 'CONNECTED',
           last_error    = NULL,
           updated_at    = now()
         WHERE usuario_id = $1 AND id = $2
         RETURNING ${CONNECTOR_COLUMNS}`,
        [usuarioId, id, tokens.accessToken, tokens.refreshToken !== undefined, tokens.refreshToken ?? null, tokens.expiresAt]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async setStatus(usuarioId, provider, status, lastError = null) {
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET status = $3, last_error = $4, updated_at = now()
         WHERE usuario_id = $1 AND provider = $2
         RETURNING ${CONNECTOR_COLUMNS}`,
        [usuarioId, provider, status, lastError]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async recordSyncResult(usuarioId, provider, result) {
      assertUsuarioId(usuarioId);
      const syncedAt = result.syncedAt ?? new Date();
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET
           status           = $3,
           last_sync_at     = $4,
           last_error       = $5,
           imported_count   = imported_count + $6,
           duplicated_count = duplicated_count + $7,
           failed_count     = failed_count + $8,
           sync_count       = sync_count + 1,
           updated_at       = now()
         WHERE usuario_id = $1 AND provider = $2
         RETURNING ${CONNECTOR_COLUMNS}`,
        [
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

    async clearCredentials(usuarioId, provider) {
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
         WHERE usuario_id = $1 AND provider = $2
         RETURNING ${CONNECTOR_COLUMNS}`,
        [usuarioId, provider]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async findByShopId(provider, shopId) {
      if (!shopId) return null;
      // Deliberadamente NÃO escopada: é a resolução do responsável dono da
      // loja que disparou o webhook. Desempate determinístico pela conexão
      // mais recente para nunca depender da ordem física das linhas.
      const { rows } = await db.query<RawRow>(
        `SELECT ${CONNECTOR_COLUMNS} FROM connectors
         WHERE provider = $1 AND shop_id = $2
         ORDER BY updated_at DESC, id ASC
         LIMIT 1`,
        [provider, shopId]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },

    async hasEvent(usuarioId, provider, externalEventId) {
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `SELECT 1 AS ok FROM connector_events
         WHERE usuario_id = $1 AND provider = $2 AND external_event_id = $3
         LIMIT 1`,
        [usuarioId, provider, externalEventId]
      );
      return rows.length > 0;
    },

    async recordEvent(usuarioId, event) {
      assertUsuarioId(usuarioId);
      // Upsert na chave de entrega única: reentrega "at-least-once"
      // atualiza o payload guardado em vez de criar uma segunda linha.
      const { rows } = await db.query<RawRow>(
        `INSERT INTO connector_events (
           id, usuario_id, connector_id, provider, external_event_id, topic, payload, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
         ON CONFLICT (usuario_id, provider, external_event_id) DO UPDATE SET
           payload      = COALESCE(EXCLUDED.payload, connector_events.payload),
           topic        = COALESCE(EXCLUDED.topic, connector_events.topic),
           connector_id = COALESCE(EXCLUDED.connector_id, connector_events.connector_id)
         RETURNING ${EVENT_COLUMNS}`,
        [
          connectorCuid(),
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

    async markEventProcessed(usuarioId, provider, externalEventId) {
      assertUsuarioId(usuarioId);
      await db.query(
        `UPDATE connector_events SET processed_at = now()
         WHERE usuario_id = $1 AND provider = $2 AND external_event_id = $3 AND processed_at IS NULL`,
        [usuarioId, provider, externalEventId]
      );
    },

    async findEvent(usuarioId, provider, externalEventId) {
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `SELECT ${EVENT_COLUMNS} FROM connector_events
         WHERE usuario_id = $1 AND provider = $2 AND external_event_id = $3
         LIMIT 1`,
        [usuarioId, provider, externalEventId]
      );
      return rows[0] ? mapEvent(rows[0]) : null;
    },

    async listRecentEvents(usuarioId, provider, limit) {
      assertUsuarioId(usuarioId);
      const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
      const { rows } = await db.query<RawRow>(
        `SELECT ${EVENT_COLUMNS} FROM connector_events
         WHERE usuario_id = $1 AND provider = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [usuarioId, provider, take]
      );
      return rows.map(mapEvent);
    },

    async listPendingSaleEvents(input) {
      if (input.providers.length === 0) return [];
      const take = Math.min(Math.max(Math.trunc(input.limit) || 50, 1), 500);
      const { rows } = await db.query<RawRow>(
        `SELECT usuario_id, provider, external_event_id FROM connector_events
         WHERE processed_at IS NULL
           AND provider = ANY($1::connector_provider[])
           AND created_at <= $2
           AND ($3::timestamptz IS NULL OR created_at >= $3)
         ORDER BY created_at ASC
         LIMIT $4`,
        [input.providers, input.before, input.after ?? null, take]
      );
      return rows.map((row) => ({
        usuarioId: toInt(row.usuario_id),
        provider: String(row.provider) as ConnectorProviderName,
        externalEventId: String(row.external_event_id),
      }));
    },

    async incrementIngestionCounters(usuarioId, provider, counters) {
      assertUsuarioId(usuarioId);
      const { rows } = await db.query<RawRow>(
        `UPDATE connectors SET
           imported_count   = imported_count + $3,
           duplicated_count = duplicated_count + $4,
           failed_count     = failed_count + $5,
           updated_at       = now()
         WHERE usuario_id = $1 AND provider = $2
         RETURNING ${CONNECTOR_COLUMNS}`,
        [usuarioId, provider, Math.max(0, counters.imported ?? 0), Math.max(0, counters.duplicated ?? 0), Math.max(0, counters.failed ?? 0)]
      );
      return rows[0] ? mapConnector(rows[0]) : null;
    },
  };
}

/**
 * Repositório padrão, preso ao pool do ERP. A resolução do banco é
 * PREGUIÇOSA (a cada chamada) para que o módulo possa ser importado antes
 * do boot ligar o pool — e para que o MODO DEMONSTRAÇÃO devolva 503 em vez
 * de quebrar na importação.
 */
export const connectorRepository: ConnectorRepository = createConnectorRepository({
  query: (text, params) => getConnectorDatabase().query(text, params),
});
