import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { reconciliarPoliticaComercial } from '../src/importacaoUniversalPolitica';
import { normalizarDestinoImportacao } from '../src/importacaoUniversalDestinos';

const CABECALHO = [
  'Item', 'Cód Categoria', 'MARCA', 'CATEGORIA MASTER', 'COLEÇÃO', 'VARIANTE COR', 'DESCRIÇÃO',
  'Tamanho', 'Código Industria', 'Tipo', 'STATUS', 'Peso KG',
  'Custo Unitário Fabricação', 'Simples Nacional', 'ICMS',
  'Atacado À Vista', 'Varejo À Vista', 'Preço Varejo', 'Preço Atacado',
];

async function planilhaBase(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Política Comercial Completa');
  for (let r = 1; r <= 10; r++) ws.getRow(r).getCell(1).value = r === 1 ? 'TABELA DE PREÇO BASE' : '';
  CABECALHO.forEach((h, i) => { ws.getRow(11).getCell(i + 1).value = h; });
  const linha = ws.getRow(12);
  const valores: Record<string, string | number> = {
    'Item': '1', 'Cód Categoria': '01', 'MARCA': 'Marca', 'CATEGORIA MASTER': 'Camisas',
    'COLEÇÃO': 'Verão', 'VARIANTE COR': 'Azul', 'DESCRIÇÃO': 'Camisa polo', 'Tamanho': 'M',
    'Código Industria': 'SKU-POL-1', 'Tipo': 'UN', 'STATUS': 'ATIVO', 'Peso KG': 0.2,
    'Custo Unitário Fabricação': 10, 'Simples Nacional': 0.06, 'ICMS': 0.02,
  };
  CABECALHO.forEach((h, i) => { linha.getCell(i + 1).value = valores[h] ?? ''; });
  const saida = wb.addWorksheet('CONTROLE ESTOQUE SAÍDA');
  const cabecalhoSaida = [
    'Código Interno Industria', 'Estoque', 'Saída', 'Estoque2', 'Saída2',
    'Saldo', 'Saldo2', 'TT Est.', 'TT Saída', 'TT Saldo',
  ];
  cabecalhoSaida.forEach((h, i) => { saida.getRow(7).getCell(i + 1).value = h; });
  saida.getRow(8).getCell(1).value = 'SKU-POL-1';
  saida.getRow(8).getCell(10).value = 5;
  const base = wb.addWorksheet('BASE CONTROLE DE ESTOQUE');
  ['Descrição', 'Tamanho', 'Código Industria'].forEach((h, i) => { base.getRow(11).getCell(i + 1).value = h; });
  const contagem = wb.addWorksheet('Estoque Com Jefferson');
  for (const linhaCabecalho of [4, 12]) contagem.getRow(linhaCabecalho).getCell(1).value = 'DESCRIÇÃO';
  const roupas = wb.addWorksheet('Política Comercial Roupas (2)');
  ['Código Industria', 'Qtd. Estoque'].forEach((h, i) => { roupas.getRow(4).getCell(i + 1).value = h; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('adaptador de política comercial produz prévia somente leitura pelo leitor central', async () => {
  assert.equal(normalizarDestinoImportacao('politica_comercial'), 'politica_comercial');
  const bytes = await planilhaBase();
  const resultado = await reconciliarPoliticaComercial(bytes, 'politica.xlsx', 'a'.repeat(64));
  const recon = resultado.resultado as any;
  assert.equal(recon.adaptador, 'politica_comercial');
  assert.equal(recon.importacaoLiberada, false);
  assert.equal(recon.totais.itens, 1);
  assert.equal(recon.previaConsolidada.registros[0].sku, 'SKU-POL-1');
  assert.equal(recon.previaConsolidada.registros[0].linha, 12);
  assert.ok((resultado.previaAdapter as any).previa.amostra.length === 1);
  assert.ok(!JSON.stringify(resultado).includes('\"gravado\":true'));
});
