// ============================================================================
// OAUTH › DESCOBERTA `.well-known` POR HTTP REAL (hotfix pós-deploy do PR #142)
//
// Sintoma em produção: no navegador,
//   https://brobond-erp.onrender.com/.well-known/oauth-authorization-server
//   https://brobond-erp.onrender.com/.well-known/oauth-protected-resource
// abriam o dashboard do ERP em vez do documento JSON.
//
// Causa comprovada: o Express SEMPRE respondeu JSON (as rotas são registradas
// antes de `express.static` e do `app.get('*')`). Quem entregava o
// `index.html` era o Service Worker do PWA, cujo fallback de navegação só
// excluía `/api/`. O conserto está em `client/src/pwaRotasServidor.ts` e é
// exercitado, com o Service Worker real, em
// `client/src/pwaRotasServidor.test.ts`.
//
// Este arquivo trava o lado do SERVIDOR pela rede (servidor real, processo
// filho, sem seguir redirecionamentos) e o CONTRATO entre os dois lados: toda
// rota que o OAuth/MCP expõe na raiz precisa estar na lista que o Service
// Worker deixa passar. O mesmo roteiro roda em modo produção, com PostgreSQL
// e o fallback do SPA ativo, em `test/pg/oauth-well-known-producao.test.ts`.
// ============================================================================
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMINHO_AS, CAMINHO_RS, conferirDescoberta, exigirJsonDireto, obter, subirServidor, type ServidorDeTeste } from './_oauth-descoberta-http';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

// Configuração REAL do processo sob teste (valores de exemplo, não segredos).
const ISSUER = 'https://erp.brobond.example';
const RESOURCE = 'https://erp.brobond.example/mcp';

let servidor: ServidorDeTeste;

before(async () => {
  servidor = await subirServidor({ NODE_ENV: 'test', DATABASE_URL: undefined, OAUTH_ISSUER: ISSUER, OAUTH_RESOURCE: RESOURCE });
});
after(async () => {
  await servidor?.encerrar();
});

test('Authorization Server Metadata e Protected Resource Metadata: HTTP 200, application/json, JSON válido, issuer/resource da configuração', async () => {
  await conferirDescoberta(servidor.base, { issuer: ISSUER, resource: RESOURCE });
});

test('descoberta não redireciona (nem para "/") e não devolve o frontend, com Accept de navegador', async () => {
  for (const caminho of [CAMINHO_AS, CAMINHO_RS]) {
    const r = await obter(servidor.base, caminho);
    assert.ok(r.status < 300 || r.status >= 400, `${caminho}: veio redirecionamento HTTP ${r.status} para ${r.location}`);
    assert.equal(r.location, null, `${caminho}: cabeçalho Location presente`);
    exigirJsonDireto(r, caminho);
  }
});

test('descoberta é pública: não exige sessão do ERP nem Bearer', async () => {
  for (const caminho of [CAMINHO_AS, CAMINHO_RS]) {
    const r = await obter(servidor.base, caminho, { headers: { Accept: 'application/json' } });
    assert.equal(r.status, 200, `${caminho} sem credencial deve responder 200`);
  }
});

test('os controles do OAuth seguem ativos por HTTP: DCR restrito, authorize com sessão, token sem cliente recusado, MCP com Bearer', async () => {
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };

  // DCR (RFC 7591): callback fora da lista oficial é recusado — em JSON.
  const dcr = await obter(servidor.base, '/oauth/register', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ client_name: 'Intruso', redirect_uris: ['https://atacante.example/callback'] }),
  });
  assert.ok(dcr.status >= 400 && dcr.status < 500, `DCR com redirect_uri não oficial deve ser 4xx, veio ${dcr.status}`);
  assert.match(dcr.contentType, /^application\/json\b/i);

  // /oauth/authorize:
  //   • chamada JSON sem Bearer → 401 JSON;
  //   • navegação HTML sem Bearer com cliente desconhecido → 400 HTML da ponte
  //     (nunca o index.html do SPA e nunca emite código);
  //   • endpoint de confirmação POST /oauth/authorize/consent sem Bearer → 401 JSON.
  const authorizeJson = await obter(servidor.base, '/oauth/authorize?response_type=code&client_id=x&code_challenge=y&code_challenge_method=S256', {
    headers: { Accept: 'application/json' },
  });
  assert.equal(authorizeJson.status, 401);
  assert.equal(authorizeJson.location, null);
  assert.match(authorizeJson.contentType, /^application\/json\b/i);

  const authorizeHtml = await obter(servidor.base, '/oauth/authorize?response_type=code&client_id=x&code_challenge=y&code_challenge_method=S256');
  assert.equal(authorizeHtml.status, 400);
  assert.equal(authorizeHtml.location, null);
  assert.match(authorizeHtml.contentType, /^text\/html\b/i);
  assert.match(authorizeHtml.texto, /oauth-bridge-root/i);
  assert.doesNotMatch(authorizeHtml.texto, /<div id="root"/i);

  const consentSemAuth = await obter(servidor.base, '/oauth/authorize/consent', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ client_id: 'x' }),
  });
  assert.equal(consentSemAuth.status, 401);
  assert.match(consentSemAuth.contentType, /^application\/json\b/i);

  // /oauth/token sem cliente válido.
  const token = await obter(servidor.base, '/oauth/token', { method: 'POST', headers: json, body: JSON.stringify({ grant_type: 'authorization_code', client_id: 'inexistente' }) });
  assert.equal(token.status, 401);
  assert.match(token.contentType, /^application\/json\b/i);

  // MCP sem Bearer OAuth.
  const mcp = await obter(servidor.base, '/mcp', { method: 'POST', headers: json, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(mcp.status, 401);
  assert.match(mcp.contentType, /^application\/json\b/i);
});

test('contrato servidor × PWA: toda rota do OAuth/MCP na raiz está fora do fallback de navegação do Service Worker', async () => {
  const { oauthRouter } = await import('../../modules/operational-control/oauth/routes');
  const { mcpRouter } = await import('../../modules/operational-control/mcp/server');
  const { ROTAS_DO_SERVIDOR, ehRotaDoServidor } = await import('../../client/src/pwaRotasServidor');

  type Camada = { route?: { path: string | string[] } };
  const caminhos = [oauthRouter, mcpRouter]
    .flatMap((router) => (router as unknown as { stack: Camada[] }).stack)
    .flatMap((camada) => (camada.route ? [camada.route.path].flat() : []));

  // Controle: a enumeração enxerga as rotas (senão o laço abaixo passaria vazio).
  for (const obrigatoria of [
    CAMINHO_AS,
    CAMINHO_RS,
    '/.well-known/jwks.json',
    '/oauth/authorize',
    '/oauth/authorize/bridge.js',
    '/oauth/authorize/session',
    '/oauth/authorize/consent',
    '/oauth/authorize/deny',
    '/oauth/token',
    '/oauth/register',
    '/oauth/revoke',
    '/mcp',
  ]) {
    assert.ok(caminhos.includes(obrigatoria), `rota esperada não encontrada no router: ${obrigatoria}`);
  }
  for (const caminho of caminhos) {
    assert.ok(
      ehRotaDoServidor(caminho),
      `A rota "${caminho}" é servida pelo Express na raiz, mas o Service Worker do PWA responderia a navegação com o index.html. ` +
        'Inclua o prefixo em client/src/pwaRotasServidor.ts.'
    );
  }
  // A lista não pode engolir as telas do ERP.
  for (const tela of ['/', '/login', '/produtos', '/config', '/vendas/novo']) {
    assert.equal(ROTAS_DO_SERVIDOR.some((re) => re.test(tela)), false, `${tela} é tela do SPA`);
  }
});
