// ============================================================================
// OAUTH 2.1 › ROTAS (Authorization Server + descoberta)
//
// Endpoints:
//   GET  /.well-known/oauth-protected-resource   (Resource Server / MCP)
//   GET  /.well-known/oauth-authorization-server (Authorization Server)
//   GET  /.well-known/jwks.json                  (chaves públicas)
//   GET  /oauth/authorize                        (Authorization Code + PKCE S256)
//   POST /oauth/token                            (code → token, refresh)
//   POST /oauth/revoke                           (revogação)
//
// Montado na RAIZ (fora do /api): o padrão MCP descobre estes caminhos bem
// conhecidos. `/oauth/authorize` exige a SESSÃO do ERP (não é um login novo);
// `/oauth/token` e `/oauth/revoke` são servidor-a-servidor.
//
// `redirect_uri` é conferida por IGUALDADE EXATA (fecha open redirect) e o
// PKCE S256 é obrigatório. Nenhum token é registrado em log.
// ============================================================================
import { type NextFunction, type Request, type Response, Router } from 'express';
import { currentUser, requireAuth, exigirReautenticacao } from '../../../server/src/auth';
import { HttpError } from '../../../server/src/errors';
import { normalizarEscopos, SCOPES } from '../domain/scopes';
import { metadadosRecurso, metadadosAutorizacao } from './metadata';
import { jwks } from './keys';
import { resolverCliente, redirectUriValida, scopesPermitidosAoCliente, autenticarCliente } from './clients';
import { criarCodigo, consumirCodigo } from './codes';
import { emitirAccessToken, emitirRefreshToken, trocarRefreshToken, revogarToken } from './tokens';
import { getStore } from '../../../server/src/services';
import { R_OAUTH_CONSENTS } from '../infrastructure/resources';
import { auditarOperacao } from '../infrastructure/audit';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export const oauthRouter: Router = Router();

oauthRouter.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json(metadadosRecurso());
});

oauthRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json(metadadosAutorizacao());
});

oauthRouter.get('/.well-known/jwks.json', wrap(async (_req, res) => {
  res.json(await jwks());
}));

/**
 * Autorização. Sem `confirm=1` devolve o CONTEÚDO DA TELA DE CONSENTIMENTO
 * (aplicação, escopos, ações, validade) para o ERP renderizar. Com `confirm=1`
 * — e uma confirmação humana RECENTE (reautenticação) — emite o código e
 * redireciona para a redirect_uri registrada.
 */
oauthRouter.get('/oauth/authorize', requireAuth, wrap(async (req, res) => {
  const cliente = await resolverCliente(String(req.query.client_id ?? ''));
  if (!cliente || !cliente.ativo) throw new HttpError(400, 'Cliente OAuth desconhecido.');
  const redirectUri = String(req.query.redirect_uri ?? '');
  if (!redirectUriValida(cliente, redirectUri)) throw new HttpError(400, 'redirect_uri não registrada para este cliente.');
  const state = String(req.query.state ?? '');
  if (String(req.query.response_type ?? 'code') !== 'code') throw new HttpError(400, 'response_type suportado: code.');
  if (String(req.query.code_challenge_method ?? 'S256') !== 'S256' || !String(req.query.code_challenge ?? '')) {
    throw new HttpError(400, 'PKCE S256 é obrigatório (code_challenge + code_challenge_method=S256).');
  }

  const pedidos = normalizarEscopos(String(req.query.scope ?? ''));
  const escopos = scopesPermitidosAoCliente(cliente, pedidos);
  if (!escopos.length) throw new HttpError(400, 'Nenhum escopo válido solicitado.');

  const u = currentUser(req);
  const empresaId = Number(u.empresa_sessao ?? u.empresa_id ?? (u.empresas?.[0] ?? 1));

  if (String(req.query.confirm ?? '') !== '1') {
    res.status(200).json({
      ok: true,
      consent: {
        client_id: cliente.client_id,
        application: cliente.nome,
        scopes: escopos,
        actions: escopos.map((s) => ACAO_POR_ESCOPO[s] ?? s),
        // Validade do consentimento exibida ao Diretor (TTL do refresh).
        consent_expires_in: Number(process.env.OAUTH_REFRESH_TTL_SECONDS ?? 30 * 24 * 3600),
      },
    });
    return;
  }

  // Confirmação humana RECENTE obrigatória para conceder escopos sensíveis.
  if (escopos.includes(SCOPES.workflowRequest) || escopos.includes(SCOPES.workflowApprove)) exigirReautenticacao(req);

  await getStore().insert(R_OAUTH_CONSENTS, { usuario_id: u.id, client_id: cliente.client_id, empresa_id: empresaId, scope: escopos.join(' ') });
  await auditarOperacao({ empresaId, actorId: u.id, eventType: 'oauth.consent', payload: { client_id: cliente.client_id, scopes: escopos } });

  const codigo = await criarCodigo({
    clientId: cliente.client_id,
    usuarioId: u.id,
    empresaId,
    perfil: u.perfil,
    redirectUri,
    scope: escopos.join(' '),
    codeChallenge: String(req.query.code_challenge),
  });

  const destino = new URL(redirectUri);
  destino.searchParams.set('code', codigo);
  if (state) destino.searchParams.set('state', state);
  res.redirect(destino.toString());
}));

const ACAO_POR_ESCOPO: Record<string, string> = {
  [SCOPES.systemRead]: 'Consultar o estado do sistema',
  [SCOPES.githubRead]: 'Consultar repositório, branches, commits e pull requests',
  [SCOPES.workflowRead]: 'Consultar workflows e execuções',
  [SCOPES.workflowRequest]: 'Solicitar execução de workflow autorizado',
  [SCOPES.workflowApprove]: 'Aprovar execução (exige confirmação humana recente)',
  [SCOPES.auditRead]: 'Consultar o histórico de auditoria',
};

/** Troca de código (PKCE) e refresh. Sem log de token. */
oauthRouter.post('/oauth/token', wrap(async (req, res) => {
  const grantType = String(req.body?.grant_type ?? '');
  const clientId = String(req.body?.client_id ?? '');

  // Autenticação do cliente: público dispensa segredo; confidencial exige
  // `client_secret` válido (Argon2id/bcrypt). O cliente precisa existir/ativo.
  const cliente = await resolverCliente(clientId);
  if (!cliente || !cliente.ativo) throw new HttpError(401, 'Cliente OAuth inválido.');
  if (!(await autenticarCliente(cliente, req.body?.client_secret))) {
    throw new HttpError(401, 'Credenciais do cliente inválidas.');
  }

  if (grantType === 'authorization_code') {
    const consumido = await consumirCodigo(
      String(req.body?.code ?? ''),
      clientId,
      String(req.body?.redirect_uri ?? ''),
      String(req.body?.code_verifier ?? '')
    );
    const scopes = normalizarEscopos(consumido.scope);
    const access = await emitirAccessToken({ usuarioId: consumido.usuarioId, empresaId: consumido.empresaId, clientId, scopes });
    const refresh = await emitirRefreshToken({ usuarioId: consumido.usuarioId, empresaId: consumido.empresaId, clientId, scopes });
    await auditarOperacao({ empresaId: consumido.empresaId, actorId: consumido.usuarioId, eventType: 'oauth.token_issued', payload: { client_id: clientId, scopes } });
    res.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expires_in, refresh_token: refresh.token, scope: access.scope });
    return;
  }

  if (grantType === 'refresh_token') {
    const par = await trocarRefreshToken(String(req.body?.refresh_token ?? ''), clientId);
    res.json({ access_token: par.access_token, token_type: 'Bearer', expires_in: par.expires_in, refresh_token: par.refresh_token, scope: par.scope });
    return;
  }

  throw new HttpError(400, 'grant_type suportado: authorization_code, refresh_token.');
}));

oauthRouter.post('/oauth/revoke', wrap(async (req, res) => {
  const token = String(req.body?.token ?? '');
  const revogado = await revogarToken(token, String(req.body?.client_id ?? ''));
  await auditarOperacao({ empresaId: 0, actorId: null, eventType: 'oauth.token_revoked', payload: { revogado } });
  // RFC 7009: responde 200 mesmo quando o token é desconhecido.
  res.status(200).json({ ok: true });
}));
