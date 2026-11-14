// ============================================================================
// PARIDADE MIGRAÇÃO × ESPELHO — OPERATIONAL CONTROL PLANE (migration 0121)
//
// A auditoria independente achou o espelho `db/schema.sql` DEFASADO: os 18
// índices (10 UNIQUE) e 4 CHECKs da migração 0121 não existiam no consolidado.
// A convenção do repositório (migrações 0116–0120 espelham 100% dos índices) e
// a documentação (`db/schema.sql` é o consolidado) exigem paridade: quem instala
// por `psql -f db/schema.sql` recebia as tabelas SEM a unicidade de idempotência,
// SEM a unicidade de `public_id` e SEM o índice parcial de aprovação de uso único.
//
// Este teste trava a correção: todo objeto NOMEADO da migração (índice, CHECK)
// precisa existir no espelho. Um objeto novo só na migração faz o teste falhar.
//
// Roda no job de memória (server/test/*.test.ts). Nenhum PostgreSQL.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const MIGRACAO = path.join(RAIZ, 'db', 'migrations', '0121_operational_control_plane.sql');
const SCHEMA = path.join(RAIZ, 'db', 'schema.sql');
const BOOTSTRAP = path.join(RAIZ, 'db', 'bootstrap.sql');

const semComentarios = (sql: string) => sql.replace(/--[^\n]*/g, '');
const migracao = semComentarios(readFileSync(MIGRACAO, 'utf8'));
const schema = semComentarios(readFileSync(SCHEMA, 'utf8'));

/** Nomes de índice criados (CREATE [UNIQUE] INDEX IF NOT EXISTS <nome>). */
function indices(sql: string): Set<string> {
  return new Set([...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()));
}

/** Nomes de CONSTRAINT de tabela (exclui PK inline e FKs sem nome). */
function constraints(sql: string): Set<string> {
  return new Set([...sql.matchAll(/CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+(?:CHECK|UNIQUE|FOREIGN|PRIMARY|EXCLUDE)/gi)].map((m) => m[1].toLowerCase()));
}

test('0121: todo índice da migração existe no espelho db/schema.sql', () => {
  const daMigracao = indices(migracao);
  assert.ok(daMigracao.size >= 18, `esperava >=18 índices na migração 0121, achei ${daMigracao.size}`);
  const doSchema = indices(schema);
  const faltando = [...daMigracao].filter((i) => !doSchema.has(i)).sort();
  assert.deepEqual(faltando, [], `índices da migração ausentes do espelho schema.sql: ${faltando.join(', ')}`);
});

test('0121: toda CONSTRAINT nomeada da migração existe no espelho db/schema.sql', () => {
  const daMigracao = constraints(migracao);
  assert.ok(daMigracao.size >= 10, `esperava >=10 constraints nomeadas, achei ${daMigracao.size}`);
  const doSchema = constraints(schema);
  const faltando = [...daMigracao].filter((c) => !doSchema.has(c)).sort();
  assert.deepEqual(faltando, [], `constraints da migração ausentes do espelho schema.sql: ${faltando.join(', ')}`);
});

test('0121: as 8 tabelas da migração existem no espelho com o mesmo nome', () => {
  const tabelas = ['operational_operations', 'operational_approvals', 'operational_executions', 'operational_audit_events', 'oauth_clients', 'oauth_authorization_codes', 'oauth_tokens', 'oauth_consents'];
  for (const t of tabelas) {
    assert.ok(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${t}\\s*\\(`, 'i').test(migracao), `migração não cria ${t}`);
    assert.ok(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${t}\\s*\\(`, 'i').test(schema), `espelho não cria ${t}`);
  }
});

test('0121: o bootstrap estrutural NÃO cria as tabelas operacionais (a cadeia versionada é a autoridade)', () => {
  const bootstrap = semComentarios(readFileSync(BOOTSTRAP, 'utf8'));
  for (const t of ['operational_operations', 'oauth_tokens', 'oauth_clients']) {
    assert.ok(!new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${t}\\s*\\(`, 'i').test(bootstrap), `o bootstrap não pode criar ${t} — a evolução é da cadeia versionada`);
  }
});

test('0121: a migração é ADITIVA (nenhum DROP TABLE/COLUMN destrutivo)', () => {
  for (const proibido of [/\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
    assert.ok(!proibido.test(migracao), `migração 0121 não pode ser destrutiva (${proibido})`);
  }
});
