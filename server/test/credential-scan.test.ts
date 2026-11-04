import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// O valor antigo só é permitido em listas de bloqueio e em testes negativos.
// Estas ocorrências não são credenciais usadas para autenticar.
const allowed = new Set([
  'client/src/components/ForcaSenha.tsx',
  'server/src/politicaSenha.ts',
  'server/src/security.ts',
  'server/src/senhaAdmin.ts',
  'server/src/services.ts',
  'server/test/admin-senha-producao.test.ts',
  'server/test/startup-producao-segredos.test.ts',
]);
const root = fileURLToPath(new URL('../../', import.meta.url));
const forbidden = ['brobond' + '123'];

test('senha legada não reaparece fora de listas de bloqueio e testes negativos documentados', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
  const violations: string[] = [];
  for (const path of files) {
    if (allowed.has(path)) continue;
    const text = readFileSync(`${root}/${path}`);
    if (text.includes(0)) continue;
    if (forbidden.some((value) => text.includes(value))) violations.push(path);
  }
  assert.deepEqual(violations, [], `ocorrências não classificadas: ${violations.join(', ')}`);
  const resolver = readFileSync(`${root}/server/src/senhaAdmin.ts`, 'utf8');
  assert.doesNotMatch(resolver, /return\s+valor\s*\|\|/);
});
