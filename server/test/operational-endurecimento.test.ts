// ============================================================================
// ENDURECIMENTO (auditoria F5/F6/F7) — paginação, cliente confidencial e
// limites explícitos do MemStore
//
// F5: `revogarTudoDoUsuario` (janela fixa de 1000) e `ultimoHash` (janela fixa
//     de 200) deixavam sobras válidas / encadeavam no hash errado em volumes
//     grandes. Aqui provamos > 1000 tokens e > 200 eventos.
// F6: `/oauth/token` autentica cliente confidencial (`client_secret_post`) e
//     recusa credencial ausente/incorreta; cliente público dispensa segredo.
// F7: o MemStore NÃO reproduz as garantias de concorrência do PostgreSQL — o
//     teste torna isso EXPLÍCITO (a autoridade de idempotência é o índice UNIQUE
//     do PG, provado em `pg-operational-control`).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const request = (await import('supertest')).default;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { HttpError } = await import('../src/errors');
const { hashPassword } = await import('../src/password');
const { revogarTudoDoUsuario, emitirAccessToken, validarAccessToken } = await import('../../modules/operational-control/oauth/tokens');
const { cadastrarCliente, autenticarCliente, resolverCliente } = await import('../../modules/operational-control/oauth/clients');
const { oauthRouter } = await import('../../modules/operational-control/oauth/routes');
const { auditarOperacao, verificarCadeiaOperacao } = await import('../../modules/operational-control/infrastructure/audit');
const { R_OAUTH_TOKENS, R_AUDIT_EVENTS } = await import('../../modules/operational-control/infrastructure/resources');
const { SCOPES } = await import('../../modules/operational-control/domain/scopes');

const store = getStore();
let seq = 0;
async function empresa(): Promise<number> {
  seq++;
  const r = await store.insert(RESOURCES.empresas, { nome: `H ${seq} ${Date.now()}` });
  return Number(r.id);
}
async function usuario(): Promise<number> {
  seq++;
  const r = await store.insert(RESOURCES.usuarios, { nome: `H ${seq}`, email: `h-${seq}-${Date.now()}@b.test`, perfil: 'admin', ativo: true });
  return Number(r.id);
}

// ---------------------------------------------------------------------------
// F5 — paginação
// ---------------------------------------------------------------------------
test('F5: revogarTudoDoUsuario revoga TODOS os tokens mesmo com > 1000 (paging completo)', async () => {
  const u = await usuario();
  const e = await empresa();
  const TOTAL = 1200;
  for (let i = 0; i < TOTAL; i++) {
    await store.insert(R_OAUTH_TOKENS, { jti: `jti-${u}-${i}`, client_id: 'c', usuario_id: u, empresa_id: e, scope: SCOPES.workflowRead, tipo: 'access', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  const n = await revogarTudoDoUsuario(u);
  assert.equal(n, TOTAL, `deveria revogar ${TOTAL}, revogou ${n}`);
  // Recontagem: nenhum token do usuário ficou sem revoked_at.
  const restantes = await store.list(R_OAUTH_TOKENS, { page: 1, pageSize: 5000, filter: { usuario_id: u } });
  assert.equal(restantes.rows.length, TOTAL);
  assert.equal(restantes.rows.filter((r) => !r.revoked_at).length, 0, 'nenhum token pode ficar válido');
});

test('F5: a cadeia global de auditoria acha o último evento global mesmo com > 200 eventos de operação depois', async () => {
  const e = await empresa();
  const u = await usuario();
  // 1 evento global (sem operação) — é o último da trilha GLOBAL desta empresa.
  await auditarOperacao({ empresaId: e, actorId: u, eventType: 'oauth.token_issued', payload: { marco: 'global' } });
  // Depois, MUITOS eventos de operação (operation_id != null) na mesma empresa.
  const opFake = 999999;
  for (let i = 0; i < 250; i++) {
    await auditarOperacao({ empresaId: e, operationId: opFake, actorId: u, eventType: 'access.denied', payload: { i } });
  }
  // Um segundo evento global DEVE encadear no primeiro global, não num de operação.
  await auditarOperacao({ empresaId: e, actorId: u, eventType: 'oauth.token_revoked', payload: { marco: 'global-2' } });

  const todos = await store.list(R_AUDIT_EVENTS, { page: 1, pageSize: 5000, sort: 'id', dir: 'asc', filter: { empresa_id: e } });
  const globais = todos.rows.filter((r) => r.operation_id === null || r.operation_id === undefined);
  assert.equal(globais.length, 2, 'deveria haver 2 eventos globais');
  assert.equal(globais[1].previous_hash, globais[0].event_hash, 'o 2º global encadeia no 1º global, não em um evento de operação');
});

// ---------------------------------------------------------------------------
// F6 — cliente confidencial
// ---------------------------------------------------------------------------
function appOAuth() {
  const app = express();
  app.use(express.json());
  app.use(oauthRouter);
  app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(erro instanceof HttpError ? erro.status : 500).json({ error: erro instanceof HttpError ? erro.message : 'Falha interna.' });
  });
  return app;
}

test('F6: cadastrar cliente confidencial sem secret_hash é recusado', async () => {
  await assert.rejects(() => cadastrarCliente({ clientId: `conf-${Date.now()}`, nome: 'X', redirectUris: ['https://x/cb'], scopes: [SCOPES.workflowRead], confidential: true }));
});

test('F6: autenticarCliente — público dispensa segredo; confidencial exige o correto', async () => {
  const publico = { client_id: 'p', nome: 'p', redirect_uris: ['https://x/cb'], scopes: [], confidential: false, secret_hash: null, ativo: true };
  assert.equal(await autenticarCliente(publico, undefined), true);

  const hash = await hashPassword('s3gredo-do-cliente');
  const confidencial = { client_id: 'c', nome: 'c', redirect_uris: ['https://x/cb'], scopes: [], confidential: true, secret_hash: hash, ativo: true };
  assert.equal(await autenticarCliente(confidencial, 's3gredo-do-cliente'), true);
  assert.equal(await autenticarCliente(confidencial, 'errado'), false);
  assert.equal(await autenticarCliente(confidencial, undefined), false);
  assert.equal(await autenticarCliente(confidencial, ''), false);
});

test('F6: POST /oauth/token recusa cliente confidencial sem/with credencial errada e aceita a correta', async () => {
  const cid = `conf-http-${Date.now()}`;
  await cadastrarCliente({ clientId: cid, nome: 'Conf', redirectUris: ['https://x/cb'], scopes: [SCOPES.workflowRead], confidential: true, secretHash: await hashPassword('certo-123') });
  const app = appOAuth();
  // Sem segredo e com segredo errado: 401 (fail-closed). A troca em si falharia
  // por código inválido, então provamos que a autenticação do cliente barra ANTES.
  const sem = await request(app).post('/oauth/token').send({ grant_type: 'authorization_code', client_id: cid, code: 'x', redirect_uri: 'https://x/cb', code_verifier: 'y' });
  assert.equal(sem.status, 401);
  const errado = await request(app).post('/oauth/token').send({ grant_type: 'authorization_code', client_id: cid, client_secret: 'errado', code: 'x', redirect_uri: 'https://x/cb', code_verifier: 'y' });
  assert.equal(errado.status, 401);
  // Com o segredo correto, a autenticação passa e a falha passa a ser o CÓDIGO (400/401 de código, não 401 de credencial).
  const certo = await request(app).post('/oauth/token').send({ grant_type: 'authorization_code', client_id: cid, client_secret: 'certo-123', code: 'inexistente', redirect_uri: 'https://x/cb', code_verifier: 'y' });
  assert.equal(certo.status, 401);
  assert.match(String(certo.body.error), /Código de autorização inválido/, 'com credencial válida, o erro passa a ser do código, não do cliente');
});

test('F6: cliente público continua trocando sem segredo (nenhuma credencial exigida)', async () => {
  const cid = `pub-${Date.now()}`;
  await cadastrarCliente({ clientId: cid, nome: 'Pub', redirectUris: ['https://x/cb'], scopes: [SCOPES.workflowRead] });
  const cli = await resolverCliente(cid);
  assert.equal(await autenticarCliente(cli!, undefined), true);
});

// ---------------------------------------------------------------------------
// F7 — limite explícito do MemStore (não é a autoridade de concorrência)
// ---------------------------------------------------------------------------
test('F7: MemStore NÃO garante unicidade de idempotência (a autoridade é o índice UNIQUE do PostgreSQL)', async () => {
  const e = await empresa();
  const u = await usuario();
  const chave = `k-${Date.now()}`;
  // Duas inserções cruas com a MESMA (empresa_id, idempotency_key): o MemStore
  // aceita as duas. No PostgreSQL o índice `uq_operational_operations_idempotencia`
  // recusa a segunda (provado em `pg-operational-control.test.ts`).
  const base = { empresa_id: e, operation_type: 'diagnostic.read_only', workflow_key: 'neon-production-diagnostic', requested_by: u, parameters_hash: 'h', reason: 'r', idempotency_key: chave, expires_at: new Date(Date.now() + 3600_000).toISOString() };
  await store.insert(RESOURCES.operational_operations, { public_id: `op_${Math.random().toString(36).slice(2)}`, ...base });
  await store.insert(RESOURCES.operational_operations, { public_id: `op_${Math.random().toString(36).slice(2)}`, ...base });
  const linhas = await store.list(RESOURCES.operational_operations, { page: 1, pageSize: 10, filter: { empresa_id: e, idempotency_key: chave } });
  assert.equal(linhas.rows.length, 2, 'o MemStore NÃO impõe a unicidade — por isso a garantia de produção é o PG');
});

// ---------------------------------------------------------------------------
// Revogação efetiva (reforço): token revogado deixa de validar
// ---------------------------------------------------------------------------
test('revogação: após revogarTudoDoUsuario, o access token deixa de validar (401)', async () => {
  const e = await empresa();
  const u = await usuario();
  const { token } = await emitirAccessToken({ usuarioId: u, empresaId: e, clientId: 'c', scopes: [SCOPES.workflowRead] });
  assert.equal((await validarAccessToken(token)).ok, true);
  await revogarTudoDoUsuario(u);
  assert.equal((await validarAccessToken(token)).ok, false, 'o token revogado não pode mais validar');
});

// Silencia a varredura ociosa de cadeia (o helper existe para o teste acima).
void verificarCadeiaOperacao;
