/**
 * Base pública do ERP usada para montar os `redirect_uri` dos fluxos
 * OAuth e as URLs de webhook.
 *
 * Fonte: `lib/app-url.ts` do brobond-ai-commerce, reduzido ao que a Fase 2
 * precisa e alinhado ao ERP: a variável canônica aqui é `APP_URL`
 * (documentada no `server/.env.example` e usada pelos links de e-mail,
 * portal e QR code).
 *
 * CONTRATO (lição cara do commerce, PR016.2): o `redirect_uri` das duas
 * pernas do OAuth tem que ser IDÊNTICO byte a byte. NADA é derivado dos
 * CABEÇALHOS da requisição que chega (`Host`, `X-Forwarded-Host`,
 * `req.url`) — atrás de um proxy eles mentem e eram exatamente o que
 * fazia as duas pernas divergirem.
 *
 * Exceção controlada (fusão no host unificado): o painel AUTENTICADO envia
 * a origem em que o navegador está (`redirect_uri` = `window.location.origin`,
 * na Render `https://brobond-erp.onrender.com`). O valor é validado com
 * `parseDynamicCallbackBase`/`resolveDynamicCallbackUri`, o caminho canônico
 * do callback é derivado no servidor e a URI escolhida é PERSISTIDA junto
 * com o state CSRF (`connector_oauth_states.redirect_uri`) — a troca do
 * código reusa exatamente a mesma URI, preservando o contrato.
 */

export interface AppUrlEnv {
  [key: string]: string | undefined;
  APP_URL?: string;
}

/** Base de desenvolvimento local (mesmo valor do `.env.example`). */
export const LOCAL_FALLBACK_BASE_URL = 'http://localhost:5173';

/** Remove barras finais e espaços de uma base de URL. */
function normalizeBase(value: string | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * Base pública configurada (`APP_URL`), ou string vazia quando não há.
 * Sem adivinhação: a ausência é informação, e cada chamador decide se
 * cai no fallback local ou exige configuração explícita.
 */
export function resolveAppBaseUrl(env: AppUrlEnv = process.env): string {
  return normalizeBase(env.APP_URL);
}

/** Base pública, com o fallback local de desenvolvimento. */
export function resolveAppBaseUrlOrLocal(env: AppUrlEnv = process.env): string {
  return resolveAppBaseUrl(env) || LOCAL_FALLBACK_BASE_URL;
}

/**
 * Monta uma URL absoluta do ERP a partir de um caminho
 * (`/api/connectors/nuvemshop/callback`).
 */
export function appUrl(path: string, env: AppUrlEnv = process.env): string {
  const base = resolveAppBaseUrlOrLocal(env);
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Caminho canônico do callback OAuth de um provedor no ERP. É o mesmo
 * formato de rota do commerce (`/api/connectors/<slug>/callback`), então
 * as URIs já cadastradas nos portais das plataformas continuam valendo.
 */
export function connectorCallbackPath(slug: string): string {
  return `/api/connectors/${slug}/callback`;
}

/** Caminho canônico do webhook de um provedor no ERP. */
export function connectorWebhookPath(slug: string): string {
  return `/api/webhooks/${slug}`;
}

/**
 * Resolve um `redirect_uri` estático: a variável explícita do provedor
 * tem precedência; sem ela, `APP_URL` + o caminho canônico do callback.
 */
export function resolveStaticRedirectUri(explicitEnvNames: readonly string[], slug: string, env: AppUrlEnv = process.env): string {
  for (const name of explicitEnvNames) {
    const explicit = (env[name] ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\/[^/]+/i.test(explicit)) return explicit;
  }
  return appUrl(connectorCallbackPath(slug), env);
}

/**
 * Extrai a origem (scheme + host + porta) de um valor de `redirect_uri`
 * dinâmico enviado pelo navegador — `window.location.origin`, que num deploy
 * da Render é o host unificado `https://brobond-erp.onrender.com`.
 *
 * Regras estritas: exige esquema http(s) válido; em produção (`NODE_ENV`)
 * exige https e host público (nada de localhost/127.0.0.1/host sem domínio).
 * Retorna `null` quando o valor não pode virar callback — o chamador cai na
 * resolução estática do ambiente em vez de colar lixo na URL do provedor.
 */
export function parseDynamicCallbackBase(value: string | null | undefined, env: AppUrlEnv = process.env): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') {
    // http só é aceitável em desenvolvimento local (nunca atrás de proxy).
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLocal) return null;
  }
  const production = (env.NODE_ENV ?? '').toLowerCase() === 'production';
  if (production) {
    const isPublic = url.protocol === 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname.includes('.');
    if (!isPublic) return null;
  }
  return url.origin;
}

/**
 * Resolve o `redirect_uri` a partir da base dinâmica enviada pelo painel
 * (a origem que o navegador está usando). A base precisa ser só a ORIGEM
 * (sem caminho); o caminho canônico `/api/connectors/<slug>/callback` é
 * sempre derivado aqui — nunca aceito pronto do cliente — para que a URI
 * final seja exatamente a rota pública de callback do ERP.
 *
 * Retorna `null` quando a base é inválida ou tenta injetar um caminho
 * estranho (ex.: `https://host/outra/pagina`).
 */
export function resolveDynamicCallbackUri(base: string | null | undefined, slug: string, env: AppUrlEnv = process.env): string | null {
  const trimmed = (base ?? '').trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const origin = parseDynamicCallbackBase(trimmed, env);
  if (!origin) return null;
  // Só aceitamos a origem nua (com ou sem barra). Qualquer caminho que não
  // seja o próprio callback canônico é rejeitado: a URI tem que bater byte
  // a byte com a registrada no painel do provedor.
  const path = `${url.pathname}`.replace(/\/+$/, '');
  if (path === '' || path === connectorCallbackPath(slug)) {
    return `${origin}${connectorCallbackPath(slug)}`;
  }
  return null;
}
