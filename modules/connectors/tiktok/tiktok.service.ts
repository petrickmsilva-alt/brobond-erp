/**
 * TikTok Shop — OAuth do vendedor e Open API oficial, somente servidor.
 *
 * IMPORTANTE: TikTok Login Kit (developers.tiktok.com) autentica um perfil
 * social e NÃO concede acesso a pedidos/produtos da TikTok Shop. Este módulo
 * usa as credenciais do Shop Partner Center: SERVICE_ID, APP_KEY e APP_SECRET.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorConfigError, ProviderApiError } from '../core/errors';
import { resolveStaticRedirectUri, type AppUrlEnv } from '../core/app-url';
import type { NormalizedContent } from '../core/connector.interface';
import { CONNECTOR_PROVIDER_SLUGS } from '../core/providers';

const PROVIDER = 'TIKTOK' as const;
export const TIKTOK_SHOP_AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize';
export const TIKTOK_SHOP_TOKEN_BASE_URL = 'https://auth.tiktok-shops.com';
export const TIKTOK_SHOP_API_BASE_URL = 'https://open-api.tiktokglobalshop.com';

function read(name: string, env: AppUrlEnv = process.env): string | undefined {
  const value = env[name];
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function requiredEnv(name: string): string {
  const value = read(name);
  if (!value) throw new ConnectorConfigError(name, PROVIDER);
  return value;
}

export interface TikTokShopOAuthConfig {
  readonly serviceId: string;
  readonly appKey: string;
  readonly appSecret: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  readonly tokenBaseUrl: string;
}

export function resolveTikTokRedirectUri(env: AppUrlEnv = process.env): string {
  return resolveStaticRedirectUri(['TIKTOK_REDIRECT_URI'], CONNECTOR_PROVIDER_SLUGS.TIKTOK, env);
}

export function getTikTokShopOAuthConfig(): TikTokShopOAuthConfig {
  return {
    serviceId: requiredEnv('TIKTOK_SERVICE_ID'),
    appKey: requiredEnv('TIKTOK_APP_KEY'),
    appSecret: requiredEnv('TIKTOK_APP_SECRET'),
    redirectUri: resolveTikTokRedirectUri(),
    authorizeUrl: read('TIKTOK_AUTHORIZATION_URL') ?? TIKTOK_SHOP_AUTHORIZE_URL,
    tokenBaseUrl: read('TIKTOK_TOKEN_BASE_URL') ?? TIKTOK_SHOP_TOKEN_BASE_URL,
  };
}

/** Compatibilidade nominal: agora significa credenciais OAuth da TikTok Shop. */
export function hasTikTokLoginCredentials(env: AppUrlEnv = process.env): boolean {
  return hasTikTokShopCredentials(env);
}

export function hasTikTokShopCredentials(env: AppUrlEnv = process.env): boolean {
  return Boolean(read('TIKTOK_SERVICE_ID', env) && read('TIKTOK_APP_KEY', env) && read('TIKTOK_APP_SECRET', env));
}

export function isTikTokSandboxMode(env: AppUrlEnv = process.env): boolean {
  const flag = (read('TIKTOK_SANDBOX', env) ?? read('TIKTOK_SANDBOX_MODE', env) ?? '').toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled', 'sandbox'].includes(flag);
}

export interface TikTokTokenSet {
  accessToken: string;
  refreshToken: string | null;
  openId: string | null;
  scope: string;
  expiresAt: Date;
  refreshExpiresAt: Date | null;
}

interface TikTokShopTokenData {
  access_token?: unknown;
  refresh_token?: unknown;
  access_token_expire_in?: unknown;
  refresh_token_expire_in?: unknown;
  open_id?: unknown;
  seller_name?: unknown;
  granted_scopes?: unknown;
}
interface TikTokShopTokenResponse extends TikTokShopTokenData {
  code?: number;
  message?: string;
  data?: TikTokShopTokenData;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Aceita tanto TTL em segundos quanto timestamp Unix retornado por versões da API. */
function expirationDate(value: unknown, fallbackSeconds: number): Date {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return new Date(Date.now() + fallbackSeconds * 1000);
  return parsed > 1_000_000_000 ? new Date(parsed * 1000) : new Date(Date.now() + parsed * 1000);
}

/** URL oficial de autorização de vendedor da TikTok Shop. */
export function buildTikTokAuthorizationUrl(state: string, config: TikTokShopOAuthConfig = getTikTokShopOAuthConfig()): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('service_id', config.serviceId);
  // O callback continua protegido pelo state de uso único do ERP.
  url.searchParams.set('state', state);
  return url.toString();
}

async function tiktokShopTokenRequest(
  operation: 'get' | 'refresh',
  params: Record<string, string>,
  config: TikTokShopOAuthConfig = getTikTokShopOAuthConfig()
): Promise<TikTokTokenSet> {
  const url = new URL(`/api/v2/token/${operation}`, config.tokenBaseUrl);
  url.search = new URLSearchParams({ app_key: config.appKey, app_secret: config.appSecret, ...params }).toString();
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a TikTok Shop.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as TikTokShopTokenResponse | undefined;
  const data = payload?.data ?? payload;
  const accessToken = asNonEmptyString(data?.access_token);
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0) || !accessToken) {
    const status = response.status || 502;
    throw new ProviderApiError(payload?.message || 'A TikTok Shop rejeitou a troca do código de autorização.', status, PROVIDER, {
      requiresReauth: status < 500 && status !== 429,
    });
  }
  const scopes = Array.isArray(data?.granted_scopes)
    ? data.granted_scopes.filter((v): v is string => typeof v === 'string').join(',')
    : asNonEmptyString(data?.granted_scopes) ?? '';
  return {
    accessToken,
    refreshToken: asNonEmptyString(data?.refresh_token),
    openId: asNonEmptyString(data?.open_id),
    scope: scopes,
    expiresAt: expirationDate(data?.access_token_expire_in, 24 * 3600),
    refreshExpiresAt: data?.refresh_token_expire_in ? expirationDate(data.refresh_token_expire_in, 365 * 24 * 3600) : null,
  };
}

export async function exchangeTikTokCode(code: string, config: TikTokShopOAuthConfig = getTikTokShopOAuthConfig()): Promise<TikTokTokenSet> {
  return tiktokShopTokenRequest('get', { auth_code: code, grant_type: 'authorized_code' }, config);
}

export async function refreshTikTokToken(
  refreshToken: string,
  config: TikTokShopOAuthConfig = getTikTokShopOAuthConfig()
): Promise<TikTokTokenSet> {
  return tiktokShopTokenRequest('refresh', { refresh_token: refreshToken, grant_type: 'refresh_token' }, config);
}

// ------------------------------------------------------------------
// TikTok Shop — assinatura das chamadas de vendedor
// ------------------------------------------------------------------

/**
 * Assinatura oficial do TikTok Shop:
 *   base = path + (params ordenados, concatenados chave+valor, sem
 *          `sign` nem `access_token`) + body
 *   sign = HMAC-SHA256(app_secret, app_secret + base + app_secret)
 */
export function signTikTokShopRequest(path: string, params: Record<string, string>, body: string, appSecret: string): string {
  const ordered = Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'access_token')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  const base = `${appSecret}${path}${ordered}${body}${appSecret}`;
  return createHmac('sha256', appSecret).update(base, 'utf8').digest('hex');
}

interface TikTokShopRequestOptions {
  accessToken: string;
  shopCipher?: string | null;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  method?: 'GET' | 'POST';
}

async function tiktokShopRequest<T>(path: string, options: TikTokShopRequestOptions): Promise<T> {
  const appKey = requiredEnv('TIKTOK_APP_KEY');
  const appSecret = requiredEnv('TIKTOK_APP_SECRET');
  const baseUrl = read('TIKTOK_API_BASE_URL') ?? TIKTOK_SHOP_API_BASE_URL;
  const body = options.body ? JSON.stringify(options.body) : '';
  const params: Record<string, string> = {
    app_key: appKey,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(options.shopCipher ? { shop_cipher: options.shopCipher } : {}),
    ...(options.query ?? {}),
  };
  params.sign = signTikTokShopRequest(path, params, body, appSecret);

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'x-tts-access-token': options.accessToken,
      },
      ...(body ? { body } : {}),
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o TikTok Shop.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as { code?: number; message?: string; data?: T } | undefined;
  if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
    const status = response.status || 502;
    throw new ProviderApiError(payload?.message || 'O TikTok Shop rejeitou a requisição.', status, PROVIDER, {
      requiresReauth: status === 401 || status === 403,
    });
  }
  return (payload?.data ?? ({} as T)) as T;
}

/** Loja autorizada e seu `shop_cipher`, obrigatório nas APIs de catálogo/pedido. */
export async function fetchTikTokAuthorizedShop(accessToken: string): Promise<{ shopCipher: string; shopName: string | null }> {
  const data = await tiktokShopRequest<{
    shops?: Array<{ cipher?: string; id?: string; name?: string; shop_name?: string }>;
  }>('/authorization/202309/shops', { accessToken });
  const shop = data.shops?.find((candidate) => candidate.cipher);
  if (!shop?.cipher) {
    throw new ProviderApiError(
      'A autorização não retornou uma loja TikTok Shop. Confirme se a conta é vendedora e se o app possui o escopo Shop Authorized Information.',
      502,
      PROVIDER
    );
  }
  return { shopCipher: shop.cipher, shopName: shop.name ?? shop.shop_name ?? null };
}

// ------------------------------------------------------------------
// Pedidos do TikTok Shop
// ------------------------------------------------------------------

export interface TikTokOrderItem {
  sku: string | null;
  title: string;
  variacaoExterna: string | null;
  sizeLabel: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface TikTokOrder {
  id: string;
  /** UNPAID · AWAITING_SHIPMENT · IN_TRANSIT · DELIVERED · COMPLETED · CANCELLED */
  status: string;
  totalAmountCents: number;
  currency: string;
  createdAt: Date;
  items: TikTokOrderItem[];
}

interface TikTokOrderDetailData {
  orders?: Array<{
    id?: string;
    status?: string;
    create_time?: number;
    payment?: { total_amount?: string; currency?: string };
    line_items?: Array<{
      seller_sku?: string;
      sku_name?: string;
      product_name?: string;
      sale_price?: string;
      currency?: string;
    }>;
  }>;
}

function centsFromDecimalString(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 100);
}

/**
 * Detalhe de um pedido (`/order/202309/orders`) — o recurso referenciado
 * pelas notificações `ORDER_STATUS_CHANGE` do Shop Partner Center.
 *
 * Cada `line_item` do TikTok é UMA peça: o agrupamento por SKU devolve a
 * quantidade real por variação, que é o que `sale_items` espera.
 */
export async function fetchTikTokOrder(accessToken: string, orderId: string, shopCipher?: string | null): Promise<TikTokOrder> {
  const data = await tiktokShopRequest<TikTokOrderDetailData>('/order/202309/orders', {
    accessToken,
    shopCipher,
    query: { ids: orderId },
  });
  const order = data.orders?.[0];
  if (!order?.id) {
    throw new ProviderApiError(`Não foi possível obter o pedido ${orderId} do TikTok Shop.`, 502, PROVIDER);
  }

  const grouped = new Map<string, TikTokOrderItem>();
  for (const line of order.line_items ?? []) {
    const key = `${line.seller_sku ?? ''}|${line.sku_name ?? ''}|${line.product_name ?? ''}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += 1;
      continue;
    }
    grouped.set(key, {
      sku: line.seller_sku?.trim() || null,
      title: line.product_name?.trim() || 'Item TikTok Shop',
      variacaoExterna: line.sku_name?.trim() || null,
      sizeLabel: line.sku_name?.split(/[,/|-]/)[0]?.trim() || null,
      quantity: 1,
      unitPriceCents: centsFromDecimalString(line.sale_price),
    });
  }

  return {
    id: order.id,
    status: order.status ?? 'UNKNOWN',
    totalAmountCents: centsFromDecimalString(order.payment?.total_amount),
    currency: order.payment?.currency ?? 'BRL',
    createdAt: order.create_time ? new Date(order.create_time * 1000) : new Date(),
    items: [...grouped.values()],
  };
}

/** Mapeia o status de um pedido TikTok para o ciclo de vida de `sales`. */
export function tiktokOrderStatusToSaleStatus(status: string): 'PAID' | 'PENDING' | 'REFUNDED' | 'CANCELLED' {
  switch (status.toUpperCase()) {
    case 'AWAITING_SHIPMENT':
    case 'AWAITING_COLLECTION':
    case 'PARTIALLY_SHIPPING':
    case 'IN_TRANSIT':
    case 'DELIVERED':
    case 'COMPLETED':
      return 'PAID';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      // UNPAID · ON_HOLD · …
      return 'PENDING';
  }
}

interface TikTokProductSearchData {
  products?: Array<{
    id?: string;
    title?: string;
    status?: string;
    skus?: Array<{ seller_sku?: string; price?: { sale_price?: string; currency?: string } }>;
    main_images?: Array<{ urls?: string[] }>;
  }>;
}

/** Catálogo ativo da loja, normalizado no contrato do framework. */
export async function fetchTikTokProducts(accessToken: string, limit: number, shopCipher?: string | null): Promise<NormalizedContent[]> {
  const data = await tiktokShopRequest<TikTokProductSearchData>('/product/202312/products/search', {
    accessToken,
    shopCipher,
    method: 'POST',
    query: { page_size: String(Math.min(Math.max(limit, 1), 50)) },
    body: { status: 'ACTIVATE' },
  });
  return (data.products ?? [])
    .filter((product) => product.id)
    .map((product) => {
      const sku = product.skus?.[0];
      const content: NormalizedContent = {
        externalId: `tiktok:product:${product.id}`,
        type: 'PRODUCT',
        title: product.title?.trim() || `Produto ${product.id}`,
        thumbnailUrl: product.main_images?.[0]?.urls?.[0],
        sku: sku?.seller_sku?.trim() || undefined,
        priceCents: centsFromDecimalString(sku?.price?.sale_price),
        currency: sku?.price?.currency ?? 'BRL',
        raw: { provider: 'tiktok', productId: product.id, status: product.status },
      };
      return content;
    });
}

// ------------------------------------------------------------------
// Webhook
// ------------------------------------------------------------------

/**
 * O TikTok Shop assina os webhooks com HMAC-SHA256 em hex minúsculo
 * sobre os BYTES CRUS da requisição prefixados pelo `app_key`. É
 * deliberadamente diferente da assinatura das chamadas de saída.
 */
export function computeTikTokWebhookSignature(rawBody: string | Buffer, appKey: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(appKey, 'utf8').update(rawBody).digest('hex');
}

export function verifyTikTokWebhookSignature(input: {
  rawBody: string | Buffer;
  signature: string | null | undefined;
  appKey?: string;
  appSecret?: string;
}): boolean {
  const appKey = input.appKey ?? process.env.TIKTOK_APP_KEY;
  const appSecret = input.appSecret ?? process.env.TIKTOK_APP_SECRET;
  const actual = input.signature?.trim().toLowerCase();
  if (!appKey || !appSecret || !actual || !/^[a-f0-9]{64}$/.test(actual)) return false;
  const expected = computeTikTokWebhookSignature(input.rawBody, appKey, appSecret);
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
