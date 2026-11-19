import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularDeltaSaldo, normalizarDocumentoImportacao, normalizarTipoMovimentacao, validarQuantidadeMovimentacao } from '../src/importacaoUniversalExecutor';

test('normaliza tipos de movimentação incluindo acentos e caixa',()=>{
 assert.equal(normalizarTipoMovimentacao('ENTRADA'),'entrada');
 assert.equal(normalizarTipoMovimentacao('Saída'),'saida');
 assert.equal(normalizarTipoMovimentacao('Transferência'),'transferencia');
 assert.equal(normalizarTipoMovimentacao('ajuste'),'ajuste');
 assert.equal(normalizarTipoMovimentacao('inventário'),null);
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
