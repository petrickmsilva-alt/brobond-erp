// ============================================================================
// OAUTH 2.1 › BROWSER AUTHORIZATION BRIDGE + FLUXO COMPLETO CHATGPT REMOTE MCP
//
// Exercita a ponte de autorização do navegador, os controles OAuth 2.1 + PKCE
// S256, CSP, anti-CSRF, recusa de open redirect e a ponta final no Remote MCP
// (`/mcp` com RS256 e bloqueio de HS256 / ampliação de escopo).
//
// Utiliza o cliente confirmado da especificação:
//   • Client ID:   chatgpt-f3f259d5-c4b5-451c-b2de-0d5b79c0260b
//   • Nome:        Brobond ERP - Cliente de Teste
//   • Redirect:    https://chatgpt.com/connector_platform_oauth_redirect
//   • Escopos (4): brobond:system:read, brobond:github:read,
//                  brobond:workflow:read, brobond:audit:read
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.OAUTH_CODE_TTL_SECONDS = '120';

const { getStore, toHttpError } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { signToken, registrarReautenticacao, limparReautenticacao } = await import('../src/auth');
const { securityHeaders, PRINT_AGENT_LOOPBACK } = await import('../src/security');
const { oauthRouter } = await import('../../modules/operational-control/oauth/routes');
const { mcpRouter } = await import('../../modules/operational-control/mcp/server');
const { cadastrarCliente, resolverCliente } = await import('../../modules/operational-control/oauth/clients');
const { derivarChallenge, hashCodigo } = await import('../../modules/operational-control/oauth/codes');
const { SCOPES } = await import('../../modules/operational-control/domain/scopes');
const { audience } = await import('../../modules/operational-control/oauth/tokens');

const store = getStore();

const CLIENT_ID = 'chatgpt-f3f259d5-c4b5-451c-b2de-0d5b79c0260b';
const CLIENT_NAME = 'Brobond ERP - Cliente de Teste';
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const QUATRO_ESCOPOS = [
  SCOPES.systemRead,
  SCOPES.githubRead,
  SCOPES.workflowRead,
  SCOPES.auditRead,
] as const;
const VERIFIER = 'pkce-verifier-seguro-com-mais-de-43-caracteres-brobond-erp-2026';
const CHALLENGE = derivarChallenge(VERIFIER);

const app = express();
app.use(securityHeaders);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(oauthRouter);
app.use(mcpRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const httpErr = toHttpError(err);
  res.status(httpErr.status).json({
    error: httpErr.message,
    ...(httpErr.code ? { code: httpErr.code } : {}),
  });
});

async function garantirClienteConfirmado(): Promise<void> {
  const existente = await resolverCliente(CLIENT_ID);
  if (!existente) {
    await cadastrarCliente({
      clientId: CLIENT_ID,
      nome: CLIENT_NAME,
      redirectUris: [REDIRECT_URI],
      scopes: [...QUATRO_ESCOPOS],
      confidential: false,
    });
  }
}

async function criarSessaoErp(opts: {
  perfil?: 'admin' | 'gerente' | 'operador';
  expirada?: boolean;
  trocarSenha?: boolean;
  empresaId?: number;
} = {}) {
  const empRow = opts.empresaId
    ? { id: opts.empresaId }
    : await store.insert(RESOURCES.empresas, { nome: `Bridge Emp ${randomUUID()}` });
  const empresaId = Number(empRow.id);
  const email = `diretor-${randomUUID()}@brobond.test`;
  const userRow = await store.insert(RESOURCES.usuarios, {
    nome: 'Diretor Brobond',
    email,
    perfil: opts.perfil ?? 'admin',
    ativo: true,
    trocar_senha: opts.trocarSenha === true,
    empresa_id: empresaId,
  });
  const userId = Number(userRow.id);
  await store.insert(RESOURCES.usuario_empresas, { usuario_id: userId, empresa_id: empresaId });

  const sid = randomUUID();
  await store.criarSessao({
    id: sid,
    usuario_id: userId,
    expira_em: new Date(Date.now() + (opts.expirada ? -60_000 : 3_600_000)).toISOString(),
    ip: '127.0.0.1',
    user_agent: 'test',
  });

  const token = signToken(
    {
      id: userId,
      name: 'Diretor Brobond',
      email,
      perfil: opts.perfil ?? 'admin',
      ...(opts.trocarSenha ? { trocar_senha: true } : {}),
    },
    {
      sid,
      emp: empresaId,
      expiresIn: opts.expirada ? -10 : '1h',
    }
  );

  return { userId, empresaId, email, token, sid };
}

function queryPadrao(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: QUATRO_ESCOPOS.join(' '),
    state: 'state-chatgpt-xyz-987',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
  const limpo: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) limpo[k] = v;
  }
  return limpo;
}

// ---------------------------------------------------------------------------
// 1) AUTENTICAÇÃO E PONTE DO NAVEGADOR
// ---------------------------------------------------------------------------
test('ponte OAuth: acessível por navegação sem Bearer, sem conceder consentimento nem emitir código', async () => {
  await garantirClienteConfirmado();
  const codigosAntes = await store.countWhere(RESOURCES.oauth_authorization_codes, {});
  const consentimentosAntes = await store.countWhere(RESOURCES.oauth_consents, {});

  // Mesmo que alguém tente forçar `confirm=1` sem Bearer na barra de endereços,
  // a rota pública só entrega a ponte estática e NUNCA emite código.
  const res = await request(app)
    .get('/oauth/authorize')
    .set('Accept', 'text/html,application/xhtml+xml')
    .query({ ...queryPadrao(), confirm: '1' })
    .expect(200);

  assert.match(String(res.headers['content-type']), /^text\/html\b/i);
  assert.equal(res.headers.location, undefined, 'não pode redirecionar sem autenticação/consentimento');
  assert.match(String(res.headers['cache-control']), /no-store/i);
  assert.match(res.text, /oauth-bridge-root/);
  assert.match(res.text, /Brobond ERP - Cliente de Teste/);
  assert.match(res.text, /<script src="\/oauth\/authorize\/bridge\.js" defer><\/script>/);
  // Zero scripts inline e zero vazamento de segredos/tokens no HTML.
  const scripts = [...res.text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1].trim(), '', 'nenhum script inline é permitido pela CSP');
  assert.doesNotMatch(res.text, /brobond_token|Bearer\s+[A-Za-z0-9._-]+/i);

  assert.equal(await store.countWhere(RESOURCES.oauth_authorization_codes, {}), codigosAntes);
  assert.equal(await store.countWhere(RESOURCES.oauth_consents, {}), consentimentosAntes);
});

test('ponte OAuth: script bridge.js é JavaScript válido, same-origin, sem eval nem fetch externo', async () => {
  const res = await request(app).get('/oauth/authorize/bridge.js').expect(200);
  assert.match(String(res.headers['content-type']), /javascript/i);
  assert.match(String(res.headers['cache-control']), /no-store/i);
  assert.doesNotMatch(res.text, /\beval\s*\(|\bnew\s+Function\b/);
  assert.doesNotMatch(res.text, /https:\/\/chatgpt\.com/);
  // Compila sem erro de sintaxe e usa exclusivamente navegação de documento para o callback.
  assert.doesNotThrow(() => new vm.Script(res.text));
  assert.match(res.text, /window\.location\.replace\(res\.body\.redirect_to\)/);
});

test('autenticação: sessão válida reconhecida; ausente, inválida, expirada e senha provisória rejeitadas', async () => {
  await garantirClienteConfirmado();
  const valida = await criarSessaoErp();
  const expirada = await criarSessaoErp({ expirada: true });
  const provisoria = await criarSessaoErp({ trocarSenha: true });

  // Sem Bearer no endpoint de sessão → 401.
  await request(app).get('/oauth/authorize/session').query(queryPadrao()).expect(401);
  // Sem Bearer no endpoint de consentimento → 401.
  await request(app)
    .post('/oauth/authorize/consent')
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao())
    .expect(401);

  // Token inválido / malformado → 401.
  await request(app)
    .get('/oauth/authorize/session')
    .set('Authorization', 'Bearer token.invalido.aqui')
    .query(queryPadrao())
    .expect(401);
  await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', 'Bearer token.invalido.aqui')
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao())
    .expect(401);

  // Token expirado → 401 com mensagem segura.
  const resExp = await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${expirada.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao())
    .expect(401);
  assert.match(String(resExp.body.error), /expirad|novamente/i);

  // Sessão com troca obrigatória de senha provisória → 403 antes de conceder consentimento.
  await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${provisoria.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao())
    .expect(403);

  // Sessão válida → 200 com dados do usuário autenticado e os 4 escopos aprovados.
  const resOk = await request(app)
    .get('/oauth/authorize/session')
    .set('Authorization', `Bearer ${valida.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .query(queryPadrao())
    .expect(200);

  assert.equal(resOk.body.ok, true);
  assert.equal(resOk.body.user.id, valida.userId);
  assert.equal(resOk.body.user.email, valida.email);
  assert.equal(resOk.body.consent.application, CLIENT_NAME);
  assert.equal(resOk.body.consent.client_id, CLIENT_ID);
  assert.deepEqual(resOk.body.consent.scopes, [...QUATRO_ESCOPOS]);
  assert.equal(resOk.body.consent.permissions.length, 4);
  assert.equal(resOk.body.consent.requires_reauth, false);
});

// ---------------------------------------------------------------------------
// 2) CONSENTIMENTO, ESCOPOS E ANTI-CSRF
// ---------------------------------------------------------------------------
test('consentimento: exibe só os 4 escopos autorizados, filtra escopos de escrita/inválidos e cancelamento não emite código', async () => {
  await garantirClienteConfirmado();
  const sessao = await criarSessaoErp();

  // Tenta pedir escopos além dos 4 do cliente (workflow:request, workflow:approve e um inventado).
  const queryComExcesso = queryPadrao({
    scope: `${QUATRO_ESCOPOS.join(' ')} ${SCOPES.workflowRequest} ${SCOPES.workflowApprove} brobond:admin:write`,
  });

  const sessRes = await request(app)
    .get('/oauth/authorize/session')
    .set('Authorization', `Bearer ${sessao.token}`)
    .query(queryComExcesso)
    .expect(200);
  assert.deepEqual(sessRes.body.consent.scopes, [...QUATRO_ESCOPOS], 'nunca concede escopos fora do cliente registrado');

  // Cancelamento (recusa do usuário) → redireciona com error=access_denied + state, SEM código e SEM consentimento.
  const codigosAntes = await store.countWhere(RESOURCES.oauth_authorization_codes, {});
  const consentsAntes = await store.countWhere(RESOURCES.oauth_consents, { usuario_id: sessao.userId, client_id: CLIENT_ID });

  const denyRes = await request(app)
    .post('/oauth/authorize/deny')
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao({ state: 'estado-cancelado-123' }))
    .expect(200);

  const urlDeny = new URL(denyRes.body.redirect_to);
  assert.equal(`${urlDeny.origin}${urlDeny.pathname}`, REDIRECT_URI);
  assert.equal(urlDeny.searchParams.get('error'), 'access_denied');
  assert.equal(urlDeny.searchParams.get('state'), 'estado-cancelado-123');
  assert.equal(urlDeny.searchParams.get('code'), null);
  assert.equal(await store.countWhere(RESOURCES.oauth_authorization_codes, {}), codigosAntes);
  assert.equal(await store.countWhere(RESOURCES.oauth_consents, { usuario_id: sessao.userId, client_id: CLIENT_ID }), consentsAntes);

  // Cancelamento para redirect_uri não registrada → 400 (fecha open redirect na recusa).
  await request(app)
    .post('/oauth/authorize/deny')
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao({ redirect_uri: 'https://evil.example/cb' }))
    .expect(400);
});

test('anti-CSRF: POST /oauth/authorize/consent exige cabeçalho explícito da ponte e rejeita Origin/Sec-Fetch-Site externo', async () => {
  await garantirClienteConfirmado();
  const sessao = await criarSessaoErp();

  // Sem X-Brobond-OAuth-Bridge → 403.
  await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${sessao.token}`)
    .send(queryPadrao())
    .expect(403);

  // Com Sec-Fetch-Site: cross-site → 403.
  await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .set('Sec-Fetch-Site', 'cross-site')
    .send(queryPadrao())
    .expect(403);

  // Com Origin divergente do Host → 403.
  await request(app)
    .post('/oauth/authorize/consent')
    .set('Host', 'brobond-erp.onrender.com')
    .set('Origin', 'https://atacante.example')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao())
    .expect(403);

  // Com Origin igual ao Host + cabeçalho da ponte → 200 e emite exatamente 1 código.
  const antes = await store.countWhere(RESOURCES.oauth_authorization_codes, {});
  const ok = await request(app)
    .post('/oauth/authorize/consent')
    .set('Host', 'brobond-erp.onrender.com')
    .set('Origin', 'https://brobond-erp.onrender.com')
    .set('Sec-Fetch-Site', 'same-origin')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao())
    .expect(200);
  assert.equal(await store.countWhere(RESOURCES.oauth_authorization_codes, {}), antes + 1);
  assert.ok(new URL(ok.body.redirect_to).searchParams.get('code'));
});

test('consentimento repetido não provoca conflito (409) e escopos sensíveis exigem reautenticação quando permitidos ao cliente', async () => {
  await garantirClienteConfirmado();
  const sessao = await criarSessaoErp();

  const r1 = await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao())
    .expect(200);
  const r2 = await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao({ scope: `${SCOPES.systemRead} ${SCOPES.auditRead}` }))
    .expect(200);
  assert.notEqual(
    new URL(r1.body.redirect_to).searchParams.get('code'),
    new URL(r2.body.redirect_to).searchParams.get('code')
  );
  assert.equal(
    await store.countWhere(RESOURCES.oauth_consents, {
      usuario_id: sessao.userId,
      client_id: CLIENT_ID,
      empresa_id: sessao.empresaId,
      revoked_at: null,
    }),
    1
  );

  // Cliente administrativo separado que possui workflow:request → exige reautenticação recente.
  const cliSensivel = `internal-reauth-${randomUUID()}`;
  await cadastrarCliente({
    clientId: cliSensivel,
    nome: 'Cliente Interno Sensível',
    redirectUris: [REDIRECT_URI],
    scopes: [SCOPES.systemRead, SCOPES.workflowRequest],
  });
  limparReautenticacao(sessao.userId);
  const semReauth = await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao({ client_id: cliSensivel, scope: SCOPES.workflowRequest }))
    .expect(403);
  assert.equal(semReauth.body.code, 'reauth_necessaria');

  registrarReautenticacao(sessao.userId);
  await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao({ client_id: cliSensivel, scope: SCOPES.workflowRequest }))
    .expect(200);
  limparReautenticacao(sessao.userId);
});

// ---------------------------------------------------------------------------
// 3) OAUTH 2.1, PKCE S256, OPEN REDIRECT E CSP
// ---------------------------------------------------------------------------
test('OAuth + PKCE: valida state, ausente/preservado, PKCE S256 obrigatório, open redirect, resource, TTL e uso único', async () => {
  await garantirClienteConfirmado();
  const sessao = await criarSessaoErp();

  const postConsent = (overrides: Record<string, string | undefined>) =>
    request(app)
      .post('/oauth/authorize/consent')
      .set('Authorization', `Bearer ${sessao.token}`)
      .set('X-Brobond-OAuth-Bridge', '1')
      .send(queryPadrao(overrides));

  // state preservado exatamente; nenhum iss extra (authorization_response_iss_parameter_supported = false) e nenhum token na URL.
  const comState = await postConsent({ state: 'state-100%-intacto:abc_def' }).expect(200);
  const urlComState = new URL(comState.body.redirect_to);
  assert.equal(`${urlComState.origin}${urlComState.pathname}`, REDIRECT_URI);
  assert.equal(urlComState.searchParams.get('state'), 'state-100%-intacto:abc_def');
  assert.equal(urlComState.searchParams.get('iss'), null, 'não envia iss quando metadata anuncia false');
  assert.deepEqual([...urlComState.searchParams.keys()].sort(), ['code', 'state']);
  assert.ok(!comState.body.redirect_to.includes(sessao.token), 'token do ERP nunca aparece no callback');

  // state ausente: tratado conforme RFC 6749/OAuth 2.1 (sem acrescentar state vazio na URL).
  const semState = await postConsent({ state: undefined }).expect(200);
  const urlSemState = new URL(semState.body.redirect_to);
  assert.equal(urlSemState.searchParams.has('state'), false);
  assert.ok(urlSemState.searchParams.get('code'));

  // code_challenge ausente → 400 (tanto na ponte HTML quanto no consent POST).
  await postConsent({ code_challenge: undefined }).expect(400);
  await request(app)
    .get('/oauth/authorize')
    .set('Accept', 'text/html')
    .query(queryPadrao({ code_challenge: undefined }))
    .expect(400);

  // PKCE diferente de S256 (plain, vazio, inválido) → 400.
  await postConsent({ code_challenge_method: 'plain' }).expect(400);
  await postConsent({ code_challenge_method: '' }).expect(400);
  await postConsent({ code_challenge: 'curto-demais' }).expect(400);

  // Open redirect / redirect_uri divergente → 400 em todas as variações.
  for (const uriMaliciosa of [
    'https://evil.example/callback',
    'https://chatgpt.com/connector_platform_oauth_redirect/extra',
    'https://chatgpt.com/connector_platform_oauth_redirect?leak=1',
    'http://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
  ]) {
    await postConsent({ redirect_uri: uriMaliciosa }).expect(400);
    const htmlErr = await request(app)
      .get('/oauth/authorize')
      .set('Accept', 'text/html')
      .query(queryPadrao({ redirect_uri: uriMaliciosa }))
      .expect(400);
    assert.equal(htmlErr.headers.location, undefined);
  }

  // Resource inválido → 400; resource igual ao audience() → 200.
  await postConsent({ resource: 'https://outro.recurso/mcp' }).expect(400);
  await postConsent({ resource: audience() }).expect(200);

  // Troca no /oauth/token: verifier incorreto, redirect divergente, cliente errado, código expirado e código reutilizado.
  const emissao = await postConsent({}).expect(200);
  const code = new URL(emissao.body.redirect_to).searchParams.get('code')!;

  // Outro cliente registrado não pode trocar o código emitido para CLIENT_ID.
  const outroCliente = `outro-${randomUUID()}`;
  await cadastrarCliente({
    clientId: outroCliente,
    nome: 'Outro Cliente',
    redirectUris: [REDIRECT_URI],
    scopes: [SCOPES.systemRead],
  });
  await request(app)
    .post('/oauth/token')
    .send({
      grant_type: 'authorization_code',
      client_id: outroCliente,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: VERIFIER,
    })
    .expect(401);

  // Redirect divergente na troca → 401.
  await request(app)
    .post('/oauth/token')
    .send({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://chatgpt.com/outra',
      code,
      code_verifier: VERIFIER,
    })
    .expect(401);

  // code_verifier incorreto → 401.
  await request(app)
    .post('/oauth/token')
    .send({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: 'verifier-incorreto-mas-com-comprimento-valido-1234567890',
    })
    .expect(401);

  // Troca correta (inclusive application/x-www-form-urlencoded, formato padrão RFC 6749 usado pelo ChatGPT) → 200.
  const tokenRes = await request(app)
    .post('/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: VERIFIER,
    })
    .expect(200);

  assert.ok(tokenRes.body.access_token);
  assert.ok(tokenRes.body.refresh_token);
  assert.equal(tokenRes.body.token_type, 'Bearer');
  assert.equal(tokenRes.body.scope, QUATRO_ESCOPOS.join(' '));

  // Reutilização do mesmo código → 409 CONFLITO.
  await request(app)
    .post('/oauth/token')
    .send({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: VERIFIER,
    })
    .expect(409);

  // Código expirado (> 120s) → 401.
  const expEmissao = await postConsent({}).expect(200);
  const expCode = new URL(expEmissao.body.redirect_to).searchParams.get('code')!;
  const expRow = await store.findOneWhere(RESOURCES.oauth_authorization_codes, { code_hash: hashCodigo(expCode) });
  await store.update(RESOURCES.oauth_authorization_codes, Number(expRow!.id), {
    expires_at: new Date(Date.now() - 1_000).toISOString(),
  });
  await request(app)
    .post('/oauth/token')
    .send({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code: expCode,
      code_verifier: VERIFIER,
    })
    .expect(401);
});

test('CSP global permanece intacta e restritiva em todas as rotas da ponte OAuth', async () => {
  await garantirClienteConfirmado();
  const res = await request(app)
    .get('/oauth/authorize')
    .set('Accept', 'text/html')
    .query(queryPadrao())
    .expect(200);

  const csp = String(res.headers['content-security-policy'] ?? '');
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("form-action 'self'"));
  assert.ok(csp.includes("frame-ancestors 'self'"));
  assert.ok(csp.includes(PRINT_AGENT_LOOPBACK));
  assert.ok(!csp.includes('unsafe-inline') || !/script-src[^;]*unsafe-inline/.test(csp), 'script-src nunca tem unsafe-inline');
  assert.ok(!csp.includes('unsafe-eval'), 'nunca usa unsafe-eval');
  assert.ok(!csp.includes('chatgpt.com'), 'CSP global não foi flexibilizada para domínios de callback');
  // Nenhum wildcard solto (`*`) fora do subdomínio explícito `https://*.cloudinary.com` já existente.
  const semCloudinary = csp.replace(/https:\/\/\*\.cloudinary\.com/g, '');
  assert.ok(!semCloudinary.includes('*'), `CSP não pode conter wildcard genérico: ${csp}`);
});

// ---------------------------------------------------------------------------
// 4) PONTA A PONTA: PONTE → TOKEN RS256 → REMOTE MCP (somente leitura)
// ---------------------------------------------------------------------------
test('ponta a ponta: ponte emite code → ChatGPT troca por RS256 → MCP aceita leitura e nega escrita/HS256', async () => {
  await garantirClienteConfirmado();
  const sessao = await criarSessaoErp({ perfil: 'admin' });

  // 1. Navegador carrega a ponte.
  await request(app)
    .get('/oauth/authorize')
    .set('Accept', 'text/html')
    .query(queryPadrao({ state: 'e2e-chatgpt-state' }))
    .expect(200);

  // 2. Ponte valida sessão local e obtém os 4 escopos.
  const resumo = await request(app)
    .get('/oauth/authorize/session')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .query(queryPadrao({ state: 'e2e-chatgpt-state' }))
    .expect(200);
  assert.deepEqual(resumo.body.consent.scopes, [...QUATRO_ESCOPOS]);

  // 3. Diretor confirma na ponte → backend grava consentimento, audita e devolve callback validado.
  const confirmacao = await request(app)
    .post('/oauth/authorize/consent')
    .set('Authorization', `Bearer ${sessao.token}`)
    .set('X-Brobond-OAuth-Bridge', '1')
    .send(queryPadrao({ state: 'e2e-chatgpt-state' }))
    .expect(200);

  const callback = new URL(confirmacao.body.redirect_to);
  assert.equal(`${callback.origin}${callback.pathname}`, REDIRECT_URI);
  assert.equal(callback.searchParams.get('state'), 'e2e-chatgpt-state');
  const code = callback.searchParams.get('code')!;
  assert.ok(code && code.length >= 32);

  // 4. ChatGPT troca code + code_verifier no /oauth/token (sem client_secret, cliente público).
  const troca = await request(app)
    .post('/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: VERIFIER,
    })
    .expect(200);

  const oauthAccessToken = String(troca.body.access_token);

  // 5. Token HS256 da sessão do ERP NÃO pode autenticar o MCP.
  await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${sessao.token}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    .expect(401);

  // 6. Token RS256 OAuth autentica `initialize`, `tools/list` e chamadas de leitura.
  const initRes = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${oauthAccessToken}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    .expect(200);
  assert.equal(initRes.body.result.serverInfo.name, 'brobond-operational-control');

  const listRes = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${oauthAccessToken}`)
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    .expect(200);
  const toolNames: string[] = listRes.body.result.tools.map((t: { name: string }) => t.name);
  // Ferramentas de leitura presentes:
  for (const leitura of [
    'brobond_system_status',
    'brobond_database_status',
    'brobond_github_branches',
    'brobond_workflow_runs',
    'brobond_operations_list',
    'brobond_audit_history',
  ]) {
    assert.ok(toolNames.includes(leitura), `ferramenta de leitura esperada: ${leitura}`);
  }
  // Ferramenta de solicitação (`workflow.request`) NÃO aparece porque o cliente só tem os 4 escopos de leitura!
  assert.ok(
    !toolNames.includes('brobond_request_diagnostic'),
    'cliente com os 4 escopos de leitura não recebe brobond_request_diagnostic'
  );

  // Chamada de leitura funciona:
  const callRead = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${oauthAccessToken}`)
    .send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'brobond_database_status', arguments: {} } })
    .expect(200);
  assert.equal(callRead.body.result.isError, undefined);
  assert.equal(callRead.body.result.structuredContent.empresa_id, sessao.empresaId);

  // Tentativa direta de chamar `brobond_request_diagnostic` é NEGADA por falta de escopo `brobond:workflow:request`:
  const callRequest = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${oauthAccessToken}`)
    .send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'brobond_request_diagnostic', arguments: { reason: 'Tentativa sem escopo.' } },
    })
    .expect(200);
  assert.equal(callRequest.body.result.isError, true);
  assert.match(callRequest.body.result.content[0].text, /escopo/i);
});
