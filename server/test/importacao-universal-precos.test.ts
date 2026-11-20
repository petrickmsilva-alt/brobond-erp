import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tx } from '../src/store';
import { UNIVERSAL_CONDITION_PRICE_FIELDS, determinePriceConditionAction, missingConditionCodes, preserveNonzeroBasePrices, requiredConditionCodesFromMappedRows, persistUniversalConditionPrice } from '../src/importacaoUniversalPrecos';

test('preserves existing nonzero base prices and fills only zero or missing fields',()=>{
 const existing={preco_venda:59.9,preco_atacado:24.5,custo:12};
 assert.deepEqual(preserveNonzeroBasePrices(existing,{preco_venda:80,preco_atacado:30,custo:15}),{custo:15});
 assert.deepEqual(preserveNonzeroBasePrices({preco_venda:0,preco_atacado:null},{preco_venda:80,preco_atacado:30}),{preco_venda:80,preco_atacado:30});
 assert.deepEqual(preserveNonzeroBasePrices({preco_venda:59.9},{preco_venda:59.9}),{});
});

test('product rows carrying condition prices are included in commercial preflight',()=>{
 const mappedProduct={sku:'BB-TEST',nome:'Produto teste',preco_atacado_vista:'99.90',preco_atacado_boleto_30:'90.00',preco_atacado_boleto_30_60:'85.00',preco_atacado_boleto_30_60_90:'80.00',preco_atacado_cartao_debito:'98.00',preco_atacado_cartao_credito_vista:'97.00',preco_atacado_cartao_credito_30_60:'94.00',preco_atacado_cartao_credito_30_60_90:'90.00',preco_varejo_vista:'129.90',preco_varejo_vista_min_2_un:'119.90',preco_varejo_cartao_vista:'129.90',preco_varejo_cartao_parcelado:'139.90'};
 const codes=requiredConditionCodesFromMappedRows([mappedProduct]);
 assert.equal(codes.length,11);
 assert.deepEqual(codes,['atacado_vista','boleto_30','boleto_30_60','boleto_30_60_90','cartao_debito','cartao_credito_vista','cartao_credito_30_60','cartao_credito_30_60_90','varejo_vista','cartao_vista','cartao_parcelado'].sort());
});

test('condition catalog preflight checks only condition codes used by mapped prices',()=>{
 const required=requiredConditionCodesFromMappedRows([{preco_atacado_vista:'99,90',preco_atacado_boleto_30:'80,00',sku:'BB1'},{preco_varejo_vista_min_2_un:'75,00'},{preco_varejo_cartao_vista:''}]);
 assert.deepEqual(required,['atacado_vista','boleto_30','varejo_vista']);
 assert.deepEqual(missingConditionCodes(required,['atacado_vista','varejo_vista']),['boleto_30']);
});

test('condition price action is idempotent by cent value and versions only changes',()=>{
 assert.equal(determinePriceConditionAction(null,49.9),'created');
 assert.equal(determinePriceConditionAction('49.900',49.9),'unchanged');
 assert.equal(determinePriceConditionAction(49.9,50.01),'versioned');
});

type QueryCall={sql:string;params:unknown[]};
function fakeTransaction(current:Record<string,unknown>|null){
 const calls:QueryCall[]=[];
 const tx={query:async(sql:string,params:unknown[]=[]):Promise<any>=>{calls.push({sql,params});if(sql.startsWith('SELECT id, preco, margem_pct'))return{rows:current?[current]:[]};if(sql.includes('UPDATE produto_precos_condicao')&&sql.includes('vigencia_fim=CURRENT_DATE'))return{rows:current?[{id:current.id}]:[]};if(sql.includes('UPDATE produto_precos_condicao')&&sql.includes('SET margem_pct'))return{rows:current?[{id:current.id}]:[]};return{rows:[{id:101}],rowCount:1};}} as unknown as Tx;
 return{tx,calls};
}
const args={empresaId:1,produtoId:42,canal:'atacado' as const,condicao:'boleto_30',preco:52.35,quantidadeMinima:1,margemPct:35,criadoPor:7,regraCalculo:{sheet:'Precos',row:8}};

test('first condition price creates active row and append-only history with null previous price',async()=>{
 const {tx,calls}=fakeTransaction(null);const action=await persistUniversalConditionPrice(tx,args);assert.equal(action,'created');
 assert.equal(calls.filter(c=>c.sql.startsWith('INSERT INTO produto_precos_condicao (')).length,1);
 const history=calls.find(c=>c.sql.includes('INSERT INTO produto_precos_condicao_historico'));assert.ok(history);assert.equal(history.params[4],null);assert.equal(history.params[5],52.35);assert.ok(calls.some(c=>c.sql.includes('pg_advisory_xact_lock')));
});

test('same condition price updates metadata without version or history insert',async()=>{
 const {tx,calls}=fakeTransaction({id:77,preco:52.35,margem_pct:35});const action=await persistUniversalConditionPrice(tx,args);assert.equal(action,'unchanged');
 assert.equal(calls.filter(c=>c.sql.startsWith('INSERT INTO produto_precos_condicao (')).length,0);
 assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO produto_precos_condicao_historico')).length,0);
 assert.equal(calls.filter(c=>c.sql.includes('UPDATE produto_precos_condicao')&&c.sql.includes('SET margem_pct')).length,1);
});

test('changed condition price closes old row, inserts new active row, and records old/new prices',async()=>{
 const {tx,calls}=fakeTransaction({id:77,preco:51.25,margem_pct:34});const action=await persistUniversalConditionPrice(tx,args);assert.equal(action,'versioned');
 assert.equal(calls.filter(c=>c.sql.includes('UPDATE produto_precos_condicao')&&c.sql.includes('vigencia_fim=CURRENT_DATE')).length,1);
 assert.equal(calls.filter(c=>c.sql.startsWith('INSERT INTO produto_precos_condicao (')).length,1);
 const history=calls.find(c=>c.sql.includes('INSERT INTO produto_precos_condicao_historico'));assert.ok(history);assert.equal(history.params[4],51.25);assert.equal(history.params[5],52.35);
});
test('parcelled retail card condition is gated at minimum quantity two',()=>{
 const definition=UNIVERSAL_CONDITION_PRICE_FIELDS.find(d=>d.field==='preco_varejo_cartao_parcelado');
 assert.equal(definition?.condicao,'cartao_parcelado');assert.equal(definition?.canal,'varejo');assert.equal(definition?.min,2);
});
