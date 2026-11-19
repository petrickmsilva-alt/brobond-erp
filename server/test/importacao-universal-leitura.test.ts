import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { inventariarArquivoUniversal } from '../src/importacaoUniversalLeitura';

test('CSV inventory keeps normalized columns and all rows', async () => {
  const bytes = Buffer.from('SKU;Nome;Cor\r\nBB-01;Camiseta;Preta\r\nBB-02;Camiseta;Branca\r\n', 'utf8');
  const result = await inventariarArquivoUniversal({ nomeArquivo: 'catalogo.csv', bytes });
  assert.equal(result.tipo, 'csv');
  assert.equal(result.sha256.length, 64);
  assert.equal(result.tamanhoBytes, bytes.length);
  assert.equal(result.abas.length, 1);
  assert.equal(result.abas[0].cabecalhos.length, 3);
  assert.equal(result.abas[0].linhas.length, 2);
  assert.equal(result.abas[0].linhas[1].valores.sku, 'BB-02');
});

test('XLSX inventory reads every worksheet and preserves formula metadata', async () => {
  const wb = new ExcelJS.Workbook();
  const first = wb.addWorksheet('Produtos');
  first.addRow(['SKU', 'Nome', 'Preço']);
  first.addRow(['BB-001', 'Camiseta', 59.9]);
  first.getCell('C3').value = { formula: 'C2*1.1', result: 65.89 };
  const second = wb.addWorksheet('Saldo');
  second.addRow(['Produto', 'Tamanho', 'Quantidade']);
  second.addRow(['BB-001', 'M', 7]);
  wb.addWorksheet('Aba vazia');
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const result = await inventariarArquivoUniversal({ nomeArquivo: 'dados.xlsx', bytes });
  assert.equal(result.tipo, 'xlsx');
  assert.equal(result.abas.length, 3);
  assert.equal(result.abas[0].nome, 'Produtos');
  assert.equal(result.abas[0].linhas.length, 2);
  assert.equal(result.abas[1].linhas[0].valores.quantidade, 7);
  assert.equal(result.abas[2].vazia, true);
  const formulaCell = result.abas[0].celulas.find(c => c.endereco === 'C3');
  assert.equal(formulaCell?.formula, 'C2*1.1');
  assert.equal(formulaCell?.resultadoFormula, 65.89);
});

test('reader rejects unsupported file types and empty files', async () => {
  await assert.rejects(() => inventariarArquivoUniversal({ nomeArquivo: 'catalogo.xls', bytes: Buffer.from('abc') }), /Formato não suportado/);
  await assert.rejects(() => inventariarArquivoUniversal({ nomeArquivo: 'catalogo.csv', bytes: Buffer.alloc(0) }), /Arquivo vazio/);
});

test('reader enforces byte and cell limits', async () => {
  await assert.rejects(() => inventariarArquivoUniversal({ nomeArquivo: 'limite.csv', bytes: Buffer.from('a;b\n1;2'), maxBytes: 2 }), /excede o limite/);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Teste');
  sheet.addRow(['A', 'B', 'C']);
  sheet.addRow([1, 2, 3]);
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  await assert.rejects(() => inventariarArquivoUniversal({ nomeArquivo: 'limite.xlsx', bytes, maxCelulas: 2 }), /excede o limite de células/);
});
