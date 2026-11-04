// R-14 (Fase 4.2) — associação segura de evento de webhook a empresa (contrato puro, sem esquema).
// LOCAL: função pura, sem banco, sem rede. Não altera tabelas: a migração depende de aprovação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const W = await import('../src/webhookEmpresa');

test('assinatura inválida: evento recusado, mesmo com mapeamento e configuração', () => {
  const r = W.resolverEmpresaDoEvento({ assinaturaValida: false, empresaDaConfiguracao: 2, empresasPorIdentificador: [2] });
  assert.deepEqual(r, { tipo: 'recusado', motivo: 'assinatura_invalida' });
});

test('configuração por empresa, sem mapeamento de identificador: associa à empresa da configuração', () => {
  const r = W.resolverEmpresaDoEvento({ assinaturaValida: true, empresaDaConfiguracao: 2, empresasPorIdentificador: [] });
  assert.deepEqual(r, { tipo: 'empresa', empresaId: 2, origem: 'configuracao' });
});

test('configuração por empresa, identificador apontando para OUTRA empresa: recusado (ambíguo), nunca associa', () => {
  const r = W.resolverEmpresaDoEvento({ assinaturaValida: true, empresaDaConfiguracao: 2, empresasPorIdentificador: [3] });
  assert.deepEqual(r, { tipo: 'recusado', motivo: 'identificador_ambiguo' });
});

test('evento sem empresa (configuração global, sem identificador): permanece GLOBAL', () => {
  const r = W.resolverEmpresaDoEvento({ assinaturaValida: true, empresaDaConfiguracao: null, empresasPorIdentificador: [] });
  assert.deepEqual(r, { tipo: 'global' });
});

test('configuração global com identificador de UMA empresa: associa a essa empresa', () => {
  const r = W.resolverEmpresaDoEvento({ assinaturaValida: true, empresaDaConfiguracao: null, empresasPorIdentificador: [5] });
  assert.deepEqual(r, { tipo: 'empresa', empresaId: 5, origem: 'identificador' });
});

test('configuração global com identificador de VÁRIAS empresas: recusado (ambíguo)', () => {
  const r = W.resolverEmpresaDoEvento({ assinaturaValida: true, empresaDaConfiguracao: null, empresasPorIdentificador: [5, 6] });
  assert.deepEqual(r, { tipo: 'recusado', motivo: 'identificador_ambiguo' });
});

test('mapeamentos repetidos da mesma empresa não viram ambiguidade', () => {
  const r = W.resolverEmpresaDoEvento({ assinaturaValida: true, empresaDaConfiguracao: null, empresasPorIdentificador: [5, 5] });
  assert.deepEqual(r, { tipo: 'empresa', empresaId: 5, origem: 'identificador' });
});

test('chave de idempotência: estável por (provedor, id do evento) e recusa id ausente', () => {
  assert.equal(W.chaveIdempotenciaEvento('pagbank', 'evt-1'), W.chaveIdempotenciaEvento('pagbank', 'evt-1'));
  assert.notEqual(W.chaveIdempotenciaEvento('pagbank', 'evt-1'), W.chaveIdempotenciaEvento('mercadopago', 'evt-1'));
  assert.throws(() => W.chaveIdempotenciaEvento('pagbank', ''), /id do evento/i);
});

test('o módulo é puro: não consulta banco nem importa o store', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/webhookEmpresa.ts', import.meta.url)), 'utf8');
  assert.equal(/from '\.\/services'|from '\.\/pgstore'|from '\.\/memdb'|from '\.\/store'|getStore\(/.test(src), false);
});
