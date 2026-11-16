// ============================================================================
// OAUTH 2.1 › ROTAS (Authorization Server + Browser Bridge + descoberta)
//
// Endpoints:
//   GET  /.well-known/oauth-protected-resource   (Resource Server / MCP)
//   GET  /.well-known/oauth-authorization-server (Authorization Server)
//   GET  /.well-known/jwks.json                  (chaves públicas)
//   POST /oauth/register                         (RFC 7591 restrito ao ChatGPT)
//   GET  /oauth/authorize                        (Browser Authorization Bridge / JSON c/ Bearer)
//   GET  /oauth/authorize/bridge.js              (script same-origin da ponte)
//   GET  /oauth/authorize/session                (resumo autenticado p/ tela de consentimento)
//   POST /oauth/authorize/consent                (concessão autenticada → código único)
//   POST /oauth/authorize/deny                   (recusa explícita → access_denied sem código)
//   POST /oauth/token                            (code → token, refresh)
//   POST /oauth/revoke                           (revogação)
//
// Montado na RAIZ (fora do /api): o padrão MCP descobre estes caminhos bem
// conhecidos. A navegação de navegador em `GET /oauth/authorize` entrega
// apenas a casca estática da ponte (sem conceder consentimento nem emitir
// código); TODA concessão de consentimento e emissão de código exige a SESSÃO
// do ERP (`requireAuth`, Bearer HS256).
//
// `redirect_uri` é conferida por IGUALDADE EXATA (fecha open redirect) e o
// PKCE S256 é obrigatório. Nenhum token ou código é registrado em log.
// ============================================================================
import { type NextFunction, type Request, type Response, Router } from 'express';
import { currentUser, requireAuth, exigirReautenticacao, type AuthUser } from '../../../server/src/auth';
import { HttpError } from '../../../server/src/errors';
import { normalizarEscopos, SCOPES } from '../domain/scopes';
import { metadadosRecurso, metadadosAutorizacao } from './metadata';
import { jwks } from './keys';
import { resolverCliente, redirectUriValida, scopesPermitidosAoCliente, autenticarCliente, type ClienteOAuth } from './clients';
import { criarCodigo, consumirCodigo } from './codes';
import { emitirAccessToken, emitirRefreshToken, trocarRefreshToken, revogarToken, audience, issuer } from './tokens';
import { getStore } from '../../../server/src/services';
import { auditarOperacao } from '../infrastructure/audit';
import { registrarClienteDinamico } from './registration';
import { renderizarPaginaBridge, SCRIPT_OAUTH_BRIDGE } from './bridge';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

/** O consentimento OAuth é uma superfície ERP, nunca disponível a conta portal exclusiva. */
function exigirUsuarioNaoPortalRepresentante(u: AuthUser): void {
  if (u.portal_representante === true) {
    throw new HttpError(403, 'Contas exclusivas do Portal do Representante não podem autorizar integrações operacionais.');
  }
}

export const oauthRouter: Router = Router();

// Limite local e conservador para impedir abuso do endpoint público RFC 7591.
const dcrTentativas = new Map<string, { inicio: number; quantidade: number }>();
function limitarRegistroDinamico(req: Request): void {
  const agora = Date.now();
  const chave = String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
  const atual = dcrTentativas.get(chave);
  if (!atual || agora - atual.inicio >= 60_000) {
    dcrTentativas.set(chave, { inicio: agora, quantidade: 1 });
    if (dcrTentativas.size > 10_000) {
      for (const [ip, janela] of dcrTentativas) if (agora - janela.inicio >= 60_000) dcrTentativas.delete(ip);
    }
    return;
  }
  if (atual.quantidade >= 20) throw new HttpError(429, 'Limite de registros OAuth excedido. Tente novamente em um minuto.');
  atual.quantidade += 1;
}

function validarResource(resource: unknown): void {
  if (resource !== undefined && resource !== '' && String(resource) !== audience()) {
    throw new HttpError(400, 'resource não corresponde ao Resource Server Brobond.');
  }
}

/**
 * S256 base64url de SHA-256 (32 bytes = 43 caracteres base64url, alfabeto RFC 7636).
 * Rejeita na entrada challenges curtas, malformadas ou métodos diferentes de S256.
 */
const CODE_CHALLENGE_S256_RE = /^[A-Za-z0-9_-]{43,128}$/;

export const ACAO_POR_ESCOPO: Record<string, string> = {
  [SCOPES.systemRead]: 'Consultar o estado operacional do sistema e do banco de dados',
  [SCOPES.githubRead]: 'Consultar repositório, branches, commits e pull requests',
  [SCOPES.workflowRead]: 'Consultar workflows autorizados, operações e execuções',
  [SCOPES.workflowRequest]: 'Solicitar execução de workflow autorizado (exige aprovação humana)',
  [SCOPES.workflowApprove]: 'Aprovar execução operacional (exige confirmação humana recente)',
  [SCOPES.auditRead]: 'Consultar o histórico de auditoria operacional',
};

export type SolicitacaoAutorizacaoValidada = {
  cliente: ClienteOAuth;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  escopos: string[];
};

/**
 * Valida integralmente os parâmetros OAuth 2.1 + PKCE S256 no servidor:
 *   • resource (quando informado) igual ao audience configurado;
 *   • cliente registrado/ativo;
 *   • redirect_uri conferida por IGUALDADE EXATA contra o cadastro do cliente;
 *   • response_type === 'code' (explícito quando enviado, padrão 'code' apenas se ausente);
 *   • code_challenge_method === 'S256' e code_challenge compatível com SHA-256 base64url;
 *   • escopos recalculados no servidor = interseção (solicitados ∩ permitidos ao cliente);
 *     quando `scope` vem vazio/ausente, usa os escopos registrados do cliente (somente se válidos).
 */
async function validarSolicitacaoAutorizacao(fonte: Record<string, unknown>): Promise<SolicitacaoAutorizacaoValidada> {
  validarResource(fonte.resource);
  const clientId = String(fonte.client_id ?? '').trim();
  const cliente = await resolverCliente(clientId);
  if (!cliente || !cliente.ativo) throw new HttpError(400, 'Cliente OAuth desconhecido.');

  const redirectUri = String(fonte.redirect_uri ?? '');
  if (!redirectUriValida(cliente, redirectUri)) throw new HttpError(400, 'redirect_uri não registrada para este cliente.');

  const responseType = fonte.response_type === undefined ? 'code' : String(fonte.response_type);
  if (responseType !== 'code') throw new HttpError(400, 'response_type suportado: code.');

  const method = fonte.code_challenge_method === undefined ? '' : String(fonte.code_challenge_method);
  const codeChallenge = String(fonte.code_challenge ?? '');
  if (method !== 'S256' || !CODE_CHALLENGE_S256_RE.test(codeChallenge)) {
    throw new HttpError(400, 'PKCE S256 é obrigatório (code_challenge válido + code_challenge_method=S256).');
  }

  const escopoBruto = String(fonte.scope ?? '').trim();
  const pedidos = escopoBruto ? normalizarEscopos(escopoBruto) : normalizarEscopos(cliente.scopes);
  // Se o cliente enviou escopos explicitamente, mas todos eram desconhecidos/inválidos → 400.
  if (escopoBruto && !pedidos.length) throw new HttpError(400, 'Nenhum escopo válido solicitado.');
  const escopos = scopesPermitidosAoCliente(cliente, pedidos);
  if (!escopos.length) throw new HttpError(400, 'Nenhum escopo autorizado para este cliente.');

  const state = fonte.state === undefined || fonte.state === null ? '' : String(fonte.state);
  if (state.length > 1024) throw new HttpError(400, 'Parâmetro state excede o limite permitido.');

  return {
    cliente,
    redirectUri,
    state,
    codeChallenge,
    escopos,
  };
}

/**
 * Defesa em profundidade contra CSRF nos endpoints mutantes da ponte:
 *   1. O token de sessão já vai explicitamente em `Authorization: Bearer` (nunca cookie);
 *   2. Exige cabeçalho customizado `X-Brobond-OAuth-Bridge: 1` (impede simple form POST cross-site);
 *   3. Se `Sec-Fetch-Site` vier presente e for `cross-site`, recusa;
 *   4. Se `Origin` vier presente, exige correspondência exata com o `Host` da requisição.
 */
function exigirIntegridadeSameOrigin(req: Request): void {
  if (String(req.headers['x-brobond-oauth-bridge'] ?? '') !== '1') {
    throw new HttpError(403, 'Cabeçalho de confirmação da ponte OAuth ausente.');
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    throw new HttpError(403, 'Requisição entre origens não permitida na confirmação OAuth.');
  }
  const origin = String(req.headers.origin ?? '').trim();
  if (origin) {
    let urlOrigin: URL;
    try {
      urlOrigin = new URL(origin);
    } catch {
      throw new HttpError(403, 'Cabeçalho Origin inválido.');
    }
    const hostReq = String(req.get('host') ?? '').trim().toLowerCase();
    if (!hostReq || urlOrigin.host.toLowerCase() !== hostReq) {
      throw new HttpError(403, 'Origin diverge do domínio do ERP.');
    }
  }
}

/**
 * Emissão ÚNICA e canônica do consentimento + authorization code.
 * Compartilhada entre `POST /oauth/authorize/consent` (ponte do navegador) e
 * `GET /oauth/authorize?confirm=1` com Bearer explícito (chamadas diretas de API/testes).
 */
async function concederConsentimentoEEmitirCallback(
  req: Request,
  u: AuthUser,
  validada: SolicitacaoAutorizacaoValidada
): Promise<string> {
  exigirUsuarioNaoPortalRepresentante(u);
  if (u.trocar_senha === true) {
    throw new HttpError(403, 'Troque sua senha provisória no ERP antes de autorizar integrações externas.');
  }
  const { cliente, redirectUri, state, codeChallenge, escopos } = validada;
  const empresaId = Number(u.empresa_sessao ?? u.empresa_id ?? (u.empresas?.[0] ?? 1));

  // Confirmação humana RECENTE obrigatória para conceder escopos sensíveis.
  if (escopos.includes(SCOPES.workflowRequest) || escopos.includes(SCOPES.workflowApprove)) {
    exigirReautenticacao(req);
  }

  await getStore().saveOAuthConsent(u.id, cliente.client_id, empresaId, escopos.join(' '));
  await auditarOperacao({
    empresaId,
    actorId: u.id,
    eventType: 'oauth.consent',
    payload: { client_id: cliente.client_id, scopes: escopos },
  });

  const codigo = await criarCodigo({
    clientId: cliente.client_id,
    usuarioId: u.id,
    empresaId,
    perfil: u.perfil,
    redirectUri,
    scope: escopos.join(' '),
    codeChallenge,
  });

  const destino = new URL(redirectUri);
  destino.searchParams.set('code', codigo);
  if (state) destino.searchParams.set('state', state);
  return destino.toString();
}

function cabecalhosSemCache(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
}

function clientePedeHtml(req: Request): boolean {
  const accept = String(req.headers.accept ?? '').toLowerCase();
  const secMode = String(req.headers['sec-fetch-mode'] ?? '').toLowerCase();
  const secDest = String(req.headers['sec-fetch-dest'] ?? '').toLowerCase();
  if (secMode === 'navigate' || secDest === 'document') return true;
  if (!accept) return false;
  // Navegadores enviam `text/html,application/xhtml+xml,...` antes de `*/*`.
  if (accept.includes('application/json') && !accept.includes('text/html')) return false;
  return accept.includes('text/html');
}

oauthRouter.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json(metadadosRecurso());
});

oauthRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json(metadadosAutorizacao());
});

oauthRouter.get('/.well-known/jwks.json', wrap(async (_req, res) => {
  res.json(await jwks());
}));

/** Registro dinâmico RFC 7591 restrito aos callbacks oficiais do ChatGPT. */
oauthRouter.post('/oauth/register', wrap(async (req, res) => {
  limitarRegistroDinamico(req);
  const cliente = await registrarClienteDinamico(req.body ?? {});
  res.status(201).json(cliente);
}));

/** Script estático same-origin da ponte OAuth (`script-src 'self'`, zero inline/eval). */
oauthRouter.get('/oauth/authorize/bridge.js', (_req, res) => {
  cabecalhosSemCache(res);
  res.type('application/javascript; charset=utf-8').status(200).send(SCRIPT_OAUTH_BRIDGE);
});

/**
 * Resumo autenticado para a tela de consentimento da ponte.
 * Requer `Bearer` da sessão do ERP; devolve aplicação, usuário autenticado e
 * escopos filtrados pelo servidor. Não grava consentimento nem gera código.
 */
oauthRouter.get('/oauth/authorize/session', requireAuth, wrap(async (req, res) => {
  cabecalhosSemCache(res);
  const validada = await validarSolicitacaoAutorizacao(req.query as Record<string, unknown>);
  const u = currentUser(req);
  exigirUsuarioNaoPortalRepresentante(u);
  const exigeReauth =
    validada.escopos.includes(SCOPES.workflowRequest) || validada.escopos.includes(SCOPES.workflowApprove);

  res.status(200).json({
    ok: true,
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      perfil: u.perfil,
    },
    consent: {
      client_id: validada.cliente.client_id,
      application: validada.cliente.nome,
      scopes: validada.escopos,
      actions: validada.escopos.map((s) => ACAO_POR_ESCOPO[s] ?? s),
      permissions: validada.escopos.map((s) => ({
        scope: s,
        description: ACAO_POR_ESCOPO[s] ?? s,
      })),
      requires_reauth: exigeReauth,
      consent_expires_in: Number(process.env.OAUTH_REFRESH_TTL_SECONDS ?? 30 * 24 * 3600),
    },
  });
}));

/**
 * Confirmação explícita de consentimento pela ponte autenticada.
 * Exige `requireAuth` (Bearer HS256 do ERP) + integridade same-origin anti-CSRF.
 * Revalida TODOS os parâmetros OAuth/PKCE no servidor, registra consentimento e
 * auditoria, cria código opaco de uso único e devolve `redirect_to` validado
 * para navegação de documento (`window.location.replace`).
 */
oauthRouter.post('/oauth/authorize/consent', requireAuth, wrap(async (req, res) => {
  cabecalhosSemCache(res);
  exigirIntegridadeSameOrigin(req);
  const validada = await validarSolicitacaoAutorizacao((req.body ?? {}) as Record<string, unknown>);
  const u = currentUser(req);
  const redirectTo = await concederConsentimentoEEmitirCallback(req, u, validada);
  res.status(200).json({ ok: true, redirect_to: redirectTo });
}));

/**
 * Recusa explícita pelo usuário na ponte.
 * NUNCA grava consentimento e NUNCA emite código. Só constrói `redirect_to`
 * com `error=access_denied` se `client_id` + `redirect_uri` corresponderem por
 * igualdade exata a um cliente registrado (impede open redirect na recusa).
 */
oauthRouter.post('/oauth/authorize/deny', wrap(async (req, res) => {
  cabecalhosSemCache(res);
  exigirIntegridadeSameOrigin(req);
  const corpo = (req.body ?? {}) as Record<string, unknown>;
  const clientId = String(corpo.client_id ?? '').trim();
  const redirectUri = String(corpo.redirect_uri ?? '');
  const state = corpo.state === undefined || corpo.state === null ? '' : String(corpo.state);

  const cliente = clientId ? await resolverCliente(clientId) : null;
  if (!cliente || !cliente.ativo || !redirectUriValida(cliente, redirectUri) || state.length > 1024) {
    throw new HttpError(400, 'Destino de cancelamento OAuth inválido.');
  }

  // Se houver sessão válida enviada opcionalmente, audita a recusa com o ator;
  // caso contrário, registra recusa sem conceder nada.
  await auditarOperacao({
    empresaId: 0,
    actorId: null,
    eventType: 'access.denied',
    payload: { origem: 'oauth_authorize_denied', client_id: cliente.client_id },
  });

  const destino = new URL(redirectUri);
  destino.searchParams.set('error', 'access_denied');
  destino.searchParams.set('error_description', 'O usuário recusou a solicitação de autorização.');
  if (state) destino.searchParams.set('state', state);
  res.status(200).json({ ok: true, redirect_to: destino.toString() });
}));

/**
 * Ponto de entrada `/oauth/authorize`:
 *   1. Com cabeçalho `Authorization` presente → fluxo programático/API direto:
 *      delega ao `requireAuth` (token ausente/inválido/expirado → 401 JSON).
 *      Sem `confirm=1`, devolve o JSON de consentimento; com `confirm=1`, emite
 *      o código pela mesma função canônica e responde 302 para `redirect_uri`.
 *   2. Sem `Authorization` e requisição de NAVEGAÇÃO HTML (`Accept: text/html`) →
 *      entrega a **OAuth Browser Authorization Bridge** na mesma origem do ERP:
 *        • se os parâmetros públicos (`client_id`, `redirect_uri`, PKCE S256,
 *          `response_type=code`, `resource`, `scope`) forem inválidos → HTTP 400
 *          com página segura de erro (sem open redirect, sem código);
 *        • se válidos → HTTP 200 HTML estático da ponte (sem conceder autorização).
 *   3. Sem `Authorization` e cliente não-HTML (`Accept: application/json` etc.) →
 *      responde 401 JSON (`Não autenticado`).
 */
oauthRouter.get('/oauth/authorize', (req, res, next) => {
  const temAuthHeader = Boolean(String(req.headers.authorization ?? '').trim());
  if (temAuthHeader) {
    return void requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      void processarAuthorizeAutenticado(req, res).catch(next);
    });
  }

  if (!clientePedeHtml(req)) {
    cabecalhosSemCache(res);
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }

  // Navegação de navegador sem Bearer: entrega a ponte HTML (nunca emite código aqui).
  void entregarPaginaBridge(req, res).catch(next);
});

async function entregarPaginaBridge(req: Request, res: Response): Promise<void> {
  cabecalhosSemCache(res);
  // Nunca aceitar `confirm=1` sem Bearer: mesmo que alguém abra `/oauth/authorize?confirm=1`
  // no navegador, a rota pública apenas renderiza a ponte e exige confirmação via POST autenticado.
  try {
    const validada = await validarSolicitacaoAutorizacao(req.query as Record<string, unknown>);
    const html = renderizarPaginaBridge({
      ok: true,
      applicationName: validada.cliente.nome,
      clientId: validada.cliente.client_id,
      scopes: validada.escopos.map((s) => ({
        scope: s,
        description: ACAO_POR_ESCOPO[s] ?? s,
      })),
    });
    res.status(200).type('text/html; charset=utf-8').send(html);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    const msg = e instanceof HttpError ? e.message : 'Parâmetros de autorização OAuth inválidos.';
    const html = renderizarPaginaBridge({
      ok: false,
      errorMessage: msg,
    });
    res.status(status >= 400 && status < 600 ? status : 400).type('text/html; charset=utf-8').send(html);
  }
}

async function processarAuthorizeAutenticado(req: Request, res: Response): Promise<void> {
  cabecalhosSemCache(res);
  const query = req.query as Record<string, unknown>;
  // No fluxo legado/direto com Bearer, code_challenge_method omitido assumia 'S256' SE code_challenge presente;
  // exigimos S256 explícito ou omitido apenas quando code_challenge válido está presente:
  const fonte: Record<string, unknown> = {
    ...query,
    code_challenge_method: query.code_challenge_method ?? (query.code_challenge ? 'S256' : ''),
  };
  const validada = await validarSolicitacaoAutorizacao(fonte);
  const u = currentUser(req);
  exigirUsuarioNaoPortalRepresentante(u);

  if (String(query.confirm ?? '') !== '1') {
    res.status(200).json({
      ok: true,
      consent: {
        client_id: validada.cliente.client_id,
        application: validada.cliente.nome,
        scopes: validada.escopos,
        actions: validada.escopos.map((s) => ACAO_POR_ESCOPO[s] ?? s),
        consent_expires_in: Number(process.env.OAUTH_REFRESH_TTL_SECONDS ?? 30 * 24 * 3600),
      },
    });
    return;
  }

  const destino = await concederConsentimentoEEmitirCallback(req, u, validada);
  res.redirect(destino);
}

/** Troca de código (PKCE) e refresh. Sem log de token. */
oauthRouter.post('/oauth/token', wrap(async (req, res) => {
  cabecalhosSemCache(res);
  validarResource(req.body?.resource);
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
  cabecalhosSemCache(res);
  const token = String(req.body?.token ?? '');
  const revogado = await revogarToken(token, String(req.body?.client_id ?? ''));
  await auditarOperacao({ empresaId: 0, actorId: null, eventType: 'oauth.token_revoked', payload: { revogado } });
  // RFC 7009: responde 200 mesmo quando o token é desconhecido.
  res.status(200).json({ ok: true });
}));

export { issuer };
