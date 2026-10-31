import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { R_CREATOR_ATTRIBUTIONS, R_CREATOR_PARTNERSHIPS } = await import('../src/creatorsResources');
const { createCreatorsEntity, updateCreatorsEntity, detailCreatorsEntity, listCreatorsEntity, listCreatorAttributions, atribuirCheckoutCreator } = await import('../src/creators');
const actor = { id: 1, name: 'Gerente', perfil: 'gerente', empresa_id: 1, empresas: [1] };
function req(body: object = {}, params: object = {}, key = 'creator-key-0001', user: any = actor) { return { body, params, user, query: {}, get: () => key } as any; }
function res() { let body: any, status = 200; const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} }; return { out, get: () => ({ body, status }) }; }
async function create(entity: 'profile' | 'campaign' | 'partnership', data: object, key: string, user = actor) { const r = res(); await createCreatorsEntity(entity)(req(data, {}, key, user), r.out); return r.get(); }
async function update(entity: 'profile' | 'campaign' | 'partnership', id: number, data: object, key: string, user = actor) { const r = res(); await updateCreatorsEntity(entity)(req(data, { id }, key, user), r.out); return r.get(); }

test('creators: cadastro e campanha reais, idempotência, versão, autorização e isolamento', async () => {
  const profileData = { name: 'Criador Teste', platform: 'INSTAGRAM', handle: '@NomeTeste', niche: 'moda' };
  await assert.rejects(() => create('profile', profileData, 'profile-no-access', { ...actor, perfil: 'operador' }), (e: any) => e.status === 403);
  const p = await create('profile', profileData, 'profile-key-0001'); assert.equal(p.status, 201); assert.equal(p.body.row.handle, 'nometeste');
  const replay = await create('profile', profileData, 'profile-key-0001'); assert.equal(replay.body.idempotente, true); assert.equal(replay.body.row.id, p.body.row.id);
  await assert.rejects(() => create('profile', { ...profileData, name: 'Outro' }, 'profile-key-0001'), (e: any) => e.status === 409);
  await assert.rejects(() => create('profile', profileData, 'profile-key-0002'), (e: any) => e.status === 409);
  await assert.rejects(() => detailCreatorsEntity('profile')(req({}, { id: p.body.row.id }, '', { ...actor, empresa_id: 2, empresas: [2] }), res().out), (e: any) => e.status === 404);
  const campData = { name: 'Campanha Real', objective: 'Divulgação de produtos', starts_on: '2020-01-01', ends_on: '2099-12-31' };
  const c = await create('campaign', campData, 'campaign-key-001'); assert.equal(c.body.row.status, 'DRAFT');
  const active = await update('campaign', c.body.row.id, { ...campData, status: 'ACTIVE', expected_version: 0 }, 'campaign-key-002'); assert.equal(active.body.row.version, 1);
  await assert.rejects(() => update('campaign', c.body.row.id, { ...campData, status: 'PAUSED', expected_version: 0 }, 'campaign-key-003'), (e: any) => e.status === 409);
  const op = res(); await listCreatorsEntity('profile')(req({}, {}, '', { ...actor, perfil: 'operador' }), op.out); assert.equal(op.get().body.total, 1);
});

test('creators: parceria manual atribui somente cupom aplicado e nunca expõe comprador', async () => {
  const s = getStore();
  const p = await create('profile', { name: 'Creator de Cupom', platform: 'TIKTOK', handle: 'cupom.teste' }, 'cupom-profile-01');
  const campData = { name: 'Campanha Cupom', objective: 'Parceria de divulgação', starts_on: '2020-01-01', ends_on: '2099-12-31' };
  const c = await create('campaign', campData, 'cupom-campaign-01');
  const coupon = await s.insert(getResource('commerce_cupons')!, { empresa_id: 1, codigo: 'CREATOR10', tipo: 'percentual', valor: 10, ativo: true, uso_atual: 0 });
  const foreign = await s.insert(getResource('commerce_cupons')!, { empresa_id: 2, codigo: 'FOREIGN10', tipo: 'percentual', valor: 10, ativo: true, uso_atual: 0 });
  const data = { creator_id: p.body.row.id, campaign_id: c.body.row.id, coupon_id: coupon.id };
  await assert.rejects(() => create('partnership', { ...data, coupon_id: foreign.id }, 'cupom-partner-00'), (e: any) => e.status === 404);
  const partner = await create('partnership', data, 'cupom-partner-01'); assert.equal(partner.body.row.status, 'PLANNED');
  await assert.rejects(() => update('partnership', partner.body.row.id, { status: 'ACTIVE', expected_version: 0 }, 'cupom-partner-02'), (e: any) => e.status === 409);
  await update('campaign', c.body.row.id, { ...campData, status: 'ACTIVE', expected_version: 0 }, 'cupom-campaign-02');
  await update('partnership', partner.body.row.id, { status: 'ACTIVE', expected_version: 0 }, 'cupom-partner-03');
  const order = await s.insert(getResource('commerce_pedidos')!, { empresa_id: 1, canal: 'BROBOND', pedido_externo: 'ORD-TEST', cupom_codigo: 'CREATOR10', estado: 'AGUARDANDO_PAGAMENTO', pagamento_estado: 'PENDING', total: 123, comprador: { nome: 'Não pode vazar', email: 'privado@teste.invalid' } });
  const recorded = await atribuirCheckoutCreator(1, Number(coupon.id), Number(order.id), null, new Date('2028-05-01T12:00:00Z'));
  assert.equal(recorded?.partnership_id, partner.body.row.id);
  assert.equal((await atribuirCheckoutCreator(1, Number(coupon.id), Number(order.id), null, new Date('2028-05-01T12:00:00Z')))?.id, recorded?.id);
  const wrong = await s.insert(getResource('commerce_pedidos')!, { empresa_id: 1, canal: 'BROBOND', pedido_externo: 'ORD-OTHER', cupom_codigo: 'OUTRO', estado: 'PAGO' });
  await assert.rejects(() => atribuirCheckoutCreator(1, Number(coupon.id), Number(wrong.id), null), (e: any) => e.status === 409);
  const output = res(); await listCreatorAttributions(req({}, { id: partner.body.row.id }), output.out);
  assert.equal(output.get().body.total, 1); assert.equal(output.get().body.rows[0].estado, 'AGUARDANDO_PAGAMENTO');
  assert.ok(!JSON.stringify(output.get().body).includes('privado@teste.invalid')); assert.ok(!JSON.stringify(output.get().body).includes('Não pode vazar'));
  await update('partnership', partner.body.row.id, { status: 'PAUSED', expected_version: 1 }, 'cupom-partner-04');
  const other = await s.insert(getResource('commerce_pedidos')!, { empresa_id: 1, canal: 'BROBOND', pedido_externo: 'ORD-PAUSED', cupom_codigo: 'CREATOR10', estado: 'PAGO' });
  assert.equal(await atribuirCheckoutCreator(1, Number(coupon.id), Number(other.id), null), null);
  assert.equal((await s.list(R_CREATOR_ATTRIBUTIONS, { page: 1, pageSize: 10, filter: { empresa_id: 1, partnership_id: partner.body.row.id } })).total, 1);
  const { excluirCupom } = await import('../src/commerce/promocoes'); const deleted = res(); await excluirCupom(req({}, { id: coupon.id }), deleted.out);
  assert.equal(deleted.get().body.desativado, true); assert.equal((await s.get(getResource('commerce_cupons')!, coupon.id))?.ativo, false);
  assert.equal((await s.get(R_CREATOR_PARTNERSHIPS, partner.body.row.id))?.coupon_id, coupon.id);
});

test('creators: match e outreach são registros REAIS, idempotentes e isolados por empresa', async () => {
  const s = getStore();
  const p = await create('profile', { name: 'Creator Match', platform: 'YOUTUBE', handle: 'match.teste' }, 'match-profile-01');
  const campData = { name: 'Campanha Match', objective: 'Afinidade editorial', starts_on: '2020-01-01', ends_on: '2099-12-31' };
  const c = await create('campaign', campData, 'match-campaign-01');
  const categoria = await s.insert(getResource('categorias')!, { nome: 'Vestidos' });

  // Match: a afinidade é registrada por uma pessoa com score e evidência.
  const matchData = { creator_id: p.body.row.id, campaign_id: c.body.row.id, categoria_id: categoria.id, score: 7.5, evidencia: { publicos: ['moda', 'verao'] }, status: 'sugerido' };
  const m = await create('match', matchData, 'match-key-0001'); assert.equal(m.status, 201);
  assert.equal(m.body.row.score, 7.5); assert.equal(m.body.row.status, 'sugerido');
  const replay = await create('match', matchData, 'match-key-0001'); assert.equal(replay.body.idempotente, true); assert.equal(replay.body.row.id, m.body.row.id);
  // Duplicidade real (creator × campanha) é recusada, não silenciada.
  await assert.rejects(() => create('match', matchData, 'match-key-0002'), (e: any) => e.status === 409);
  // Isolamento por empresa: outra empresa não enxerga o match.
  await assert.rejects(() => detailCreatorsEntity('match')(req({}, { id: m.body.row.id }, '', { ...actor, empresa_id: 2, empresas: [2] }), res().out), (e: any) => e.status === 404);
  // Operador não cria (RBAC de escrita espelhado no servidor).
  await assert.rejects(() => create('match', matchData, 'match-key-0003', { ...actor, perfil: 'operador' }), (e: any) => e.status === 403);

  // Outreach: registro manual do contato. Não há geração nem envio simulados.
  const outreachData = { creator_id: p.body.row.id, canal: 'email', assunto: 'Convite', mensagem: 'Olá, temos uma campanha.', status: 'rascunho' };
  const o = await create('outreach', outreachData, 'outreach-key-001'); assert.equal(o.status, 201);
  assert.equal(o.body.row.status, 'rascunho'); assert.equal(o.body.row.enviado_em, null);
  // Transição para "enviado" grava o carimbo do humano que afirmou contatar.
  const sent = await update('outreach', o.body.row.id, { status: 'enviado' }, 'outreach-key-002');
  assert.equal(sent.body.row.status, 'enviado'); assert.ok(sent.body.row.enviado_em);
  await assert.rejects(() => create('outreach', { ...outreachData, canal: 'pombo' }, 'outreach-key-003'), (e: any) => e.status === 400);
  const lista = res(); await listCreatorsEntity('outreach')(req({}, {}, '', { ...actor, perfil: 'operador' }), lista.out);
  assert.equal(lista.get().body.total, 1);
});
