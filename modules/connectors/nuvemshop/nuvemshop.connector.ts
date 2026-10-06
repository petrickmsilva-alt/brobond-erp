/**
 * Adaptador da Nuvemshop (contrato `ProviderConnector`) — estrutura
 * inicial do conector da plataforma-PONTE do Hub Omnichannel.
 *
 * DECISÃO ESTRATÉGICA DO DIRETOR (2026-10-05): com o desprovisionamento
 * dos conectores nativos de SHOPEE e TIKTOK (barreiras burocráticas de
 * suas APIs), a Nuvemshop assume a triangulação de vendas — o catálogo
 * publicado no TikTok e a receita dos canais de social commerce passam a
 * entrar no ERP por UMA única integração oficial.
 *
 * ESTADO ATUAL: estrutura pronta para receber a integração. Este
 * adaptador já satisfaz o contrato do `connector.factory.ts` (que mapeia
 * estritamente o trio MERCADOLIVRE · MERCADOPAGO · NUVEMSHOP), mas o
 * `nuvemshop.service.ts` — OAuth, catálogo, pedidos e assinatura de
 * webhook contra a API oficial (api.nuvemshop.com.br / Tiendanube) —
 * ainda não foi implementado. Até lá, toda operação de rede responde com
 * um erro de domínio claro, NUNCA com um adaptador fantasma.
 *
 * Variáveis de ambiente da aplicação (server/.env.example):
 *   NUVEMSHOP_CLIENT_ID      — id do app no Developer Center da Nuvemshop;
 *   NUVEMSHOP_CLIENT_SECRET  — segredo do app;
 *   NUVEMSHOP_REDIRECT_URI   — ${APP_URL}/api/connectors/nuvemshop/callback.
 */

import type { ConnectorHealth, FetchCatalogOptions, NormalizedContent, ProviderConnector } from '../core/connector.interface';
import { ConnectorError } from '../core/errors';
import { CONNECTOR_PROVIDER_REQUIRED_ENV } from '../core/providers';

/** Mensagem única do esqueleto — a integração oficial está em implantação. */
export const NUVEMSHOP_INTEGRATION_PENDING_MESSAGE =
  'A integração da Nuvemshop está em implantação: a estrutura do conector já está registrada no Hub Omnichannel e a ativação do OAuth, do catálogo e da triangulação de vendas chega com o nuvemshop.service.ts.';

export class NuvemshopConnector implements ProviderConnector {
  readonly provider = 'NUVEMSHOP' as const;
  readonly name = 'Nuvemshop';

  async fetchCatalog(_options: FetchCatalogOptions): Promise<NormalizedContent[]> {
    // Sem chamada de rede até o serviço oficial existir: o contrato exige
    // erro de domínio (mapeado para HTTP pela rota), não um array vazio
    // que o painel confundiria com "loja sem produtos".
    throw new ConnectorError(NUVEMSHOP_INTEGRATION_PENDING_MESSAGE, this.provider);
  }

  async testConnection(): Promise<ConnectorHealth> {
    const missingEnv = CONNECTOR_PROVIDER_REQUIRED_ENV.NUVEMSHOP.filter((name) => !process.env[name]?.trim());
    const configured = missingEnv.length === 0;
    return {
      provider: this.provider,
      ok: configured,
      missingEnv,
      message: configured
        ? 'Credenciais da aplicação Nuvemshop detectadas. A ativação do OAuth e da triangulação de vendas chega com o nuvemshop.service.ts.'
        : `Configure ${missingEnv.join(' e ')} no servidor para ativar a plataforma-ponte (triangulação Shopee/TikTok via Nuvemshop).`,
    };
  }
}
