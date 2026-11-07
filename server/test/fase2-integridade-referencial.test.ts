// ============================================================================
// FASE 2 — INTEGRIDADE REFERENCIAL DO PADRÃO E4.2 (composite FK por empresa).
//
// Uma FK composta `(empresa_id, x) REFERENCES pai (empresa_id, id)` SÓ é válida
// se o pai tiver um índice ÚNICO em `(empresa_id, id)`. Sem ele, o PostgreSQL
// recusa o `ADD CONSTRAINT` — e a migração falha no deploy, não no CI de
// memória. Este teste pega isso ANTES: lê a cadeia de migrations + o espelho
// `schema.sql`, extrai cada FK E4.2 e cada índice `uq_e42_*`, e exige que todo
// destino tenha a chave única correspondente.
//
// Também trava a forma da migração do CRM (0104): não destrutiva, com
// `NOT VALID` + `VALIDATE` (protege escrita nova e confere o legado).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = path.join(raiz, 'db', 'migrations');

function lerCadeia(): string {
  const schema = readFileSync(path.join(raiz, 'db', 'schema.sql'), 'utf8');
  const migracoes = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    .join('\n');
  return `${schema}\n${migracoes}`;
}

const texto = lerCadeia().replace(/--[^\n]*/g, '');

/** Índices únicos declarados: chave `tabela` → conjunto de assinaturas de colunas. */
function indicesUnicos(): Map<string, Set<string>> {
  const mapa = new Map<string, Set<string>>();
  for (const m of texto.matchAll(/CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s+ON\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
    const tabela = m[2].toLowerCase();
    const cols = m[3]
      .split(',')
      .map((c) => c.trim().split(/\s+/)[0].toLowerCase())
      .filter(Boolean)
      .join(',');
    const set = mapa.get(tabela) ?? new Set<string>();
    set.add(cols);
    mapa.set(tabela, set);
  }
  return mapa;
}

/** FKs compostas E4.2 declaradas nos blocos `VALUES (...) AS v(tabela, nome, ddl)`. */
function fksCompostas(): { tabela: string; ddl: string }[] {
  const out: { tabela: string; ddl: string }[] = [];
  for (const m of texto.matchAll(/\(\s*'([a-z_][a-z0-9_]*)'\s*,\s*'fk_e42_[a-z0-9_]+'\s*,\s*'([^']*FOREIGN\s+KEY[^']*)'\s*\)/gi)) {
    out.push({ tabela: m[1].toLowerCase(), ddl: m[2] });
  }
  return out;
}

const unicos = indicesUnicos();
const fks = fksCompostas();

test('a cadeia declara FKs compostas E4.2 (o padrão existe e é usado)', () => {
  assert.ok(fks.length > 0, 'nenhuma FK E4.2 encontrada — o extrator ou a cadeia mudou');
});

test('toda FK composta E4.2 aponta para um pai com UNIQUE (empresa_id, id)', () => {
  const problemas: string[] = [];
  for (const fk of fks) {
    const m = /FOREIGN\s+KEY\s*\(\s*empresa_id\s*,\s*([a-z0-9_]+)\s*\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(\s*([^)]*)\)/i.exec(fk.ddl);
    if (!m) { problemas.push(`${fk.tabela}: DDL fora do padrão (${fk.ddl})`); continue; }
    const pai = m[2].toLowerCase();
    const colsDestino = m[3].split(',').map((c) => c.trim().toLowerCase()).join(',');
    const assinaturas = unicos.get(pai);
    if (!assinaturas || !assinaturas.has(colsDestino)) {
      problemas.push(`${fk.tabela} → ${pai}(${colsDestino}) sem UNIQUE correspondente`);
    }
  }
  assert.deepEqual(problemas, []);
});

test('a migração do CRM (0104) é não destrutiva e usa NOT VALID + VALIDATE', () => {
  const arq = readdirSync(MIGRATIONS).find((f) => /^0104_.*\.sql$/.test(f));
  assert.ok(arq, 'migração 0104 ausente');
  const sql = readFileSync(path.join(MIGRATIONS, arq!), 'utf8').replace(/--[^\n]*/g, '');
  assert.ok(/NOT\s+VALID/i.test(sql), 'FK composta deve entrar como NOT VALID');
  assert.ok(/VALIDATE\s+CONSTRAINT/i.test(sql), 'NOT VALID deve ser validado em seguida');
  for (const proibido of [/\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
    assert.ok(!proibido.test(sql), `migração destrutiva (${proibido})`);
  }
});

test('o espelho schema.sql contém os mesmos objetos E4.2 do CRM da migração 0104', () => {
  const schema = readFileSync(path.join(raiz, 'db', 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const migracao = readFileSync(path.join(MIGRATIONS, '0104_crm_integridade_multempresa.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const objetos = (s: string) => new Set([...s.matchAll(/uq_e42_crm_[a-z0-9_]+|fk_e42_crm_[a-z0-9_]+/g)].map((m) => m[0]));
  const noSchema = objetos(schema);
  const naMigracao = objetos(migracao);
  for (const o of naMigracao) assert.ok(noSchema.has(o), `schema.sql não espelha ${o}`);
});
