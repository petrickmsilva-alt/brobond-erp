-- Durable, tenant-scoped jobs for the canonical commercial policy import.
-- The job row is the durable queue record; catalog writes and the succeeded
-- transition are committed in the same PostgreSQL transaction.
CREATE TABLE IF NOT EXISTS carga_politica_comercial_jobs (
  id UUID PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  idempotency_hash CHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result JSONB,
  error TEXT,
  lease_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT carga_politica_comercial_jobs_status_ck
    CHECK (status IN ('queued','running','succeeded','failed')),
  CONSTRAINT carga_politica_comercial_jobs_payload_obj_ck
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT carga_politica_comercial_jobs_attempts_ck
    CHECK (attempts >= 0),
  CONSTRAINT carga_politica_comercial_jobs_lease_ck
    CHECK (
      (status = 'running' AND lease_token IS NOT NULL AND heartbeat_at IS NOT NULL)
      OR (status <> 'running' AND lease_token IS NULL)
    ),
  CONSTRAINT carga_politica_comercial_jobs_idem
    UNIQUE (empresa_id, usuario_id, idempotency_hash)
);

CREATE INDEX IF NOT EXISTS carga_politica_comercial_jobs_queue_idx
  ON carga_politica_comercial_jobs (created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS carga_politica_comercial_jobs_owner_idx
  ON carga_politica_comercial_jobs (empresa_id, usuario_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS carga_politica_comercial_jobs_one_running_per_company
  ON carga_politica_comercial_jobs (empresa_id)
  WHERE status = 'running';
