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
