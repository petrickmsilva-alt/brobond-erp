// R-1 (Ordem integral, Fase 4.3) — autorização de TODAS as rotas de marketplace.
// LOCAL: store em memória; fetch global substituído por dublê (nenhuma chamada de rede).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const M: any = await import('../src/marketplace');
const L: any = await import('../src/loja');
const ler = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const ENV_KEYS = ['MERCADOLIVRE_TOKEN', 'WOOCOMMERCE_URL', 'WOOCOMMERCE_CK', 'WOOCOMMERCE_CS', 'WOOCOMMERCE_EMPRESA_ID'];
const envAnterior: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const fetchAnterior = globalThis.fetch;
test.after(() => {
  for (const k of ENV_KEYS) { if (envAnterior[k] === undefined) delete process.env[k]; else process.env[k] = envAnterior[k]; }
  globalThis.fetch = fetchAnterior;
});

function resDe() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
const usuario = (perfil: string, empresa = 1) => ({ id: 10, name: `u-${perfil}`, perfil, empresa_id: empresa, email: `${perfil}@x.test` });
async function chamar(fn: (req: any, res: any) => unknown, user: any, extra: Record<string, unknown> = {}) {
  const res = resDe();
  try { await fn({ user, query: {}, body: {}, headers: {}, ...extra }, res); return { res, erro: null as any }; }
  catch (e: any) { return { res, erro: e }; }
}
const statusDe = (r: { res: any; erro: any }) => r.erro?.status ?? r.res.statusCode;

test('GET /api/marketplace/status: só administrador; operador, gerente e financeiro recebem 403', async () => {
  process.env.MERCADOLIVRE_TOKEN = 'token-de-teste-nao-real';
  for (const perfil of ['operador', 'gerente', 'financeiro']) {
    const r = await chamar(M.marketplaceStatus, usuario(perfil));
    assert.equal(statusDe(r), 403, `${perfil}: 403`);
  }
  const adm = await chamar(M.marketplaceStatus, usuario('admin'));
  assert.equal(statusDe(adm), 200, 'admin consulta');
});

test('GET /api/marketplace/status: sem sessão não responde 200 nem expõe configuração', async () => {
  const r = await chamar(M.marketplaceStatus, undefined);
  assert.notEqual(statusDe(r), 200);
  assert.equal(JSON.stringify(r.res.body ?? {}).includes('url'), false);
});

test('GET /api/marketplace/loja/status: operador é recusado; gerente da empresa vinculada consulta', async () => {
  process.env.WOOCOMMERCE_URL = 'https://loja.exemplo.test';
  process.env.WOOCOMMERCE_CK = 'ck-de-teste';
  process.env.WOOCOMMERCE_CS = 'cs-de-teste';
  process.env.WOOCOMMERCE_EMPRESA_ID = '1';
  const op = await chamar(L.statusLoja, usuario('operador', 1));
  assert.equal(statusDe(op), 403, 'operador não consulta a integração');
  const ger = await chamar(L.statusLoja, usuario('gerente', 1));
  assert.equal(statusDe(ger), 200, 'gerente da empresa vinculada consulta');
  const outra = await chamar(L.statusLoja, usuario('gerente', 2));
  assert.equal(statusDe(outra), 404, 'gerente de outra empresa não vê a integração');
});

test('POST /api/marketplace/sincronizar: não devolve identificadores externos de pedidos', async () => {
  process.env.MERCADOLIVRE_TOKEN = 'token-de-teste-nao-real';
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ results: [{ id: 987654321, status: 'paid' }] }) })) as any;
  const r = await chamar(M.sincronizarPedidos, usuario('admin', 1), { body: { provider: 'mercadolivre' } });
  assert.equal(statusDe(r), 200);
  assert.equal(r.res.body.sincronizados, 1, 'contagem preservada');
  assert.equal(JSON.stringify(r.res.body).includes('987654321'), false, 'identificador externo não vai para a resposta');
  assert.equal('pedidos' in r.res.body, false, 'lista de pedidos não é devolvida');
});

test('POST /api/marketplace/sincronizar: gerente e operador recusados (regressão R-1)', async () => {
  process.env.MERCADOLIVRE_TOKEN = 'token-de-teste-nao-real';
  for (const perfil of ['gerente', 'operador']) {
    const r = await chamar(M.sincronizarPedidos, usuario(perfil, 1), { body: { provider: 'mercadolivre' } });
    assert.equal(statusDe(r), 403, `${perfil}: 403`);
  }
});

test('inventário: toda rota /api/marketplace está registrada depois da guarda de sessão', () => {
  const src = ler('../src/index.ts');
  const guarda = src.indexOf("app.use('/api', wrap(requireAuth));");
  assert.ok(guarda > 0, 'guarda de sessão localizada');
  const linhas = src.split('\n');
  const rotas = linhas
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /app\.(get|post|put|patch|delete)\('\/api\/marketplace/.test(l));
  assert.ok(rotas.length >= 5, 'inventário encontrou as rotas de marketplace');
  const posGuarda = src.slice(0, guarda).split('\n').length;
  for (const r of rotas) {
    assert.ok(r.i > posGuarda, `rota de marketplace antes da guarda: linha ${r.i}`);
  }
});
