// ============================================================================
// E3.2 contra Postgres REAL — contas a pagar, de-para, XML e a cadeia completa.
//
// Só se prova aqui (o memdb não tem constraint nem coluna DATE de verdade):
//
//   • A REGRESSÃO DO VENCIMENTO: `compras.fin_vencimento` é coluna DATE, o
//     Postgres devolve um objeto `Date`, e `String(date).slice(0,10)` produzia
//     "Mon Nov 09" → `addMeses` estourava `RangeError: Invalid time value` →
//     **500 em qualquer compra com vencimento**. Este teste existir é o que
//     impede a volta desse bug.
//   • Recebimento completo gera conta a pagar com parcelas, vencimentos e a
//     FK de origem (`referencia_tipo='compra'` + `referencia_id`), não texto.
//   • Recebimento PARCIAL não gera obrigação financeira.
//   • Estornar a compra cancela as contas a pagar.
//   • De-para: UNIQUE (fornecedor_id, codigo_fornecedor) recusa duplicata e a
//     migração 0029 está aplicada.
//   • A cadeia completa: fornecedor → compra → recebimento → estoque → custo →
//     conta a pagar, e o isolamento entre empresas em cada elo.
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
async function um<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

async function cenario(tag: string) {
  const { migrate } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const compras = await import('../src/compras');
  const s = getStore();
  seq++;
  const empresa = await s.insert(RESOURCES.empresas, { nome: `Empresa ${tag} ${seq} ${SUFIXO}`, ativo: true });
  const empresaId = Number(empresa.id);
  const usuario = await s.insert(RESOURCES.usuarios, {
    nome: `Admin ${tag} ${seq}`,
    email: `admin-${tag}-${seq}-${SUFIXO}@brobond.test`,
    perfil: 'admin',
    empresa_id: empresaId,
    ativo: true,
  });
  if (!(await s.findOneWhere(RESOURCES.locais, { nome: 'loja' }))) {
    await s.insert(RESOURCES.locais, { codigo: 'LOJA', nome: 'loja', tipo: 'loja', ativo: true, empresa_id: empresaId });
  }
  const fornecedor = await s.insert(RESOURCES.fornecedores, { nome: `Forn ${tag} ${seq}`, cnpj: '', ativo: true, empresa_id: empresaId });
  const insumo = await s.insert(RESOURCES.insumos, { nome: `Insumo ${tag} ${seq}`, unidade: 'un', custo_medio: 0, ativo: true, empresa_id: empresaId });
  const actor = {
    id: Number(usuario.id),
    name: String(usuario.nome),
    perfil: 'admin' as const,
    empresa_id: empresaId,
    empresas: [empresaId],
  };
  const { escopoDoAtor } = await import('../src/empresa');
  return { RESOURCES, s, compras, empresaId, actor, escopo: escopoDoAtor(actor), fornecedor, insumo };
}

async function novaCompra(
  ctx: Ctx,
  opts: { qtd: number; preco: number; frete?: number; fin?: Record<string, unknown> }
) {
  const total = opts.qtd * opts.preco + (opts.frete ?? 0);
  const compra = await ctx.s.insert(ctx.RESOURCES.compras, {
    empresa_id: ctx.empresaId,
    fornecedor_id: Number(ctx.fornecedor.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'pendente',
    total,
    frete: opts.frete ?? 0,
    ...(opts.fin || {}),
  });
  const item = await ctx.s.insert(ctx.RESOURCES.itens_compra, {
    empresa_id: ctx.empresaId,
    compra_id: Number(compra.id),
    insumo_id: Number(ctx.insumo.id),
    quantidade: opts.qtd,
    quantidade_recebida: 0,
    preco_unitario: opts.preco,
  });
  return { compraId: Number(compra.id), itemId: Number(item.id), total };
}

async function receber(ctx: Ctx, compraId: number, itemId: number, quantidade: number, extra: Record<string, unknown> = {}) {
  const { reqDe, resFake } = await import('./_p1util');
  const { res, saida } = resFake();
  await ctx.compras.receberParcial(
    reqDe({ itens: [{ item_compra_id: itemId, quantidade }], ...extra }, { params: { id: compraId }, user: ctx.actor as any }),
    res
  );
  return { status: saida.status, body: saida.json };
}

async function parcelasDaCompra(compraId: number) {
  return q<{ id: number; parcela: string; total_parcelas: string; valor: string; vencimento: string; status: string; tipo: string; empresa_id: string; referencia_tipo: string; referencia_id: string }>(
    `SELECT id, parcela, total_parcelas, valor, to_char(vencimento,'YYYY-MM-DD') AS vencimento, status, tipo, empresa_id, referencia_tipo, referencia_id
       FROM lancamentos_financeiros WHERE referencia_tipo='compra' AND referencia_id=$1 ORDER BY parcela`,
    [compraId]
  );
}

// ---------------------------------------------------------------------------
// 1) A REGRESSÃO DO VENCIMENTO (era 500)
// ---------------------------------------------------------------------------
test('pg E3.2: compra COM vencimento recebe e gera parcelas (regressão do RangeError)', { skip }, async () => {
  const ctx = await cenario('venc');
  // fin_vencimento é coluna DATE — é exatamente o caso que devolvia 500.
  const { compraId, itemId } = await novaCompra(ctx, {
    qtd: 100,
    preco: 50,
    frete: 400,
    fin: { condicao_pagamento: '30/60/90', fin_parcelas: 3, fin_vencimento: '2026-11-09', fin_forma_pagamento: 'boleto' },
  });

  const r = await receber(ctx, compraId, itemId, 100);
  assert.equal(r.status, 201, `o recebimento com vencimento falhou: ${JSON.stringify(r.body)}`);

  const p = await parcelasDaCompra(compraId);
  assert.equal(p.length, 3, 'deveria gerar 3 parcelas');
  const soma = p.reduce((a, x) => a + Number(x.valor), 0);
  assert.equal(Math.round(soma * 100) / 100, 5400, `a soma das parcelas deveria fechar no total 5400, deu ${soma}`);
  assert.deepEqual(p.map((x) => x.vencimento), ['2026-11-09', '2026-12-09', '2027-01-09'], 'os vencimentos mensais estão errados');
  assert.ok(p.every((x) => x.status === 'pendente'));
  assert.ok(p.every((x) => x.tipo === 'despesa'), 'conta a pagar é despesa');
  assert.ok(p.every((x) => Number(x.empresa_id) === ctx.empresaId), 'parcela com empresa errada');
});

test('pg E3.2: vencimento no dia 31 não vira mês seguinte (31 jan + 1m = 28 fev)', { skip }, async () => {
  const ctx = await cenario('venc31');
  const { compraId, itemId } = await novaCompra(ctx, {
    qtd: 10,
    preco: 100,
    fin: { fin_parcelas: 2, fin_vencimento: '2027-01-31' },
  });
  const r = await receber(ctx, compraId, itemId, 10);
  assert.equal(r.status, 201);
  const p = await parcelasDaCompra(compraId);
  assert.deepEqual(p.map((x) => x.vencimento), ['2027-01-31', '2027-02-28'], 'fevereiro precisa respeitar o último dia do mês');
});

// ---------------------------------------------------------------------------
// 2) QUANDO NASCE A OBRIGAÇÃO
// ---------------------------------------------------------------------------
test('pg E3.2: recebimento PARCIAL não gera conta a pagar; o completo gera', { skip }, async () => {
  const ctx = await cenario('parc');
  const { compraId, itemId } = await novaCompra(ctx, { qtd: 100, preco: 50, fin: { fin_parcelas: 2, fin_vencimento: '2026-11-09' } });

  await receber(ctx, compraId, itemId, 40);
  assert.equal((await parcelasDaCompra(compraId)).length, 0, 'recebimento parcial não pode gerar obrigação financeira');

  const r = await receber(ctx, compraId, itemId, 60);
  assert.equal(r.status, 201);
  const p = await parcelasDaCompra(compraId);
  assert.equal(p.length, 2, 'ao completar o pedido a conta a pagar nasce');
  assert.equal(Math.round(p.reduce((a, x) => a + Number(x.valor), 0) * 100) / 100, 5000);
});

test('pg E3.2: estornar a compra cancela as contas a pagar', { skip }, async () => {
  const ctx = await cenario('estfin');
  const { compraId, itemId } = await novaCompra(ctx, { qtd: 50, preco: 20, fin: { fin_parcelas: 1, fin_vencimento: '2026-12-01' } });
  await receber(ctx, compraId, itemId, 50);
  assert.equal((await parcelasDaCompra(compraId)).length, 1);

  const { updateRecord } = await import('../src/services');
  await updateRecord(ctx.RESOURCES.compras, compraId, { status: 'cancelado' }, ctx.actor, { escopo: ctx.escopo });

  const p = await parcelasDaCompra(compraId);
  assert.equal(p.length, 1, 'a parcela não pode sumir — histórico é histórico');
  assert.equal(p[0].status, 'cancelado', 'a conta a pagar de uma compra estornada precisa ser cancelada');
});

test('pg E3.2: compra de valor zero não gera parcela de R$ 0,00', { skip }, async () => {
  const ctx = await cenario('zero');
  // Sem itens com valor: total 0. O banco exige valor > 0 na parcela.
  const compra = await ctx.s.insert(ctx.RESOURCES.compras, {
    empresa_id: ctx.empresaId,
    fornecedor_id: Number(ctx.fornecedor.id),
    data: '2026-10-09',
    status: 'pendente',
    total: 0,
  });
  const item = await ctx.s.insert(ctx.RESOURCES.itens_compra, {
    empresa_id: ctx.empresaId,
    compra_id: Number(compra.id),
    insumo_id: Number(ctx.insumo.id),
    quantidade: 5,
    quantidade_recebida: 0,
    preco_unitario: 0,
  });
  const r = await receber(ctx, Number(compra.id), Number(item.id), 5);
  assert.equal(r.status, 201, `receber compra de valor zero falhou: ${JSON.stringify(r.body)}`);
  assert.equal((await parcelasDaCompra(Number(compra.id))).length, 0);
});

// ---------------------------------------------------------------------------
// 3) DE-PARA
// ---------------------------------------------------------------------------
test('pg E3.2: a 0029 está aplicada — colunas e índices do de-para', { skip }, async () => {
  await cenario('mig29');
  const cols = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='produto_fornecedor_skus' AND column_name IN ('descricao','unidade','ativo') ORDER BY column_name`
  );
  assert.deepEqual(cols.map((c) => c.column_name), ['ativo', 'descricao', 'unidade']);

  const idx = await q<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname IN ('produto_fornecedor_skus_produto_idx','produto_fornecedor_skus_ativos_idx') ORDER BY indexname`
  );
  assert.deepEqual(idx.map((c) => c.indexname), ['produto_fornecedor_skus_ativos_idx', 'produto_fornecedor_skus_produto_idx']);
});

test('pg E3.2: o mesmo código no mesmo fornecedor é recusado pelo UNIQUE (23505)', { skip }, async () => {
  const ctx = await cenario('depara');
  const { createRecord } = await import('../src/services');
  const prod = await ctx.s.insert(ctx.RESOURCES.produtos, { nome: `Prod ${SUFIXO}`, sku: `SKU-${SUFIXO}`, empresa_id: ctx.empresaId, ativo: true });

  await createRecord(
    ctx.RESOURCES.produto_fornecedor_skus,
    { fornecedor_id: Number(ctx.fornecedor.id), codigo_fornecedor: 'DUP-1', produto_id: Number(prod.id), descricao: 'X', unidade: 'UN', ativo: true },
    ctx.actor
  );
  const erro: any = await createRecord(
    ctx.RESOURCES.produto_fornecedor_skus,
    { fornecedor_id: Number(ctx.fornecedor.id), codigo_fornecedor: 'DUP-1', produto_id: Number(prod.id) },
    ctx.actor
  ).then(() => null, (e: any) => e);
  assert.ok(erro, 'o de-para duplicado deveria ter sido recusado');
  assert.ok([409, 500].includes(Number(erro.status)), `status inesperado: ${erro.status}`);
  assert.match(String(erro.message), /já|duplicad|existe/i, `mensagem pouco clara: ${erro.message}`);
});

test('pg E3.2 MULTIEMPRESA: o mesmo código em A e B não colide (escopos separados)', { skip }, async () => {
  const a = await cenario('dpA');
  const b = await cenario('dpB');
  const { createRecord } = await import('../src/services');

  const prodA = await a.s.insert(a.RESOURCES.produtos, { nome: `ProdA ${SUFIXO}`, sku: `A-${SUFIXO}`, empresa_id: a.empresaId, ativo: true });
  const prodB = await b.s.insert(b.RESOURCES.produtos, { nome: `ProdB ${SUFIXO}`, sku: `B-${SUFIXO}`, empresa_id: b.empresaId, ativo: true });

  const da = await createRecord(a.RESOURCES.produto_fornecedor_skus, { fornecedor_id: Number(a.fornecedor.id), codigo_fornecedor: 'MESMO', produto_id: Number(prodA.id) }, a.actor);
  const db = await createRecord(b.RESOURCES.produto_fornecedor_skus, { fornecedor_id: Number(b.fornecedor.id), codigo_fornecedor: 'MESMO', produto_id: Number(prodB.id) }, b.actor);
  assert.notEqual(Number(da.id), Number(db.id));

  const deA = await um<{ empresa_id: string; produto_id: string }>('SELECT empresa_id, produto_id FROM produto_fornecedor_skus WHERE id=$1', [Number(da.id)]);
  assert.equal(Number(deA!.empresa_id), a.empresaId);
  assert.equal(Number(deA!.produto_id), Number(prodA.id), 'o de-para da A apontou para o produto da B');
});

// ---------------------------------------------------------------------------
// 4) A CADEIA COMPLETA
// ---------------------------------------------------------------------------
test('pg E3.2 E2E: fornecedor → compra → recebimento → estoque → custo → conta a pagar', { skip }, async () => {
  const ctx = await cenario('e2e');
  const { compraId, itemId, total } = await novaCompra(ctx, {
    qtd: 100,
    preco: 50,
    frete: 400,
    fin: { condicao_pagamento: '28 dias', fin_parcelas: 2, fin_vencimento: '2026-11-09', fin_forma_pagamento: 'boleto', fin_conta_id: null },
  });

  // 1) compra existe e pertence à empresa
  const compra = await um<{ status: string; empresa_id: string; fornecedor_id: string }>('SELECT status, empresa_id, fornecedor_id FROM compras WHERE id=$1', [compraId]);
  assert.equal(compra!.status, 'pendente');
  assert.equal(Number(compra!.empresa_id), ctx.empresaId);
  assert.ok(Number(compra!.fornecedor_id) > 0, 'a compra precisa ter FK de fornecedor, não só o nome');

  // 2) recebimento parcial
  const r1 = await receber(ctx, compraId, itemId, 40);
  assert.equal(r1.status, 201);
  assert.equal(r1.body.status, 'parcial');

  // 3) estoque subiu só pelo recebido
  const saldo1 = await um<{ quantidade: string }>('SELECT quantidade FROM estoque_insumos WHERE insumo_id=$1', [Number(ctx.insumo.id)]);
  assert.equal(Number(saldo1!.quantidade), 40);

  // 4) custo aplicado pela regra canônica
  assert.equal(Number(r1.body.custos[0].custo_unitario_efetivo), 54, 'preço 50 + frete 160/40');
  const custo1 = await um<{ custo_medio: string }>('SELECT custo_medio FROM insumos WHERE id=$1', [Number(ctx.insumo.id)]);
  assert.equal(Number(custo1!.custo_medio), 54);

  // 5) parcial não gera financeiro
  assert.equal((await parcelasDaCompra(compraId)).length, 0);

  // 6) completa o pedido
  const r2 = await receber(ctx, compraId, itemId, 60);
  assert.equal(r2.status, 201);
  assert.equal(r2.body.status, 'recebido');

  // 7) estoque e custo finais
  const saldo2 = await um<{ quantidade: string }>('SELECT quantidade FROM estoque_insumos WHERE insumo_id=$1', [Number(ctx.insumo.id)]);
  assert.equal(Number(saldo2!.quantidade), 100);
  const custo2 = await um<{ custo_medio: string }>('SELECT custo_medio FROM insumos WHERE id=$1', [Number(ctx.insumo.id)]);
  assert.equal(Number(custo2!.custo_medio), 54, 'o frete não pode ser cobrado duas vezes');

  // 8) conta a pagar com vínculo por FK
  const p = await parcelasDaCompra(compraId);
  assert.equal(p.length, 2);
  assert.ok(p.every((x) => x.referencia_tipo === 'compra' && Number(x.referencia_id) === compraId), 'o vínculo precisa ser estrutural, não texto');
  assert.equal(Math.round(p.reduce((a, x) => a + Number(x.valor), 0) * 100) / 100, total);

  // 9) a movimentação liga o recebimento ao item da compra
  const movs = await q<{ compra_id: string; recebimento_id: string; item_compra_id: string; custo_unitario: string }>(
    `SELECT compra_id, recebimento_id, item_compra_id, custo_unitario FROM movimentacoes_insumos WHERE insumo_id=$1 ORDER BY id`,
    [Number(ctx.insumo.id)]
  );
  assert.equal(movs.length, 2);
  assert.ok(movs.every((m) => Number(m.compra_id) === compraId && Number(m.item_compra_id) === itemId && Number(m.recebimento_id) > 0));
  assert.ok(movs.every((m) => Number(m.custo_unitario) === 54));
});

test('pg E3.2 E2E MULTIEMPRESA: B não enxerga nada da cadeia da A (A → B → A)', { skip }, async () => {
  const a = await cenario('e2eA');
  const b = await cenario('e2eB');

  const { compraId, itemId } = await novaCompra(a, { qtd: 100, preco: 50, fin: { fin_parcelas: 1, fin_vencimento: '2026-11-09' } });
  await receber(a, compraId, itemId, 100);

  // B não pode receber a compra da A.
  const cruzado = await receber(b, compraId, itemId, 10)
    .then((r) => r.status)
    .catch((e: any) => e.status ?? e.message);
  assert.equal(cruzado, 404, 'a empresa B conseguiu mexer na compra da A');

  // B não vê a compra, o estoque, o custo nem as contas a pagar da A.
  const comprasVisiveis = await q<{ id: string }>(`SELECT id FROM compras WHERE empresa_id=$1`, [b.empresaId]);
  assert.equal(comprasVisiveis.length, 0);

  const lancs = await q<{ empresa_id: string }>(`SELECT empresa_id FROM lancamentos_financeiros WHERE referencia_tipo='compra' AND referencia_id=$1`, [compraId]);
  assert.equal(lancs.length, 1);
  assert.equal(Number(lancs[0].empresa_id), a.empresaId, 'a conta a pagar da A apareceu para a B');

  const estoques = await q<{ empresa_id: string }>(`SELECT empresa_id FROM estoque_insumos WHERE insumo_id=$1`, [Number(a.insumo.id)]);
  assert.ok(estoques.every((e) => Number(e.empresa_id) === a.empresaId));

  // Voltando para A: tudo continua lá e intacto.
  const custoA = await um<{ custo_medio: string }>('SELECT custo_medio FROM insumos WHERE id=$1', [Number(a.insumo.id)]);
  assert.equal(Number(custoA!.custo_medio), 50);
  assert.equal((await parcelasDaCompra(compraId)).length, 1);
});
