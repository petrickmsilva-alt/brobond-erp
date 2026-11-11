// ============================================================================
// COMMERCE ENTERPRISE — ONDA 3 (publicação em canal externo).
//
// A vitrine nativa `/loja` foi RETIRADA (ADR-0007). O que resta aqui é o
// contrato da fila de publicação EXTERNA (WooCommerce): uma publicação de
// outra empresa falha ANTES de usar credencial global — nunca vaza token de
// um tenant para outro.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { processarPublicacao } = await import('../src/commerce/catalogo');
const s = getStore();
const payload = (slug: string) => ({ sku: slug, titulo: slug, resumo: null, descricao: '', slug, preco: 20, preco_promo: null,
  condicao: 'novo', ativo: true, destaque: false, disponivel: 10, metadados: {} });

test('publicação WooCommerce de outra empresa falha antes de usar credencial global', async (t) => {
  const p = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: 'W3-EXT-1', nome: 'Produto externo', ativo: true, preco_venda: 10 });
  let calls = 0;
  const original = { id: process.env.WOOCOMMERCE_EMPRESA_ID, url: process.env.WOOCOMMERCE_URL, ck: process.env.WOOCOMMERCE_CK, cs: process.env.WOOCOMMERCE_CS };
  process.env.WOOCOMMERCE_EMPRESA_ID = '2'; process.env.WOOCOMMERCE_URL = 'https://example.invalid'; process.env.WOOCOMMERCE_CK = 'fixture'; process.env.WOOCOMMERCE_CS = 'fixture';
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}'); });
  try {
    const row = await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: 1, produto_id: p.id, canal: 'WOOCOMMERCE', versao: 1, estado: 'QUEUED', payload: payload('onda3-ext-1') });
    assert.equal(await processarPublicacao(row), 'falhou'); assert.equal(calls, 0);
    assert.match(String((await s.get(RESOURCES.commerce_publicacoes, Number(row.id)))?.ultimo_erro), /não vinculado/);
  } finally {
    for (const [name, value] of Object.entries({ WOOCOMMERCE_EMPRESA_ID: original.id, WOOCOMMERCE_URL: original.url, WOOCOMMERCE_CK: original.ck, WOOCOMMERCE_CS: original.cs })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
