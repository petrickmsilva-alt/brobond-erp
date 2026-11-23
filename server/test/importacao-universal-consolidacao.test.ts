import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const ler = (caminho: string) => readFileSync(`${raiz}/${caminho}`, 'utf8');
const existe = (caminho: string) => existsSync(`${raiz}/${caminho}`);
import { DESTINOS_IMPORTACAO, modeloCsvDestino, normalizarDestinoImportacao } from '../src/importacaoUniversalDestinos';
import { reconhecerEntidadesUniversal } from '../src/importacaoUniversalEntidades';
import { interpretarCamposUniversal } from '../src/importacaoUniversalSemantica';
import type { ArquivoInventariado } from '../src/importacaoUniversalLeitura';

test('somente a interface universal existe como tela de importação', () => {
  const app = ler('client/src/App.tsx');
  assert.match(app, /path="importacao-universal"/);
  assert.doesNotMatch(app, /path="importar\/:tipo"/);
  assert.doesNotMatch(app, /path="carga-politica-comercial"/);
  assert.equal(existe('client/src/pages/ImportacaoUniversalPage.tsx'), true);
  assert.equal(existe('client/src/pages/ImportarPage.tsx'), false);
  assert.equal(existe('client/src/pages/CargaPoliticaComercialPage.tsx'), false);
});

test('enumerate rotas API de importação — somente o motor universal', () => {
  const index = ler('server/src/index.ts');
  assert.doesNotMatch(index, /\/api\/importar\/(preview|confirmar|modelo)/);
  assert.doesNotMatch(index, /\/api\/carga\/politica-comercial/);
  assert.match(index, /\/api\/importacao-universal\/analisar/);
  assert.equal(existe('server/src/importacao.ts'), false);
});

test('todos os atalhos de módulo apontam para a interface única com contexto', () => {
  const source = ler('client/src/lib/importacao.ts');
  assert.doesNotMatch(source, /\/importar\//);
  const lib = source.match(/return cfg \? `([^`]+)`/);
  assert.ok(lib);
  assert.equal(lib?.[1], '/importacao-universal?destino=${cfg.tipo}');
  for (const destino of DESTINOS_IMPORTACAO) {
    assert.equal(normalizarDestinoImportacao(destino.id), destino.id);
    assert.ok(modeloCsvDestino(destino.id).startsWith('\uFEFF'));
  }
  assert.equal(normalizarDestinoImportacao('saldos'), 'estoque');
  assert.equal(normalizarDestinoImportacao('política comercial'), 'politica_comercial');
  assert.equal(normalizarDestinoImportacao('inexistente'), 'universal');
});

test('política comercial é um adaptador do núcleo, com fila durável interna', () => {
  const index = ler('server/src/index.ts');
  assert.match(index, /import \{ processarFilaCargaComercial \}/);
  const adapter = ler('server/src/importacaoUniversalPolitica.ts');
  assert.match(adapter, /enfileirarCargaPoliticaComercial/);
  assert.match(adapter, /reconciliarPoliticaComercial/);
});

test('insumo é reconhecido como entidade própria sem virar produto', () => {
  const file: ArquivoInventariado = {
    nome: 'insumos.csv', sha256: 'a'.repeat(64), tamanhoBytes: 1, tipo: 'csv',
    abas: [{
      nome: 'Insumos', indice: 0, totalLinhas: 2, totalColunas: 3, linhaCabecalho: 1,
      cabecalhos: ['nome', 'unidade', 'custo_medio'], vazia: false, celulas: [],
      linhas: [{ linhaOrigem: 2, valores: { nome: 'Tecido', unidade: 'm', custo_medio: '18,50' } }],
    }],
  };
  const detected = reconhecerEntidadesUniversal(file, interpretarCamposUniversal(file));
  assert.equal(detected.entidades[0]?.tipo, 'insumo');
});
