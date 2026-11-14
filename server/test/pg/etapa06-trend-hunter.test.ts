// Etapa 06 em PostgreSQL REAL: vendas canônicas, score, replay, divergência 409,
// tenant A×B com a mesma chave, unicidade parcial e orçamento por mês UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const skip = process.env.DATABASE_URL ? false : 'requer PostgreSQL real';
process.env.NODE_ENV = 'test';

function req(body: object, params: object = {}, key = 'ai-pg-key-0001', user: any) {
  return { body, params, user, query: {}, get: (h: string) => (h.toLowerCase() === 'idempotency-key' ? key : undefined) } as any;
}
function res() {
  let body: any, status = 200;
  const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} };
  return { out, get: () => ({ body, status }) };
}
async function call(handler: Function, request: any) {
  const r = res(); await handler(request, r.out); return r.get();
}
async function boot() {
  const db = await import('../../src/db'); await db.migrate(); assert.equal(db.isDbConnected(), true); return db;
}

test('PG 06 — Trend Hunter real, replay, divergência e isolamento por empresa', { skip }, async () => {
  const { query } = await boot();
  const { gerarTrendHunter } = await import('../../src/trendHunter');
  const suffix = `th-pg-${Date.now()}-${process.pid}`;
  const u = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('TH PG',$1,'gerente',1) RETURNING id", [`${suffix}@test.invalid`])).rows[0];
  const actor = { id: Number(u.id), name: 'TH PG', perfil: 'gerente', empresa_id: 1, empresas: [1] };
  const REF = '2026-11-14';
  const p = (await query("INSERT INTO produtos (empresa_id,sku,nome,ativo,custo,preco_venda) VALUES (1,$1,'Produto TH PG',true,10,30) RETURNING id", [suffix])).rows[0];
  const cli = (await query("INSERT INTO clientes (empresa_id,nome,tipo,ativo) VALUES (1,$1,'pf',true) RETURNING id", [suffix])).rows[0];
  for (const [dia, qtd, ext] of [['2026-11-03', 2, `${suffix}-v1`], ['2026-11-09', 4, `${suffix}-v2`], ['2026-11-11', 3, `${suffix}-v3`]] as const) {
    const v = (await query("INSERT INTO vendas (empresa_id,cliente_id,status,total,data,faturada_em,canal_venda,pedido_externo_id) VALUES (1,$1,'faturada',$2,$3,$3,'balcao',$4) RETURNING id", [cli.id, qtd * 30, `${dia}T12:00:00Z`, ext])).rows[0];
    await query('INSERT INTO itens_venda (empresa_id,venda_id,produto_id,quantidade,preco_unitario,subtotal) VALUES (1,$1,$2,$3,30,$4)', [v.id, p.id, qtd, qtd * 30]);
  }
  const thBody = { data_referencia: REF, janela_dias: 7 };
  const th = await call(gerarTrendHunter, req(thBody, {}, `${suffix}-th`, actor));
  assert.equal(th.status, 201); assert.ok(th.body.total >= 1);
  const rec = th.body.recomendacoes.find((r: any) => r.evidencia.produto_id === Number(p.id));
  assert.ok(rec); assert.equal(Number(rec.score), 0.626);
  const thReplay = await call(gerarTrendHunter, req(thBody, {}, `${suffix}-th`, actor));
  assert.equal(thReplay.status, 200); assert.equal(thReplay.body.execucao_id, th.body.execucao_id);
  await assert.rejects(() => call(gerarTrendHunter, req({ ...thBody, janela_dias: 14 }, {}, `${suffix}-th`, actor)), (e: any) => e.status === 409);

  // Tenant: outra empresa com a MESMA chave não colide; idempotência é por empresa.
  const empB = (await query("INSERT INTO empresas (nome,ativo) VALUES ($1,true) RETURNING id", [`${suffix}-empresa-b`])).rows[0];
  const u2 = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('TH PG B',$1,'gerente',$2) RETURNING id", [`${suffix}-b@test.invalid`, empB.id])).rows[0];
  const actorB = { id: Number(u2.id), name: 'TH PG B', perfil: 'gerente', empresa_id: Number(empB.id), empresas: [Number(empB.id)] };
  const thB = await call(gerarTrendHunter, req(thBody, {}, `${suffix}-th`, actorB));
  assert.equal(thB.status, 201); assert.equal(thB.body.total, 0);
  const keys = await query('SELECT empresa_id,id FROM ai_executions WHERE chave_idempotencia=$1 ORDER BY empresa_id', [`${suffix}-th`]);
  assert.equal(keys.rows.length, 2); assert.notEqual(keys.rows[0].id, keys.rows[1].id);
  await assert.rejects(() => query("INSERT INTO ai_executions (empresa_id,finalidade,estado,custo,chave_idempotencia) VALUES (1,'duplicada','sucesso',0,$1)", [`${suffix}-th`]), (e: any) => e.code === '23505');
});

test('PG 06 — orçamento mensal real por provider e bloqueio de provedor externo', { skip }, async () => {
  const { query } = await boot();
  const { gerarTrendHunter } = await import('../../src/trendHunter');
  const { custoMesIA } = await import('../../src/aiPlatform');
  const suffix = `budget-pg-${Date.now()}-${process.pid}`;
  const u = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('Budget PG',$1,'gerente',1) RETURNING id", [`${suffix}@test.invalid`])).rows[0];
  const actor = { id: Number(u.id), name: 'Budget PG', perfil: 'gerente', empresa_id: 1, empresas: [1] };
  const prov = (await query("INSERT INTO ai_providers (empresa_id,nome,tipo,limite_mensal_custo,ativo) VALUES (1,$1,'heuristica',10,true) RETURNING id", [suffix])).rows[0];
  await query("INSERT INTO ai_executions (empresa_id,provider_id,finalidade,estado,custo,criado_em) VALUES (1,$1,'mes-atual','sucesso',9.5,'2026-11-02T00:00:00Z')", [prov.id]);
  await query("INSERT INTO ai_executions (empresa_id,provider_id,finalidade,estado,custo,criado_em) VALUES (1,$1,'mes-anterior','sucesso',100,'2026-10-30T00:00:00Z')", [prov.id]);
  assert.equal(await custoMesIA(1, Number(prov.id), '2026-11-14'), 9.5);
  await query("INSERT INTO ai_executions (empresa_id,provider_id,finalidade,estado,custo,criado_em) VALUES (1,$1,'estouro','sucesso',1,'2026-11-03T00:00:00Z')", [prov.id]);
  await assert.rejects(() => call(gerarTrendHunter, req({ data_referencia: '2026-11-14', janela_dias: 7, provider_id: Number(prov.id) }, {}, `${suffix}-blocked`, actor)), (e: any) => e.status === 409);
  const ext = (await query("INSERT INTO ai_providers (empresa_id,nome,tipo,ativo) VALUES (1,$1,'externo',true) RETURNING id", [`${suffix}-ext`])).rows[0];
  await assert.rejects(() => call(gerarTrendHunter, req({ data_referencia: '2026-11-14', janela_dias: 7, provider_id: Number(ext.id) }, {}, `${suffix}-ext`, actor)), (e: any) => e.status === 409);
  const blocked = await query('SELECT count(*)::int n FROM ai_executions WHERE chave_idempotencia LIKE $1', [`${suffix}%`]);
  assert.equal(blocked.rows[0].n, 0);
});
