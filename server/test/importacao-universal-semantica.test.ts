import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpretarCamposUniversal } from '../src/importacaoUniversalSemantica';
import type { ArquivoInventariado } from '../src/importacaoUniversalLeitura';

const fixture: ArquivoInventariado = {
  nome: 'catalogo.csv', sha256: 'a'.repeat(64), tamanhoBytes: 128, tipo: 'csv',
  abas: [{
    nome: 'Catalogo', indice: 0, totalLinhas: 3, totalColunas: 4, linhaCabecalho: 1,
    cabecalhos: ['sku', 'nome', 'preco_venda', 'campo_extra_do_cliente'],
    vazia: false, celulas: [],
    linhas: [
      { linhaOrigem: 2, valores: { sku: 'BB-001', nome: 'Polo', preco_venda: '59,90', campo_extra_do_cliente: 'valor A' } },
      { linhaOrigem: 3, valores: { sku: 'BB-002', nome: 'Camiseta', preco_venda: '79,90', campo_extra_do_cliente: 'valor B' } },
    ],
  }],
};

test('semantic mapping assigns known headers and preserves unknown columns for manual review', () => {
  const result = interpretarCamposUniversal(fixture);
  assert.equal(result.sugestoes.find(s => s.colunaOriginal === 'sku')?.campoCanonico, 'sku');
  assert.equal(result.sugestoes.find(s => s.colunaOriginal === 'preco_venda')?.campoCanonico, 'preco_venda');
  const unknown = result.camposDesconhecidos.find(s => s.colunaOriginal === 'campo_extra_do_cliente');
  assert.ok(unknown);
  assert.equal(unknown?.requerConfirmacao, true);
  assert.equal(unknown?.confianca, 0);
});

test('semantic mapping marks duplicate target suggestions as ambiguous', () => {
  const duplicated: ArquivoInventariado = {
    ...fixture,
    abas: [{ ...fixture.abas[0], cabecalhos: ['sku', 'referencia', 'nome'], linhas: [] }],
  };
  const result = interpretarCamposUniversal(duplicated);
  assert.equal(result.ambiguidades.length, 1);
  assert.equal(result.ambiguidades[0].campos[0], 'sku');
  assert.ok(result.sugestoes.filter(s => s.campoCanonico === 'sku').every(s => s.requerConfirmacao));
});

test('heuristic partial matches never become auto-approved mappings', () => {
  const partial: ArquivoInventariado = {
    ...fixture,
    abas: [{ ...fixture.abas[0], cabecalhos: ['preco_promo_cliente'], linhas: [] }],
  };
  const result = interpretarCamposUniversal(partial);
  const suggestion = result.sugestoes[0];
  assert.equal(suggestion.requerConfirmacao, true);
  assert.ok(suggestion.confianca < 1);
});
