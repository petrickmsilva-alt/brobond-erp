// ============================================================================
// GOVERNANÇA DE TENANCY — classificação das tabelas sem `empresa_id`.
//
// Garante que nenhuma tabela fica sem decisão explícita de isolamento: para
// cada tabela SEM `empresa_id` no DDL real, exige uma entrada em
// TABELAS_SEM_EMPRESA_ID com categoria e motivo. Uma tabela nova sem
// `empresa_id` que não seja classificada faz este teste FALHAR — o GAP não
// passa silenciosamente.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extrairColunasCreateTable } from '../../scripts/arquitetura-sql';
import { TABELAS_SEM_EMPRESA_ID, tabelasSemClassificacao } from '../src/tenant-tables';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reconstrói o conjunto de colunas por tabela a partir do DDL real. */
function colunasPorTabela(): Map<string, Set<string>> {
  const arquivos = [
    path.join(raiz, 'db', 'schema.sql'),
    ...readdirSync(path.join(raiz, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(raiz, 'db', 'migrations', f)),
  ];
  const tabelas = new Map<string, Set<string>>();
  for (const arquivo of arquivos) {
    const sql = readFileSync(arquivo, 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi)) {
      const nome = m[1].toLowerCase();
      const cols = tabelas.get(nome) ?? new Set<string>();
      for (const c of extrairColunasCreateTable(m[2])) cols.add(c);
      tabelas.set(nome, cols);
    }
    for (const stmt of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([\s\S]*?);/gi)) {
      const cols = tabelas.get(stmt[1].toLowerCase());
      if (!cols) continue;
      for (const c of stmt[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) cols.add(c[1].toLowerCase());
    }
  }
  return tabelas;
}

const tabelas = colunasPorTabela();
const semEmpresa = [...tabelas.entries()].filter(([, c]) => !c.has('empresa_id')).map(([n]) => n).sort();

test('toda tabela sem empresa_id está classificada (nenhum GAP silencioso)', () => {
  const naoClassificadas = tabelasSemClassificacao(semEmpresa);
  assert.deepEqual(
    naoClassificadas,
    [],
    `tabelas sem empresa_id e sem classificação em TABELAS_SEM_EMPRESA_ID: ${naoClassificadas.join(', ')}`,
  );
});

test('a classificação não cita tabela inexistente nem tabela que TEM empresa_id', () => {
  const comEmpresa = new Set([...tabelas.entries()].filter(([, c]) => c.has('empresa_id')).map(([n]) => n));
  const problemas: string[] = [];
  for (const nome of Object.keys(TABELAS_SEM_EMPRESA_ID)) {
    if (!tabelas.has(nome)) problemas.push(`${nome} (não existe no DDL)`);
    else if (comEmpresa.has(nome)) problemas.push(`${nome} (tem empresa_id — não deveria estar aqui)`);
  }
  assert.deepEqual(problemas, []);
});

test('toda classificação herda-tenant aponta para um pai que tem empresa_id', () => {
  const problemas: string[] = [];
  for (const [nome, info] of Object.entries(TABELAS_SEM_EMPRESA_ID)) {
    if (info.categoria !== 'herda-tenant' && info.categoria !== 'projecao') continue;
    assert.ok(info.herdaDe, `${nome}: categoria ${info.categoria} exige herdaDe`);
    const pai = tabelas.get(info.herdaDe!);
    if (!pai) problemas.push(`${nome} → ${info.herdaDe} (pai inexistente)`);
    else if (!pai.has('empresa_id')) problemas.push(`${nome} → ${info.herdaDe} (pai sem empresa_id)`);
  }
  assert.deepEqual(problemas, []);
});
