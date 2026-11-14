// OAuth 2.1 / RFC 7591 — Dynamic Client Registration para clientes MCP.
import { randomUUID } from 'node:crypto';
import { SCOPES, normalizarEscopos } from '../domain/scopes';
import { cadastrarCliente } from './clients';
import { OperationalError } from '../domain/errors';

export type DynamicRegistrationRequest = {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
};

const REDIRECT_HOST = 'chatgpt.com';
const REDIRECT_PATHS = ['/connector_platform_oauth_redirect', /^\/connector\/oauth\/[A-Za-z0-9_-]+$/];
const SCOPES_PADRAO = [SCOPES.systemRead, SCOPES.githubRead, SCOPES.workflowRead, SCOPES.auditRead];

function redirectUriChatGPT(valor: unknown): string {
  const raw = String(valor ?? '').trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new OperationalError('PARAMETRO_INVALIDO', 'redirect_uri inválida.'); }
  const caminhoPermitido = REDIRECT_PATHS.some((item) => typeof item === 'string' ? url.pathname === item : item.test(url.pathname));
  if (url.protocol !== 'https:' || url.hostname !== REDIRECT_HOST || url.port || url.username || url.password || url.search || url.hash || !caminhoPermitido) {
    throw new OperationalError('PARAMETRO_INVALIDO', 'redirect_uri não pertence aos callbacks HTTPS permitidos do ChatGPT.');
  }
  return url.toString();
}

export async function registrarClienteDinamico(input: DynamicRegistrationRequest) {
  const redirects = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (!redirects.length || redirects.length > 5) throw new OperationalError('PARAMETRO_INVALIDO', 'Informe de 1 a 5 redirect_uris.');
  const redirectUris = [...new Set(redirects.map(redirectUriChatGPT))];
  if (input.grant_types !== undefined && (!Array.isArray(input.grant_types) || !input.grant_types.includes('authorization_code') || input.grant_types.some((grant) => !['authorization_code', 'refresh_token'].includes(String(grant))) || new Set(input.grant_types).size !== input.grant_types.length)) {
    throw new OperationalError('PARAMETRO_INVALIDO', 'grant_types deve conter authorization_code e, opcionalmente, refresh_token.');
  }
  if (input.response_types !== undefined && (!Array.isArray(input.response_types) || input.response_types.length !== 1 || input.response_types[0] !== 'code')) {
    throw new OperationalError('PARAMETRO_INVALIDO', 'response_types deve conter somente code.');
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== 'none') {
    throw new OperationalError('PARAMETRO_INVALIDO', 'Somente clientes públicos com token_endpoint_auth_method=none são aceitos.');
  }
  const rawScopes = input.scope === undefined ? SCOPES_PADRAO : String(input.scope).split(/\s+/).filter(Boolean);
  if (rawScopes.some((scope) => !(SCOPES_PADRAO as readonly string[]).includes(scope))) {
    throw new OperationalError('PARAMETRO_INVALIDO', 'O registro ChatGPT inicial aceita somente escopos de leitura.');
  }
  const requested = normalizarEscopos(rawScopes);
  if (!requested.length) throw new OperationalError('PARAMETRO_INVALIDO', 'Nenhum escopo Brobond válido foi solicitado.');
  const name = String(input.client_name ?? 'ChatGPT Remote MCP').trim().slice(0, 120) || 'ChatGPT Remote MCP';
  const clientId = `chatgpt-${randomUUID()}`;
  await cadastrarCliente({ clientId, nome: name, redirectUris, scopes: requested, confidential: false });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: requested.join(' '),
  };
}
