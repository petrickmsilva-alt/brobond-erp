// Etapa 08 em PostgreSQL REAL: AI CEO briefing derivado da Control Tower,
// idempotência por empresa, evidência com indicadores e nenhuma aplicação.
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

test('PG 08 — AI CEO briefing real, replay e isolamento por empresa', { skip }, async () => {
  const { query } = await boot();
  const { gerarBriefingCEO, capacidadesAIStudio } = await import('../../src/aiStudio');
  const suffix = `ceo-pg-${Date.now()}-${process.pid}`;
  const u = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('CEO PG',$1,'gerente',1) RETURNING id", [`${suffix}@test.invalid`])).rows[0];
  const actor = { id: Number(u.id), name: 'CEO PG', perfil: 'gerente', empresa_id: 1, empresas: [1] };
  const REF = '2026-11-14';
  const cap = res(); capacidadesAIStudio(req({}, {}, '', actor), cap.out);
  assert.equal(cap.get().body.generativo_externo, false);
  assert.deepEqual(cap.get().body.agentes.map((a: any) => a.id), ['trend-hunter', 'creator-intelligence', 'ai-ceo']);
  const ceo = await call(gerarBriefingCEO, req({ data_referencia: REF }, {}, `${suffix}-ceo`, actor));
  assert.equal(ceo.status, 201); assert.equal(ceo.body.total, 1);
  const r = ceo.body.recomendacoes[0];
  assert.equal(r.dominio, 'commerce'); assert.equal(r.status, 'pendente');
  assert.equal(r.evidencia.aplicacao_automatica, false);
  assert.ok(Array.isArray(r.evidencia.indicadores)); assert.ok(r.evidencia.formula);
  const ceoReplay = await call(gerarBriefingCEO, req({ data_referencia: REF }, {}, `${suffix}-ceo`, actor));
  assert.equal(ceoReplay.status, 200); assert.equal(ceoReplay.body.execucao_id, ceo.body.execucao_id);
  await assert.rejects(() => call(gerarBriefingCEO, req({ data_referencia: '2026-11-15' }, {}, `${suffix}-ceo`, actor)), (e: any) => e.status === 409);
  // Operador não gera briefing (RBAC gerente+).
  const op = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('CEO OP',$1,'operador',1) RETURNING id", [`${suffix}-op@test.invalid`])).rows[0];
  const actorOp = { id: Number(op.id), name: 'CEO OP', perfil: 'operador', empresa_id: 1, empresas: [1] };
  await assert.rejects(() => call(gerarBriefingCEO, req({ data_referencia: REF }, {}, `${suffix}-op`, actorOp)), (e: any) => e.status === 403);
  // Outra empresa com a mesma chave não colide.
  const empB = (await query("INSERT INTO empresas (nome,ativo) VALUES ($1,true) RETURNING id", [`${suffix}-empresa-b`])).rows[0];
  const u2 = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('CEO PG B',$1,'gerente',$2) RETURNING id", [`${suffix}-b@test.invalid`, empB.id])).rows[0];
  const actorB = { id: Number(u2.id), name: 'CEO PG B', perfil: 'gerente', empresa_id: Number(empB.id), empresas: [Number(empB.id)] };
  const ceoB = await call(gerarBriefingCEO, req({ data_referencia: REF }, {}, `${suffix}-ceo`, actorB));
  assert.equal(ceoB.status, 201);
  const keys = await query('SELECT empresa_id,id FROM ai_executions WHERE chave_idempotencia=$1 ORDER BY empresa_id', [`${suffix}-ceo`]);
  assert.equal(keys.rows.length, 2); assert.notEqual(keys.rows[0].id, keys.rows[1].id);
});
