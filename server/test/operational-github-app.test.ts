import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.JWT_SECRET = 'local-test-secret-not-production';
const { resolverConfigGithubApp, salvarConfigGithubApp } = await import('../../modules/operational-control/infrastructure/token-vault');
const { GithubAppClient, assinarAppJwt } = await import('../../modules/operational-control/infrastructure/github-app.client');
const { gravarConfig, removerConfig } = await import('../src/configuracoes');
const { getStore } = await import('../src/services');
const { cifrarSegredo, decifrarSegredo } = await import('../src/segredos');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const cfg = { appId: '123', installationId: '456', privateKey: pem, webhookSecret: null };
const limparEnv = () => { delete process.env.GITHUB_APP_ID; delete process.env.GITHUB_APP_INSTALLATION_ID; delete process.env.GITHUB_APP_PRIVATE_KEY; };
const env = (key = pem) => { process.env.GITHUB_APP_ID = '123'; process.env.GITHUB_APP_INSTALLATION_ID = '456'; process.env.GITHUB_APP_PRIVATE_KEY = key; };
const apagar = async () => { limparEnv(); await removerConfig('operational_github_app'); };

test('vault real: ausência, vazio, PEM, precedência e fallback cifrado', async () => {
  await apagar();
  let r = await resolverConfigGithubApp();
  assert.equal(r.diagnostico.ambiente, 'ausente'); assert.equal(r.diagnostico.banco, 'registro_inexistente');
  env(''); r = await resolverConfigGithubApp(); assert.equal(r.diagnostico.ambiente, 'vazio');
  env('BEGIN PRIVATE KEY invalid'); r = await resolverConfigGithubApp(); assert.equal(r.diagnostico.ambiente, 'pem_invalido');
  env(pem.replace(/\n/g, '\\n')); r = await resolverConfigGithubApp();
  assert.equal(r.diagnostico.fonte, 'ambiente'); assert.equal(r.config?.privateKey, pem.trim());
  await salvarConfigGithubApp({ ...cfg, appId: '789' }, 'teste-local');
  assert.equal((await resolverConfigGithubApp()).config?.appId, '123');
  env('inválido'); r = await resolverConfigGithubApp(); assert.equal(r.config?.appId, '789'); assert.equal(r.diagnostico.fonte, 'banco');
  limparEnv(); r = await resolverConfigGithubApp(); assert.equal(r.config?.privateKey, pem.trim());
  await gravarConfig('operational_github_app', '{', 'teste-local');
  assert.equal((await resolverConfigGithubApp()).diagnostico.banco, 'json_invalido');
  await gravarConfig('operational_github_app', JSON.stringify({ app_id:'123', installation_id:'456', private_key:'v1.invalid.invalid.invalid' }), 'teste-local');
  assert.equal((await resolverConfigGithubApp()).diagnostico.banco, 'descriptografia_falhou');
  const store = getStore(); const original = store.findOneWhere;
  store.findOneWhere = async () => { throw new Error('não registrar esta mensagem'); };
  try { assert.equal((await resolverConfigGithubApp()).diagnostico.banco, 'leitura_falhou'); }
  finally { store.findOneWhere = original; await apagar(); }
});

test('cifra preserva leitura legado JWT e separação de domínio', () => {
  delete process.env.SEGREDOS_ENCRYPTION_KEY; delete process.env.APP_ENCRYPTION_KEY;
  const antigo = cifrarSegredo('dado de teste');
  process.env.SEGREDOS_ENCRYPTION_KEY = 'chave-dedicada-local-teste';
  try { assert.equal(decifrarSegredo(antigo), 'dado de teste'); }
  finally { delete process.env.SEGREDOS_ENCRYPTION_KEY; }
});

test('JWT RS256: emissor, assinatura e expiração', () => {
  const agora = Date.now(); const token = assinarAppJwt(cfg, agora);
  const payload = jwt.verify(token, pair.publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload;
  assert.equal(payload.iss, cfg.appId); assert.equal(payload.exp! - payload.iat!, 540);
});

test('cliente real usa vault; cache isolado, renovação e alteração de identidade', async () => {
  await apagar(); env(); let agora = Date.now(); let chamadas = 0;
  const client = new GithubAppClient({ agora: () => agora, fetchImpl: async (_url, init) => {
    chamadas++; assert.equal(init.method, 'POST');
    const bearer = String((init.headers as Record<string, string>).Authorization).slice(7);
    jwt.verify(bearer, pair.publicKey, { algorithms: ['RS256'], clockTimestamp: Math.floor(agora / 1000) });
    return Response.json({ token: `token-local-${chamadas}`, expires_at: new Date(agora + 3600_000).toISOString() });
  } });
  try {
    assert.equal(await client.installationToken(), 'token-local-1');
    assert.equal(await client.installationToken(), 'token-local-1');
    agora += 56 * 60_000; assert.equal(await client.installationToken(), 'token-local-2');
    process.env.GITHUB_APP_INSTALLATION_ID = '457'; assert.equal(await client.installationToken(), 'token-local-3');
    const segundo = new GithubAppClient({ fetchImpl: async () => { chamadas++; return Response.json({ token: 'outro-local', expires_at: new Date(Date.now() + 3600_000).toISOString() }); } });
    assert.equal(await segundo.installationToken(), 'outro-local'); assert.equal(chamadas, 4);
  } finally { await apagar(); }
});

test('respostas de instalação 401/403/404/422 e erro de rede não revelam corpo remoto', async () => {
  for (const status of [401, 403, 404, 422, 500]) {
    const client = new GithubAppClient({ config: cfg, fetchImpl: async () => Response.json({ message: 'MARCADOR_PRIVADO' }, { status }) });
    await assert.rejects(client.installationToken(), (e: Error & { codigo?: string }) => e.codigo === 'GITHUB_INDISPONIVEL' && !e.message.includes('MARCADOR_PRIVADO') && e.message.includes(String(status)));
  }
  const client = new GithubAppClient({ config: cfg, fetchImpl: async () => { throw new Error('MARCADOR_PRIVADO'); } });
  await assert.rejects(client.installationToken(), (e: Error) => !e.message.includes('MARCADOR_PRIVADO'));
});

test('401 no recurso renova uma vez; timeout distinto', async () => {
  let tokens = 0; let requests = 0;
  const client = new GithubAppClient({ config: cfg, fetchImpl: async (url, init) => {
    if (url.includes('access_tokens')) return Response.json({ token: `t${++tokens}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    requests++; return Response.json({}, { status: requests === 1 ? 401 : 200 });
  } });
  assert.equal((await client.comInstalacao('/resource')).status, 200); assert.equal(tokens, 2);
  process.env.GITHUB_API_TIMEOUT_MS = '100';
  try {
    const slow = new GithubAppClient({ config: cfg, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('privado')))) });
    await assert.rejects(slow.installationToken(), /timeout/);
  } finally { delete process.env.GITHUB_API_TIMEOUT_MS; }
});
