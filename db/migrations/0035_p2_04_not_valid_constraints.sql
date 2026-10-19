-- ============================================================================
-- P2-04 — Constraints PostgreSQL marcadas como NOT VALID (auditoria forense).
--
-- ACHADO: o FULL FORENSIC SYSTEM AUDIT encontrou constraints CHECK criadas com
-- `NOT VALID` e nunca validadas. O inventário real em PostgreSQL 16.14
-- (pg_constraint.convalidated = false) aponta exatamente 8 constraints, todas
-- CHECK, todas em tabelas financeiras:
--
--   | constraint                          | tabela                    | origem |
--   |-------------------------------------|---------------------------|--------|
--   | ck_lanc_fin_valor_positivo          | lancamentos_financeiros   | 0011   |
--   | ck_lanc_fin_taxa_pct                | lancamentos_financeiros   | 0011   |
--   | ck_transf_fin_valor_positivo        | transferencias_financeiras| 0011   |
--   | ck_transf_fin_contas_diferentes     | transferencias_financeiras| 0011   |
--   | ck_gateway_cobrancas_valor          | gateway_cobrancas         | 0025   |
--   | ck_gateway_cobrancas_metodo         | gateway_cobrancas         | 0025   |
--   | ck_gateway_cobrancas_status         | gateway_cobrancas         | 0025   |
--   | ck_extrato_valor_positivo           | fin_extrato_transacoes    | 0025   |
--
-- Nenhuma FK, UNIQUE, PK ou EXCLUDE está NOT VALID. Não há constraint NOT VALID
-- fora do financeiro.
--
-- ORIGEM (por que nasceram NOT VALID): 0011 e 0025 são migrações sobre tabelas
-- que JÁ existiam com dados. O padrão do projeto — documentado em 0001/0002 — é
-- criar o CHECK como NOT VALID (protege toda escrita NOVA imediatamente) e
-- tentar `VALIDATE CONSTRAINT` logo em seguida; se houver linha legada
-- incompatível, a validação é adiada com RAISE NOTICE em vez de derrubar o boot.
-- Em 0011 e 0025, porém, a VALIDATE foi esquecida: as constraints ficaram
-- NOT VALID para SEMPRE, mesmo em banco novo e vazio, onde não há nada a
-- adiar. É um artefato de migração, não uma decisão de negócio.
--
-- ESTADO DOS DADOS (banco fresco 16.14, pg_constraint): 0 violações em todas as
-- 8. As regras continuam válidas: valor > 0, 0 <= taxa_pct < 100, contas
-- diferentes, método/status do gateway no vocabulário canônico.
--
-- CORREÇÃO (determinística e idempotente):
--   1) DIAGNÓSTICO somente leitura: conta as violações de cada regra.
--   2) Se o conjunto está LIMPO: `VALIDATE CONSTRAINT` (convalidated = true).
--      A validação é barata aqui: as tabelas são pequenas e os CHECKs têm
--      índice/utilização direta de coluna; o ACCESS EXCLUSIVE dura só o scan.
--   3) Se houver violação legada: a constraint PERMANECE NOT VALID (escritas
--      novas seguem bloqueadas) e o upgrade emite RAISE NOTICE com a contagem —
--      sem backfill heurístico, sem DELETE em massa, sem inventar valores.
--      Isso é o mesmo contrato de 0032 (vocabulário de expedição).
--
-- NÃO corrige dados especulativamente. Se um dia houver violação, a decisão é
-- de negócio, não da migração.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Diagnóstico (somente leitura) — evidência do estado real ANTES do DDL.
-- ----------------------------------------------------------------------------
DO $p204_diagnostico$
DECLARE
  n_lanc_valor   INTEGER;
  n_lanc_taxa    INTEGER;
  n_transf_valor INTEGER;
  n_transf_contas INTEGER;
  n_gw_valor     INTEGER;
  n_gw_metodo    INTEGER;
  n_gw_status    INTEGER;
  n_extrato_valor INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_lanc_valor    FROM lancamentos_financeiros   WHERE NOT (valor > 0);
  SELECT COUNT(*) INTO n_lanc_taxa     FROM lancamentos_financeiros   WHERE NOT (taxa_pct >= 0 AND taxa_pct < 100);
  SELECT COUNT(*) INTO n_transf_valor  FROM transferencias_financeiras WHERE NOT (valor > 0);
  SELECT COUNT(*) INTO n_transf_contas FROM transferencias_financeiras WHERE NOT (conta_origem_id <> conta_destino_id);
  SELECT COUNT(*) INTO n_gw_valor      FROM gateway_cobrancas          WHERE NOT (valor > 0);
  SELECT COUNT(*) INTO n_gw_metodo     FROM gateway_cobrancas          WHERE NOT (metodo IN ('pix','boleto','cartao_credito','cartao_debito'));
  SELECT COUNT(*) INTO n_gw_status     FROM gateway_cobrancas          WHERE NOT (status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou'));
  SELECT COUNT(*) INTO n_extrato_valor FROM fin_extrato_transacoes     WHERE NOT (valor > 0);
  RAISE NOTICE 'P2-04 diagnóstico (violações por regra): lanc_valor=%, lanc_taxa=%, transf_valor=%, transf_contas=%, gw_valor=%, gw_metodo=%, gw_status=%, extrato_valor=%',
    n_lanc_valor, n_lanc_taxa, n_transf_valor, n_transf_contas, n_gw_valor, n_gw_metodo, n_gw_status, n_extrato_valor;
END
$p204_diagnostico$;

-- ----------------------------------------------------------------------------
-- 2) Validação condicional — VALIDATE só quando o conjunto está limpo.
--    Idempotente: reexecutar em banco já validado não faz nada (convalidated).
-- ----------------------------------------------------------------------------
DO $p204_valida$
DECLARE
  c RECORD;
  n_violacoes BIGINT;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('lancamentos_financeiros',    'ck_lanc_fin_valor_positivo',       $$ NOT (valor > 0) $$),
      ('lancamentos_financeiros',    'ck_lanc_fin_taxa_pct',             $$ NOT (taxa_pct >= 0 AND taxa_pct < 100) $$),
      ('transferencias_financeiras', 'ck_transf_fin_valor_positivo',     $$ NOT (valor > 0) $$),
      ('transferencias_financeiras', 'ck_transf_fin_contas_diferentes',  $$ NOT (conta_origem_id <> conta_destino_id) $$),
      ('gateway_cobrancas',          'ck_gateway_cobrancas_valor',       $$ NOT (valor > 0) $$),
      ('gateway_cobrancas',          'ck_gateway_cobrancas_metodo',      $$ NOT (metodo IN ('pix','boleto','cartao_credito','cartao_debito')) $$),
      ('gateway_cobrancas',          'ck_gateway_cobrancas_status',      $$ NOT (status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou')) $$),
      ('fin_extrato_transacoes',     'ck_extrato_valor_positivo',        $$ NOT (valor > 0) $$)
    ) AS v(tabela, nome, regra_invalida)
  LOOP
    -- Só existe constraint a validar se a tabela/constraint existem neste banco.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('public.' || c.tabela) AND conname = c.nome
    ) THEN
      CONTINUE;
    END IF;
    -- Já validada (ex.: reexecução): nada a fazer.
    IF (SELECT convalidated FROM pg_constraint
         WHERE conrelid = to_regclass('public.' || c.tabela) AND conname = c.nome) THEN
      CONTINUE;
    END IF;

    EXECUTE format('SELECT COUNT(*) FROM %I WHERE %s', c.tabela, c.regra_invalida) INTO n_violacoes;
    IF n_violacoes = 0 THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tabela, c.nome);
      RAISE NOTICE 'P2-04: constraint %.% VALIDADA (0 violações).', c.tabela, c.nome;
    ELSE
      RAISE NOTICE 'P2-04: constraint %.% MANTIDA NOT VALID — % linha(s) legada(s) violam a regra. Escritas novas já são recusadas; a validação exige decisão de negócio sobre os dados históricos.', c.tabela, c.nome, n_violacoes;
    END IF;
  END LOOP;
END
$p204_valida$;

-- ----------------------------------------------------------------------------
-- 3) Documentação da política — deixa explícito que a constraint não é mais
--    "esquecida": nasce validada (quando o conjunto está limpo) e a manutenção
--    de NOT VALID só acontece por violação legada comprovada.
-- ----------------------------------------------------------------------------
COMMENT ON CONSTRAINT ck_lanc_fin_valor_positivo       ON lancamentos_financeiros    IS 'P2-04: valor do lançamento > 0. Validada quando não há linha legada inválida.';
COMMENT ON CONSTRAINT ck_lanc_fin_taxa_pct             ON lancamentos_financeiros    IS 'P2-04: 0 <= taxa_pct < 100. Validada quando não há linha legada inválida.';
COMMENT ON CONSTRAINT ck_transf_fin_valor_positivo     ON transferencias_financeiras IS 'P2-04: valor da transferência > 0. Validada quando não há linha legada inválida.';
COMMENT ON CONSTRAINT ck_transf_fin_contas_diferentes  ON transferencias_financeiras IS 'P2-04: origem e destino diferentes. Validada quando não há linha legada inválida.';
COMMENT ON CONSTRAINT ck_gateway_cobrancas_valor       ON gateway_cobrancas          IS 'P2-04: valor da cobrança > 0. Validada quando não há linha legada inválida.';
COMMENT ON CONSTRAINT ck_gateway_cobrancas_metodo      ON gateway_cobrancas          IS 'P2-04: método no vocabulário canônico do gateway. Validada quando não há linha legada inválida.';
COMMENT ON CONSTRAINT ck_gateway_cobrancas_status      ON gateway_cobrancas          IS 'P2-04: status no vocabulário canônico do gateway. Validada quando não há linha legada inválida.';
COMMENT ON CONSTRAINT ck_extrato_valor_positivo        ON fin_extrato_transacoes     IS 'P2-04: valor da linha de extrato > 0. Validada quando não há linha legada inválida.';
