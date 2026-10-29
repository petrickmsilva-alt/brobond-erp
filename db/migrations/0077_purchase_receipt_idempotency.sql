-- Preserve legacy documents untouched. New receipt commands retain the full
-- tenant/order-scoped key and a digest of the normalized request; no stock or
-- accounting data is copied or rewritten.
ALTER TABLE compra_recebimentos ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE compra_recebimentos ADD COLUMN IF NOT EXISTS request_hash TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compra_recebimentos_idempotencia_formato_ck'
                 AND conrelid = 'compra_recebimentos'::regclass) THEN
    ALTER TABLE compra_recebimentos ADD CONSTRAINT compra_recebimentos_idempotencia_formato_ck CHECK (
      (idempotency_key IS NULL AND request_hash IS NULL)
      OR (idempotency_key IS NOT NULL AND length(idempotency_key) BETWEEN 1 AND 160
          AND request_hash IS NOT NULL AND request_hash ~ '^[a-f0-9]{64}$')
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS compra_recebimentos_comando_uq
  ON compra_recebimentos (empresa_id, compra_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
