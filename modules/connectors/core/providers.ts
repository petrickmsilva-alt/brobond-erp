/**
 * Registro de provedores dos conectores multicanal — Fase 2 da fusão
 * commerce → ERP.
 *
 * Fonte: `modules/marketplace/core/providers.ts` do brobond-ai-commerce
 * (PR012). DECISÃO ESTRATÉGICA DO DIRETOR (2026-10-05):
 *
 *   • SHOPEE e TIKTOK foram DESPROVISIONADOS do ecossistema — as barreiras
 *     burocráticas/de API tornaram os conectores nativos inviáveis. Não
 *     existe builder, import, slug, rótulo, alias, tópico de webhook nem
 *     ramo de persistência para eles em lugar nenhum do módulo.
 *   • A NUVEMSHOP entra como plataforma-PONTE do Hub Omnichannel: a
 *     triangulação de vendas (incluindo o catálogo do TikTok) passa por
 *     ela. O registro já a lista entre os provedores de produção.
 *   • O ERP opera com o TRIO de produção — MERCADOLIVRE, MERCADOPAGO e
 *     NUVEMSHOP. O Instagram Shopping permanece no enum do banco
 *     (`connector_provider`) por compatibilidade com a migration da Fase 1,
 *     mas NÃO é um provedor registrado: o `connector.factory.ts` é estrito
 *     e nunca resolve um adaptador para ele.
 *   • A tenancy é `usuarioId` (FK → `usuarios.id` do ERP) e não mais
 *     `organizationId`.
 *
 * ESTE ARQUIVO É PURO: sem `process.env`, sem acesso a banco, sem
 * dependência de Express — pode ser importado por qualquer camada.
 */

// ------------------------------------------------------------------
// Provedores
// ------------------------------------------------------------------

/**
 * O TRIO de produção do motor comercial (decisão do Diretor). A ordem é a
 * ordem de exibição no painel de conectores.
 */
export const CONNECTOR_PROVIDERS = ['MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP'] as const;

export type ConnectorProviderName = (typeof CONNECTOR_PROVIDERS)[number];

/** Rótulos pt-BR dos cartões de conector. */
export const CONNECTOR_PROVIDER_LABELS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Mercado Livre',
  MERCADOPAGO: 'Mercado Pago',
  NUVEMSHOP: 'Nuvemshop',
};

/** Descrição curta exibida sob o título do cartão. */
export const CONNECTOR_PROVIDER_DESCRIPTIONS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Meli API oficial — OAuth2 com rotação automática de refresh token.',
  MERCADOPAGO: 'Checkout e faturamento via Access Token de produção.',
  NUVEMSHOP: 'Plataforma-ponte do Hub Omnichannel — triangulação de vendas e catálogo (incluindo TikTok) em uma única integração.',
};

/** O que o operador conecta, por provedor (objeto da chamada para ação). */
export const CONNECTOR_PROVIDER_ACCOUNT_LABELS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Conta do Mercado Livre',
  MERCADOPAGO: 'Credenciais do Mercado Pago',
  NUVEMSHOP: 'Loja da Nuvemshop',
};

/** Rótulo do botão conectar/reconectar de um provedor. */
export function connectorConnectLabel(provider: ConnectorProviderName, connected = false): string {
  return `${connected ? 'Reconectar' : 'Conectar'} ${CONNECTOR_PROVIDER_ACCOUNT_LABELS[provider]}`;
}

/**
 * Slug de URL de cada provedor. É o `:provider` das rotas
 * `/api/connectors/:provider/callback` e `/api/webhooks/:provider`.
 */
export const CONNECTOR_PROVIDER_SLUGS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'mercadolivre',
  MERCADOPAGO: 'mercadopago',
  NUVEMSHOP: 'nuvemshop',
};

/**
 * Apelidos aceitos na URL além do slug canônico. Os conectores nativos de
 * Shopee e TikTok NÃO têm apelidos: os literais "shopee"/"tiktok" são
 * rejeitados por `parseConnectorProvider()` antes de tocar o banco.
 */
const CONNECTOR_PROVIDER_ALIASES: Record<string, ConnectorProviderName> = {
  mercadolivre: 'MERCADOLIVRE',
  'mercado-livre': 'MERCADOLIVRE',
  meli: 'MERCADOLIVRE',
  mercadopago: 'MERCADOPAGO',
  'mercado-pago': 'MERCADOPAGO',
  mp: 'MERCADOPAGO',
  nuvemshop: 'NUVEMSHOP',
  'nuvem-shop': 'NUVEMSHOP',
  // A Nuvemshop opera como Tiendanube nos países hispanofonos.
  tiendanube: 'NUVEMSHOP',
};

/**
 * Converte o segmento `:provider` da rota (ou qualquer entrada externa)
 * no provedor canônico. Retorna `null` — nunca lança — para entrada
 * desconhecida: a rota responde 404 e nada chega ao banco.
 */
export function parseConnectorProvider(value: unknown): ConnectorProviderName | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return CONNECTOR_PROVIDER_ALIASES[normalized] ?? null;
}

/** Type guard: o valor é um dos três provedores registrados? */
export function isConnectorProviderName(value: unknown): value is ConnectorProviderName {
  return typeof value === 'string' && (CONNECTOR_PROVIDERS as readonly string[]).includes(value as ConnectorProviderName);
}

// ------------------------------------------------------------------
// Modelo de autenticação
// ------------------------------------------------------------------

/**
 * Como a conexão de cada provedor é estabelecida:
 *   `oauth2`      — redirecionamento do navegador até o provedor;
 *   `credentials` — o operador cola as credenciais de produção no painel.
 */
export type ConnectorAuthModel = 'oauth2' | 'credentials';

export const CONNECTOR_PROVIDER_AUTH_MODEL: Record<ConnectorProviderName, ConnectorAuthModel> = {
  MERCADOLIVRE: 'oauth2',
  MERCADOPAGO: 'credentials',
  NUVEMSHOP: 'oauth2',
};

/** Variáveis de ambiente obrigatórias da APLICAÇÃO, por provedor. */
export const CONNECTOR_PROVIDER_REQUIRED_ENV: Record<ConnectorProviderName, readonly string[]> = {
  MERCADOLIVRE: ['MERCADOLIVRE_CLIENT_ID', 'MERCADOLIVRE_CLIENT_SECRET'],
  MERCADOPAGO: [],
  NUVEMSHOP: ['NUVEMSHOP_CLIENT_ID', 'NUVEMSHOP_CLIENT_SECRET'],
};

// ------------------------------------------------------------------
// Status da conexão (enum `connection_status` do banco)
// ------------------------------------------------------------------

export const CONNECTION_STATUSES = [
  'DISCONNECTED',
  'CONNECTED',
  'EXPIRED',
  'ERROR',
  'PENDING_APPROVAL',
  'REAUTH_REQUIRED',
  'SANDBOX_ACTIVE',
] as const;

export type ConnectionStatusName = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatusName, string> = {
  DISCONNECTED: 'Desconectado',
  CONNECTED: 'Conectado',
  EXPIRED: 'Credencial expirada',
  ERROR: 'Erro na última chamada',
  PENDING_APPROVAL: 'Aguardando aprovação da plataforma',
  REAUTH_REQUIRED: 'Reconexão necessária',
  SANDBOX_ACTIVE: 'Sandbox ativo',
};

export function isConnectionStatusName(value: unknown): value is ConnectionStatusName {
  return typeof value === 'string' && (CONNECTION_STATUSES as readonly string[]).includes(value as ConnectionStatusName);
}

// ------------------------------------------------------------------
// Canal de venda (enum `sale_channel` do banco)
// ------------------------------------------------------------------

export const SALE_CHANNELS = ['BROBOND', 'INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP'] as const;

export type SaleChannelName = (typeof SALE_CHANNELS)[number];

export const SALE_STATUSES = ['PENDING', 'PAID', 'REFUNDED', 'CANCELLED'] as const;

export type SaleStatusName = (typeof SALE_STATUSES)[number];

/**
 * O canal de uma venda sincronizada é idêntico ao provedor do conector —
 * os enums foram desenhados 1:1 na Fase 1, então o mapeamento não pode
 * divergir.
 */
export function saleChannelFromConnectorProvider(provider: ConnectorProviderName): SaleChannelName {
  return provider;
}
