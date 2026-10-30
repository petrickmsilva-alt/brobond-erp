-- Preserva a identidade completa da decisão, sem reescrever cotações legadas.
ALTER TABLE cotacoes_compra ADD COLUMN IF NOT EXISTS decisao_hash TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cotacoes_compra'::regclass AND conname = 'cotacao_decisao_hash_ck') THEN
    ALTER TABLE cotacoes_compra ADD CONSTRAINT cotacao_decisao_hash_ck
      CHECK (decisao_hash IS NULL OR decisao_hash ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END $$;
ALTER TABLE cotacoes_compra VALIDATE CONSTRAINT cotacao_decisao_hash_ck;
