// ============================================================================
// OAUTH 2.1 (Resource Server do MCP) — Authorization Code + PKCE S256
//
// Exercita o código REAL do Authorization Server com o MemStore: PKCE
// obrigatório, código de uso único, vínculo cliente/redirect/verifier, refresh
// com rotação, validação de assinatura/issuer/audience/expiração/revogação e os
// documentos de descoberta.
//
// O que este arquivo NÃO pode provar (e o teste `pg-operational-control` cobre
// no banco real) é a unicidade/índice parcial — aqui a garantia é a lógica.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const jwt = (await import('jsonwebtoken')).default;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { cadastrarCliente, resolverCliente, redirectUriValida, scopesPermitidosAoCliente } = await import('../../modules/operational-control/oauth/clients');
const { criarCodigo, consumirCodigo, derivarChallenge, pkceConfere } = await import('../../modules/operational-control/oauth/codes');
const { emitirAccessToken, emitirRefreshToken, trocarRefreshToken, validarAccessToken, revogarToken, issuer, audience, TTL_ACCESS_S } = await import('../../modules/operational-control/oauth/tokens');
const { obterChaves, jwks } = await import('../../modules/operational-control/oauth/keys');
const { metadadosRecurso, metadadosAutorizacao } = await import('../../modules/operational-control/oauth/metadata');
const { SCOPES, TODOS_OS_SCOPES } = await import('../../modules/operational-control/domain/scopes');
const { ehTokenOAuth, requisicaoComTokenOAuth, exigirConfirmacaoHumana } = await import('../../modules/operational-control/http/operational-control.middleware');
const { signToken } = await import('../src/auth');

const CLIENTE = 'chatgpt-client';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const VERIFIER = 'verifier-de-teste-com-43-caracteres-ou-mais-abcdefghij';

let seq = 0;
async function usuario(): Promise<number> {
  seq++;
  const row = await getStore().insert(RESOURCES.usuarios, { nome: `OAuth ${seq}`, email: `oauth-${seq}-${Date.now()}@brobond.test`, perfil: 'admin', ativo: true });
  return Number(row.id);
}
async function empresa(): Promise<number> {
  seq++;
  const row = await getStore().insert(RESOURCES.empresas, { nome: `OAuth Emp ${seq} ${Date.now()}` });
  return Number(row.id);
}

async function garantirCliente(): Promise<void> {
  const existe = await resolverCliente(CLIENTE);
  if (!existe) {
    await cadastrarCliente({
      clientId: CLIENTE,
      nome: 'ChatGPT (MCP)',
      redirectUris: [REDIRECT],
      scopes: [...TODOS_OS_SCOPES],
    });
  }
}

// ---------------------------------------------------------------------------
// 1) DESCOBERTA — metadados anunciam PKCE S256 e os escopos iniciais
// ---------------------------------------------------------------------------
test('descoberta: o Resource Server anuncia audience, AS e escopos; PKCE S256 é o único método', async () => {
  const rs = metadadosRecurso();
  assert.equal(rs.resource, audience());
  assert.deepEqual(rs.authorization_servers, [issuer()]);
  assert.deepEqual(rs.scopes_supported, [...TODOS_OS_SCOPES]);
  assert.deepEqual(rs.bearer_methods_supported, ['header']);

  const as = metadadosAutorizacao();
  assert.equal(as.issuer, issuer());
  assert.equal(as.token_endpoint, `${issuer()}/oauth/token`);
  assert.ok(String(as.jwks_uri).endsWith('/.well-known/jwks.json'));
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  // CIMD é anunciado SOMENTE quando habilitado (fail-closed): não se anuncia
  // capacidade inexistente. Sem `OAUTH_CIMD_ENABLED=true`, é `false`.
  assert.equal(as.client_id_metadata_document_supported, false);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none', 'client_secret_post']);
  // Nenhum escopo de escrita genérica existe no catálogo.
  assert.ok(!TODOS_OS_SCOPES.some((s) => /write|admin|execute|shell/.test(s)), 'não pode existir escopo genérico de escrita');
});

test('JWKS publica só a chave PÚBLICA (nunca o expoente privado `d`)', async () => {
  const doc = await jwks();
  assert.equal(doc.keys.length, 1);
  const k = doc.keys[0];
  assert.equal(k.kty, 'RSA');
  assert.equal(k.alg, 'RS256');
  assert.ok(typeof k.n === 'string' && typeof k.e === 'string');
  assert.ok(!('d' in k), 'o JWKS nunca inclui a chave privada');
});

// ---------------------------------------------------------------------------
// 2) PKCE S256 — obrigatório e conferido em tempo constante
// ---------------------------------------------------------------------------
test('PKCE: challenge = base64url(SHA-256(verifier)) e a conferência recusa verifier errado', () => {
  const challenge = derivarChallenge(VERIFIER);
  assert.equal(challenge, derivarChallenge(VERIFIER));
  assert.equal(pkceConfere(VERIFIER, challenge), true);
  assert.equal(pkceConfere('outro-verifier-qualquer-com-tamanho-suficiente-xxxxxx', challenge), false);
});

test('PKCE: challenge curta (não-S256) é recusada na criação do código', async () => {
  const uid = await usuario();
  const eid = await empresa();
  await assert.rejects(
    () => criarCodigo({ clientId: CLIENTE, usuarioId: uid, empresaId: eid, perfil: 'admin', redirectUri: REDIRECT, scope: SCOPES.githubRead, codeChallenge: 'curto' }),
    /PKCE/i
  );
});

// ---------------------------------------------------------------------------
// 3) CÓDIGO — uso único, vinculado a cliente/redirect/verifier
// ---------------------------------------------------------------------------
test('código: troca válida consome; reutilizar o mesmo código é CONFLITO', async () => {
  const uid = await usuario();
  const eid = await empresa();
  const codigo = await criarCodigo({ clientId: CLIENTE, usuarioId: uid, empresaId: eid, perfil: 'admin', redirectUri: REDIRECT, scope: `${SCOPES.githubRead} ${SCOPES.workflowRead}`, codeChallenge: derivarChallenge(VERIFIER) });

  const consumido = await consumirCodigo(codigo, CLIENTE, REDIRECT, VERIFIER);
  assert.equal(consumido.usuarioId, uid);
  assert.equal(consumido.empresaId, eid);
  assert.equal(consumido.scope, `${SCOPES.githubRead} ${SCOPES.workflowRead}`);

  await assert.rejects(() => consumirCodigo(codigo, CLIENTE, REDIRECT, VERIFIER), /já foi utilizado/i);
});

test('código: verifier errado, cliente errado e redirect divergente são recusados', async () => {
  const uid = await usuario();
  const eid = await empresa();
  const novo = () => criarCodigo({ clientId: CLIENTE, usuarioId: uid, empresaId: eid, perfil: 'admin', redirectUri: REDIRECT, scope: SCOPES.auditRead, codeChallenge: derivarChallenge(VERIFIER) });

  await assert.rejects(async () => consumirCodigo(await novo(), CLIENTE, REDIRECT, 'verifier-errado-mas-com-tamanho-suficiente-xxxxxxxx'), /PKCE/i);
  await assert.rejects(async () => consumirCodigo(await novo(), 'outro-cliente', REDIRECT, VERIFIER), /outro cliente/i);
  await assert.rejects(async () => consumirCodigo(await novo(), CLIENTE, 'https://malicioso.example/cb', VERIFIER), /redirect_uri/i);
});

test('cliente: redirect_uri só passa por IGUALDADE EXATA e escopo pedido é subconjunto do concedido', async () => {
  await garantirCliente();
  const cliente = await resolverCliente(CLIENTE);
  assert.ok(cliente);
  assert.equal(redirectUriValida(cliente!, REDIRECT), true);
  // Prefixo/variação não passa: fecha o open redirect.
  assert.equal(redirectUriValida(cliente!, `${REDIRECT}?extra=1`), false);
  assert.equal(redirectUriValida(cliente!, 'https://chatgpt.com/'), false);
  // Escopo fora do concedido ao cliente é filtrado (nunca amplia).
  assert.deepEqual(scopesPermitidosAoCliente(cliente!, [SCOPES.githubRead, 'brobond:write:all']), [SCOPES.githubRead]);
});

// ---------------------------------------------------------------------------
// 4) ACCESS TOKEN — assinatura, issuer, audience, expiração e revogação
// ---------------------------------------------------------------------------
test('access token: RS256 válido é aceito; token de outro audience é recusado', async () => {
  const uid = await usuario();
  const eid = await empresa();
  const { token } = await emitirAccessToken({ usuarioId: uid, empresaId: eid, clientId: CLIENTE, scopes: [SCOPES.githubRead] });

  const ok = await validarAccessToken(token);
  assert.equal(ok.ok, true);
  assert.equal(ok.claims?.sub, `user:${uid}`);
  assert.equal(ok.claims?.aud, audience());
  assert.equal(ok.claims?.iss, issuer());
  assert.equal(ok.claims?.emp, eid);

  // Assinado com a MESMA chave, mas para OUTRO recurso → audience não confere.
  const chaves = await obterChaves();
  const errado = jwt.sign({ iss: issuer(), sub: `user:${uid}`, aud: 'https://outro.servico/api', client_id: CLIENTE, scope: SCOPES.githubRead, jti: 'x', emp: eid }, chaves.privateKey, { algorithm: 'RS256', keyid: chaves.kid });
  const v = await validarAccessToken(errado);
  assert.equal(v.ok, false);
  assert.equal(v.motivo, 'audience');
});

test('access token: expirado e revogado são recusados', async () => {
  const uid = await usuario();
  const eid = await empresa();
  const { token, jti } = await emitirAccessToken({ usuarioId: uid, empresaId: eid, clientId: CLIENTE, scopes: [SCOPES.auditRead] });
  assert.ok(TTL_ACCESS_S > 0 && TTL_ACCESS_S <= 3600, 'o access token é curto (≤ 1h)');

  const chaves = await obterChaves();
  const expirado = jwt.sign({ iss: issuer(), sub: `user:${uid}`, aud: audience(), client_id: CLIENTE, scope: SCOPES.auditRead, jti, emp: eid }, chaves.privateKey, { algorithm: 'RS256', expiresIn: -10 });
  const vExp = await validarAccessToken(expirado);
  assert.equal(vExp.ok, false);
  assert.equal(vExp.motivo, 'expirado');

  assert.equal(await revogarToken(token, CLIENTE), true);
  const vRev = await validarAccessToken(token);
  assert.equal(vRev.ok, false);
  assert.equal(vRev.motivo, 'revogado');
});

// ---------------------------------------------------------------------------
// 5) REFRESH — rotação invalida o anterior
// ---------------------------------------------------------------------------
test('refresh: a troca devolve novo par e REVOGA o refresh usado', async () => {
  const uid = await usuario();
  const eid = await empresa();
  const refresh = await emitirRefreshToken({ usuarioId: uid, empresaId: eid, clientId: CLIENTE, scopes: [SCOPES.githubRead] });

  const par = await trocarRefreshToken(refresh.token, CLIENTE);
  assert.ok(par.access_token && par.refresh_token);
  assert.notEqual(par.refresh_token, refresh.token);
  assert.equal((await validarAccessToken(par.access_token)).ok, true);

  await assert.rejects(() => trocarRefreshToken(refresh.token, CLIENTE), /inválido ou expirado/i);
});

// ---------------------------------------------------------------------------
// 6) ROTEAMENTO DE IDENTIDADE — RS256 (OAuth) × HS256 (sessão do ERP)
// ---------------------------------------------------------------------------
test('roteamento: o Bearer RS256 vai para o OAuth; o JWT de sessão (HS256) NÃO', () => {
  const sessao = signToken({ id: 1, name: 'Diretor', email: 'd@brobond.test', perfil: 'admin' } as never, { sid: 's1' });
  assert.equal(ehTokenOAuth(sessao), false, 'a sessão do ERP nunca cai no caminho OAuth');
  assert.equal(requisicaoComTokenOAuth({ headers: { authorization: `Bearer ${sessao}` } } as never), false);

  // Cabeçalho RS256 é reconhecido (a validação real é a assinatura).
  const falso = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.payload.sig`;
  assert.equal(ehTokenOAuth(falso), true);
  assert.equal(requisicaoComTokenOAuth({ headers: { authorization: `Bearer ${falso}` } } as never), true);
  assert.equal(ehTokenOAuth('sem-pontos'), false);
});

test('aprovação: um ator via MCP nunca satisfaz a confirmação humana', () => {
  const req = { operationalActor: { id: 1, name: 'x', perfil: 'admin', empresa_id: 1, scopes: [...TODOS_OS_SCOPES], viaMcp: true } } as never;
  assert.throws(() => exigirConfirmacaoHumana(req), /agente MCP não aprova|confirmação humana/i);
});
