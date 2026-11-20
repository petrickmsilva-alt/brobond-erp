import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAMPOS_CANONICOS_IMPORTACAO } from '../src/importacaoUniversalHandler';
import { interpretarCamposUniversal } from '../src/importacaoUniversalSemantica';
import type { ArquivoInventariado } from '../src/importacaoUniversalLeitura';

test('condition price and margin aliases map to canonicals accepted by the API contract',()=>{
 const aliases:Record<string,string>={
  atacado_vista:'preco_atacado_vista',
  boleto_30:'preco_atacado_boleto_30',
  boleto_30_60:'preco_atacado_boleto_30_60',
  boleto_30_60_90:'preco_atacado_boleto_30_60_90',
  atacado_cartao_debito:'preco_atacado_cartao_debito',
  atacado_cartao_credito_vista:'preco_atacado_cartao_credito_vista',
  atacado_cartao_credito_30_60:'preco_atacado_cartao_credito_30_60',
  atacado_cartao_credito_30_60_90:'preco_atacado_cartao_credito_30_60_90',
  varejo_vista:'preco_varejo_vista',
  varejo_2_un:'preco_varejo_vista_min_2_un',
  cartao_vista:'preco_varejo_cartao_vista',
  cartao_parcelado:'preco_varejo_cartao_parcelado',
  margem_atacado_vista:'margem_bruta_atacado_vista',
  margem_varejo_vista:'margem_bruta_varejo_vista',
  margem_varejo_2_un:'margem_bruta_varejo_min_2_un',
 };
 for(const [header,canonical] of Object.entries(aliases)){
  const file:ArquivoInventariado={nome:'precos.csv',sha256:'a'.repeat(64),tamanhoBytes:1,tipo:'csv',abas:[{nome:'Preços',indice:0,totalLinhas:2,totalColunas:2,linhaCabecalho:1,cabecalhos:['sku',header],vazia:false,celulas:[],linhas:[{linhaOrigem:2,valores:{sku:'BB-001',[header]:'99,90'}}]}]};
  const result=interpretarCamposUniversal(file);
  assert.equal(result.sugestoes.find(s=>s.colunaOriginal===header)?.campoCanonico,canonical,header);
  assert.ok(CAMPOS_CANONICOS_IMPORTACAO.has(canonical),`API mapping contract missing ${canonical}`);
 }
});
