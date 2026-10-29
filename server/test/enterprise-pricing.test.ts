import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services'); const { RESOURCES } = await import('../src/resources');
const { melhorPromocaoAtiva } = await import('../src/commerce/promocoes');
test('pricing: considera promoções após a primeira página sem misturar empresas', async () => {
  const s = getStore();
  for (let i = 0; i < 501; i++) await s.insert(RESOURCES.commerce_promocoes, { empresa_id: 1, nome: `promo ${i}`, tipo: 'valor', valor: i === 500 ? 30 : 1, ativo: true });
  await s.insert(RESOURCES.commerce_promocoes, { empresa_id: 2, nome: 'outra empresa', tipo: 'valor', valor: 90, ativo: true });
  const resultado = await melhorPromocaoAtiva(1, 100, new Date('2029-01-01'));
  assert.equal(resultado?.nome, 'promo 500'); assert.equal(resultado?.regra.valor, 30);
});
