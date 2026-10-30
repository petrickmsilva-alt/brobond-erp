// ============================================================================
// ONDAS 4–5 / D2–D7 — GROWTH, DATA/BI, AI, DEMAND/SUPPLY, WMS/TMS, EPM.
//
// Prova, com o store real (memdb em test), que:
//   • marketing automation dispara de forma idempotente e respeita consentimento;
//   • loyalty mantém saldo = soma dos movimentos (sem crédito duplicado);
//   • affiliate só gera comissão com atribuição real e não duplica;
//   • BI reconstruído carrega empresa/origem/período/dimensão/métrica;
//   • IA recomenda com evidência e não altera nada operacional;
//   • demanda → suprimento encadeia sem inventar número;
//   • EPM calcula variance do realizado real;
//   • o isolamento por empresa bloqueia acesso cruzado (Empresa A × B).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const {
  dispararAutomacao,
  creditarPontosVenda,
  saldoFidelidade,
  apurarComissaoAfiliado,
  pagarComissaoAfiliado,
  roiCampanha,
  reconstruirBi,
  painelBi,
  gerarRecomendacoes,
  decidirRecomendacao,
  gerarForecastDemanda,
  gerarPlanoSuprimento,
  aprovarSop,
  calcularScorecardFornecedor,
  varianceEpm,
  forecastCenario,
} = await import('../src/enterprise45');

const s = getStore();
const uGerenteA = await s.insert(RESOURCES.usuarios, { empresa_id: 1, nome: 'Gerente A', email: 'ga45@x.invalid', perfil: 'gerente', senha_hash: 'x' });
const uGerenteB = await s.insert(RESOURCES.usuarios, { empresa_id: 2, nome: 'Gerente B', email: 'gb45@x.invalid', perfil: 'gerente', senha_hash: 'x' });
const uOperadorA = await s.insert(RESOURCES.usuarios, { empresa_id: 1, nome: 'Operador A', email: 'oa45@x.invalid', perfil: 'operador', senha_hash: 'x' });

const GERENTE_A = { id: Number(uGerenteA.id), name: 'Gerente A', perfil: 'gerente' as const, empresa_id: 1, empresas: [1] };
const GERENTE_B = { id: Number(uGerenteB.id), name: 'Gerente B', perfil: 'gerente' as const, empresa_id: 2, empresas: [2] };
const OPERADOR_A = { id: Number(uOperadorA.id), name: 'Operador A', perfil: 'operador' as const, empresa_id: 1, empresas: [1] };

function req(body: object = {}, params: object = {}, user: any = GERENTE_A, query: object = {}, key = 'idem-key-0001') {
  return { body, params, user, query, get: (h: string) => (h === 'Idempotency-Key' ? key : undefined) } as any;
}
function res() {
  let body: any; let status = 200;
  const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} };
  return { out, get: () => ({ body, status }) };
}
async function call(handler: any, body: object = {}, params: object = {}, user: any = GERENTE_A, query: object = {}, key = 'idem-key-0001') {
  const r = res();
  await handler(req(body, params, user, query, key), r.out);
  return r.get().body;
}

/** Semeia cliente, produto, venda faturada e estoque para a empresa 1 (uma vez). */
let seedA: { clienteId: number; produtoId: number; vendaId: number; localId: number } | null = null;
async function semearEmpresaA() {
  if (seedA) return seedA;
  const s = getStore();
  const cliente = await s.insert(RESOURCES.clientes, { empresa_id: 1, nome: 'Cliente 45' });
  const produto = await s.insert(RESOURCES.produtos, { empresa_id: 1, nome: 'Produto 45', sku: `SKU45-${Date.now()}`, custo: 60 });
  const local = await s.insert(RESOURCES.locais, { empresa_id: 1, nome: 'Depósito 45' });
  const venda = await s.insert(RESOURCES.vendas, { empresa_id: 1, cliente_id: Number(cliente.id), status: 'faturada', total: 1000, canal: 'BROBOND', faturada_em: '2026-03-15T00:00:00.000Z' });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(produto.id), quantidade: 10, preco_unitario: 100, subtotal: 1000 });
  await s.insert(RESOURCES.estoques, { empresa_id: 1, produto_id: Number(produto.id), local_id: Number(local.id), quantidade: 5, custo_medio: 60 });
  seedA = { clienteId: Number(cliente.id), produtoId: Number(produto.id), vendaId: Number(venda.id), localId: Number(local.id) };
  return seedA;
}

test('D2: loyalty credita pontos por venda e mantém saldo = soma dos movimentos', async () => {
  const { clienteId, vendaId } = await semearEmpresaA();
  const prog = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 1, nome: `Programa ${Date.now()}`, pontos_por_real: 2, ativo: true });
  const m1 = await call(creditarPontosVenda, { programa_id: Number(prog.id), cliente_id: clienteId, venda_id: vendaId });
  assert.equal(m1.pontos, 2000);
  // Reexecutar a mesma venda NÃO duplica o crédito (idempotente por chave).
  const m2 = await call(creditarPontosVenda, { programa_id: Number(prog.id), cliente_id: clienteId, venda_id: vendaId });
  assert.equal(Number(m2.id), Number(m1.id));
  const saldo = await call(saldoFidelidade, {}, { clienteId });
  const doPrograma = saldo.programas.find((p: any) => p.programa_id === Number(prog.id));
  assert.equal(doPrograma.saldo, 2000);
  assert.equal(doPrograma.movimentos, 1);
});

test('D2: marketing automation dispara idempotente e bloqueia sem consentimento', async () => {
  const { clienteId } = await semearEmpresaA();
  const auto = await s.insert(RESOURCES.marketing_automations, {
    empresa_id: 1, nome: `Auto ${Date.now()}`, trigger_tipo: 'pedido_pago', acao_tipo: 'enviar_mensagem', canal: 'email', ativo: true, condicao: {},
  });
  // Sem consentimento de marketing → bloqueia.
  await assert.rejects(() => call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }), (e: any) => e.status === 409);
  await s.insert(RESOURCES.customer_consents, { empresa_id: 1, cliente_id: clienteId, finalidade: 'marketing', concedido: true });
  const r1 = await call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }, GERENTE_A, {}, 'auto-run-key-1');
  assert.equal(r1.idempotente, false);
  // Mesma chave → não gera segunda execução.
  const r2 = await call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }, GERENTE_A, {}, 'auto-run-key-1');
  assert.equal(r2.idempotente, true);
  assert.equal(Number(r2.run.id), Number(r1.run.id));
});

test('D2: affiliate só apura comissão com atribuição real e não duplica', async () => {
  const { vendaId } = await semearEmpresaA();
  const creator = await s.insert(RESOURCES.creator_profiles, { empresa_id: 1, name: 'Creator X', platform: 'INSTAGRAM', handle: `cx${Date.now()}`, status: 'ACTIVE' });
  const brief = await s.insert(RESOURCES.creator_campaigns, { empresa_id: 1, name: 'Briefing X', objective: 'Aumentar vendas do canal', starts_on: '2026-03-01', ends_on: '2026-03-31', status: 'ACTIVE' });
  const camp = await s.insert(RESOURCES.crm_campanhas, { empresa_id: 1, nome: `Campanha Growth ${Date.now()}`, ativo: true, custo: 200 });
  const parc = await s.insert(RESOURCES.creator_partnerships, { empresa_id: 1, creator_id: Number(creator.id), campaign_id: Number(brief.id), crm_campanha_id: Number(camp.id), status: 'ACTIVE' });
  // Sem atribuição → bloqueia.
  await assert.rejects(() => call(apurarComissaoAfiliado, { percentual: 10 }, { partnershipId: Number(parc.id) }), (e: any) => e.status === 409);
  await s.insert(RESOURCES.creator_attributions, { empresa_id: 1, partnership_id: Number(parc.id), order_id: vendaId });
  const r1 = await call(apurarComissaoAfiliado, { percentual: 10 }, { partnershipId: Number(parc.id) });
  assert.equal(r1.comissoes.length, 1);
  assert.equal(Number(r1.comissoes[0].valor), 100);
  // Repetir não duplica (chave parceria+atribuição).
  const r2 = await call(apurarComissaoAfiliado, { percentual: 10 }, { partnershipId: Number(parc.id) });
  assert.equal(r2.comissoes.length, 1);
  assert.equal(Number(r2.comissoes[0].id), Number(r1.comissoes[0].id));
  // Pagar encaminha ao financeiro EXISTENTE e é idempotente.
  const p1 = await call(pagarComissaoAfiliado, {}, { id: Number(r1.comissoes[0].id) });
  assert.ok(p1.lancamento_id);
  const p2 = await call(pagarComissaoAfiliado, {}, { id: Number(r1.comissoes[0].id) });
  assert.equal(p2.idempotente, true);
  // ROI da campanha usa custo e receita reais.
  const roi = await call(roiCampanha, {}, { id: Number(camp.id) });
  assert.equal(roi.receita_atribuida, 1000);
  assert.ok(roi.roas !== null);
});

test('D3: BI reconstruído carrega empresa/origem/período/dimensão/métrica', async () => {
  await semearEmpresaA();
  const out = await call(reconstruirBi, { periodo: '2026-03' });
  assert.ok(out.linhas >= 3);
  const receita = out.projecoes.find((p: any) => p.metrica === 'receita' && p.dimensao === 'total');
  assert.equal(Number(receita.valor), 1000);
  assert.equal(receita.periodo, '2026-03');
  assert.equal(receita.origem, 'vendas');
  assert.equal(Number(receita.empresa_id), 1);
  assert.ok(receita.gerado_em);
  const painel = await call(painelBi, {}, {}, GERENTE_A, { periodo: '2026-03' });
  assert.equal(painel.receita, 1000);
  assert.equal(painel.cmv, 600);
  assert.equal(painel.margem, 400);
});

test('D4: IA recomenda com evidência e não altera nada operacional', async () => {
  const { produtoId } = await semearEmpresaA();
  // Mínimo acima do saldo real (5) na linha de estoque → recomendação de reposição.
  const est = await s.list(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { empresa_id: 1, produto_id: produtoId } });
  await s.update(RESOURCES.estoques, Number(est.rows[0].id), { estoque_min: 20 });
  const out = await call(gerarRecomendacoes, { dominio: 'inventory' });
  assert.ok(out.total >= 1);
  const rec = out.recomendacoes.find((r: any) => Number(r.evidencia.produto_id) === produtoId);
  assert.ok(rec, 'deve recomendar o produto abaixo do mínimo');
  assert.ok(rec.evidencia.minimo === 20 && rec.evidencia.saldo === 5);
  assert.equal(rec.status, 'pendente');
  // A recomendação NÃO alterou estoque.
  const estDepois = await s.list(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { empresa_id: 1, produto_id: produtoId } });
  assert.equal(Number(estDepois.rows[0].quantidade), 5);
  const decidida = await call(decidirRecomendacao, { status: 'aceita' }, { id: Number(rec.id) });
  assert.equal(decidida.status, 'aceita');
  assert.ok(decidida.decidido_em);
});

test('D5: demanda → suprimento encadeia sem inventar número', async () => {
  const { produtoId } = await semearEmpresaA();
  const fc = await call(gerarForecastDemanda, { periodo: '2026-03' });
  assert.ok(fc.linhas >= 1);
  const linha = fc.forecasts.find((f: any) => Number(f.produto_id) === produtoId);
  assert.ok(linha);
  assert.equal(Number(linha.historico), 10);
  const sup = await call(gerarPlanoSuprimento, { periodo: '2026-03' });
  const plano = sup.planos.find((p: any) => Number(p.produto_id) === produtoId);
  assert.ok(plano);
  assert.equal(Number(plano.estoque_atual), 5);
  assert.equal(Number(plano.necessidade), Math.max(0, Number(linha.forecast) - 5));
  assert.equal(plano.status, 'planejado');
  // Aprovar cenário S&OP registra autor.
  const cenario = await s.insert(RESOURCES.sop_scenarios, { empresa_id: 1, nome: `Cenário ${Date.now()}`, periodo: '2026-03', demanda_total: 10, capacidade_total: 8, impacto_financeiro: 0 });
  const ap = await call(aprovarSop, {}, { id: Number(cenario.id) });
  assert.equal(ap.status, 'aprovado');
  assert.equal(Number(ap.aprovado_por), Number(GERENTE_A.id));
});

test('D6: scorecard de fornecedor deriva OTIF dos documentos reais', async () => {
  const fornecedor = await s.insert(RESOURCES.fornecedores, { empresa_id: 1, nome: `Fornecedor ${Date.now()}` });
  await s.insert(RESOURCES.compras, { empresa_id: 1, fornecedor_id: Number(fornecedor.id), status: 'recebida', data: '2026-03-05' });
  const sc = await call(calcularScorecardFornecedor, { periodo: '2026-03' }, { fornecedorId: Number(fornecedor.id) });
  assert.equal(sc.periodo, '2026-03');
  assert.ok(Number(sc.otif_pct) >= 0 && Number(sc.otif_pct) <= 100);
});

test('D7: EPM calcula variance do realizado real e o forecast do cenário', async () => {
  const { clienteId } = await semearEmpresaA();
  const conta = await s.insert(RESOURCES.plano_contas, { empresa_id: 1, nome: `Conta ${Date.now()}`, codigo: `1.${Date.now()}`, natureza: 'despesa' });
  const categoria = await s.insert(RESOURCES.categorias_financeiras, { nome: `Cat ${Date.now()}`, tipo: 'despesa', ativo: true });
  const bud = await s.insert(RESOURCES.epm_budgets, { empresa_id: 1, nome: `Orçamento ${Date.now()}`, periodo: '2026-03', conta_id: Number(conta.id), categoria_financeira_id: Number(categoria.id), valor_orcado: 800, status: 'aprovado' });
  await s.insert(RESOURCES.lancamentos_financeiros, { data: '2026-03-10', tipo: 'despesa', descricao: 'Despesa real', valor: 500, categoria_id: Number(categoria.id), status: 'confirmado' });
  const v = await call(varianceEpm, {}, {}, GERENTE_A, { periodo: '2026-03' });
  const linha = v.linhas.find((l: any) => Number(l.orcamento_id) === Number(bud.id));
  assert.ok(linha);
  assert.equal(linha.orcado, 800);
  assert.equal(linha.realizado, 500);
  assert.equal(linha.variacao, -300);
  // Forecast do cenário usa o realizado real (venda de 1000) e a premissa.
  const cen = await s.insert(RESOURCES.epm_scenarios, { empresa_id: 1, nome: `Cenário EPM ${Date.now()}`, periodo: '2026-03', premissas: { crescimento_pct: 10, custo_pct: 40 } });
  const f = await call(forecastCenario, {}, { id: Number(cen.id) });
  assert.equal(f.realizado, 1000);
  assert.equal(f.receita_projetada, 1100);
  assert.equal(f.custo_projetado, 440);
  void clienteId;
});

test('D2–D7: isolamento por empresa bloqueia acesso cruzado (A × B)', async () => {
  const { clienteId } = await semearEmpresaA();
  const progA = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 1, nome: `Prog A ${Date.now()}`, pontos_por_real: 1 });
  const progB = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 2, nome: `Prog B ${Date.now()}`, pontos_por_real: 1 });
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente B 45' });
  // Empresa B não usa o programa da empresa A nem o cliente da empresa A.
  await assert.rejects(() => call(creditarPontosVenda, { programa_id: Number(progA.id), cliente_id: Number(clienteB.id) }, {}, GERENTE_B), (e: any) => e.status === 404);
  await assert.rejects(() => call(creditarPontosVenda, { programa_id: Number(progB.id), cliente_id: clienteId }, {}, GERENTE_B), (e: any) => e.status === 404);
  // Operador sem alçada não gera recomendação de IA (minPerfil gerente).
  await assert.rejects(() => call(gerarRecomendacoes, { dominio: 'inventory' }, {}, OPERADOR_A), (e: any) => e.status === 403);
});
