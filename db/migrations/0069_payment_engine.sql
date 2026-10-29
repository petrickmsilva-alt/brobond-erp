-- Incremental payment domain. Reuses gateway_configs, gateway_cobrancas,
-- gateway_webhook_events, audit and Commerce outbox. No second financial ledger.
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS payment_policy jsonb NOT NULL DEFAULT '{}';
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS health_status text;
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE gateway_webhook_events ADD COLUMN IF NOT EXISTS payload_hash text;
ALTER TABLE gateway_webhook_events ADD COLUMN IF NOT EXISTS correlation_id text;
CREATE UNIQUE INDEX IF NOT EXISTS gateway_cobrancas_empresa_id_id ON gateway_cobrancas(empresa_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_pedidos_empresa_id_id ON commerce_pedidos(empresa_id,id);
CREATE TABLE IF NOT EXISTS payment_intents (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id),
  order_id bigint NOT NULL, customer_ref text, channel text NOT NULL, currency varchar(3) NOT NULL,
  minor_units smallint NOT NULL DEFAULT 2 CHECK(minor_units BETWEEN 0 AND 4),
  amount bigint NOT NULL CHECK(amount > 0), method text NOT NULL, provider text,
  status text NOT NULL CHECK(status IN ('CREATED','PENDING','PENDING_MANUAL_CONFIRMATION','REQUIRES_ACTION','AUTHORIZED','CAPTURE_PENDING','CAPTURED','PAID','PARTIALLY_REFUNDED','REFUNDED','CANCELED','FAILED','EXPIRED','CHARGEBACK','DISPUTED')),
  idempotency_key text NOT NULL, correlation_id text NOT NULL, active_operation bigint,
  cobranca_id bigint, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,order_id), UNIQUE(empresa_id,idempotency_key),
  FOREIGN KEY(empresa_id,order_id) REFERENCES commerce_pedidos(empresa_id,id),
  FOREIGN KEY(empresa_id,cobranca_id) REFERENCES gateway_cobrancas(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  provider text NOT NULL, provider_transaction_id text, method text NOT NULL,
  requested_amount bigint NOT NULL CHECK(requested_amount>0), authorized_amount bigint NOT NULL DEFAULT 0,
  captured_amount bigint NOT NULL DEFAULT 0, refunded_amount bigint NOT NULL DEFAULT 0,
  status text NOT NULL, failure_code text, failure_message text,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  idempotency_key text NOT NULL, correlation_id text NOT NULL, safe_reference jsonb NOT NULL DEFAULT '{}', request_cifradas text,
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,provider,idempotency_key), UNIQUE(provider,provider_transaction_id),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id),
  CHECK(refunded_amount>=0 AND captured_amount>=refunded_amount AND authorized_amount>=0)
);
CREATE TABLE IF NOT EXISTS payment_operations (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  operation text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('PROCESSING','SUCCEEDED','FAILED','UNCERTAIN')),
  amount bigint NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,payment_intent_id,operation,idempotency_key),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), code text NOT NULL,
  name text NOT NULL, enabled boolean NOT NULL DEFAULT false, settings jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,code)
);
CREATE TABLE IF NOT EXISTS payment_routing_rules (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), method text NOT NULL, provider text NOT NULL,
  priority integer NOT NULL CHECK(priority>=0), enabled boolean NOT NULL DEFAULT false,
  conditions jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(empresa_id,method,priority)
);
CREATE TABLE IF NOT EXISTS payment_refunds (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  operation_id bigint NOT NULL, amount bigint NOT NULL CHECK(amount>0), status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,operation_id),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id),
  FOREIGN KEY(empresa_id,operation_id) REFERENCES payment_operations(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_disputes (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  provider_reference text NOT NULL, status text NOT NULL CHECK(status IN ('DISPUTE_OPENED','UNDER_REVIEW','EVIDENCE_REQUIRED','EVIDENCE_SUBMITTED','WON','LOST','CLOSED')),
  amount bigint NOT NULL CHECK(amount>=0), reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(empresa_id,provider_reference),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_settlements (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  provider text NOT NULL, provider_reference text NOT NULL, settlement_date date,
  gross_amount bigint NOT NULL CHECK(gross_amount>=0), provider_fee bigint, gateway_fee bigint, installment_fee bigint, antifraud_fee bigint,
  net_amount bigint, refund_amount bigint NOT NULL DEFAULT 0, chargeback_amount bigint NOT NULL DEFAULT 0,
  payout_reference text, status text NOT NULL CHECK(status IN ('UNRECONCILED','MATCHED','PARTIAL','DIVERGENT','RESOLVED')),
  evidence jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,provider,provider_reference),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id)
);
CREATE INDEX IF NOT EXISTS payment_intents_tenant_status ON payment_intents(empresa_id,status,id DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_tenant_intent ON payment_attempts(empresa_id,payment_intent_id);
CREATE INDEX IF NOT EXISTS payment_operations_recovery ON payment_operations(status,updated_at);
