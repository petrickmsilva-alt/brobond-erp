/**
 * Mercado Livre — API oficial (Meli), SOMENTE servidor.
 *
 * Fonte: `modules/marketplace/mercadolivre/mercadolivre.service.ts` do
 * brobond-ai-commerce (PR012/PR016). Fluxo OAuth2 documentado:
 *
 *   buildMercadoLivreAuthorizationUrl() → auth.mercadolivre.com.br
 *   /api/connectors/mercadolivre/callback recebe (code, state) →
 *   exchangeMercadoLivreCode() troca o código por um par access/refresh
 *   e refreshMercadoLivreToken() rotaciona antes do vencimento (6h).
 *
 * CONTRATO DO REDIRECT URI (PR016.2, preservado na fusão)
 * -------------------------------------------------------
 * A Meli valida o `redirect_uri` DUAS vezes — em `/authorization` e na
 * troca do código — e os dois valores precisam ser idênticos byte a byte
 * e iguais ao cadastrado no DevCenter. Por isso o valor é ESTÁTICO,
 * resolvido só do ambiente (`MERCADOLIVRE_REDIRECT_URI` ou `APP_URL` +
 * `/api/connectors/mercadolivre/callback`). NADA é derivado da
 * requisição de entrada.
 */

import { ConnectorConfigError, ProviderApiError } from '../core/errors';
import { resolveStaticRedirectUri, type AppUrlEnv } from '../core/app-url';
import type { NormalizedContent } from '../core/connector.interface';
import { CONNECTOR_PROVIDER_SLUGS } from '../core/providers';

const MELI_API_BASE_URL = 'https://api.mercadolibre.com';
const MELI_AUTH_BASE_URL = 'https://auth.mercadolivre.com.br';
const PROVIDER = 'MERCADOLIVRE' as const;

/** A única ação que resolve toda falha de autorização deste canal. */
export const MERCADOLIVRE_CONNECT_CTA = 'Conectar Conta do Mercado Livre';

export interface MercadoLivreConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  authBaseUrl: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConnectorConfigError(name, PROVIDER);
  return value;
}

/** Config de servidor; o client secret nunca sai deste módulo. */
export function getMercadoLivreConfig(): MercadoLivreConfig {
  return {
    clientId: requiredEnv('MERCADOLIVRE_CLIENT_ID'),
    clientSecret: requiredEnv('MERCADOLIVRE_CLIENT_SECRET'),
    apiBaseUrl: process.env.MERCADOLIVRE_API_BASE_URL?.trim() || MELI_API_BASE_URL,
    authBaseUrl: process.env.MERCADOLIVRE_AUTH_BASE_URL?.trim() || MELI_AUTH_BASE_URL,
  };
}

/** `true` quando as credenciais da aplicação estão no ambiente. */
export function hasMercadoLivreCredentials(env: AppUrlEnv = process.env): boolean {
  return Boolean(env.MERCADOLIVRE_CLIENT_ID?.trim() && env.MERCADOLIVRE_CLIENT_SECRET?.trim());
}

/**
 * O `redirect_uri` apresentado à Meli — ESTÁTICO, só do ambiente. Precisa
 * estar cadastrado VERBATIM no DevCenter.
 */
export function resolveMercadoLivreRedirectUri(env: AppUrlEnv = process.env): string {
  return resolveStaticRedirectUri(['MERCADOLIVRE_REDIRECT_URI'], CONNECTOR_PROVIDER_SLUGS.MERCADOLIVRE, env);
}

/**
 * Normaliza o identificador público da aplicação antes de ele chegar à
 * Meli: painéis de ambiente guardam espaço acidental e barra final
 * copiada, e a Meli compara esse valor de forma estrita. O SEGREDO
 * deliberadamente não é normalizado.
 */
function normalizeAuthorizationClientId(clientId: string): string {
  return clientId.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * URL de autorização do vendedor para uma aplicação privada.
 *
 * A Meli deriva as permissões da configuração da aplicação no DevCenter.
 * Enviar `scope` (incluindo `offline_access`) opta pela validação de
 * permissões de terceiros e pode disparar a tela amarela de homologação
 * comercial. Por isso a requisição é deliberadamente estrita: campos de
 * protocolo + o state CSRF de uso único.
 */
export function buildMercadoLivreAuthorizationUrl(state: string, config: MercadoLivreConfig = getMercadoLivreConfig()): string {
  const url = new URL('/authorization', config.authBaseUrl.trim().toLowerCase());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', normalizeAuthorizationClientId(config.clientId));
  url.searchParams.set('redirect_uri', resolveMercadoLivreRedirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

export interface MercadoLivreTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  userId: string;
}

interface MeliTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: number;
  error?: string;
  error_description?: string;
  message?: string;
}

function parseMeliTokenResponse(rawBody: string): MeliTokenResponse | undefined {
  if (!rawBody) return undefined;
  try {
    return JSON.parse(rawBody) as MeliTokenResponse;
  } catch {
    return undefined;
  }
}

function logMeliTokenRejection(status: number, statusText: string, rawBody: string, redirectUri?: string): void {
  console.error('[mercadolivre.oauth.token] resposta rejeitada pelo Mercado Livre', {
    status,
    statusText,
    // O redirect URI ESTÁTICO que este deploy repetiu — é o valor a
    // cadastrar verbatim no DevCenter quando a Meli recusa o grant.
    ...(redirectUri ? { redirectUri } : {}),
    rawBody,
  });
}

async function meliTokenRequest(
  config: MercadoLivreConfig,
  form: Record<string, string>,
  redirectUri?: string
): Promise<MercadoLivreTokenSet> {
  const url = new URL('/oauth/token', config.apiBaseUrl);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...form,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o Mercado Livre.', 503, PROVIDER);
  }
  const rawBody = await response.text().catch(() => '');
  const payload = parseMeliTokenResponse(rawBody);
  if (!response.ok || !payload?.access_token || !payload.refresh_token || !payload.expires_in) {
    // NUNCA logar corpo de resposta 2xx: mesmo uma resposta incompleta
    // pode trazer um access token vivo.
    logMeliTokenRejection(
      response.status,
      response.statusText,
      response.ok ? '[omitido: a resposta pode conter credenciais]' : rawBody,
      redirectUri
    );
    const status = response.status || 502;
    throw new ProviderApiError(
      payload?.error_description || payload?.message || payload?.error || 'O Mercado Livre rejeitou a troca de token.',
      status,
      PROVIDER,
      // Grant recusado nunca se conserta repetindo — só autorizando a
      // conta de novo. Rate limit e indisponibilidade seguem retentáveis.
      { requiresReauth: status < 500 && status !== 429 }
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000),
    userId: payload.user_id !== undefined ? String(payload.user_id) : '',
  };
}

/** Troca o `code` de autorização por tokens (code grant oficial). */
export async function exchangeMercadoLivreCode(
  code: string,
  config: MercadoLivreConfig = getMercadoLivreConfig()
): Promise<MercadoLivreTokenSet> {
  const redirectUri = resolveMercadoLivreRedirectUri();
  return meliTokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, redirectUri);
}

/** Rotaciona o par de tokens antes do vencimento (6h de vida). */
export async function refreshMercadoLivreToken(
  refreshToken: string,
  config: MercadoLivreConfig = getMercadoLivreConfig()
): Promise<MercadoLivreTokenSet> {
  return meliTokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

// ------------------------------------------------------------------
// Chamadas autenticadas
// ------------------------------------------------------------------

/** `true` quando há material suficiente para chamar a Meli. */
export function hasMercadoLivreAuthorization(accessToken: string | null | undefined, userId?: string | null): boolean {
  if (!accessToken || !accessToken.trim()) return false;
  if (userId !== undefined && (!userId || !String(userId).trim())) return false;
  return true;
}

function assertMercadoLivreAuthorization(accessToken: string | null | undefined, userId?: string | null): void {
  if (!hasMercadoLivreAuthorization(accessToken, userId)) {
    throw new ProviderApiError(
      `A conta do Mercado Livre ainda não foi autorizada. Clique em "${MERCADOLIVRE_CONNECT_CTA}" para liberar o acesso.`,
      401,
      PROVIDER,
      { requiresReauth: true }
    );
  }
}

async function meliAuthorizedGet(url: URL, accessToken: string, context: string): Promise<{ status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o Mercado Livre.', 503, PROVIDER);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const status = response.status || 502;
    // 401/403 significam credencial recusada: o conserto é reconectar.
    throw new ProviderApiError(context, status, PROVIDER, {
      requiresReauth: status === 401 || status === 403,
    });
  }
  return { status: response.status, payload };
}

interface MeliUser {
  id?: number;
  nickname?: string;
  site_id?: string;
}

/** Identidade do vendedor (`/users/me`) — dado não secreto do conector. */
export async function fetchMercadoLivreIdentity(
  accessToken: string,
  config: MercadoLivreConfig = getMercadoLivreConfig()
): Promise<{ userId: string; nickname: string | null; siteId: string | null }> {
  assertMercadoLivreAuthorization(accessToken);
  const { payload } = await meliAuthorizedGet(
    new URL('/users/me', config.apiBaseUrl),
    accessToken,
    'Não foi possível identificar a conta do vendedor no Mercado Livre.'
  );
  const user = payload as MeliUser | undefined;
  if (user?.id === undefined) {
    throw new ProviderApiError('Não foi possível identificar a conta do vendedor no Mercado Livre.', 502, PROVIDER);
  }
  return {
    userId: String(user.id),
    nickname: user.nickname ?? null,
    siteId: user.site_id ?? null,
  };
}

// ------------------------------------------------------------------
// Pedidos — ingestão de vendas por webhook
// ------------------------------------------------------------------

/** Converte um valor decimal em centavos inteiros, limpando lixo. */
function toCents(amount: number | null | undefined): number {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

/** Item de um pedido da Meli, já normalizado para o `sale_items` do ERP. */
export interface MeliOrderItem {
  /** SKU do vendedor (`seller_sku` / `seller_custom_field`), quando houver. */
  sku: string | null;
  title: string;
  /** Nome literal da variação no marketplace ("Tamanho: M / Cor: Preto"). */
  variacaoExterna: string | null;
  quantity: number;
  unitPriceCents: number;
  /** Valor do tamanho declarado na variação, quando identificável. */
  sizeLabel: string | null;
}

export interface MeliOrder {
  id: string;
  /** Status da Meli: payment_required · payment_in_process · paid · … */
  status: string;
  /** Total do pedido em CENTAVOS. */
  totalAmountCents: number;
  currencyId: string;
  dateCreated: Date;
  dateClosed: Date | null;
  buyerNickname: string | null;
  itemCount: number;
  items: MeliOrderItem[];
}

interface MeliOrderItemResponse {
  item?: {
    id?: string;
    title?: string;
    seller_sku?: string | null;
    seller_custom_field?: string | null;
    variation_attributes?: Array<{ id?: string; name?: string; value_name?: string }>;
  };
  quantity?: number;
  unit_price?: number;
}

interface MeliOrderResponse {
  id?: number;
  status?: string;
  total_amount?: number;
  currency_id?: string;
  date_created?: string;
  date_closed?: string | null;
  buyer?: { nickname?: string };
  order_items?: MeliOrderItemResponse[];
  payments?: Array<{ status?: string; transaction_amount?: number }>;
  message?: string;
}

/** Nomes de atributo que a Meli usa para tamanho nas variações. */
const SIZE_ATTRIBUTE_IDS = new Set(['SIZE', 'SIZE_GRID_ID', 'TALLE', 'TAMANHO']);

function mapOrderItem(entry: MeliOrderItemResponse): MeliOrderItem {
  const attributes = entry.item?.variation_attributes ?? [];
  const sizeAttribute = attributes.find(
    (attribute) => SIZE_ATTRIBUTE_IDS.has((attribute.id ?? '').toUpperCase()) || /tamanho|talle|size/i.test(attribute.name ?? '')
  );
  const variacao = attributes
    .map((attribute) => `${attribute.name ?? attribute.id ?? ''}: ${attribute.value_name ?? ''}`)
    .filter((part) => part.trim() !== ':')
    .join(' / ');
  return {
    sku: entry.item?.seller_sku?.trim() || entry.item?.seller_custom_field?.trim() || null,
    title: entry.item?.title?.trim() || `Anúncio ${entry.item?.id ?? '—'}`,
    variacaoExterna: variacao || null,
    quantity: Math.max(1, Math.trunc(Number(entry.quantity ?? 1)) || 1),
    unitPriceCents: toCents(entry.unit_price),
    sizeLabel: sizeAttribute?.value_name?.trim() || null,
  };
}

/**
 * Busca um pedido (`GET /orders/{id}`) — o recurso referenciado pelas
 * notificações `orders`/`orders_v2`. O access token precisa pertencer ao
 * vendedor do pedido (resolvido pela ingestão).
 */
export async function fetchMercadoLivreOrder(
  accessToken: string,
  orderId: string,
  config: MercadoLivreConfig = getMercadoLivreConfig()
): Promise<MeliOrder> {
  assertMercadoLivreAuthorization(accessToken);
  const url = new URL(`/orders/${encodeURIComponent(orderId)}`, config.apiBaseUrl);
  const { payload: raw } = await meliAuthorizedGet(url, accessToken, `Não foi possível obter o pedido ${orderId} do Mercado Livre.`);
  const payload = raw as MeliOrderResponse | undefined;
  if (payload?.id === undefined) {
    throw new ProviderApiError(`Não foi possível obter o pedido ${orderId} do Mercado Livre.`, 502, PROVIDER);
  }

  // Pedido parcialmente pago já carrega pagamentos aprovados: a receita
  // usa o valor efetivamente pago, nunca o total pendente.
  const approvedPaymentsTotal = (payload.payments ?? [])
    .filter((payment) => payment.status === 'approved')
    .reduce((sum, payment) => sum + toCents(payment.transaction_amount), 0);
  const orderTotalCents = toCents(payload.total_amount);
  const items = (payload.order_items ?? []).map(mapOrderItem);

  return {
    id: String(payload.id),
    status: payload.status ?? 'unknown',
    totalAmountCents: approvedPaymentsTotal > 0 ? approvedPaymentsTotal : orderTotalCents,
    currencyId: payload.currency_id ?? 'BRL',
    dateCreated: payload.date_created ? new Date(payload.date_created) : new Date(),
    dateClosed: payload.date_closed ? new Date(payload.date_closed) : null,
    buyerNickname: payload.buyer?.nickname ?? null,
    itemCount: Math.max(1, items.reduce((sum, item) => sum + item.quantity, 0) || 1),
    items,
  };
}

interface MeliRelatedResourceResponse {
  order_id?: number | string;
  order?: { id?: number | string };
  orders?: Array<{ id?: number | string }>;
}

type MeliNotificationResource = 'orders' | 'payments' | 'collections' | 'shipments';

function resourceReference(
  resource: string,
  allowedSegments: readonly MeliNotificationResource[]
): { segment: MeliNotificationResource; id: string } | null {
  const match = /^\/(orders|payments|collections|shipments)\/([^/?#]+)/i.exec(resource.trim());
  if (!match?.[1] || !match[2]) return null;
  const segment = match[1].toLowerCase() as MeliNotificationResource;
  return allowedSegments.includes(segment) ? { segment, id: match[2] } : null;
}

/**
 * Resolve qualquer notificação relacionada a venda até o id canônico do
 * pedido. `payments` e `shipments` apontam para os próprios recursos, então
 * a ingestão segue esse recurso pela API oficial antes de buscar o pedido
 * autoritativo. `items` devolve `null` de propósito: mudança de anúncio é
 * registrada, mas não pode criar receita sem pedido.
 */
export async function resolveMercadoLivreNotificationOrderId(
  accessToken: string,
  topic: string,
  resource: string,
  config: MercadoLivreConfig = getMercadoLivreConfig()
): Promise<string | null> {
  const normalizedTopic = topic.trim().toLowerCase();
  if (normalizedTopic === 'orders' || normalizedTopic === 'orders_v2') {
    return resourceReference(resource, ['orders'])?.id ?? null;
  }
  if (normalizedTopic === 'items') return null;

  const reference =
    normalizedTopic === 'payments'
      ? resourceReference(resource, ['payments', 'collections'])
      : normalizedTopic === 'shipments'
        ? resourceReference(resource, ['shipments'])
        : null;
  if (!reference) return null;

  assertMercadoLivreAuthorization(accessToken);
  const url = new URL(`/${reference.segment}/${encodeURIComponent(reference.id)}`, config.apiBaseUrl);
  const { payload: raw } = await meliAuthorizedGet(
    url,
    accessToken,
    `Não foi possível resolver ${reference.segment}/${reference.id} do Mercado Livre.`
  );
  const payload = raw as MeliRelatedResourceResponse | undefined;
  const orderId = payload?.order?.id ?? payload?.order_id ?? payload?.orders?.[0]?.id;
  return orderId === undefined || orderId === null ? null : String(orderId);
}

/** Mapeia o status de um pedido da Meli para o ciclo de vida de `sales`. */
export function meliOrderStatusToSaleStatus(status: string): 'PAID' | 'PENDING' | 'CANCELLED' {
  switch (status) {
    case 'paid':
    case 'partially_paid':
    case 'shipped':
    case 'delivered':
      return 'PAID';
    case 'cancelled':
      return 'CANCELLED';
    default:
      // payment_required · payment_in_process · confirmed · …
      return 'PENDING';
  }
}

// ------------------------------------------------------------------
// Catálogo (anúncios do vendedor)
// ------------------------------------------------------------------

interface MeliItemSearchResponse {
  results?: string[];
}

interface MeliItemsBatchEntry {
  code?: number;
  body?: {
    id?: string;
    title?: string;
    permalink?: string;
    thumbnail?: string;
    price?: number;
    currency_id?: string;
    seller_custom_field?: string | null;
    sold_quantity?: number;
  };
}

/**
 * Lista os anúncios ativos do vendedor, normalizados no contrato do
 * framework. A guarda de autorização roda ANTES da primeira chamada de
 * rede: quem nunca completou o OAuth recebe a instrução "Conectar Conta
 * do Mercado Livre", não uma falha genérica de listagem.
 */
export async function fetchMercadoLivreItems(
  accessToken: string,
  userId: string,
  limit: number,
  config: MercadoLivreConfig = getMercadoLivreConfig()
): Promise<NormalizedContent[]> {
  assertMercadoLivreAuthorization(accessToken, userId);

  const searchUrl = new URL(`/users/${encodeURIComponent(userId)}/items/search`, config.apiBaseUrl);
  searchUrl.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 50)));
  searchUrl.searchParams.set('offset', '0');

  const { payload: searchRaw } = await meliAuthorizedGet(searchUrl, accessToken, 'Não foi possível listar os anúncios do Mercado Livre.');
  const ids = ((searchRaw as MeliItemSearchResponse | undefined)?.results ?? []).slice(0, 20);
  if (ids.length === 0) return [];

  const itemsUrl = new URL('/items', config.apiBaseUrl);
  itemsUrl.searchParams.set('ids', ids.join(','));
  const { payload: itemsRaw } = await meliAuthorizedGet(
    itemsUrl,
    accessToken,
    'Não foi possível obter os detalhes dos anúncios do Mercado Livre.'
  );
  if (!Array.isArray(itemsRaw)) {
    throw new ProviderApiError('Não foi possível obter os detalhes dos anúncios do Mercado Livre.', 502, PROVIDER);
  }

  return (itemsRaw as MeliItemsBatchEntry[])
    .filter((entry) => entry.code === 200 && entry.body?.id)
    .map((entry) => {
      const item = entry.body as NonNullable<MeliItemsBatchEntry['body']>;
      const content: NormalizedContent = {
        externalId: `meli:item:${userId}:${item.id}`,
        type: 'PRODUCT',
        title: item.title ?? `Anúncio ${item.id}`,
        url: item.permalink,
        thumbnailUrl: item.thumbnail,
        priceCents: toCents(item.price),
        currency: item.currency_id ?? 'BRL',
        sku: item.seller_custom_field?.trim() || undefined,
        raw: {
          provider: 'mercadolivre',
          userId,
          itemId: item.id,
          price: item.price,
          currency: item.currency_id,
          soldQuantity: item.sold_quantity,
        },
      };
      return content;
    });
}
