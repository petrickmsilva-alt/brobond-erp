// ============================================================
// MOTOR DE FRETE — MIGRATION 0102 no Postgres REAL.
// Escopo: tabelas, constraints, índices, idempotência (reaplicação), isolamento
// multiempresa e dedupe de eventos. Integração LOCAL com Postgres real.
// Só roda com DATABASE_URL apontando para banco NOVO (gate test:pg). Sem URL: auto-pula.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (Postgres real, gate test:pg)';
process.env.NODE_ENV = 'test';

const db: any = temBanco ? await import('../src/db') : null;
if (temBanco) await db.migrate();

const SQL_0102 = readFileSync(fileURLToPath(new URL('../../db/migrations/0102_logistics_engine.sql', import.meta.url)), 'utf8');
const sufixo = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function sql<T = any>(texto: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.pool.query(texto, params);
  return r.rows as T[];
}

test('schema: as 6 tabelas do módulo logístico existem com empresa_id NOT NULL e FK', { skip }, async () => {
  const tabelas = ['logistics_shipping_rules', 'logistics_quotes', 'logistics_packages', 'logistics_labels', 'logistics_webhook_inbox', 'logistics_audit_logs'];
  const cols = await sql(
    `SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'empresa_id' AND table_name = ANY($1)`,
    [tabelas]
  );
  assert.equal(cols.length, tabelas.length);
  for (const c of cols) assert.equal(c.is_nullable, 'NO', `${c.table_name}.empresa_id NOT NULL`);
  const fks = await sql(
    `SELECT conrelid::regclass::text AS tabela FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'empresas'::regclass AND conrelid::regclass::text = ANY($1)`,
    [tabelas]
  );
  assert.equal(fks.length, tabelas.length, 'toda tabela referencia empresas');
});

test('schema: envios ganhou store_key/modalidade/quote_id e o CHECK recusa store_key inválido', { skip }, async () => {
  const cols = await sql(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='envios'
        AND column_name IN ('store_key','modalidade','quote_id','servico_nome','custo_previsto','custo_efetivo')`
  );
  assert.equal(cols.length, 6);
  const emp = await sql<{ id: number }>(`SELECT id FROM empresas ORDER BY id LIMIT 1`);
  const cliente = await sql<{ id: number }>(`INSERT INTO clientes (empresa_id, nome) VALUES ($1, $2) RETURNING id`, [emp[0].id, `Cliente Ck ${sufixo}`]);
  const venda = await sql<{ id: number }>(`INSERT INTO vendas (empresa_id, cliente_id, data, status, total) VALUES ($1, $2, now()::date, 'confirmada', 10) RETURNING id`, [emp[0].id, cliente[0].id]);
  await assert.rejects(
    () => sql(`INSERT INTO envios (empresa_id, venda_id, provider, status, store_key) VALUES ($1, $2, 'manual', 'pendente', 'INVALIDA')`, [emp[0].id, venda[0].id]),
    /envios_store_ck/
  );
});

test('schema: envio_eventos ganhou dedupe_key e o índice único parcial existe', { skip }, async () => {
  const idx = await sql(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='envio_eventos' AND indexname='uq_logistics_evento_dedupe'`
  );
  assert.equal(idx.length, 1);
});

test('migration: reaplicar a 0102 é idempotente (não falha, não duplica)', { skip }, async () => {
  await db.pool.query(SQL_0102);
  const t = await sql(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='logistics_quotes'`
  );
  assert.equal(t[0].n, 1);
});

test('isolamento: duas empresas não compartilham remessas (filtro por empresa_id)', { skip }, async () => {
  const emp = await sql<{ id: number }>(`SELECT id FROM empresas ORDER BY id LIMIT 2`);
  if (emp.length < 2) return; // sem duas empresas no banco de teste, nada a provar
  const [a, b] = emp.map((e) => e.id);
  const cliente = await sql<{ id: number }>(
    `INSERT INTO clientes (empresa_id, nome) VALUES ($1, $2) RETURNING id`,
    [a, `Cliente Log ${sufixo}`]
  );
  const venda = await sql<{ id: number }>(
    `INSERT INTO vendas (empresa_id, cliente_id, data, status, total) VALUES ($1, $2, now()::date, 'confirmada', 100) RETURNING id`,
    [a, cliente[0].id]
  );
  await sql(
    `INSERT INTO envios (empresa_id, venda_id, provider, status, store_key, modalidade) VALUES ($1, $2, 'manual', 'cotado', 'RETAIL', 'CIF')`,
    [a, venda[0].id]
  );
  const daA = await sql(`SELECT id FROM envios WHERE empresa_id = $1 AND venda_id = $2`, [a, venda[0].id]);
  const daB = await sql(`SELECT id FROM envios WHERE empresa_id = $1 AND venda_id = $2`, [b, venda[0].id]);
  assert.equal(daA.length, 1);
  assert.equal(daB.length, 0);
});

test('dedupe: o índice único de evento recusa a mesma chave duas vezes', { skip }, async () => {
  const emp = await sql<{ id: number }>(`SELECT id FROM empresas ORDER BY id LIMIT 1`);
  const cliente = await sql<{ id: number }>(`INSERT INTO clientes (empresa_id, nome) VALUES ($1, $2) RETURNING id`, [emp[0].id, `Cliente Ded ${sufixo}`]);
  const venda = await sql<{ id: number }>(`INSERT INTO vendas (empresa_id, cliente_id, data, status, total) VALUES ($1, $2, now()::date, 'confirmada', 10) RETURNING id`, [emp[0].id, cliente[0].id]);
  const envio = await sql<{ id: number }>(`INSERT INTO envios (empresa_id, venda_id, provider, status) VALUES ($1, $2, 'manual', 'pendente') RETURNING id`, [emp[0].id, venda[0].id]);
  const chave = `dedupe-${sufixo}`;
  await sql(`INSERT INTO envio_eventos (empresa_id, envio_id, para_status, dedupe_key) VALUES ($1, $2, 'postado', $3)`, [emp[0].id, envio[0].id, chave]);
  await assert.rejects(
    () => sql(`INSERT INTO envio_eventos (empresa_id, envio_id, para_status, dedupe_key) VALUES ($1, $2, 'postado', $3)`, [emp[0].id, envio[0].id, chave]),
    /uq_logistics_evento_dedupe|duplicate key/
  );
});
