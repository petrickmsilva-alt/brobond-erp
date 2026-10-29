-- Disputas e versões de relatórios são evidências operacionais. Nenhuma dessas
-- tabelas substitui os pagamentos, o extrato bancário ou o livro financeiro.
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS external_dispute_id TEXT;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'ENGINE';
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE payment_disputes ADD CONSTRAINT payment_disputes_origin_ck CHECK (origin IN ('ENGINE', 'MANUAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payment_disputes ADD CONSTRAINT payment_disputes_version_ck CHECK (version >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payment_disputes ADD CONSTRAINT payment_disputes_external_ck CHECK (
    external_dispute_id IS NULL OR (provider IS NOT NULL AND length(trim(external_dispute_id)) BETWEEN 1 AND 160)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS payment_disputes_empresa_id_uq ON payment_disputes (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_disputes_external_uq
  ON payment_disputes (empresa_id, provider, external_dispute_id) WHERE external_dispute_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_disputes_status_idx ON payment_disputes (empresa_id, status, id DESC);

CREATE TABLE IF NOT EXISTS payment_dispute_evidence (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  dispute_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('NOTE', 'DOCUMENT_REFERENCE')),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 200),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 4000),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, dispute_id, idempotency_key),
  FOREIGN KEY (empresa_id, dispute_id) REFERENCES payment_disputes (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_dispute_evidence_page_idx ON payment_dispute_evidence (empresa_id, dispute_id, id DESC);

CREATE TABLE IF NOT EXISTS payment_dispute_events (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  dispute_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REGISTER', 'TRANSITION')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  external_reference TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, idempotency_key),
  FOREIGN KEY (empresa_id, dispute_id) REFERENCES payment_disputes (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_dispute_events_page_idx ON payment_dispute_events (empresa_id, dispute_id, id DESC);

CREATE TABLE IF NOT EXISTS payment_payout_revisions (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  payout_id BIGINT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  report JSONB NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 500),
  previous_hash TEXT CHECK (previous_hash IS NULL OR length(previous_hash) = 64),
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, payout_id, revision),
  UNIQUE (empresa_id, payout_id, content_hash),
  FOREIGN KEY (empresa_id, payout_id) REFERENCES payment_payouts (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_payout_revisions_page_idx ON payment_payout_revisions (empresa_id, payout_id, revision DESC);

CREATE UNIQUE INDEX IF NOT EXISTS payment_payout_revision_key_uq
  ON payment_payout_revisions (empresa_id, payout_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_payout_unlinks (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  payout_id BIGINT NOT NULL,
  bank_transaction_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 500),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, payout_id, idempotency_key),
  FOREIGN KEY (empresa_id, payout_id) REFERENCES payment_payouts (empresa_id, id),
  FOREIGN KEY (empresa_id, bank_transaction_id) REFERENCES fin_extrato_transacoes (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_payout_unlinks_page_idx ON payment_payout_unlinks (empresa_id, payout_id, id DESC);
