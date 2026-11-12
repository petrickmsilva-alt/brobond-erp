#!/usr/bin/env node
// ============================================================================
// CRIAÇÃO SEGURA DOS ÍNDICES DA MIGRAÇÃO 0121 (CREATE INDEX CONCURRENTLY)
//
// POR QUE UM SCRIPT, SE JÁ EXISTE MIGRAÇÃO?
//   A migração roda dentro de uma transação — e `CREATE INDEX CONCURRENTLY`
//   NÃO pode rodar em transação. Em produção, `CREATE INDEX` comum bloqueia
//   escrita na tabela enquanto constrói (produtos, com milhares de linhas,
//   trava o PDV por segundos). Este script é o caminho sem bloqueio:
//
//     1. verifica se pg_trgm está disponível (e se já está instalada);
//     2. confere quais índices já existem;
//     3. mostra EXATAMENTE o que faria, sem tocar no banco (padrão);
//     4. com --apply, cria um a um com CONCURRENTLY, reportando tempo e tamanho;
//     5. valida no fim (indisvalid = false, pg_index) e relata.
//
// Uso:
//   PERF_DB_URL='postgres://...' node scripts/perf/indices-concurrently.mjs            # dry-run
//   PERF_DB_URL='postgres://...' node scripts/perf/indices-concurrently.mjs --apply    # aplica
//
// PRÉ-REQUISITOS DE OPERAÇÃO (não automatizados de propósito)
//   • Backup/recuperação verificados ANTES (branch do Neon ou pg_dump).
//   • Janela de baixo tráfego: CONCURRENTLY evita bloqueio, mas consome CPU/IO.
//   • Se um índice ficar INVÁLIDO (falha no meio), drop e recrie — o script avisa.
// ============================================================================
const args = process.argv.slice(2);
const APLICAR = args.includes('--apply');
const URL_BANCO = process.env.PERF_DB_URL || '';

if (!URL_BANCO.trim()) {
  console.error('Defina PERF_DB_URL. Abortando.');
  process.exit(2);
}

const { default: pg } = await import('pg');

// (tabela, nome do índice, expressão) — espelha db/migrations/0121.
const INDICES = [
  ['produtos', 'perf_produtos_nome_trgm', '(nome gin_trgm_ops)'],
  ['produtos', 'perf_produtos_sku_trgm', '(sku gin_trgm_ops)'],
  ['produtos', 'perf_produtos_codigo_barras_trgm', '(codigo_barras gin_trgm_ops)'],
  ['clientes', 'perf_clientes_nome_trgm', '(nome gin_trgm_ops)'],
  ['fornecedores', 'perf_fornecedores_nome_trgm', '(nome gin_trgm_ops)'],
];

const cliente = new pg.Client({ connectionString: URL_BANCO, application_name: 'brobond-perf-indices' });
await cliente.connect();

try {
  const disponivel = (await cliente.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm'`)).rowCount > 0;
  const instalada = (await cliente.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)).rowCount > 0;
  console.log(`pg_trgm disponível: ${disponivel} · instalada: ${instalada}`);

  if (!disponivel) {
    console.error('pg_trgm não está disponível neste servidor: os índices de trigram não podem ser criados. A busca continua correta, apenas sem aceleração.');
    process.exit(0);
  }
  if (!instalada) {
    if (!APLICAR) {
      console.log('→ [dry-run] criaria a extensão: CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    } else {
      await cliente.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      console.log('✅ extensão pg_trgm criada.');
    }
  }

  let criados = 0;
  for (const [tabela, nome, expressao] of INDICES) {
    const existeTabela = (await cliente.query('SELECT to_regclass($1) AS t', [`public.${tabela}`])).rows[0]?.t;
    if (!existeTabela) {
      console.log(`- ${tabela}: tabela inexistente, pulando ${nome}.`);
      continue;
    }
    const existe = (await cliente.query('SELECT to_regclass($1) AS i', [`public.${nome}`])).rows[0]?.i;
    if (existe) {
      console.log(`= ${nome}: já existe.`);
      continue;
    }
    const ddl = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${nome} ON ${tabela} USING gin ${expressao}`;
    if (!APLICAR) {
      console.log(`→ [dry-run] ${ddl}`);
      continue;
    }
    console.log(`… criando ${nome} (CONCURRENTLY, sem bloquear escrita)`);
    const inicio = Date.now();
    await cliente.query(ddl);
    const ms = Date.now() - inicio;
    const tamanho = (
      await cliente.query(`SELECT pg_size_pretty(pg_relation_size($1)) AS t`, [`public.${nome}`])
    ).rows[0]?.t;
    const valido = (
      await cliente.query(
        `SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
        [nome]
      )
    ).rows[0]?.indisvalid;
    console.log(`✅ ${nome} em ${ms} ms · ${tamanho} · válido=${valido}`);
    if (valido === false) {
      console.error(`⚠️  ${nome} ficou INVÁLIDO. Recrie: DROP INDEX CONCURRENTLY ${nome}; e rode de novo.`);
    }
    criados++;
  }
  console.log(APLICAR ? `\nConcluído: ${criados} índice(s) criado(s).` : '\nDry-run: nada foi alterado. Use --apply para criar.');
} finally {
  await cliente.end().catch(() => undefined);
}
