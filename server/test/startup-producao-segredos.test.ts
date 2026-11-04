// Ordem Final 2.8 — JWT_SECRET e ADMIN_PASSWORD em PRODUÇÃO: sem padrão, sem fallback, bloqueio na
// inicialização e nenhum valor de segredo na saída. LOCAL: processos filhos com NODE_ENV=production;
// nenhuma conexão com banco (o guard de DATABASE_URL só verifica a variável).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RAIZ_SERVER = fileURLToPath(new URL('..', import.meta.url));
const JWT_FORTE = randomBytes(24).toString('hex');
const ADMIN_FORTE = `senha-${randomBytes(6).toString('hex')}`;
const BASE = { NODE_ENV: 'production', DATABASE_URL: 'postgres://usuario:senha@127.0.0.1:1/banco', JWT_SECRET: JWT_FORTE, ADMIN_PASSWORD: ADMIN_FORTE, PATH: process.env.PATH || '' };

function subir(env: Record<string, string | undefined>, codigo = "require('./src/security').assertProductionSecrets(); console.log('BOOT_OK');") {
  const ambiente: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...BASE, ...env })) if (v !== undefined) ambiente[k] = v;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', codigo], { cwd: RAIZ_SERVER, env: ambiente, encoding: 'utf8', timeout: 120000 });
  const saida = `${r.stdout || ''}${r.stderr || ''}`;
  // Nenhum valor de segredo pode sair no log.
  for (const segredo of [JWT_FORTE, ADMIN_FORTE]) assert.ok(!saida.includes(segredo), 'segredo não aparece na saída');
  return { code: r.status, saida };
}

test('produção com JWT_SECRET e ADMIN_PASSWORD fortes e DATABASE_URL: inicialização passa', { timeout: 150000 }, () => {
  const r = subir({});
  assert.equal(r.code, 0, r.saida);
  assert.match(r.saida, /BOOT_OK/);
});

test('produção sem JWT_SECRET: bloqueia (exit 1), sem fallback', { timeout: 150000 }, () => {
  const r = subir({ JWT_SECRET: undefined });
  assert.notEqual(r.code, 0);
  assert.match(r.saida, /JWT_SECRET/);
});

test('produção com JWT_SECRET curto (< 24): bloqueia', { timeout: 150000 }, () => {
  const r = subir({ JWT_SECRET: 'curto-demais' });
  assert.notEqual(r.code, 0);
});

test('produção com o JWT_SECRET de desenvolvimento: bloqueia', { timeout: 150000 }, () => {
  const r = subir({ JWT_SECRET: 'brobond-dev-secret' });
  assert.notEqual(r.code, 0);
});

test('produção sem ADMIN_PASSWORD: bloqueia (exit 1)', { timeout: 150000 }, () => {
  const r = subir({ ADMIN_PASSWORD: undefined });
  assert.notEqual(r.code, 0);
  assert.match(r.saida, /ADMIN_PASSWORD/);
});

test('produção com ADMIN_PASSWORD igual ao padrão de desenvolvimento ou curta: bloqueia', { timeout: 150000 }, () => {
  assert.notEqual(subir({ ADMIN_PASSWORD: 'brobond123' }).code, 0);
  assert.notEqual(subir({ ADMIN_PASSWORD: 'curta' }).code, 0);
});

test('produção sem DATABASE_URL: bloqueia (sem fallback em memória)', { timeout: 150000 }, () => {
  const r = subir({ DATABASE_URL: undefined });
  assert.notEqual(r.code, 0);
  assert.match(r.saida, /DATABASE_URL/);
});

test('produção sem JWT_SECRET: a chave de assinatura não tem fallback (segredoJwt lança)', { timeout: 150000 }, () => {
  const r = subir({ JWT_SECRET: undefined }, "require('./src/chavesCifra').segredoJwt(); console.log('NAO_DEVERIA_CHEGAR');");
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.saida, /NAO_DEVERIA_CHEGAR/);
});
