-- ============================================================================
-- PROD-DB-01.5 — PROPAGAÇÃO DO NOME CANÔNICO DE LOCAIS (correção E4.2)
--
-- Corrige, de forma administrativa, auditada e reversível, os registros cujo
-- texto de local ficou defasado do nome canônico apontado por `local_id`.
-- É exatamente a parcela `nomes_locais_inconsistentes` do preflight E4.2
-- (db/migrations/0030_e42_locais_estoque_multempresa.sql) que bloqueia o DDL.
--
-- NÃO é uma migration da aplicação: o boot NUNCA executa este arquivo. Ele é
-- um procedimento manual, rodado por um operador, fora da cadeia automática.
--
-- A regra E4.2 NÃO é alterada, o preflight NÃO é removido nem relaxado.
--
-- ----------------------------------------------------------------------------
-- COMO USAR (preferência: sempre rodar o DRY-RUN antes)
--
--   DRY-RUN (padrão, não escreve nada):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -f db/admin/005-propagar-nomes-locais-e42.sql
--
--   APPLY (dupla confirmação explícita; COMMIT ao final):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -v apply=on -v confirmacao=PROD-DB-01.5 \
--       -f db/admin/005-propagar-nomes-locais-e42.sql
--
-- SEGURANÇA:
--   • DRY-RUN por padrão: sem `-v apply=on` NADA é escrito.
--   • APPLY exige TAMBÉM `-v confirmacao=PROD-DB-01.5` (impede apply acidental).
--   • Tudo roda em UMA transação explícita: APPLY faz COMMIT; qualquer outro
--     caminho (erro, guarda acionada, dry-run) faz ROLLBACK.
--   • Guardas abortam (ROLLBACK) se existir QUALQUER caso que não seja classe B
--     (vínculo de outra empresa, texto NULL, órfão, ou diferença só de
--     caixa/espaço). Nada é alterado quando há ambiguidade.
--
-- PRECEDENTE: docs/RELATORIO-PROD-DB-01-4.md (diagnóstico read-only).
-- ============================================================================

\set ON_ERROR_STOP on

-- Modo: APPLY somente com parâmetro explícito; default é DRY-RUN.
\if :{?apply}
\else
  \set apply off
\endif
\if :{?confirmacao}
\else
  \set confirmacao off
\endif
SELECT set_config('e42.apply', :'apply', false) AS modo_apply,
       set_config('e42.confirmacao', :'confirmacao', false) AS confirmacao;

-- Transação explícita: nada é persistido até o COMMIT condicional no fim.
BEGIN;

-- ----------------------------------------------------------------------------
-- BLOCO AUTOCONTIDO. O teste PG (prod-db-015) extrai daqui até o terminador e
-- executa o bloco dentro de uma transação própria que faz ROLLBACK, para provar
-- a correção sem alterar o banco de teste. Mantenha o tag exatamente assim.
-- ----------------------------------------------------------------------------
DO $e42_propagar_nomes_locais$
DECLARE
  aplicar       BOOLEAN := coalesce(current_setting('e42.apply', true), 'off') IN ('on', 'true', '1', 'yes');
  confirmado    BOOLEAN := coalesce(current_setting('e42.confirmacao', true), '') = 'PROD-DB-01.5';
  total_antes   BIGINT;
  total_depois  BIGINT;
  a_casos       BIGINT;
  c_casos       BIGINT;
  b_casos       BIGINT;
  orfaos        BIGINT;
  upd_estoques  BIGINT := 0;
  upd_mov_local BIGINT := 0;
  upd_mov_dest BIGINT := 0;
  upd_inv       BIGINT := 0;
  r             RECORD;
BEGIN
  -- -------------------------------------------------------------------------
  -- (A) DIAGNÓSTICO BEFORE — as quatro parcelas exatas do preflight E4.2.
  -- -------------------------------------------------------------------------
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO total_antes;
  RAISE NOTICE 'E4.2/01.5 BEFORE nomes_locais_inconsistentes=%', total_antes;

  -- -------------------------------------------------------------------------
  -- (B) CLASSIFICAÇÃO por origem (mesma regra de A/B/C do PROD-DB-01.4).
  -- -------------------------------------------------------------------------
  FOR r IN
    WITH inc AS (
      SELECT 'estoques.local'::text AS origem, e.empresa_id AS reg_emp, l.empresa_id AS loc_emp, e.local AS txt, l.nome AS nome
        FROM estoques e JOIN locais l ON l.id = e.local_id
       WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
      UNION ALL
      SELECT 'movimentacoes.local', m.empresa_id, l.empresa_id, m.local, l.nome
        FROM movimentacoes m JOIN locais l ON l.id = m.local_id
       WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
      UNION ALL
      SELECT 'movimentacoes.local_destino', m.empresa_id, l.empresa_id, m.local_destino, l.nome
        FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
       WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
      UNION ALL
      SELECT 'inventarios.local', inv.empresa_id, l.empresa_id, inv.local, l.nome
        FROM inventarios inv JOIN locais l ON l.id = inv.local_id
       WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
    )
    SELECT origem,
      count(*) FILTER (WHERE reg_emp IS DISTINCT FROM loc_emp OR txt IS NULL) AS a,
      count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                         AND lower(btrim(txt)) = lower(btrim(nome)) AND txt IS DISTINCT FROM nome) AS c,
      count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                         AND lower(btrim(txt)) <> lower(btrim(nome))) AS b
    FROM inc GROUP BY origem ORDER BY origem
  LOOP
    RAISE NOTICE 'E4.2/01.5 origem=% A(vínculo/null)=% C(caixa/espaço)=% B(a corrigir)=%', r.origem, r.a, r.c, r.b;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- (C) PROTEÇÃO — aborta se houver QUALQUER caso que não seja classe B.
  -- -------------------------------------------------------------------------
  SELECT count(*) INTO orfaos FROM (
    SELECT e.id FROM estoques e LEFT JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND l.id IS NULL
    UNION ALL
    SELECT m.id FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND l.id IS NULL
    UNION ALL
    SELECT m.id FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND l.id IS NULL
    UNION ALL
    SELECT inv.id FROM inventarios inv LEFT JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND l.id IS NULL
  ) o;

  WITH inc AS (
    SELECT 'estoques.local'::text AS origem, e.empresa_id AS reg_emp, l.empresa_id AS loc_emp, e.local AS txt, l.nome AS nome
      FROM estoques e JOIN locais l ON l.id = e.local_id
     WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
    UNION ALL
    SELECT 'movimentacoes.local', m.empresa_id, l.empresa_id, m.local, l.nome
      FROM movimentacoes m JOIN locais l ON l.id = m.local_id
     WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
    UNION ALL
    SELECT 'movimentacoes.local_destino', m.empresa_id, l.empresa_id, m.local_destino, l.nome
      FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
     WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
    UNION ALL
    SELECT 'inventarios.local', inv.empresa_id, l.empresa_id, inv.local, l.nome
      FROM inventarios inv JOIN locais l ON l.id = inv.local_id
     WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
  )
  SELECT
    count(*) FILTER (WHERE reg_emp IS DISTINCT FROM loc_emp OR txt IS NULL),
    count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                       AND lower(btrim(txt)) = lower(btrim(nome)) AND txt IS DISTINCT FROM nome),
    count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                       AND lower(btrim(txt)) <> lower(btrim(nome)))
    INTO a_casos, c_casos, b_casos
  FROM inc;

  IF orfaos > 0 THEN
    RAISE EXCEPTION 'E4.2/01.5 ABORTADO: % registro(s) com local_id apontando para local inexistente (órfão). Nada foi alterado.', orfaos
      USING HINT = 'Corrija o vínculo canônico antes; não associe por nome.';
  END IF;
  IF a_casos > 0 THEN
    RAISE EXCEPTION 'E4.2/01.5 ABORTADO: % caso(s) classe A (vínculo de outra empresa ou texto de local NULL). Nada foi alterado.', a_casos
      USING HINT = 'Classe A exige revisão manual de empresa_id; não é correção automática por nome.';
  END IF;
  IF c_casos > 0 THEN
    RAISE EXCEPTION 'E4.2/01.5 ABORTADO: % caso(s) classe C (diferença apenas de caixa/espaço). Nada foi alterado.', c_casos
      USING HINT = 'Diferença cosmética: decida com a administração se normaliza; não é propagação de renome.';
  END IF;

  RAISE NOTICE 'E4.2/01.5 classificação: A=% C=% B=% (todos classe B: correção segura)', a_casos, c_casos, b_casos;

  IF NOT aplicar THEN
    RAISE NOTICE 'E4.2/01.5 DRY-RUN: nenhuma escrita. Seriam atualizados % registro(s) classe B.', b_casos;
    RAISE NOTICE 'E4.2/01.5 DRY-RUN: para aplicar use -v apply=on -v confirmacao=PROD-DB-01.5';
    RETURN;
  END IF;

  IF NOT confirmado THEN
    RAISE EXCEPTION 'E4.2/01.5 APPLY recusado: falta -v confirmacao=PROD-DB-01.5. Nada foi alterado.'
      USING HINT = 'A dupla confirmação evita APPLY acidental.';
  END IF;

  -- -------------------------------------------------------------------------
  -- (D) CORREÇÃO — junta SEMPRE por local_id + empresa_id (nunca por nome).
  -- -------------------------------------------------------------------------
  UPDATE estoques e SET local = l.nome
    FROM locais l
   WHERE e.local_id = l.id
     AND e.empresa_id = l.empresa_id
     AND e.local IS DISTINCT FROM l.nome;
  GET DIAGNOSTICS upd_estoques = ROW_COUNT;

  UPDATE movimentacoes m SET local = l.nome
    FROM locais l
   WHERE m.local_id = l.id
     AND m.empresa_id = l.empresa_id
     AND m.local IS DISTINCT FROM l.nome;
  GET DIAGNOSTICS upd_mov_local = ROW_COUNT;

  UPDATE movimentacoes m SET local_destino = l.nome
    FROM locais l
   WHERE m.local_destino_id = l.id
     AND m.empresa_id = l.empresa_id
     AND m.local_destino IS DISTINCT FROM l.nome;
  GET DIAGNOSTICS upd_mov_dest = ROW_COUNT;

  UPDATE inventarios inv SET local = l.nome
    FROM locais l
   WHERE inv.local_id = l.id
     AND inv.empresa_id = l.empresa_id
     AND inv.local IS DISTINCT FROM l.nome;
  GET DIAGNOSTICS upd_inv = ROW_COUNT;

  RAISE NOTICE 'E4.2/01.5 atualizados: estoques.local=%, movimentacoes.local=%, movimentacoes.local_destino=%, inventarios.local=% (total=%)',
    upd_estoques, upd_mov_local, upd_mov_dest, upd_inv,
    upd_estoques + upd_mov_local + upd_mov_dest + upd_inv;

  -- -------------------------------------------------------------------------
  -- (E) DIAGNÓSTICO AFTER — critério de aceite: nomes_locais_inconsistentes=0.
  -- -------------------------------------------------------------------------
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO total_depois;

  IF total_depois <> 0 THEN
    RAISE EXCEPTION 'E4.2/01.5 FALHOU: após a correção nomes_locais_inconsistentes=% (esperado 0). Transação revertida.', total_depois
      USING HINT = 'Nada foi persistido; investigue antes de repetir.';
  END IF;
  RAISE NOTICE 'E4.2/01.5 AFTER nomes_locais_inconsistentes=0 (de % para 0)', total_antes;
END
$e42_propagar_nomes_locais$;

-- ----------------------------------------------------------------------------
-- (F) SEGURANÇA — COMMIT só no APPLY explícito; qualquer outro caminho ROLLBACK.
-- ----------------------------------------------------------------------------
\if :apply
  COMMIT;
  \echo 'E4.2/01.5 APPLY: transação COMITADA. Confirme com o diagnóstico read-only (db/diagnostico-e42-nomes-locais.sql) que o contador está em 0.'
\else
  ROLLBACK;
  \echo 'E4.2/01.5 DRY-RUN: transação revertida (ROLLBACK). Nenhum dado foi alterado.'
\endif
