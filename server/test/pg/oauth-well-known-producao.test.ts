// ============================================================================
// OAUTH › DESCOBERTA `.well-known` EM MODO PRODUÇÃO (hotfix pós-deploy PR #142)
//
// Mesmo roteiro de `test/oauth-well-known-http.test.ts`, agora nas condições
// do deploy na Render:
//   • `NODE_ENV=production` — é só neste modo que o `index.ts` registra
//     `express.static` e o fallback `app.get('*')` que entrega o `index.html`;
//   • PostgreSQL REAL (banco descartável, cadeia de migrações completa);
//   • `TRUST_PROXY=1`, como no `render.yaml`.
//
// O que este arquivo prova: com o fallback do SPA LIGADO (há um controle que
// confirma o `index.html` numa rota qualquer do ERP), as rotas `.well-known`
// continuam respondendo JSON direto — sem cair no frontend e sem redirecionar.
// Ou seja, a ordem de registro no Express está correta e assim deve ficar.
//
// O lado do navegador (Service Worker do PWA, a causa real do incidente) é
// coberto em `client/src/pwaRotasServidor.test.ts`.
// ============================================================================
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { criarBancoDescartavel, destruirBancoDescartavel, type BancoDescartavel } from './_boot-harness';
import { CAMINHO_AS, CAMINHO_RS, SERVER_DIR, conferirDescoberta, exigirJsonDireto, obter, subirServidor, type ServidorDeTeste } from '../_oauth-descoberta-http';

const ISSUER = 'https://erp.brobond.example';
const RESOURCE = 'https://erp.brobond.example/mcp';

// O fallback do SPA lê `client/dist/index.html`. O gate `test:pg` não builda o
// front; quando o arquivo não existe, o teste cria uma casca mínima (e remove
// só o que criou) para que o fallback esteja de fato ATIVO durante a medição.
const DIST = path.resolve(SERVER_DIR, '../client/dist');
const INDEX = path.join(DIST, 'index.html');
let criouDist = false;
let criouIndex = false;

let banco: BancoDescartavel;
let servidor: ServidorDeTeste;

before(async () => {
  if (!existsSync(INDEX)) {
    criouDist = !existsSync(DIST);
    mkdirSync(DIST, { recursive: true });
    writeFileSync(INDEX, '<!doctype html><html lang="pt-BR"><head><title>BROBOND ERP</title></head><body><div id="root"></div></body></html>');
    criouIndex = true;
  }
  banco = await criarBancoDescartavel('oauthwk');
  servidor = await subirServidor(
    {
      NODE_ENV: 'production',
      DATABASE_URL: banco.url,
      // O PostgreSQL do gate não fala TLS (produção fala): só a conexão muda.
      PGSSL: 'false',
      TRUST_PROXY: '1',
      BOOT_HOLD_MS: '20000',
      OAUTH_ISSUER: ISSUER,
      OAUTH_RESOURCE: RESOURCE,
    },
    240_000
  );
});

after(async () => {
  await servidor?.encerrar();
  if (banco) await destruirBancoDescartavel(banco);
  if (criouDist) rmSync(DIST, { recursive: true, force: true });
  else if (criouIndex) rmSync(INDEX, { force: true });
});

test('controle: em produção o fallback do SPA está ATIVO (rota do ERP recebe o index.html)', async () => {
  const r = await obter(servidor.base, '/produtos/123/editar');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /^text\/html\b/i);
  assert.match(r.texto, /<!doctype html/i);
});

test('produção + PostgreSQL: os dois documentos de descoberta respondem JSON direto, com issuer/resource da configuração', async () => {
  await conferirDescoberta(servidor.base, { issuer: ISSUER, resource: RESOURCE });
});

test('produção: `.well-known` não cai no fallback do frontend nem redireciona para "/"', async () => {
  for (const caminho of [CAMINHO_AS, CAMINHO_RS]) {
    const r = await obter(servidor.base, caminho);
    assert.ok(r.status < 300 || r.status >= 400, `${caminho}: redirecionamento HTTP ${r.status} para ${r.location}`);
    assert.equal(r.location, null);
    exigirJsonDireto(r, caminho);
  }
});

test('produção: demais rotas do servidor na raiz não recebem o index.html', async () => {
  // GET /mcp → 405 JSON-RPC; /oauth/authorize (JSON) sem sessão → 401 JSON;
  // /oauth/authorize (navegação HTML) → ponte OAuth (nunca o index.html do SPA).
  const mcp = await obter(servidor.base, '/mcp');
  assert.equal(mcp.status, 405);
  assert.match(mcp.contentType, /^application\/json\b/i);
  const authorizeJson = await obter(servidor.base, '/oauth/authorize?response_type=code&client_id=x&code_challenge=y&code_challenge_method=S256', {
    headers: { Accept: 'application/json' },
  });
  assert.equal(authorizeJson.status, 401);
  assert.equal(authorizeJson.location, null);
  assert.match(authorizeJson.contentType, /^application\/json\b/i);

  const authorizeBridge = await obter(servidor.base, '/oauth/authorize?response_type=code&client_id=x&code_challenge=y&code_challenge_method=S256');
  assert.equal(authorizeBridge.status, 400);
  assert.equal(authorizeBridge.location, null);
  assert.match(authorizeBridge.contentType, /^text\/html\b/i);
  assert.match(authorizeBridge.texto, /oauth-bridge-root/i);
  assert.doesNotMatch(authorizeBridge.texto, /<div id="root"/i);
});
