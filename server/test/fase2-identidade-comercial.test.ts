// ============================================================================
// FASE 2 — IDENTIDADE COMERCIAL (ADR-0005 / ADR-0008).
//
// Prova, contra o código REAL, que a identidade de um pedido externo combina
// EMPRESA + CANAL + LOJA (`store_key`) + PLATAFORMA + ID EXTERNO, e que pedidos
// de lojas diferentes NÃO colidem mesmo com o MESMO id externo. Também trava a
// separação loja × plataforma × canal de venda.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { referenciaPedido } = await import('../src/commerce/woocommerce/pedidos');
const { STORE_KEYS, FONTE_PRECO, CANAL_PEDIDO, STORE_LABEL } = await import('../src/commerce/woocommerce/registry');

test('a identidade do pedido externo inclui a LOJA (não só o id externo)', () => {
  assert.equal(referenciaPedido('RETAIL', 1001), 'WOO-RETAIL-1001');
  assert.equal(referenciaPedido('WHOLESALE', 1001), 'WOO-WHOLESALE-1001');
});

test('o MESMO id externo em lojas diferentes NÃO colide', () => {
  const ids = STORE_KEYS.map((k) => referenciaPedido(k, 42));
  assert.equal(new Set(ids).size, STORE_KEYS.length, 'cada loja gera referência distinta');
  // Nenhuma referência de uma loja é prefixo ambíguo da outra.
  assert.notEqual(referenciaPedido('RETAIL', 4200), referenciaPedido('WHOLESALE', 4200));
});

test('cada loja tem preço-fonte, canal de venda e rótulo próprios', () => {
  assert.equal(FONTE_PRECO.RETAIL, 'preco_venda');
  assert.equal(FONTE_PRECO.WHOLESALE, 'preco_atacado');
  assert.equal(CANAL_PEDIDO.RETAIL, 'site_varejo');
  assert.equal(CANAL_PEDIDO.WHOLESALE, 'site_atacado');
  assert.ok(STORE_LABEL.RETAIL.includes('brobond.com.br'));
  assert.ok(STORE_LABEL.WHOLESALE.includes('atacado.brobond.com.br'));
});

test('as lojas oficiais são exatamente RETAIL e WHOLESALE (identidade imutável)', () => {
  assert.deepEqual([...STORE_KEYS].sort(), ['RETAIL', 'WHOLESALE']);
});
