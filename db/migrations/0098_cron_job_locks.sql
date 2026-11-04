-- Coordenação dos cinco processos de cron (relatorios, pagamentos, publicacoes,
-- pedidos, crm): uma linha de lock por job_id, token monotônico, heartbeat e
-- unidades de trabalho com chave estável.
-- Não implica exatamente-uma-vez em provedor externo.
-- Rollback (somente manutenção autorizada, depois de parar workers):
--   BEGIN;
--   DROP TABLE IF EXISTS cron_work_items;
--   DROP TABLE IF EXISTS cron_job_locks;
--   DELETE FROM schema_migrations WHERE id = '0098_cron_job_locks.sql';
--   COMMIT;
-- Esta pasta não contém script de descida automático.
CREATE TABLE IF NOT EXISTS cron_job_locks (
  job_id text PRIMARY KEY,
  owner_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  state text NOT NULL CHECK (state IN ('HELD', 'RELEASED'))
);
CREATE INDEX IF NOT EXISTS cron_job_locks_expiry_idx ON cron_job_locks (expires_at) WHERE state = 'HELD';

CREATE TABLE IF NOT EXISTS cron_work_items (
  job_id text NOT NULL REFERENCES cron_job_locks(job_id),
  idempotency_key text NOT NULL,
  entity_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','PROCESSING','COMPLETED','FAILED','RETRYABLE','ABANDONED')),
  owner_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  attempts integer NOT NULL CHECK (attempts > 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  result jsonb,
  error_code text,
  PRIMARY KEY (job_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS cron_work_items_state_idx ON cron_work_items (job_id, state);
