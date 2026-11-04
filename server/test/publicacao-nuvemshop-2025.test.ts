// Migração Nuvemshop para o contrato 2025-03 (decisão (b) aprovada pelo Diretor).
// Testes LOCAIS com fetch simulado: não há rede, credencial real nem homologação.
// Contrato usado (documentação pública da plataforma, versão 2025-03):
//   base  https://api.tiendanube.com/2025-03/{store_id}
//   auth  Authorization: Bearer <token> + User-Agent obrigatório
//   POST /products (variants com price/stock/sku), GET /products/sku/{sku},
//   PATCH /products/stock-price ([{id, variants:[{id, price, inventory_levels:[{stock}]}]}]).
// Ordem Final 2.5: estes testes exercitam a LÓGICA do adapter com evidenciaOficialEscrita=true.
// A produção segue bloqueada (ESCRITA_NUVEMSHOP_2025_LIBERADA=false); ver nuvemshop-escrita-bloqueada.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { publicarItemNuvemshop, corpoCriacaoNuvemshop, BASE_NUVEMSHOP_2025 } = await import(
  '../src/commerce/publicacaoNuvemshop'
);
const { PublicacaoFalha } = await import('../src/commerce/publicacaoCanais');

type Chamada = { url: string; method: string; headers: Record<string, string>; body: any };

function fetchSimulado(respostas: Array<(c: Chamada) => Response | Promise<Response>>) {
  const chamadas: Chamada[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    const c: Chamada = {
      url,
      method: init?.method || 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    chamadas.push(c);
    const r = respostas[chamadas.length - 1];
    if (!r) throw new Error(`chamada inesperada #${chamadas.length}: ${c.method} ${url}`);
    return r(c);
  };
  return { fn: fn as any, chamadas };
}

const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
const item = (over: Partial<Parameters<typeof publicarItemNuvemshop>[1]> = {}) => ({
  sku: 'SKU-001',
  titulo: 'Camiseta Azul',
  descricao: 'Algodão',
  preco: 25.9,
  disponivel: 7,
  condicao: 'novo',
  ...over,
});
const BASE = `${BASE_NUVEMSHOP_2025}/9001`;

test('base 2025-03 é a documentada e não usa o contrato v1', () => {
  assert.equal(BASE_NUVEMSHOP_2025, 'https://api.tiendanube.com/2025-03');
});

test('sem SKU: recusa antes de qualquer chamada', async () => {
  const sim = fetchSimulado([]);
  await assert.rejects(
    publicarItemNuvemshop({ accessToken: 't', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim.fn }, item({ sku: ' ' }), null),
    (e: unknown) => e instanceof PublicacaoFalha && (e as PublicacaoFalha).rejeitada === true
  );
  assert.equal(sim.chamadas.length, 0);
});

test('sem vínculo e SKU inexistente: cria com POST 2025-03 (variants, preço em string, estoque, SKU)', async () => {
  const sim = fetchSimulado([
    () => json(404, { message: 'Not found' }),
    () => json(201, { id: 555, variants: [{ id: 777, sku: 'SKU-001' }] }),
  ]);
  const r = await publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim.fn }, item(), null);
  assert.deepEqual(r, { externalId: '555:777', operacao: 'criado' });
  assert.equal(sim.chamadas[0].method, 'GET');
  assert.equal(sim.chamadas[0].url, `${BASE}/products/sku/SKU-001`);
  const post = sim.chamadas[1];
  assert.equal(post.method, 'POST');
  assert.equal(post.url, `${BASE}/products`);
  assert.equal(post.body.name, 'Camiseta Azul');
  assert.deepEqual(post.body.variants, [{ price: '25.90', stock_management: true, stock: 7, sku: 'SKU-001' }]);
  assert.equal(post.headers.Authorization, 'Bearer tok');
  assert.equal(post.headers['User-Agent'], 'App (x@y.com)');
  assert.ok(sim.chamadas.every((c) => !c.url.includes('api.nuvemshop.com.br') && !c.url.includes('/v1/')));
});

test('vínculo existente (externalId "produto:variante"): atualiza com PATCH stock-price e não cria', async () => {
  const sim = fetchSimulado([() => json(200, [{ id: 555, variants: [{ id: 777, success: true }] }])]);
  const r = await publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim.fn }, item(), '555:777');
  assert.deepEqual(r, { externalId: '555:777', operacao: 'atualizado' });
  assert.equal(sim.chamadas.length, 1);
  assert.equal(sim.chamadas[0].method, 'PATCH');
  assert.equal(sim.chamadas[0].url, `${BASE}/products/stock-price`);
  assert.deepEqual(sim.chamadas[0].body, [
    { id: 555, variants: [{ id: 777, price: '25.90', inventory_levels: [{ stock: 7 }] }] },
  ]);
});

test('SKU já existe na loja sem vínculo: adota o produto existente (não duplica)', async () => {
  const sim = fetchSimulado([
    () => json(200, { id: 555, variants: [{ id: 777, sku: 'SKU-001' }] }),
    () => json(200, [{ id: 555, variants: [{ id: 777, success: true }] }]),
  ]);
  const r = await publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim.fn }, item(), null);
  assert.deepEqual(r, { externalId: '555:777', operacao: 'vinculado_por_sku' });
  assert.ok(!sim.chamadas.some((c) => c.method === 'POST'), 'não pode criar outro produto');
});

test('retry após timeout do POST: a próxima tentativa encontra o SKU e não cria de novo (P0-01)', async () => {
  // 1ª tentativa: lookup 404 → POST dá timeout (resposta perdida).
  const sim1 = fetchSimulado([
    () => json(404, {}),
    () => {
      throw new Error('socket hang up');
    },
  ]);
  await assert.rejects(
    publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim1.fn }, item(), null),
    (e: unknown) => e instanceof PublicacaoFalha && (e as PublicacaoFalha).rejeitada === false
  );
  // 2ª tentativa: o produto já existe no provedor; o lookup por SKU o adota.
  const sim2 = fetchSimulado([
    () => json(200, { id: 555, variants: [{ id: 777, sku: 'SKU-001' }] }),
    () => json(200, [{ id: 555, variants: [{ id: 777, success: true }] }]),
  ]);
  const r = await publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim2.fn }, item(), null);
  assert.equal(r.operacao, 'vinculado_por_sku');
  assert.ok(!sim2.chamadas.some((c) => c.method === 'POST'));
});

test('vínculo apontando para produto inexistente: recusa sem criar outro', async () => {
  const sim = fetchSimulado([() => json(404, {})]);
  await assert.rejects(
    publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim.fn }, item(), '555:777'),
    (e: unknown) => e instanceof PublicacaoFalha && (e as PublicacaoFalha).rejeitada === true
  );
  assert.equal(sim.chamadas.length, 1);
});

test('erro HTTP não vaza corpo da resposta (pode conter dados do lojista)', async () => {
  const sim = fetchSimulado([() => new Response('token=SEGREDO-123 cliente=fulano', { status: 500 })]);
  await assert.rejects(
    publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', evidenciaOficialEscrita: true, fetch: sim.fn }, item(), '555:777'),
    (e: unknown) => {
      assert.ok(e instanceof PublicacaoFalha);
      assert.ok(!String((e as Error).message).includes('SEGREDO-123'));
      assert.ok(!String((e as Error).message).includes('fulano'));
      return true;
    }
  );
});

test('corpo de criação: preço com duas casas, estoque nunca negativo', () => {
  const corpo = corpoCriacaoNuvemshop(item({ preco: 10, disponivel: -3 }));
  assert.equal(corpo.variants[0].price, '10.00');
  assert.equal(corpo.variants[0].stock, 0);
});
