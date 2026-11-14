// ============================================================================
// ETAPA 02/03 — classificação GLOBAL do gate final: só com evidência de desenho.
//
// O gate `scripts/final-go-live-audit.ts` aceita um conjunto fechado de tabelas
// sem `empresa_id` (GLOBAIS). Este teste TRAVA a justificativa arquitetural das
// duas entradas reconciliadas na Etapa 02/03 — para que a classificação não
// vire "lista de exceções que cresce":
//
//   • fiscal_layouts: referência oficial versionada (0115) — recurso READ_ONLY,
//     sem `empresa: true`, com fonte_url/ato normativo/vigência;
//   • oauth_clients: GLOBAL documentado na 0121; o dado por empresa
//     (oauth_authorization_codes / oauth_tokens / oauth_consents) TEM
//     `empresa: true` — o desenho só é global para o cadastro da aplicação.
//
// Se alguém ligar `empresa: true`/escrita nesses recursos, ou remover a
// documentação de desenho global da migration, este teste falha e a entrada
// precisa ser reavaliada (não silenciosamente mantida).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');

test('fiscal_layouts: referência global READ_ONLY com fonte oficial (0115)', () => {
  const r = RESOURCES.fiscal_layouts;
  assert.ok(r, 'recurso existe');
  assert.notEqual(r.empresa, true, 'referência de leiaute não é dado de empresa');
  assert.equal(r.ops.create, false);
  assert.equal(r.ops.update, false);
  assert.equal(r.ops.delete, false);
  const nomes = r.fields.map((f) => f.name);
  for (const campo of ['fonte_url', 'ato_normativo', 'vigencia_inicio', 'codigo_versao']) {
    assert.ok(nomes.includes(campo), `campo de governança ${campo} presente`);
  }
  const mig = readFileSync(new URL('../../db/migrations/0115_fase9_5_fiscal_layouts.sql', import.meta.url), 'utf8');
  assert.match(mig, /TABELA DE REFERÊNCIA VERSIONADA/i, 'migration documenta o desenho de referência');
});

test('oauth_clients: GLOBAL documentado (0121); codes/tokens/consents SÃO por empresa', () => {
  const r = RESOURCES.oauth_clients;
  assert.ok(r, 'recurso existe');
  assert.notEqual(r.empresa, true, 'cliente OAuth é a aplicação, não o tenant');
  assert.equal(r.internal, true, 'não exposto no CRUD genérico');
  assert.equal(r.ops.create, false);
  assert.equal(r.ops.update, false);
  assert.equal(r.ops.delete, false);
  const mig = readFileSync(new URL('../../db/migrations/0121_operational_control_plane.sql', import.meta.url), 'utf8');
  assert.match(mig, /oauth_clients` é GLOBAL/, 'migration documenta explicitamente o desenho GLOBAL');
  for (const key of ['oauth_authorization_codes', 'oauth_tokens', 'oauth_consents'] as const) {
    assert.equal(RESOURCES[key].empresa, true, `${key} carrega empresa_id (dado por empresa)`);
    assert.equal(RESOURCES[key].internal, true, `${key} não exposto no CRUD genérico`);
  }
});

test('oauth_clients não tem empresa_id no schema; fiscal_layouts idem (desenho, não omissão)', () => {
  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  for (const tabela of ['oauth_clients', 'fiscal_layouts']) {
    const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${tabela} \\(([\\s\\S]*?)\\n\\);`).exec(schema);
    assert.ok(m, `CREATE TABLE ${tabela} encontrado`);
    assert.ok(!/empresa_id/.test(m[1]), `${tabela} não tem empresa_id (GLOBAL por desenho)`);
  }
});
