import assert from 'node:assert/strict';
import { test } from 'node:test';
import { construirModeloDependencias, reconhecerEntidadesUniversal } from '../src/importacaoUniversalEntidades';
import { reconciliarImportacaoUniversal } from '../src/importacaoUniversalRecon';
import { interpretarCamposUniversal } from '../src/importacaoUniversalSemantica';
import type { ArquivoInventariado } from '../src/importacaoUniversalLeitura';

const priceOnly:ArquivoInventariado={nome:'precos.csv',sha256:'b'.repeat(64),tamanhoBytes:3,tipo:'csv',abas:[{nome:'Preços',indice:0,totalLinhas:2,totalColunas:2,linhaCabecalho:1,cabecalhos:['sku','atacado_vista'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-A',atacado_vista:'39,90'}}]}]};
const productsERP=[{id:7,sku:'SKU-A',nome:'Produto A',codigo_barras:null,cor:null,tamanho:null,custo:10,preco_venda:50,ativo:true,produto_pai_id:null,variacao_chave:null,variacao_tamanho_id:null,cor_id:null}];
const contexto=(erpSkus:Map<string,number>,sourceSkus:Map<string,Set<string>>)=>({produtosPorSku:erpSkus,skusPorAba:sourceSkus});
function confirmedSemantic(file:ArquivoInventariado){const sem=interpretarCamposUniversal(file);return{...sem,sugestoes:sem.sugestoes.map(s=>({...s,requerConfirmacao:false,ignorado:false}))};}

test('price-only sheet is classified and linked by unique existing ERP SKU without redundant product tab',()=>{
 const sem=confirmedSemantic(priceOnly),entities=reconhecerEntidadesUniversal(priceOnly,sem);
 assert.equal(entities.entidades.find(e=>e.aba==='Preços')?.tipo,'preco');
 const deps=construirModeloDependencias(entities.entidades,[],contexto(new Map([['SKU-A',1]]),new Map([['Preços',new Set(['SKU-A'])]])));
 const priceDependency=deps.find(d=>d.aba==='Preços');
 assert.equal(priceDependency?.estado,'vinculada');
 assert.equal(priceDependency?.resolvidaNoERP,true);
 assert.equal(priceDependency?.skusERPResolvidos,1);
 assert.deepEqual(priceDependency?.bloqueios,[]);
 const result=reconciliarImportacaoUniversal(priceOnly,sem,{...entities,dependencias:deps},productsERP,[]);
 assert.equal(result.totais.preco_sem_produto,0);
 assert.equal(result.dependencias.find(d=>d.aba==='Preços')?.resolvidaNoERP,true);
 assert.equal(result.dependencias.filter(d=>['sku','variacao','estoque','preco','movimentacao'].includes(d.tipo)&&d.estado==='pendente'&&d.bloqueios.length>0).length,0);
 assert.equal(result.importacaoLiberada,false,'reconciliation remains read-only; approval and execution are separate gates');
});

test('ERP dependency stays blocked for missing or duplicate SKU matches',()=>{
 for(const counts of [new Map<string,number>(),new Map([['SKU-A',2]])]){
  const sem=confirmedSemantic(priceOnly),entities=reconhecerEntidadesUniversal(priceOnly,sem);
  const deps=construirModeloDependencias(entities.entidades,[],contexto(counts,new Map([['Preços',new Set(['SKU-A'])]])));
  const d=deps.find(x=>x.aba==='Preços');
  assert.equal(d?.estado,'pendente');
  assert.equal(d?.resolvidaNoERP,false);
  assert.equal(d?.skusERPComPendencia,1);
  assert.ok(d?.bloqueios.some(b=>b.includes('1 de 1 SKU(s)')));
 }
});

test('existing ERP SKU cannot bypass an unconfirmed workbook product-parent relation',()=>{
 const file:ArquivoInventariado={nome:'produto-e-preco.csv',sha256:'c'.repeat(64),tamanhoBytes:4,tipo:'csv',abas:[
  {nome:'Produtos',indice:0,totalLinhas:2,totalColunas:2,linhaCabecalho:1,cabecalhos:['sku','nome'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-A',nome:'Produto A'}}]},
  {nome:'Preços',indice:1,totalLinhas:2,totalColunas:2,linhaCabecalho:1,cabecalhos:['sku','atacado_vista'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-A',atacado_vista:'39,90'}}]},
 ]};
 const sem=confirmedSemantic(file),entities=reconhecerEntidadesUniversal(file,sem);
 assert.equal(entities.entidades.find(e=>e.aba==='Produtos')?.tipo,'produto');
 assert.equal(entities.entidades.find(e=>e.aba==='Preços')?.tipo,'preco');
 const deps=construirModeloDependencias(entities.entidades,[],contexto(new Map([['SKU-A',1]]),new Map([['Preços',new Set(['SKU-A'])]])));
 const d=deps.find(x=>x.aba==='Preços');
 assert.equal(d?.estado,'pendente');
 assert.equal(d?.resolvidaNoERP,false);
 assert.ok(d?.bloqueios.some(b=>b.includes('Vínculo com aba pai precisa ser confirmado explicitamente.')));
});

test('ERP unique SKU resolution is limited to stock, price, and movement update sheets',()=>{
 const sources:ArquivoInventariado[]=[
  {nome:'estoque.csv',sha256:'d'.repeat(64),tamanhoBytes:3,tipo:'csv',abas:[{nome:'Estoque',indice:0,totalLinhas:2,totalColunas:4,linhaCabecalho:1,cabecalhos:['sku','tamanho','quantidade','local'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-A',tamanho:'M',quantidade:'5',local:'LOJA'}}]}]},
  {nome:'movimentos.csv',sha256:'e'.repeat(64),tamanhoBytes:3,tipo:'csv',abas:[{nome:'Movimentos',indice:0,totalLinhas:2,totalColunas:4,linhaCabecalho:1,cabecalhos:['sku','tipo_movimento','quantidade','local'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-A',tipo_movimento:'entrada',quantidade:'1',local:'LOJA'}}]}]},
  {nome:'sku.csv',sha256:'f'.repeat(64),tamanhoBytes:2,tipo:'csv',abas:[{nome:'SKUs',indice:0,totalLinhas:2,totalColunas:1,linhaCabecalho:1,cabecalhos:['sku'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'SKU-A'}}]}]},
 ];
 for(const file of sources){
  const sem=confirmedSemantic(file),entities=reconhecerEntidadesUniversal(file,sem);
  const entity=entities.entidades[0];
  const dependencies=construirModeloDependencias(entities.entidades,[],contexto(new Map([['SKU-A',1]]),new Map([[entity.aba,new Set(['SKU-A'])]])));
  const dependency=dependencies[0];
  if(['estoque','movimentacao'].includes(entity.tipo)){
   assert.equal(dependency.estado,'vinculada',entity.tipo);
   assert.equal(dependency.resolvidaNoERP,true,entity.tipo);
   assert.equal(dependency.bloqueios.length,0,entity.tipo);
  }else{
   assert.equal(entity.tipo,'sku');
   assert.equal(dependency.estado,'pendente','SKU sheet still requires an explicit product parent');
   assert.equal(dependency.resolvidaNoERP,false);
  }
 }
});
