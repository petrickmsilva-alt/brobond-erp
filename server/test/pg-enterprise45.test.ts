// ============================================================================
// ONDAS 4–5 contra Postgres REAL — D2–D7 sobre a cadeia versionada (0093).
//
// Só se prova aqui o que o memdb não tem: CHECK de domínio, FK real, UNIQUE
// composto por empresa e o efeito de uma transação serializável de verdade.
// O caminho de negócio (saldo de pontos, atribuição→comissão, forecast→plano,
// variance do realizado) é exercitado com o store real.
//
// Roda no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula.
// O pool é singleton de módulo — não fechar aqui.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const SUFIXO = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

type Ctx = Awaited<ReturnType<typeof cenario>>;

async function q<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { query } = await import('../src/db');
  return (await query(sql, params)).rows as T[];
}

async function cenario(tag: string) {
  const { migrate } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const { escopoDoAtor } = await import('../src/empresa');
  const s = getStore();
  seq++;
  const empresa = await s.insert(RESOURCES.empresas, { nome: `Empresa ${tag} ${seq} ${SUFIXO}`, ativo: true });
  const empresaId = Number(empresa.id);
  const usuario = await s.insert(RESOURCES.usuarios, {
    nome: `Admin ${tag} ${seq}`, email: `w45-${tag}-${seq}-${SUFIXO}@brobond.test`, perfil: 'admin', empresa_id: empresaId, ativo: true,
  });
  const actor = { id: Number(usuario.id), name: String(usuario.nome), perfil: 'admin' as const, empresa_id: empresaId, empresas: [empresaId] };
  return { RESOURCES, s, empresaId, actor, escopo: escopoDoAtor(actor) };
}

async function chamar(handler: any, ctx: Ctx, body: object = {}, params: object = {}, key = 'k', query: object = {}) {
  const { reqDe, resFake } = await import('./_p1util');
  const { res, saida } = resFake();
  await handler(reqDe(body, { params, query, user: ctx.actor as any, headers: { 'idempotency-key': key } }), res);
  return saida;
}

// ---------------------------------------------------------------------------
// 1) A cadeia versionada 0093 está aplicada e as tabelas são isoladas por empresa
// ---------------------------------------------------------------------------
test('pg W45: as tabelas das ondas 4–5 existem com empresa_id NOT NULL', { skip }, async () => {
  await cenario('tabs');
  const linhas = await q<{ table_name: string; is_nullable: string }>(
    `SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND column_name='empresa_id'
        AND table_name IN ('marketing_automations','marketing_automation_runs','loyalty_programs','loyalty_tiers','loyalty_movements',
          'affiliate_commissions','creator_matches','creator_outreach','bi_read_models','ai_providers','ai_prompts','ai_executions',
          'ai_recommendations','demand_forecasts','supply_plans','sop_scenarios','envio_ocorrencias','fornecedor_scorecards',
          'epm_budgets','epm_scenarios','epm_assets','epm_projects','epm_project_tasks')
      ORDER BY table_name`
  );
  assert.equal(linhas.length, 23, `esperava 23 tabelas com empresa_id; veio ${linhas.length}`);
  for (const l of linhas) assert.equal(l.is_nullable, 'NO', `${l.table_name}.empresa_id deveria ser NOT NULL`);
});

test('pg W45: CHECK de domínio recusa estado inválido (defesa em profundidade)', { skip }, async () => {
  const ctx = await cenario('chk');
  const programa = await ctx.s.insert(ctx.RESOURCES.loyalty_programs, { empresa_id: ctx.empresaId, nome: `Prog ${SUFIXO}`, pontos_por_real: 1, ativo: true });
  const cliente = await ctx.s.insert(ctx.RESOURCES.clientes, { empresa_id: ctx.empresaId, nome: `Cli ${SUFIXO}` });
  await assert.rejects(
    () => q(`INSERT INTO loyalty_movements (empresa_id, programa_id, cliente_id, tipo, pontos, chave_idempotencia) VALUES ($1,$2,$3,'tipo_invalido',10,$4)`,
      [ctx.empresaId, Number(programa.id), Number(cliente.id), `chk-${SUFIXO}`]),
    /loyalty_movements_tipo_valido|check/i
  );
  // pontos = 0 também é barrado pelo CHECK de domínio.
  await assert.rejects(
    () => q(`INSERT INTO loyalty_movements (empresa_id, programa_id, cliente_id, tipo, pontos, chave_idempotencia) VALUES ($1,$2,$3,'credito',0,$4)`,
      [ctx.empresaId, Number(programa.id), Number(cliente.id), `chk0-${SUFIXO}`]),
    /loyalty_movements_pontos_validos|check/i
  );
});

test('pg W45: UNIQUE (empresa_id, chave_idempotencia) impede crédito duplicado', { skip }, async () => {
  const ctx = await cenario('idem');
  const programa = await ctx.s.insert(ctx.RESOURCES.loyalty_programs, { empresa_id: ctx.empresaId, nome: `Prog ${SUFIXO}`, pontos_por_real: 1, ativo: true });
  const cliente = await ctx.s.insert(ctx.RESOURCES.clientes, { empresa_id: ctx.empresaId, nome: `Cli ${SUFIXO}` });
  const chave = `venda-1-${cliente.id}-${programa.id}`;
  await q(`INSERT INTO loyalty_movements (empresa_id, programa_id, cliente_id, tipo, pontos, chave_idempotencia) VALUES ($1,$2,$3,'credito',100,$4)`,
    [ctx.empresaId, Number(programa.id), Number(cliente.id), chave]);
  await assert.rejects(
    () => q(`INSERT INTO loyalty_movements (empresa_id, programa_id, cliente_id, tipo, pontos, chave_idempotencia) VALUES ($1,$2,$3,'credito',100,$4)`,
      [ctx.empresaId, Number(programa.id), Number(cliente.id), chave]),
    /duplicate key|unique/i
  );
  // A mesma chave em OUTRA empresa não colide (escopo por empresa).
  const outra = await ctx.s.insert(ctx.RESOURCES.empresas, { nome: `Outra ${SUFIXO}`, ativo: true });
  const progB = await ctx.s.insert(ctx.RESOURCES.loyalty_programs, { empresa_id: Number(outra.id), nome: `ProgB ${SUFIXO}`, pontos_por_real: 1 });
  const cliB = await ctx.s.insert(ctx.RESOURCES.clientes, { empresa_id: Number(outra.id), nome: `CliB ${SUFIXO}` });
  await q(`INSERT INTO loyalty_movements (empresa_id, programa_id, cliente_id, tipo, pontos, chave_idempotencia) VALUES ($1,$2,$3,'credito',100,$4)`,
    [Number(outra.id), Number(progB.id), Number(cliB.id), chave]);
});

// ---------------------------------------------------------------------------
// 2) Saldo de pontos = soma dos movimentos, através do handler real
// ---------------------------------------------------------------------------
test('pg W45: creditar venda é idempotente e o saldo é a soma dos movimentos', { skip }, async () => {
  const ctx = await cenario('saldo');
  const { creditarPontosVenda, saldoFidelidade } = await import('../src/enterprise45');
  const programa = await ctx.s.insert(ctx.RESOURCES.loyalty_programs, { empresa_id: ctx.empresaId, nome: `Prog ${SUFIXO}`, pontos_por_real: 2, ativo: true });
  const cliente = await ctx.s.insert(ctx.RESOURCES.clientes, { empresa_id: ctx.empresaId, nome: `Cli ${SUFIXO}` });
  const produto = await ctx.s.insert(ctx.RESOURCES.produtos, { empresa_id: ctx.empresaId, nome: `Prod ${SUFIXO}`, sku: `W45-${SUFIXO}`, custo: 60 });
  const venda = await ctx.s.insert(ctx.RESOURCES.vendas, { empresa_id: ctx.empresaId, cliente_id: Number(cliente.id), status: 'faturada', total: 500, faturada_em: '2026-04-10T00:00:00.000Z' });
  await ctx.s.insert(ctx.RESOURCES.itens_venda, { empresa_id: ctx.empresaId, venda_id: Number(venda.id), produto_id: Number(produto.id), quantidade: 5, preco_unitario: 100, subtotal: 500 });

  const r1 = await chamar(creditarPontosVenda, ctx, { programa_id: Number(programa.id), cliente_id: Number(cliente.id), venda_id: Number(venda.id) }, {}, `venda-${venda.id}`);
  assert.ok(r1.json, `esperava corpo; veio ${JSON.stringify(r1)}`);
  assert.equal(Number(r1.json.pontos), 1000);
  const r2 = await chamar(creditarPontosVenda, ctx, { programa_id: Number(programa.id), cliente_id: Number(cliente.id), venda_id: Number(venda.id) }, {}, `venda-${venda.id}`);
  assert.equal(Number(r2.json.id), Number(r1.json.id), 'repetir a chave não pode criar segundo movimento');

  const saldo = await chamar(saldoFidelidade, ctx, {}, { clienteId: Number(cliente.id) });
  const p = saldo.json.programas.find((x: any) => x.programa_id === Number(programa.id));
  assert.equal(p.saldo, 1000);
  assert.equal(p.movimentos, 1);
});

// ---------------------------------------------------------------------------
// 3) BI reconstruído sobre vendas REAIS no Postgres
// ---------------------------------------------------------------------------
test('pg W45: BI reconstrói receita/CMV/margem do período real', { skip }, async () => {
  const ctx = await cenario('bi');
  const { reconstruirBi, painelBi } = await import('../src/enterprise45');
  const cliente = await ctx.s.insert(ctx.RESOURCES.clientes, { empresa_id: ctx.empresaId, nome: `Cli ${SUFIXO}` });
  const produto = await ctx.s.insert(ctx.RESOURCES.produtos, { empresa_id: ctx.empresaId, nome: `Prod ${SUFIXO}`, sku: `W45B-${SUFIXO}`, custo: 60 });
  const venda = await ctx.s.insert(ctx.RESOURCES.vendas, { empresa_id: ctx.empresaId, cliente_id: Number(cliente.id), status: 'faturada', total: 1000, canal: 'BROBOND', faturada_em: '2026-05-12T00:00:00.000Z' });
  await ctx.s.insert(ctx.RESOURCES.itens_venda, { empresa_id: ctx.empresaId, venda_id: Number(venda.id), produto_id: Number(produto.id), quantidade: 10, preco_unitario: 100, subtotal: 1000 });

  await chamar(reconstruirBi, ctx, { periodo: '2026-05' });
  const painel = await chamar(painelBi, ctx, {}, {}, 'k', { periodo: '2026-05' });
  assert.equal(painel.json.receita, 1000);
  assert.equal(painel.json.cmv, 600);
  assert.equal(painel.json.margem, 400);
  const linhas = await q(`SELECT origem, periodo, dimensao, metrica, valor, empresa_id FROM bi_read_models WHERE empresa_id=$1 AND periodo='2026-05'`, [ctx.empresaId]);
  assert.ok(linhas.length >= 3);
  assert.ok(linhas.every((l: any) => l.origem && l.periodo && l.dimensao && l.metrica));
});

// ---------------------------------------------------------------------------
// 4) Demanda → suprimento → S&OP, encadeados sobre o histórico real
// ---------------------------------------------------------------------------
test('pg W45: forecast → plano de suprimento → S&OP aprovado com autor', { skip }, async () => {
  const ctx = await cenario('sop');
  const { gerarForecastDemanda, gerarPlanoSuprimento, aprovarSop } = await import('../src/enterprise45');
  const cliente = await ctx.s.insert(ctx.RESOURCES.clientes, { empresa_id: ctx.empresaId, nome: `Cli ${SUFIXO}` });
  const produto = await ctx.s.insert(ctx.RESOURCES.produtos, { empresa_id: ctx.empresaId, nome: `Prod ${SUFIXO}`, sku: `W45S-${SUFIXO}`, custo: 10 });
  const local = await ctx.s.insert(ctx.RESOURCES.locais, { empresa_id: ctx.empresaId, codigo: 'DEP', nome: `Dep ${SUFIXO}`, tipo: 'deposito', ativo: true, padrao: true });
  const venda = await ctx.s.insert(ctx.RESOURCES.vendas, { empresa_id: ctx.empresaId, cliente_id: Number(cliente.id), status: 'faturada', total: 300, faturada_em: '2026-06-10T00:00:00.000Z' });
  await ctx.s.insert(ctx.RESOURCES.itens_venda, { empresa_id: ctx.empresaId, venda_id: Number(venda.id), produto_id: Number(produto.id), quantidade: 3, preco_unitario: 100, subtotal: 300 });
  await ctx.s.insert(ctx.RESOURCES.estoques, { empresa_id: ctx.empresaId, produto_id: Number(produto.id), local_id: Number(local.id), quantidade: 1, custo_medio: 10 });

  const fc = await chamar(gerarForecastDemanda, ctx, { periodo: '2026-06' });
  assert.ok(fc.json.linhas >= 1);
  const linha = fc.json.forecasts.find((f: any) => Number(f.produto_id) === Number(produto.id));
  assert.equal(Number(linha.historico), 3);

  const sup = await chamar(gerarPlanoSuprimento, ctx, { periodo: '2026-06' });
  const plano = sup.json.planos.find((p: any) => Number(p.produto_id) === Number(produto.id));
  assert.ok(plano, 'o plano deveria cobrir o produto com necessidade');
  assert.equal(Number(plano.estoque_atual), 1);

  const cenSop = await ctx.s.insert(ctx.RESOURCES.sop_scenarios, { empresa_id: ctx.empresaId, nome: `Cen ${SUFIXO}`, periodo: '2026-06', demanda_total: 3, capacidade_total: 2, impacto_financeiro: 0 });
  const ap = await chamar(aprovarSop, ctx, {}, { id: Number(cenSop.id) });
  assert.equal(ap.json.status, 'aprovado');
  assert.equal(Number(ap.json.aprovado_por), ctx.actor.id);
});

// ---------------------------------------------------------------------------
// 5) EPM: variance do realizado REAL + forecast de cenário
// ---------------------------------------------------------------------------
test('pg W45: EPM calcula variance do realizado e projeta o cenário', { skip }, async () => {
  const ctx = await cenario('epm');
  const { varianceEpm, forecastCenario } = await import('../src/enterprise45');
  const cliente = await ctx.s.insert(ctx.RESOURCES.clientes, { empresa_id: ctx.empresaId, nome: `Cli ${SUFIXO}` });
  const conta = await ctx.s.insert(ctx.RESOURCES.plano_contas, { empresa_id: ctx.empresaId, nome: `Conta ${SUFIXO}`, codigo: `9.${Date.now()}`, natureza: 'despesa' });
  const categoria = await ctx.s.insert(ctx.RESOURCES.categorias_financeiras, { nome: `Cat ${SUFIXO}`, tipo: 'despesa', ativo: true });
  const bud = await ctx.s.insert(ctx.RESOURCES.epm_budgets, { empresa_id: ctx.empresaId, nome: `Orc ${SUFIXO}`, periodo: '2026-07', conta_id: Number(conta.id), categoria_financeira_id: Number(categoria.id), valor_orcado: 800, status: 'aprovado' });
  await ctx.s.insert(ctx.RESOURCES.lancamentos_financeiros, { empresa_id: ctx.empresaId, data: '2026-07-10', tipo: 'despesa', descricao: 'Despesa', valor: 500, categoria_id: Number(categoria.id), status: 'confirmado' });
  const venda = await ctx.s.insert(ctx.RESOURCES.vendas, { empresa_id: ctx.empresaId, cliente_id: Number(cliente.id), status: 'faturada', total: 2000, faturada_em: '2026-07-15T00:00:00.000Z' });

  const v = await chamar(varianceEpm, ctx, {}, {}, 'k', { periodo: '2026-07' });
  const linha = v.json.linhas.find((l: any) => Number(l.orcamento_id) === Number(bud.id));
  assert.ok(linha, 'a variance deveria listar o orçamento do período');
  assert.equal(linha.orcado, 800);
  assert.equal(linha.realizado, 500);
  assert.equal(linha.variacao, -300);

  const cen = await ctx.s.insert(ctx.RESOURCES.epm_scenarios, { empresa_id: ctx.empresaId, nome: `Cen ${SUFIXO}`, periodo: '2026-07', premissas: { crescimento_pct: 10, custo_pct: 40 } });
  const f = await chamar(forecastCenario, ctx, {}, { id: Number(cen.id) });
  assert.equal(f.json.realizado, 2000);
  assert.equal(f.json.receita_projetada, 2200);
  assert.equal(f.json.custo_projetado, 880);
  void venda;
});

// ---------------------------------------------------------------------------
// 6) Isolamento por empresa: A não enxerga nem altera dado de B
// ---------------------------------------------------------------------------
test('pg W45: isolamento por empresa (A × B) em loyalty e affiliate', { skip }, async () => {
  const a = await cenario('isoA');
  const b = await cenario('isoB');
  const { creditarPontosVenda, apurarComissaoAfiliado } = await import('../src/enterprise45');

  const progA = await a.s.insert(a.RESOURCES.loyalty_programs, { empresa_id: a.empresaId, nome: `ProgA ${SUFIXO}`, pontos_por_real: 1, ativo: true });
  const cliA = await a.s.insert(a.RESOURCES.clientes, { empresa_id: a.empresaId, nome: `CliA ${SUFIXO}` });
  const cliB = await b.s.insert(b.RESOURCES.clientes, { empresa_id: b.empresaId, nome: `CliB ${SUFIXO}` });
  const progB = await b.s.insert(b.RESOURCES.loyalty_programs, { empresa_id: b.empresaId, nome: `ProgB ${SUFIXO}`, pontos_por_real: 1, ativo: true });

  // B usando o programa de A, ou o cliente de A → 404 (nunca 403).
  await assert.rejects(
    () => apurarIso(creditarPontosVenda, b, { programa_id: Number(progA.id), cliente_id: Number(cliB.id) }),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    () => apurarIso(creditarPontosVenda, b, { programa_id: Number(progB.id), cliente_id: Number(cliA.id) }),
    (e: any) => e.status === 404
  );

  // Comissão: parceria da empresa A não é alcançável pela empresa B.
  const creatorA = await a.s.insert(a.RESOURCES.creator_profiles, { empresa_id: a.empresaId, name: `CrA ${SUFIXO}`, platform: 'INSTAGRAM', handle: `cra${SUFIXO}`, status: 'ACTIVE' });
  const briefA = await a.s.insert(a.RESOURCES.creator_campaigns, { empresa_id: a.empresaId, name: `BrA ${SUFIXO}`, objective: 'Aumentar vendas do canal', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'ACTIVE' });
  const campA = await a.s.insert(a.RESOURCES.crm_campanhas, { empresa_id: a.empresaId, nome: `CampA ${SUFIXO}`, ativo: true, custo: 100 });
  const parcA = await a.s.insert(a.RESOURCES.creator_partnerships, { empresa_id: a.empresaId, creator_id: Number(creatorA.id), campaign_id: Number(briefA.id), crm_campanha_id: Number(campA.id), status: 'ACTIVE' });
  await assert.rejects(
    () => apurarIso(apurarComissaoAfiliado, b, { percentual: 10 }, { partnershipId: Number(parcA.id) }),
    (e: any) => e.status === 404
  );
});

async function apurarIso(handler: any, ctx: Ctx, body: object, params: object = {}) {
  const { reqDe, resFake } = await import('./_p1util');
  const { res, saida } = resFake();
  await handler(reqDe(body, { params, user: ctx.actor as any }), res);
  return saida.json;
}
