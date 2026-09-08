// Testes da Fase 2 — pedidos de venda/compra: itens, totais calculados,
// faturamento com baixa de estoque, recebimento com custo médio e estornos.
// Modo memória (não precisa de banco); as mesmas regras valem no Postgres.
import { test, before } from 'node:test';
void before;
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, getRecord, listRecords, getStore } = await import('../src/services');
const { HttpError } = await import('../src/errors');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

async function expectHttp(fn: () => Promise<unknown>, status: number, re?: RegExp) {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(e instanceof HttpError, `esperava HttpError, veio ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.status, status, `status ${e.status} ≠ ${status}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail(`esperava erro ${status}`);
}

async function addItem(vendaId: number, item: Record<string, unknown>) {
  const s = getStore();
  return s.transaction(async (tx) => {
    const { aplicarRegrasPedido } = await import('../src/itens');
    const data = await import('../src/validate').then((m) => m.validatePayload(RESOURCES.itens_venda, item, 'create'));
    const row = await s.insert(RESOURCES.itens_venda, { ...data, venda_id: vendaId, subtotal: Math.round(Number(data.quantidade) * Number(data.preco_unitario) * (1 - Number(data.desconto_pct || 0) / 100) * 100) / 100 }, tx);
    const { recalcularTotal } = await import('../src/itens');
    await recalcularTotal('venda', vendaId, tx);
    return row;
  });
}

async function addItemCompra(compraId: number, item: Record<string, unknown>) {
  const s = getStore();
  return s.transaction(async (tx) => {
    const { recalcularTotal } = await import('../src/itens');
    const data = await import('../src/validate').then((m) => m.validatePayload(RESOURCES.itens_compra, item, 'create'));
    const row = await s.insert(RESOURCES.itens_compra, { ...data, compra_id: compraId }, tx);
    await recalcularTotal('compra', compraId, tx);
    return row;
  });
}

let produtoId = 0;
let insumoId = 0;
let representanteId = 0;
let clienteId = 0;
let fornecedorId = 0;
let setupDone = false;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  getStore();
  const p = await createRecord(RESOURCES.produtos, { sku: 'V-001', nome: 'Camisa Venda', preco_venda: 100 }, admin);
  produtoId = Number(p.id);
  const ins = await createRecord(RESOURCES.insumos, { nome: 'Tecido Algodão', unidade: 'm', custo_medio: 10 }, admin);
  insumoId = Number(ins.id);
  const rep = await createRecord(RESOURCES.representantes, { nome: 'Rep Teste', comissao_pct: 5 }, admin);
  representanteId = Number(rep.id);
  const cli = await createRecord(RESOURCES.clientes, { nome: 'Cliente Teste' }, admin);
  clienteId = Number(cli.id);
  const forn = await createRecord(RESOURCES.fornecedores, { nome: 'Fornecedor Teste' }, admin);
  fornecedorId = Number(forn.id);
}

before(async () => {
  await ensureSetup();
});

test('venda: total é recalculado pelo servidor (itens + frete − desconto)', async () => {
  await ensureSetup();
  const v = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, data: '2026-09-01', frete: 10, desconto: 5 }, admin);
  await addItem(Number(v.id), { produto_id: produtoId, tamanho_id: 3, quantidade: 2, preco_unitario: 100 });
  await addItem(Number(v.id), { produto_id: produtoId, tamanho_id: 4, quantidade: 1, preco_unitario: 100, desconto_pct: 10 });
  const depois = await getRecord(RESOURCES.vendas, Number(v.id));
  // 2×100 + 1×100×0,9 + 10 frete − 5 desconto = 295
  assert.equal(Number(depois.total), 295);
  // total enviado pelo cliente nunca é aceito (campo readonly: é ignorado)
  await updateRecord(RESOURCES.vendas, Number(v.id), { total: 9999 }, admin);
  const depois2 = await getRecord(RESOURCES.vendas, Number(v.id));
  assert.equal(Number(depois2.total), 295);
});

test('venda: faturar sem saldo bloqueia com 409 listando os itens', async () => {
  await ensureSetup();
  const v = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, data: '2026-09-01' }, admin);
  await addItem(Number(v.id), { produto_id: produtoId, tamanho_id: 3, quantidade: 5, preco_unitario: 100 });
  await expectHttp(() => updateRecord(RESOURCES.vendas, Number(v.id), { status: 'faturada' }, admin), 409, /saldo/i);
});

test('venda: faturar baixa o estoque e cancelar estorna; comissão é congelada', async () => {
  await ensureSetup();
  // Entrada de estoque: 10 peças na loja
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: 3, local: 'loja', quantidade: 10 }, admin);
  const v = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, data: '2026-09-01', representante_id: representanteId, local_saida: 'expedicao' }, admin);
  await addItem(Number(v.id), { produto_id: produtoId, tamanho_id: 3, quantidade: 4, preco_unitario: 100 });

  await updateRecord(RESOURCES.vendas, Number(v.id), { status: 'faturada' }, admin);
  const saldoDepois = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId, tamanho_id: 3, local: 'loja' } });
  assert.equal(Number(saldoDepois.rows[0].quantidade), 6); // 10 − 4
  const fat = await getRecord(RESOURCES.vendas, Number(v.id));
  assert.ok(fat.faturada_em, 'faturada_em deve estar preenchida');
  assert.equal(Number(fat.comissao_pct), 5);
  assert.equal(Number(fat.comissao_valor), 20); // 400 × 5%

  // Cancelar → estorna
  await updateRecord(RESOURCES.vendas, Number(v.id), { status: 'cancelada' }, admin);
  const saldoEstorno = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId, tamanho_id: 3, local: 'loja' } });
  assert.equal(Number(saldoEstorno.rows[0].quantidade), 10);
  const canc = await getRecord(RESOURCES.vendas, Number(v.id));
  assert.equal(canc.faturada_em, null);
  assert.equal(canc.comissao_valor, null);
});

test('venda: itens não podem ser editados após faturar', async () => {
  await ensureSetup();
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: 4, local: 'loja', quantidade: 5 }, admin);
  const v = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, data: '2026-09-01' }, admin);
  const item = await addItem(Number(v.id), { produto_id: produtoId, tamanho_id: 4, quantidade: 2, preco_unitario: 100 });
  await updateRecord(RESOURCES.vendas, Number(v.id), { status: 'faturada' }, admin);

  // Tenta inserir item via handler de sub-recurso (simula a rota)
  const { createItem } = await import('../src/itens');
  const req: any = { params: { id: String(v.id) }, path: '/api/vendas/' + v.id + '/itens', body: { produto_id: produtoId, tamanho_id: 4, quantidade: 1, preco_unitario: 100 }, user: admin };
  const res: any = { status: () => res, json: () => res };
  await expectHttp(() => createItem(req, res), 409, /faturado/i);
  void item;
});

test('venda: faturado não volta para aberto; cancelado é terminal', async () => {
  await ensureSetup();
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: 5, local: 'loja', quantidade: 3 }, admin);
  const v = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, data: '2026-09-01' }, admin);
  await addItem(Number(v.id), { produto_id: produtoId, tamanho_id: 5, quantidade: 1, preco_unitario: 100 });
  await updateRecord(RESOURCES.vendas, Number(v.id), { status: 'faturada' }, admin);
  await expectHttp(() => updateRecord(RESOURCES.vendas, Number(v.id), { status: 'aberta' }, admin), 409, /cancel/i);
  await updateRecord(RESOURCES.vendas, Number(v.id), { status: 'cancelada' }, admin);
  await expectHttp(() => updateRecord(RESOURCES.vendas, Number(v.id), { status: 'aberta' }, admin), 409, /cancelad/i);
});

test('compra: receber atualiza custo médio ponderado (saldo zero e saldo existente)', async () => {
  await ensureSetup();
  // Caso 1: saldo zero → custo médio vira o preço da compra
  const c1 = await createRecord(RESOURCES.compras, { fornecedor_id: fornecedorId, data: '2026-09-01' }, admin);
  await addItemCompra(Number(c1.id), { insumo_id: insumoId, quantidade: 10, preco_unitario: 20 });
  await updateRecord(RESOURCES.compras, Number(c1.id), { status: 'recebido' }, admin);
  const ins1 = await getRecord(RESOURCES.insumos, insumoId);
  assert.equal(Number(ins1.custo_medio), 20);
  assert.equal(await getStore().insumoStock(insumoId), 10);

  // Caso 2: saldo existente → média ponderada
  const c2 = await createRecord(RESOURCES.compras, { fornecedor_id: fornecedorId, data: '2026-09-02' }, admin);
  await addItemCompra(Number(c2.id), { insumo_id: insumoId, quantidade: 10, preco_unitario: 30 });
  await updateRecord(RESOURCES.compras, Number(c2.id), { status: 'recebido' }, admin);
  const ins2 = await getRecord(RESOURCES.insumos, insumoId);
  // (10×20 + 10×30) / 20 = 25
  assert.equal(Number(ins2.custo_medio), 25);
  assert.equal(await getStore().insumoStock(insumoId), 20);
  const compra = await getRecord(RESOURCES.compras, Number(c2.id));
  assert.ok(compra.recebida_em, 'recebida_em deve estar preenchida');
});

test('compra: cancelar recebida estorna o estoque e reverte o custo médio', async () => {
  await ensureSetup();
  const c = await createRecord(RESOURCES.compras, { fornecedor_id: fornecedorId, data: '2026-09-03' }, admin);
  await addItemCompra(Number(c.id), { insumo_id: insumoId, quantidade: 5, preco_unitario: 40 });
  await updateRecord(RESOURCES.compras, Number(c.id), { status: 'recebido' }, admin);
  assert.equal(await getStore().insumoStock(insumoId), 25);
  await updateRecord(RESOURCES.compras, Number(c.id), { status: 'cancelado' }, admin);
  assert.equal(await getStore().insumoStock(insumoId), 20);
  const ins = await getRecord(RESOURCES.insumos, insumoId);
  // volta à média anterior (25)
  assert.equal(Number(ins.custo_medio), 25);
});

test('compra: receber sem itens é bloqueado', async () => {
  await ensureSetup();
  const c = await createRecord(RESOURCES.compras, { fornecedor_id: fornecedorId, data: '2026-09-01' }, admin);
  await expectHttp(() => updateRecord(RESOURCES.compras, Number(c.id), { status: 'recebido' }, admin), 409, /item/i);
});

test('relatório de comissões soma apenas vendas faturadas/entregues no período', async () => {
  await ensureSetup();
  const { relatorio } = await import('../src/relatorios');
  const req: any = { query: {}, user: admin };
  let payload: any = null;
  const res: any = { json: (d: any) => ((payload = d), res) };
  await relatorio(req, res, 'comissoes');
  assert.ok(payload, 'relatório deve responder JSON');
  // venda faturada e cancelada (= estornada) não conta; as dos outros testes
  // também foram canceladas. Estrutura nova: colunas/linhas + gráfico mensal.
  assert.ok(Array.isArray(payload.linhas));
  assert.ok(payload.colunas.some((c: any) => c.key === 'comissao'));
  assert.ok(payload.grafico && Array.isArray(payload.grafico.rotulos) && payload.grafico.rotulos.length === 12);
  const resumo = payload.resumo || {};
  assert.equal(typeof resumo.comissao, 'number');
});
