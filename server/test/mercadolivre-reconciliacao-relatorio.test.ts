// Mercado Livre — relatório de reconciliação de anúncios (Fase 4.3, item 9).
// Função PURA: não chama a rede e NÃO exclui nem altera anúncios. Só classifica.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { reconciliarAnunciosMercadoLivre } = await import('../src/commerce/reconciliacaoMercadoLivre');

describe('Mercado Livre — relatório de reconciliação (somente leitura)', () => {
  test('anúncio com external_id confirmado pelo SKU fica vinculado', () => {
    const r = reconciliarAnunciosMercadoLivre(
      [{ produto_id: 1, sku: 'SKU-1', external_id: 'MLB100' }],
      [{ id: 'MLB100', sku: 'SKU-1' }]
    );
    assert.equal(r.linhas[0].situacao, 'vinculado');
    assert.equal(r.linhas[0].acao_sugerida, 'nenhuma');
  });

  test('external_id que aponta para anúncio com outro SKU é divergência (não é reatribuído)', () => {
    const r = reconciliarAnunciosMercadoLivre(
      [{ produto_id: 1, sku: 'SKU-1', external_id: 'MLB100' }],
      [{ id: 'MLB100', sku: 'OUTRO' }]
    );
    assert.equal(r.linhas[0].situacao, 'external_id_divergente');
    assert.equal(r.linhas[0].acao_sugerida, 'revisar');
  });

  test('external_id ausente no canal é reportado, sem recriar nem apagar', () => {
    const r = reconciliarAnunciosMercadoLivre([{ produto_id: 1, sku: 'SKU-1', external_id: 'MLB999' }], []);
    assert.equal(r.linhas[0].situacao, 'sem_anuncio_remoto');
  });

  test('produto sem external_id com um único anúncio de mesmo SKU: reuso sugerido (não duplica)', () => {
    const r = reconciliarAnunciosMercadoLivre([{ produto_id: 2, sku: 'SKU-2', external_id: null }], [{ id: 'MLB200', sku: 'SKU-2' }]);
    assert.equal(r.linhas[0].situacao, 'vinculavel_por_sku');
    assert.equal(r.linhas[0].external_id_sugerido, 'MLB200');
  });

  test('SKU duplicado no canal é reportado para resolução humana', () => {
    const r = reconciliarAnunciosMercadoLivre(
      [{ produto_id: 3, sku: 'SKU-3', external_id: null }],
      [{ id: 'MLB300', sku: 'SKU-3' }, { id: 'MLB301', sku: 'SKU-3' }]
    );
    assert.equal(r.linhas[0].situacao, 'sku_duplicado_remoto');
    assert.equal(r.linhas[0].external_id_sugerido, null);
  });

  test('produto sem SKU é reportado e nunca publicado por reconciliação', () => {
    const r = reconciliarAnunciosMercadoLivre([{ produto_id: 4, sku: '  ', external_id: null }], []);
    assert.equal(r.linhas[0].situacao, 'sem_sku');
  });

  test('anúncio remoto sem produto local correspondente é apenas listado', () => {
    const r = reconciliarAnunciosMercadoLivre([], [{ id: 'MLB900', sku: 'ORFAO' }]);
    assert.equal(r.linhas.find((l) => l.external_id === 'MLB900')?.situacao, 'anuncio_remoto_sem_produto');
  });

  test('invariante: o relatório nunca inclui exclusões e declara zero alterações', () => {
    const r = reconciliarAnunciosMercadoLivre(
      [{ produto_id: 1, sku: 'A', external_id: 'MLB1' }, { produto_id: 2, sku: 'B', external_id: null }],
      [{ id: 'MLB1', sku: 'A' }, { id: 'MLB2', sku: 'C' }]
    );
    assert.equal(r.exclusoes, 0);
    assert.equal(r.alteracoes, 0);
    assert.equal(r.resumo.total, r.linhas.length);
  });
});
