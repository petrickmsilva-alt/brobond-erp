-- Data civil do efeito da baixa no livro existente. Registros históricos não
-- são preenchidos com data presumida; NULL sinaliza falta de evidência.
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS data_baixa DATE;
CREATE INDEX IF NOT EXISTS lancamentos_financeiros_empresa_data_baixa_idx
  ON lancamentos_financeiros (empresa_id, data_baixa) WHERE data_baixa IS NOT NULL;
