// ============================================================================
// ETAPA 07 — CREATOR INTELLIGENCE (matching determinístico, sem envio/LLM).
// Contratos: tokens/afinidade normalizados, atribuições pagas reais, score
// versionado, evidência, idempotência, RBAC, tenant/campanha cross-empresa 404,
// nenhuma criação de match/outreach/parceria e nenhum envio automático.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { criarAtor, garantirAdmin, reqDe, chamar, esperarErro } = await import('./_p1util');
const { gerarCreatorIntelligence, afinidadeNicho, tokensAfidade, CREATOR_INTELLIGENCE_PESOS } = await import('../src/creatorIntelligence');
const { R_CREATORS, R_CREATOR_CAMPAIGNS, R_CREATOR_PARTNERSHIPS, R_CREATOR_ATTRIBUTIONS, R_CREATOR_OUTREACH } = await import('../src/creatorsResources');

await garantirAdmin();
const s = getStore();
const gerenteA = await criarAtor(1, 'gerente');
const gerenteB = await criarAtor(2, 'gerente');
const operadorA = await criarAtor(1, 'operador');
const tag = Date.now().toString(36);
const REF = '2026-11-14';

test('07 — tokens/afinidade são normalizados e pesos fecham em 1', () => {
  assert.deepEqual(tokensAfidade('Moda Verão e praia'), ['moda', 'praia', 'verao']);
  const a = afinidadeNicho('moda verão', 'Campanha de moda e praia');
  assert.equal(a.valor, 0.5);
  assert.deepEqual(a.comuns, ['moda']);
  assert.equal(Object.values(CREATOR_INTELLIGENCE_PESOS).reduce((x, y) => x + y, 0), 1);
});

test('07 — Creator Intelligence usa atribuições pagas reais, não cria match/outreach/parceria', async () => {
  const creator = await s.insert(R_CREATORS, { empresa_id: 1, name: 'Creator Moda', platform: 'INSTAGRAM', handle: `moda.${tag}`, niche: 'moda verão', status: 'ACTIVE', version: 0, created_by: gerenteA.id, updated_by: gerenteA.id });
  const campaign = await s.insert(R_CREATOR_CAMPAIGNS, { empresa_id: 1, name: 'Campanha Moda Verão', objective: 'Divulgação de moda verão', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'ACTIVE', version: 0, created_by: gerenteA.id, updated_by: gerenteA.id });
  const partner = await s.insert(R_CREATOR_PARTNERSHIPS, { empresa_id: 1, creator_id: Number(creator.id), campaign_id: Number(campaign.id), status: 'ACTIVE', version: 0, created_by: gerenteA.id, updated_by: gerenteA.id });
  const order = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', pedido_externo: `CI-${tag}`, estado: 'PAGO', pagamento_estado: 'APPROVED', total: 200 });
  await s.insert(R_CREATOR_ATTRIBUTIONS, { empresa_id: 1, partnership_id: Number(partner.id), order_id: Number(order.id) });
  const matchesAntes = (await s.list(RESOURCES.creator_matches, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total;
  const outreachAntes = (await s.list(R_CREATOR_OUTREACH, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total;
  const body = { data_referencia: REF, campaign_id: Number(campaign.id) };
  const out = await chamar(gerarCreatorIntelligence, reqDe(body, { user: gerenteA, headers: { 'Idempotency-Key': `ci-${tag}-0001` } }), 201);
  assert.equal(out.total, 1);
  const r = out.recomendacoes[0];
  assert.equal(r.dominio, 'marketing');
  assert.equal(r.evidencia.creator_id, Number(creator.id));
  assert.equal(r.evidencia.historico.pedidos_pagos, 1);
  assert.equal(r.evidencia.geracao_mensagem, false);
  assert.equal(r.evidencia.envio_automatico, false);
  assert.equal(Number(r.score), 0.76); // 0,5×1 + 0,3×(1/5) + 0,2×1
  const replay = await chamar(gerarCreatorIntelligence, reqDe(body, { user: gerenteA, headers: { 'Idempotency-Key': `ci-${tag}-0001` } }), 200);
  assert.equal(replay.idempotente, true);
  assert.equal((await s.list(RESOURCES.creator_matches, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total, matchesAntes);
  assert.equal((await s.list(R_CREATOR_OUTREACH, { page: 1, pageSize: 100, filter: { empresa_id: 1 } })).total, outreachAntes);
  await esperarErro(() => chamar(gerarCreatorIntelligence, reqDe({ ...body, campaign_id: 999999 }, { user: gerenteA, headers: { 'Idempotency-Key': `ci-${tag}-404` } })), 404);
  await esperarErro(() => chamar(gerarCreatorIntelligence, reqDe(body, { user: operadorA, headers: { 'Idempotency-Key': `ci-${tag}-op` } })), 403);
});

test('07 — campanha de outra empresa é 404 e não entra no cálculo', async () => {
  const campaignB = await s.insert(R_CREATOR_CAMPAIGNS, { empresa_id: 2, name: 'Campanha B', objective: 'Objetivo da empresa B', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'ACTIVE', version: 0, created_by: gerenteB.id, updated_by: gerenteB.id });
  await esperarErro(() => chamar(gerarCreatorIntelligence, reqDe({ data_referencia: REF, campaign_id: Number(campaignB.id) }, { user: gerenteA, headers: { 'Idempotency-Key': `ci-${tag}-cross` } })), 404);
});
