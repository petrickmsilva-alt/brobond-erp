// ============================================================================
// OAUTH 2.1 › TOKENS
//
// Access token = JWT RS256, curto (15 min por padrão), com `iss`, `sub`,
// `aud`, `client_id`, `scope`, `iat`, `exp` e `jti`. O `jti` é gravado em
// `oauth_tokens` para permitir REVOGAÇÃO: a assinatura prova a origem; a
// tabela prova que o token não foi revogado.
//
// Refresh token é OPACO (não é JWT) e só o HASH é guardado — o valor em claro
// existe apenas na resposta ao cliente. Rotação: usar o refresh invalida o
// anterior (o novo aponta para o antigo via `parent_jti`).
//
// NUNCA registramos token em log; a resposta é o único lugar onde ele aparece.
// ============================================================================
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { getStore } from '../../../server/src/services';
import { R_OAUTH_TOKENS } from '../infrastructure/resources';
import { obterChaves } from './keys';
import { OperationalError } from '../domain/errors';
import { normalizarEscopos } from '../domain/scopes';
import type { Row } from '../../../server/src/store';

export const TTL_ACCESS_S = Number(process.env.OAUTH_ACCESS_TTL_SECONDS ?? 900);
export const TTL_REFRESH_S = Number(process.env.OAUTH_REFRESH_TTL_SECONDS ?? 30 * 24 * 3600);

/** Issuer do Authorization Server (referência; a URL efetiva é validada no deploy). */
export function issuer(): string {
  return String(process.env.OAUTH_ISSUER ?? 'https://auth.brobond.com.br').replace(/\/+$/, '');
}

/** Audience do Resource Server (o endpoint MCP). */
export function audience(): string {
  return String(process.env.OAUTH_RESOURCE ?? 'https://mcp.brobond.com.br/mcp').replace(/\/+$/, '');
}

export type ClaimsToken = {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
  /** Empresa do consentimento — recorta o acesso do token. */
  emp: number;
};

function novoJti(): string {
  return randomBytes(16).toString('hex');
}

function hashRefresh(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

/** Emite o access token e registra o `jti` (revogável). */
export async function emitirAccessToken(dados: {
  usuarioId: number;
  empresaId: number;
  clientId: string;
  scopes: readonly string[];
}): Promise<{ token: string; expires_in: number; jti: string; scope: string }> {
  const chaves = await obterChaves();
  const scope = normalizarEscopos(dados.scopes).join(' ');
  const agora = Math.floor(Date.now() / 1000);
  const jti = novoJti();
  const claims: ClaimsToken = {
    iss: issuer(),
    sub: `user:${dados.usuarioId}`,
    aud: audience(),
    client_id: dados.clientId,
    scope,
    iat: agora,
    exp: agora + TTL_ACCESS_S,
    jti,
    emp: dados.empresaId,
  };
  const token = jwt.sign(claims as unknown as Record<string, unknown>, chaves.privateKey, {
    algorithm: 'RS256',
    keyid: chaves.kid,
  });
  await getStore().insert(R_OAUTH_TOKENS, {
    jti,
    client_id: dados.clientId,
    usuario_id: dados.usuarioId,
    empresa_id: dados.empresaId,
    scope,
    tipo: 'access',
    expires_at: new Date((agora + TTL_ACCESS_S) * 1000).toISOString(),
  });
  return { token, expires_in: TTL_ACCESS_S, jti, scope };
}

/** Emite o refresh token OPACO (guarda só o hash). */
export async function emitirRefreshToken(dados: {
  usuarioId: number;
  empresaId: number;
  clientId: string;
  scopes: readonly string[];
  parentJti?: string;
}): Promise<{ token: string; expires_in: number }> {
  const valor = randomBytes(32).toString('base64url');
  await getStore().insert(R_OAUTH_TOKENS, {
    jti: novoJti(),
    client_id: dados.clientId,
    usuario_id: dados.usuarioId,
    empresa_id: dados.empresaId,
    scope: normalizarEscopos(dados.scopes).join(' '),
    tipo: 'refresh',
    parent_jti: dados.parentJti ?? null,
    refresh_hash: hashRefresh(valor),
    expires_at: new Date(Date.now() + TTL_REFRESH_S * 1000).toISOString(),
  });
  return { token: valor, expires_in: TTL_REFRESH_S };
}

export type ValidacaoToken = {
  ok: boolean;
  claims?: ClaimsToken;
  motivo?: 'assinatura' | 'expirado' | 'issuer' | 'audience' | 'revogado';
};

/** Valida assinatura, issuer, audience, expiração e revogação. */
export async function validarAccessToken(token: string): Promise<ValidacaoToken> {
  const chaves = await obterChaves();
  let claims: ClaimsToken;
  try {
    claims = jwt.verify(token, chaves.publicKey, { algorithms: ['RS256'], issuer: issuer(), audience: audience() }) as unknown as ClaimsToken;
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('expired')) return { ok: false, motivo: 'expirado' };
    if (msg.includes('issuer')) return { ok: false, motivo: 'issuer' };
    if (msg.includes('audience')) return { ok: false, motivo: 'audience' };
    return { ok: false, motivo: 'assinatura' };
  }
  const row = await getStore().findOneWhere(R_OAUTH_TOKENS, { jti: claims.jti });
  if (!row || row.revoked_at) return { ok: false, motivo: 'revogado' };
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) return { ok: false, motivo: 'expirado' };
  return { ok: true, claims };
}

/** Troca um refresh token válido por um novo par (rotação: invalida o antigo). */
export async function trocarRefreshToken(refresh: string, clientId: string): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const hash = hashRefresh(String(refresh ?? ''));
  const row = await getStore().findOneWhere(R_OAUTH_TOKENS, { refresh_hash: hash, tipo: 'refresh' });
  if (!row || row.revoked_at || new Date(String(row.expires_at)).getTime() <= Date.now()) {
    throw new OperationalError('NAO_AUTENTICADO', 'Refresh token inválido ou expirado.');
  }
  if (String(row.client_id) !== String(clientId)) throw new OperationalError('NAO_AUTENTICADO', 'Refresh token de outro cliente.');
  // Rotação: o refresh usado é revogado imediatamente.
  await revogarPorJti(String(row.jti));
  const scopes = String(row.scope ?? '').split(/\s+/).filter(Boolean);
  const access = await emitirAccessToken({ usuarioId: Number(row.usuario_id), empresaId: Number(row.empresa_id), clientId, scopes });
  const novoRefresh = await emitirRefreshToken({ usuarioId: Number(row.usuario_id), empresaId: Number(row.empresa_id), clientId, scopes, parentJti: String(row.jti) });
  return { access_token: access.token, refresh_token: novoRefresh.token, expires_in: access.expires_in, scope: access.scope };
}

async function revogarPorJti(jti: string): Promise<void> {
  await revogarToken(jti);
}

/**
 * Revoga um token. Aceita as TRÊS formas que um cliente pode enviar:
 *   • o access token JWT (RFC 7009 manda o token como ele é) — extrai o `jti`;
 *   • o `jti` cru (uso interno);
 *   • o refresh token opaco (casa pelo hash).
 * Sem decodificar o JWT, revogar o access token — o caso NORMAL — não revogaria
 * nada, e a resposta 200 daria uma falsa sensação de segurança.
 */
export async function revogarToken(valor: string, _clientId?: string): Promise<boolean> {
  const store = getStore();
  const jtiDoValor = extrairJti(valor);
  if (jtiDoValor) {
    const porJti = await store.findOneWhere(R_OAUTH_TOKENS, { jti: jtiDoValor });
    if (porJti) return (await store.tryUpdateIf(R_OAUTH_TOKENS, Number(porJti.id), { revoked_at: null }, { revoked_at: new Date().toISOString() })) !== null;
  }
  const porHash = await store.findOneWhere(R_OAUTH_TOKENS, { refresh_hash: hashRefresh(valor) });
  if (porHash) return (await store.tryUpdateIf(R_OAUTH_TOKENS, Number(porHash.id), { revoked_at: null }, { revoked_at: new Date().toISOString() })) !== null;
  return false;
}

/** O `jti` do token: o próprio valor (quando já é o jti) ou o claim de um JWT. */
function extrairJti(valor: string): string {
  const v = String(valor ?? '');
  if (!v.includes('.')) return v;
  const decodificado = jwt.decode(v);
  return decodificado && typeof decodificado === 'object' && 'jti' in decodificado ? String((decodificado as { jti: unknown }).jti) : '';
}

/** Revoga TODOS os tokens de um usuário (logout global / revogação de acesso). */
export async function revogarTudoDoUsuario(usuarioId: number): Promise<number> {
  const store = getStore();
  let n = 0;
  // Paginação por OFFSET: a varredura NÃO pode ter janela fixa — um usuário com
  // mais tokens que a página deixava os excedentes VÁLIDOS. Só atualizamos
  // linhas (nunca removemos), então a ordem por `id` é estável e o paging é seguro.
  const pageSize = 500;
  for (let page = 1; ; page++) {
    const res = await store.list(R_OAUTH_TOKENS, { page, pageSize, sort: 'id', dir: 'asc', filter: { usuario_id: usuarioId } });
    for (const row of res.rows as Row[]) {
      if (row.revoked_at) continue;
      const ok = await store.tryUpdateIf(R_OAUTH_TOKENS, Number(row.id), { revoked_at: null }, { revoked_at: new Date().toISOString() });
      if (ok) n++;
    }
    if (res.rows.length < pageSize) break;
  }
  return n;
}
