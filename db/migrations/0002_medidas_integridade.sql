-- 0002_medidas_integridade.sql — integridade da tabela de medidas (2026-09-08)
--
-- Auditoria do módulo "Tabela de Medidas" (docs/AUDITORIA-MEDIDAS-2026-09-08.md):
-- a API aceita QUALQUER número em uma célula (negativo, 99.999 cm, "abc" virava
-- NULL silenciosamente) e nenhum registro no banco dizia quando a tabela foi
-- atualizada — o cliente via a grade sem nenhuma noção de confiabilidade.
--
-- 1) CHECK de sanidade física (guarda de último recurso; o limite POR UNIDADE
--    — cm ≤ 300, mm ≤ 3000, pol ≤ 150 — é validado na API em server/src/medidas.ts,
--    que dá a mensagem amigável. 3000 cobre o maior limite unitário: 3 m em mm).
-- 2) Backfill de `atualizado_em` nos valores existentes (usa a data da medida
--    da coluna, senão agora) — a coluna já vem do schema.sql idempotente.
--
-- Aplicado uma única vez pelo runner em server/src/db.ts (registrado em
-- schema_migrations). Idempotente por construção, no mesmo estilo do 0001.
-- Para aplicar à mão: psql -d brobond -f db/migrations/0002_medidas_integridade.sql

DO $mig$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('medida_valores', 'medida_valores_valor_sanity', $$ valor >= 0 AND valor <= 3000 $$)
    ) AS t(tbl, nome, expr)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.nome) THEN
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.nome, c.expr);
    EXCEPTION WHEN duplicate_object THEN
      CONTINUE;
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tbl, c.nome);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'aviso: % não validou os registros existentes (%) — segue valendo para toda gravação nova; revise os valores com psql: SELECT * FROM medida_valores WHERE valor < 0 OR valor > 3000', c.nome, SQLERRM;
    END;
    RAISE NOTICE 'constraint % aplicada em %', c.nome, c.tbl;
  END LOOP;
END
$mig$;

-- Backfill: quando a célula foi "atualizada pela última vez" não tem histórico;
-- a melhor aproximação é a data da coluna (medida.atualizado_em) — mantém o
-- painel de completude e o "atualizada em" do cliente coerentes.
UPDATE medida_valores v
SET atualizado_em = COALESCE(m.atualizado_em, now())
FROM medidas m
WHERE v.medida_id = m.id
  AND v.atualizado_em IS NULL;
