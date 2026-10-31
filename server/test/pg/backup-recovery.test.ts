import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { montarBackupSql } from '../../src/backup';

test('PG backup: FK closure, nullable cycles, self references, text zeros, revoked tokens and sequences', {
  skip: !process.env.DATABASE_URL ? 'requer PostgreSQL real' : false,
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const schema = `backup_regression_${process.pid}`;
  const sensitive = randomBytes(32).toString('hex');
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE parents (id serial PRIMARY KEY, nome text);
      CREATE TABLE orders (id serial PRIMARY KEY, parent_id int NOT NULL REFERENCES parents(id), document_id int, sku text,
                           token_hash text NOT NULL UNIQUE, token text NOT NULL, credenciais_cifradas text, senha_hash text);
      CREATE TABLE documents (id serial PRIMARY KEY, order_id int NOT NULL REFERENCES orders(id));
      ALTER TABLE orders ADD FOREIGN KEY(document_id) REFERENCES documents(id);
      CREATE TABLE nodes (id serial PRIMARY KEY, parent_id int REFERENCES nodes(id));
      CREATE TABLE empty_rows (id serial PRIMARY KEY);
      CREATE TABLE fin_periodos_contabeis (id serial PRIMARY KEY, estado text);
      CREATE FUNCTION guard_period() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS(SELECT 1 FROM fin_periodos_contabeis WHERE estado='fechado') THEN
          RAISE EXCEPTION 'Período fechado';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_period BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_period();
      INSERT INTO parents VALUES (9, 'Empresa A');
      INSERT INTO orders(id,parent_id,sku,token_hash,token,credenciais_cifradas,senha_hash) VALUES (17,9,'000123',$1,$1,$1,$1);
    `.replace(/\$1/g, "'" + sensitive + "'"));
    await client.query('INSERT INTO documents VALUES (20,17); UPDATE orders SET document_id=20 WHERE id=17');
    await client.query('INSERT INTO nodes VALUES (2,NULL); INSERT INTO nodes VALUES (1,2)');
    await client.query("INSERT INTO fin_periodos_contabeis VALUES (1,'fechado')");
    const sql = await montarBackupSql(client, ['documents', 'orders', 'nodes', 'empty_rows', 'fin_periodos_contabeis'], 'regression\nSELECT forbidden;');
    assert.equal(sql.includes('\nSELECT forbidden;'), false, 'actor must not inject executable SQL through a comment');
    assert.equal(sql.includes(sensitive), false, 'backup exported authentication material');
    assert.ok(sql.includes('INSERT INTO "parents"'), 'FK parent missing from resource inventory must be included');
    await client.query('INSERT INTO empty_rows VALUES (99)');
    await client.query(sql);
    await client.query(sql);
    assert.equal((await client.query('SELECT count(*)::int n FROM empty_rows')).rows[0].n, 0, 'empty source table must clear stale target rows');
    const order = (await client.query('SELECT * FROM orders WHERE id=17')).rows[0];
    assert.equal(order.sku, '000123');
    assert.equal((await client.query('SELECT estado FROM fin_periodos_contabeis WHERE id=1')).rows[0].estado, 'fechado');
    assert.equal(order.document_id, 20);
    assert.equal(order.parent_id, 9);
    assert.equal(order.credenciais_cifradas, null);
    assert.equal(order.senha_hash, null);
    assert.ok(order.token_hash.startsWith('REVOKED_BY_RESTORE:'));
    assert.ok(order.token.startsWith('REVOKED_BY_RESTORE:'));
    assert.equal(/^[a-f0-9]+$/i.test(order.token), false, 'revoked raw token must not satisfy public route token format');
    assert.equal((await client.query('SELECT parent_id FROM nodes WHERE id=1')).rows[0].parent_id, 2);
    const next = (await client.query("INSERT INTO parents(nome) VALUES ('Empresa B') RETURNING id")).rows[0].id;
    assert.equal(next, 10, 'sequence must advance past restored identifiers');
    assert.equal((await client.query('SELECT count(*)::int n FROM documents')).rows[0].n, 1);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
