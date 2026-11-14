// ============================================================================
// OAUTH 2.1 › METADADOS DE DESCOBERTA
//
// Resource Server (`/.well-known/oauth-protected-resource`) e Authorization
// Server (`/.well-known/oauth-authorization-server`) — o ChatGPT descobre por
// aqui onde autenticar e quais escopos existem. PKCE S256 é anunciado como o
// ÚNICO método aceito. Nada de segredo nestes documentos.
// ============================================================================
import { TODOS_OS_SCOPES } from '../domain/scopes';
import { audience, issuer } from './tokens';
import { cimdHabilitado } from './outbound-guard';

/** Metadados do Resource Server (o MCP). */
export function metadadosRecurso(): Record<string, unknown> {
  return {
    resource: audience(),
    authorization_servers: [issuer()],
    scopes_supported: [...TODOS_OS_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/** Metadados do Authorization Server. */
export function metadadosAutorizacao(): Record<string, unknown> {
  const iss = issuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    authorization_response_iss_parameter_supported: true,
    revocation_endpoint: `${iss}/oauth/revoke`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // Só anunciamos o que REALMENTE é suportado: o cliente confidencial é
    // autenticado por `client_secret_post`; o público usa `none`.
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: [...TODOS_OS_SCOPES],
    // Client ID Metadata Documents (CIMD): só é anunciado quando HABILITADO e
    // protegido (a guarda anti-SSRF exige `OAUTH_CIMD_ENABLED=true`). Não
    // anunciar capacidade inexistente.
    client_id_metadata_document_supported: cimdHabilitado(),
  };
}
