-- ============================================================================
-- 0023 — O CHECK de provedor fiscal não pode ser uma lista fechada
--
-- A 0019 travou `empresa_fiscal_config.provider` em ('nenhum','focus',
-- 'plugnotas'). Isso contradiz o contrato do `FiscalProvider`: registrar um
-- adaptador novo (outro emissor, ou um dublê em teste) passa a exigir uma
-- migration só para liberar o nome — exatamente o acoplamento que a interface
-- existe para evitar.
--
-- O formato continua restrito (slug minúsculo curto), o que preserva a
-- proteção real: nada de valor livre, nada de string vazia. Quem decide se o
-- provedor existe é o registro em `fiscalProvider.ts`, e provedor
-- desconhecido cai no provedor NULO — que não emite.
--
-- Idempotente.
-- ============================================================================
ALTER TABLE empresa_fiscal_config DROP CONSTRAINT IF EXISTS empresa_fiscal_provider_valido;

DO $$ BEGIN
  ALTER TABLE empresa_fiscal_config ADD CONSTRAINT empresa_fiscal_provider_valido
    CHECK (provider ~ '^[a-z0-9_]{2,20}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `documentos_fiscais.provider` nunca teve lista fechada e continua assim:
-- o CHECK de prova de autorização já impede `provider = 'nenhum'` autorizar.
