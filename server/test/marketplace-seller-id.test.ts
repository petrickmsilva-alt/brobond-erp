// R-1 (Fase 4.3, item 13) — sincronização legada do Mercado Livre usa o seller_id REAL.
// LOCAL: fetch mockado; nada sai da máquina.
// Antes: a URL enviava o texto literal "seller=seller_id" (inválido para a API).
// Agora: primeiro /users/me (identidade do token), depois orders/search?seller=<id>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.MERCADOLIVRE_TOKEN = 'fixture-token-seller-000';
// Ordem Final 2.4: o token estático só é usado com contrato declarado para a empresa do administrador.
process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO = '1:contrato-teste-000';

const { sincronizarPedidos } = await import('../src/marketplace');

const admin = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1 };
function resDe() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
function mockFetch(t: any, identidade: { status: number; body: unknown }) {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    urls.push(url);
    if (url.includes('/users/me')) {
      return new Response(JSON.stringify(identidade.body), { status: identidade.status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ results: [{ id: 'PED-1', status: 'paid' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return urls;
}

test('usa o seller_id retornado por /users/me e nunca envia o literal "seller_id"', async (t) => {
  const urls = mockFetch(t, { status: 200, body: { id: 987654321 } });
  const res = resDe();
  await sincronizarPedidos({ user: admin, body: { provider: 'mercadolivre' }, headers: {}, query: {} } as any, res);
  const pedidos = urls.find((u) => u.includes('orders/search'));
  assert.ok(pedidos, 'a busca de pedidos deve ocorrer');
  assert.ok(pedidos!.includes('seller=987654321'), `seller real esperado na URL: ${pedidos}`);
  assert.ok(!urls.some((u) => u.includes('seller_id')), 'o literal seller_id não pode sair para a API');
  assert.equal(res.body?.provider, 'mercadolivre');
});

test('identidade indisponível: não busca pedidos com seller inventado', async (t) => {
  const urls = mockFetch(t, { status: 401, body: { message: 'invalid token' } });
  const res = resDe();
  await sincronizarPedidos({ user: admin, body: { provider: 'mercadolivre' }, headers: {}, query: {} } as any, res);
  assert.equal(urls.some((u) => u.includes('orders/search')), false, 'sem identidade não há busca de pedidos');
  assert.ok(!urls.some((u) => u.includes('seller_id')));
  assert.equal(res.body?.sincronizados ?? 0, 0);
});

test('o código-fonte não contém mais o literal seller=seller_id', () => {
  const fonte = readFileSync(fileURLToPath(new URL('../src/marketplace.ts', import.meta.url)), 'utf8');
  assert.equal(fonte.includes('seller=seller_id'), false);
});
