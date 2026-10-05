/**
 * TikTok — Login Kit v2 (OAuth do usuário) + TikTok Shop Partner Center
 * (API do vendedor), SOMENTE servidor.
 *
 * Fonte: `modules/connectors/tiktok/**` + `modules/marketplace/tiktok/
 * tiktok-bridge.service.ts` do brobond-ai-commerce (PR009/PR012/PR017),
 * consolidados em um único serviço porque no ERP os dois lados gravam na
 * MESMA linha de `connectors` (provedor TIKTOK) — não há mais a tabela
 * `TikTokAccount` separada do commerce.
 *
 * Dois conjuntos de credenciais, de propósito:
 *   • `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` — Login Kit v2, o fluxo
 *     OAuth que conecta a conta (escopo `user.info.stats`);
 *   • `TIKTOK_APP_KEY`/`TIKTOK_APP_SECRET` — app vendedora do Shop
 *     Partner Center, usada para assinar as chamadas de pedido e para
 *     verificar a assinatura dos webhooks. Enquanto a aprovação comercial
 *     não sai, o conector fica `PENDING_APPROVAL` — isso é estado
 *     operacional esperado, NUNCA falha de servidor.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorConfigError, ProviderApiError } from '../core/errors';
import { resolveStaticRedirectUri, type AppUrlEnv } from '../core/app-url';
import type { NormalizedContent } from '../core/connector.interface';
import { CONNECTOR_PROVIDER_SLUGS } from '../core/providers';

const PROVIDER = 'TIKTOK' as const;

/** Host de consentimento padrão (família tiktok.com). */
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
/** Host de token padrão (família tiktokapis.com). */
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
/** Host da API do Login Kit (metadados de usuário). */
export const TIKTOK_LOGIN_API_BASE_URL = 'https://open.tiktokapis.com';
/** Host da API do TikTok Shop (pedidos, produtos). */
export const TIKTOK_SHOP_API_BASE_URL = 'https://open-api.tiktokglobalshop.com';
/** Escopo exatamente igual ao salvo no painel de desenvolvedores. */
export const TIKTOK_DEFAULT_SCOPE = 'user.info.stats';

function read(name: string, env: AppUrlEnv = process.env): string | undefined {
  const value = env[name];
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredEnv(name: string): string {
  const value = read(name);
  if (!value) throw new ConnectorConfigError(name, PROVIDER);
  return value;
}

export interface TikTokLoginConfig {
  readonly clientKey: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
}

/**
 * O `redirect_uri` do Login Kit — ESTÁTICO. O TikTok compara o valor byte
 * a byte entre a autorização e a troca do código; uma barra final a mais
 * já é outro callback registrado.
 */
export function resolveTikTokRedirectUri(env: AppUrlEnv = process.env): string {
  return resolveStaticRedirectUri(['TIKTOK_REDIRECT_URI'], CONNECTOR_PROVIDER_SLUGS.TIKTOK, env);
}

export function getTikTokLoginConfig(): TikTokLoginConfig {
  return {
    clientKey: requiredEnv('TIKTOK_CLIENT_KEY'),
    clientSecret: requiredEnv('TIKTOK_CLIENT_SECRET'),
    redirectUri: resolveTikTokRedirectUri(),
    scope: read('TIKTOK_SCOPES') ?? TIKTOK_DEFAULT_SCOPE,
    authorizeUrl: read('TIKTOK_AUTH_BASE_URL') ? `${read('TIKTOK_AUTH_BASE_URL')}/v2/auth/authorize/` : TIKTOK_AUTHORIZE_URL,
    tokenUrl: TIKTOK_TOKEN_URL,
  };
}

/** `true` quando as duas credenciais do Login Kit estão no ambiente. */
export function hasTikTokLoginCredentials(env: AppUrlEnv = process.env): boolean {
  return Boolean(read('TIKTOK_CLIENT_KEY', env) && read('TIKTOK_CLIENT_SECRET', env));
}

/** `true` quando a app vendedora do Shop Partner Center está configurada. */
export function hasTikTokShopCredentials(env: AppUrlEnv = process.env): boolean {
  return Boolean(read('TIKTOK_APP_KEY', env) && read('TIKTOK_APP_SECRET', env));
}

/**
 * Sandbox do TikTok Developers: plenamente funcional e NUNCA uma falha.
 * O conector fica `SANDBOX_ACTIVE` para o painel mostrar o estado real.
 */
export function isTikTokSandboxMode(env: AppUrlEnv = process.env): boolean {
  const clientKey = (read('TIKTOK_CLIENT_KEY', env) ?? '').toLowerCase();
  if (!clientKey) return false;
  const flag = (read('TIKTOK_SANDBOX', env) ?? read('TIKTOK_SANDBOX_MODE', env) ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', 'sandbox'].includes(flag)) return true;
  const sandboxClientKey = (read('TIKTOK_SANDBOX_CLIENT_KEY', env) ?? '').toLowerCase();
  if (sandboxClientKey && clientKey === sandboxClientKey) return true;
  return clientKey.startsWith('sb') || clientKey.includes('sandbox');
}

// ------------------------------------------------------------------
// OAuth (Login Kit v2)
// ------------------------------------------------------------------

export interface TikTokTokenSet {
  accessToken: string;
  refreshToken: string | null;
  openId: string | null;
  scope: string;
  expiresAt: Date;
  refreshExpiresAt: Date | null;
}

interface TikTokRawTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  open_id?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  refresh_expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function toPositiveSeconds(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** URL de consentimento do Login Kit v2 (com o state CSRF do ERP). */
export function buildTikTokAuthorizationUrl(state: string, config: TikTokLoginConfig = getTikTokLoginConfig()): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_key', config.clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function tiktokTokenRequest(config: TikTokLoginConfig, form: Record<string, string>): Promise<TikTokTokenSet> {
  const body = new URLSearchParams({
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    ...form,
  });

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o TikTok.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as TikTokRawTokenPayload | undefined;
  const accessToken = asNonEmptyString(payload?.access_token);
  const expiresIn = toPositiveSeconds(payload?.expires_in);
  if (!response.ok || !accessToken || !expiresIn) {
    const status = response.status || 502;
    throw new ProviderApiError(
      asNonEmptyString(payload?.error_description) ?? asNonEmptyString(payload?.error) ?? 'O TikTok rejeitou a troca de token.',
      status,
      PROVIDER,
      { requiresReauth: status < 500 && status !== 429 }
    );
  }
  const refreshExpiresIn = toPositiveSeconds(payload?.refresh_expires_in);
  return {
    accessToken,
    refreshToken: asNonEmptyString(payload?.refresh_token),
    openId: asNonEmptyString(payload?.open_id),
    scope: asNonEmptyString(payload?.scope) ?? config.scope,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    refreshExpiresAt: refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : null,
  };
}

/** Troca o `code` de autorização por tokens (Login Kit v2). */
export async function exchangeTikTokCode(code: string, config: TikTokLoginConfig = getTikTokLoginConfig()): Promise<TikTokTokenSet> {
  return tiktokTokenRequest(config, {
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  });
}

/**
 * Rotaciona o access token (vive 24h; o refresh token, 365 dias). Sem
 * este caminho, toda conta conectada há mais de um dia caía em EXPIRED e
 * o painel pedia uma reautorização inútil a cada "Sincronizar".
 */
export async function refreshTikTokToken(
  refreshToken: string,
  config: TikTokLoginConfig = getTikTokLoginConfig()
): Promise<TikTokTokenSet> {
  return tiktokTokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

interface TikTokUserInfoResponse {
  data?: { user?: { open_id?: string; display_name?: string; username?: string } };
  error?: { code?: string; message?: string };
}

/** Identidade do titular da conta — dado não secreto gravado no conector. */
export async function fetchTikTokIdentity(accessToken: string): Promise<{ openId: string | null; displayName: string | null }> {
  const url = new URL('/v2/user/info/', TIKTOK_LOGIN_API_BASE_URL);
  url.searchParams.set('fields', 'open_id,display_name,username');
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o TikTok.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as TikTokUserInfoResponse | undefined;
  if (!response.ok) {
    // A identidade é complementar: um erro aqui não invalida o token que
    // o provedor acabou de emitir.
    return { openId: null, displayName: null };
  }
  const user = payload?.data?.user;
  return {
    openId: user?.open_id ?? null,
    displayName: user?.display_name ?? user?.username ?? null,
  };
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
