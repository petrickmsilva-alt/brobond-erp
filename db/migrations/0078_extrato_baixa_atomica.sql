-- O título pode receber várias baixas parciais. Cada linha do extrato aponta
-- para o efeito financeiro específico (filho na parcial; principal na total).
-- Os registros antigos permanecem inalterados e precisam de revisão de prova.
ALTER TABLE fin_extrato_transacoes ADD COLUMN IF NOT EXISTS baixa_lancamento_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS lancamentos_financeiros_empresa_id_uq
  ON lancamentos_financeiros (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS fin_extrato_baixa_unica_uq
  ON fin_extrato_transacoes (empresa_id, baixa_lancamento_id)
  WHERE baixa_lancamento_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fin_extrato_transacoes'::regclass AND conname = 'fin_extrato_baixa_empresa_fk') THEN
    ALTER TABLE fin_extrato_transacoes ADD CONSTRAINT fin_extrato_baixa_empresa_fk
      FOREIGN KEY (empresa_id, baixa_lancamento_id) REFERENCES lancamentos_financeiros (empresa_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fin_extrato_transacoes'::regclass AND conname = 'fin_extrato_baixa_coerente_ck') THEN
    ALTER TABLE fin_extrato_transacoes ADD CONSTRAINT fin_extrato_baixa_coerente_ck
      CHECK (baixa_lancamento_id IS NULL OR (status = 'conciliada' AND lancamento_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE fin_extrato_transacoes VALIDATE CONSTRAINT fin_extrato_baixa_empresa_fk;
ALTER TABLE fin_extrato_transacoes VALIDATE CONSTRAINT fin_extrato_baixa_coerente_ck;
