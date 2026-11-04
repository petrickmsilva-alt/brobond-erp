// Ordem Final 2.4 — Mercado Livre: o token ESTÁTICO de instalação (MERCADOLIVRE_TOKEN) na rota legada
// /api/marketplace/sincronizar só é usado com contrato válido para a empresa do administrador.
// LOCAL: fetch interceptado; nada sai da máquina. Valores de token e referência são fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const M: any = await import('../src/marketplace');
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const s: any = getStore();

const TOKEN = 'fixture-token-estatico-contrato-000';
const REF = 'ref-contrato-fixture-99';
const ENV_KEYS = ['MERCADOLIVRE_TOKEN', 'MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO'];
const anterior: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
test.after(() => { for (const k of ENV_KEYS) { if (anterior[k] === undefined) delete process.env[k]; else process.env[k] = anterior[k]; } });

const admin = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1 };
const resDe = () => { const r: any = { statusCode: 200, body: undefined }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: unknown) => { r.body = b; return r; }; return r; };

function mockFetch(t: any) {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    urls.push(url);
    const corpo = url.includes('/users/me') ? { id: 424242 } : { results: [{ id: 'PED-X', status: 'paid' }] };
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return urls;
}
async function sincronizar(user: any) {
  const res = resDe();
  let erro: any = null;
  try { await M.sincronizarPedidos({ user, body: { provider: 'mercadolivre' }, headers: {}, query: {} } as any, res); } catch (e: any) { erro = e; }
  return { res, erro };
}

test('sem MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO: 409, nenhuma chamada ao Mercado Livre e auditoria da tentativa', async (t) => {
  process.env.MERCADOLIVRE_TOKEN = TOKEN;
  delete process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO;
  const urls = mockFetch(t);
  const { erro } = await sincronizar(admin);
  assert.equal(erro?.status, 409);
  assert.equal(urls.length, 0, 'nenhuma chamada externa sem contrato');
  assert.doesNotMatch(String(erro?.message), new RegExp(TOKEN));
  const audit = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 500, filter: { recurso: 'marketplace' } });
  const registro = audit.rows.find((r: any) => String(r.descricao || '').includes('bloqueada: token estático'));
  assert.ok(registro, 'tentativa bloqueada fica auditada');
  assert.ok(!JSON.stringify(registro).includes(TOKEN));
});

test('contrato de OUTRA empresa não serve: 409 sem chamada externa', async (t) => {
  process.env.MERCADOLIVRE_TOKEN = TOKEN;
  process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO = `2:${REF}`;
  const urls = mockFetch(t);
  const { erro } = await sincronizar(admin);
  assert.equal(erro?.status, 409);
  assert.equal(urls.length, 0);
});

test('contrato malformado (sem empresa, referência curta ou com espaço): 409 sem chamada externa', async (t) => {
  process.env.MERCADOLIVRE_TOKEN = TOKEN;
  for (const valor of [REF, '1:curto', '1: com-espaco-na-referencia', '1:', 'x:' + REF]) {
    process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO = valor;
    const urls = mockFetch(t);
    const { erro } = await sincronizar(admin);
    assert.equal(erro?.status, 409, `valor malformado deve bloquear: "${valor.replace(/[^:]/g, '*')}"`);
    assert.equal(urls.length, 0);
  }
});

test('contrato válido para a empresa do administrador: a rota legítima funciona (identidade + pedidos com seller real)', async (t) => {
  process.env.MERCADOLIVRE_TOKEN = TOKEN;
  process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO = `1:${REF}`;
  const urls = mockFetch(t);
  const { res, erro } = await sincronizar(admin);
  assert.equal(erro, null);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('/users/me'));
  assert.ok(urls[1].includes('orders/search?seller=424242'), 'seller vem de /users/me, não é literal');
  assert.equal(res.body?.sincronizados, 1);
});

test('a resposta e o status nunca expõem o token nem a referência do contrato', async (t) => {
  process.env.MERCADOLIVRE_TOKEN = TOKEN;
  process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO = `1:${REF}`;
  mockFetch(t);
  const { res } = await sincronizar(admin);
  assert.ok(!JSON.stringify(res.body).includes(TOKEN) && !JSON.stringify(res.body).includes(REF));
  const rs = resDe();
  M.marketplaceStatus({ user: admin, query: {}, body: {}, headers: {} } as any, rs);
  const st = rs.body;
  assert.equal(st.mercadolivre.contrato_token_estatico, true);
  assert.ok(!JSON.stringify(st).includes(TOKEN) && !JSON.stringify(st).includes(REF));
});

test('status sem contrato informa contrato_token_estatico=false sem vazar token', () => {
  process.env.MERCADOLIVRE_TOKEN = TOKEN;
  delete process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO;
  const rs = resDe();
  M.marketplaceStatus({ user: admin, query: {}, body: {}, headers: {} } as any, rs);
  assert.equal(rs.body.mercadolivre.contrato_token_estatico, false);
  assert.ok(!JSON.stringify(rs.body).includes(TOKEN));
});
