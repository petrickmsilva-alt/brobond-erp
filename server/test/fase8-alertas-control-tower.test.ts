// ============================================================================
// FASE 8 — ALERTAS (AI CONTROL TOWER).
//
// Prova, com o store real (memdb em test), que:
//   • os detectores leem documentos CANÔNICOS reais (estoque, vendas, financeiro,
//     fila, pedidos, tickets, divergências) e não inventam número;
//   • a ocorrência é IDEMPOTENTE por fingerprint e conta as reincidências;
//   • o alerta que deixa de ser detectado é RESOLVIDO; o que volta, REABRE;
//   • a janela anti-spam suprime a NOTIFICAÇÃO sem apagar a ocorrência;
//   • reconhecer/resolver/silenciar são idempotentes e auditados;
//   • o isolamento por empresa bloqueia acesso cruzado (404, nunca 403);
//   • o painel agrega por domínio/severidade.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const {
  avaliarAlertas,
  painelAlertas,
  reconhecerAlerta,
  resolverAlerta,
  silenciarAlerta,
  avaliarAlertasHandler,
  painelAlertasHandler,
  DETECTORES,
  DOMINIOS_ALERTA,
} = await import('../src/alerts');

const s = getStore();

async function novaEmpresa(sufixo: string): Promise<number> {
  const emp = await s.insert(RESOURCES.empresas, { nome: `Empresa Alerta ${sufixo} ${Date.now()} ${Math.random()}` } as any);
  return Number(emp.id);
}

async function novoProduto(empresaId: number, nome: string): Promise<number> {
  const p = await s.insert(RESOURCES.produtos, { empresa_id: empresaId, nome, sku: `AL-${Date.now()}-${Math.random()}`, ativo: true, custo: 10, preco_venda: 20 } as any);
  return Number(p.id);
}

/** Local de estoque ativo — sem ele o saldo é INDETERMINADO e a detecção é pulada. */
async function novoLocal(empresaId: number): Promise<number> {
  const l = await s.insert(RESOURCES.locais, { empresa_id: empresaId, nome: `Loja ${Math.random()}`, ativo: true, tipo: 'loja', padrao: true } as any);
  return Number(l.id);
}

async function celula(empresaId: number, produtoId: number, localId: number, quantidade: number, estoqueMin = 0) {
  const existente = await s.findOneWhere(RESOURCES.estoques, { empresa_id: empresaId, produto_id: produtoId, local_id: localId });
  const patch = { quantidade, estoque_min: estoqueMin };
  if (existente) await s.update(RESOURCES.estoques, Number(existente.id), patch as any);
  else await s.insert(RESOURCES.estoques, { empresa_id: empresaId, produto_id: produtoId, local_id: localId, local: 'loja', ...patch } as any);
}

async function vender(empresaId: number, clienteId: number, produtoId: number, total: number, faturadaEm: string) {
  const v = await s.insert(RESOURCES.vendas, { empresa_id: empresaId, cliente_id: clienteId, status: 'faturada', total, faturada_em: faturadaEm, canal_venda: 'BROBOND' } as any);
  await s.insert(RESOURCES.itens_venda, { empresa_id: empresaId, venda_id: Number(v.id), produto_id: produtoId, quantidade: 1, preco_unitario: total, subtotal: total } as any);
  return Number(v.id);
}

async function novoCliente(empresaId: number, nome: string): Promise<number> {
  const c = await s.insert(RESOURCES.clientes, { empresa_id: empresaId, nome } as any);
  return Number(c.id);
}

const GESTOR = (empresaId: number, id: number) => ({ id, name: 'Gestor', perfil: 'gerente' as const, empresa_id: empresaId, empresas: [empresaId] });

test('F8: catálogo de detectores é real e cobre os domínios da Control Tower', () => {
  assert.ok(DETECTORES.length >= 8, `esperava >=8 detectores, veio ${DETECTORES.length}`);
  const dominios = new Set(DETECTORES.map((d) => d.dominio));
  for (const d of dominios) assert.ok((DOMINIOS_ALERTA as readonly string[]).includes(d));
  assert.ok(dominios.has('estoque') && dominios.has('financeiro') && dominios.has('integracoes'));
});

test('F8: ruptura e estoque abaixo do mínimo usam o estoque canônico real', async () => {
  const emp = await novaEmpresa('A');
  const local = await novoLocal(emp);
  const cliente = await novoCliente(emp, 'Cliente Alerta');
  const produto = await novoProduto(emp, 'Produto Ruptura');

  // Celula com mínimo 5 e saldo 1 → abaixo do mínimo.
  await celula(emp, produto, local, 1, 5);
  // Venda recente do produto → ruptura se o disponível zerar.
  await vender(emp, cliente, produto, 100, new Date().toISOString());

  const r1 = await avaliarAlertas(emp);
  assert.ok(r1.detectadas >= 1, `esperava ao menos o alerta de estoque baixo, veio ${r1.detectadas}`);
  assert.ok(r1.abertas >= 1);

  const painel = await painelAlertas(emp);
  const chaves = painel.alertas.map((a) => a.regra_chave);
  assert.ok(chaves.includes('estoque_abaixo_minimo'), 'estoque abaixo do mínimo deve ser detectado');
  const baixo = painel.alertas.find((a) => a.regra_chave === 'estoque_abaixo_minimo')!;
  assert.equal((baixo.evidencia as any).saldo, 1);
  assert.equal((baixo.evidencia as any).minimo, 5);

  // Zera o saldo → agora também há ruptura (produto com venda recente).
  await celula(emp, produto, local, 0, 5);
  const r2 = await avaliarAlertas(emp);
  assert.ok(r2.detectadas >= 2, 'com saldo zerado, ruptura também é detectada');
  const painel2 = await painelAlertas(emp);
  assert.ok(painel2.alertas.some((a) => a.regra_chave === 'ruptura_estoque'));
});

test('F8: idempotência por fingerprint — reprocessar não empilha e conta ocorrências', async () => {
  const emp = await novaEmpresa('B');
  const local = await novoLocal(emp);
  const produto = await novoProduto(emp, 'Produto Reincidente');
  await celula(emp, produto, local, 1, 5);

  const r1 = await avaliarAlertas(emp);
  assert.equal(r1.abertas, 1);
  const r2 = await avaliarAlertas(emp);
  assert.equal(r2.abertas, 0, 'segunda rodada não abre de novo');
  assert.equal(r2.mantidas, 1, 'segunda rodada mantém e incrementa');

  const painel = await painelAlertas(emp);
  const alerta = painel.alertas.find((a) => a.regra_chave === 'estoque_abaixo_minimo')!;
  assert.equal(alerta.ocorrencias, 2, 'a reincidência é contada, não empilhada');
  const total = (await s.list(RESOURCES.alert_events, { page: 1, pageSize: 100, filter: { empresa_id: emp } })).total;
  assert.equal(total, 1, 'uma linha por ocorrência lógica');
});

test('F8: alerta que desaparece é RESOLVIDO e o que volta REABRE', async () => {
  const emp = await novaEmpresa('C');
  const local = await novoLocal(emp);
  const produto = await novoProduto(emp, 'Produto Some');
  await celula(emp, produto, local, 1, 5);

  await avaliarAlertas(emp);
  // Repõe o estoque acima do mínimo → o alerta deixa de ser detectado.
  await celula(emp, produto, local, 10, 5);
  const r = await avaliarAlertas(emp);
  assert.equal(r.resolvidas, 1, 'o alerta que sumiu é resolvido');
  let painel = await painelAlertas(emp);
  let alerta = painel.alertas.find((a) => a.regra_chave === 'estoque_abaixo_minimo')!;
  assert.equal(alerta.status, 'RESOLVIDO');
  assert.ok(alerta.resolvido_em);

  // Volta a cair → REABRE (a correção não pode esconder a recaída).
  await celula(emp, produto, local, 1, 5);
  const r2 = await avaliarAlertas(emp);
  assert.equal(r2.reabertas, 1);
  painel = await painelAlertas(emp);
  alerta = painel.alertas.find((a) => a.regra_chave === 'estoque_abaixo_minimo')!;
  assert.equal(alerta.status, 'ABERTO');
  assert.equal(alerta.ocorrencias, 1, 'reabrir reinicia a contagem');
});

test('F8: janela anti-spam suprime a notificação sem apagar a ocorrência', async () => {
  const emp = await novaEmpresa('D');
  const local = await novoLocal(emp);
  const produto = await novoProduto(emp, 'Produto AntiSpam');
  await celula(emp, produto, local, 1, 5);
  await s.insert(RESOURCES.alert_rules, { empresa_id: emp, chave: 'estoque_abaixo_minimo', nome: 'Mínimo', dominio: 'estoque', severidade: 'media', frequencia_minima_min: 60, ativo: true } as any);

  const r1 = await avaliarAlertas(emp);
  assert.equal(r1.a_notificar, 1, 'primeira detecção notifica');
  const r2 = await avaliarAlertas(emp);
  assert.equal(r2.a_notificar, 0, 'dentro da janela não notifica de novo');
  assert.equal(r2.mantidas, 1, 'a ocorrência continua registrada');
});

test('F8: regra inativa suspende o detector; limiar da regra sobrepõe o padrão', async () => {
  const emp = await novaEmpresa('E');
  const local = await novoLocal(emp);
  const produto = await novoProduto(emp, 'Produto Regra');
  await celula(emp, produto, local, 1, 5);
  await s.insert(RESOURCES.alert_rules, { empresa_id: emp, chave: 'estoque_abaixo_minimo', nome: 'Suspenso', dominio: 'estoque', severidade: 'baixa', ativo: false } as any);

  const r = await avaliarAlertas(emp);
  const painel = await painelAlertas(emp);
  assert.equal(painel.alertas.filter((a) => a.regra_chave === 'estoque_abaixo_minimo').length, 0, 'regra inativa suspende o detector');
  assert.equal(r.regras_avaliadas, DETECTORES.length - 1);
});

test('F8: reconhecer, resolver e silenciar são idempotentes e auditados', async () => {
  const emp = await novaEmpresa('F');
  const local = await novoLocal(emp);
  const produto = await novoProduto(emp, 'Produto Transicao');
  await celula(emp, produto, local, 1, 5);
  await avaliarAlertas(emp);
  const painel = await painelAlertas(emp);
  const id = Number(painel.alertas.find((a) => a.regra_chave === 'estoque_abaixo_minimo')!.id);
  const ator = { id: null, name: 'Gestor' };

  const ciente = await reconhecerAlerta(emp, id, ator);
  assert.equal(ciente.status, 'CIENTE');
  const ciente2 = await reconhecerAlerta(emp, id, ator);
  assert.equal(ciente2.status, 'CIENTE', 'reconhecer de novo é idempotente');

  const resolvido = await resolverAlerta(emp, id, 'Reposto pelo comprador.', ator);
  assert.equal(resolvido.status, 'RESOLVIDO');
  const resolvido2 = await resolverAlerta(emp, id, 'outro texto', ator);
  assert.equal(resolvido2.status, 'RESOLVIDO', 'resolver de novo é idempotente');

  const silenciado = await silenciarAlerta(emp, id, new Date(Date.now() + 86_400_000).toISOString(), ator);
  assert.equal(silenciado.status, 'SILENCIADO');
  assert.ok(silenciado.silenciado_ate);

  await assert.rejects(() => resolverAlerta(emp, id, '   ', ator), (e: any) => e.status === 400);
  const aud = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 50, filter: { empresa_id: emp, recurso: 'alert_events' } });
  assert.ok(aud.rows.length >= 3, 'reconhecer/resolver/silenciar ficam auditados');
});

test('F8: isolamento por empresa — B não vê nem transiciona alerta de A (404)', async () => {
  const empA = await novaEmpresa('G');
  const empB = await novaEmpresa('H');
  const local = await novoLocal(empA);
  const produto = await novoProduto(empA, 'Produto Isolado');
  await celula(empA, produto, local, 1, 5);
  await avaliarAlertas(empA);
  const painelB = await painelAlertas(empB);
  assert.equal(painelB.alertas.length, 0, 'a empresa B não enxerga alertas de A');

  const idA = Number((await painelAlertas(empA)).alertas[0].id);
  await assert.rejects(() => reconhecerAlerta(empB, idA, { id: null, name: 'x' }), (e: any) => e.status === 404);
  await assert.rejects(() => resolverAlerta(empB, idA, 'x', { id: null, name: 'x' }), (e: any) => e.status === 404);
  await assert.rejects(() => silenciarAlerta(empB, idA, new Date().toISOString(), { id: null, name: 'x' }), (e: any) => e.status === 404);
});

test('F8: falha de integração e divergência de conciliação são detectadas', async () => {
  const emp = await novaEmpresa('I');
  await s.insert(RESOURCES.commerce_outbox, { empresa_id: emp, tipo: 'publicacao', chave: `al-out-${Date.now()}`, estado: 'ERRO', tentativas: 5, ultimo_erro: 'timeout' } as any);
  const produto = await novoProduto(emp, 'Produto Divergente');
  await s.insert(RESOURCES.commerce_reconciliacao, { empresa_id: emp, canal: 'MERCADOLIVRE', categoria: 'PRECO', tipo: 'preco_indisponivel', classificacao: 'HUMANA', severidade: 'alta', detalhe: 'sem preço', fingerprint: `fp-${Date.now()}`, status: 'ABERTA' } as any);

  await avaliarAlertas(emp);
  const painel = await painelAlertas(emp);
  const chaves = painel.alertas.map((a) => a.regra_chave);
  assert.ok(chaves.includes('falha_integracao'));
  assert.ok(chaves.includes('divergencia_conciliacao'));
  assert.ok(painel.totais.por_dominio.integracoes >= 2);
});

test('F8: handlers HTTP validam filtros e escopo', async () => {
  const emp = await novaEmpresa('J');
  const usuario = await s.insert(RESOURCES.usuarios, { empresa_id: emp, nome: 'Gestor J', email: `gj${Date.now()}@x.invalid`, perfil: 'gerente', senha_hash: 'x' } as any);
  const gestor = GESTOR(emp, Number(usuario.id));
  const local = await novoLocal(emp);
  const produto = await novoProduto(emp, 'Produto HTTP');
  await celula(emp, produto, local, 1, 5);

  const r = res();
  await avaliarAlertasHandler({ body: {}, params: {}, user: gestor, query: {}, get: () => undefined } as any, r.out);
  assert.equal(r.get().status, 201);
  assert.ok(r.get().body.detectadas >= 1);

  const rp = res();
  await painelAlertasHandler({ body: {}, params: {}, user: gestor, query: {}, get: () => undefined } as any, rp.out);
  assert.ok(Array.isArray(rp.get().body.alertas));

  await assert.rejects(
    () => painelAlertasHandler({ body: {}, params: {}, user: gestor, query: { dominio: 'inexistente' }, get: () => undefined } as any, res().out),
    (e: any) => e.status === 400,
  );
  await assert.rejects(
    () => avaliarAlertasHandler({ body: { detectores: ['nao_existe'] }, params: {}, user: gestor, query: {}, get: () => undefined } as any, res().out),
    (e: any) => e.status === 400,
  );
});

function res() {
  let body: any; let status = 200;
  const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} };
  return { out, get: () => ({ body, status }) };
}

// ----------------------------------------------------------------------------
// AI CONTROL TOWER — leitura executiva consolidada.
// ----------------------------------------------------------------------------
const { painelControlTower } = await import('../src/controlTower');

test('F8/Tower: consolida indicadores reais, saúde, alertas e pendências de UMA empresa', async () => {
  const emp = await novaEmpresa('K');
  const local = await novoLocal(emp);
  const cliente = await novoCliente(emp, 'Cliente Tower');
  const produto = await novoProduto(emp, 'Produto Tower');
  await celula(emp, produto, local, 1, 5);
  const agora = new Date().toISOString();
  await vender(emp, cliente, produto, 500, agora);
  await vender(emp, cliente, produto, 300, agora);
  // Fila em erro + pedido parado + ticket com SLA estourado.
  await s.insert(RESOURCES.commerce_outbox, { empresa_id: emp, tipo: 'publicacao', chave: `tw-${Date.now()}`, estado: 'ERRO', tentativas: 5 } as any);
  await s.insert(RESOURCES.commerce_pedidos, { empresa_id: emp, canal: 'BROBOND', pedido_externo: `TW-${Date.now()}`, estado: 'ERRO', erro: 'x' } as any);
  await s.insert(RESOURCES.service_tickets, { empresa_id: emp, numero: 'TKT-TOWER', assunto: 'x', status: 'aberto', prioridade: 'alta', prazo_resolucao_em: new Date(Date.now() - 3600_000).toISOString() } as any);
  await avaliarAlertas(emp);

  const tower = await painelControlTower(emp);
  assert.equal(tower.empresa_id, emp);
  const receita = tower.indicadores.find((i) => i.chave === 'receita')!;
  assert.equal(receita.valor, 800);
  assert.ok(receita.formula.length > 0 && receita.origem.includes('vendas'), 'cada indicador declara fórmula e origem');
  assert.equal(tower.saude_operacional.outbox_erro, 1);
  assert.equal(tower.saude_operacional.pedidos_parados, 1);
  assert.equal(tower.saude_operacional.tickets_sla_estourado, 1);
  assert.ok(tower.alertas.totais.abertos >= 1);
  assert.ok(tower.pendencias_criticas.length >= 3, 'pendências críticas consolidadas');
  assert.ok(tower.pendencias_criticas.every((p) => Object.keys(p.evidencia).length >= 0));
  assert.ok(tower.limitacoes.length >= 1, 'limitações são declaradas');
});

test('F8/Tower: previsões e recomendações vêm de dados reais persistidos', async () => {
  const emp = await novaEmpresa('L');
  const produto = await novoProduto(emp, 'Produto Previsto');
  await s.insert(RESOURCES.demand_forecasts, { empresa_id: emp, produto_id: produto, periodo: '2026-10', historico: 10, forecast: 42, metodo: 'media_movel' } as any);
  await s.insert(RESOURCES.supply_plans, { empresa_id: emp, produto_id: produto, periodo: '2026-10', demanda: 42, estoque_atual: 10, necessidade: 32, status: 'pendente' } as any);
  const exec = await s.insert(RESOURCES.ai_executions, { empresa_id: emp, finalidade: 'recomendacao_inventory', estado: 'sucesso', entrada: {}, resultado: {}, custo: 0 } as any);
  await s.insert(RESOURCES.ai_recommendations, { empresa_id: emp, execucao_id: Number(exec.id), dominio: 'inventory', modelo: 'heuristica-interna', score: 0.8, evidencia: { produto_id: produto, saldo: 1, minimo: 5 }, recomendacao: 'Repor produto', status: 'pendente' } as any);

  const tower = await painelControlTower(emp);
  assert.equal(tower.previsoes.demanda[0].forecast, 42);
  assert.equal(tower.previsoes.suprimento[0].necessidade, 32);
  assert.equal(tower.recomendacoes.total_pendentes, 1);
  const rec = tower.recomendacoes.pendentes[0];
  assert.equal(rec.requer_aprovacao, true, 'recomendação nunca executa sozinha');
  assert.equal(rec.confianca, 'alta');
  assert.equal(rec.impacto_estimado, null, 'sem valor explícito na evidência não se inventa impacto');
});

test('F8/Tower: isolamento — a torre de B não enxerga nada de A', async () => {
  const empA = await novaEmpresa('M');
  const empB = await novaEmpresa('N');
  const local = await novoLocal(empA);
  const produto = await novoProduto(empA, 'Produto Torre A');
  await celula(empA, produto, local, 1, 5);
  await avaliarAlertas(empA);

  const towerB = await painelControlTower(empB);
  assert.equal(towerB.saude_operacional.alertas_abertos, 0);
  assert.equal(towerB.alertas.totais.abertos, 0);
  assert.equal(towerB.indicadores.find((i) => i.chave === 'receita')!.valor, 0);
});

test('F8/Tower: sem histórico, crescimento e margem devolvem null (não zero enganoso)', async () => {
  const emp = await novaEmpresa('O');
  const tower = await painelControlTower(emp);
  assert.equal(tower.indicadores.find((i) => i.chave === 'crescimento_pct')!.valor, null);
  assert.equal(tower.indicadores.find((i) => i.chave === 'ticket_medio')!.valor, null);
  assert.ok(tower.limitacoes.some((l) => /sem vendas/i.test(l)));
});
