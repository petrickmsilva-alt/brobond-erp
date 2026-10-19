// ============================================================================
// PROD-DB-01.4 — DIAGNÓSTICO (READ-ONLY) de `nomes_locais_inconsistentes`.
//
// Contexto: o preflight da migração 0030 (E4.2) bloqueia o DDL quando encontra
// divergência entre o vínculo canônico (`local_id`) e o nome textual gravado em
// `estoques.local`, `movimentacoes.local`, `movimentacoes.local_destino` e
// `inventarios.local`. Em produção o contador acusou:
//
//   nomes_locais_inconsistentes=69
//
// Este arquivo NÃO corrige nada e NÃO executa escrita. Ele:
//   1. confirma que a consulta usada aqui é a MESMA da migração 0030 (lida do
//      arquivo, sem reescrever a regra E4.2 — nenhum mascaramento);
//   2. reproduz o contador em PostgreSQL 16;
//   3. lista, registro por registro, o que faz cada caso ser inconsistente:
//        - origem (tabela/coluna)
//        - id do registro
//        - id do local e nome atual do cadastro (`locais.nome`)
//        - empresa_id do cadastro do local e empresa_id do registro
//        - registro relacionado que causa a inconsistência (a linha `locais`)
//        - valor esperado (nome canônico) e valor encontrado (texto gravado)
//   4. classifica cada caso para separar dado realmente inconsistente (A),
//      dado historicamente válido que a regra nova passou a recusar (B) e
//      possível falso positivo da própria consulta (C).
//
// Apenas SELECT, CTE e EXPLAIN. Nenhum INSERT/UPDATE/DELETE/DDL.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-014-diagnostico-nomes-locais.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
  );
}

process.env.NODE_ENV = 'test';
const { query } = await import('../../src/db');

const MIGRATION = fileURLToPath(
  new URL('../../../db/migrations/0030_e42_locais_estoque_multempresa.sql', import.meta.url)
);

// ---------------------------------------------------------------------------
// Guarda de leitura: nenhuma instrução deste diagnóstico pode escrever. A
// verificação roda sobre o próprio texto SQL antes de enviá-lo ao banco.
// ---------------------------------------------------------------------------
const ESCRITA = /\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|copy|vacuum)\b/i;

async function somenteLeitura<T extends Record<string, any> = any>(sql: string, params?: unknown[]) {
  assert.ok(!ESCRITA.test(sql), `PROD-DB-01.4 é READ-ONLY; instrução de escrita detectada:\n${sql}`);
  return query<T>(sql, params);
}

// ---------------------------------------------------------------------------
// As QUATRO parcelas exatas que compõem `nomes_locais_inconsistentes` na
// migração 0030. Mantidas idênticas ao arquivo (com whitespace normalizado).
// ---------------------------------------------------------------------------
const PARCELAS = [
  'SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome',
  'SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome',
  'SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome',
  'SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome',
];

const CONTADOR_SQL = `SELECT
  (${PARCELAS[0]}) +
  (${PARCELAS[1]}) +
  (${PARCELAS[2]}) +
  (${PARCELAS[3]})
  AS nomes_locais_inconsistentes`;

// Detalhamento por registro. A coluna `local_empresa_id` vs `registro_empresa_id`
// e `so_diferenca_caixa_espaco` sustentam a classificação A/B/C.
const DETALHE_SQL = `
WITH inconsistencias AS (
  SELECT 'estoques'::text AS origem, e.id AS registro_id,
         e.local_id AS local_id, l.nome AS nome_atual,
         l.empresa_id AS local_empresa_id, e.empresa_id AS registro_empresa_id,
         e.local AS valor_encontrado, l.nome AS valor_esperado,
         l.ativo AS local_ativo
    FROM estoques e JOIN locais l ON l.id = e.local_id
   WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'movimentacoes.local'::text, m.id,
         m.local_id, l.nome,
         l.empresa_id, m.empresa_id,
         m.local, l.nome,
         l.ativo
    FROM movimentacoes m JOIN locais l ON l.id = m.local_id
   WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'movimentacoes.local_destino'::text, m.id,
         m.local_destino_id, l.nome,
         l.empresa_id, m.empresa_id,
         m.local_destino, l.nome,
         l.ativo
    FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
   WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'inventarios'::text, inv.id,
         inv.local_id, l.nome,
         l.empresa_id, inv.empresa_id,
         inv.local, l.nome,
         l.ativo
    FROM inventarios inv JOIN locais l ON l.id = inv.local_id
   WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
)
SELECT *,
       (lower(btrim(coalesce(valor_encontrado, ''))) = lower(btrim(nome_atual))) AS so_diferenca_caixa_espaco
  FROM inconsistencias
 ORDER BY origem, local_id, registro_id`;

type Caso = {
  origem: string;
  registro_id: number;
  local_id: number;
  nome_atual: string;
  local_empresa_id: number;
  registro_empresa_id: number;
  valor_encontrado: string | null;
  valor_esperado: string;
  local_ativo: boolean | null;
  so_diferenca_caixa_espaco: boolean;
};

function classificar(c: Caso): { classe: 'A' | 'B' | 'C'; motivo: string } {
  if (Number(c.local_empresa_id) !== Number(c.registro_empresa_id)) {
    return { classe: 'A', motivo: 'vínculo aponta para local de OUTRA empresa (deveria ser bloqueado também por vinculos_locais)' };
  }
  if (c.valor_encontrado === null || c.valor_encontrado === undefined) {
    return { classe: 'A', motivo: 'registro com local_id canônico mas texto de local AUSENTE (NULL)' };
  }
  if (c.so_diferenca_caixa_espaco) {
    return { classe: 'C', motivo: 'possível falso positivo: difere apenas em caixa/espaços; mesma localidade semântica' };
  }
  return {
    classe: 'B',
    motivo: 'texto histórico divergente do nome canônico (renome do local sem propagação para este registro)',
  };
}

async function appendResumo(markdown: string): Promise<void> {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p) return;
  await appendFile(p, `\n${markdown}\n`, 'utf8');
}

test('PROD-DB-01.4 — diagnostica exatamente quais registros fazem nomes_locais_inconsistentes', async () => {
  // -----------------------------------------------------------------------
  // 1) A consulta do diagnóstico é a MESMA da migração 0030 (sem mascarar).
  // -----------------------------------------------------------------------
  const migracao = readFileSync(MIGRATION, 'utf8');
  const normalizado = migracao.replace(/\s+/g, ' ');
  for (const parcela of PARCELAS) {
    assert.ok(
      normalizado.includes(parcela),
      `a parcela de nomes_locais_inconsistentes não foi encontrada verbatim na migração 0030:\n${parcela}`
    );
  }
  assert.ok(
    /nomes_locais_inconsistentes/.test(normalizado),
    'a variável nomes_locais_inconsistentes deve existir na migração 0030'
  );

  // -----------------------------------------------------------------------
  // 2) Schema presente? (o diagnóstico é read-only e não cria nada)
  // -----------------------------------------------------------------------
  const tabelas = await somenteLeitura<{ tabela: string; existe: boolean }>(`
    SELECT t AS tabela, to_regclass('public.' || t) IS NOT NULL AS existe
      FROM unnest(ARRAY['locais','estoques','movimentacoes','inventarios']) AS t`);
  const faltando = tabelas.rows.filter((r) => !r.existe).map((r) => r.tabela);
  assert.equal(
    faltando.length,
    0,
    `PROD-DB-01.4 exige o schema E4.2 aplicado; ausente: ${faltando.join(', ')}. ` +
      'Este teste é READ-ONLY e de propósito NÃO chama migrate() (pode ser apontado ao banco real). ' +
      'Rode-o depois das migrações — no gate PostgreSQL os arquivos anteriores já as aplicam.'
  );

  // -----------------------------------------------------------------------
  // 3) Contador exato (reprodução da migração 0030) + EXPLAIN.
  // -----------------------------------------------------------------------
  const contador = await somenteLeitura<{ nomes_locais_inconsistentes: string }>(CONTADOR_SQL);
  const total = Number(contador.rows[0].nomes_locais_inconsistentes);

  const plano = await somenteLeitura(`EXPLAIN ${CONTADOR_SQL}`);

  // -----------------------------------------------------------------------
  // 4) Detalhamento registro por registro.
  // -----------------------------------------------------------------------
  const detalhe = await somenteLeitura<Caso>(DETALHE_SQL);
  assert.equal(
    detalhe.rows.length,
    total,
    'o detalhamento deve ter exatamente a mesma quantidade de linhas do contador do preflight'
  );

  const porOrigem = new Map<string, number>();
  const porClasse = new Map<'A' | 'B' | 'C', number>([['A', 0], ['B', 0], ['C', 0]]);
  const porLocal = new Map<number, number>();
  const classificados = detalhe.rows.map((c) => {
    const k = classificar(c);
    porOrigem.set(c.origem, (porOrigem.get(c.origem) ?? 0) + 1);
    porClasse.set(k.classe, (porClasse.get(k.classe) ?? 0) + 1);
    porLocal.set(Number(c.local_id), (porLocal.get(Number(c.local_id)) ?? 0) + 1);
    return { ...c, ...k };
  });

  const linhas = [
    `nomes_locais_inconsistentes=${total}`,
    `  por origem: ${[...porOrigem.entries()].map(([o, n]) => `${o}=${n}`).join(', ') || '(nenhuma)'}`,
    `  por classe: A(dado inconsistente)=${porClasse.get('A')}, B(histórico válido vs regra nova)=${porClasse.get('B')}, C(possível falso positivo)=${porClasse.get('C')}`,
    `  por local_id: ${[...porLocal.entries()].map(([id, n]) => `local ${id}=${n}`).join(', ') || '(nenhum)'}`,
  ];

  console.log('\n=== PROD-DB-01.4 — nomes_locais_inconsistentes ===');
  for (const l of linhas) console.log(l);
  console.log('--- plano do contador ---');
  for (const r of plano.rows as { 'QUERY PLAN': string }[]) console.log(`  ${r['QUERY PLAN']}`);
  console.log('--- registros (origem | registro_id | local_id | empresa local/registro | esperado | encontrado | classe) ---');
  for (const c of classificados) {
    console.log(
      `  ${c.origem} | id=${c.registro_id} | local_id=${c.local_id} | empresa local=${c.local_empresa_id}/registro=${c.registro_empresa_id}` +
        ` | esperado="${c.valor_esperado}" | encontrado="${c.valor_encontrado ?? '<NULL>'}" | ${c.classe} (${c.motivo})`
    );
  }

  await appendResumo(
    [
      '### PROD-DB-01.4 — nomes_locais_inconsistentes',
      ...linhas.map((l) => `- ${l}`),
      '',
      '| origem | registro_id | local_id | empresa local | empresa registro | esperado | encontrado | classe |',
      '|---|---|---|---|---|---|---|---|',
      ...classificados
        .slice(0, 200)
        .map(
          (c) =>
            `| ${c.origem} | ${c.registro_id} | ${c.local_id} | ${c.local_empresa_id} | ${c.registro_empresa_id} | ${c.valor_esperado} | ${c.valor_encontrado ?? '<NULL>'} | ${c.classe} |`
        ),
    ].join('\n')
  );

  // -----------------------------------------------------------------------
  // 5) Garantias do diagnóstico (não da correção): nenhuma escrita foi feita.
  // -----------------------------------------------------------------------
  const agora = await somenteLeitura<{ total: string }>(CONTADOR_SQL);
  assert.equal(
    Number(agora.rows[0].nomes_locais_inconsistentes),
    total,
    'o diagnóstico é READ-ONLY: o contador não pode mudar durante a execução'
  );
});
