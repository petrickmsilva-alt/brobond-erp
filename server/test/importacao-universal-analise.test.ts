import assert from 'node:assert/strict';
import {test} from 'node:test';
import ExcelJS from 'exceljs';
import {analisarArquivoUniversal} from '../src/importacaoUniversalAnalise';

test('universal analysis aggregates inventory and always blocks direct import',async()=>{
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Produtos');
 ws.addRow(['SKU','Nome','Preço']);ws.addRow(['AB1','Polo','79.90']);
 wb.addWorksheet('Aba vazia');
 const bytes=Buffer.from(await wb.xlsx.writeBuffer());
 const result=await analisarArquivoUniversal({nomeArquivo:'test.xlsx',bytes});
 assert.equal(result.resumo.abas,2);
 assert.equal(result.resumo.linhas,1);
 assert.equal(result.resumo.perdaDadosPrevista,0);
 assert.equal(result.resumo.prontoParaImportar,false);
 assert.ok(result.bloqueios.length>0);
});
