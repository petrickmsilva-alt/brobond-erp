/**
 * Serviço de conexões multicanal — a camada que o servidor do ERP chama.
 *
 * Fonte: `modules/marketplace/core/connector.service.ts` do
 * brobond-ai-commerce (PR012/PR016). ADAPTAÇÕES DESTA FASE:
 *
 *   • Tenancy `organizationId: string` → `usuarioId: number` em TODAS as
 *     assinaturas: quem é dono da conexão, quem aparece na auditoria de
 *     faturamento e quem recebe a venda importada é o OPERADOR do ERP.
 *   • Auditoria por gancho injetado (`core/audit.ts`) em vez de
 *     `prisma.auditLog`.
 *   • Shopee e TikTok foram REMOVIDOS do ecossistema (decisão da
 *     diretoria, 2026-10-05): o mapa de refresh é exaustivo sobre o TRIO
 *     DE PRODUÇÃO — MERCADOLIVRE, MERCADOPAGO e NUVEMSHOP — e o
 *     TypeScript garante isso em tempo de compilação
 *     (`satisfies Record<…>`).
 */

import { auditConnector } from './audit';
import { connectorRepository, type ConnectorRepository } from './connector.repository';
import {
  decryptConnectorSecret,
  encryptConnectorSecret,
  hasConnectorEncryptionKey,
  maskConnectorSecretPreview,
  ConnectorCryptoError,
} from './crypto.service';
import { ConnectorConfigError, ConnectorError, ConnectorReauthRequiredError, ConnectorTokenUndecryptableError } from './errors';
import { connectorOAuthStateService, type ConnectorOAuthStateService } from './oauth-state.service';
import {
  CONNECTION_STATUS_LABELS,
  CONNECTOR_PROVIDERS,
  CONNECTOR_PROVIDER_AUTH_MODEL,
  CONNECTOR_PROVIDER_DESCRIPTIONS,
  CONNECTOR_PROVIDER_LABELS,
  CONNECTOR_PROVIDER_REDIRECT_ENV,
  CONNECTOR_PROVIDER_REQUIRED_ENV,
  CONNECTOR_PROVIDER_SLUGS,
  type ConnectorProviderName,
} from './providers';
import { resolveDynamicCallbackUri } from './app-url';
import type { ConnectorRow, ConnectorStatusDTO } from './types';

import {
  buildMercadoLivreAuthorizationUrl,
  exchangeMercadoLivreCode,
  fetchMercadoLivreIdentity,
  refreshMercadoLivreToken,
} from '../mercadolivre/mercadolivre.service';
import {
  getMercadoPagoEnvironmentCredentials,
  hasPersistedMercadoPagoCredentials,
  validateMercadoPagoAccessToken,
} from '../mercadopago/mercadopago.service';
import { buildNuvemshopAuthorizationUrl, exchangeNuvemshopCode, fetchNuvemshopStore } from '../nuvemshop/nuvemshop.service';

/** Margem de renovação: um token que vence em menos de 5 min é rotacionado. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

// ------------------------------------------------------------------
// Helpers de credencial
// ------------------------------------------------------------------

/**
 * Decifra uma credencial guardada. Um texto cifrado gravado ANTES de uma
 * troca de `CONNECTOR_ENCRYPTION_KEY` nunca mais abre — isso é um ESTADO,
 * não uma exceção para derrubar o servidor: vira
 * `ConnectorTokenUndecryptableError` e o canal é estacionado em
 * `REAUTH_REQUIRED`.
 */
function decryptCredential(ciphertext: string, provider: ConnectorProviderName, label: string): string {
  try {
    return decryptConnectorSecret(ciphertext);
  } catch (error) {
    if (error instanceof ConnectorCryptoError) {
      throw new ConnectorTokenUndecryptableError(
        provider,
        `Não foi possível abrir o ${label} guardado do conector "${provider}" (a CONNECTOR_ENCRYPTION_KEY mudou). Reconecte a conta para gravar a credencial com a chave atual.`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function parkConnectorForUndecryptableCredential(
  repository: ConnectorRepository,
  usuarioId: number,
  provider: ConnectorProviderName,
  error: ConnectorTokenUndecryptableError
): Promise<void> {
  try {
    await repository.setStatus(usuarioId, provider, 'REAUTH_REQUIRED', error.message);
  } catch {
    // Banco indisponível no caminho de erro: o erro de domínio já carrega
    // a ação que o operador precisa tomar. Nunca escalar para 500.
  }
}

// ------------------------------------------------------------------
// Serviço
// ------------------------------------------------------------------

export interface StartAuthorizationResult {
  provider: ConnectorProviderName;
  /** URL de consentimento para a qual o navegador deve ser enviado. */
  authorizationUrl: string;
  /** `redirect_uri` estático enviado ao provedor (útil para diagnóstico). */
  redirectUri: string;
}

export interface ConnectorServiceDependencies {
  repository?: ConnectorRepository;
  oauthStates?: ConnectorOAuthStateService;
  now?: () => Date;
}

export function createConnectorService(deps: ConnectorServiceDependencies = {}) {
  const repository = deps.repository ?? connectorRepository;
  const oauthStates = deps.oauthStates ?? connectorOAuthStateService;
  const now = deps.now ?? (() => new Date());

  /**
   * Rotação de token por provedor. O mapa é EXAUSTIVO sobre o TRIO de
   * produção: incluir um quarto (ou tentar reintroduzir um removido,
   * como Shopee/TikTok) quebra a compilação em vez de virar um
   * `undefined` silencioso em produção.
   */
  const TOKEN_REFRESHERS = {
    MERCADOLIVRE: async (connector: ConnectorRow, refreshToken: string) => {
      const tokens = await refreshMercadoLivreToken(refreshToken);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        shopId: connector.shopId,
      };
    },
    // O Access Token de produção do Mercado Pago não expira: não há o que
    // rotacionar — trocar a credencial é ato manual do operador.
    MERCADOPAGO: null,
    // O token da Nuvemshop também é PERMANENTE (só morre quando um novo é
    // emitido ou quando o lojista desinstala o app): não existe refresh
    // token para rotacionar — reinstalar/reautorizar é o caminho.
    NUVEMSHOP: null,
  } satisfies Record<
    ConnectorProviderName,
    | null
    | ((
        connector: ConnectorRow,
        refreshToken: string
      ) => Promise<{
        accessToken: string;
        refreshToken: string | null;
        expiresAt: Date | null;
        shopId: string | null;
      }>)
  >;

  return {
    /** Conexões do responsável, já projetadas sem material secreto. */
    async listStatus(usuarioId: number): Promise<ConnectorStatusDTO[]> {
      const rows = await repository.list(usuarioId);
      const byProvider = new Map(rows.map((row) => [row.provider, row]));
      return CONNECTOR_PROVIDERS.map((provider) => toConnectorStatusDTO(provider, byProvider.get(provider) ?? null));
    },

    /** Uma conexão específica, projetada sem material secreto. */
    async getStatus(usuarioId: number, provider: ConnectorProviderName): Promise<ConnectorStatusDTO> {
      return toConnectorStatusDTO(provider, await repository.findByProvider(usuarioId, provider));
    },

    /**
     * Inicia o fluxo OAuth de um provedor: emite o state CSRF (amarrado ao
     * `usuarioId`) e devolve a URL de consentimento.
     *
     * `options.redirectBase` é a ORIGEM dinâmica enviada pelo painel
     * (`window.location.origin` — num deploy da Render,
     * `https://brobond-erp.onrender.com`, o host unificado do ERP). Ela é
     * validada (https público em produção) e o caminho canônico do callback
     * é derivado NO SERVIDOR; a URI escolhida é persistida com o state para
     * que a troca do código repita exatamente o mesmo valor byte a byte.
     * Sem base válida, cai na resolução estática do ambiente.
     */
    async startAuthorization(
      usuarioId: number,
      provider: ConnectorProviderName,
      options: { redirectBase?: string | null } = {}
    ): Promise<StartAuthorizationResult> {
      if (CONNECTOR_PROVIDER_AUTH_MODEL[provider] !== 'oauth2') {
        throw new ConnectorError(`O conector "${provider}" é conectado por credenciais de produção, não por OAuth.`, provider);
      }
      assertEncryptionKey();
      const dynamicRedirectUri = resolveDynamicCallbackUri(options.redirectBase, CONNECTOR_PROVIDER_SLUGS[provider]);
      const missing = connectorConfigurationMissing(provider, dynamicRedirectUri);
      if (missing.length) {
        throw new ConnectorError(`Configuração incompleta do conector: ${missing.join(', ')}.`, provider);
      }
      const state = await oauthStates.issue(usuarioId, provider, { redirectUri: dynamicRedirectUri });
      switch (provider) {
        case 'MERCADOLIVRE': {
          const { resolveMercadoLivreRedirectUri } = await import('../mercadolivre/mercadolivre.service');
          return {
            provider,
            authorizationUrl: buildMercadoLivreAuthorizationUrl(state, undefined, dynamicRedirectUri),
            redirectUri: resolveMercadoLivreRedirectUri(undefined, dynamicRedirectUri),
          };
        }
        case 'NUVEMSHOP': {
          const { resolveNuvemshopRedirectUri } = await import('../nuvemshop/nuvemshop.service');
          // A Nuvemshop não aceita `redirect_uri` na URL de autorização: a
          // URL de redirecionamento é a cadastrada no Portal de Parceiros.
          // Resolvemos o valor mesmo assim para devolvê-lo ao painel — é
          // exatamente o endereço que precisa estar registrado lá.
          return {
            provider,
            authorizationUrl: buildNuvemshopAuthorizationUrl(state),
            redirectUri: resolveNuvemshopRedirectUri(undefined, dynamicRedirectUri),
          };
        }
        default:
          throw new ConnectorError(`O conector "${provider}" não possui fluxo OAuth.`, provider);
      }
    },

    /**
     * Conclui um callback OAuth. O `state` — e SÓ ele — determina o
     * responsável: a rota de callback é pública (o provedor chega nela sem
     * cookie de sessão do ERP).
     */
    async handleOAuthCallback(
      provider: ConnectorProviderName,
      input: { code: string; state: string; shopId?: string | null }
    ): Promise<{ usuarioId: number; connector: ConnectorRow }> {
      assertEncryptionKey();
      const { usuarioId, redirectUri } = await oauthStates.consume(input.state, provider);

      switch (provider) {
        case 'MERCADOLIVRE': {
          // O redirect_uri da troca é o MESMO da autorização (persistido no
          // state): a Meli compara os dois valores byte a byte.
          const tokens = await exchangeMercadoLivreCode(input.code, undefined, redirectUri);
          const identity = await fetchMercadoLivreIdentity(tokens.accessToken);
          const connector = await repository.upsertConnection(usuarioId, provider, {
            status: 'CONNECTED',
            accessToken: encryptConnectorSecret(tokens.accessToken),
            refreshToken: encryptConnectorSecret(tokens.refreshToken),
            expiresAt: tokens.expiresAt,
            shopId: identity.userId,
            shopName: identity.nickname,
            metadata: { siteId: identity.siteId },
          });
          await auditConnector({
            action: 'MERCADOLIVRE_CONNECTED',
            usuarioId,
            provider,
            connectorId: connector.id,
            metadata: { sellerId: identity.userId, nickname: identity.nickname },
          });
          return { usuarioId, connector };
        }

        case 'NUVEMSHOP': {
          const tokens = await exchangeNuvemshopCode(input.code);
          const store = await fetchNuvemshopStore(tokens.accessToken, tokens.storeId);
          const connector = await repository.upsertConnection(usuarioId, provider, {
            status: 'CONNECTED',
            accessToken: encryptConnectorSecret(tokens.accessToken),
            // Token PERMANENTE: não há refresh token nem validade para
            // guardar — gravar um `expiresAt` falso só provocaria uma
            // renovação impossível.
            refreshToken: null,
            expiresAt: null,
            // `user_id` da Nuvemshop = id da loja, exigido em toda chamada.
            shopId: tokens.storeId,
            shopName: store.storeName,
            metadata: { scope: tokens.scope, storeUrl: store.storeUrl },
          });
          await auditConnector({
            action: 'NUVEMSHOP_CONNECTED',
            usuarioId,
            provider,
            connectorId: connector.id,
            metadata: { storeId: tokens.storeId, storeName: store.storeName },
          });
          return { usuarioId, connector };
        }

        default:
          throw new ConnectorError(`O conector "${provider}" não possui fluxo OAuth.`, provider);
      }
    },

    /** Ativa para este operador o par provisionado no ambiente do servidor. */
    async connectMercadoPagoFromEnvironment(usuarioId: number): Promise<ConnectorRow> {
      const credentials = getMercadoPagoEnvironmentCredentials();
      if (!credentials) {
        throw new ConnectorConfigError('MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_PUBLIC_KEY', 'MERCADOPAGO');
      }
      return this.connectMercadoPago(usuarioId, credentials);
    },

    /**
     * Mercado Pago: valida o Access Token de produção contra `/users/me`
     * ANTES de persistir (credencial nunca é gravada sem passar na
     * validação oficial) e guarda as duas chaves cifradas.
     */
    async connectMercadoPago(usuarioId: number, input: { accessToken: string; publicKey: string }): Promise<ConnectorRow> {
      assertEncryptionKey();
      const identity = await validateMercadoPagoAccessToken(input.accessToken);
      const connector = await repository.upsertConnection(usuarioId, 'MERCADOPAGO', {
        status: 'CONNECTED',
        accessToken: encryptConnectorSecret(input.accessToken),
        publicKey: encryptConnectorSecret(input.publicKey),
        refreshToken: null,
        expiresAt: null,
        shopId: identity.userId,
        shopName: identity.nickname,
        metadata: { siteId: identity.siteId, email: identity.email },
      });
      await auditConnector({
        action: 'MERCADOPAGO_CONNECTED',
        usuarioId,
        provider: 'MERCADOPAGO',
        connectorId: connector.id,
        metadata: { collectorId: identity.userId },
      });
      return connector;
    },

    /**
     * Devolve um access token VÁLIDO em texto puro, renovando de forma
     * transparente quando vencido ou prestes a vencer.
     */
    async getValidAccessToken(usuarioId: number, provider: ConnectorProviderName): Promise<{ accessToken: string; shopId: string | null }> {
      const connector = await repository.findByProvider(usuarioId, provider);

      // Mercado Pago: o par do ambiente é o fallback de deploy para
      // instalações que provisionam a credencial globalmente.
      if (provider === 'MERCADOPAGO' && !hasPersistedMercadoPagoCredentials(connector)) {
        const environment = getMercadoPagoEnvironmentCredentials();
        if (environment) return { accessToken: environment.accessToken, shopId: null };
      }

      if (!connector?.accessToken) {
        throw new ConnectorReauthRequiredError(provider, `O conector "${provider}" não possui credencial ativa. Conecte a conta primeiro.`);
      }

      try {
        const expiring = connector.expiresAt !== null && connector.expiresAt.getTime() <= now().getTime() + TOKEN_REFRESH_SKEW_MS;
        if (!expiring) {
          return {
            accessToken: decryptCredential(connector.accessToken, provider, 'token de acesso'),
            shopId: connector.shopId,
          };
        }

        const refresher = TOKEN_REFRESHERS[provider];
        if (!connector.refreshToken || !refresher) {
          await repository.setStatus(usuarioId, provider, 'EXPIRED');
          throw new ConnectorReauthRequiredError(provider, `A credencial do conector "${provider}" expirou. Reconecte a conta.`);
        }

        const refreshToken = decryptCredential(connector.refreshToken, provider, 'refresh token');
        try {
          const tokens = await refresher(connector, refreshToken);
          await repository.saveTokens(usuarioId, connector.id, {
            accessToken: encryptConnectorSecret(tokens.accessToken),
            refreshToken: tokens.refreshToken ? encryptConnectorSecret(tokens.refreshToken) : null,
            expiresAt: tokens.expiresAt,
          });
          return { accessToken: tokens.accessToken, shopId: tokens.shopId };
        } catch (error) {
          await repository.setStatus(usuarioId, provider, 'EXPIRED', 'A renovação do token falhou — reconecte a conta.');
          // Refresh que falha é terminal para a credencial: o provedor vai
          // continuar recusando até a conta ser autorizada de novo.
          if (error instanceof ConnectorReauthRequiredError) throw error;
          throw new ConnectorReauthRequiredError(
            provider,
            `A renovação automática do token do conector "${provider}" falhou. Reconecte a conta para restabelecer o acesso.`,
            { cause: error }
          );
        }
      } catch (error) {
        if (error instanceof ConnectorTokenUndecryptableError) {
          await parkConnectorForUndecryptableCredential(repository, usuarioId, provider, error);
        }
        throw error;
      }
    },

    /**
     * Revoga a conexão: apaga TODA cifra localmente (esta aplicação nunca
     * mais consegue chamar o provedor) e registra a trilha de auditoria. A
     * desautorização do lado do provedor segue disponível no painel do
     * vendedor.
     */
    async disconnect(usuarioId: number, provider: ConnectorProviderName): Promise<void> {
      const connector = await repository.clearCredentials(usuarioId, provider);
      await auditConnector({
        action: `${provider}_DISCONNECTED`,
        usuarioId,
        provider,
        connectorId: connector?.id ?? null,
      });
    },

    /** Acesso ao repositório para as camadas de ingestão e sincronização. */
    repository,
  };
}

/** Lança quando a chave global de cifra não está configurada. */
function assertEncryptionKey(): void {
  if (!hasConnectorEncryptionKey()) {
    throw new ConnectorConfigError('CONNECTOR_ENCRYPTION_KEY');
  }
}

function isProductionCallbackUrl(value: string | undefined): boolean {
  try {
    const url = new URL((value ?? '').trim());
    return url.protocol === 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname.includes('.');
  } catch {
    return false;
  }
}

function connectorConfigurationMissing(provider: ConnectorProviderName, dynamicRedirectUri?: string | null): string[] {
  const missing = CONNECTOR_PROVIDER_REQUIRED_ENV[provider].filter((name) => !process.env[name]?.trim());
  if (!hasConnectorEncryptionKey()) missing.push('CONNECTOR_ENCRYPTION_KEY (32 bytes em base64 ou 64 hex)');
  if (CONNECTOR_PROVIDER_AUTH_MODEL[provider] === 'oauth2' && process.env.NODE_ENV === 'production') {
    const redirectEnvName = CONNECTOR_PROVIDER_REDIRECT_ENV[provider];
    const explicitRedirect = redirectEnvName ? process.env[redirectEnvName]?.trim() : undefined;
    // O redirect dinâmico do painel (origem da Render, validado) também
    // satisfaz o requisito de callback público em HTTPS.
    if (!isProductionCallbackUrl(explicitRedirect) && !isProductionCallbackUrl(process.env.APP_URL) && !dynamicRedirectUri) {
      missing.push('APP_URL ou REDIRECT_URI público em HTTPS');
    }
  }
  return [...new Set(missing)];
}

/** Projeção segura de uma linha de `connectors` para o painel. */
export function toConnectorStatusDTO(provider: ConnectorProviderName, row: ConnectorRow | null): ConnectorStatusDTO {
  const missingEnv = connectorConfigurationMissing(provider);
  // O Mercado Pago aceita credencial por painel OU por ambiente, mas todos
  // os caminhos persistidos exigem uma chave de cifra válida.
  const configured = provider === 'MERCADOPAGO'
    ? hasConnectorEncryptionKey() && (Boolean(row?.accessToken) || getMercadoPagoEnvironmentCredentials() !== null)
    : missingEnv.length === 0;
  const status = row?.status ?? 'DISCONNECTED';
  return {
    provider,
    label: CONNECTOR_PROVIDER_LABELS[provider],
    description: CONNECTOR_PROVIDER_DESCRIPTIONS[provider],
    authModel: CONNECTOR_PROVIDER_AUTH_MODEL[provider],
    status,
    statusLabel: CONNECTION_STATUS_LABELS[status],
    connected: status === 'CONNECTED' || status === 'SANDBOX_ACTIVE',
    configured,
    missingEnv,
    shopId: row?.shopId ?? null,
    shopName: row?.shopName ?? null,
    expiresAt: row?.expiresAt ? row.expiresAt.toISOString() : null,
    lastSyncAt: row?.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastError: row?.lastError ?? null,
    importedCount: row?.importedCount ?? 0,
    duplicatedCount: row?.duplicatedCount ?? 0,
    failedCount: row?.failedCount ?? 0,
    syncCount: row?.syncCount ?? 0,
    hasAccessToken: Boolean(row?.accessToken),
    hasRefreshToken: Boolean(row?.refreshToken),
    environmentCredentialsAvailable: provider === 'MERCADOPAGO' && getMercadoPagoEnvironmentCredentials() !== null,
    // Prévia mascarada: o painel nunca recebe a chave pública inteira a
    // partir da cifra — só a confirmação visual de que há uma gravada.
    publicKeyPreview: row?.publicKey
      ? (() => {
          try {
            return maskConnectorSecretPreview(decryptConnectorSecret(row.publicKey));
          } catch {
            return null;
          }
        })()
      : null,
    requiresReauth: status === 'REAUTH_REQUIRED' || status === 'EXPIRED',
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** Serviço padrão, preso ao repositório e ao estado OAuth padrão. */
export const connectorService = createConnectorService();

export type ConnectorService = ReturnType<typeof createConnectorService>;
