// Testes de API e segurança — complementa os testes de regras de negócio.
// Foco: validação de payload, autenticação, rate limit, hash de senha, tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

test('Token JWT malformado é rejeitado pelo jwt.verify', async () => {
  const jwtModule = await import('jsonwebtoken');
  const jwtVerify = jwtModule.default?.verify || jwtModule.verify;
  const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';

  assert.throws(() => {
    jwtVerify('token-invalido', SECRET);
  });

  assert.throws(() => {
    jwtVerify('', SECRET);
  });

  assert.throws(() => {
    jwtVerify('eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.abc', SECRET);
  });
});

test('verifyPassword rejeita hash que não é bcrypt', async () => {
  const { verifyPassword, hashPassword } = await import('../src/auth');

  // Hash inválido (não começa com $2a$, $2b$, $2y$)
  assert.equal(await verifyPassword('qualquer', 'not-a-bcrypt-hash'), false);

  // Hash nulo/undefined
  assert.equal(await verifyPassword('qualquer', null), false);
  assert.equal(await verifyPassword('qualquer', undefined), false);

  // Hash vazio
  assert.equal(await verifyPassword('qualquer', ''), false);

  // Hash válido
  const hash = await hashPassword('MinhaSenha123');
  assert.equal(await verifyPassword('MinhaSenha123', hash), true);
  assert.equal(await verifyPassword('SenhaErrada', hash), false);
});

test('hashResetToken gera hash SHA-256 determinístico', async () => {
  const { hashResetToken } = await import('../src/auth');

  const token = 'abc123def456';
  const hash1 = hashResetToken(token);
  const hash2 = hashResetToken(token);

  assert.equal(hash1, hash2); // Mesmo token → mesmo hash
  assert.equal(hash1.length, 64); // SHA-256 → 64 caracteres hex
  assert.notEqual(hashResetToken('outro-token'), hash1); // Token diferente → hash diferente
});

test('gerarResetToken gera string aleatória com entropia suficiente', async () => {
  const { gerarResetToken } = await import('../src/auth');

  const t1 = gerarResetToken();
  const t2 = gerarResetToken();

  assert.notEqual(t1, t2); // Tokens diferentes
  assert.ok(t1.length >= 32); // Pelo menos 128 bits de entropia (32 chars hex)
  assert.ok(/^[a-f0-9]+$/i.test(t1)); // Somente caracteres hex
});

test('Rate limit: buckets acumulam contagem corretamente', async () => {
  const { registerLoginFailure, registerLoginSuccess } = await import('../src/security');

  const req: any = {
    body: { email: 'bucket@test.com' },
    headers: {},
    socket: { remoteAddress: '192.168.1.100' },
  };

  // Primeira falha → restam 4
  assert.equal(registerLoginFailure(req), 4);
  // Segunda → restam 3
  assert.equal(registerLoginFailure(req), 3);
  // Terceira → restam 2
  assert.equal(registerLoginFailure(req), 2);

  // Login com sucesso limpa o bucket
  registerLoginSuccess(req);

  // Após sucesso, contador zera → restam 5 novamente
  assert.equal(registerLoginFailure(req), 4);
});

test('assertProductionSecrets: não bloqueia fora de produção', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  delete process.env.JWT_SECRET;
  delete process.env.ADMIN_PASSWORD;

  const { assertProductionSecrets } = await import('../src/security');

  // Em NODE_ENV=test, não deve bloquear
  assert.doesNotThrow(() => assertProductionSecrets());

  process.env.NODE_ENV = originalEnv;
});

test('normalizeEmail: trim e lowercase', async () => {
  const { normalizeEmail } = await import('../src/auth');

  assert.equal(normalizeEmail('  User@Example.COM  '), 'user@example.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('validarPoliticaSenha: mínimo de 8 caracteres', async () => {
  const { validarPoliticaSenha } = await import('../src/services');

  // Senha curta
  assert.ok(validarPoliticaSenha('curta', 'user@test.com'));

  // Senha válida
  assert.equal(validarPoliticaSenha('MinhaSenhaForte123', 'user@test.com'), null);

  // Senha igual ao email
  const result = validarPoliticaSenha('user@test.com', 'user@test.com');
  assert.ok(result !== null); // Deve retornar erro
});

test('signToken: gera token JWT com dados do usuário', async () => {
  const { signToken } = await import('../src/auth');
  const jwtModule = await import('jsonwebtoken');
  const jwtVerify = jwtModule.default?.verify || jwtModule.verify;
  const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';

  const user = { id: 42, name: 'Test User', email: 'test@test.com', perfil: 'admin' as const };
  const token = signToken(user);

  assert.ok(token.length > 0);

  // Decodifica e valida
  const decoded = jwtVerify(token, SECRET) as any;
  assert.equal(decoded.id, 42);
  assert.equal(decoded.name, 'Test User');
  assert.equal(decoded.email, 'test@test.com');
  assert.equal(decoded.perfil, 'admin');
  assert.ok(decoded.exp); // Tem expiração
});

test('clientIp: extrai IP de X-Forwarded-For ou socket', async () => {
  const { clientIp } = await import('../src/auth');

  // Com X-Forwarded-For
  const req1: any = { headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req1), '10.0.0.1');

  // Sem X-Forwarded-For
  const req2: any = { headers: {}, socket: { remoteAddress: '192.168.1.50' } };
  assert.equal(clientIp(req2), '192.168.1.50');

  // Sem nada
  const req3: any = { headers: {}, socket: {} };
  assert.equal(clientIp(req3), '');
});

test('translatePgError: 42703 cita a coluna faltante', async () => {
  const { translatePgError } = await import('../src/pgstore');
  const err = translatePgError({ code: '42703', column: 'colecao_id', message: 'column t.colecao_id does not exist' });
  assert.ok(err);
  assert.equal(err.status, 500);
  assert.match(err.message, /colecao_id/);
  assert.match(err.message, /schema\.sql/);
});

test('todo campo não-virtual de resources.ts existe em db/schema.sql', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { RESOURCES, columnsOf } = await import('../src/resources');

  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  const cols = columnsFromSchema(sql);
  const faltando: string[] = [];
  for (const r of Object.values(RESOURCES)) {
    const tableCols = cols.get(r.table);
    assert.ok(tableCols, `tabela ${r.table} (recurso ${r.key}) não aparece no schema.sql`);
    for (const f of columnsOf(r)) {
      if (f.name === 'id') continue;
      if (!tableCols!.has(f.name)) faltando.push(`${r.table}.${f.name} (recurso ${r.key})`);
    }
  }
  assert.deepEqual(faltando, [], `colunas declaradas no recurso mas ausentes no schema:\n${faltando.join('\n')}`);
});

function columnsFromSchema(sql: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const createRe = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql))) {
    const table = m[1];
    const set = map.get(table) ?? new Set<string>(['id']);
    for (const line of m[2].split('\n')) {
      const trimmed = line.trim().replace(/,$/, '');
      if (!trimmed || trimmed.startsWith('--')) continue;
      const col = trimmed.match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (!col) continue;
      const name = col[1].toLowerCase();
      if (['unique', 'primary', 'constraint', 'check', 'foreign'].includes(name)) continue;
      set.add(name);
    }
    map.set(table, set);
  }
  const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/gi;
  while ((m = alterRe.exec(sql))) {
    const set = map.get(m[1]) ?? new Set<string>();
    set.add(m[2].toLowerCase());
    map.set(m[1], set);
  }
  return map;
}

test('parseNumber do validate.ts aceita formatos pt-BR', async () => {
  const { parseNumber } = await import('../src/validate');

  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1234.56'), 1234.56);
  assert.equal(parseNumber('R$ 1.234,56'), 1234.56);
  assert.equal(parseNumber('  100  '), 100);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(42), 42);
  assert.equal(parseNumber('abc'), null);
});
