// ============================================================================
// ETAPA 08 — AI STUDIO / AI CEO (catálogo fechado + briefing determinístico).
// Contratos: catálogo sem ferramenta arbitrária, generativo externo bloqueado,
// briefing derivado da Control Tower com evidência, idempotência, RBAC e
// nenhuma aplicação automática.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { criarAtor, garantirAdmin, reqDe, resFake, chamar, esperarErro } = await import('./_p1util');
const { gerarBriefingCEO, capacidadesAIStudio, catalogoAIStudio, prioridadeCEO } = await import('../src/aiStudio');

await garantirAdmin();
const gerenteA = await criarAtor(1, 'gerente');
const operadorA = await criarAtor(1, 'operador');
const tag = Date.now().toString(36);
const REF = '2026-11-14';

test('08 — catálogo do Studio é fechado; CEO briefing é leitura executiva sem aplicação', async () => {
  const cat = catalogoAIStudio();
  assert.equal(cat.generativo_externo, false);
  assert.deepEqual(cat.agentes.map((a: any) => a.id), ['trend-hunter', 'creator-intelligence', 'ai-ceo']);
  assert.ok(cat.ferramentas.every((f: any) => ['leitura', 'decisao_humana'].includes(f.tipo)));
  const { res, saida } = resFake();
  capacidadesAIStudio(reqDe({}, { user: gerenteA }), res);
  assert.equal(saida.json.generativo_externo, false);
  assert.throws(() => capacidadesAIStudio(reqDe({}, { user: operadorA }), resFake().res), (e: any) => e.status === 403);
  const prior = prioridadeCEO({ alertas_criticos: 5, outbox_erro: 10, pedidos_parados: 10, tickets_sla_estourado: 10 }, 10_000);
  assert.equal(prior.score, 1);
  const out = await chamar(gerarBriefingCEO, reqDe({ data_referencia: REF }, { user: gerenteA, headers: { 'Idempotency-Key': `ceo-${tag}-001` } }), 201);
  assert.equal(out.total, 1);
  const r = out.recomendacoes[0];
  assert.equal(r.dominio, 'commerce');
  assert.equal(r.status, 'pendente');
  assert.equal(r.evidencia.aplicacao_automatica, false);
  assert.ok(Array.isArray(r.evidencia.indicadores));
  assert.ok(r.evidencia.formula);
  const replay = await chamar(gerarBriefingCEO, reqDe({ data_referencia: REF }, { user: gerenteA, headers: { 'Idempotency-Key': `ceo-${tag}-001` } }), 200);
  assert.equal(replay.idempotente, true);
  await esperarErro(() => chamar(gerarBriefingCEO, reqDe({ data_referencia: REF }, { user: operadorA, headers: { 'Idempotency-Key': `ceo-${tag}-op` } })), 403);
});
