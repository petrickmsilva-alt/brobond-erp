// ============================================================================
// STOREFRONT ENTERPRISE — GALERIA (uma / muitas / ordem / variante / fallback
// / nenhuma). Domínio puro, sem banco, sem dados inventados: as fotos são
// fixtures explícitas da própria tabela `arquivos`.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selecionarGaleria, galeriasPorVariante, midiaPublica, type MidiaGaleria } from '../src/commerce/galeria';
import { metadadosGaleria } from '../src/uploads';

const foto = (id: number, extra: Partial<MidiaGaleria> = {}): MidiaGaleria => ({
  id,
  url: `/api/arquivos/${id}/conteudo`,
  thumb_url: `/api/arquivos/${id}/conteudo?thumb=1`,
  alt_text: `Foto ${id}`,
  principal: false,
  ordem: id,
  variante_id: null,
  ativo: true,
  ...extra,
});

describe('Galeria — regras reais de mídia por variação', () => {
  test('nenhuma mídia → lista vazia (tela mostra placeholder, nunca imagem falsa)', () => {
    assert.deepEqual(selecionarGaleria([], null), []);
    assert.deepEqual(galeriasPorVariante([], 'Camiseta'), {});
  });

  test('uma mídia → galeria com 1 item e alt text real', () => {
    const g = selecionarGaleria([foto(1, { principal: true })], null);
    assert.equal(g.length, 1);
    assert.equal(midiaPublica(g[0], 'Camiseta').alt_text, 'Foto 1');
  });

  test('muitas mídias → principal primeiro, depois ordem, depois id (estável)', () => {
    const g = selecionarGaleria([
      foto(5, { ordem: 1 }),
      foto(2, { ordem: 9, principal: true }),
      foto(3, { ordem: 1 }),
      foto(4, { ordem: 0 }),
    ], null);
    assert.deepEqual(g.map((f) => f.id), [2, 4, 3, 5]);
  });

  test('mídia inativa nunca aparece; sem mídia geral mostra a primeira da variante', () => {
    const g = selecionarGaleria([foto(1, { ativo: false }), foto(2, { variante_id: 7 })], null);
    assert.deepEqual(g.map((f) => f.id), [2]);
  });

  test('variante COM mídia própria → somente as dela (sem misturar com a geral)', () => {
    const g = selecionarGaleria([
      foto(1, { principal: true }),
      foto(2, { variante_id: 7, ordem: 1 }),
      foto(3, { variante_id: 7, ordem: 0, principal: true }),
      foto(4, { variante_id: 8 }),
    ], 7);
    assert.deepEqual(g.map((f) => f.id), [3, 2]);
  });

  test('variante SEM mídia própria → fallback para as fotos do produto', () => {
    const g = selecionarGaleria([foto(1, { principal: true }), foto(4, { variante_id: 8 })], 7);
    assert.deepEqual(g.map((f) => f.id), [1]);
  });

  test('mapa por variante inclui SÓ variantes com mídia real, em ordem', () => {
    const mapa = galeriasPorVariante([
      foto(1),
      foto(2, { variante_id: 7, ordem: 2 }),
      foto(3, { variante_id: 7, ordem: 1, principal: true }),
      foto(4, { variante_id: 8, ativo: false }),
    ], 'Camiseta');
    assert.deepEqual(Object.keys(mapa).sort(), ['7']);
    assert.deepEqual(mapa['7'].map((f) => f.id), [3, 2]);
    assert.equal(mapa['7'][0].alt_text, 'Foto 3');
  });

  test('alt text ausente usa o nome REAL do produto (nunca texto inventado)', () => {
    const publica = midiaPublica(foto(1, { alt_text: '' }), 'COTTON "B"');
    assert.equal(publica.alt_text, 'COTTON "B"');
    assert.equal(publica.thumb_url.includes('thumb=1'), true);
  });

  test('metadados do admin são fail-closed: lixo/injeção não vira registro', () => {
    const m = metadadosGaleria({ alt_text: '  Frente  ', ativo: false, variante_id: '7', ordem: 'ignore', empresa_id: 999 });
    assert.deepEqual(m, { alt_text: 'Frente', ativo: false, variante_id: 7 });
    assert.deepEqual(metadadosGaleria({}), {});
    // alt_text/ativo com tipo errado são ignorados; variante inválida vira null
    // (desassocia a foto), nunca um id inexistente persistido.
    assert.deepEqual(metadadosGaleria({ alt_text: 123, ativo: 'nao-bool', variante_id: 'x' }), { variante_id: null });
  });
});
