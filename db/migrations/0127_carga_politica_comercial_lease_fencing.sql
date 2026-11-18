-- Reconcile the durable commercial-policy queue on databases where
-- migration 0126 was applied before lease fencing was added to the worker.
-- Additive and idempotent: existing job rows and payloads are preserved.

ALTER TABLE carga_politica_comercial_jobs
  ADD COLUMN IF NOT EXISTS lease_token UUID;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'carga_politica_comercial_jobs'::regclass
       AND conname = 'carga_politica_comercial_jobs_payload_obj_ck'
  ) THEN
    ALTER TABLE carga_politica_comercial_jobs
      ADD CONSTRAINT carga_politica_comercial_jobs_payload_obj_ck
      CHECK (jsonb_typeof(payload) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'carga_politica_comercial_jobs'::regclass
       AND conname = 'carga_politica_comercial_jobs_attempts_ck'
  ) THEN
    ALTER TABLE carga_politica_comercial_jobs
      ADD CONSTRAINT carga_politica_comercial_jobs_attempts_ck
      CHECK (attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'carga_politica_comercial_jobs'::regclass
       AND conname = 'carga_politica_comercial_jobs_lease_ck'
  ) THEN
    ALTER TABLE carga_politica_comercial_jobs
      ADD CONSTRAINT carga_politica_comercial_jobs_lease_ck
      CHECK (
        (status = 'running' AND lease_token IS NOT NULL AND heartbeat_at IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'carga_politica_comercial_jobs'::regclass
       AND conname = 'carga_politica_comercial_jobs_empresa_id_fkey'
  ) THEN
    ALTER TABLE carga_politica_comercial_jobs
      ADD CONSTRAINT carga_politica_comercial_jobs_empresa_id_fkey
      FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'carga_politica_comercial_jobs'::regclass
       AND conname = 'carga_politica_comercial_jobs_usuario_id_fkey'
  ) THEN
    ALTER TABLE carga_politica_comercial_jobs
      ADD CONSTRAINT carga_politica_comercial_jobs_usuario_id_fkey
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE RESTRICT;
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS carga_politica_comercial_jobs_queue_idx
  ON carga_politica_comercial_jobs (created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS carga_politica_comercial_jobs_owner_idx
  ON carga_politica_comercial_jobs (empresa_id, usuario_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS carga_politica_comercial_jobs_one_running_per_company
  ON carga_politica_comercial_jobs (empresa_id)
  WHERE status = 'running';
