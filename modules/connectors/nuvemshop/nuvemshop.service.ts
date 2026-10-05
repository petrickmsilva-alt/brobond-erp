/**
 * Nuvemshop (Tiendanube) — API oficial, SOMENTE servidor.
 *
 * PLATAFORMA-PONTE DO HUB OMNICHANNEL (decisão da diretoria, 2026-10-05)
 * ----------------------------------------------------------------------
 * Os conectores nativos de Shopee e TikTok Shop foram REMOVIDOS do
 * ecossistema (barreiras burocráticas das APIs). A triangulação de vendas
 * — inclusive o catálogo exibido no TikTok — passa a acontecer pela
 * Nuvemshop: a loja é a fonte do pedido e este módulo a traz para
 * `sales`/`sale_items` como qualquer outro canal.
 *
 * OAuth2 (restrito ao grant `authorization_code`):
 *
 *   buildNuvemshopAuthorizationUrl() → https://www.nuvemshop.com.br/apps/<client_id>/authorize
 *   /api/connectors/nuvemshop/callback recebe (code, state) →
 *   exchangeNuvemshopCode() troca o código por um access token PERMANENTE.
 *
 * PARTICULARIDADES DA PLATAFORMA (documentadas, não suposições):
 *   • O token NÃO EXPIRA: só é invalidado quando um novo é emitido ou
 *     quando o lojista desinstala o app. Por isso não existe
 *     `refreshNuvemshopToken()` e `expiresAt` é sempre `null` — o mapa de
 *     rotação em `connector.service.ts` registra `NUVEMSHOP: null`.
 *   • O `user_id` devolvido junto com o token é o ID DA LOJA e é
 *     obrigatório em toda chamada à API — é ele que guardamos em
 *     `connectors.shop_id`.
 *   • O cabeçalho de autenticação é `Authentication: bearer <token>`
 *     (não `Authorization`), e um `User-Agent` identificando a aplicação
 *     é exigido pela plataforma.
 *   • O `redirect_uri` é fixo no Portal de Parceiros; `NUVEMSHOP_REDIRECT_URI`
 *     existe para que o ERP saiba (e exiba) exatamente qual URL foi
 *     cadastrada lá — é o valor que o callback precisa servir.
 *   • Webhook: HMAC-SHA256 HEX do CORPO CRU com o client secret, no
 *     cabeçalho `x-linkedstore-hmac-sha256`.
 */

import { ConnectorConfigError, ProviderApiError } from '../core/errors';
import { resolveStaticRedirectUri, type AppUrlEnv } from '../core/app-url';
import type { NormalizedContent } from '../core/connector.interface';
import { hmacSha256Hex } from '../core/crypto.service';
import { CONNECTOR_PROVIDER_SLUGS } from '../core/providers';

/** Base da API para lojas brasileiras (o espelho LATAM é api.tiendanube.com). */
export const NUVEMSHOP_API_BASE_URL = 'https://api.nuvemshop.com.br/v1';

/** Base de autorização/instalação do app (espelho LATAM: www.tiendanube.com). */
export const NUVEMSHOP_AUTH_BASE_URL = 'https://www.nuvemshop.com.br';

/** Identificação exigida pela plataforma em toda requisição. */
const NUVEMSHOP_DEFAULT_USER_AGENT = 'Brobond AI ERP (contato@brobond.com.br)';

const PROVIDER = 'NUVEMSHOP' as const;

/** A única ação que resolve toda falha de autorização deste canal. */
export const NUVEMSHOP_CONNECT_CTA = 'Conectar Loja da Nuvemshop';

/** Cabeçalho onde a Nuvemshop entrega a assinatura do webhook. */
export const NUVEMSHOP_WEBHOOK_SIGNATURE_HEADER = 'x-linkedstore-hmac-sha256';

export interface NuvemshopConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  authBaseUrl: string;
  userAgent: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConnectorConfigError(name, PROVIDER);
  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Config de servidor; o client secret nunca sai deste módulo. */
export function getNuvemshopConfig(): NuvemshopConfig {
  return {
    clientId: requiredEnv('NUVEMSHOP_CLIENT_ID'),
    clientSecret: requiredEnv('NUVEMSHOP_CLIENT_SECRET'),
    apiBaseUrl: normalizeBaseUrl(process.env.NUVEMSHOP_API_BASE_URL?.trim() || NUVEMSHOP_API_BASE_URL),
    authBaseUrl: normalizeBaseUrl(process.env.NUVEMSHOP_AUTH_BASE_URL?.trim() || NUVEMSHOP_AUTH_BASE_URL),
    userAgent: process.env.NUVEMSHOP_USER_AGENT?.trim() || NUVEMSHOP_DEFAULT_USER_AGENT,
  };
}

/** `true` quando as credenciais da aplicação estão no ambiente. */
export function hasNuvemshopCredentials(env: AppUrlEnv = process.env): boolean {
  return Boolean(env.NUVEMSHOP_CLIENT_ID?.trim() && env.NUVEMSHOP_CLIENT_SECRET?.trim());
}

/**
 * O `redirect_uri` da Nuvemshop é cadastrado no Portal de Parceiros
 * ("URL de redirecionamento"), então aqui ele é RESOLVIDO, não negociado:
 * `NUVEMSHOP_REDIRECT_URI` quando explícito, senão `APP_URL` + o caminho
 * canônico do callback. O override dinâmico do painel (origem validada do
 * host unificado) tem precedência pelo mesmo contrato dos demais canais.
 */
export function resolveNuvemshopRedirectUri(env: AppUrlEnv = process.env, override?: string | null): string {
  if (override && /^https?:\/\/[^/]+/i.test(override)) return override;
  return resolveStaticRedirectUri(['NUVEMSHOP_REDIRECT_URI'], CONNECTOR_PROVIDER_SLUGS.NUVEMSHOP, env);
}

/**
 * URL de instalação/autorização do app na loja do lojista.
 *
 * A Nuvemshop deriva os escopos da configuração do app no Portal de
 * Parceiros — a requisição carrega apenas o `state` CSRF de uso único.
 */
export function buildNuvemshopAuthorizationUrl(state: string, config: NuvemshopConfig = getNuvemshopConfig()): string {
  const clientId = encodeURIComponent(config.clientId.trim());
  const url = new URL(`/apps/${clientId}/authorize`, config.authBaseUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface NuvemshopTokenSet {
  accessToken: string;
  /** Id da loja (`user_id`) — obrigatório em toda chamada à API. */
  storeId: string;
  scope: string | null;
}

interface NuvemshopTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  user_id?: number | string;
  error?: string;
  error_description?: string;
}

/**
 * Troca o `code` de instalação (válido por 5 minutos) pelo access token
 * permanente. O corpo vai em JSON — a plataforma recusa os campos em query
 * string, e esse é o erro #1 de integração relatado na documentação.
 */
export async function exchangeNuvemshopCode(code: string, config: NuvemshopConfig = getNuvemshopConfig()): Promise<NuvemshopTokenSet> {
  const url = new URL('/apps/authorize/token', config.authBaseUrl);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': config.userAgent,
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
      }),
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a Nuvemshop.', 503, PROVIDER);
  }

  const rawBody = await response.text().catch(() => '');
  let payload: NuvemshopTokenResponse | undefined;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as NuvemshopTokenResponse) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok || !payload?.access_token || payload.user_id === undefined || payload.user_id === null) {
    // NUNCA logar corpo de resposta 2xx: mesmo incompleta, pode trazer um
    // access token vivo (e o da Nuvemshop é permanente).
    console.error('[nuvemshop.oauth.token] resposta rejeitada pela Nuvemshop', {
      status: response.status,
      statusText: response.statusText,
      rawBody: response.ok ? '[omitido: a resposta pode conter credenciais]' : rawBody,
    });
    const status = response.status || 502;
    throw new ProviderApiError(payload?.error_description || payload?.error || 'A Nuvemshop rejeitou a troca de token.', status, PROVIDER, {
      // Grant recusado nunca se conserta repetindo — só reinstalando o app.
      requiresReauth: status < 500 && status !== 429,
    });
  }

  return {
    accessToken: payload.access_token,
    storeId: String(payload.user_id),
    scope: payload.scope ?? null,
  };
}

// ------------------------------------------------------------------
// Chamadas autenticadas
// ------------------------------------------------------------------

/** `true` quando há material suficiente para chamar a API da loja. */
export function hasNuvemshopAuthorization(accessToken: string | null | undefined, storeId?: string | null): boolean {
  if (!accessToken || !accessToken.trim()) return false;
  if (storeId !== undefined && (!storeId || !String(storeId).trim())) return false;
  return true;
}

function assertNuvemshopAuthorization(accessToken: string | null | undefined, storeId?: string | null): void {
  if (!hasNuvemshopAuthorization(accessToken, storeId)) {
    throw new ProviderApiError(
      `A loja da Nuvemshop ainda não foi autorizada. Clique em "${NUVEMSHOP_CONNECT_CTA}" para liberar o acesso.`,
      401,
      PROVIDER,
      { requiresReauth: true }
    );
  }
}

async function nuvemshopGet(path: string, accessToken: string, config: NuvemshopConfig, context: string): Promise<unknown> {
  const url = new URL(`${config.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        // Contrato da plataforma: o cabeçalho é `Authentication`, não `Authorization`.
        authentication: `bearer ${accessToken}`,
        'user-agent': config.userAgent,
      },
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a Nuvemshop.', 503, PROVIDER);
  }
  if (!response.ok) {
    const status = response.status || 502;
    // 401/403 significam token revogado ou app desinstalado: o conserto é
    // reinstalar/reautorizar — nunca repetir.
    throw new ProviderApiError(context, status, PROVIDER, { requiresReauth: status === 401 || status === 403 });
  }
  return response.json().catch(() => undefined);
}

interface NuvemshopStoreResponse {
  id?: number | string;
  name?: Record<string, string> | string;
  url_with_protocol?: string;
  original_domain?: string;
}

/** Texto localizado da Nuvemshop (`{ "pt": "...", "es": "..." }`). */
function localized(value: Record<string, string> | string | undefined, fallback: string): string {
  if (typeof value === 'string') return value.trim() || fallback;
  if (value && typeof value === 'object') {
    const picked = value.pt ?? value.pt_BR ?? value.es ?? value.en ?? Object.values(value)[0];
    if (typeof picked === 'string' && picked.trim()) return picked.trim();
  }
  return fallback;
}

/** Dados públicos da loja autorizada (`GET /store`) — nada secreto. */
export async function fetchNuvemshopStore(
  accessToken: string,
  storeId: string,
  config: NuvemshopConfig = getNuvemshopConfig()
): Promise<{ storeId: string; storeName: string | null; storeUrl: string | null }> {
  assertNuvemshopAuthorization(accessToken, storeId);
  const payload = (await nuvemshopGet(
    `/${encodeURIComponent(storeId)}/store`,
    accessToken,
    config,
    'Não foi possível identificar a loja na Nuvemshop.'
  )) as NuvemshopStoreResponse | undefined;

  return {
    storeId,
    storeName: payload ? localized(payload.name, `Loja ${storeId}`) : null,
    storeUrl: payload?.url_with_protocol ?? (payload?.original_domain ? `https://${payload.original_domain}` : null),
  };
}

/** Converte um valor decimal (a Nuvemshop manda string) em centavos. */
function toCents(amount: number | string | null | undefined): number {
  const value = typeof amount === 'string' ? Number(amount.replace(',', '.')) : Number(amount ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

// ------------------------------------------------------------------
// Pedidos — ingestão de vendas por webhook
// ------------------------------------------------------------------

/** Item de um pedido da Nuvemshop, normalizado para `sale_items`. */
export interface NuvemshopOrderItem {
  sku: string | null;
  title: string;
  /** Nome literal da variante na loja ("M / Preto"). */
  variacaoExterna: string | null;
  quantity: number;
  unitPriceCents: number;
  /** Valor do tamanho declarado na variante, quando identificável. */
  sizeLabel: string | null;
}

export interface NuvemshopOrder {
  id: string;
  /** Número do pedido exibido ao lojista. */
  number: string | null;
  /** `open` · `closed` · `cancelled`. */
  status: string;
  /** `pending` · `authorized` · `paid` · `refunded` · `voided` · `abandoned`. */
  paymentStatus: string;
  totalAmountCents: number;
  currency: string;
  createdAt: Date;
  items: NuvemshopOrderItem[];
}

interface NuvemshopOrderProductResponse {
  name?: string;
  sku?: string | null;
  quantity?: number | string;
  price?: number | string;
  variant_values?: Array<string | null> | null;
}

interface NuvemshopOrderResponse {
  id?: number | string;
  number?: number | string;
  status?: string;
  payment_status?: string;
  total?: number | string;
  currency?: string;
  created_at?: string;
  paid_at?: string | null;
  products?: NuvemshopOrderProductResponse[];
}

/** Rótulos de variante que a Nuvemshop usa para tamanho em lojas pt-BR. */
const SIZE_VALUE_PATTERN = /^(PP|P|M|G|GG|XG|XGG|XS|S|L|XL|XXL|\d{2})$/i;

function mapOrderItem(entry: NuvemshopOrderProductResponse): NuvemshopOrderItem {
  const values = (entry.variant_values ?? []).filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  return {
    sku: entry.sku?.trim() || null,
    title: entry.name?.trim() || 'Produto da Nuvemshop',
    variacaoExterna: values.length ? values.join(' / ') : null,
    quantity: Math.max(1, Math.trunc(Number(entry.quantity ?? 1)) || 1),
    unitPriceCents: toCents(entry.price),
    sizeLabel: values.find((value) => SIZE_VALUE_PATTERN.test(value.trim()))?.trim() ?? null,
  };
}

/**
 * Busca um pedido (`GET /{store_id}/orders/{id}`) — o recurso apontado
 * pelos webhooks `order/*`, que chegam "magros" (store_id, event, id).
 */
export async function fetchNuvemshopOrder(
  accessToken: string,
  storeId: string,
  orderId: string,
  config: NuvemshopConfig = getNuvemshopConfig()
): Promise<NuvemshopOrder> {
  assertNuvemshopAuthorization(accessToken, storeId);
  const payload = (await nuvemshopGet(
    `/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}`,
    accessToken,
    config,
    `Não foi possível obter o pedido ${orderId} da Nuvemshop.`
  )) as NuvemshopOrderResponse | undefined;

  if (payload?.id === undefined || payload.id === null) {
    throw new ProviderApiError(`Não foi possível obter o pedido ${orderId} da Nuvemshop.`, 502, PROVIDER);
  }

  const items = (payload.products ?? []).map(mapOrderItem);
  return {
    id: String(payload.id),
    number: payload.number !== undefined && payload.number !== null ? String(payload.number) : null,
    status: payload.status ?? 'unknown',
    paymentStatus: payload.payment_status ?? 'pending',
    totalAmountCents: toCents(payload.total),
    currency: payload.currency ?? 'BRL',
    createdAt: payload.paid_at ? new Date(payload.paid_at) : payload.created_at ? new Date(payload.created_at) : new Date(),
    items,
  };
}

/**
 * Mapeia o par (status do pedido, status do pagamento) para o ciclo de
 * vida de `sales`. O cancelamento do pedido vence o pagamento: um pedido
 * cancelado não é receita, mesmo que tenha sido pago antes.
 */
export function nuvemshopOrderStatusToSaleStatus(status: string, paymentStatus: string): 'PAID' | 'PENDING' | 'REFUNDED' | 'CANCELLED' {
  if (status.trim().toLowerCase() === 'cancelled') return 'CANCELLED';
  switch (paymentStatus.trim().toLowerCase()) {
    case 'paid':
    case 'authorized':
      return 'PAID';
    case 'refunded':
    case 'partially_refunded':
      return 'REFUNDED';
    case 'voided':
    case 'abandoned':
      return 'CANCELLED';
    default:
      // pending · in_process · …
      return 'PENDING';
  }
}

// ------------------------------------------------------------------
// Catálogo (produtos da loja)
// ------------------------------------------------------------------

interface NuvemshopProductVariantResponse {
  id?: number | string;
  price?: number | string | null;
  sku?: string | null;
  stock?: number | null;
}

interface NuvemshopProductResponse {
  id?: number | string;
  name?: Record<string, string> | string;
  canonical_url?: string;
  images?: Array<{ src?: string }>;
  variants?: NuvemshopProductVariantResponse[];
  published?: boolean;
  created_at?: string;
}

/**
 * Lista os produtos da loja, normalizados no contrato do framework. É o
 * catálogo que a triangulação publica nos demais canais (inclusive a
 * vitrine do TikTok) — a guarda de autorização roda ANTES da rede.
 */
export async function fetchNuvemshopProducts(
  accessToken: string,
  storeId: string,
  limit: number,
  config: NuvemshopConfig = getNuvemshopConfig()
): Promise<NormalizedContent[]> {
  assertNuvemshopAuthorization(accessToken, storeId);

  const perPage = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const payload = await nuvemshopGet(
    `/${encodeURIComponent(storeId)}/products?per_page=${perPage}&page=1`,
    accessToken,
    config,
    'Não foi possível listar os produtos da Nuvemshop.'
  );

  if (!Array.isArray(payload)) {
    throw new ProviderApiError('Não foi possível listar os produtos da Nuvemshop.', 502, PROVIDER);
  }

  return (payload as NuvemshopProductResponse[])
    .filter((product) => product.id !== undefined && product.id !== null)
    .map((product) => {
      const variant = product.variants?.[0];
      const title = localized(product.name, `Produto ${product.id}`);
      const content: NormalizedContent = {
        externalId: `nuvemshop:product:${storeId}:${product.id}`,
        type: 'PRODUCT',
        title,
        url: product.canonical_url,
        thumbnailUrl: product.images?.[0]?.src,
        priceCents: toCents(variant?.price),
        currency: 'BRL',
        sku: variant?.sku?.trim() || undefined,
        publishedAt: product.created_at ? new Date(product.created_at) : undefined,
        raw: {
          provider: 'nuvemshop',
          storeId,
          productId: product.id,
          published: product.published ?? null,
          variants: product.variants?.length ?? 0,
        },
      };
      return content;
    });
}

// ------------------------------------------------------------------
// Webhooks
// ------------------------------------------------------------------

/**
 * Verifica a assinatura de um webhook da Nuvemshop: HMAC-SHA256 HEX do
 * CORPO CRU com o client secret do app, entregue em
 * `x-linkedstore-hmac-sha256`.
 *
 * NUNCA lança: assinatura ausente, malformada ou de tamanho diferente é
 * simplesmente `false` — quem decide o 401 é o tratador.
 */
export function verifyNuvemshopWebhookSignature(rawBody: string, signature: string | null | undefined): boolean {
  const presented = (signature ?? '').trim().toLowerCase();
  if (!presented) return false;
  const clientSecret = process.env.NUVEMSHOP_CLIENT_SECRET?.trim();
  if (!clientSecret) return false;
  const expected = hmacSha256Hex(clientSecret, rawBody);
  if (expected.length !== presented.length) return false;
  // Comparação sem vazar tamanho/posição do primeiro byte divergente.
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return diff === 0;
}
