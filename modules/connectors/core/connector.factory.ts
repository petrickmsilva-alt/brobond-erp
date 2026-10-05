/**
 * Mapeador central dos conectores — o ÚNICO ponto onde um
 * `ConnectorProviderName` vira um `ProviderConnector`.
 *
 * Fonte: `modules/connectors/core/connector.factory.ts` do
 * brobond-ai-commerce (PR005/PR012).
 *
 * ADAPTAÇÃO DESTA FASE (exigência do diretor): o mapa trata APENAS os
 * QUATRO provedores remanescentes, de forma ESTRITA e sem referências
 * mortas:
 *
 *   • saíram `MOCK` e `INSTAGRAM` (nunca foram motores de pedido do ERP);
 *   • saiu o conector da NUVEMSHOP, removido do ecossistema — não há
 *     builder, import, slug, rótulo nem ramo de persistência sobrando
 *     para ele em lugar nenhum do módulo;
 *   • o tipo do mapa é `Record<ConnectorProviderName, () =>
 *     ProviderConnector>`: esquecer um provedor OU acrescentar uma chave
 *     que não exista no registro QUEBRA A COMPILAÇÃO. A exaustividade é
 *     do compilador, não da revisão de código.
 *
 * `getConnector(provider)` é a única forma suportada de obter um
 * conector: mapear provedor → implementação NUNCA pode acontecer por um
 * `switch` fora daqui.
 */

import { MercadoLivreConnector } from '../mercadolivre/mercadolivre.connector';
import { MercadoPagoConnector } from '../mercadopago/mercadopago.connector';
import { ShopeeConnector } from '../shopee/shopee.connector';
import { TikTokConnector } from '../tiktok/tiktok.connector';
import type { ProviderConnector } from './connector.interface';
import { ConnectorNotRegisteredError } from './errors';
import { CONNECTOR_PROVIDERS, parseConnectorProvider, type ConnectorProviderName } from './providers';

/**
 * Provedor → construtor do adaptador. As instâncias são cacheadas por
 * provedor, então o mapeador é estável
 * (`getConnector('SHOPEE') === getConnector('SHOPEE')`).
 */
const CONNECTOR_BUILDERS: Record<ConnectorProviderName, () => ProviderConnector> = {
  MERCADOLIVRE: () => new MercadoLivreConnector(),
  MERCADOPAGO: () => new MercadoPagoConnector(),
  SHOPEE: () => new ShopeeConnector(),
  TIKTOK: () => new TikTokConnector(),
};

const instances = new Map<ConnectorProviderName, ProviderConnector>();

/**
 * Resolve o conector de um provedor (singleton preguiçoso por provedor).
 *
 * @throws {ConnectorNotRegisteredError} para provedor não registrado.
 */
export function getConnector(provider: ConnectorProviderName): ProviderConnector {
  const cached = instances.get(provider);
  if (cached) return cached;

  const build = CONNECTOR_BUILDERS[provider];
  if (!build) throw new ConnectorNotRegisteredError(String(provider));

  const instance = build();
  instances.set(provider, instance);
  return instance;
}

/**
 * Resolve o conector a partir de um valor externo (segmento de rota,
 * corpo de requisição). Entrada desconhecida — inclusive o literal
 * "nuvemshop" do conector removido — devolve `null`, nunca um adaptador
 * fantasma.
 */
export function getConnectorFromInput(value: unknown): ProviderConnector | null {
  const provider = parseConnectorProvider(value);
  return provider ? getConnector(provider) : null;
}

/** Todos os conectores registrados, na ordem de exibição do painel. */
export function listConnectors(): ProviderConnector[] {
  return CONNECTOR_PROVIDERS.map((provider) => getConnector(provider));
}

/** Quantos provedores o mapeador conhece (denominador dos KPIs). */
export const REGISTERED_CONNECTOR_COUNT = CONNECTOR_PROVIDERS.length;
