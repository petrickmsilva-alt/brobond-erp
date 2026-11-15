import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.OAUTH_CODE_TTL_SECONDS = '90';
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { signToken } = await import('../src/auth');
const { oauthRouter } = await import('../../modules/operational-control/oauth/routes');
const { cadastrarCliente } = await import('../../modules/operational-control/oauth/clients');
const { derivarChallenge, hashCodigo } = await import('../../modules/operational-control/oauth/codes');
const store = getStore();
const app = express();
app.use(express.json(), oauthRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: err.message }));
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const client = 'consent-regression';
const scopeA = 'brobond:system:read';
const scopeB = 'brobond:audit:read';
const verifier = 'verifier-de-regressao-com-mais-de-43-caracteres-12345';

async function session(empresaId: number) {
  const row = await store.insert(RESOURCES.usuarios, { nome: 'Consent test', email: `${randomUUID()}@brobond.test`, perfil: 'admin', ativo: true, empresa_id: empresaId });
  await store.insert(RESOURCES.usuario_empresas, { usuario_id: row.id, empresa_id: empresaId });
  const sid = randomUUID();
  await store.criarSessao({ id: sid, usuario_id: Number(row.id), expira_em: new Date(Date.now() + 3600000).toISOString(), ip: null, user_agent: null });
  return { id: Number(row.id), token: signToken({ id: Number(row.id), name: 'Consent test', perfil: 'admin' }, { sid, emp: empresaId }) };
}
function authorize(token: string, scope = scopeA) {
  return request(app).get('/oauth/authorize').set('Authorization', `Bearer ${token}`).query({ client_id: client, redirect_uri: redirect, scope, confirm: '1', state: 'original', code_challenge_method: 'S256', code_challenge: derivarChallenge(verifier) });
}
function exchange(code: string, codeVerifier = verifier) {
  return request(app).post('/oauth/token').send({ grant_type: 'authorization_code', client_id: client, redirect_uri: redirect, code, code_verifier: codeVerifier });
}

test('authorize: repetições, isolamento, concorrência, falha fechada, auditoria e PKCE/TTL', async (t) => {
  await cadastrarCliente({ clientId: client, nome: 'Consent regression', redirectUris: [redirect], scopes: [scopeA, scopeB] });
  const emp = await store.insert(RESOURCES.empresas, { nome: 'Consent A' });
  const empB = await store.insert(RESOURCES.empresas, { nome: 'Consent B' });
  const user = await session(Number(emp.id));
  const other = await session(Number(emp.id));
  const otherCompany = await session(Number(empB.id));
  const consent = () => store.findOneWhere(RESOURCES.oauth_consents, { usuario_id: user.id, client_id: client, empresa_id: emp.id, revoked_at: null });
  let firstId: unknown;
  await t.test('primeira cria e segunda atualiza sem 409, com auditoria em ambas', async () => {
    const first = await authorize(user.token, `${scopeA} ${scopeB}`).expect(302);
    assert.ok(new URL(first.headers.location).searchParams.get('code'));
    firstId = (await consent())?.id;
    const second = await authorize(user.token, scopeB).expect(302);
    assert.equal(new URL(second.headers.location).searchParams.get('state'), 'original');
    assert.equal((await consent())?.id, firstId);
    assert.equal((await consent())?.scope, scopeB);
    const audit = await store.list(RESOURCES.operational_audit_events, { page: 1, pageSize: 100, sort: 'id', dir: 'asc', filter: { actor_id: user.id, event_type: 'oauth.consent' } });
    assert.equal(audit.rows.length, 2);
    assert.deepEqual((audit.rows[1].payload as { scopes: string[] }).scopes, [scopeB]);
  });
  await t.test('usuários e empresas independentes; mesmo usuário em outra empresa', async () => {
    await authorize(other.token).expect(302);
    await authorize(otherCompany.token).expect(302);
    await store.saveOAuthConsent(user.id, client, Number(empB.id), scopeA);
    assert.equal((await consent())?.scope, scopeB);
    assert.equal(await store.countWhere(RESOURCES.oauth_consents, { client_id: client }), 4);
  });
  await t.test('autorizações concorrentes criam somente um ativo', async () => {
    const concurrent = await session(Number(emp.id));
    await Promise.all(Array.from({ length: 12 }, () => authorize(concurrent.token).expect(302)));
    assert.equal(await store.countWhere(RESOURCES.oauth_consents, { usuario_id: concurrent.id, client_id: client, revoked_at: null }), 1);
  });
  await t.test('falha de persistência não emite código nem consent audit', async () => {
    const before = await store.countWhere(RESOURCES.oauth_authorization_codes, {});
    const audits = await store.countWhere(RESOURCES.operational_audit_events, { event_type: 'oauth.consent' });
    const original = store.saveOAuthConsent;
    store.saveOAuthConsent = async () => { throw new Error('persistence failed'); };
    try { await authorize(user.token).expect(500); } finally { store.saveOAuthConsent = original; }
    assert.equal(await store.countWhere(RESOURCES.oauth_authorization_codes, {}), before);
    assert.equal(await store.countWhere(RESOURCES.operational_audit_events, { event_type: 'oauth.consent' }), audits);
  });
  await t.test('troca exige S256, código de uso único e TTL configurado', async () => {
    const before = Date.now();
    const result = await authorize(user.token).expect(302);
    const code = new URL(result.headers.location).searchParams.get('code')!;
    const row = await store.findOneWhere(RESOURCES.oauth_authorization_codes, { code_hash: hashCodigo(code) });
    assert.ok(row);
    assert.equal(row.code_challenge_method, 'S256');
    assert.ok(new Date(String(row.expires_at)).getTime() >= before + 90000);
    assert.ok(new Date(String(row.expires_at)).getTime() <= Date.now() + 90000);
    await exchange(code, 'wrong-verifier').expect(500);
    await exchange(code).expect(200);
    await exchange(code).expect(500);
    const expired = await authorize(user.token).expect(302);
    const expiredCode = new URL(expired.headers.location).searchParams.get('code')!;
    const expiredRow = await store.findOneWhere(RESOURCES.oauth_authorization_codes, { code_hash: hashCodigo(expiredCode) });
    await store.update(RESOURCES.oauth_authorization_codes, Number(expiredRow!.id), { expires_at: new Date(Date.now() - 1).toISOString() });
    await exchange(expiredCode).expect(500);
    await request(app).get('/oauth/authorize').set('Authorization', `Bearer ${user.token}`).query({ client_id: client, redirect_uri: redirect, scope: scopeA, confirm: '1', code_challenge: verifier, code_challenge_method: 'plain' }).expect(500);
  });
  await t.test('revogado não é reativado ou apagado', async () => {
    await store.update(RESOURCES.oauth_consents, Number(firstId), { revoked_at: new Date().toISOString() });
    await authorize(user.token).expect(302);
    assert.notEqual((await consent())?.id, firstId);
    assert.ok((await store.get(RESOURCES.oauth_consents, Number(firstId)))?.revoked_at);
  });
});
