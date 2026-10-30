-- Alçada de compra é por usuário × empresa, nunca fornecida pelo cliente.
-- NULL preserva os vínculos legados sem presumir uma autorização monetária.
ALTER TABLE usuario_empresas ADD COLUMN IF NOT EXISTS limite_aprovacao_compra NUMERIC(14,2);
DO $$ BEGIN
  ALTER TABLE usuario_empresas ADD CONSTRAINT usuario_empresa_limite_compra_valido
    CHECK (limite_aprovacao_compra IS NULL OR limite_aprovacao_compra >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
