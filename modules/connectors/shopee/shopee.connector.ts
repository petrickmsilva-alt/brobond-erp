/**
 * Adaptador da Shopee (contrato `ProviderConnector`).
 *
 * Fonte: `modules/connectors/shopee/shopee.connector.ts` do
 * brobond-ai-commerce, agora sobre a tenancy `usuarioId` do ERP.
 */

import type { ConnectorHealth, FetchCatalogOptions, NormalizedContent, ProviderConnector } from '../core/connector.interface';
import { ConnectorReauthRequiredError } from '../core/errors';
import { CONNECTOR_PROVIDER_REQUIRED_ENV } from '../core/providers';
import { connectorService } from '../core/connector.service';
import { fetchShopeeProducts, hasShopeeCredentials } from './shopee.service';

export class ShopeeConnector implements ProviderConnector {
  readonly provider = 'SHOPEE' as const;
  readonly name = 'Shopee';

  async fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    const { accessToken, shopId } = await connectorService.getValidAccessToken(options.usuarioId, this.provider);
    if (!shopId) {
      throw new ConnectorReauthRequiredError(
        this.provider,
        'A loja da Shopee não está vinculada a este responsável. Conecte a Conta da Shopee novamente.'
      );
    }
    return fetchShopeeProducts(accessToken, shopId, options.limit ?? 50);
  }

  async testConnection(): Promise<ConnectorHealth> {
    const missingEnv = CONNECTOR_PROVIDER_REQUIRED_ENV.SHOPEE.filter((name) => !process.env[name]?.trim());
    const configured = hasShopeeCredentials();
    return {
      provider: this.provider,
      ok: configured,
      missingEnv,
      message: configured
        ? 'Integração oficial pronta. Autorize uma loja Shopee para liberar catálogo e pedidos.'
        : `Configure ${missingEnv.join(' e ')} no servidor para conectar uma loja.`,
    };
  }
}
