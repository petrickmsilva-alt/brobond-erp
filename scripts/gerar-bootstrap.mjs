#!/usr/bin/env node
// ============================================================================
// PROD-DB-02 — gerador do bootstrap estrutural (db/bootstrap.sql).
//
// O bootstrap estrutural é a parte de db/schema.sql que só garante ESTRUTURA:
// CREATE TABLE/INDEX/TYPE/FUNCTION/TRIGGER e ALTERs aditivos. É idempotente,
// não contém DML (nenhum UPDATE/INSERT/DELETE) e não contém preflight que
// aborta (RAISE EXCEPTION).
//
// Este script extrai essa parte da SEÇÃO ESTRUTURAL-BASE do db/schema.sql
// (tudo até o bloco que espelha as migrations 0017..0020). A evolução a partir
// da 0017 vive exclusivamente em db/migrations/*.sql, aplicada pela cadeia
// versionada — o bootstrap não a repete.
//
// Uso:
//   node scripts/gerar-bootstrap.mjs           # regenera db/bootstrap.sql
//   node scripts/gerar-bootstrap.mjs --check   # falha se estiver defasado
// ============================================================================
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA = path.join(RAIZ, 'db', 'schema.sql');
const BOOTSTRAP = path.join(RAIZ, 'db', 'bootstrap.sql');

// Marcador do fim da seção estrutural-base em db/schema.sql.
const MARCADOR_CORTE = '-- BLOCO P0 — MULTIEMPRESA, CADASTRO DE PRODUTO';

// Objetos que a cadeia versionada REMOVE (DROP) em algum ponto. O bootstrap roda
// a CADA boot e antes da cadeia; se ele recriasse um objeto que a cadeia
// derruba, o segundo boot o traria de volta — o banco deixaria de ser
// idempotente e um índice de unicidade global revogado (ex.: o de `connectors`,
// substituído por (empresa_id, usuario_id, provider) na 0033) voltaria a valer,
// reabrindo colisão entre tenants. O bootstrap é a ESTRUTURA-BASE; quem manda
// no estado final é a cadeia, que pode remover o que a base criou.
const DROPS = [
  [/\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi, 'idx'],
  [/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi, 'tbl'],
  [/\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi, 'view'],
  [/\bDROP\s+MATERIALIZED\s+VIEW\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi, 'matview'],
  [/\bDROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi, 'type'],
  [/\bDROP\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi, 'seq'],
  [/\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/gi, 'trg'],
];

// Reconhece o objeto criado por um statement de CREATE (nome + tipo).
const CREATES = [
  [/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i, 'idx'],
  [/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i, 'tbl'],
  [/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("?[\w.]+"?)/i, 'view'],
  [/^\s*CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i, 'matview'],
  [/^\s*CREATE\s+TYPE\s+("?[\w.]+"?)/i, 'type'],
  [/^\s*CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i, 'seq'],
  [/^\s*CREATE\s+TRIGGER\s+("?[\w.]+"?)/i, 'trg'],
];

/** Coleta os DROPs de um conjunto de statements (nome normalizado + tipo). */
function objetosRemovidos(statements) {
  const removidos = new Set();
  for (const texto of statements) {
    const corpo = texto.replace(/^\s*(?:--[^\n]*\n|\s)*/, '');
    for (const [re, kind] of DROPS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(corpo))) removidos.add(`${kind}:${m[1].replace(/"/g, '')}`);
    }
    // DROP dinâmico: EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_empresa_' || ...).
    for (const m of corpo.matchAll(/format\(\s*'DROP\s+(\w+)\s+IF\s+EXISTS\s+%I[^']*'\s*,\s*'([^']+)'/gi)) {
      removidos.add(`${m[1].toLowerCase()}:${m[2]}`);
    }
  }
  return removidos;
}

/** Nome+tipo do objeto criado por um statement, ou null. */
function objetoCriado(corpo) {
  for (const [re, kind] of CREATES) {
    const m = re.exec(corpo);
    if (m) return `${kind}:${m[1].replace(/"/g, '')}`;
  }
  return null;
}

const CABECALHO = `-- ============================================================================
-- BROBOND ERP — BOOTSTRAP ESTRUTURAL (PostgreSQL)
--
-- ARQUIVO GERADO. Não edite à mão: rode \`node scripts/gerar-bootstrap.mjs\`.
-- Um teste (server/test/prod-db-02-bootstrap-sync.test.ts) falha se este arquivo
-- divergir de db/schema.sql.
--
-- RESPONSABILIDADE: garantir a ESTRUTURA-BASE de um banco (tabelas, tipos,
-- índices, funções/triggers e colunas aditivas). Executado a cada boot por
-- server/src/db.ts, ANTES da cadeia versionada.
--
-- GARANTIAS (verificadas por testes PostgreSQL reais):
--   * IDEMPOTENTE: todo comando é IF NOT EXISTS / CREATE OR REPLACE ou ALTER
--     aditivo; pode rodar quantas vezes for preciso.
--   * SÓ DDL: nenhum UPDATE/INSERT/DELETE. O boot NUNCA corrige dados.
--   * NUNCA ABORTA POR DADO LEGADO: não contém preflight com RAISE EXCEPTION.
--     Regras de dado (E4.2 e seguintes) vivem na cadeia versionada
--     (db/migrations/*.sql) e, quando violadas, deixam o banco DEGRADADO.
--
-- Fonte: seção estrutural-base de db/schema.sql (espelho de
-- db/migrations/0001..0016). A evolução a partir da 0017 vive exclusivamente
-- em db/migrations/.
-- ============================================================================

`;

/**
 * Divide um arquivo SQL em statements de topo, respeitando strings, aspas
 * duplas, comentários de linha/bloco e blocos com dollar-quoting.
 * Retorna [{ inicio, fim, texto, linha }] (offset de fim exclusivo).
 */
export function dividirStatements(sql) {
  const statements = [];
  const n = sql.length;
  let i = 0;
  let inicio = 0;
  let linha = 1;
  let estado = null; // null | 'linha' | 'bloco' | "'" | '"' | 'dollar'
  let tag = null;
  const fechar = (fim) => statements.push({ inicio, fim, texto: sql.slice(inicio, fim), linha });
  while (i < n) {
    const ch = sql[i];
    const dois = sql.slice(i, i + 2);
    if (estado === null) {
      if (dois === '--') { estado = 'linha'; i += 2; continue; }
      if (dois === '/*') { estado = 'bloco'; i += 2; continue; }
      if (ch === "'") { estado = "'"; i += 1; continue; }
      if (ch === '"') { estado = '"'; i += 1; continue; }
      if (ch === '$') {
        const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
        if (m) { estado = 'dollar'; tag = m[0]; i += tag.length; continue; }
      }
      if (ch === ';') { fechar(i + 1); inicio = i + 1; i += 1; continue; }
      if (ch === '\n') linha += 1;
      i += 1;
    } else if (estado === 'linha') {
      if (ch === '\n') { estado = null; linha += 1; }
      i += 1;
    } else if (estado === 'bloco') {
      if (dois === '*/') { estado = null; i += 2; continue; }
      if (ch === '\n') linha += 1;
      i += 1;
    } else if (estado === "'" || estado === '"') {
      if (ch === estado) {
        if (sql.slice(i, i + 2) === estado + estado) { i += 2; continue; }
        estado = null;
      }
      if (ch === '\n') linha += 1;
      i += 1;
    } else if (estado === 'dollar') {
      if (sql.startsWith(tag, i)) { i += tag.length; estado = null; continue; }
      if (ch === '\n') linha += 1;
      i += 1;
    }
  }
  if (sql.slice(inicio).trim()) fechar(n);
  return statements;
}

function linhaEm(sql, offset) {
  let linha = 1;
  for (let i = 0; i < offset; i += 1) if (sql[i] === '\n') linha += 1;
  return linha;
}

/** Remove comentários iniciais para inspecionar o primeiro token. */
function corpoSemComentarios(stmt) {
  return stmt.replace(/^\s*(?:--[^\n]*\n|\s)*/, '');
}
/**
 * Reexecuta a criação/remoção de objetos da ESTRUTURA-BASE e de TODA a cadeia
 * versionada (em ordem lexical), devolvendo o conjunto de objetos que existem no
 * estado FINAL. Serve para não deixar no bootstrap um `CREATE` de objeto que a
 * cadeia derruba depois — o bootstrap roda a cada boot, então recriá-lo
 * desfaria a remoção (ver comentário de DROPS).
 */
export function objetosDoEstadoFinal(statementsBase, statementsCadeia) {
  const vivo = new Set();
  for (const texto of [...statementsBase, ...statementsCadeia]) {
    const corpo = texto.replace(/^\s*(?:--[^\n]*\n|\s)*/, '').trim();
    const criado = objetoCriado(corpo);
    if (criado) vivo.add(criado);
    for (const [re, kind] of DROPS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(corpo))) vivo.delete(`${kind}:${m[1].replace(/"/g, '')}`);
    }
  }
  return vivo;
}

/**
 * Extrai o bootstrap estrutural de db/schema.sql.
 * `statementsCadeia` (opcional) é a lista de statements de db/migrations/*.sql,
 * em ordem lexical; quando fornecida, o bootstrap não recria objetos que a
 * cadeia remove.
 * Retorna { sql, excluidos: [{ linha, motivo }] }.
 */
export function extrairBootstrap(sql, { statementsCadeia = [] } = {}) {
  const corte = linhaEm(sql, sql.indexOf(MARCADOR_CORTE));
  const excluidos = [];
  const mantidos = [];
  const candidatos = dividirStatements(sql).filter((s) => s.linha <= corte);

  // Objeto criado por cada candidato (nome+tipo), para o filtro de remoção.
  const corpoDe = (s) => corpoSemComentarios(s.texto).trim();
  const vivoFinal = objetosDoEstadoFinal(candidatos.map((s) => s.texto), statementsCadeia);

  for (const { texto, linha } of candidatos) {
    const corpo = corpoDe({ texto });
    const primeiro = /^([A-Za-z]+)/.exec(corpo)?.[1]?.toUpperCase() ?? '';
    if (['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE'].includes(primeiro)) {
      excluidos.push({ linha, motivo: `DML ${primeiro}` });
      continue;
    }
    if (/RAISE\s+EXCEPTION/i.test(texto)) {
      excluidos.push({ linha, motivo: 'RAISE EXCEPTION (preflight que aborta)' });
      continue;
    }
    const criado = objetoCriado(corpo);
    if (criado && !vivoFinal.has(criado)) {
      excluidos.push({ linha, motivo: `${criado} é removido pela cadeia versionada` });
      continue;
    }
    mantidos.push(texto.trim());
  }
  return { sql: CABECALHO + mantidos.join('\n\n') + '\n', excluidos };
}

/** Statements de db/migrations/*.sql, em ordem lexical de arquivo. */
function statementsDaCadeia() {
  const dir = path.join(RAIZ, 'db', 'migrations');
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const st of dividirStatements(readFileSync(path.join(dir, f), 'utf8'))) out.push(st.texto);
  }
  return out;
}

const ehPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (ehPrincipal) {
  const schema = readFileSync(SCHEMA, 'utf8');
  const { sql, excluidos } = extrairBootstrap(schema, { statementsCadeia: statementsDaCadeia() });
  const check = process.argv.includes('--check');
  const atual = readFileSync(BOOTSTRAP, 'utf8');
  if (check) {
    if (atual !== sql) {
      console.error('db/bootstrap.sql está defasado em relação a db/schema.sql. Rode: node scripts/gerar-bootstrap.mjs');
      process.exit(1);
    }
    console.log('db/bootstrap.sql está sincronizado com db/schema.sql.');
  } else {
    writeFileSync(BOOTSTRAP, sql, 'utf8');
    console.log(`db/bootstrap.sql gerado (${excluidos.length} statements excluídos: DML/preflight).`);
    for (const e of excluidos) console.log(`  - linha ${e.linha}: ${e.motivo}`);
  }
}
