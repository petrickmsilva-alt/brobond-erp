-- A confirmação do refund pertence a uma operação específica, não ao aumento
-- do total estornado do pagamento. Legados permanecem sem evidência presumida.
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS provider_refund_status TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_empresa_id_provider_uq
  ON payment_intents (empresa_id, id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_provider_reference_uq
  ON payment_refunds (empresa_id, provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'payment_refunds'::regclass AND conname = 'payment_refund_provider_fk') THEN
    ALTER TABLE payment_refunds ADD CONSTRAINT payment_refund_provider_fk
      FOREIGN KEY (empresa_id, payment_intent_id, provider) REFERENCES payment_intents (empresa_id, id, provider) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'payment_refunds'::regclass AND conname = 'payment_refund_evidence_ck') THEN
    ALTER TABLE payment_refunds ADD CONSTRAINT payment_refund_evidence_ck CHECK (
      (provider IS NULL AND provider_refund_id IS NULL AND provider_refund_status IS NULL) OR
      (provider IS NOT NULL AND provider_refund_id IS NOT NULL AND length(trim(provider_refund_id)) BETWEEN 1 AND 160
       AND provider_refund_id !~ '[[:cntrl:]]' AND provider_refund_status IS NOT NULL AND provider_refund_status IN ('PENDING', 'SUCCEEDED'))
    ) NOT VALID;
  END IF;
END $$;
ALTER TABLE payment_refunds VALIDATE CONSTRAINT payment_refund_provider_fk;
ALTER TABLE payment_refunds VALIDATE CONSTRAINT payment_refund_evidence_ck;
