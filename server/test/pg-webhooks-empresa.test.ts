// ============================================================
// R-14 (Fase 4.3) — associação empresarial de webhooks no Postgres REAL.
// Escopo: migração 0097 (colunas nullable, FK, índices), preservação de linhas legadas
// (reaplicação e rollback documentado), e filtros por empresa no PgStore.
// Integração LOCAL com Postgres real (16.14 no gate). Não é homologação de provedor.
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
const W: any = await import('../src/webhooks');
const { getStore } = await import('../src/services');
if (temBanco) await db.migrate();

const SQL_0097 = readFileSync(fileURLToPath(new URL('../../db/migrations/0097_webhooks_empresa.sql', import.meta.url)), 'utf8');
const sufixo = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const EMP_A = 1;
const EMP_B = 2;

async function sql<T = any>(texto: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.pool.query(texto, params);
  return r.rows as T[];
}

test('schema: empresa_id anulável e com FK para empresas em webhooks e webhook_entregas', { skip }, async () => {
  const cols = await sql(
    `SELECT table_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'empresa_id' AND table_name IN ('webhooks','webhook_entregas')`,
  );
  assert.equal(cols.length, 2, 'as duas colunas existem');
  for (const c of cols) {
    assert.equal(c.is_nullable, 'YES', `${c.table_name}.empresa_id é anulável`);
    assert.equal(c.column_default, null, `${c.table_name}.empresa_id sem default (nunca inferido)`);
  }
  const fks = await sql(
    `SELECT conrelid::regclass::text AS tabela FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'empresas'::regclass AND conrelid::regclass::text IN ('webhooks','webhook_entregas')`,
  );
  assert.equal(fks.length, 2, 'FK para empresas nas duas tabelas');
});

test('migração 0097 reaplicada e rollback documentado preservam linhas legadas, sem backfill', { skip }, async () => {
  await sql(`INSERT INTO empresas (id, nome) VALUES ($1, 'Empresa B (teste R-14)') ON CONFLICT (id) DO NOTHING`, [EMP_B]);
  const [legado] = await sql(
    `INSERT INTO webhooks (nome, url, eventos, ativo) VALUES ($1, 'https://legado.exemplo.test/h', '["usuario.criado"]', true) RETURNING id`,
    [`Legado-${sufixo}`],
  );
  const [entLegado] = await sql(
    `INSERT INTO webhook_entregas (webhook_id, evento, payload, estado) VALUES ($1, 'usuario.criado', '{}', 'ok') RETURNING id`,
    [legado.id],
  );
  // Reaplicação da migração sobre dados existentes: idempotente.
  await db.pool.query(SQL_0097);
  const depois = await sql(`SELECT nome, empresa_id FROM webhooks WHERE id = $1`, [legado.id]);
  assert.equal(depois[0].nome, `Legado-${sufixo}`, 'nome preservado');
  assert.equal(depois[0].empresa_id, null, 'sem backfill: legado segue NULL');
  // Rollback documentado (docs/auditoria/fase-4-3-registro.md, R-14) e nova aplicação.
  await db.pool.query('ALTER TABLE webhook_entregas DROP COLUMN IF EXISTS empresa_id');
  await db.pool.query('ALTER TABLE webhooks DROP COLUMN IF EXISTS empresa_id');
  const semColuna = await sql(`SELECT count(*)::int AS n FROM webhooks WHERE id = $1`, [legado.id]);
  assert.equal(semColuna[0].n, 1, 'rollback não remove linhas');
  await db.pool.query(SQL_0097);
  const ent = await sql(`SELECT id, empresa_id FROM webhook_entregas WHERE id = $1`, [entLegado.id]);
  assert.equal(ent.length, 1, 'entrega legada preservada');
  assert.equal(ent[0].empresa_id, null);
});

test('PgStore: alvos de evento respeitam empresa; evento global só a webhook global', { skip }, async () => {
  const store = getStore();
  const a = await store.insert(W.R_WEBHOOKS, { nome: `PG-A-${sufixo}`, url: 'https://a.exemplo.test/h', eventos: JSON.stringify(['usuario.criado']), ativo: true, segredo_cifrado: 'x', empresa_id: EMP_A });
  const b = await store.insert(W.R_WEBHOOKS, { nome: `PG-B-${sufixo}`, url: 'https://b.exemplo.test/h', eventos: JSON.stringify(['usuario.criado']), ativo: true, segredo_cifrado: 'x', empresa_id: EMP_B });
  const g = await store.insert(W.R_WEBHOOKS, { nome: `PG-G-${sufixo}`, url: 'https://g.exemplo.test/h', eventos: JSON.stringify(['usuario.ativado']), ativo: true, segredo_cifrado: 'x' });
  const ids = (await W.alvosDoEvento('usuario.criado', EMP_A)).map((w: any) => Number(w.id));
  assert.ok(ids.includes(Number(a.id)), 'A recebe evento de A');
  assert.equal(ids.includes(Number(b.id)), false, 'B não recebe evento de A');
  const globais = (await W.alvosDoEvento('usuario.ativado', undefined)).map((w: any) => Number(w.id));
  assert.ok(globais.includes(Number(g.id)), 'global recebe evento global');
  assert.equal(globais.includes(Number(a.id)), false, 'webhook de A não recebe evento global');
});

test('PgStore: entregas filtradas por empresa excluem legado NULL e a outra empresa', { skip }, async () => {
  const store = getStore();
  const w = await store.insert(W.R_WEBHOOKS, { nome: `PG-E-${sufixo}`, url: 'https://e.exemplo.test/h', eventos: '[]', ativo: true, segredo_cifrado: 'x', empresa_id: EMP_A });
  await store.insert(W.R_ENTREGAS, { webhook_id: Number(w.id), evento: 'usuario.criado', payload: '{}', estado: 'ok', tentativas: 1, empresa_id: EMP_A });
  await store.insert(W.R_ENTREGAS, { webhook_id: Number(w.id), evento: 'usuario.criado', payload: '{}', estado: 'ok', tentativas: 1, empresa_id: EMP_B });
  const list = await store.list(W.R_ENTREGAS, { page: 1, pageSize: 50, sort: 'id', dir: 'desc', filter: { webhook_id: Number(w.id), empresa_id: EMP_A } });
  assert.equal(list.rows.length, 1, 'só a entrega da empresa A');
  assert.equal(Number(list.rows[0].empresa_id), EMP_A);
});

test('PgStore: listagem de webhooks para admin de A não mostra B nem global', { skip }, async () => {
  const store = getStore();
  await store.insert(W.R_WEBHOOKS, { nome: `LST-A-${sufixo}`, url: 'https://la.exemplo.test/h', eventos: '[]', ativo: true, segredo_cifrado: 'x', empresa_id: EMP_A });
  await store.insert(W.R_WEBHOOKS, { nome: `LST-B-${sufixo}`, url: 'https://lb.exemplo.test/h', eventos: '[]', ativo: true, segredo_cifrado: 'x', empresa_id: EMP_B });
  await store.insert(W.R_WEBHOOKS, { nome: `LST-G-${sufixo}`, url: 'https://lg.exemplo.test/h', eventos: '[]', ativo: true, segredo_cifrado: 'x' });
  const admin = { id: 9001, name: 'Adm', perfil: 'admin', email: `adm.${sufixo}@teste.local`, empresa_id: EMP_A };
  let body: any;
  const req: any = { user: admin, params: {}, query: {}, headers: {}, body: {} };
  const res: any = { json: (b: unknown) => { body = b; return res; }, status: () => res };
  await W.listarWebhooks(req, res);
  const nomes = body.webhooks.map((w: any) => w.nome);
  assert.ok(nomes.includes(`LST-A-${sufixo}`), 'webhook de A listado');
  assert.equal(nomes.includes(`LST-B-${sufixo}`), false, 'B não listado');
  assert.equal(nomes.includes(`LST-G-${sufixo}`), false, 'global não listado');
});
