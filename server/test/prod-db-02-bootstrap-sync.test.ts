// ============================================================================
// PROD-DB-02 — sincronização e contrato do bootstrap estrutural (sem PG).
//
// O bootstrap (db/bootstrap.sql) é GERADO a partir de db/schema.sql por
// scripts/gerar-bootstrap.mjs. Este teste trava o CONTRATO do arquivo:
//
//   1. está sincronizado com o gerador (defasagem falha o build);
//   2. é SÓ DDL — nenhum UPDATE/INSERT/DELETE/TRUNCATE (o boot nunca corrige
//      dados);
//   3. não contém preflight que aborta (nenhum RAISE EXCEPTION) — dado legado
//      não pode impedir a estrutura-base;
//   4. não recria objetos que a cadeia versionada remove (senão o 2º boot os
//      ressuscitaria, quebrando idempotência e a regra de tenant).
//
// Roda no job de testes de memória (server/test/*.test.ts). Nenhum PostgreSQL.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  dividirStatements,
  extrairBootstrap,
  objetosDoEstadoFinal,
} from '../../scripts/gerar-bootstrap.mjs';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const SCHEMA = path.join(RAIZ, 'db', 'schema.sql');
const BOOTSTRAP = path.join(RAIZ, 'db', 'bootstrap.sql');
const MIGRATIONS = path.join(RAIZ, 'db', 'migrations');

function statementsDaCadeia(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    for (const st of dividirStatements(readFileSync(path.join(MIGRATIONS, f), 'utf8'))) out.push(st.texto);
  }
  return out;
}

function primeiroToken(texto: string): string {
  const corpo = texto.replace(/^\s*(?:--[^\n]*\n|\s)*/, '');
  return /^([A-Za-z]+)/.exec(corpo)?.[1]?.toUpperCase() ?? '';
}

/** Remove comentários de linha `-- ...` (o suficiente p/ inspecionar o SQL real). */
function semComentarios(texto: string): string {
  return texto.replace(/--[^\n]*/g, '');
}

test('PROD-DB-02 — db/bootstrap.sql está sincronizado com db/schema.sql', () => {
  const atual = readFileSync(BOOTSTRAP, 'utf8');
  const { sql } = extrairBootstrap(readFileSync(SCHEMA, 'utf8'), { statementsCadeia: statementsDaCadeia() });
  assert.equal(
    atual,
    sql,
    'db/bootstrap.sql está defasado. Rode: node scripts/gerar-bootstrap.mjs'
  );
});

test('PROD-DB-02 — o bootstrap é só DDL: nenhum DML e nenhum preflight que aborta', () => {
  const statements = dividirStatements(readFileSync(BOOTSTRAP, 'utf8'));
  const dml = statements
    .map((s) => ({ linha: s.linha, token: primeiroToken(s.texto), texto: s.texto }))
    .filter((s) => ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE'].includes(s.token));
  assert.deepEqual(
    dml.map((d) => `linha ${d.linha}: ${d.token}`),
    [],
    'o bootstrap não pode conter DML — o boot NUNCA corrige dados'
  );
  const aborta = statements.filter((s) => /RAISE\s+EXCEPTION/i.test(semComentarios(s.texto)));
  assert.deepEqual(
    aborta.map((s) => `linha ${s.linha}`),
    [],
    'o bootstrap não pode conter preflight que aborta — dado legado não bloqueia a estrutura-base'
  );
});

test('PROD-DB-02 — o bootstrap não recria objetos removidos pela cadeia versionada', () => {
  const cadeia = statementsDaCadeia();
  const bootstrap = readFileSync(BOOTSTRAP, 'utf8');
  const base = dividirStatements(bootstrap).map((s) => s.texto);
  const vivoFinal = objetosDoEstadoFinal(base, cadeia);

  const criadosNoBootstrap = new Set<string>();
  for (const texto of base) {
    const corpo = texto.replace(/^\s*(?:--[^\n]*\n|\s)*/, '');
    const m = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i.exec(corpo);
    if (m) criadosNoBootstrap.add(`idx:${m[1].replace(/"/g, '')}`);
  }
  const ressuscitados = [...criadosNoBootstrap].filter((k) => !vivoFinal.has(k));
  assert.deepEqual(
    ressuscitados,
    [],
    'o bootstrap recria índice que a cadeia remove; o 2º boot o traria de volta. Exclua-o no gerador.'
  );
});
