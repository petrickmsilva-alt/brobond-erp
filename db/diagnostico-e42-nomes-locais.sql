-- ============================================================================
-- PROD-DB-01.4 — DIAGNÓSTICO READ-ONLY de `nomes_locais_inconsistentes`
--
-- Reproduz, em PostgreSQL, a parcela `nomes_locais_inconsistentes` do preflight
-- E4.2 (db/migrations/0030_e42_locais_estoque_multempresa.sql) e lista, registro
-- por registro, o que faz cada caso ser considerado inconsistente.
--
-- REGRA: SOMENTE LEITURA. Nenhum INSERT/UPDATE/DELETE/DDL. Seguro rodar em
-- produção:
--
--   psql "$DATABASE_URL" -f db/diagnostico-e42-nomes-locais.sql
--
-- A regra E4.2 NÃO é alterada nem mascarada: as quatro parcelas do contador
-- abaixo são idênticas às da migração 0030.
-- ============================================================================

-- 1) CONTADOR — as quatro parcelas exatas do preflight (soma = 69 em produção).
SELECT
  (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
    WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome)
+ (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
    WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome)
+ (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
    WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome)
+ (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
    WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
  AS nomes_locais_inconsistentes;

-- 2) DISTRIBUIÇÃO por origem (quantos em cada tabela/coluna).
WITH inconsistencias AS (
  SELECT 'estoques'::text AS origem, e.id AS registro_id
    FROM estoques e JOIN locais l ON l.id = e.local_id
   WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'movimentacoes.local', m.id
    FROM movimentacoes m JOIN locais l ON l.id = m.local_id
   WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'movimentacoes.local_destino', m.id
    FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
   WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'inventarios', inv.id
    FROM inventarios inv JOIN locais l ON l.id = inv.local_id
   WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
)
SELECT origem, count(*) AS qtd FROM inconsistencias GROUP BY origem ORDER BY qtd DESC;

-- 3) DETALHE registro por registro — o que faz cada caso ser inconsistente:
--    id do registro, id do local, nome atual do cadastro (`locais.nome`),
--    empresa do cadastro x empresa do registro, registro relacionado (a linha
--    `locais`), valor esperado e valor encontrado.
WITH inconsistencias AS (
  SELECT 'estoques'::text AS origem, e.id AS registro_id,
         e.local_id AS local_id, l.id AS local_cadastro_id, l.nome AS nome_atual,
         l.empresa_id AS local_empresa_id, e.empresa_id AS registro_empresa_id,
         l.ativo AS local_ativo,
         e.local AS valor_encontrado, l.nome AS valor_esperado
    FROM estoques e JOIN locais l ON l.id = e.local_id
   WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'movimentacoes.local', m.id, m.local_id, l.id, l.nome, l.empresa_id, m.empresa_id,
         l.ativo, m.local, l.nome
    FROM movimentacoes m JOIN locais l ON l.id = m.local_id
   WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'movimentacoes.local_destino', m.id, m.local_destino_id, l.id, l.nome, l.empresa_id, m.empresa_id,
         l.ativo, m.local_destino, l.nome
    FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
   WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
  UNION ALL
  SELECT 'inventarios', inv.id, inv.local_id, l.id, l.nome, l.empresa_id, inv.empresa_id,
         l.ativo, inv.local, l.nome
    FROM inventarios inv JOIN locais l ON l.id = inv.local_id
   WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
)
SELECT
  origem, registro_id, local_id, local_cadastro_id,
  nome_atual AS cadastro_nome_atual,
  local_empresa_id, registro_empresa_id,
  (local_empresa_id IS DISTINCT FROM registro_empresa_id) AS empresa_diverge,
  valor_esperado, valor_encontrado,
  (lower(btrim(coalesce(valor_encontrado, ''))) = lower(btrim(nome_atual))) AS so_caixa_espaco,
  CASE
    WHEN local_empresa_id IS DISTINCT FROM registro_empresa_id THEN 'A (vínculo de outra empresa)'
    WHEN valor_encontrado IS NULL THEN 'A (texto de local ausente)'
    WHEN lower(btrim(coalesce(valor_encontrado, ''))) = lower(btrim(nome_atual)) THEN 'C (possível falso positivo: caixa/espaço)'
    ELSE 'B (histórico válido vs regra nova: renome sem propagação)'
  END AS classe
FROM inconsistencias
ORDER BY origem, local_id, registro_id;

-- 4) AGRUPAMENTO por local — os 69 casos, em geral, se concentram em poucos
--    locais renomeados; este bloco mostra quantos registros cada local afeta.
WITH inconsistencias AS (
  SELECT e.local_id, l.nome AS nome_atual
    FROM estoques e JOIN locais l ON l.id = e.local_id
   WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT m.local_id, l.nome FROM movimentacoes m JOIN locais l ON l.id = m.local_id
   WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
  UNION ALL
  SELECT m.local_destino_id, l.nome FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
   WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
  UNION ALL
  SELECT inv.local_id, l.nome FROM inventarios inv JOIN locais l ON l.id = inv.local_id
   WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
)
SELECT local_id, nome_atual, count(*) AS registros_afetados
  FROM inconsistencias GROUP BY local_id, nome_atual ORDER BY registros_afetados DESC;
