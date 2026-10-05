/**
 * Registro de provedores dos conectores multicanal — Fase 2 da fusão
 * commerce → ERP.
 *
 * Fonte: `modules/marketplace/core/providers.ts` do brobond-ai-commerce
 * (PR012). ADAPTAÇÕES DESTA FASE:
 *
 *   • O ERP opera com QUATRO provedores core — MERCADOLIVRE, MERCADOPAGO,
 *     SHOPEE e TIKTOK. O Instagram Shopping permanece no enum do banco
 *     (`connector_provider`) por compatibilidade com a migration da Fase 1,
 *     mas NÃO é um provedor registrado: o `connector.factory.ts` é estrito
 *     e nunca resolve um adaptador para ele.
 *   • O conector da Nuvemshop do commerce foi REMOVIDO do ecossistema. Não
 *     existe `NUVEMSHOP` em lugar nenhum deste módulo: nem no registro, nem
 *     no mapeador central, nem na persistência. Qualquer `provider`
 *     desconhecido (inclusive o literal "nuvemshop") é rejeitado por
 *     `parseConnectorProvider()` antes de tocar o banco.
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
 * Os QUATRO provedores remanescentes do motor comercial. A ordem é a
 * ordem de exibição no painel de conectores.
 */
export const CONNECTOR_PROVIDERS = ['MERCADOLIVRE', 'MERCADOPAGO', 'SHOPEE', 'TIKTOK'] as const;

export type ConnectorProviderName = (typeof CONNECTOR_PROVIDERS)[number];

/** Rótulos pt-BR dos cartões de conector. */
export const CONNECTOR_PROVIDER_LABELS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Mercado Livre',
  MERCADOPAGO: 'Mercado Pago',
  SHOPEE: 'Shopee',
  TIKTOK: 'TikTok Shop',
};

/** Descrição curta exibida sob o título do cartão. */
export const CONNECTOR_PROVIDER_DESCRIPTIONS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Meli API oficial — OAuth2 com rotação automática de refresh token.',
  MERCADOPAGO: 'Checkout e faturamento via Access Token de produção.',
  SHOPEE: 'Shopee Open Platform v2 com assinatura HMAC-SHA256.',
  TIKTOK: 'TikTok Shop Partner Center — OAuth2 oficial para pedidos e catálogo.',
};

/** O que o operador conecta, por provedor (objeto da chamada para ação). */
export const CONNECTOR_PROVIDER_ACCOUNT_LABELS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Conta do Mercado Livre',
  MERCADOPAGO: 'Credenciais do Mercado Pago',
  SHOPEE: 'Conta da Shopee',
  TIKTOK: 'Conta do TikTok',
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
  SHOPEE: 'shopee',
  TIKTOK: 'tiktok',
};

/**
 * Apelidos aceitos na URL além do slug canônico. Mantidos porque os
 * painéis das plataformas já têm callbacks registrados com hífen (e o
 * registro é imutável do lado de lá).
 */
const CONNECTOR_PROVIDER_ALIASES: Record<string, ConnectorProviderName> = {
  mercadolivre: 'MERCADOLIVRE',
  'mercado-livre': 'MERCADOLIVRE',
  meli: 'MERCADOLIVRE',
  mercadopago: 'MERCADOPAGO',
  'mercado-pago': 'MERCADOPAGO',
  mp: 'MERCADOPAGO',
  shopee: 'SHOPEE',
  tiktok: 'TIKTOK',
  'tiktok-shop': 'TIKTOK',
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

/** Type guard: o valor é um dos quatro provedores registrados? */
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
  SHOPEE: 'oauth2',
  TIKTOK: 'oauth2',
};

/** Variáveis de ambiente obrigatórias da APLICAÇÃO, por provedor. */
export const CONNECTOR_PROVIDER_REQUIRED_ENV: Record<ConnectorProviderName, readonly string[]> = {
  MERCADOLIVRE: ['MERCADOLIVRE_CLIENT_ID', 'MERCADOLIVRE_CLIENT_SECRET'],
  MERCADOPAGO: [],
  SHOPEE: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'],
  TIKTOK: ['TIKTOK_SERVICE_ID', 'TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET'],
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

export const SALE_CHANNELS = ['BROBOND', 'TIKTOK', 'INSTAGRAM', 'SHOPEE', 'MERCADOLIVRE', 'MERCADOPAGO'] as const;

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
