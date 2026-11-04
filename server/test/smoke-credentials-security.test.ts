import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scripts = ['smoke-e2e.mjs', 'smoke-creators.mjs', 'smoke-dependencias.mjs', 'smoke-pg.mjs', 'ux05-fixtures.mjs', '../server/test/smoke.mjs'];
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}`], { cwd: root, env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('scripts abortam antes da rede sem senha explícita e ignoram variáveis legadas', async () => {
  for (const script of scripts) {
    const env = { ...process.env, SMOKE_SENHA: 'legacy-only', ADMIN_PASSWORD: 'legacy-only', UX05_PASS: 'legacy-only' };
    delete env.BROBOND_TEST_ADMIN_PASSWORD;
    delete env.BROBOND_TEST_NEW_PASSWORD;
    const result = await run(script, env);
    assert.notEqual(result.code, 0, script);
    assert.match(result.output, /BROBOND_TEST_ADMIN_PASSWORD/, script);
    assert.doesNotMatch(result.output, /legacy-only/, script);
  }
});

test('fixtures usam senha configurada e não registram segredo refletido em resposta de erro', async () => {
  const password = randomBytes(24).toString('hex');
  let received = '';
  const server = createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end('{"db":"memory"}'); return; }
    req.on('data', (d) => { received += d; });
    req.on('end', () => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: password })); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const result = await run('ux05-fixtures.mjs', { ...process.env, NODE_ENV: 'test', UX05_API: `http://127.0.0.1:${addr.port}`, BROBOND_TEST_ADMIN_PASSWORD: password, UX05_PASS: password });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(received).password, password);
    assert.equal(result.output.includes(password), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('smokes exigem também senha nova, sem fallback', async () => {
  for (const script of scripts.slice(0, 4)) {
    const secret = randomBytes(24).toString('hex');
    const env = { ...process.env, BROBOND_TEST_ADMIN_PASSWORD: secret, SMOKE_SENHA_NOVA: 'legacy-only' };
    delete env.BROBOND_TEST_NEW_PASSWORD;
    const result = await run(script, env);
    assert.notEqual(result.code, 0, script);
    assert.match(result.output, /BROBOND_TEST_NEW_PASSWORD/, script);
    assert.equal(result.output.includes(secret), false, script);
  }
});
