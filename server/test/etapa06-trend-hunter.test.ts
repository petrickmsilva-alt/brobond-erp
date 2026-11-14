// ============================================================================
// ETAPA 06 — TREND HUNTER (determinístico, interno, sem descoberta externa).
// Contratos: janelas/agregação reproduzíveis, vendas reais, score versionado,
// evidência, idempotência por empresa, divergência 409, RBAC, tenant A×B,
// orçamento mensal com enforcement e nenhuma alteração operacional.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { criarAtor, garantirAdmin, reqDe, chamar, esperarErro } = await import('./_p1util');
const { gerarTrendHunter, janelaTrend, agregarTrends, variacaoTrend, TREND_HUNTER_PESOS } = await import('../src/trendHunter');
const { assertOrcamentoIA, custoMesIA, hashPayloadIA } = await import('../src/aiPlatform');

await garantirAdmin();
const s = getStore();
const gerenteA = await criarAtor(1, 'gerente');
const gerenteB = await criarAtor(2, 'gerente');
const operadorA = await criarAtor(1, 'operador');
const tag = Date.now().toString(36);
const REF = '2026-11-14';

async function produto(empresaId: number, sku: string, nome: string) {
  return s.insert(RESOURCES.produtos, { empresa_id: empresaId, sku, nome, ativo: true, custo: 10, preco_venda: 30 });
}
async function venda(empresaId: number, dia: string, total: number) {
  const cliente = await s.insert(RESOURCES.clientes, { empresa_id: empresaId, nome: `Cliente ${tag} ${dia}`, tipo: 'pf', ativo: true });
  return s.insert(RESOURCES.vendas, { empresa_id: empresaId, cliente_id: Number(cliente.id), status: 'faturada', total, data: `${dia}T12:00:00Z`, faturada_em: `${dia}T12:00:00Z`, canal_venda: 'balcao' });
}
async function item(empresaId: number, vendaId: number, produtoId: number, quantidade: number) {
  return s.insert(RESOURCES.itens_venda, { empresa_id: empresaId, venda_id: vendaId, produto_id: produtoId, quantidade, preco_unitario: 30, subtotal: quantidade * 30 });
}

test('06 — janelas e agregação são determinísticas; crescimento sem base é null', () => {
  const j = janelaTrend(REF, 7);
  assert.deepEqual(j.atual, { inicio: '2026-11-08', fim: '2026-11-14', dias: 7 });
  assert.deepEqual(j.anterior, { inicio: '2026-11-01', fim: '2026-11-07', dias: 7 });
  assert.equal(variacaoTrend(9, 3), 200);
  assert.equal(variacaoTrend(3, 0), null);
  const vendas = [
    { id: 1, status: 'faturada', faturada_em: '2026-11-10T10:00:00Z' },
    { id: 2, status: 'entregue', faturada_em: '2026-11-04T10:00:00Z' },
    { id: 3, status: 'cancelada', faturada_em: '2026-11-10T10:00:00Z' },
  ];
  const itens = [
    { venda_id: 1, produto_id: 7, quantidade: 6, subtotal: 180 },
    { venda_id: 2, produto_id: 7, quantidade: 2, subtotal: 60 },
    { venda_id: 3, produto_id: 7, quantidade: 99, subtotal: 2970 },
  ];
  const agg = agregarTrends(vendas, itens, j);
  assert.equal(agg.atual.get(7)!.quantidade, 6);
  assert.equal(agg.anterior.get(7)!.quantidade, 2);
  assert.equal(agg.atual.get(7)!.receita, 180);
  assert.equal(Object.values(TREND_HUNTER_PESOS).reduce((a, b) => a + b, 0), 1);
});

test('06 — Trend Hunter recomenda sobre vendas reais, é idempotente e não altera operação', async () => {
  const p = await produto(1, `TH-${tag}`, 'Produto Tendência');
  const v1 = await venda(1, '2026-11-03', 60); await item(1, Number(v1.id), Number(p.id), 2);
  const v2 = await venda(1, '2026-11-09', 120); await item(1, Number(v2.id), Number(p.id), 4);
  const v3 = await venda(1, '2026-11-11', 90); await item(1, Number(v3.id), Number(p.id), 3);
  const estoqueAntes = (await s.list(RESOURCES.estoques, { page: 1, pageSize: 100, filter: { empresa_id: 1, produto_id: Number(p.id) } })).total;
  const body = { data_referencia: REF, janela_dias: 7 };
  const req = reqDe(body, { user: gerenteA, headers: { 'Idempotency-Key': `th-${tag}-0001` } });
  const out = await chamar(gerarTrendHunter, req, 201);
  assert.equal(out.total, 1);
  const r = out.recomendacoes[0];
  assert.equal(r.dominio, 'sales');
  assert.equal(r.modelo, 'trend-hunter-deterministico');
  assert.equal(r.status, 'pendente');
  assert.equal(Number(r.score), 0.626); // 0,45×1 + 0,30×(7/20) + 0,25×(2/7) ≈ 0,626
  assert.equal(r.evidencia.variacao_pct, 250);
  assert.equal(r.evidencia.descoberta_externa, false);
  assert.equal(r.evidencia.atual.quantidade, 7);
  assert.equal(r.evidencia.anterior.quantidade, 2);
  assert.ok(r.evidencia.formula && r.evidencia.fonte && r.evidencia.justificativa);
  const exec = await s.get(RESOURCES.ai_executions, out.execucao_id);
  assert.equal(Number(exec!.custo), 0);
  assert.equal(exec!.estado, 'sucesso');
  assert.equal(exec!.chave_idempotencia, `th-${tag}-0001`);
  const replay = await chamar(gerarTrendHunter, req, 200);
  assert.equal(replay.idempotente, true);
  assert.equal(replay.execucao_id, out.execucao_id);
  assert.deepEqual(replay.recomendacoes.map((x: any) => x.id), out.recomendacoes.map((x: any) => x.id));
  await esperarErro(() => chamar(gerarTrendHunter, reqDe({ ...body, janela_dias: 14 }, { user: gerenteA, headers: { 'Idempotency-Key': `th-${tag}-0001` } })), 409);
  await esperarErro(() => chamar(gerarTrendHunter, reqDe(body, { user: operadorA, headers: { 'Idempotency-Key': `th-${tag}-op` } })), 403);
  const estoqueDepois = (await s.list(RESOURCES.estoques, { page: 1, pageSize: 100, filter: { empresa_id: 1, produto_id: Number(p.id) } })).total;
  assert.equal(estoqueDepois, estoqueAntes);
});

test('06 — tenant A×B: mesma chave não colide e B não recebe tendência de A', async () => {
  await produto(2, `TH-B-${tag}`, 'Produto B sem histórico');
  const body = { data_referencia: REF, janela_dias: 7 };
  const outB = await chamar(gerarTrendHunter, reqDe(body, { user: gerenteB, headers: { 'Idempotency-Key': `th-${tag}-0001` } }), 201);
  assert.equal(outB.total, 0);
  const execsA = await s.list(RESOURCES.ai_executions, { page: 1, pageSize: 100, filter: { empresa_id: 1, chave_idempotencia: `th-${tag}-0001` } });
  const execsB = await s.list(RESOURCES.ai_executions, { page: 1, pageSize: 100, filter: { empresa_id: 2, chave_idempotencia: `th-${tag}-0001` } });
  assert.equal(execsA.total, 1);
  assert.equal(execsB.total, 1);
  assert.notEqual(execsA.rows[0].id, execsB.rows[0].id);
});

test('06 — orçamento mensal é enforcement real por provider; externo bloqueado', async () => {
  const provider = await s.insert(RESOURCES.ai_providers, { empresa_id: 1, nome: `Provider orçamento ${tag}`, tipo: 'heuristica', limite_mensal_custo: 10, ativo: true });
  // O store em memória carimba criado_em=agora; o recorte por mês UTC com datas
  // históricas é provado no gate PostgreSQL. Aqui o mês corrente basta.
  const mesAtual = new Date().toISOString().slice(0, 10);
  await s.insert(RESOURCES.ai_executions, { empresa_id: 1, provider_id: Number(provider.id), finalidade: 'custo-anterior', estado: 'sucesso', custo: 9.5 });
  assert.equal(await custoMesIA(1, Number(provider.id), mesAtual), 9.5);
  await assertOrcamentoIA(1, Number(provider.id), 0.5, mesAtual);
  await assert.rejects(() => assertOrcamentoIA(1, Number(provider.id), 0.51, mesAtual), (e: any) => e.status === 409);
  // Consumo já acima do limite bloqueia até execução determinística de custo 0.
  await s.insert(RESOURCES.ai_executions, { empresa_id: 1, provider_id: Number(provider.id), finalidade: 'custo-extra', estado: 'sucesso', custo: 1 });
  await esperarErro(() => chamar(gerarTrendHunter, reqDe({ data_referencia: mesAtual, janela_dias: 7, provider_id: Number(provider.id) }, { user: gerenteA, headers: { 'Idempotency-Key': `th-${tag}-budget` } })), 409);
  const externo = await s.insert(RESOURCES.ai_providers, { empresa_id: 1, nome: `Provider externo ${tag}`, tipo: 'externo', ativo: true });
  await esperarErro(() => chamar(gerarTrendHunter, reqDe({ data_referencia: REF, janela_dias: 7, provider_id: Number(externo.id) }, { user: gerenteA, headers: { 'Idempotency-Key': `th-${tag}-ext` } })), 409);
  assert.equal(hashPayloadIA({ b: 2, a: 1 }), hashPayloadIA({ a: 1, b: 2 }));
});
