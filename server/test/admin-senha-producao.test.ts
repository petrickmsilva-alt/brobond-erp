// ============================================================================
// ADMIN_PASSWORD — sem padrão inseguro em produção (Fase 4.3, item 13)
//
// Regras: credencial explícita em todos os ambientes. Em produção,
// senha ausente, curta ou igual à credencial legada resolve para vazio,
// e vazio NUNCA autentica (nem na contingência com banco fora, nem na reautenticação).
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const { senhaAdministradorConfigurada, senhasIguais } = await import('../src/senhaAdmin');

describe('ADMIN_PASSWORD: resolução por ambiente', () => {
  test('fora de produção: ausente não autentica; configurada é preservada', () => {
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), '');
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), '');
    const senha = randomBytes(24).toString('hex');
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'test', ADMIN_PASSWORD: senha } as NodeJS.ProcessEnv), senha);
  });

  test('produção: ausente resolve para vazio (nenhum login aceito)', () => {
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), '');
  });

  test('produção: senha igual ao padrão de desenvolvimento resolve para vazio', () => {
    assert.equal(senhaAdministradorConfigurada({ NODE_ENV: 'production', ADMIN_PASSWORD: 'brobond123' } as NodeJS.ProcessEnv), '');
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
