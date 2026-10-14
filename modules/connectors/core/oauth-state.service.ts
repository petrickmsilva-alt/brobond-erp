/**
 * Estado CSRF do fluxo OAuth de conexão.
 *
 * Fonte: `modules/marketplace/core/oauth-state.service.ts` do
 * brobond-ai-commerce (PR012). ADAPTAÇÃO: o state amarra o callback ao
 * par confiável `empresaId` + `usuarioId` do ERP (tabela
 * `connector_oauth_states`, com vínculo de usuário — é dado efêmero).
 *
 * Contrato preservado: o state é aleatório (256 bits), guardado só como
 * SHA-256, expira em dez minutos e é consumido EXATAMENTE UMA VEZ antes
 * de o código de autorização ser trocado. É ele — e só ele — que diz a
 * empresa e o responsável do callback: a rota pública não tem sessão.
 */

import { randomBytes } from 'node:crypto';
import { getConnectorDatabase, type ConnectorDatabase } from './database';
import { hashConnectorOAuthState } from './crypto.service';
import { connectorCuid } from './id';
import type { ConnectorProviderName } from './providers';
import { assertEmpresaId, assertUsuarioId } from './connector.repository';

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
   * byte — esse é o contrato do OAuth do Mercado Livre/Shopee.
   */
  issue(empresaId: number, usuarioId: number, provider: ConnectorProviderName, metadata?: { redirectUri?: string | null }): Promise<string>;
  /**
   * Consome o state apresentado por um callback OAuth. Ele — e só ele —
   * determina o responsável; é de uso único e com prazo.
   *
   * @throws {ConnectorOAuthStateError} state inválido, expirado ou repetido.
   */
  consume(state: string, provider: ConnectorProviderName): Promise<{ empresaId: number; usuarioId: number; redirectUri: string | null }>;
}

export function createConnectorOAuthStateService(
  db: ConnectorDatabase,
  deps: ConnectorOAuthStateDependencies = {}
): ConnectorOAuthStateService {
  const now = deps.now ?? (() => new Date());
  const randomState = deps.randomState ?? (() => randomBytes(32).toString('base64url'));

  return {
    async issue(empresaId, usuarioId, provider, metadata) {
      assertEmpresaId(empresaId);
      assertUsuarioId(usuarioId);
      const state = randomState();
      const current = now();
      // Limpeza oportunista dos states vencidos deste responsável/provedor.
      await db.query(
        `DELETE FROM connector_oauth_states
         WHERE empresa_id = $1 AND usuario_id = $2 AND provider = $3 AND expires_at <= $4`,
        [empresaId, usuarioId, provider, current]
      );
      await db.query(
        `INSERT INTO connector_oauth_states (id, empresa_id, usuario_id, provider, state_hash, redirect_uri, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          connectorCuid(),
          empresaId,
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
        `DELETE FROM connector_oauth_states s
         USING usuarios u
         WHERE s.state_hash = $1 AND s.provider = $2 AND s.expires_at > $3
           AND u.id = s.usuario_id
           AND (u.empresa_id = s.empresa_id OR EXISTS (
             SELECT 1 FROM usuario_empresas ue
             WHERE ue.usuario_id = s.usuario_id AND ue.empresa_id = s.empresa_id
           ))
         RETURNING s.empresa_id, s.usuario_id, s.redirect_uri`,
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
        empresaId: assertEmpresaId(Number(row.empresa_id)),
        usuarioId: assertUsuarioId(Number(row.usuario_id)),
        redirectUri: row.redirect_uri === null || row.redirect_uri === undefined ? null : String(row.redirect_uri),
      };
    },
  };
}

/** Serviço padrão, preso ao pool do ERP (resolução preguiçosa). */
export const connectorOAuthStateService: ConnectorOAuthStateService = createConnectorOAuthStateService({
  query: (text, params) => getConnectorDatabase().query(text, params),
});
