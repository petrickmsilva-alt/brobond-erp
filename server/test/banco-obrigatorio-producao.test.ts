// R-3 (Fase 4.2) — em produção, a ausência de DATABASE_URL impede a inicialização e a prontidão.
// LOCAL. Os cenários de boot/store rodam em processo filho: o cache de `getStore` e o
// `assertProductionSecrets` (que encerra o processo) não podem contaminar a suíte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const url = (rel: string) => pathToFileURL(`${RAIZ}${rel}`).href;

function ambiente(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (extra[k] === undefined) delete env[k];
  return env;
}

// Valores FICTÍCIOS só para satisfazer validações de tamanho em testes; não são segredos.
const PROD_SEM_BANCO = {
  NODE_ENV: 'production',
  DATABASE_URL: undefined,
  JWT_SECRET: 'fixture-jwt-secret-sem-valor-real-000',
  ADMIN_PASSWORD: 'fixture-senha-de-teste-000',
  MFA_ENCRYPTION_KEY: 'fixture-mfa-000000000000000000000000',
};

test('função pura: produção sem banco é recusada; com banco, teste e desenvolvimento são aceitos', async () => {
  const { bancoAusenteEmProducao } = await import('../src/security');
  assert.equal(bancoAusenteEmProducao({ NODE_ENV: 'production' } as any, false), true);
  assert.equal(bancoAusenteEmProducao({ NODE_ENV: 'production' } as any, true), false);
  assert.equal(bancoAusenteEmProducao({ NODE_ENV: 'test' } as any, false), false, 'memória permitida fora de produção');
  assert.equal(bancoAusenteEmProducao({ NODE_ENV: 'development' } as any, false), false);
});

test('store: em produção sem DATABASE_URL, getStore não cai em memória', () => {
  const script = `import(${JSON.stringify(url('server/src/services.ts'))}).then(m => {
    try { const s = m.getStore(); console.log('RESULTADO:' + (s.constructor?.name || 'desconhecido')); }
    catch (e) { console.log('RESULTADO:ERRO:' + (e && e.status || 'x')); }
  }).catch(e => console.log('RESULTADO:IMPORT_ERRO'));`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: RAIZ, env: ambiente(PROD_SEM_BANCO), encoding: 'utf8', timeout: 120_000 });
  const linha = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULTADO:')) || '';
  assert.notEqual(linha, 'RESULTADO:MemStore', 'MemStore em produção sem banco é proibido');
  assert.match(linha, /RESULTADO:ERRO:503/, `esperado 503; obtido: ${linha || r.stderr.slice(0, 200)}`);
});

test('boot: produção sem DATABASE_URL encerra antes de subir (exit não zero, aviso claro)', () => {
  const script = `import(${JSON.stringify(url('server/src/security.ts'))}).then(m => { m.assertProductionSecrets(); console.log('RESULTADO:CONTINUOU'); });`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: RAIZ, env: ambiente(PROD_SEM_BANCO), encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(r.status, 0, 'processo deve encerrar');
  assert.ok(!(r.stdout || '').includes('RESULTADO:CONTINUOU'));
  assert.match(r.stderr || '', /DATABASE_URL/);
});

test('boot: com DATABASE_URL presente, a checagem não bloqueia', () => {
  const script = `import(${JSON.stringify(url('server/src/security.ts'))}).then(m => { m.assertProductionSecrets(); console.log('RESULTADO:CONTINUOU'); });`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: RAIZ, env: ambiente({ ...PROD_SEM_BANCO, DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture' }), encoding: 'utf8', timeout: 120_000,
  });
  assert.match(r.stdout || '', /RESULTADO:CONTINUOU/, r.stderr?.slice(0, 300));
});
