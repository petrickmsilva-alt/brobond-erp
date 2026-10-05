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
import { fetchTikTokProducts, hasTikTokShopCredentials, isTikTokSandboxMode } from './tiktok.service';

export class TikTokConnector implements ProviderConnector {
  readonly provider = 'TIKTOK' as const;
  readonly name = 'TikTok Shop';

  async fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    const { accessToken } = await connectorService.getValidAccessToken(options.usuarioId, this.provider);
    const status = await connectorService.getStatus(options.usuarioId, this.provider);
    const shopCipher = typeof status.shopId === 'string' && status.shopId ? status.shopId : undefined;
    return fetchTikTokProducts(accessToken, options.limit ?? 50, shopCipher);
  }

  async testConnection(): Promise<ConnectorHealth> {
    const missingEnv = CONNECTOR_PROVIDER_REQUIRED_ENV.TIKTOK.filter((name) => !process.env[name]?.trim());
    const shop = hasTikTokShopCredentials();
    const sandbox = isTikTokSandboxMode();
    return {
      provider: this.provider,
      ok: shop,
      missingEnv,
      message: !shop
        ? `Configure ${missingEnv.join(' e ')} do Shop Partner Center para conectar uma loja.`
        : sandbox
          ? 'Sandbox da TikTok Shop ativo — use uma loja de teste autorizada no Partner Center.'
          : 'Integração TikTok Shop pronta para autorizar uma loja vendedora.',
    };
  }
}
