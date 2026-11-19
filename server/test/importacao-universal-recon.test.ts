import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reconciliarImportacaoUniversal} from '../src/importacaoUniversalRecon';
import {interpretarCamposUniversal} from '../src/importacaoUniversalSemantica';
import {reconhecerEntidadesUniversal} from '../src/importacaoUniversalEntidades';
import type {ArquivoInventariado} from '../src/importacaoUniversalLeitura';

test('reconciliation is read-only, classifies new and duplicate source SKUs, and preserves unknown columns',()=>{
 const file:ArquivoInventariado={nome:'p.xlsx',sha256:'a'.repeat(64),tamanhoBytes:4,tipo:'xlsx',abas:[{nome:'Products',indice:0,totalLinhas:3,totalColunas:4,linhaCabecalho:1,cabecalhos:['sku','nome','preco_venda','unknown'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'AA1',nome:'A',preco_venda:'40',unknown:'x'}},{linhaOrigem:3,valores:{sku:'AA1',nome:'A2',preco_venda:'41',unknown:'y'}}]}]};
 const sem=interpretarCamposUniversal(file),ent=reconhecerEntidadesUniversal(file,sem);
 const result=reconciliarImportacaoUniversal(file,sem,ent,[],[]);
 assert.equal(result.importacaoLiberada,false);
 assert.equal(result.perdaDadosPrevista,0);
 assert.equal(result.totais.duplicado_origem,1);
 assert.ok(result.divergencias.some(d=>d.tipo==='campo_desconhecido'));
 assert.equal(result.registros[0].dadosOriginais.unknown,'x');
});
test('reconciliation proposes product field differences without writing to ERP',()=>{
 const file:ArquivoInventariado={nome:'p.csv',sha256:'b'.repeat(64),tamanhoBytes:3,tipo:'csv',abas:[{nome:'Products',indice:0,totalLinhas:2,totalColunas:2,linhaCabecalho:1,cabecalhos:['sku','nome'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'BB01',nome:'Nome novo'}}]}]};
 const sem=interpretarCamposUniversal(file),ent=reconhecerEntidadesUniversal(file,sem);
 const result=reconciliarImportacaoUniversal(file,sem,ent,[{id:1,sku:'BB01',nome:'Nome antigo'}],[]);
 assert.equal(result.totais.atualizacao_proposta,1);
 assert.equal(result.importacaoLiberada,false);
});

test('reconciliation blocks duplicate source barcodes across different SKUs',()=>{
 const file:ArquivoInventariado={nome:'duplicados.csv',sha256:'c'.repeat(64),tamanhoBytes:5,tipo:'csv',abas:[{nome:'Products',indice:0,totalLinhas:3,totalColunas:3,linhaCabecalho:1,cabecalhos:['sku','nome','codigo_barras'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-1',nome:'Produto 1',codigo_barras:'7890000000001'}},{linhaOrigem:3,valores:{sku:'SKU-2',nome:'Produto 2',codigo_barras:'7890000000001'}}]}]};
 const sem=interpretarCamposUniversal(file),ent=reconhecerEntidadesUniversal(file,sem);
 const result=reconciliarImportacaoUniversal(file,sem,ent,[],[]);
 assert.equal(result.totais.conflito_codigo_barras,1);
 assert.ok(result.divergencias.some(d=>d.tipo==='conflito_codigo_barras'&&d.linhasOrigem.length===2));
 assert.equal(result.importacaoLiberada,false);
});

test('reconciliation blocks duplicate barcodes across separate workbook sheets',()=>{
 const file:ArquivoInventariado={nome:'multiabas.xlsx',sha256:'d'.repeat(64),tamanhoBytes:8,tipo:'xlsx',abas:[
  {nome:'Products A',indice:0,totalLinhas:2,totalColunas:3,linhaCabecalho:1,cabecalhos:['sku','nome','codigo_barras'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-A',nome:'Produto A',codigo_barras:'7890000000002'}}]},
  {nome:'Products B',indice:1,totalLinhas:2,totalColunas:3,linhaCabecalho:1,cabecalhos:['sku','nome','codigo_barras'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-B',nome:'Produto B',codigo_barras:'7890000000002'}}]}
 ]};
 const sem=interpretarCamposUniversal(file),ent=reconhecerEntidadesUniversal(file,sem);
 const result=reconciliarImportacaoUniversal(file,sem,ent,[],[]);
 const conflict=result.divergencias.find(d=>d.tipo==='conflito_codigo_barras'&&d.chave==='7890000000002');
 assert.ok(conflict);
 assert.equal(conflict.linhasOrigem.length,2);
 assert.equal((conflict.detalhes?.origens as unknown[]).length,2);
 assert.equal(result.importacaoLiberada,false);
});
