import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { registrarClienteDinamico } = await import('../../modules/operational-control/oauth/registration');
const { resolverCliente } = await import('../../modules/operational-control/oauth/clients');
const { metadadosAutorizacao } = await import('../../modules/operational-control/oauth/metadata');

const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';

test('DCR: registra cliente público ChatGPT com redirect exato e escopos limitados', async () => {
  const response = await registrarClienteDinamico({
    client_name: 'Brobond ERP ChatGPT',
    redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'brobond:system:read brobond:github:read brobond:workflow:read brobond:audit:read',
  });
  assert.match(response.client_id, /^chatgpt-[0-9a-f-]{36}$/);
  assert.deepEqual(response.redirect_uris, [callback]);
  assert.equal(response.token_endpoint_auth_method, 'none');
  const stored = await resolverCliente(response.client_id);
  assert.ok(stored);
  assert.equal(stored?.confidential, false);
  assert.deepEqual(stored?.redirect_uris, [callback]);
  assert.deepEqual(stored?.scopes, ['brobond:system:read', 'brobond:github:read', 'brobond:workflow:read', 'brobond:audit:read']);
});

test('DCR: recusa redirect fora do domínio ChatGPT e variantes inseguras', async () => {
  for (const uri of [
    'http://chatgpt.com/connector_platform_oauth_redirect',
    'https://evil.example/connector_platform_oauth_redirect',
    'https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.example',
    'https://chatgpt.com/other',
    'https://chatgpt.com/connector/oauth/callback/extra',
  ]) {
    await assert.rejects(() => registrarClienteDinamico({ redirect_uris: [uri] }), /redirect_uri/i);
  }
});

test('DCR: recusa grant, response type e autenticação de cliente não suportados', async () => {
  await assert.rejects(() => registrarClienteDinamico({ redirect_uris: [callback], grant_types: ['client_credentials'] }), /grant_types/i);
  await assert.rejects(() => registrarClienteDinamico({ redirect_uris: [callback], response_types: ['token'] }), /response_types/i);
  await assert.rejects(() => registrarClienteDinamico({ redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_post' }), /token_endpoint_auth_method/i);
});

test('DCR: padrão é somente leitura e escopos desconhecidos são recusados', async () => {
  const response = await registrarClienteDinamico({ redirect_uris: [callback] });
  assert.ok(response.scope.includes('brobond:system:read'));
  assert.ok(!response.scope.includes('brobond:workflow:request'));
  const authorizationOnly = await registrarClienteDinamico({ redirect_uris: [callback], grant_types: ['authorization_code'] });
  assert.deepEqual(authorizationOnly.grant_types, ['authorization_code']);
  await assert.rejects(() => registrarClienteDinamico({ redirect_uris: [callback], scope: 'brobond:system:read scope-inexistente' }), /escopo/i);
  await assert.rejects(() => registrarClienteDinamico({ redirect_uris: [callback], scope: 'brobond:workflow:request' }), /somente escopos de leitura/i);
});

test('descoberta OAuth: publica DCR sem declarar suporte global ao parâmetro iss', () => {
  const metadata = metadadosAutorizacao();
  assert.equal(metadata.registration_endpoint, `${metadata.issuer}/oauth/register`);
  assert.equal(metadata.authorization_response_iss_parameter_supported, false);
});
