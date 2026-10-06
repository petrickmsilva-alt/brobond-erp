/**
 * Instagram Shopping (Meta Graph API) — cliente oficial, SOMENTE servidor.
 *
 * ESTE ARQUIVO É ISOLADO: não importa nada de `mercadolivre/`,
 * `mercadopago/` ou `nuvemshop/`. Só depende dos primitivos de `core/`
 * (erros, cifra, URLs) — os mesmos que qualquer canal usa. Trocar,
 * desligar ou remover o Instagram não toca em uma linha dos outros
 * conectores.
 *
 * ──────────────────────────────────────────────────────────────────────
 * O QUE A API DA META REALMENTE ENTREGA (verificado em 2026-10-06)
 * ──────────────────────────────────────────────────────────────────────
 * O objeto de webhook `instagram` da Graph API v26.0 expõe EXATAMENTE
 * estes campos (developers.facebook.com/docs/graph-api/webhooks/reference/instagram):
 *
 *     comments · live_comments · mentions · messages · message_edit ·
 *     message_reactions · messaging_handover · messaging_postbacks ·
 *     messaging_referral · messaging_seen · standby · story_insights
 *
 * NÃO EXISTE campo de pedido, compra, carrinho ou "sacolinha". A única
 * API que já devolveu pedido de Instagram/Facebook Shops foi a
 * **Commerce Order Management API**, e ela foi SEPULTADA:
 *
 *   • 2025-09 — a Meta descontinuou o checkout nativo (pagamento,
 *     gestão de pedido e pós-venda voltaram para o site do lojista);
 *   • 2026-07-29 — 47 endpoints de Commerce Order Management foram
 *     bloqueados na v26.0, SEM API substituta;
 *   • 2026-10-27 — o bloqueio se estende a TODAS as versões suportadas.
 *
 * E no Brasil o checkout nativo NUNCA existiu: a sacolinha sempre levou
 * o comprador para o site do lojista, então o pedido nasce no checkout
 * do site (na nossa operação, a plataforma-ponte), não na Meta.
 *
 * CONSEQUÊNCIA DE PROJETO (e o motivo de este arquivo não fingir nada):
 *   • o que chega da Meta é INTERAÇÃO (comentário, menção, DM, clique em
 *     referral de produto) — vira evento na caixa de entrada do painel,
 *     com `topic` fiel ao campo recebido;
 *   • o caminho de RECEITA (`mapInstagramOrderPayload`) é estritamente
 *     dirigido por payload: só devolve rascunho de venda quando o corpo
 *     recebido traz pedido de verdade (id, itens, total, moeda). Para
 *     todo webhook que a Meta emite hoje ele devolve `null` — nenhuma
 *     venda é inventada, nenhum número é estimado;
 *   • o catálogo é real e consultável: a API de Product Tagging
 *     (`available_catalogs` + `catalog_product_search`) continua viva e
 *     é ela que alimenta "Conteúdo importado desta plataforma".
 */

import { timingSafeEqual } from 'node:crypto';
import { resolveStaticRedirectUri, type AppUrlEnv } from '../core/app-url';
import type { NormalizedContent } from '../core/connector.interface';
import { hmacSha256Hex } from '../core/crypto.service';
import { ConnectorConfigError, ProviderApiError } from '../core/errors';
import type { SaleStatusName } from '../core/providers';
import type { JsonObject } from '../core/types';

const PROVIDER = 'INSTAGRAM' as const;

/** Versão da Graph API usada em TODAS as chamadas (v26.0 — 2026-07-29). */
export const INSTAGRAM_GRAPH_VERSION = 'v26.0';

/** Base da Graph API da Meta. */
export const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.facebook.com';

/** Base do diálogo de consentimento (Facebook Login for Business). */
export const INSTAGRAM_AUTH_BASE_URL = 'https://www.facebook.com';

/** Cabeçalho onde a Meta entrega a assinatura do webhook. */
export const INSTAGRAM_WEBHOOK_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Prefixo obrigatório da assinatura (`sha256=<hex>`). */
const SIGNATURE_PREFIX = 'sha256=';

/** A única ação que resolve qualquer falha de autorização deste canal. */
export const INSTAGRAM_CONNECT_CTA = 'Conectar Conta Comercial do Instagram';

/**
 * Permissões pedidas no consentimento. São as que a conta comercial
 * precisa conceder para que o ERP leia o perfil, a caixa de interações
 * e o catálogo de Shopping.
 */
export const INSTAGRAM_OAUTH_SCOPES = [
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'instagram_shopping_tag_products',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
] as const;

/**
 * Campos de webhook assinados no app da Meta. É a lista REAL do objeto
 * `instagram` — não há campo de pedido para assinar.
 */
export const INSTAGRAM_WEBHOOK_FIELDS = [
  'comments',
  'live_comments',
  'mentions',
  'messages',
  'message_reactions',
  'messaging_postbacks',
  'messaging_referral',
  'story_insights',
] as const;

export type InstagramWebhookField = (typeof INSTAGRAM_WEBHOOK_FIELDS)[number];

// ------------------------------------------------------------------
// Configuração
// ------------------------------------------------------------------

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  /** Token combinado com a Meta no cadastro do webhook (`hub.verify_token`). */
  verifyToken: string;
  graphBaseUrl: string;
  authBaseUrl: string;
  graphVersion: string;
}

function requiredEnv(name: string, env: AppUrlEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) throw new ConnectorConfigError(name, PROVIDER);
  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Config de servidor. O app secret NUNCA sai deste módulo. */
export function getInstagramConfig(env: AppUrlEnv = process.env): InstagramConfig {
  return {
    appId: requiredEnv('INSTAGRAM_APP_ID', env),
    appSecret: requiredEnv('INSTAGRAM_APP_SECRET', env),
    verifyToken: env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim() ?? '',
    graphBaseUrl: normalizeBaseUrl(env.INSTAGRAM_GRAPH_BASE_URL?.trim() || INSTAGRAM_GRAPH_BASE_URL),
    authBaseUrl: normalizeBaseUrl(env.INSTAGRAM_AUTH_BASE_URL?.trim() || INSTAGRAM_AUTH_BASE_URL),
    graphVersion: env.INSTAGRAM_GRAPH_VERSION?.trim() || INSTAGRAM_GRAPH_VERSION,
  };
}

/** `true` quando as credenciais do app da Meta estão no ambiente. */
export function hasInstagramCredentials(env: AppUrlEnv = process.env): boolean {
  return Boolean(env.INSTAGRAM_APP_ID?.trim() && env.INSTAGRAM_APP_SECRET?.trim());
}

/**
 * `redirect_uri` do consentimento. A Meta exige que a URI esteja na
 * lista branca do app ("Valid OAuth Redirect URIs"), então o valor é
 * RESOLVIDO — `INSTAGRAM_REDIRECT_URI` quando explícito, senão
 * `APP_URL` + o caminho canônico do callback. O override dinâmico do
 * painel (origem validada) tem precedência, pelo mesmo contrato dos
 * demais canais.
 */
export function resolveInstagramRedirectUri(env: AppUrlEnv = process.env, override?: string | null): string {
  if (override && /^https?:\/\/[^/]+/i.test(override)) return override;
  return resolveStaticRedirectUri(['INSTAGRAM_REDIRECT_URI'], 'instagram', env);
}

function graphUrl(path: string, config: InstagramConfig): URL {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return new URL(`${config.graphBaseUrl}/${config.graphVersion}${suffix}`);
}

// ------------------------------------------------------------------
// OAuth 2.0 (Facebook Login for Business)
// ------------------------------------------------------------------

/**
 * URL de consentimento. O `state` é o CSRF de uso único emitido pelo
 * serviço de conectores; o `redirect_uri` precisa bater BYTE A BYTE com
 * o usado na troca do código (contrato da Meta, igual ao dos demais).
 */
export function buildInstagramAuthorizationUrl(
  state: string,
  config: InstagramConfig = getInstagramConfig(),
  redirectUri: string = resolveInstagramRedirectUri()
): string {
  const url = new URL(`/${config.graphVersion}/dialog/oauth`, config.authBaseUrl);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', INSTAGRAM_OAUTH_SCOPES.join(','));
  return url.toString();
}

export interface InstagramTokenSet {
  accessToken: string;
  /** `null` quando a Meta não devolve validade (token de página). */
  expiresAt: Date | null;
}

interface MetaTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  error?: { message?: string; type?: string; code?: number };
}

function expiresAtFrom(expiresIn: number | string | undefined): Date | null {
  const seconds = Number(expiresIn ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}

async function readTokenResponse(response: Response, context: string): Promise<MetaTokenResponse> {
  const rawBody = await response.text().catch(() => '');
  let payload: MetaTokenResponse | undefined;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as MetaTokenResponse) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok || !payload?.access_token) {
    // Resposta 2xx pode conter um token vivo — nunca cai no log.
    console.error('[instagram.oauth.token] resposta rejeitada pela Meta', {
      status: response.status,
      statusText: response.statusText,
      rawBody: response.ok ? '[omitido: a resposta pode conter credenciais]' : rawBody,
    });
    const status = response.status || 502;
    throw new ProviderApiError(payload?.error?.message || context, status, PROVIDER, {
      // Grant recusado não se conserta repetindo: só reautorizando.
      requiresReauth: status < 500 && status !== 429,
    });
  }
  return payload;
}

/** Troca o `code` do consentimento pelo token de curta duração (1h). */
export async function exchangeInstagramCode(
  code: string,
  redirectUri: string,
  config: InstagramConfig = getInstagramConfig()
): Promise<InstagramTokenSet> {
  const url = graphUrl('/oauth/access_token', config);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a Graph API da Meta.', 503, PROVIDER);
  }
  const payload = await readTokenResponse(response, 'A Meta rejeitou a troca do código de autorização.');
  return { accessToken: payload.access_token as string, expiresAt: expiresAtFrom(payload.expires_in) };
}

/**
 * Converte o token curto em LONGO (60 dias). O mesmo grant
 * (`fb_exchange_token`) renova um token longo que ainda esteja válido —
 * é por isso que o mapa de rotação do serviço de conectores aponta para
 * esta função.
 */
export async function exchangeInstagramLongLivedToken(
  token: string,
  config: InstagramConfig = getInstagramConfig()
): Promise<InstagramTokenSet> {
  const url = graphUrl('/oauth/access_token', config);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('fb_exchange_token', token);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a Graph API da Meta.', 503, PROVIDER);
  }
  const payload = await readTokenResponse(response, 'A Meta rejeitou a conversão para token de longa duração.');
  return { accessToken: payload.access_token as string, expiresAt: expiresAtFrom(payload.expires_in) };
}

// ------------------------------------------------------------------
// Chamadas autenticadas
// ------------------------------------------------------------------

export function hasInstagramAuthorization(accessToken: string | null | undefined, igUserId?: string | null): boolean {
  if (!accessToken || !accessToken.trim()) return false;
  if (igUserId !== undefined && (!igUserId || !String(igUserId).trim())) return false;
  return true;
}

function assertInstagramAuthorization(accessToken: string | null | undefined, igUserId?: string | null): void {
  if (!hasInstagramAuthorization(accessToken, igUserId)) {
    throw new ProviderApiError(
      `A conta comercial do Instagram ainda não foi autorizada. Clique em "${INSTAGRAM_CONNECT_CTA}" para liberar o acesso.`,
      401,
      PROVIDER,
      { requiresReauth: true }
    );
  }
}

interface MetaErrorEnvelope {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

async function instagramGet(path: string, accessToken: string, config: InstagramConfig, context: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = graphUrl(path, config);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('access_token', accessToken);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar a Graph API da Meta.', 503, PROVIDER);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const status = response.status || 502;
    const envelope = (body ?? {}) as MetaErrorEnvelope;
    // 190 = token inválido/expirado; 10/200 = permissão ausente. Nos três
    // casos o conserto é reautorizar a conta, nunca repetir a chamada.
    const code = Number(envelope.error?.code ?? 0);
    throw new ProviderApiError(envelope.error?.message || context, status, PROVIDER, {
      requiresReauth: status === 401 || status === 403 || code === 190 || code === 10 || code === 200,
    });
  }
  return body;
}

export interface InstagramBusinessAccount {
  /** ID da conta profissional do Instagram — é o `shop_id` do conector. */
  igUserId: string;
  username: string | null;
  name: string | null;
  /** Página do Facebook vinculada (a assinatura do webhook mora nela). */
  pageId: string | null;
  pageName: string | null;
}

interface MetaAccountsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    instagram_business_account?: { id?: string; username?: string; name?: string };
  }>;
}

/**
 * Descobre a conta comercial do Instagram ligada às páginas do usuário
 * autorizado (`GET /me/accounts`). É a identidade que amarra todo
 * webhook de entrada a um operador do ERP.
 */
export async function fetchInstagramBusinessAccount(
  accessToken: string,
  config: InstagramConfig = getInstagramConfig()
): Promise<InstagramBusinessAccount> {
  assertInstagramAuthorization(accessToken);
  const payload = (await instagramGet('/me/accounts', accessToken, config, 'Não foi possível identificar a conta comercial do Instagram.', {
    fields: 'id,name,instagram_business_account{id,username,name}',
    limit: '50',
  })) as MetaAccountsResponse | undefined;

  const page = (payload?.data ?? []).find((entry) => entry.instagram_business_account?.id);
  const igUserId = page?.instagram_business_account?.id;
  if (!igUserId) {
    throw new ProviderApiError(
      'Nenhuma conta comercial do Instagram está vinculada às páginas autorizadas. Vincule a conta no Meta Business e tente de novo.',
      409,
      PROVIDER,
      { requiresReauth: true }
    );
  }
  return {
    igUserId: String(igUserId),
    username: page?.instagram_business_account?.username?.trim() || null,
    name: page?.instagram_business_account?.name?.trim() || page?.name?.trim() || null,
    pageId: page?.id ? String(page.id) : null,
    pageName: page?.name?.trim() || null,
  };
}

// ------------------------------------------------------------------
// Catálogo — API de Product Tagging (viva e suportada)
// ------------------------------------------------------------------

interface MetaCatalogsResponse {
  data?: Array<{ catalog_id?: string; catalog_name?: string; shopping_tags_enabled?: boolean }>;
}

interface MetaCatalogProductsResponse {
  data?: Array<{
    product_id?: number | string;
    product_name?: string;
    retailer_id?: string;
    image_url?: string;
    review_status?: string;
    is_checkout_flow?: boolean;
    merchant_id?: number | string;
  }>;
}

/**
 * Produtos do catálogo de Shopping da conta
 * (`available_catalogs` → `catalog_product_search`).
 *
 * A Meta NÃO devolve preço nesse recurso, então `priceCents` fica
 * ausente de propósito: melhor um campo vazio do que um número chutado
 * no painel do Diretor.
 */
export async function fetchInstagramCatalogProducts(
  accessToken: string,
  igUserId: string,
  limit: number,
  config: InstagramConfig = getInstagramConfig()
): Promise<NormalizedContent[]> {
  assertInstagramAuthorization(accessToken, igUserId);
  const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);

  const catalogs = (await instagramGet(
    `/${encodeURIComponent(igUserId)}/available_catalogs`,
    accessToken,
    config,
    'Não foi possível listar os catálogos disponíveis para a conta do Instagram.'
  )) as MetaCatalogsResponse | undefined;

  const catalogId = catalogs?.data?.find((entry) => entry.catalog_id)?.catalog_id;
  if (!catalogId) {
    throw new ProviderApiError(
      'A conta comercial não tem catálogo de Instagram Shopping aprovado. Habilite a sacolinha no Commerce Manager para sincronizar o catálogo.',
      409,
      PROVIDER
    );
  }

  const products = (await instagramGet(
    `/${encodeURIComponent(igUserId)}/catalog_product_search`,
    accessToken,
    config,
    'Não foi possível listar os produtos do catálogo do Instagram.',
    { catalog_id: String(catalogId), limit: String(take) }
  )) as MetaCatalogProductsResponse | undefined;

  return (products?.data ?? [])
    .filter((product) => product.product_id !== undefined && product.product_id !== null)
    .map((product) => {
      const content: NormalizedContent = {
        externalId: `instagram:product:${igUserId}:${String(product.product_id)}`,
        type: 'PRODUCT',
        title: product.product_name?.trim() || `Produto ${String(product.product_id)}`,
        thumbnailUrl: product.image_url,
        sku: product.retailer_id?.trim() || undefined,
        currency: 'BRL',
        raw: {
          provider: 'instagram',
          igUserId,
          catalogId: String(catalogId),
          productId: String(product.product_id),
          reviewStatus: product.review_status ?? null,
          // Informa se o produto está no fluxo de checkout da Meta — no
          // Brasil é sempre falso (a compra acontece no site do lojista).
          isCheckoutFlow: product.is_checkout_flow ?? false,
        },
      };
      return content;
    });
}

// ------------------------------------------------------------------
// Webhook — handshake de verificação
// ------------------------------------------------------------------

export interface InstagramChallengeQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
  [key: string]: string | undefined;
}

/**
 * Handshake `GET` do cadastro do webhook: a Meta chama a URL com
 * `hub.mode=subscribe`, o `hub.verify_token` combinado e um
 * `hub.challenge` aleatório, e exige o challenge de volta em TEXTO PURO.
 *
 * Devolve `null` quando o token não confere (a rota responde 403) ou
 * quando `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` não está no ambiente — sem
 * segredo configurado ninguém consegue registrar o endpoint.
 */
export function verifyInstagramWebhookChallenge(query: InstagramChallengeQuery, env: AppUrlEnv = process.env): string | null {
  const mode = (query['hub.mode'] ?? '').trim();
  const presented = (query['hub.verify_token'] ?? '').trim();
  const challenge = (query['hub.challenge'] ?? '').trim();
  const expected = env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim() ?? '';
  if (mode !== 'subscribe' || !challenge || !expected || !presented) return null;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge;
}

/**
 * Assinatura do webhook: HMAC-SHA256 HEX do CORPO CRU com o APP SECRET,
 * entregue como `sha256=<hex>` em `x-hub-signature-256`.
 *
 * NUNCA lança: ausência, formato errado ou tamanho diferente é `false` —
 * quem decide o 401 é o tratador.
 */
export function verifyInstagramWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  env: AppUrlEnv = process.env
): boolean {
  const presented = (signature ?? '').trim().toLowerCase();
  if (!presented.startsWith(SIGNATURE_PREFIX)) return false;
  const appSecret = env.INSTAGRAM_APP_SECRET?.trim();
  if (!appSecret) return false;
  const digest = presented.slice(SIGNATURE_PREFIX.length);
  const expected = hmacSha256Hex(appSecret, rawBody);
  if (expected.length !== digest.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ digest.charCodeAt(index);
  }
  return diff === 0;
}

// ------------------------------------------------------------------
// Webhook — normalização do payload
// ------------------------------------------------------------------

/** Evento já normalizado a partir de UMA entrada do corpo da Meta. */
export interface InstagramWebhookEvent {
  /** Chave de deduplicação (`UNIQUE (usuario_id, provider, …)`). */
  externalEventId: string;
  /** Campo da Meta: `comments`, `messages`, `messaging_referral`, … */
  topic: string;
  /** Conta comercial do Instagram — resolve o dono do evento. */
  igUserId: string;
  /** Momento declarado pela Meta, quando houver. */
  occurredAt: Date;
  payload: JsonObject;
}

function asRecord(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out : null;
}

/** `entry.time` da Meta vem em SEGUNDOS; `timestamp` de DM, em ms. */
function metaTime(entryTime: unknown, fallback: Date): Date {
  const seconds = Number(entryTime ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  const millis = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/**
 * Identificador estável de uma entrega. A Meta não manda um "event id",
 * então ele é derivado dos campos que a própria entrega carrega (conta,
 * campo, id do recurso e instante). Reentrega do mesmo evento produz a
 * MESMA chave e é descartada pela unicidade de `connector_events`.
 */
function buildEventId(igUserId: string, topic: string, resourceId: string | null, occurredAt: Date): string {
  const resource = resourceId ?? String(Math.trunc(occurredAt.getTime() / 1000));
  return `instagram:${topic}:${igUserId}:${resource}`;
}

/** Id do recurso dentro do `value` de um `changes[]`. */
function changeResourceId(value: JsonObject): string | null {
  return (
    text(value.id) ??
    text(value.comment_id) ??
    text(value.media_id) ??
    text(asRecord(value.media).id) ??
    text(value.order_id) ??
    text(value.merchant_order_id) ??
    null
  );
}

/**
 * Converte o corpo bruto do webhook da Meta na lista de eventos
 * normalizados. Aceita as DUAS formas do objeto `instagram`:
 *
 *   • `entry[].changes[]`   — comentários, menções, insights de story;
 *   • `entry[].messaging[]` — mensagens diretas, reações, referrals de
 *     produto (o clique na sacolinha que abre a DM).
 *
 * Corpo de outro objeto (`page`, `whatsapp_business_account`, …) devolve
 * lista vazia: o endpoint do Instagram não processa o que não é dele.
 */
export function parseInstagramWebhookPayload(body: JsonObject, now: Date = new Date()): InstagramWebhookEvent[] {
  const object = text(body.object);
  if (object && object !== 'instagram') return [];

  const events: InstagramWebhookEvent[] = [];
  for (const rawEntry of asArray(body.entry)) {
    const entry = asRecord(rawEntry);
    const entryTime = metaTime(entry.time, now);
    const entryId = text(entry.id);

    for (const rawChange of asArray(entry.changes)) {
      const change = asRecord(rawChange);
      const field = text(change.field);
      if (!field) continue;
      const value = asRecord(change.value);
      const igUserId = entryId ?? text(value.recipient_id) ?? text(asRecord(value.recipient).id);
      if (!igUserId) continue;
      events.push({
        externalEventId: buildEventId(igUserId, field, changeResourceId(value), entryTime),
        topic: field,
        igUserId,
        occurredAt: entryTime,
        payload: { object: 'instagram', field, value, entry_id: igUserId, entry_time: entry.time ?? null },
      });
    }

    for (const rawMessaging of asArray(entry.messaging)) {
      const messaging = asRecord(rawMessaging);
      const recipientId = text(asRecord(messaging.recipient).id);
      const igUserId = recipientId ?? entryId;
      if (!igUserId) continue;
      const occurredAt = metaTime(messaging.timestamp, entryTime);
      // O campo é inferido pela forma da entrega — a Meta só nomeia o
      // campo em `changes[]`, nunca em `messaging[]`.
      const topic = messaging.reaction
        ? 'message_reactions'
        : messaging.postback
          ? 'messaging_postbacks'
          : messaging.referral
            ? 'messaging_referral'
            : messaging.read
              ? 'messaging_seen'
              : 'messages';
      const resourceId =
        text(asRecord(messaging.message).mid) ??
        text(asRecord(messaging.reaction).mid) ??
        text(asRecord(messaging.postback).mid) ??
        text(asRecord(messaging.sender).id);
      events.push({
        externalEventId: buildEventId(igUserId, topic, resourceId, occurredAt),
        topic,
        igUserId,
        occurredAt,
        payload: { object: 'instagram', field: topic, value: messaging, entry_id: igUserId, entry_time: entry.time ?? null },
      });
    }
  }
  return events;
}

// ------------------------------------------------------------------
// Pedido — caminho de RECEITA, estritamente dirigido por payload
// ------------------------------------------------------------------

/**
 * Tópicos que PODEM carregar pedido. A lista existe por simetria com os
 * demais canais e para que o motor financeiro só olhe para entregas de
 * comércio — nenhum webhook do objeto `instagram` usa estes nomes hoje
 * (ver o cabeçalho deste arquivo).
 */
export const INSTAGRAM_SALE_TOPICS = ['orders', 'commerce_orders', 'order_status_update'] as const;

export function isInstagramSaleTopic(topic: string | null): boolean {
  if (!topic) return false;
  return (INSTAGRAM_SALE_TOPICS as readonly string[]).includes(topic.trim().toLowerCase());
}

/** Item de pedido do Instagram, normalizado para `sale_items`. */
export interface InstagramOrderItem {
  /** `retailer_id` do catálogo = SKU do ERP. */
  sku: string | null;
  title: string;
  variacaoExterna: string | null;
  sizeLabel: string | null;
  quantity: number;
  unitPriceCents: number;
}

/** Pedido do Instagram, normalizado para `sales`. */
export interface InstagramOrder {
  id: string;
  status: SaleStatusName;
  totalAmountCents: number;
  currency: string;
  occurredAt: Date;
  items: InstagramOrderItem[];
}

/** Estados de pedido da Meta → ciclo de vida de `sales`. */
export function instagramOrderStatusToSaleStatus(status: string | null | undefined): SaleStatusName {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'CREATED':
    case 'FB_PROCESSING':
    case 'IN_PROGRESS':
    case 'PENDING':
      return 'PENDING';
    case 'COMPLETED':
    case 'SHIPPED':
    case 'PAID':
      return 'PAID';
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'REFUNDED';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

/** Preço da Meta chega como `{ amount: "199.90", currency: "BRL" }`. */
function moneyToCents(value: unknown): number {
  const record = asRecord(value);
  const raw = record.amount !== undefined ? record.amount : value;
  const amount = typeof raw === 'string' ? Number(raw.replace(',', '.')) : Number(raw ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
}

function moneyCurrency(value: unknown, fallback: string): string {
  const currency = text(asRecord(value).currency);
  return currency ? currency.toUpperCase() : fallback;
}

/** Rótulos de tamanho usados pelo catálogo pt-BR. */
const SIZE_VALUE_PATTERN = /^(PP|P|M|G|GG|XG|XGG|XS|S|L|XL|XXL|\d{2})$/i;

function mapOrderItem(raw: unknown): InstagramOrderItem | null {
  const entry = asRecord(raw);
  const product = asRecord(entry.product);
  const sku = text(entry.retailer_id) ?? text(product.retailer_id) ?? text(entry.sku);
  const title = text(entry.product_name) ?? text(product.name) ?? text(entry.name) ?? (sku ? `Produto ${sku}` : null);
  const quantity = Math.max(1, Math.trunc(Number(entry.quantity ?? 1)) || 1);
  const unitPriceCents = moneyToCents(entry.price_per_unit ?? entry.unit_price ?? entry.price);
  if (!title && !sku) return null;
  const variacao = text(entry.variant) ?? text(product.variant) ?? null;
  return {
    sku,
    title: title ?? 'Produto do Instagram Shopping',
    variacaoExterna: variacao,
    sizeLabel: variacao && SIZE_VALUE_PATTERN.test(variacao) ? variacao : null,
    quantity,
    unitPriceCents,
  };
}

/**
 * Converte um payload de PEDIDO da Meta no rascunho de venda do ERP.
 *
 * REGRA DURA: só devolve pedido quando o corpo traz o pedido INTEIRO —
 * identificador externo e pelo menos um item com quantidade. Qualquer
 * outra coisa (comentário, DM, menção, clique na sacolinha, payload
 * vazio) devolve `null` e NADA é gravado em `sales`. O painel do canal
 * prefere mostrar zero a mostrar um número que a Meta não mandou.
 */
export function mapInstagramOrderPayload(payload: JsonObject): InstagramOrder | null {
  const value = asRecord(payload.value);
  const order = Object.keys(asRecord(value.order)).length ? asRecord(value.order) : Object.keys(value).length ? value : payload;

  const id = text(order.id) ?? text(order.order_id) ?? text(order.merchant_order_id);
  if (!id) return null;

  const items = asArray(order.items ?? asRecord(order.items).data)
    .map(mapOrderItem)
    .filter((item): item is InstagramOrderItem => item !== null);
  if (!items.length) return null;

  const currency = moneyCurrency(order.order_total ?? order.total ?? order.estimated_payment_details, 'BRL');
  const declaredTotal = moneyToCents(order.order_total ?? order.total ?? order.estimated_payment_details);
  const computedTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);

  const created = text(order.created) ?? text(order.created_time) ?? text(order.last_updated);
  const occurredAt = created ? new Date(created) : new Date();

  // A Meta manda o estado ora como objeto (`order_status: { state }`),
  // ora como string solta. Ler o objeto cru aqui gravaria o literal
  // "[object Object]" como status — e todo pedido cairia no default.
  const statusSource = Object.keys(asRecord(order.order_status)).length
    ? asRecord(order.order_status).state
    : (order.order_status ?? order.status);

  return {
    id,
    status: instagramOrderStatusToSaleStatus(text(statusSource)),
    // O total declarado manda; sem ele, a soma dos itens. Nunca um chute.
    totalAmountCents: declaredTotal > 0 ? declaredTotal : computedTotal,
    currency,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    items,
  };
}
