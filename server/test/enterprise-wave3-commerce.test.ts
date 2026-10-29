import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL; process.env.COMMERCE_LOJA_EMPRESA_ID = '1';
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { lojaProdutosPublicos, lojaPreview } = await import('../src/commerce/vitrine');
const { despublicarProduto, processarPublicacao, enfileirarPublicacao } = await import('../src/commerce/catalogo');
const s = getStore(); const actor = { id: 1, name: 'Gerente', perfil: 'admin', empresa_id: 1, empresas: [1] };
const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next);
const app = express(); app.use(express.json());
app.get('/products', wrap(lojaProdutosPublicos)); app.post('/preview', wrap(lojaPreview));
app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
const payload = (slug: string) => ({ sku: slug, titulo: slug, resumo: null, descricao: '', slug, preco: 20, preco_promo: null,
  condicao: 'novo', ativo: true, destaque: false, disponivel: 10, metadados: {} });
let seq = 0;
async function product() {
  const n = ++seq; const p = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: `W3-${n}`, nome: `Produto onda 3 ${n}`, ativo: true, preco_venda: 10 });
  await s.insert(RESOURCES.commerce_produtos, { empresa_id: 1, produto_id: p.id, slug: `onda3-${n}` });
  return { id: Number(p.id), slug: `onda3-${n}` };
}
function response() { return { json() { return this; } } as any; }

test('vitrine: preço de canal e publicação além da primeira página são respeitados no catálogo e preview', async () => {
  await s.insert(RESOURCES.commerce_configuracoes, { empresa_id: 1, loja_nome: 'Teste', frete_provedor: 'retirada' });
  const a = await product(); const b = await product();
  for (const p of [a, b]) {
    await s.insert(RESOURCES.commerce_precos, { empresa_id: 1, produto_id: p.id, canal: 'BROBOND', preco: p.id === b.id ? 77 : 20 });
    await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: 1, produto_id: p.id, canal: 'BROBOND', versao: 1, estado: 'PUBLISHED' });
  }
  const original = s.list.bind(s);
  s.list = async (r, opts, tx) => original(r, ['produtos', 'commerce_produtos', 'commerce_precos', 'commerce_publicacoes'].includes(r.key) ? { ...opts, pageSize: 1 } : opts, tx);
  try {
    const list = await request(app).get('/products').expect(200);
    assert.equal(list.body.total, 2); assert.equal(list.body.produtos.find((x: any) => x.id === b.id).preco, 77);
    const preview = await request(app).post('/preview').send({ itens: [{ produto_id: b.id, quantidade: 1 }] }).expect(200);
    assert.equal(preview.body.itens[0].preco_unitario, 77); assert.equal(preview.body.totais.total, 77);
  } finally { s.list = original; }
});

test('despublicação: todas as versões e trabalhos pendentes são encerrados; replay não ressuscita', async () => {
  const p = await product();
  for (const [versao, estado] of [[1, 'PUBLISHED'], [2, 'PUBLISHED'], [3, 'QUEUED']] as const) {
    await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: 1, produto_id: p.id, canal: 'BROBOND', versao, estado, payload: payload(p.slug) });
  }
  const stale = (await s.list(RESOURCES.commerce_publicacoes, { page: 1, pageSize: 10, filter: { empresa_id: 1, produto_id: p.id, estado: 'QUEUED' } })).rows[0];
  await despublicarProduto({ user: actor, params: { id: p.id }, body: {} } as any, response());
  const rows = await s.list(RESOURCES.commerce_publicacoes, { page: 1, pageSize: 10, filter: { empresa_id: 1, produto_id: p.id } });
  assert.equal(rows.total, 3); assert.ok(rows.rows.every((row) => row.estado === 'UNPUBLISHED'));
  assert.equal(await processarPublicacao(stale), 'ignorada');
  const listing = await request(app).get('/products').expect(200); assert.ok(!listing.body.produtos.some((x: any) => x.id === p.id));
});

test('despublicação invalida conclusão de worker antigo em PUBLISHING', async () => {
  const p = await product(); const row = await enfileirarPublicacao(1, p.id, 'BROBOND', payload(p.slug), null);
  const original = s.tryUpdateIf.bind(s); let claimed!: () => void; let release!: () => void;
  const started = new Promise<void>((r) => { claimed = r; }); const hold = new Promise<void>((r) => { release = r; });
  s.tryUpdateIf = async (resource, id, expected, data, tx) => {
    const result = await original(resource, id, expected, data, tx);
    if (resource.key === 'commerce_publicacoes' && Number(id) === Number(row.id) && data.estado === 'PUBLISHING' && result) { claimed(); await hold; }
    return result;
  };
  try {
    const worker = processarPublicacao(row); await started;
    await despublicarProduto({ user: actor, params: { id: p.id }, body: {} } as any, response());
    release(); assert.equal(await worker, 'ignorada');
    assert.equal((await s.get(RESOURCES.commerce_publicacoes, Number(row.id)))?.estado, 'UNPUBLISHED');
  } finally { release(); s.tryUpdateIf = original; }
});

test('publicação WooCommerce de outra empresa falha antes de usar credencial global', async (t) => {
  const p = await product(); let calls = 0;
  const original = { id: process.env.WOOCOMMERCE_EMPRESA_ID, url: process.env.WOOCOMMERCE_URL, ck: process.env.WOOCOMMERCE_CK, cs: process.env.WOOCOMMERCE_CS };
  process.env.WOOCOMMERCE_EMPRESA_ID = '2'; process.env.WOOCOMMERCE_URL = 'https://example.invalid'; process.env.WOOCOMMERCE_CK = 'fixture'; process.env.WOOCOMMERCE_CS = 'fixture';
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}'); });
  try {
    const row = await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: 1, produto_id: p.id, canal: 'WOOCOMMERCE', versao: 1, estado: 'QUEUED', payload: payload(p.slug) });
    assert.equal(await processarPublicacao(row), 'falhou'); assert.equal(calls, 0);
    assert.match(String((await s.get(RESOURCES.commerce_publicacoes, Number(row.id)))?.ultimo_erro), /não vinculado/);
  } finally {
    for (const [name, value] of Object.entries({ WOOCOMMERCE_EMPRESA_ID: original.id, WOOCOMMERCE_URL: original.url, WOOCOMMERCE_CK: original.ck, WOOCOMMERCE_CS: original.cs })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
