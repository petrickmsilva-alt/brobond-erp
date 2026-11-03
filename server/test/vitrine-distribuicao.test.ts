import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const { distribuirSecoesCatalogo } = await import('../src/commerce/vitrine');

type Card = {
  id: number; sku: string; slug: string; nome: string; resumo: null; destaque: boolean;
  preco: number; preco_original: number | null; promocional: boolean; foto_url: null;
  categoria_id: null; categoria: null; criado_em: string | null;
};
const card = (id: number, options: Partial<Card> = {}): Card => ({
  id, sku: `sku-${id}`, slug: `produto-${id}`, nome: `Produto ${id}`, resumo: null,
  destaque: false, preco: 10, preco_original: null, promocional: false, foto_url: null,
  categoria_id: null, categoria: null, criado_em: `2026-01-${String(id).padStart(2, '0')}`,
  ...options,
});

function assertUniqueAcrossSections(cards: Card[]) {
  const { secoes, idsDistribuidos } = distribuirSecoesCatalogo(cards);
  const sectionIds = [secoes.destaques, secoes.ofertas, secoes.novidades].flat().map((item) => item.id);
  assert.equal(new Set(sectionIds).size, sectionIds.length);
  assert.equal(idsDistribuidos.size, sectionIds.length);
  return { secoes, idsDistribuidos };
}

test('home: 1 produto aparece em uma única seção; coleção fica vazia', () => {
  const { secoes, idsDistribuidos } = assertUniqueAcrossSections([card(17, { destaque: true, promocional: true })]);
  assert.deepEqual(secoes.destaques.map((p) => p.id), [17]);
  assert.deepEqual(secoes.ofertas, []);
  assert.deepEqual(secoes.novidades, []);
  assert.deepEqual([...idsDistribuidos], [17]);
});

test('home: 2 produtos não se repetem entre destaques, ofertas, novidades e coleção', () => {
  const produtos = [card(17, { destaque: true, promocional: true }), card(18, { promocional: true })];
  const { secoes, idsDistribuidos } = assertUniqueAcrossSections(produtos);
  assert.deepEqual(secoes.destaques.map((p) => p.id), [17]);
  assert.deepEqual(secoes.ofertas.map((p) => p.id), [18]);
  assert.deepEqual(secoes.novidades, []);
  assert.deepEqual(produtos.filter((p) => !idsDistribuidos.has(p.id)).map((p) => p.id), []);
});

test('home: 3+ produtos recebem uma distribuição determinística e sem duplicação', () => {
  const produtos = [
    card(17, { destaque: true, promocional: true }),
    card(18, { destaque: true }),
    card(19, { promocional: true }),
    card(20),
  ];
  const first = assertUniqueAcrossSections(produtos);
  const second = assertUniqueAcrossSections([...produtos].reverse());
  assert.deepEqual(first.secoes.destaques.map((p) => p.id), [17, 18]);
  assert.deepEqual(first.secoes.ofertas.map((p) => p.id), [19]);
  assert.deepEqual(first.secoes.novidades.map((p) => p.id), [20]);
  assert.deepEqual(first.secoes, second.secoes);
});

test('home: seção vazia permanece vazia e pode ser ocultada pela apresentação', () => {
  const { secoes, idsDistribuidos } = assertUniqueAcrossSections([]);
  assert.deepEqual(secoes, { destaques: [], ofertas: [], novidades: [] });
  assert.equal(idsDistribuidos.size, 0);
});
