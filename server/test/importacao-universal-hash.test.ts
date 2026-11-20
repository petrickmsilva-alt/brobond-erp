import test from 'node:test';
import assert from 'node:assert/strict';
import { hashAprovacaoImportacaoUniversal, jsonCanonicoImportacaoUniversal } from '../src/importacaoUniversalHash';

test('approval hashing is stable across object key order and JSONB normalization',()=>{
 const id='12345678-1234-1234-1234-123456789012',sha='a'.repeat(64);
 const mappingA={mapeamentoConfirmado:{mapeamentos:[{aba:'Produtos',colunaOriginal:'SKU',campoCanonico:'sku'}],entidades:[{aba:'Produtos',tipo:'produto'}]},reconciliacao:{divergencias:[],totais:{products:241,conditions:2892}}};
 const mappingB={reconciliacao:{totais:{conditions:2892,products:241},divergencias:[]},mapeamentoConfirmado:{entidades:[{tipo:'produto',aba:'Produtos'}],mapeamentos:[{campoCanonico:'sku',colunaOriginal:'SKU',aba:'Produtos'}]}};
 assert.equal(jsonCanonicoImportacaoUniversal(mappingA),jsonCanonicoImportacaoUniversal(mappingB));
 assert.equal(hashAprovacaoImportacaoUniversal(id,1,sha,4,mappingA.mapeamentoConfirmado,mappingA.reconciliacao),hashAprovacaoImportacaoUniversal(id,1,sha,4,mappingB.mapeamentoConfirmado,mappingB.reconciliacao));
});

test('approval canonicalization preserves array order but omits undefined object keys',()=>{
 assert.equal(jsonCanonicoImportacaoUniversal({z:undefined,b:2,a:[undefined,1]}),'{"a":[null,1],"b":2}');
 assert.notEqual(jsonCanonicoImportacaoUniversal([1,2]),jsonCanonicoImportacaoUniversal([2,1]));
});
