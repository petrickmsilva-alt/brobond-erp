-- Durable jobs for the canonical commercial policy import.
CREATE TABLE IF NOT EXISTS carga_politica_comercial_jobs (
  id UUID PRIMARY KEY,
  empresa_id BIGINT NOT NULL,
  usuario_id BIGINT NOT NULL,
  idempotency_hash CHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed')),
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT carga_politica_comercial_jobs_idem UNIQUE (empresa_id, usuario_id, idempotency_hash)
);
CREATE INDEX IF NOT EXISTS carga_politica_comercial_jobs_queue_idx
  ON carga_politica_comercial_jobs (created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS carga_politica_comercial_jobs_owner_idx
  ON carga_politica_comercial_jobs (empresa_id, usuario_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS carga_politica_comercial_jobs_one_running_per_company
  ON carga_politica_comercial_jobs (empresa_id)
  WHERE status = 'running';
