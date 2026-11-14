// ============================================================================
// OAUTH 2.1 › CLIENTES
//
// Cadastro pelo MODELO RECOMENDADO: Client ID Metadata Document (CIMD) quando
// o cliente suporta; senão, um cliente REGISTRADO (id + redirect URIs
// EXATAS). DCR indiscriminado NÃO é implementado (decisão da especificação).
//
// `redirect_uri` é conferida por IGUALDADE EXATA contra a lista registrada —
// é o que fecha o open redirect no fluxo de autorização.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { verifyPassword } from '../../../server/src/password';
import { R_OAUTH_CLIENTS } from '../infrastructure/resources';
import { buscarDocumentoCimd, cimdHabilitado } from './outbound-guard';
import type { Row } from '../../../server/src/store';

export type ClienteOAuth = {
  client_id: string;
  nome: string;
  redirect_uris: string[];
  scopes: string[];
  confidential: boolean;
  secret_hash: string | null;
  ativo: boolean;
};

function daLinha(row: Row): ClienteOAuth {
  const uris = String(row.redirect_uris ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const scopes = String(row.scopes ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    client_id: String(row.client_id),
    nome: String(row.nome ?? ''),
    redirect_uris: uris,
    scopes,
    confidential: row.confidential === true,
    secret_hash: row.secret_hash ? String(row.secret_hash) : null,
    ativo: row.ativo !== false,
  };
}

/** Cliente registrado no banco (ativo). */
export async function clienteRegistrado(clientId: string): Promise<ClienteOAuth | null> {
  const row = await getStore().findOneWhere(R_OAUTH_CLIENTS, { client_id: String(clientId), ativo: true });
  return row ? daLinha(row) : null;
}

/** O cliente OAuth existe e está ativo? */
export async function clienteAtivo(clientId: string): Promise<boolean> {
  return (await clienteRegistrado(clientId)) !== null;
}

/**
 * Resolve um Client ID Metadata Document (CIMD) quando o client_id é uma URL.
 * A busca passa pela GUARDA anti-SSRF (`outbound-guard`): só HTTPS, sem rede
 * interna, IP validado e FIXADO na conexão, redirect revalidado, teto de
 * tamanho e timeout. Desligado por padrão (`OAUTH_CIMD_ENABLED=true` liga).
 * O documento é DADO EXTERNO: só os campos conhecidos são usados e a
 * redirect_uri continua sendo conferida por igualdade exata.
 */
export async function clientePorCimd(clientId: string): Promise<ClienteOAuth | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  try {
    const doc = await buscarDocumentoCimd(clientId);
    const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map((u) => String(u)) : [];
    if (!uris.length) return null;
    const scopes = Array.isArray(doc.scope) ? doc.scope.map((s) => String(s)) : String(doc.scope ?? '').split(/\s+/).filter(Boolean);
    return {
      client_id: clientId,
      nome: String(doc.client_name ?? url.hostname),
      redirect_uris: uris,
      scopes,
      confidential: false,
      secret_hash: null,
      ativo: true,
    };
  } catch {
    return null;
  }
}

/** Resolve o cliente: registro no banco primeiro, CIMD depois (se habilitado). */
export async function resolverCliente(clientId: string): Promise<ClienteOAuth | null> {
  const registrado = await clienteRegistrado(clientId);
  if (registrado) return registrado;
  if (!cimdHabilitado()) return null;
  return clientePorCimd(clientId);
}

/** A redirect_uri pertence EXATAMENTE ao cliente? */
export function redirectUriValida(cliente: ClienteOAuth, redirectUri: string): boolean {
  return cliente.redirect_uris.includes(String(redirectUri ?? ''));
}

/** Os escopos pedidos são subconjunto dos permitidos ao cliente? */
export function scopesPermitidosAoCliente(cliente: ClienteOAuth, scopes: readonly string[]): string[] {
  if (!cliente.scopes.length) return [...scopes];
  return scopes.filter((s) => cliente.scopes.includes(s));
}

/** Cadastro administrativo de um cliente (o secret, se houver, entra com hash). */
export async function cadastrarCliente(dados: {
  clientId: string;
  nome: string;
  redirectUris: string[];
  scopes: string[];
  confidential?: boolean;
  secretHash?: string | null;
}): Promise<void> {
  const confidential = !!dados.confidential;
  // Um cliente confidencial SEM hash de segredo não tem como autenticar; nasceria
  // anunciado como confidencial e nunca conseguiria trocar código. Recusamos.
  if (confidential && !dados.secretHash) {
    throw new Error('Cliente confidencial exige secret_hash.');
  }
  await getStore().insert(R_OAUTH_CLIENTS, {
    client_id: dados.clientId,
    nome: dados.nome,
    redirect_uris: dados.redirectUris.join(' '),
    scopes: dados.scopes.join(' '),
    confidential,
    secret_hash: dados.secretHash ?? null,
    ativo: true,
  });
}

/**
 * Autentica o cliente no `/oauth/token` conforme o `token_endpoint_auth_methods_supported`.
 * Cliente PÚBLICO (`confidential=false`): nenhum segredo é exigido. Cliente
 * CONFIDENCIAL: exige `client_secret` e confere contra o hash guardado (Argon2id
 * ou bcrypt) em tempo constante. Fail-closed: sem segredo ou hash divergente,
 * recusa. Nada do segredo é registrado.
 */
export async function autenticarCliente(cliente: ClienteOAuth, clientSecret: unknown): Promise<boolean> {
  if (!cliente.confidential) return true;
  const informado = String(clientSecret ?? '');
  if (!informado || !cliente.secret_hash) return false;
  return verifyPassword(informado, cliente.secret_hash);
}
