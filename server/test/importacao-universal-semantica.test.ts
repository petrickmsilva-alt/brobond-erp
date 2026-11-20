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

test('expanded canonical fields are recognized without lossy alias collisions', () => {
  const headers = [
    'material','modelagem','genero','marca','cest','tipo','condicao','producao',
    'unidade','tags','formato','ativo','codigo_item','codigo_categoria',
    'codigo_industria','variacao_tamanho_id','local_destino','motivo',
  ];
  const expanded: ArquivoInventariado = {
    ...fixture,
    abas: [{ ...fixture.abas[0], cabecalhos: headers, linhas: [] }],
  };
  const result = interpretarCamposUniversal(expanded);
  for (const header of headers) {
    assert.equal(result.sugestoes.find(s => s.colunaOriginal === header)?.campoCanonico, header, `canonical field ${header}`);
  }
  assert.equal(result.camposDesconhecidos.length, 0);
});

test('expanded English and operational aliases map to their intended canonical fields', () => {
  const aliases: Record<string,string> = {
    fabric: 'material', fit: 'modelagem', gender: 'genero', brand: 'marca',
    cest: 'cest', type: 'tipo', condition: 'condicao', production: 'producao',
    uom: 'unidade', keywords: 'tags', format: 'formato', active: 'ativo',
    item_code: 'codigo_item', category_code: 'codigo_categoria',
    industry_code: 'codigo_industria', size_id: 'variacao_tamanho_id',
    warehouse_destination: 'local_destino', reason: 'motivo',
  };
  for (const [header, expected] of Object.entries(aliases)) {
    const isolated: ArquivoInventariado = {
      ...fixture,
      abas: [{ ...fixture.abas[0], cabecalhos: [header], linhas: [] }],
    };
    const result = interpretarCamposUniversal(isolated);
    assert.equal(result.sugestoes[0]?.campoCanonico, expected, `alias ${header}`);
  }
});
