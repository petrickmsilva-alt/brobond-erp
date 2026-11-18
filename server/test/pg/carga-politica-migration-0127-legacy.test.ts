import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'requer DATABASE_URL (gate test:pg)';

test('0127 atualiza fila 0126 legada com lease fencing sem perder jobs e é idempotente', { skip }, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const schema = `test_migration_0127_${randomUUID().replace(/-/g, '')}`;
  const schemaQuoted = `"${schema}"`;
  const jobId = randomUUID();
  const leaseToken = randomUUID();
  const hash = 'a'.repeat(64);

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schemaQuoted}`);
    await client.query(`SET search_path TO ${schemaQuoted}, public`);
    await client.query('CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
    await client.query('CREATE TABLE usuarios (id INTEGER PRIMARY KEY)');
    await client.query(`
      CREATE TABLE carga_politica_comercial_jobs (
        id UUID PRIMARY KEY,
        empresa_id BIGINT NOT NULL,
        usuario_id BIGINT NOT NULL,
        idempotency_hash CHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        result JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT carga_politica_comercial_jobs_status_check
          CHECK (status IN ('queued','running','succeeded','failed')),
        CONSTRAINT carga_politica_comercial_jobs_idem
          UNIQUE (empresa_id, usuario_id, idempotency_hash)
      )
    `);
    await client.query(`
      CREATE INDEX carga_politica_comercial_jobs_queue_idx
        ON carga_politica_comercial_jobs (created_at)
        WHERE status = 'queued'
    `);
    await client.query(`
      CREATE INDEX carga_politica_comercial_jobs_owner_idx
        ON carga_politica_comercial_jobs (empresa_id, usuario_id, created_at DESC)
    `);
    await client.query(`
      CREATE UNIQUE INDEX carga_politica_comercial_jobs_one_running_per_company
        ON carga_politica_comercial_jobs (empresa_id)
        WHERE status = 'running'
    `);
    await client.query('INSERT INTO empresas (id) VALUES (1)');
    await client.query('INSERT INTO usuarios (id) VALUES (1)');
    await client.query(
      `INSERT INTO carga_politica_comercial_jobs (id, empresa_id, usuario_id, idempotency_hash, payload)
       VALUES ($1, 1, 1, $2, '{}'::jsonb)`,
      [jobId, hash]
    );

    const migrationPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../db/migrations/0127_carga_politica_comercial_lease_fencing.sql'
    );
    const migration = readFileSync(migrationPath, 'utf8');
    await client.query(migration);

    const column = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'carga_politica_comercial_jobs'
          AND column_name = 'lease_token'`,
      [schema]
    );
    assert.equal(column.rows[0]?.data_type, 'uuid');

    const constraints = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = $1::regclass`,
      [`${schema}.carga_politica_comercial_jobs`]
    );
    const names = new Set(constraints.rows.map((row) => row.conname));
    assert.ok(names.has('carga_politica_comercial_jobs_lease_ck'));
    assert.ok(names.has('carga_politica_comercial_jobs_payload_obj_ck'));
    assert.ok(names.has('carga_politica_comercial_jobs_attempts_ck'));
    assert.ok(names.has('carga_politica_comercial_jobs_empresa_id_fkey'));
    assert.ok(names.has('carga_politica_comercial_jobs_usuario_id_fkey'));

    await client.query(
      `UPDATE carga_politica_comercial_jobs
          SET status = 'running', lease_token = $2, heartbeat_at = now(), attempts = 1
        WHERE id = $1`,
      [jobId, leaseToken]
    );
    const preserved = await client.query(
      `SELECT id, status, attempts, lease_token, payload
         FROM carga_politica_comercial_jobs WHERE id = $1`,
      [jobId]
    );
    assert.equal(preserved.rows[0].id, jobId);
    assert.equal(preserved.rows[0].status, 'running');
    assert.equal(preserved.rows[0].attempts, 1);
    assert.equal(preserved.rows[0].lease_token, leaseToken);
    assert.deepEqual(preserved.rows[0].payload, {});

    await assert.rejects(
      client.query(
        `INSERT INTO carga_politica_comercial_jobs
          (id, empresa_id, usuario_id, idempotency_hash, payload, status, heartbeat_at)
         VALUES ($1, 1, 1, $2, '{}'::jsonb, 'running', now())`,
        [randomUUID(), 'b'.repeat(64)]
      ),
      (error: any) => error?.code === '23514'
    );

    // Reaplicar a migration deve preservar o job e não duplicar constraints/índices.
    await client.query(migration);
    const afterRetry = await client.query(
      `SELECT count(*)::int AS jobs FROM carga_politica_comercial_jobs WHERE id = $1`,
      [jobId]
    );
    assert.equal(afterRetry.rows[0].jobs, 1);
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schemaQuoted} CASCADE`).catch(() => undefined);
    await client.end();
  }
});
