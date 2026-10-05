/**
 * Shopee Open Platform v2 — API oficial de parceiro, SOMENTE servidor.
 *
 * Fonte: `modules/marketplace/shopee/shopee.service.ts` do
 * brobond-ai-commerce (PR012), acrescido do detalhe de pedido usado pela
 * ingestão de vendas do ERP.
 *
 * Esquema de assinatura documentado (HMAC-SHA256):
 *   baseString = partner_id + path + timestamp [+ access_token + shop_id]
 *   sign       = HMAC-SHA256(partner_key, baseString)
 *
 * Fluxo: buildShopeeAuthorizationUrl() → o vendedor autoriza →
 * /api/connectors/shopee/callback recebe (code, shop_id) →
 * exchangeShopeeCode() grava os tokens cifrados em `connectors`.
 *
 * CSRF: o redirecionamento de autorização da Shopee NÃO carrega `state`.
 * A amarração com o responsável do ERP é feita pelo `state` que o ERP
 * injeta na própria `redirect` (ver `connector.service.ts`) — e, na falta
 * dele, o callback é recusado.
 */

import { timingSafeEqual } from 'node:crypto';
import { ConnectorConfigError, ProviderApiError } from '../core/errors';
import { hmacSha256Hex } from '../core/crypto.service';
import { resolveStaticRedirectUri, type AppUrlEnv } from '../core/app-url';
import type { NormalizedContent } from '../core/connector.interface';
import { CONNECTOR_PROVIDER_SLUGS } from '../core/providers';

const SHOPEE_API_BASE_URL = 'https://partner.shopeemobile.com';
const PROVIDER = 'SHOPEE' as const;

export interface ShopeeConfig {
  partnerId: number;
  partnerKey: string;
  apiBaseUrl: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConnectorConfigError(name, PROVIDER);
  return value;
}

/** Config de servidor; a partner key nunca sai deste módulo. */
export function getShopeeConfig(): ShopeeConfig {
  const partnerIdRaw = requiredEnv('SHOPEE_PARTNER_ID');
  const partnerId = Number(partnerIdRaw);
  if (!Number.isInteger(partnerId) || partnerId <= 0) {
    throw new ConnectorConfigError('SHOPEE_PARTNER_ID', PROVIDER);
  }
  return {
    partnerId,
    partnerKey: requiredEnv('SHOPEE_PARTNER_KEY'),
    apiBaseUrl: process.env.SHOPEE_API_BASE_URL?.trim() || SHOPEE_API_BASE_URL,
  };
}

/** `true` quando as credenciais da aplicação estão no ambiente. */
export function hasShopeeCredentials(env: AppUrlEnv = process.env): boolean {
  return Boolean(env.SHOPEE_PARTNER_ID?.trim() && env.SHOPEE_PARTNER_KEY?.trim());
}

/**
 * O `redirect` apresentado à Shopee — ESTÁTICO, só do ambiente
 * (`SHOPEE_REDIRECT_URI` ou `APP_URL` + o caminho canônico). Precisa
 * bater byte a byte com o callback cadastrado no Partner Center.
 */
export function getShopeeRedirectUri(env: AppUrlEnv = process.env): string {
  return resolveStaticRedirectUri(['SHOPEE_REDIRECT_URI'], CONNECTOR_PROVIDER_SLUGS.SHOPEE, env);
}

/**
 * Assinatura oficial v2. `accessToken` e `shopId` entram na base string
 * APENAS em chamadas autenticadas (nunca nas URLs de autorização).
 */
export function shopeeSign(
  config: ShopeeConfig,
  path: string,
  timestamp: number,
  extras: { accessToken?: string; shopId?: string | number } = {}
): string {
  const baseString =
    `${config.partnerId}${path}${timestamp}` + (extras.accessToken ?? '') + (extras.shopId !== undefined ? String(extras.shopId) : '');
  return hmacSha256Hex(config.partnerKey, baseString);
}

/**
 * URL de autorização do vendedor (Open Platform v2).
 *
 * O `state` do ERP viaja dentro do próprio `redirect` como query string:
 * a Shopee devolve a URL inteira, então é assim que o callback público
 * descobre a qual responsável a loja pertence sem depender de sessão.
 */
export function buildShopeeAuthorizationUrl(state: string, config: ShopeeConfig = getShopeeConfig()): string {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(path, config.apiBaseUrl);
  const redirect = new URL(getShopeeRedirectUri());
  redirect.searchParams.set('state', state);
  url.searchParams.set('partner_id', String(config.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', shopeeSign(config, path, timestamp));
  url.searchParams.set('redirect', redirect.toString());
  return url.toString();
}

export interface ShopeeTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

interface ShopeeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  error?: string;
  message?: string;
}

async function shopeePost<T extends Record<string, unknown>>(
  config: ShopeeConfig,
  path: string,
  body: Record<string, unknown>,
  extras: { accessToken?: string; shopId?: string | number } = {}
): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(path, config.apiBaseUrl);
  url.searchParams.set('partner_id', String(config.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', shopeeSign(config, path, timestamp, extras));
  if (extras.accessToken) url.searchParams.set('access_token', extras.accessToken);
  if (extras.shopId !== undefined) url.searchParams.set('shop_id', String(extras.shopId));

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a Shopee Open Platform.', 503, PROVIDER);
  }
  // Nunca propagar payload cru do provedor — pode trazer dado do vendedor.
  const payload = (await response.json().catch(() => undefined)) as (T & { error?: string; message?: string }) | undefined;
  if (!response.ok || (payload && typeof payload.error === 'string' && payload.error !== '')) {
    const status = response.status || 502;
    throw new ProviderApiError(payload?.message || 'A Shopee Open Platform rejeitou a requisição.', status, PROVIDER, {
      requiresReauth: status === 401 || status === 403,
    });
  }
  return payload as T;
}

async function shopeeGet<T extends Record<string, unknown>>(
  config: ShopeeConfig,
  path: string,
  params: Record<string, string>,
  extras: { accessToken: string; shopId: string }
): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(path, config.apiBaseUrl);
  url.searchParams.set('partner_id', String(config.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('access_token', extras.accessToken);
  url.searchParams.set('shop_id', extras.shopId);
  url.searchParams.set('sign', shopeeSign(config, path, timestamp, extras));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a Shopee Open Platform.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as (T & { error?: string; message?: string }) | undefined;
  if (!response.ok || (payload && typeof payload.error === 'string' && payload.error !== '')) {
    const status = response.status || 502;
    throw new ProviderApiError(payload?.message || 'A Shopee Open Platform rejeitou a requisição.', status, PROVIDER, {
      requiresReauth: status === 401 || status === 403,
    });
  }
  return payload as T;
}

/** Troca o `code` de autorização pelo par de tokens da loja. */
export async function exchangeShopeeCode(code: string, shopId: string, config: ShopeeConfig = getShopeeConfig()): Promise<ShopeeTokenSet> {
  const data = await shopeePost<ShopeeTokenResponse & Record<string, unknown>>(config, '/api/v2/auth/token/get', {
    code,
    shop_id: Number(shopId),
    partner_id: config.partnerId,
  });
  if (!data.access_token || !data.refresh_token || !data.expire_in) {
    throw new ProviderApiError('A Shopee não retornou um par de tokens válido.', 502, PROVIDER);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expire_in * 1000),
  };
}

/** Rotaciona um access token vencido (endpoint oficial de refresh). */
export async function refreshShopeeToken(
  refreshToken: string,
  shopId: string,
  config: ShopeeConfig = getShopeeConfig()
): Promise<ShopeeTokenSet> {
  const data = await shopeePost<ShopeeTokenResponse & Record<string, unknown>>(config, '/api/v2/auth/access_token/get', {
    refresh_token: refreshToken,
    shop_id: Number(shopId),
    partner_id: config.partnerId,
  });
  if (!data.access_token || !data.refresh_token || !data.expire_in) {
    throw new ProviderApiError('A Shopee não renovou o token de acesso.', 502, PROVIDER);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expire_in * 1000),
  };
}

/** Nome da loja — identidade não secreta gravada no conector. */
export async function fetchShopeeShopInfo(
  accessToken: string,
  shopId: string,
  config: ShopeeConfig = getShopeeConfig()
): Promise<{ shopName: string | null }> {
  try {
    const payload = await shopeeGet<{ shop_name?: string } & Record<string, unknown>>(
      config,
      '/api/v2/shop/get_shop_info',
      {},
      { accessToken, shopId }
    );
    return { shopName: typeof payload.shop_name === 'string' ? payload.shop_name : null };
  } catch {
    // O nome é cosmético: nunca derruba uma conexão recém-autorizada.
    return { shopName: null };
  }
}

// ------------------------------------------------------------------
// Catálogo
// ------------------------------------------------------------------

interface ShopeeItemListResponse extends Record<string, unknown> {
  response?: { item?: Array<{ item_id?: number }> };
}

interface ShopeeItemBaseInfoResponse extends Record<string, unknown> {
  response?: {
    item_list?: Array<{
      item_id?: number;
      item_name?: string;
      item_sku?: string;
      description?: string;
      image?: { image_url_list?: string[] };
      price_info?: Array<{ current_price?: number; currency?: string }>;
    }>;
  };
}

/** Catálogo ativo da loja, normalizado no contrato do framework. */
export async function fetchShopeeProducts(
  accessToken: string,
  shopId: string,
  limit: number,
  config: ShopeeConfig = getShopeeConfig()
): Promise<NormalizedContent[]> {
  const pageSize = Math.min(Math.max(limit, 1), 50);
  const list = await shopeeGet<ShopeeItemListResponse>(
    config,
    '/api/v2/product/get_item_list',
    { offset: '0', page_size: String(pageSize), item_status: 'NORMAL' },
    { accessToken, shopId }
  );
  const ids = (list.response?.item ?? []).map((item) => item.item_id).filter((id): id is number => typeof id === 'number');
  if (ids.length === 0) return [];

  const details = await shopeeGet<ShopeeItemBaseInfoResponse>(
    config,
    '/api/v2/product/get_item_base_info',
    { item_id_list: ids.join(',') },
    { accessToken, shopId }
  );

  return (details.response?.item_list ?? [])
    .filter((item) => item.item_id !== undefined)
    .map((item) => {
      const price = item.price_info?.[0];
      const content: NormalizedContent = {
        externalId: `shopee:item:${shopId}:${item.item_id}`,
        type: 'PRODUCT',
        title: item.item_name?.trim() || `Produto ${item.item_id}`,
        thumbnailUrl: item.image?.image_url_list?.[0],
        caption: item.description?.slice(0, 2000),
        sku: item.item_sku?.trim() || undefined,
        priceCents: price?.current_price ? Math.round(Number(price.current_price) * 100) : undefined,
        currency: price?.currency ?? 'BRL',
        raw: { provider: 'shopee', shopId, itemId: item.item_id },
      };
      return content;
    });
}

// ------------------------------------------------------------------
// Pedidos — ingestão de vendas por webhook
// ------------------------------------------------------------------

export interface ShopeeOrderItem {
  sku: string | null;
  title: string;
  variacaoExterna: string | null;
  sizeLabel: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface ShopeeOrder {
  orderSn: string;
  /** UNPAID · READY_TO_SHIP · SHIPPED · COMPLETED · CANCELLED · … */
  status: string;
  totalAmountCents: number;
  currency: string;
  createdAt: Date;
  items: ShopeeOrderItem[];
}

interface ShopeeOrderDetailResponse extends Record<string, unknown> {
  response?: {
    order_list?: Array<{
      order_sn?: string;
      order_status?: string;
      total_amount?: number;
      currency?: string;
      create_time?: number;
      item_list?: Array<{
        item_name?: string;
        item_sku?: string;
        model_name?: string;
        model_sku?: string;
        model_quantity_purchased?: number;
        model_discounted_price?: number;
        model_original_price?: number;
      }>;
    }>;
  };
}

/**
 * Detalhe de um pedido (`/api/v2/order/get_order_detail`) — o recurso
 * referenciado pelos pushes de código 3 (order status) da Shopee.
 */
export async function fetchShopeeOrder(
  accessToken: string,
  shopId: string,
  orderSn: string,
  config: ShopeeConfig = getShopeeConfig()
): Promise<ShopeeOrder> {
  const payload = await shopeeGet<ShopeeOrderDetailResponse>(
    config,
    '/api/v2/order/get_order_detail',
    {
      order_sn_list: orderSn,
      response_optional_fields: 'item_list,total_amount,order_status,create_time,currency',
    },
    { accessToken, shopId }
  );
  const order = payload.response?.order_list?.[0];
  if (!order?.order_sn) {
    throw new ProviderApiError(`Não foi possível obter o pedido ${orderSn} da Shopee.`, 502, PROVIDER);
  }
  const items: ShopeeOrderItem[] = (order.item_list ?? []).map((item) => ({
    sku: item.model_sku?.trim() || item.item_sku?.trim() || null,
    title: item.item_name?.trim() || 'Item Shopee',
    variacaoExterna: item.model_name?.trim() || null,
    // A Shopee traz a variação como texto livre ("M, Preto"): o primeiro
    // segmento é o tamanho na esmagadora maioria das grades de vestuário.
    sizeLabel: item.model_name?.split(/[,/|-]/)[0]?.trim() || null,
    quantity: Math.max(1, Math.trunc(Number(item.model_quantity_purchased ?? 1)) || 1),
    unitPriceCents: Math.round(Number(item.model_discounted_price ?? item.model_original_price ?? 0) * 100),
  }));
  return {
    orderSn: order.order_sn,
    status: order.order_status ?? 'UNKNOWN',
    totalAmountCents: Math.round(Number(order.total_amount ?? 0) * 100),
    currency: order.currency ?? 'BRL',
    createdAt: order.create_time ? new Date(order.create_time * 1000) : new Date(),
    items,
  };
}

/** Mapeia o status de um pedido Shopee para o ciclo de vida de `sales`. */
export function shopeeOrderStatusToSaleStatus(status: string): 'PAID' | 'PENDING' | 'REFUNDED' | 'CANCELLED' {
  switch (status.toUpperCase()) {
    case 'READY_TO_SHIP':
    case 'PROCESSED':
    case 'SHIPPED':
    case 'TO_CONFIRM_RECEIVE':
    case 'COMPLETED':
      return 'PAID';
    case 'CANCELLED':
    case 'INVOICE_PENDING':
      return 'CANCELLED';
    case 'IN_CANCEL':
    case 'TO_RETURN':
      return 'REFUNDED';
    default:
      // UNPAID · READY_TO_FULFIL · …
      return 'PENDING';
  }
}

// ------------------------------------------------------------------
// Webhook
// ------------------------------------------------------------------

function safeEqualHex(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Assinatura oficial do push da Shopee:
 *   HMAC-SHA256(partner_key, webhook_url + raw_body) no cabeçalho
 *   `authorization`.
 *
 * A URL precisa ser EXATAMENTE a cadastrada no Partner Center — por isso
 * ela é recebida pronta pelo chamador (a rota monta a partir do `APP_URL`
 * estático, nunca do `Host` da requisição).
 */
export function verifyShopeeWebhookSignature(
  rawBody: string,
  webhookUrl: string,
  signature: string | null | undefined,
  partnerKey = process.env.SHOPEE_PARTNER_KEY?.trim()
): boolean {
  const received = signature?.trim().toLowerCase();
  if (!partnerKey || !received || !/^[a-f0-9]{64}$/.test(received)) return false;
  const expected = hmacSha256Hex(partnerKey, `${webhookUrl}|${rawBody}`);
  const legacyExpected = hmacSha256Hex(partnerKey, `${webhookUrl}${rawBody}`);
  return safeEqualHex(received, expected) || safeEqualHex(received, legacyExpected);
}
