#!/usr/bin/env node
// ============================================================================
// EXPLAIN (ANALYZE, BUFFERS) DAS CONSULTAS QUENTES DO ERP
//
// Roda os formatos de consulta que a aplicação realmente emite — listagem
// paginada genérica, busca de SKU com trigram, estoque por produto,
// movimentações, galeria de arquivos, fila do commerce e auditoria — e mostra
// plano, tempo de execução, quantas linhas foram varridas e QUAL índice foi
// usado. É o instrumento que justifica (ou dispensa) um índice novo.
//
// SEGURANÇA (obrigatório ler)
//   • Só aceita SELECT / WITH. Qualquer outro verbo aborta o script.
//   • Abre transação READ ONLY + `statement_timeout` — não há como escrever.
//   • Exige `PERF_DB_URL` explícito; NUNCA usa DATABASE_URL da aplicação por
//     acidente. Recusa hosts que pareçam produção sem `--permitir-producao`.
//   • Use preferencialmente um BRANCH do Neon (cópia isolada) ou banco de teste.
//
// Uso:
//   PERF_DB_URL='postgres://...' node scripts/perf/explain-analyze.mjs \
//     [--empresa 1] [--produto 1] [--termo CAM] [--json saida.json] [--top 20]
//
// Para comparar ANTES × DEPOIS: rode e salve `--json antes.json`, aplique a
// migração 0121 (ou o script indices-concurrently), rode de novo com
// `--json depois.json` e compare os tempos de execução.
// ============================================================================
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const temFlag = (nome) => args.includes(`--${nome}`);

const URL_BANCO = process.env.PERF_DB_URL || '';
const EMPRESA = Number(arg('empresa', 1));
const PRODUTO = Number(arg('produto', 1));
const TERMO = String(arg('termo', 'CAM'));
const JSON_SAIDA = arg('json', '');
const TIMEOUT_MS = Number(arg('timeout', 30_000));

if (!URL_BANCO.trim()) {
  console.error('Defina PERF_DB_URL (nunca a DATABASE_URL de produção). Abortando.');
  process.exit(2);
}
if (/prod|production/i.test(URL_BANCO) && !temFlag('permitir-producao')) {
  console.error('A URL parece apontar para produção. Use um branch/banco de teste ou passe --permitir-producao conscientemente.');
  process.exit(2);
}

const { default: pg } = await import('pg');

// Formas de consulta espelhando server/src/pgstore.ts e productSearch.ts
// (parâmetros idênticos em forma; valores são apenas plausíveis).
const CONSULTAS = [
  {
    nome: 'listagem produtos (COUNT)',
    sql: `SELECT COUNT(*)::int AS total FROM produtos t WHERE t.empresa_id = $1`,
    params: [EMPRESA],
  },
  {
    nome: 'listagem produtos (página ordenada)',
    sql: `SELECT t.id, t.sku, t.nome, t.preco_venda FROM produtos t
           WHERE t.empresa_id = $1
           ORDER BY t.nome ASC NULLS LAST, t.id DESC LIMIT 25 OFFSET 0`,
    params: [EMPRESA],
  },
  {
    nome: 'busca por texto/SKU (ILIKE com curinga à esquerda)',
    sql: `SELECT t.id, t.sku, t.nome FROM produtos t
           WHERE t.empresa_id = $1
             AND (t.nome::text ILIKE $2 OR t.sku::text ILIKE $2 OR t.codigo_barras::text ILIKE $2)
           ORDER BY t.nome ASC NULLS LAST, t.id DESC LIMIT 25`,
    params: [EMPRESA, `%${TERMO}%`],
  },
  {
    nome: 'estoque por produto (agregação por tamanho)',
    sql: `SELECT e.produto_id, e.tamanho_id, sum(e.quantidade)::double precision AS quantidade
            FROM estoques e
            JOIN produtos p ON p.id = e.produto_id AND p.empresa_id = $1
           WHERE e.empresa_id = $1 AND (p.id = $2 OR p.produto_pai_id = $2)
           GROUP BY e.produto_id, e.tamanho_id`,
    params: [EMPRESA, PRODUTO],
  },
  {
    nome: 'movimentações por produto (timeline)',
    sql: `SELECT t.id, t.data, t.tipo, t.quantidade FROM movimentacoes t
           WHERE t.produto_id = $1
           ORDER BY t.data DESC NULLS LAST, t.id DESC LIMIT 50`,
    params: [PRODUTO],
  },
  {
    nome: 'galeria de arquivos por registro',
    sql: `SELECT id, url, principal, ordem FROM arquivos
           WHERE recurso = $1 AND registro_id = ANY($2::int[]) AND ativo = TRUE
           ORDER BY principal DESC, ordem ASC, id ASC`,
    params: ['produtos', [PRODUTO]],
  },
  {
    nome: 'fila do commerce (claim)',
    sql: `SELECT id, tipo, chave FROM commerce_outbox
           WHERE estado = 'PENDENTE' AND proxima_tentativa_em <= now()
           ORDER BY proxima_tentativa_em LIMIT 20`,
    params: [],
  },
  {
    nome: 'auditoria (lista da empresa)',
    sql: `SELECT t.id, t.data, t.recurso FROM auditoria t
           WHERE t.empresa_id = $1
           ORDER BY t.data DESC NULLS LAST, t.id DESC LIMIT 25`,
    params: [EMPRESA],
  },
  {
    nome: 'vendas (lista da empresa)',
    sql: `SELECT t.id, t.data, t.status FROM vendas t
           WHERE t.empresa_id = $1
           ORDER BY t.data DESC NULLS LAST, t.id DESC LIMIT 25`,
    params: [EMPRESA],
  },
];

const SOMENTE_LEITURA = /^\s*(select|with)\b/i;

/** Resume o plano JSON: tempo, varreduras sequenciais e índices usados. */
function resumirPlano(planoJson) {
  const raiz = Array.isArray(planoJson) ? planoJson[0] : planoJson;
  const plano = raiz?.Plan ?? {};
  const nos = [];
  const visitar = (no) => {
    if (!no) return;
    nos.push(no);
    for (const filho of no.Plans ?? []) visitar(filho);
  };
  visitar(plano);
  const seqScans = nos.filter((n) => n['Node Type'] === 'Seq Scan');
  return {
    tempo_execucao_ms: raiz?.['Execution Time'] ?? null,
    tempo_planejamento_ms: raiz?.['Planning Time'] ?? null,
    linhas_retornadas: plano['Actual Rows'] ?? null,
    nos: nos.length,
    seq_scans: seqScans.map((n) => ({
      tabela: n['Relation Name'],
      linhas_varridas: n['Actual Rows'],
      filtro_removido_pct: n['Rows Removed by Filter'] ?? 0,
    })),
    indices_usados: [...new Set(nos.filter((n) => n['Index Name']).map((n) => n['Index Name']))],
    trabalha_em_memoria: nos.some((n) => n['Node Type'] === 'Sort' && n['Sort Method']?.includes('external')),
  };
}

const cliente = new pg.Client({ connectionString: URL_BANCO, application_name: 'brobond-perf-explain' });
await cliente.connect();

const resultados = [];
try {
  // Sessão explicitamente somente leitura e limitada no tempo.
  await cliente.query('BEGIN TRANSACTION READ ONLY');
  await cliente.query(`SET LOCAL statement_timeout = ${Math.max(1000, TIMEOUT_MS)}`);

  for (const c of CONSULTAS) {
    if (!SOMENTE_LEITURA.test(c.sql)) {
      console.error(`⛔ Consulta recusada (não é somente leitura): ${c.nome}`);
      continue;
    }
    try {
      const { rows } = await cliente.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${c.sql}`,
        c.params
      );
      const resumo = resumirPlano(rows[0]['QUERY PLAN']);
      resultados.push({
        nome: c.nome,
        ...resumo,
        veredito:
          resumo.tempo_execucao_ms !== null && resumo.tempo_execucao_ms > 300
            ? 'LENTA (>300ms)'
            : resumo.seq_scans.length
              ? 'SEQ SCAN'
              : 'ok',
      });
      console.log(
        `\n▸ ${c.nome}\n  execução ${resumo.tempo_execucao_ms?.toFixed?.(2) ?? resumo.tempo_execucao_ms} ms` +
          ` · planejamento ${resumo.tempo_planejamento_ms?.toFixed?.(2) ?? resumo.tempo_planejamento_ms} ms` +
          ` · linhas ${resumo.linhas_retornadas}`
      );
      if (resumo.indices_usados.length) console.log(`  índices: ${resumo.indices_usados.join(', ')}`);
      if (resumo.seq_scans.length) {
        console.log(
          `  ⚠️  seq scan: ${resumo.seq_scans
            .map((s) => `${s.tabela} (${s.linhas_varridas} linhas)`)
            .join(', ')}`
        );
      }
    } catch (e) {
      resultados.push({ nome: c.nome, erro: String(e.message || e).slice(0, 200) });
      console.log(`\n▸ ${c.nome}\n  ⚠️  não executou: ${String(e.message || e).slice(0, 160)}`);
    }
  }
  await cliente.query('ROLLBACK');
} finally {
  await cliente.end().catch(() => undefined);
}

if (JSON_SAIDA) {
  writeFileSync(JSON_SAIDA, JSON.stringify({ gerado_em: new Date().toISOString(), empresa: EMPRESA, produto: PRODUTO, termo: TERMO, consultas: resultados }, null, 2));
  console.log(`\n💾 JSON salvo em ${JSON_SAIDA}`);
}

const lentas = resultados.filter((r) => (r.tempo_execucao_ms ?? 0) > 300);
console.log(`\n=== Resumo: ${resultados.length} consultas · ${lentas.length} acima de 300 ms ===`);
