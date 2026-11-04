import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('servidor de teste recusa boot sem ADMIN_PASSWORD sem exibir credenciais não relacionadas', () => {
  const sentinel = randomBytes(24).toString('hex');
  const env = { ...process.env, NODE_ENV: 'test', JWT_SECRET: sentinel };
  delete env.ADMIN_PASSWORD;
  delete env.DATABASE_URL;
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ADMIN_PASSWORD ausente/);
  assert.equal((child.stdout + child.stderr).includes(sentinel), false);
});
