// ERP-03: real catalog + JSONB/constraints on the operational webhook table.
// The test is included by test:pg; it never substitutes a mock for the DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL) throw new Error('ERP-03 exige DATABASE_URL PostgreSQL real');
process.env.NODE_ENV = 'test';
const { migrate, pool, query } = await import('../../src/db');
await migrate();
if (!pool) throw new Error('ERP-03: pool PostgreSQL indisponível');

test('ERP-03: todas as migrations do ERP constam no catálogo real, sem drift de registro', async () => {
  const dir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
  const expected = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  const { rows } = await query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  assert.deepEqual(rows.map((r) => r.id), expected);
  const catalog = await query<{ type: string; nullable: string }>(
    `SELECT data_type AS type, is_nullable AS nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateway_webhook_events' AND column_name = 'payload'`,
  );
  assert.deepEqual(catalog.rows, [{ type: 'jsonb', nullable: 'YES' }]);
  const idx = await query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_gateway_webhook_evento'`,
  );
  assert.equal(idx.rows.length, 1);
  assert.match(idx.rows[0].indexdef, /UNIQUE INDEX.*lower\(provider\).*evento_id/i);
});

test('ERP-03: JSONB objeto/string/array/null e UNIQUE/FK/NOT NULL no banco operacional; rollback sem resíduos', async () => {
  const client = await pool.connect();
  const provider = `e03-${randomUUID()}`;
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    const values = [
      { event_id: 'object', meta: { count: 2 } },
      'legacy JSON string',
      [1, { count: 2 }],
      null,
    ];
    for (const [i, value] of values.entries()) {
      await client.query(
        `INSERT INTO gateway_webhook_events (provider, evento_id, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [provider, `json-${i}`, JSON.stringify(value)],
      );
    }
    await client.query(`INSERT INTO gateway_webhook_events (provider, evento_id, payload) VALUES ($1, 'sql-null', NULL)`, [provider]);
    const { rows } = await client.query<{ evento_id: string; payload: unknown; kind: string | null; count: string | null }>(
      `SELECT evento_id, payload, jsonb_typeof(payload) AS kind, payload #>> '{meta,count}' AS count
       FROM gateway_webhook_events WHERE provider = $1 ORDER BY id`, [provider],
    );
    assert.deepEqual(rows.map((r) => r.kind), ['object', 'string', 'array', 'null', null]);
    assert.deepEqual(rows.slice(0, 4).map((r) => r.payload), values);
    assert.equal(rows[0].count, '2', 'operator #>> must read a real object field');
    assert.equal(rows[4].payload, null);

    async function rejectsWithoutAborting(sql: string, params: unknown[], code: string) {
      await client.query('SAVEPOINT e03_constraint');
      await assert.rejects(() => client.query(sql, params), (err: any) => err.code === code);
      await client.query('ROLLBACK TO SAVEPOINT e03_constraint');
      await client.query('RELEASE SAVEPOINT e03_constraint');
    }
    const insert = `INSERT INTO gateway_webhook_events (provider, evento_id, empresa_id) VALUES ($1, $2, $3)`;
    await rejectsWithoutAborting(insert, [provider.toUpperCase(), 'json-0', null], '23505'); // case-insensitive UNIQUE
    await rejectsWithoutAborting(insert, [provider, 'missing-tenant', -2147483647], '23503'); // real FK
    await rejectsWithoutAborting(insert, [null, 'missing-provider', null], '23502'); // NOT NULL
    const { rows: final } = await client.query<{ count: string }>(
      'SELECT count(*) FROM gateway_webhook_events WHERE provider = $1', [provider],
    );
    assert.equal(Number(final[0].count), 5, 'failed statements leave no partial inserts');
  } finally {
    if (started) await client.query('ROLLBACK');
    client.release();
  }
  const { rows: after } = await query<{ count: string }>(
    'SELECT count(*) FROM gateway_webhook_events WHERE provider = $1', [provider],
  );
  assert.equal(Number(after[0].count), 0, 'transaction fixture is fully rolled back');
});
