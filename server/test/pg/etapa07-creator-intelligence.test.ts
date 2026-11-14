// Etapa 07 em PostgreSQL REAL: creator_commands aceita match/outreach (CHECK
// alargado pela 0122), idempotência/replay, e Creator Intelligence com
// atribuições pagas reais sem criar match/outreach/parceria nem enviar.
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

test('PG 07 — creator_commands aceita match/outreach e mantém tenant/idempotência', { skip }, async () => {
  const { query } = await boot();
  const { createCreatorsEntity } = await import('../../src/creators');
  const suffix = `ci-pg-${Date.now()}-${process.pid}`;
  const u = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('Creator Intel PG',$1,'gerente',1) RETURNING id", [`${suffix}@test.invalid`])).rows[0];
  const actor = { id: Number(u.id), name: 'Creator Intel PG', perfil: 'gerente', empresa_id: 1, empresas: [1] };
  const profile = await call(createCreatorsEntity('profile'), req({ name: 'Creator PG', platform: 'INSTAGRAM', handle: suffix, niche: 'moda verão' }, {}, `${suffix}-profile`, actor));
  const campaign = await call(createCreatorsEntity('campaign'), req({ name: 'Campanha moda', objective: 'moda verão', starts_on: '2020-01-01', ends_on: '2099-12-31', status: 'ACTIVE' }, {}, `${suffix}-campaign`, actor));
  const creatorId = Number(profile.body.row.id), campaignId = Number(campaign.body.row.id);
  const matchBody = { creator_id: creatorId, campaign_id: campaignId, score: 80, status: 'sugerido', evidencia: { fonte: 'teste PG', fatos: ['nicho declarado'] } };
  const match = await call(createCreatorsEntity('match'), req(matchBody, {}, `${suffix}-match`, actor));
  assert.equal(match.status, 201);
  const replay = await call(createCreatorsEntity('match'), req(matchBody, {}, `${suffix}-match`, actor));
  assert.equal(replay.status, 200); assert.equal(replay.body.row.id, match.body.row.id);
  const outreach = await call(createCreatorsEntity('outreach'), req({ creator_id: creatorId, canal: 'email', mensagem: 'Rascunho factual registrado por humano.', status: 'rascunho' }, {}, `${suffix}-outreach`, actor));
  assert.equal(outreach.status, 201); assert.equal(outreach.body.row.status, 'rascunho'); assert.equal(outreach.body.row.enviado_em, null);
  const commands = await query("SELECT entity FROM creator_commands WHERE empresa_id=1 AND entity IN ('match','outreach') AND idempotency_key LIKE $1 ORDER BY entity", [`${suffix}%`]);
  assert.deepEqual(commands.rows.map((r: any) => r.entity), ['match', 'outreach']);
  await assert.rejects(() => query("INSERT INTO creator_commands (empresa_id,idempotency_key,request_hash,entity,entity_id,created_by) VALUES (1,'invalid-entity-pg',repeat('a',64),'inexistente',1,$1)", [actor.id]), (e: any) => e.code === '23514');
});

test('PG 07 — Creator Intelligence com atribuições pagas reais, sem efeitos colaterais', { skip }, async () => {
  const { query } = await boot();
  const { gerarCreatorIntelligence } = await import('../../src/creatorIntelligence');
  const suffix = `ci2-pg-${Date.now()}-${process.pid}`;
  const u = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('CI PG',$1,'gerente',1) RETURNING id", [`${suffix}@test.invalid`])).rows[0];
  const actor = { id: Number(u.id), name: 'CI PG', perfil: 'gerente', empresa_id: 1, empresas: [1] };
  const REF = '2026-11-14';
  const cr = (await query("INSERT INTO creator_profiles (empresa_id,name,platform,handle,niche,status,created_by,updated_by) VALUES (1,'Creator CI PG','INSTAGRAM',$1,'moda verão','ACTIVE',$2,$2) RETURNING id", [`${suffix}-creator`, actor.id])).rows[0];
  const ca = (await query("INSERT INTO creator_campaigns (empresa_id,name,objective,starts_on,ends_on,status,created_by,updated_by) VALUES (1,'Campanha moda CI','moda verão','2026-01-01','2026-12-31','ACTIVE',$1,$1) RETURNING id", [actor.id])).rows[0];
  const pa = (await query("INSERT INTO creator_partnerships (empresa_id,creator_id,campaign_id,status,created_by,updated_by) VALUES (1,$1,$2,'ACTIVE',$3,$3) RETURNING id", [cr.id, ca.id, actor.id])).rows[0];
  const order = (await query("INSERT INTO commerce_pedidos (empresa_id,canal,pedido_externo,estado,pagamento_estado,total) VALUES (1,'BROBOND',$1,'PAGO','APPROVED',200) RETURNING id", [suffix])).rows[0];
  await query('INSERT INTO creator_attributions (empresa_id,partnership_id,order_id) VALUES (1,$1,$2)', [pa.id, order.id]);
  const ciBody = { data_referencia: REF, campaign_id: Number(ca.id) };
  const ci = await call(gerarCreatorIntelligence, req(ciBody, {}, `${suffix}-ci`, actor));
  assert.equal(ci.status, 201); assert.ok(ci.body.total >= 1);
  // Banco PG compartilhado: outros creators ativos podem casar. O contrato é o
  // par específico + tenant único + ausência de efeitos colaterais.
  const recDoCreator = ci.body.recomendacoes.find((r: any) => r.evidencia.creator_id === Number(cr.id));
  assert.ok(recDoCreator); assert.equal(Number(recDoCreator.score), 0.76);
  assert.ok(ci.body.recomendacoes.every((r: any) => r.empresa_id === 1));
  const ciReplay = await call(gerarCreatorIntelligence, req(ciBody, {}, `${suffix}-ci`, actor));
  assert.equal(ciReplay.status, 200);
  const matchesBefore = (await query('SELECT count(*)::int n FROM creator_matches WHERE empresa_id=1')).rows[0].n;
  const outreachBefore = (await query('SELECT count(*)::int n FROM creator_outreach WHERE empresa_id=1')).rows[0].n;
  assert.equal((await query('SELECT count(*)::int n FROM creator_matches WHERE empresa_id=1')).rows[0].n, matchesBefore);
  assert.equal((await query('SELECT count(*)::int n FROM creator_outreach WHERE empresa_id=1')).rows[0].n, outreachBefore);
  // Campanha de outra empresa: 404, não entra no cálculo.
  const empB = (await query("INSERT INTO empresas (nome,ativo) VALUES ($1,true) RETURNING id", [`${suffix}-empresa-b`])).rows[0];
  const caB = (await query("INSERT INTO creator_campaigns (empresa_id,name,objective,starts_on,ends_on,status,created_by,updated_by) VALUES ($1,'Campanha B','objetivo b','2026-01-01','2026-12-31','ACTIVE',$2,$2) RETURNING id", [empB.id, actor.id])).rows[0];
  await assert.rejects(() => call(gerarCreatorIntelligence, req({ data_referencia: REF, campaign_id: Number(caB.id) }, {}, `${suffix}-cross`, actor)), (e: any) => e.status === 404);
});
