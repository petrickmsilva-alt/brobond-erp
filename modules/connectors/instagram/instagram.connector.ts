/**
 * Adaptador do Instagram Shopping (contrato `ProviderConnector`).
 *
 * O catálogo vem da API de Product Tagging da Meta — o recurso de
 * Shopping que continua vivo e suportado depois do fim do checkout
 * nativo. Pedido NÃO sai daqui: a Meta não expõe pedido de Instagram
 * para terceiros (ver `instagram.service.ts`), e o caminho de receita
 * do canal é o webhook dirigido por payload do
 * `InstagramConnectorService`.
 */

import type { ConnectorHealth, FetchCatalogOptions, NormalizedContent, ProviderConnector } from '../core/connector.interface';
import { connectorService } from '../core/connector.service';
import { ConnectorReauthRequiredError } from '../core/errors';
import { CONNECTOR_PROVIDER_REQUIRED_ENV } from '../core/providers';
import { fetchInstagramCatalogProducts, hasInstagramCredentials, INSTAGRAM_CONNECT_CTA } from './instagram.service';

export class InstagramConnector implements ProviderConnector {
  readonly provider = 'INSTAGRAM' as const;
  readonly name = 'Instagram Shopping';

  async fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    const { accessToken, shopId } = await connectorService.getValidAccessToken(options.usuarioId, this.provider);
    // `shopId` é o ID da conta profissional do Instagram: sem ele a
    // chamada nem é montada — o operador lê a ação que resolve.
    if (!shopId) {
      throw new ConnectorReauthRequiredError(
        this.provider,
        `A conta comercial do Instagram não está vinculada a este responsável. Clique em "${INSTAGRAM_CONNECT_CTA}" para autorizar novamente.`
      );
    }
    return fetchInstagramCatalogProducts(accessToken, shopId, options.limit ?? 50);
  }

  async testConnection(): Promise<ConnectorHealth> {
    const missingEnv = CONNECTOR_PROVIDER_REQUIRED_ENV.INSTAGRAM.filter((name) => !process.env[name]?.trim());
    const configured = hasInstagramCredentials();
    return {
      provider: this.provider,
      ok: configured,
      missingEnv,
      message: configured
        ? 'App da Meta configurado. Autorize a conta comercial do Instagram para liberar catálogo e webhooks.'
        : `Configure ${missingEnv.join(' e ')} no servidor para conectar a conta comercial.`,
    };
  }
}
