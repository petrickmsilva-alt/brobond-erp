/**
 * Adaptador do TikTok (contrato `ProviderConnector`).
 *
 * Fonte: `modules/connectors/tiktok/tiktok.connector.ts` do
 * brobond-ai-commerce (PR009/PR017), agora sobre a tenancy `usuarioId`.
 *
 * Enquanto a app vendedora do Shop Partner Center não é aprovada, o
 * catálogo não existe: o conector devolve lista vazia e o canal fica em
 * `PENDING_APPROVAL`. Isso é estado operacional esperado — NUNCA uma
 * falha de servidor.
 */

import type { ConnectorHealth, FetchCatalogOptions, NormalizedContent, ProviderConnector } from '../core/connector.interface';
import { CONNECTOR_PROVIDER_REQUIRED_ENV } from '../core/providers';
import { connectorService } from '../core/connector.service';
import { fetchTikTokProducts, hasTikTokLoginCredentials, hasTikTokShopCredentials, isTikTokSandboxMode } from './tiktok.service';

export class TikTokConnector implements ProviderConnector {
  readonly provider = 'TIKTOK' as const;
  readonly name = 'TikTok Shop';

  async fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    // Sem a app vendedora aprovada não há API de catálogo para chamar.
    if (!hasTikTokShopCredentials()) return [];
    const { accessToken } = await connectorService.getValidAccessToken(options.usuarioId, this.provider);
    const status = await connectorService.getStatus(options.usuarioId, this.provider);
    const shopCipher = typeof status.shopId === 'string' && status.shopId ? status.shopId : undefined;
    return fetchTikTokProducts(accessToken, options.limit ?? 50, shopCipher);
  }

  async testConnection(): Promise<ConnectorHealth> {
    const missingEnv = CONNECTOR_PROVIDER_REQUIRED_ENV.TIKTOK.filter((name) => !process.env[name]?.trim());
    const login = hasTikTokLoginCredentials();
    const shop = hasTikTokShopCredentials();
    const sandbox = isTikTokSandboxMode();
    return {
      provider: this.provider,
      ok: login,
      missingEnv,
      message: !login
        ? `Configure ${missingEnv.join(' e ')} no servidor para conectar uma conta.`
        : sandbox
          ? 'Sandbox do TikTok Developers ativo — o fluxo é funcional com as contas de teste cadastradas.'
          : shop
            ? 'Integração oficial pronta (Login Kit + Shop Partner Center).'
            : 'Login Kit pronto. A app vendedora do Shop Partner Center ainda não foi configurada (TIKTOK_APP_KEY/TIKTOK_APP_SECRET): o canal conecta, mas fica aguardando aprovação para pedidos.',
    };
  }
}
