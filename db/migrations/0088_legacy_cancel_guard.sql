-- Cancelamentos legados não podem perder uma chamada externa incerta.
ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS cancelamento_operacao_estado TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gateway_cobrancas'::regclass AND conname='gateway_cancelamento_estado_ck') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT gateway_cancelamento_estado_ck CHECK (cancelamento_operacao_estado IS NULL OR cancelamento_operacao_estado IN ('PROCESSING','UNCERTAIN','SUCCEEDED','FAILED')) NOT VALID;
  END IF;
END $$;
ALTER TABLE gateway_cobrancas VALIDATE CONSTRAINT gateway_cancelamento_estado_ck;
