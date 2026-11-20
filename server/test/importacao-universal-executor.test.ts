import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtraAttributes, mergeExtraAttributes, normalizarMargemPercentual, calcularDeltaSaldo, findByNormalizedDocument, normalizarDocumentoImportacao, normalizarTipoMovimentacao, validarQuantidadeMovimentacao, resolveExistingVariationParent, resolveMappedVariationSize } from '../src/importacaoUniversalExecutor';

test('normaliza tipos de movimentação incluindo acentos e caixa',()=>{
 assert.equal(normalizarTipoMovimentacao('ENTRADA'),'entrada');
 assert.equal(normalizarTipoMovimentacao('Saída'),'saida');
 assert.equal(normalizarTipoMovimentacao('Transferência'),'transferencia');
 assert.equal(normalizarTipoMovimentacao('ajuste'),'ajuste');
 assert.equal(normalizarTipoMovimentacao('inventário'),null);
});

test('normaliza margem percentual em fração Excel ou pontos percentuais',()=>{
 assert.equal(normalizarMargemPercentual(0.35),35);
 assert.equal(normalizarMargemPercentual(35),35);
 assert.equal(normalizarMargemPercentual(0.355),35.5);
 assert.equal(normalizarMargemPercentual(75.5),75.5);
 assert.equal(normalizarMargemPercentual('0.35%'),0.35);
 assert.equal(normalizarMargemPercentual('0,35%'),0.35);
 assert.equal(normalizarMargemPercentual('35%'),35);
 assert.equal(normalizarMargemPercentual('0.35'),35);
 assert.throws(()=>normalizarMargemPercentual('100%'),e=>(e as any)?.status===422);
 assert.throws(()=>normalizarMargemPercentual('abc%'),e=>(e as any)?.status===422);
 assert.throws(()=>normalizarMargemPercentual(100),e=>(e as any)?.status===422);
 assert.throws(()=>normalizarMargemPercentual(-5),e=>(e as any)?.status===422);
});

test('valida quantidade positiva para entrada, saída e transferência',()=>{
 assert.deepEqual(validarQuantidadeMovimentacao('Saída','2,5'),{tipo:'saida',quantidade:2.5});
 assert.deepEqual(validarQuantidadeMovimentacao('Transferência',3),{tipo:'transferencia',quantidade:3});
 assert.throws(()=>validarQuantidadeMovimentacao('Entrada',-1),e=>(e as any)?.status===422);
 assert.throws(()=>validarQuantidadeMovimentacao('Saída','texto'),e=>(e as any)?.status===422);
 assert.throws(()=>validarQuantidadeMovimentacao('Transferência',0),e=>(e as any)?.status===422);
});

test('ajuste de estoque aceita delta assinado, mas rejeita zero',()=>{
 assert.deepEqual(validarQuantidadeMovimentacao('Ajuste',-4),{tipo:'ajuste',quantidade:-4});
 assert.deepEqual(validarQuantidadeMovimentacao('Ajuste',5),{tipo:'ajuste',quantidade:5});
 assert.throws(()=>validarQuantidadeMovimentacao('Ajuste',0),e=>(e as any)?.status===422);
});

test('saldo absoluto vira delta e não reaplica o saldo integral',()=>{
 assert.equal(calcularDeltaSaldo(7,10),3);
 assert.equal(calcularDeltaSaldo(10,0),-10);
 assert.equal(calcularDeltaSaldo(4,4),0);
 assert.throws(()=>calcularDeltaSaldo(4,-1),e=>(e as any)?.status===422);
 assert.throws(()=>calcularDeltaSaldo(-2,1),e=>(e as any)?.status===422);
});

test('normaliza CPF/CNPJ para chave idempotente sem pontuação',()=>{
 assert.equal(normalizarDocumentoImportacao('12.345.678/0001-90'),'12345678000190');
 assert.equal(normalizarDocumentoImportacao('123.456.789-09'),'12345678909');
 assert.equal(normalizarDocumentoImportacao('  00.111.222/0001-33  '),'00111222000133');
 assert.equal(normalizarDocumentoImportacao(''),'');
 assert.equal(normalizarDocumentoImportacao(null),'');
});

test('ignora explicitamente colunas mapeadas como Ignorar campo ao montar extras',()=>{
 const mappings=[
  {aba:'Produtos',colunaOriginal:'SKU',campoCanonico:'sku',ignorado:false},
  {aba:'Produtos',colunaOriginal:'Interno',campoCanonico:null,ignorado:true},
  {aba:'Produtos',colunaOriginal:'Notas',campoCanonico:null,ignorado:false},
 ];
 assert.deepEqual(buildExtraAttributes({SKU:'A-1',Interno:'segredo',Notas:'extra'},'Produtos',mappings),{Notas:'extra'});
});

test('reimportação de variação preserva atributos ERP e sobrescreve apenas chaves fornecidas',()=>{
 assert.deepEqual(mergeExtraAttributes({erp_fabricante:'BroBond',erp_grade:'M',origem:'anterior'},{origem:'nova',observacao:'sheet'}),{erp_fabricante:'BroBond',erp_grade:'M',origem:'nova',observacao:'sheet'});
 assert.deepEqual(mergeExtraAttributes(null,{observacao:'sheet'}),{observacao:'sheet'});
 assert.deepEqual(mergeExtraAttributes(['invalido'],{observacao:'sheet'}),{observacao:'sheet'});
});

test('localiza CPF/CNPJ existente com pontuacao no registro e escopo do tenant',()=>{
 const rows=[
  {id:1,empresa_id:1,cnpj_cpf:'12.345.678/0001-90',nome:'Tenant A'},
  {id:2,empresa_id:2,cnpj_cpf:'12345678000190',nome:'Tenant B'},
 ];
 assert.equal(findByNormalizedDocument(rows as any,'cnpj_cpf','12345678000190',1)?.id,1);
 assert.equal(findByNormalizedDocument(rows as any,'cnpj_cpf','12345678000190',2)?.id,2);
 assert.equal(findByNormalizedDocument(rows as any,'cnpj_cpf','00000000000000',1),null);
});
test('resolve existing variation child SKU to its ERP parent, never to the child itself',()=>{
 const parent={id:100,sku:'PARENT',produto_pai_id:null};const child={id:101,sku:'CHILD-M',produto_pai_id:100};const rows=[parent,child] as any[];
 assert.equal(resolveExistingVariationParent(rows,'CHILD-M'),parent);
 assert.equal(resolveExistingVariationParent(rows,'PARENT'),null);
 assert.equal(resolveExistingVariationParent(rows,'MISSING'),null);
 assert.equal(resolveExistingVariationParent([{id:101,sku:'CHILD-M',produto_pai_id:999}] as any,'CHILD-M'),null);
});

test('mapped variation size ID resolves directly and remains tenant-scoped',()=>{
 const sizes=[{id:7,empresa_id:1,codigo:'M',nome:'Medium'},{id:8,empresa_id:2,codigo:'G',nome:'Large'}] as any;
 assert.equal(resolveMappedVariationSize(sizes,null,7,1)?.id,7);
 assert.equal(resolveMappedVariationSize(sizes,'M',7,1)?.id,7);
 assert.equal(resolveMappedVariationSize(sizes,null,null,1),null);
 assert.throws(()=>resolveMappedVariationSize(sizes,null,8,1),e=>(e as any)?.status===422);
 assert.throws(()=>resolveMappedVariationSize(sizes,'M',9,1),e=>(e as any)?.status===422);
 assert.throws(()=>resolveMappedVariationSize(sizes,'M',7,2),e=>(e as any)?.status===422);
});
