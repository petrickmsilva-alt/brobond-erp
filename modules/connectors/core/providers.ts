/**
 * Registro de provedores dos conectores multicanal — Hub Omnichannel.
 *
 * Fonte: `modules/marketplace/core/providers.ts` do brobond-ai-commerce
 * (PR012). ADAPTAÇÕES VIGENTES:
 *
 *   • DECISÃO DE NEGÓCIO (2026-10-05): os conectores nativos de SHOPEE e
 *     TIKTOK foram REMOVIDOS do ecossistema por causa das barreiras
 *     burocráticas das APIs deles. Não existe `SHOPEE` nem `TIKTOK` em
 *     lugar nenhum deste módulo — nem no registro, nem no mapeador
 *     central, nem na persistência (os valores saíram dos enums
 *     `connector_provider`/`sale_channel` na migration
 *     `drop_shopee_and_tiktok_connectors`).
 *   • O TRIO DE PRODUÇÃO é MERCADOLIVRE, MERCADOPAGO e NUVEMSHOP. A
 *     Nuvemshop é a PLATAFORMA-PONTE da triangulação de vendas: o
 *     catálogo que ela publica (inclusive o exibido no TikTok) e os
 *     pedidos que ela fecha são a fonte do canal.
 *   • O Instagram Shopping permanece no enum do banco por compatibilidade
 *     com a Fase 1, mas NÃO é um provedor registrado: o
 *     `connector.factory.ts` é estrito e nunca resolve um adaptador para
 *     ele.
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
 * O TRIO de produção do motor comercial. A ordem é a ordem de exibição
 * no painel de conectores.
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
  NUVEMSHOP: 'Plataforma-ponte do Hub: OAuth2 oficial com catálogo e pedidos para a triangulação de vendas.',
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
  nuvemshop: 'NUVEMSHOP',
  'nuvem-shop': 'NUVEMSHOP',
  tiendanube: 'NUVEMSHOP',
};

/**
 * Converte o segmento `:provider` da rota (ou qualquer entrada externa)
 * no provedor canônico. Retorna `null` — nunca lança — para entrada
 * desconhecida: a rota responde 404 e nada chega ao banco. Os literais
 * "shopee" e "tiktok" dos conectores removidos caem exatamente aqui.
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

/**
 * Variável de `redirect_uri` explícito de cada provedor OAuth. Usada na
 * checagem de prontidão de produção (um callback público em HTTPS).
 * `null` para quem não fala OAuth.
 */
export const CONNECTOR_PROVIDER_REDIRECT_ENV: Record<ConnectorProviderName, string | null> = {
  MERCADOLIVRE: 'MERCADOLIVRE_REDIRECT_URI',
  MERCADOPAGO: null,
  NUVEMSHOP: 'NUVEMSHOP_REDIRECT_URI',
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
