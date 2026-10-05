/**
 * Base pública do ERP usada para montar os `redirect_uri` dos fluxos
 * OAuth e as URLs de webhook.
 *
 * Fonte: `lib/app-url.ts` do brobond-ai-commerce, reduzido ao que a Fase 2
 * precisa e alinhado ao ERP: a variável canônica aqui é `APP_URL`
 * (documentada no `server/.env.example` e usada pelos links de e-mail,
 * portal e QR code).
 *
 * CONTRATO (lição cara do commerce, PR016.2): o `redirect_uri` é
 * ESTÁTICO. NADA é derivado da requisição que chega (`Host`,
 * `X-Forwarded-Host`, `req.url`). Mercado Livre e Shopee comparam o valor
 * byte a byte entre a autorização e a troca do código; recalcular a URI a
 * partir dos cabeçalhos atrás de um proxy é exatamente o que fazia as
 * duas pernas divergirem.
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
 * (`/api/connectors/shopee/callback`).
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
