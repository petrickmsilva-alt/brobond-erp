-- 0067 — estado operacional explícito para executor fiscal não configurado.
-- Não há geração, validação ou leiaute oficial: a tentativa termina em NAO_SUPORTADO.
ALTER TABLE fiscal_execucoes
  DROP CONSTRAINT IF EXISTS fiscal_execucoes_status_valido;

ALTER TABLE fiscal_execucoes
  ADD CONSTRAINT fiscal_execucoes_status_valido
  CHECK (status IN ('PENDENTE','EM_PROCESSAMENTO','VALIDADO','ERRO','ENTREGUE','NAO_SUPORTADO'));

COMMENT ON COLUMN fiscal_execucoes.status IS
  'Estado explícito da tentativa; NAO_SUPORTADO significa que não há manifesto/leiaute oficial configurado e nenhum arquivo/validação foi produzido.';
