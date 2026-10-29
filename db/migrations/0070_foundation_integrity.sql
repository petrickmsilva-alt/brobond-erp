-- Foundation: new audit signatures cover tenant and event time. Historical
-- signatures remain version 1; no historical row is rewritten or re-signed.
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS hash_versao SMALLINT NOT NULL DEFAULT 1;
DO $$ BEGIN
  ALTER TABLE auditoria ADD CONSTRAINT auditoria_hash_versao_ck CHECK (hash_versao IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Monotonically increasing fencing token survives manual retries; it is not a
-- retry counter and therefore never resets when an operator requeues an event.
ALTER TABLE commerce_outbox ADD COLUMN IF NOT EXISTS claim_versao INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_claim_versao_ck CHECK (claim_versao >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Due work and expired leases can be found without scanning unrelated rows.
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_devida
  ON commerce_outbox (proxima_tentativa_em, id) WHERE estado = 'PENDENTE';
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_lease
  ON commerce_outbox (atualizado_em, id) WHERE estado = 'PROCESSANDO';
