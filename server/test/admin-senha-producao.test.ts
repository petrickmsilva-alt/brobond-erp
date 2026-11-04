// ============================================================================
// ADMIN_PASSWORD — sem padrão inseguro em produção (Fase 4.3, item 13)
//
// Regras: fora de produção, o padrão de desenvolvimento continua valendo (testes
// locais). Em produção, senha ausente, curta ou igual ao padrão resolve para vazio,
// e vazio NUNCA autentica (nem na contingência com banco fora, nem na reautenticação).
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { senhaAdministradorConfigurada, senhasIguais, SENHA_ADMIN_DESENVOLVIMENTO } = await import('../src/senhaAdmin');

describe('ADMIN_PASSWORD: resolução por ambiente', () => {
  test('fora de produção: ausente usa o padrão de desenvolvimento (testes locais preservados)', () => {
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), SENHA_ADMIN_DESENVOLVIMENTO);
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), SENHA_ADMIN_DESENVOLVIMENTO);
  });

  test('produção: ausente resolve para vazio (nenhum login aceito)', () => {
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), '');
  });

  test('produção: senha igual ao padrão de desenvolvimento resolve para vazio', () => {
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'production', ADMIN_PASSWORD: SENHA_ADMIN_DESENVOLVIMENTO } as NodeJS.ProcessEnv), '');
  });

  test('produção: senha curta (< 8) resolve para vazio; senha forte é usada', () => {
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'production', ADMIN_PASSWORD: 'curta' } as NodeJS.ProcessEnv), '');
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'production', ADMIN_PASSWORD: '  forte-9X!aa  ' } as NodeJS.ProcessEnv), 'forte-9X!aa');
  });
});

describe('ADMIN_PASSWORD: comparação em tempo constante', () => {
  test('senhas iguais são aceitas; diferentes, de tamanho diferente ou vazias são recusadas', () => {
    assert.equal(senhasIguais('segredo-forte-1', 'segredo-forte-1'), true);
    assert.equal(senhasIguais('segredo-forte-1', 'segredo-forte-2'), false);
    assert.equal(senhasIguais('curta', 'muito-mais-longa'), false);
    assert.equal(senhasIguais('', ''), false, 'vazio nunca autentica');
    assert.equal(senhasIguais('x', ''), false);
  });
});
