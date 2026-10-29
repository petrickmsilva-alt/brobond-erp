-- A late review is an operational exception, not a second payment ledger.
-- The original order, charge and payment intent remain the sources of truth.
CREATE TABLE IF NOT EXISTS payment_late_reviews (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  order_id BIGINT NOT NULL,
  cobranca_id BIGINT NOT NULL,
  payment_intent_id BIGINT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REFUNDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, order_id),
  FOREIGN KEY (empresa_id, order_id) REFERENCES commerce_pedidos (empresa_id, id),
  FOREIGN KEY (empresa_id, cobranca_id) REFERENCES gateway_cobrancas (empresa_id, id),
  FOREIGN KEY (empresa_id, payment_intent_id) REFERENCES payment_intents (empresa_id, id),
  CHECK ((status = 'OPEN' AND resolved_at IS NULL) OR (status = 'REFUNDED' AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS payment_late_reviews_queue_idx
  ON payment_late_reviews (empresa_id, status, id DESC);
