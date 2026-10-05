/**
 * Adaptador da Nuvemshop (contrato `ProviderConnector`).
 *
 * É a PLATAFORMA-PONTE do Hub Omnichannel: o catálogo que sai daqui é o
 * mesmo que alimenta a triangulação de vendas dos demais canais (inclusive
 * a vitrine do TikTok, cujo conector nativo foi removido do ecossistema).
 */

import type { ConnectorHealth, FetchCatalogOptions, NormalizedContent, ProviderConnector } from '../core/connector.interface';
import { ConnectorReauthRequiredError } from '../core/errors';
import { CONNECTOR_PROVIDER_REQUIRED_ENV } from '../core/providers';
import { connectorService } from '../core/connector.service';
import { fetchNuvemshopProducts, hasNuvemshopCredentials, NUVEMSHOP_CONNECT_CTA } from './nuvemshop.service';

export class NuvemshopConnector implements ProviderConnector {
  readonly provider = 'NUVEMSHOP' as const;
  readonly name = 'Nuvemshop';

  async fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    const { accessToken, shopId } = await connectorService.getValidAccessToken(options.usuarioId, this.provider);
    // O `user_id` (id da loja) é obrigatório em TODA chamada da API: sem
    // ele a requisição nem é montada — o operador lê a ação que resolve.
    if (!shopId) {
      throw new ConnectorReauthRequiredError(
        this.provider,
        `A loja da Nuvemshop não está vinculada a este responsável. Clique em "${NUVEMSHOP_CONNECT_CTA}" para autorizar novamente.`
      );
    }
    return fetchNuvemshopProducts(accessToken, shopId, options.limit ?? 50);
  }

  async testConnection(): Promise<ConnectorHealth> {
    const missingEnv = CONNECTOR_PROVIDER_REQUIRED_ENV.NUVEMSHOP.filter((name) => !process.env[name]?.trim());
    const configured = hasNuvemshopCredentials();
    return {
      provider: this.provider,
      ok: configured,
      missingEnv,
      message: configured
        ? 'Integração oficial pronta. Autorize a loja da Nuvemshop para liberar catálogo e pedidos.'
        : `Configure ${missingEnv.join(' e ')} no servidor para conectar uma loja.`,
    };
  }
}
