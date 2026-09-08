-- 0001_integridade_dominio.sql — regras de domínio no banco (revisão de 2026-09-08)
--
-- O banco não tinha NENHUMA constraint de CHECK: "saldo não pode ficar negativo",
-- "o tipo da movimentação é um destes quatro", "inventário é aberto ou fechado"
-- viviam só no código da API. Um INSERT/UPDATE direto (psql, import, correção
-- manual) escrevia qualquer valor e o estoque perdia a verdade.
--
-- Aplicado uma única vez pelo runner em server/src/db.ts, que registra o nome em
-- `schema_migrations`. Idempotente por construção: constraint que já existe é
-- pulada e a validação dos registros antigos é TENTADA sem quebrar o boot — se
-- houver linha ilegável, a constraint fica NOT VALID (continua valendo para toda
-- gravação nova) e o aviso sai no log.
--
-- Para aplicar à mão: psql -d brobond -f db/migrations/0001_integridade_dominio.sql
-- Se o índice único de saldos for pulado por duplicatas, limpe (conferindo antes
-- qual linha manter) e crie:
--   DELETE FROM estoques a USING estoques b
--    WHERE a.id > b.id AND a.produto_id = b.produto_id
--      AND COALESCE(a.tamanho_id, -1) = COALESCE(b.tamanho_id, -1) AND a.local = b.local;
--   CREATE UNIQUE INDEX ON estoques (produto_id, tamanho_id, local);

DO $mig$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('estoques',      'estoques_quantidade_nao_negativo',  $$ quantidade >= 0 $$),
      ('estoques',      'estoques_local_nao_vazio',          $$ length(btrim(local)) > 0 $$),
      ('movimentacoes', 'movimentacoes_tipo_valido',         $$ tipo IN ('entrada', 'saida', 'transferencia', 'ajuste') $$),
      ('movimentacoes', 'movimentacoes_quantidade_nao_zero', $$ quantidade <> 0 $$),
      ('inventarios',   'inventarios_status_valido',         $$ status IN ('aberto', 'fechado') $$),
      ('usuarios',      'usuarios_perfil_valido',            $$ perfil IN ('admin', 'gerente', 'operador') $$),
      ('vendas',        'vendas_nfe_status_valido',          $$ nfe_status IN ('nao_emitida', 'simulada', 'emitida', 'cancelada') $$)
    ) AS t(tbl, nome, expr)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.nome) THEN
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.nome, c.expr);
    EXCEPTION WHEN duplicate_object THEN
      CONTINUE; -- outra instância criou a mesma constraint neste instante
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tbl, c.nome);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'aviso: % não validou os registros existentes (%) — segue valendo para toda gravação nova', c.nome, SQLERRM;
    END;
    RAISE NOTICE 'constraint % aplicada em %', c.nome, c.tbl;
  END LOOP;
END
$mig$;

-- adjustStock/tryAdjustStock usam ON CONFLICT (produto_id, tamanho_id, local), que
-- exige índice único dessas colunas: num banco criado antes dessa linha do schema
-- ele falta, e aí qualquer baixa de estoque quebra. Cria quando não existe e
-- quando não há duplicatas — escolher qual linha manter é decisão do operador.
DO $idx$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname IN ('estoques_produto_id_tamanho_id_local_key', 'estoques_unico_produto_tamanho_local')
       AND relnamespace = current_schema()::regnamespace
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT produto_id, tamanho_id, local FROM estoques
       GROUP BY produto_id, tamanho_id, local HAVING COUNT(*) > 1
    ) d
  ) THEN
    RAISE NOTICE 'aviso: há saldos duplicados em estoques — o índice único (produto_id, tamanho_id, local) NÃO foi criado; limpe as linhas repetidas e reexecute este arquivo';
    RETURN;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS estoques_unico_produto_tamanho_local ON estoques (produto_id, tamanho_id, local);
END
$idx$;
