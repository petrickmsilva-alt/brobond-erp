// ============================================================================
// OAUTH 2.1 › CÓDIGOS DE AUTORIZAÇÃO + PKCE S256
//
// O authorization code é OPACO e de vida curta; guardamos só o HASH. O PKCE
// S256 é OBRIGATÓRIO: `code_challenge = base64url(SHA-256(verifier))`. Trocar
// o código exige o `code_verifier` original — um código interceptado não é
// suficiente para obter token.
//
// O código é de USO ÚNICO: `consumed_at` é gravado atomicamente na troca.
// ============================================================================
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore } from '../../../server/src/services';
import { R_OAUTH_CODES } from '../infrastructure/resources';
import { OperationalError } from '../domain/errors';
import type { Row } from '../../../server/src/store';

const TTL_CODIGO_MS = Number(process.env.OAUTH_CODE_TTL_SECONDS ?? 120) * 1000;

export function hashCodigo(codigo: string): string {
  return createHash('sha256').update(String(codigo)).digest('hex');
}

/** PKCE S256: a challenge é o SHA-256 do verifier em base64url. */
export function derivarChallenge(verifier: string): string {
  return createHash('sha256').update(String(verifier)).digest('base64url');
}

/** Confere o verifier contra a challenge (comparação em tempo constante). */
export function pkceConfere(verifier: string, challenge: string): boolean {
  const esperado = Buffer.from(derivarChallenge(verifier));
  const informado = Buffer.from(String(challenge));
  if (esperado.length !== informado.length) return false;
  return timingSafeEqual(esperado, informado);
}

/** Cria o código de autorização (devolve o valor em claro, guarda só o hash). */
export async function criarCodigo(dados: {
  clientId: string;
  usuarioId: number;
  empresaId: number;
  perfil: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
}): Promise<string> {
  if (!dados.codeChallenge || String(dados.codeChallenge).length < 43) {
    throw new OperationalError('PARAMETRO_INVALIDO', 'O PKCE (code_challenge S256) é obrigatório.');
  }
  const codigo = randomBytes(32).toString('base64url');
  await getStore().insert(R_OAUTH_CODES, {
    code_hash: hashCodigo(codigo),
    client_id: dados.clientId,
    usuario_id: dados.usuarioId,
    empresa_id: dados.empresaId,
    perfil: dados.perfil,
    redirect_uri: dados.redirectUri,
    scope: dados.scope,
    code_challenge: dados.codeChallenge,
    code_challenge_method: 'S256',
    expires_at: new Date(Date.now() + TTL_CODIGO_MS).toISOString(),
  });
  return codigo;
}

export type CodigoConsumido = {
  usuarioId: number;
  empresaId: number;
  perfil: string;
  clientId: string;
  redirectUri: string;
  scope: string;
};

/**
 * Consome o código ATOMICAMENTE (uso único) e valida client/redirect/PKCE.
 * Qualquer divergência lança; o código NUNCA é reutilizado.
 */
export async function consumirCodigo(codigo: string, clientId: string, redirectUri: string, codeVerifier: string): Promise<CodigoConsumido> {
  const store = getStore();
  const row = await store.findOneWhere(R_OAUTH_CODES, { code_hash: hashCodigo(codigo) });
  if (!row) throw new OperationalError('NAO_AUTENTICADO', 'Código de autorização inválido.');
  const r = row as Row;
  if (r.consumed_at) throw new OperationalError('CONFLITO', 'O código de autorização já foi utilizado.');
  if (new Date(String(r.expires_at)).getTime() <= Date.now()) throw new OperationalError('NAO_AUTENTICADO', 'O código de autorização expirou.');
  if (String(r.client_id) !== String(clientId)) throw new OperationalError('NAO_AUTENTICADO', 'O código pertence a outro cliente.');
  if (String(r.redirect_uri) !== String(redirectUri)) throw new OperationalError('NAO_AUTENTICADO', 'A redirect_uri diverge da usada na autorização.');
  if (String(r.code_challenge_method) !== 'S256' || !pkceConfere(codeVerifier, String(r.code_challenge))) {
    throw new OperationalError('NAO_AUTENTICADO', 'A verificação PKCE falhou.');
  }
  const consumido = await store.tryUpdateIf(R_OAUTH_CODES, Number(r.id), { consumed_at: null }, { consumed_at: new Date().toISOString() });
  if (!consumido) throw new OperationalError('CONFLITO', 'O código de autorização já foi utilizado.');
  return {
    usuarioId: Number(r.usuario_id),
    empresaId: Number(r.empresa_id),
    perfil: String(r.perfil),
    clientId: String(r.client_id),
    redirectUri: String(r.redirect_uri),
    scope: String(r.scope ?? ''),
  };
}
