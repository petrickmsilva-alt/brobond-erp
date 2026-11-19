import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconhecerEntidadesUniversal } from '../src/importacaoUniversalEntidades';
import { interpretarCamposUniversal } from '../src/importacaoUniversalSemantica';
import type { ArquivoInventariado } from '../src/importacaoUniversalLeitura';

test('recognizes product and stock tabs and suggests shared SKU relation without auto-approval',()=>{
 const file:ArquivoInventariado={nome:'multi.xlsx',sha256:'a'.repeat(64),tamanhoBytes:100,tipo:'xlsx',abas:[
 {nome:'Produtos',indice:0,totalLinhas:2,totalColunas:2,linhaCabecalho:1,cabecalhos:['sku','nome'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'BB001',nome:'Camisa'}}]},
 {nome:'Estoque',indice:1,totalLinhas:2,totalColunas:3,linhaCabecalho:1,cabecalhos:['sku','tamanho','quantidade'],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'BB001',tamanho:'M',quantidade:5}}]}
 ]};
 const sem=interpretarCamposUniversal(file), ent=reconhecerEntidadesUniversal(file,sem);
 assert.equal(ent.entidades.find(e=>e.aba==='Produtos')?.tipo,'produto');
 assert.equal(ent.entidades.find(e=>e.aba==='Estoque')?.tipo,'estoque');
 assert.ok(ent.relacionamentos.some(r=>r.origemAba==='Produtos'&&r.destinoAba==='Estoque'&&r.campoOrigem==='sku'));
 assert.ok(ent.relacionamentos.every(r=>r.requerConfirmacao));
});
