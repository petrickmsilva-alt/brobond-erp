-- ============================================================================
-- 0022 — `empresa_fiscal_config.id`
--
-- A tabela nasceu com PK em `empresa_id` (uma configuração por empresa, e isso
-- continua verdade por causa do UNIQUE herdado da PK). Só que a camada de
-- persistência genérica (store) endereça qualquer registro por `id`, e sem
-- essa coluna a configuração fiscal ficaria fora dela — exigindo SQL à mão
-- justamente no caminho que reserva numeração de NF-e.
--
-- Acrescentar `id` é aditivo: nada é renomeado, a PK permanece em `empresa_id`
-- e os dados existentes recebem numeração automática.
--
-- Idempotente.
-- ============================================================================
ALTER TABLE empresa_fiscal_config ADD COLUMN IF NOT EXISTS id SERIAL;

DO $$ BEGIN
  ALTER TABLE empresa_fiscal_config ADD CONSTRAINT empresa_fiscal_config_id_unico UNIQUE (id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
