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
 *   • A NUVEMSHOP é a PLATAFORMA-PONTE da triangulação de vendas: o
 *     catálogo que ela publica (inclusive o exibido no TikTok) e os
 *     pedidos que ela fecha são a fonte do canal.
 *   • INSTAGRAM SHOPPING (2026-10-06): o canal passou a ter conector
 *     PRÓPRIO e independente (`instagram/`), ligado direto à Graph API
 *     da Meta — OAuth2 oficial, webhook assinado e catálogo de Product
 *     Tagging. A Meta NÃO expõe pedido de Instagram para terceiros (o
 *     checkout nativo foi descontinuado em 2025 e a Commerce Order
 *     Management API some de todas as versões em 2026-10-27), então o
 *     canal entra como motor de INTERAÇÃO + catálogo, com o caminho de
 *     receita pronto e dirigido por payload. Ver
 *     `instagram/instagram.service.ts`.
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
 * Os QUATRO canais de produção do motor comercial. A ordem é a ordem de
 * exibição no painel de conectores.
 */
export const CONNECTOR_PROVIDERS = ['MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP', 'INSTAGRAM'] as const;

export type ConnectorProviderName = (typeof CONNECTOR_PROVIDERS)[number];

/** Rótulos pt-BR dos cartões de conector. */
export const CONNECTOR_PROVIDER_LABELS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Mercado Livre',
  MERCADOPAGO: 'Mercado Pago',
  NUVEMSHOP: 'Nuvemshop',
  INSTAGRAM: 'Instagram Shopping',
};

/** Descrição curta exibida sob o título do cartão. */
export const CONNECTOR_PROVIDER_DESCRIPTIONS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Meli API oficial — OAuth2 com rotação automática de refresh token.',
  MERCADOPAGO: 'Checkout e faturamento via Access Token de produção.',
  NUVEMSHOP: 'Plataforma-ponte do Hub: OAuth2 oficial com catálogo e pedidos para a triangulação de vendas.',
  INSTAGRAM:
    'Graph API da Meta — conexão direta com a conta comercial: catálogo da sacolinha e webhook assinado de interações em tempo real.',
};

/** O que o operador conecta, por provedor (objeto da chamada para ação). */
export const CONNECTOR_PROVIDER_ACCOUNT_LABELS: Record<ConnectorProviderName, string> = {
  MERCADOLIVRE: 'Conta do Mercado Livre',
  MERCADOPAGO: 'Credenciais do Mercado Pago',
  NUVEMSHOP: 'Loja da Nuvemshop',
  INSTAGRAM: 'Conta Comercial do Instagram',
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
  INSTAGRAM: 'instagram',
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
  instagram: 'INSTAGRAM',
  'instagram-shopping': 'INSTAGRAM',
  ig: 'INSTAGRAM',
  meta: 'INSTAGRAM',
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
  INSTAGRAM: 'oauth2',
};

/** Variáveis de ambiente obrigatórias da APLICAÇÃO, por provedor. */
export const CONNECTOR_PROVIDER_REQUIRED_ENV: Record<ConnectorProviderName, readonly string[]> = {
  MERCADOLIVRE: ['MERCADOLIVRE_CLIENT_ID', 'MERCADOLIVRE_CLIENT_SECRET'],
  MERCADOPAGO: [],
  NUVEMSHOP: ['NUVEMSHOP_CLIENT_ID', 'NUVEMSHOP_CLIENT_SECRET'],
  // O verify token não entra aqui: ele só é exigido para REGISTRAR o
  // webhook na Meta, não para conectar a conta.
  INSTAGRAM: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
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
  INSTAGRAM: 'INSTAGRAM_REDIRECT_URI',
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

export const SALE_CHANNELS = ['BROBOND', 'INSTAGRAM_SHOPPING', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP'] as const;

export type SaleChannelName = (typeof SALE_CHANNELS)[number];

export const SALE_STATUSES = ['PENDING', 'PAID', 'REFUNDED', 'CANCELLED'] as const;

export type SaleStatusName = (typeof SALE_STATUSES)[number];

/**
 * Provedor do conector → canal gravado em `sales.channel`.
 *
 * Três canais são 1:1 com o provedor (os enums foram desenhados assim na
 * Fase 1). A ÚNICA divergência é deliberada e vem da diretoria: o
 * provedor `INSTAGRAM` (conta comercial da Meta) grava receita no canal
 * `INSTAGRAM_SHOPPING` — o rótulo renomeado na migração
 * `0015_instagram_shopping_channel`, que nomeia a vitrine, não a rede
 * social.
 *
 * O mapa é `Record<ConnectorProviderName, SaleChannelName>`: provedor
 * novo sem canal — ou canal que não exista no enum — QUEBRA A
 * COMPILAÇÃO em vez de virar `undefined` em produção.
 */
const SALE_CHANNEL_BY_PROVIDER: Record<ConnectorProviderName, SaleChannelName> = {
  MERCADOLIVRE: 'MERCADOLIVRE',
  MERCADOPAGO: 'MERCADOPAGO',
  NUVEMSHOP: 'NUVEMSHOP',
  INSTAGRAM: 'INSTAGRAM_SHOPPING',
};

export function saleChannelFromConnectorProvider(provider: ConnectorProviderName): SaleChannelName {
  return SALE_CHANNEL_BY_PROVIDER[provider];
}
