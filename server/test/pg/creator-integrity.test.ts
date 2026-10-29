import { test } from 'node:test';
import assert from 'node:assert/strict';
const skip = process.env.DATABASE_URL ? false : 'requer PostgreSQL real';
process.env.NODE_ENV = 'test';
function req(body: object, params: object = {}, key = 'creator-pg-key-1', user: any) { return { body, params, user, query: {}, get: () => key } as any; }
function res() { let body: any, status = 200; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} }; return { out, get: () => ({ body, status }) }; }
async function boot() { const db = await import('../../src/db'); await db.migrate(); assert.equal(db.isDbConnected(), true); return db; }

test('PG creators: concorrência idempotente, restrições de tenant e cupom protegido', { skip }, async () => {
  const { query } = await boot(); const { createCreatorsEntity, updateCreatorsEntity } = await import('../../src/creators');
  const { excluirCupom } = await import('../../src/commerce/promocoes');
  const suffix = `creators-pg-${Date.now()}-${process.pid}`;
  const u = (await query("INSERT INTO usuarios (nome,email,perfil,empresa_id) VALUES ('Creator PG',$1,'admin',1) RETURNING id", [`${suffix}@test.invalid`])).rows[0];
  const actor = { id: Number(u.id), name: 'Creator PG', perfil: 'admin', empresa_id: 1, empresas: [1] };
  const profileData = { name: 'Criador real', platform: 'INSTAGRAM', handle: suffix };
  const results = await Promise.all(Array.from({ length: 5 }, async () => { const r = res(); await createCreatorsEntity('profile')(req(profileData, {}, 'profile-pg-key', actor), r.out); return r.get(); }));
  assert.equal(results.filter((r) => r.status === 201).length, 1); assert.equal(new Set(results.map((r) => String(r.body.row.id))).size, 1);
  const profileId = Number(results[0].body.row.id);
  const campData = { name: 'Campanha real', objective: 'Divulgação verificável', starts_on: '2020-01-01', ends_on: '2099-12-31' };
  const campaign = res(); await createCreatorsEntity('campaign')(req(campData, {}, 'campaign-pg-key', actor), campaign.out); const campaignId = Number(campaign.get().body.row.id);
  const company = (await query('INSERT INTO empresas (nome,ativo) VALUES ($1,true) RETURNING id', [suffix])).rows[0];
  const foreignCoupon = (await query("INSERT INTO commerce_cupons (empresa_id,codigo,tipo,valor) VALUES ($1,$2,'percentual',5) RETURNING id", [company.id, suffix])).rows[0];
  await assert.rejects(() => createCreatorsEntity('partnership')(req({ creator_id: profileId, campaign_id: campaignId, coupon_id: Number(foreignCoupon.id) }, {}, 'bad-coupon-pg-key', actor), res().out), (e: any) => e.status === 404);
  await assert.rejects(() => query("INSERT INTO creator_partnerships (empresa_id,creator_id,campaign_id,status) VALUES ($1,$2,$3,'PLANNED')", [company.id, profileId, campaignId]), (e: any) => e.code === '23503');
  const coupon = (await query("INSERT INTO commerce_cupons (empresa_id,codigo,tipo,valor) VALUES (1,$1,'percentual',5) RETURNING id", [suffix])).rows[0];
  const [creation, deletion] = await Promise.allSettled([
    createCreatorsEntity('partnership')(req({ creator_id: profileId, campaign_id: campaignId, coupon_id: Number(coupon.id) }, {}, 'partner-pg-key', actor), res().out),
    excluirCupom(req({}, { id: Number(coupon.id) }, '', actor), res().out),
  ]);
  assert.equal(deletion.status, 'fulfilled');
  if (creation.status === 'rejected') assert.equal(creation.reason.status, 404);
  const partners = await query('SELECT id,coupon_id FROM creator_partnerships WHERE empresa_id=1 AND creator_id=$1', [profileId]);
  const coupons = await query('SELECT id,ativo FROM commerce_cupons WHERE id=$1', [coupon.id]);
  if (partners.rows.length) { assert.equal(coupons.rows.length, 1); assert.equal(coupons.rows[0].ativo, false); }
  else assert.equal(coupons.rows.length, 0);
  const update = res(); await updateCreatorsEntity('campaign')(req({ ...campData, status: 'ACTIVE', expected_version: 0 }, { id: campaignId }, 'campaign-active-pg', actor), update.out);
  assert.equal(update.get().body.row.version, 1);
  await assert.rejects(() => updateCreatorsEntity('campaign')(req({ ...campData, status: 'PAUSED', expected_version: 0 }, { id: campaignId }, 'campaign-stale-pg', actor), res().out), (e: any) => e.status === 409);
});
