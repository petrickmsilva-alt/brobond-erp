// ============================================================================
// REGRESSÃO — leitura de colunas do DDL no inventário arquitetural.
//
// O `architecture:audit` mantém a métrica "tabelas com empresa_id" a partir do
// texto do `CREATE TABLE`. O parser antigo só reconhecia colunas indentadas com
// exatamente dois espaços e PERDIA as colunas inline (várias na mesma linha),
// o que gerava FALSO POSITIVO em `tabelas_sem_empresa_id` — as tabelas
// `payment_*` apareciam sem `empresa_id` apesar de tê-lo.
//
// Este teste trava a correção: (1) a função pura reconhece colunas inline e
// ignora restrições por tabela; (2) o DDL real de `db/schema.sql` confirma que
// `payment_intents` e as demais tabelas `payment_*` declaram `empresa_id`.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extrairColunasCreateTable, tabelasComEmpresaId } from '../../scripts/arquitetura-sql';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('reconhece colunas inline na mesma linha do CREATE TABLE', () => {
  const corpo = `
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id),
  order_id bigint NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()`;
  const cols = extrairColunasCreateTable(corpo);
  assert.ok(cols.includes('empresa_id'), `esperava empresa_id em ${JSON.stringify(cols)}`);
  assert.ok(cols.includes('order_id'));
  assert.ok(cols.includes('status'));
  assert.ok(cols.includes('id'));
});

test('ignora restrições por tabela (CONSTRAINT/PRIMARY KEY/FOREIGN KEY/UNIQUE/CHECK)', () => {
  const corpo = `
  id bigserial PRIMARY KEY,
  empresa_id integer NOT NULL,
  UNIQUE(empresa_id,id),
  FOREIGN KEY(empresa_id) REFERENCES empresas(id),
  CONSTRAINT payment_x_ck CHECK (amount > 0)`;
  const cols = extrairColunasCreateTable(corpo);
  assert.deepEqual([...cols].sort(), ['empresa_id', 'id']);
});

test('aceita colunas em linhas separadas (formato clássico)', () => {
  const corpo = `
  id bigserial PRIMARY KEY,
  empresa_id integer NOT NULL,
  nome text NOT NULL`;
  assert.deepEqual([...extrairColunasCreateTable(corpo)].sort(), ['empresa_id', 'id', 'nome']);
});

test('DDL real: toda tabela payment_* declara empresa_id (regressão do falso positivo)', () => {
  const arquivos = [
    path.join(raiz, 'db', 'schema.sql'),
    ...readdirSync(path.join(raiz, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(raiz, 'db', 'migrations', f)),
  ];
  const blocos = new Map<string, string>();
  for (const arquivo of arquivos) {
    const sql = readFileSync(arquivo, 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi)) {
      blocos.set(m[1].toLowerCase(), m[2]);
    }
  }
  const paymentTables = [...blocos.keys()].filter((t) => t.startsWith('payment_'));
  assert.ok(paymentTables.length >= 8, `esperava várias tabelas payment_*, achei ${paymentTables.length}`);
  for (const tabela of paymentTables) {
    const cols = extrairColunasCreateTable(blocos.get(tabela)!);
    assert.ok(cols.includes('empresa_id'), `a tabela ${tabela} deveria ter empresa_id (colunas: ${JSON.stringify(cols)})`);
  }
});

test('a contagem de tabelas com empresa_id bate com o inventário arquitetural', () => {
  // Trava a divergência 184×192: `audit:menu` e `architecture:audit` leem o MESMO
  // DDL pela MESMA função (scripts/arquitetura-sql.ts). Uma leitura que perca
  // colunas inline volta a reportar 184 e quebra aqui — e no inventário.
  const sqlFontes = [
    readFileSync(path.join(raiz, 'db', 'schema.sql'), 'utf8'),
    ...readdirSync(path.join(raiz, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(path.join(raiz, 'db', 'migrations', f), 'utf8')),
  ];
  const comEmpresa = tabelasComEmpresaId(sqlFontes).size;
  const inventario = JSON.parse(readFileSync(path.join(raiz, 'docs', 'ERP-3.0-ARCHITECTURE-INVENTORY.json'), 'utf8'));
  assert.equal(comEmpresa, inventario.tabelas.com_empresa_id, 'contagem de empresa_id divergente do inventário');
});
