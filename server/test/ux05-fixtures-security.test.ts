import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('UX05 fixtures: never log passwords/tokens/auth bodies; temporary TOTP is owner-only', async () => {
  // Ephemeral LOCAL test data only; no external credentials or stored fixtures.
  const password = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const secret = randomBytes(20).toString('hex').replace(/[0189]/g, 'A').toUpperCase();
  const dir = mkdtempSync(join(tmpdir(), 'ux05-security-'));
  const secretFile = join(dir, 'totp');
  const server = createServer((req, res) => {
    req.resume();
    let body: unknown = {};
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/health') body = { db: 'memory' };
    else if (url.pathname === '/api/auth/login') body = { mfa_ticket: token, mfa_setup_required: true, token };
    else if (url.pathname === '/api/auth/mfa/desafio') body = { segredo: secret };
    else if (url.pathname === '/api/auth/login/mfa') body = { token, user: { trocar_senha: false } };
    else if (url.pathname === '/api/empresas') body = { rows: [{ id: 2 }] };
    else if (url.pathname === '/api/usuarios') body = { rows: [{ id: 3, email: 'gerente@brobond.com.br' }, { id: 4, email: 'operador@brobond.com.br' }] };
    else if (url.pathname.endsWith('/senha-temporaria')) body = { senha_temporaria: password };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const script = fileURLToPath(new URL('../../scripts/ux05-fixtures.mjs', import.meta.url));
    const child = spawn(process.execPath, [script], { env: {
      ...process.env, NODE_ENV: 'test', UX05_API: `http://127.0.0.1:${address.port}`,
      UX05_PASS: password, UX05_TOTP_SECRET_FILE: secretFile,
    } });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0);
    for (const value of [password, token, secret]) assert.equal(output.includes(value), false, 'sensitive value leaked');
    assert.equal(readFileSync(secretFile, 'utf8'), secret);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UX05 fixtures: authentication failure logs only HTTP status, never the response body', async () => {
  const sensitive = randomBytes(32).toString('hex');
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') res.end(JSON.stringify({ db: 'memory' }));
    else { res.statusCode = 401; res.end(JSON.stringify({ token: sensitive, senha_temporaria: sensitive, segredo: sensitive })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/ux05-fixtures.mjs', import.meta.url))], {
      env: { ...process.env, NODE_ENV: 'test', UX05_API: `http://127.0.0.1:${address.port}`, UX05_PASS: sensitive },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 1);
    assert.match(output, /401/);
    assert.equal(output.includes(sensitive), false, 'error response leaked');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
