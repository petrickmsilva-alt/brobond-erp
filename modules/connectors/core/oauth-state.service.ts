/**
 * Estado CSRF do fluxo OAuth de conexão.
 *
 * Fonte: `modules/marketplace/core/oauth-state.service.ts` do
 * brobond-ai-commerce (PR012). ADAPTAÇÃO: o state passa a amarrar o
 * callback ao `usuarioId` do ERP (tabela `connector_oauth_states`,
 * CASCADE com `usuarios` — é dado efêmero).
 *
 * Contrato preservado: o state é aleatório (256 bits), guardado só como
 * SHA-256, expira em dez minutos e é consumido EXATAMENTE UMA VEZ antes
 * de o código de autorização ser trocado. É ele — e só ele — que diz de
 * qual operador é o callback: a rota pública de callback não tem sessão.
 */

import { randomBytes } from 'node:crypto';
import { getConnectorDatabase, type ConnectorDatabase } from './database';
import { hashConnectorOAuthState } from './crypto.service';
import { connectorCuid } from './id';
import type { ConnectorProviderName } from './providers';
import { assertUsuarioId } from './connector.repository';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export class ConnectorOAuthStateError extends Error {
  readonly httpStatus = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ConnectorOAuthStateError';
  }
}

export interface ConnectorOAuthStateDependencies {
  now?: () => Date;
  randomState?: () => string;
}

export interface ConnectorOAuthStateService {
  /**
   * Emite um state opaco novo para um provedor de um responsável. Quando a
   * autorização usou um `redirect_uri` dinâmico (origem do painel), ele é
   * gravado junto: a troca do código PRECISA repetir a MESMA URI byte a
   * byte — esse é o contrato do OAuth do Mercado Livre.
   */
  issue(usuarioId: number, provider: ConnectorProviderName, metadata?: { redirectUri?: string | null }): Promise<string>;
  /**
   * Consome o state apresentado por um callback OAuth. Ele — e só ele —
   * determina o responsável; é de uso único e com prazo.
   *
   * @throws {ConnectorOAuthStateError} state inválido, expirado ou repetido.
   */
  consume(state: string, provider: ConnectorProviderName): Promise<{ usuarioId: number; redirectUri: string | null }>;
}

export function createConnectorOAuthStateService(
  db: ConnectorDatabase,
  deps: ConnectorOAuthStateDependencies = {}
): ConnectorOAuthStateService {
  const now = deps.now ?? (() => new Date());
  const randomState = deps.randomState ?? (() => randomBytes(32).toString('base64url'));

  return {
    async issue(usuarioId, provider, metadata) {
      assertUsuarioId(usuarioId);
      const state = randomState();
      const current = now();
      // Limpeza oportunista dos states vencidos deste responsável/provedor.
      await db.query(
        `DELETE FROM connector_oauth_states
         WHERE usuario_id = $1 AND provider = $2 AND expires_at <= $3`,
        [usuarioId, provider, current]
      );
      await db.query(
        `INSERT INTO connector_oauth_states (id, usuario_id, provider, state_hash, redirect_uri, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [
          connectorCuid(),
          usuarioId,
          provider,
          hashConnectorOAuthState(state),
          metadata?.redirectUri?.trim() || null,
          new Date(current.getTime() + OAUTH_STATE_TTL_MS),
        ]
      );
      return state;
    },

    async consume(state, provider) {
      const current = now();
      if (!state || typeof state !== 'string') {
        throw new ConnectorOAuthStateError('O estado de autorização é inválido ou expirou. Inicie a conexão novamente.');
      }
      const stateHash = hashConnectorOAuthState(state);
      // DELETE … RETURNING é a consumição atômica: dois callbacks
      // simultâneos com o mesmo state — reentrega ou replay — só podem
      // ganhar uma vez.
      const { rows } = await db.query<Record<string, unknown>>(
        `DELETE FROM connector_oauth_states
         WHERE state_hash = $1 AND provider = $2 AND expires_at > $3
         RETURNING usuario_id, redirect_uri`,
        [stateHash, provider, current]
      );
      const row = rows[0];
      if (!row) {
        // Limpa um state vencido/divergente que porventura exista, para
        // que uma tentativa repetida não encontre lixo reaproveitável.
        await db.query(`DELETE FROM connector_oauth_states WHERE state_hash = $1`, [stateHash]);
        throw new ConnectorOAuthStateError('O estado de autorização é inválido ou expirou. Inicie a conexão novamente.');
      }
      return {
        usuarioId: Number(row.usuario_id),
        redirectUri: row.redirect_uri === null || row.redirect_uri === undefined ? null : String(row.redirect_uri),
      };
    },
  };
}

/** Serviço padrão, preso ao pool do ERP (resolução preguiçosa). */
export const connectorOAuthStateService: ConnectorOAuthStateService = createConnectorOAuthStateService({
  query: (text, params) => getConnectorDatabase().query(text, params),
});
