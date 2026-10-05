/**
 * Adaptador do Mercado Pago (contrato `ProviderConnector`).
 *
 * Fonte: `modules/connectors/mercadopago/mercadopago.connector.ts` do
 * brobond-ai-commerce. O "catálogo" deste canal é o feed de faturamento
 * (pagamentos recentes) — é o que alimenta os KPIs de receita.
 */

import type { ConnectorHealth, FetchCatalogOptions, NormalizedContent, ProviderConnector } from '../core/connector.interface';
import { connectorService } from '../core/connector.service';
import { fetchMercadoPagoPayments, getMercadoPagoEnvironmentCredentials } from './mercadopago.service';

export class MercadoPagoConnector implements ProviderConnector {
  readonly provider = 'MERCADOPAGO' as const;
  readonly name = 'Mercado Pago';

  async fetchCatalog(options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    const { accessToken } = await connectorService.getValidAccessToken(options.usuarioId, this.provider);
    return fetchMercadoPagoPayments(accessToken, options.limit ?? 50);
  }

  async testConnection(): Promise<ConnectorHealth> {
    // O Mercado Pago não exige variáveis da APLICAÇÃO: a credencial de
    // produção é colada no painel e guardada cifrada. O par de ambiente é
    // só um atalho de deploy.
    const environment = getMercadoPagoEnvironmentCredentials();
    return {
      provider: this.provider,
      ok: environment !== null,
      missingEnv: [],
      message: environment
        ? 'Credenciais de ambiente detectadas. Conecte pelo painel para gravá-las cifradas por responsável.'
        : 'Cole o Access Token e a Public Key de produção no painel (Conectores → Mercado Pago) para conectar.',
    };
  }
}
