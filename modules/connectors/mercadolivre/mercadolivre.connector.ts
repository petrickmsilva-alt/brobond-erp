/**
 * Adaptador do Mercado Livre (contrato `ProviderConnector`).
 *
 * Fonte: `modules/connectors/mercadolivre/mercadolivre.connector.ts` do
 * brobond-ai-commerce. ADAPTAÇÃO: `options.organizationId` →
 * `options.usuarioId` (tenancy do ERP) e resolução da credencial pelo
 * `connectorService` do módulo.
 */

import type { ConnectorHealth, FetchCatalogOptions, NormalizedContent, ProviderConnector } from '../core/connector.interface';
import { ConnectorReauthRequiredError } from '../core/errors';
import { CONNECTOR_PROVIDER_REQUIRED_ENV } from '../core/providers';
import { connectorService } from '../core/connector.service';
import {
  fetchMercadoLivreItems,
  hasMercadoLivreAuthorization,
  hasMercadoLivreCredentials,
  MERCADOLIVRE_CONNECT_CTA,
} from './mercadolivre.service';

export class MercadoLivreConnector implements ProviderConnector {
  readonly provider = 'MERCADOLIVRE' as const;
  readonly name = 'Mercado Livre';

  async fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    const { accessToken, shopId } = await connectorService.getValidAccessToken(options.usuarioId, this.provider);
    // Sem credencial utilizável NUNCA chamamos a API: listar anúncios com
    // bearer vazio devolvia um 401 opaco que o painel mostrava como "Não
    // foi possível listar os anúncios do Mercado Livre". Agora o operador
    // lê a ação que realmente resolve.
    if (!hasMercadoLivreAuthorization(accessToken, shopId)) {
      throw new ConnectorReauthRequiredError(
        this.provider,
        `A conta do Mercado Livre ainda não foi autorizada. Clique em "${MERCADOLIVRE_CONNECT_CTA}" para liberar o acesso aos seus anúncios.`
      );
    }
    return fetchMercadoLivreItems(accessToken, shopId as string, options.limit ?? 50);
  }

  async testConnection(): Promise<ConnectorHealth> {
    const missingEnv = CONNECTOR_PROVIDER_REQUIRED_ENV.MERCADOLIVRE.filter((name) => !process.env[name]?.trim());
    const configured = hasMercadoLivreCredentials();
    return {
      provider: this.provider,
      ok: configured,
      missingEnv,
      message: configured
        ? 'Integração oficial pronta. Conecte uma conta Mercado Livre para validar as permissões.'
        : `Configure ${missingEnv.join(' e ')} no servidor para conectar uma conta.`,
    };
  }
}
