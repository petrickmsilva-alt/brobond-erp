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

test('varredura de padrões de credencial em arquivos rastreados', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
  const patterns: Array<{ name: string; re: RegExp }> = [
    { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'github-pat', re: /ghp_[A-Za-z0-9]{20,}/ },
    { name: 'private-key', re: /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  ];
  const violations: string[] = [];
  for (const path of files) {
    if (path.endsWith('.md') || path.includes('test/')) continue;
    const buf = readFileSync(`${root}/${path}`);
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    for (const p of patterns) {
      if (p.re.test(text)) violations.push(`${path}:${p.name}`);
    }
  }
  assert.deepEqual(violations, [], `padrões de credencial: ${violations.join(', ')}`);
});
