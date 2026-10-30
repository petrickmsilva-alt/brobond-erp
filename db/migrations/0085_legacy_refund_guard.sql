-- Durable reservation of legacy gateway refunds: a close sees in-flight and
-- uncertain external writes, without creating another financial ledger.
ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS estorno_operacao_estado TEXT;
ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS estorno_operacao_em TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE gateway_cobrancas ADD CONSTRAINT gateway_estorno_operacao_estado_ck
    CHECK (estorno_operacao_estado IS NULL OR estorno_operacao_estado IN ('PROCESSING','UNCERTAIN','SUCCEEDED','FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
