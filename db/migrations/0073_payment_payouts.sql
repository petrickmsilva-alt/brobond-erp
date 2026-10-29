-- Repasses declarados por relatório do provedor. São evidência de liquidação,
-- não lançamentos financeiros ou um segundo livro-caixa.
CREATE UNIQUE INDEX IF NOT EXISTS fin_extrato_empresa_id_uq ON fin_extrato_transacoes (empresa_id, id);
CREATE TABLE IF NOT EXISTS payment_payouts (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  provider TEXT NOT NULL,
  payout_reference TEXT NOT NULL,
  settlement_date DATE NOT NULL,
  currency VARCHAR(3) NOT NULL CHECK (currency = 'BRL'),
  net_amount BIGINT NOT NULL CHECK (net_amount >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('IMPORTED', 'DIVERGENT', 'MATCHED')),
  bank_transaction_id INTEGER,
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, provider, payout_reference),
  FOREIGN KEY (empresa_id, bank_transaction_id) REFERENCES fin_extrato_transacoes (empresa_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_payout_bank_once_uq
  ON payment_payouts (empresa_id, bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_payout_status_idx ON payment_payouts (empresa_id, status, settlement_date DESC);
ALTER TABLE payment_settlements ADD COLUMN IF NOT EXISTS payout_id BIGINT;
DO $$ BEGIN
  ALTER TABLE payment_settlements ADD CONSTRAINT payment_settlement_payout_empresa_fk
    FOREIGN KEY (empresa_id, payout_id) REFERENCES payment_payouts (empresa_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS payment_settlement_payout_idx ON payment_settlements (empresa_id, payout_id);
