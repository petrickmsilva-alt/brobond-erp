ALTER TABLE devolucoes ADD COLUMN IF NOT EXISTS payment_intent_id BIGINT;
ALTER TABLE devolucoes ADD COLUMN IF NOT EXISTS refund_amount BIGINT;
ALTER TABLE devolucoes ADD COLUMN IF NOT EXISTS refund_estado TEXT;
DO $$ BEGIN
  ALTER TABLE devolucoes ADD CONSTRAINT devolucao_refund_valido CHECK
  ((payment_intent_id IS NULL AND refund_amount IS NULL AND refund_estado IS NULL) OR
   (payment_intent_id IS NOT NULL AND refund_amount > 0 AND refund_estado IN ('PENDENTE','CONCLUIDO')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE devolucoes ADD CONSTRAINT devolucao_payment_empresa_fk
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE commerce_outbox DROP CONSTRAINT commerce_outbox_tipo_ck;
DO $$ BEGIN
  ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_tipo_ck CHECK
  (tipo IN ('conversao','publicacao','sincronizacao','alerta','refund_devolucao'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_chargeback_dispute
  ON lancamentos_financeiros(empresa_id,referencia_id) WHERE referencia_tipo='chargeback_dispute';
