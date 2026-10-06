/**
 * Mapeador central dos conectores — o ÚNICO ponto onde um
 * `ConnectorProviderName` vira um `ProviderConnector`.
 *
 * Fonte: `modules/connectors/core/connector.factory.ts` do
 * brobond-ai-commerce (PR005/PR012).
 *
 * ESTADO ATUAL: o mapa trata ESTRITAMENTE os QUATRO canais de produção
 * — MERCADOLIVRE, MERCADOPAGO, NUVEMSHOP e INSTAGRAM — sem nenhuma
 * referência morta:
 *
 *   • saiu `MOCK` (nunca foi motor de pedido do ERP);
 *   • ENTROU `INSTAGRAM` (2026-10-06): conector próprio e isolado,
 *     ligado direto à Graph API da Meta — catálogo de Product Tagging e
 *     webhook assinado. Nenhum dos outros três é tocado por ele;
 *   • saíram os conectores nativos de SHOPEE e TIKTOK, removidos do
 *     ecossistema por causa das barreiras burocráticas das APIs deles —
 *     não há builder, import, slug, rótulo nem ramo de persistência
 *     sobrando para eles em lugar nenhum do módulo; a triangulação de
 *     vendas (inclusive o catálogo do TikTok) passa pela NUVEMSHOP;
 *   • o tipo do mapa é `Record<ConnectorProviderName, () =>
 *     ProviderConnector>`: esquecer um provedor OU acrescentar uma chave
 *     que não exista no registro QUEBRA A COMPILAÇÃO. A exaustividade é
 *     do compilador, não da revisão de código.
 *
 * `getConnector(provider)` é a única forma suportada de obter um
 * conector: mapear provedor → implementação NUNCA pode acontecer por um
 * `switch` fora daqui.
 */

import { InstagramConnector } from '../instagram/instagram.connector';
import { MercadoLivreConnector } from '../mercadolivre/mercadolivre.connector';
import { MercadoPagoConnector } from '../mercadopago/mercadopago.connector';
import { NuvemshopConnector } from '../nuvemshop/nuvemshop.connector';
import type { ProviderConnector } from './connector.interface';
import { ConnectorNotRegisteredError } from './errors';
import { CONNECTOR_PROVIDERS, parseConnectorProvider, type ConnectorProviderName } from './providers';

/**
 * Provedor → construtor do adaptador. As instâncias são cacheadas por
 * provedor, então o mapeador é estável
 * (`getConnector('NUVEMSHOP') === getConnector('NUVEMSHOP')`).
 */
const CONNECTOR_BUILDERS: Record<ConnectorProviderName, () => ProviderConnector> = {
  MERCADOLIVRE: () => new MercadoLivreConnector(),
  MERCADOPAGO: () => new MercadoPagoConnector(),
  NUVEMSHOP: () => new NuvemshopConnector(),
  INSTAGRAM: () => new InstagramConnector(),
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
 * corpo de requisição). Entrada desconhecida — inclusive os literais
 * "shopee" e "tiktok" dos conectores removidos — devolve `null`, nunca
 * um adaptador fantasma.
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
