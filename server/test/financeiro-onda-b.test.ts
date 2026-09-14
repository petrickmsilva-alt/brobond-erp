// Testes da Onda B (modo memória — sem banco):
//   • Parcelamento real: venda/compra com N parcelas gera N lançamentos com
//     vencimentos mensais, centavos exatos e reconciliação na edição/cancelamento.
//   • Baixa dedicada: receber/pagar com juros, multa e desconto em lançamentos
//     filhos — caixa e DRE fecham com o extrato.
//   • Aging: envelhecimento do contas a receber por faixa de atraso.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getResource } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { syncLancamentoVenda, syncLancamentoCompra, baixarLancamento, resumoFinanceiro } = await import('../src/financeiro');
const { HttpError } = await import('../src/errors');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const, email: 'a@a' } as any;
const mockReq = (body: Record<string, unknown> = {}, params: Record<string, string> = {}) => ({ user: { id: 1, name: 'Admin', perfil: 'admin', email: 'a@a' }, body, params }) as any;
const mockRes = () => {
  const r: any = {};
  r.json = (d: any) => {
    r.data = d;
    return r;
  };
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  return r;
};

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

const hoje = new Date().toISOString().slice(0, 10);
const addDias = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

async function parcelasDe(tipo: string, refId: number) {
  const s = getStore();
  const lista = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 50, filter: { referencia_tipo: tipo, referencia_id: refId } });
  return lista.rows.sort((a: any, b: any) => Number(a.parcela) - Number(b.parcela));
}

const vendaFake = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  status: 'faturada',
  cliente_id: null,
  total: 300,
  fin_status: 'a_receber',
  fin_parcelas: 3,
  fin_vencimento: '2026-10-05',
  canal_venda: 'balcao',
  data: '2026-09-14',
  faturada_em: '2026-09-14',
  ...over,
});

before(async () => {
  getStore();
});

test('parcelamento real: 3x gera 3 lançamentos mensais com descrição x/3', async () => {
  const s = getStore();
  await s.transaction(async (tx: any) => syncLancamentoVenda(null, vendaFake(), {}, admin, tx));
  const parcelas = await parcelasDe('venda', 9001);
  assert.equal(parcelas.length, 3);
  assert.deepEqual(parcelas.map((p) => String(p.vencimento)), ['2026-10-05', '2026-11-05', '2026-12-05']);
  assert.deepEqual(parcelas.map((p) => Number(p.valor)), [100, 100, 100]);
  assert.deepEqual(parcelas.map((p) => Number(p.parcela)), [1, 2, 3]);
  assert.deepEqual(parcelas.map((p) => Number(p.total_parcelas)), [3, 3, 3]);
  assert.match(String(parcelas[0].descricao), /\(1\/3\)$/);
  for (const p of parcelas) assert.equal(p.status, 'pendente');
});

test('parcelamento real: centavos exatos (100 ÷ 3 = 33,33 + 33,33 + 33,34)', async () => {
  const s = getStore();
  await s.transaction(async (tx: any) => syncLancamentoVenda(null, vendaFake({ id: 9002, total: 100, fin_vencimento: '2026-10-10' }), {}, admin, tx));
  const parcelas = await parcelasDe('venda', 9002);
  assert.deepEqual(parcelas.map((p) => Number(p.valor)), [33.33, 33.33, 33.34]);
  assert.equal(parcelas.reduce((acc, p) => acc + Number(p.valor), 0), 100);
});

test('parcelamento real: vencimento mensal respeita fim do mês (31/01 → 28/02)', async () => {
  const s = getStore();
  await s.transaction(async (tx: any) => syncLancamentoVenda(null, vendaFake({ id: 9003, total: 200, fin_parcelas: 2, fin_vencimento: '2026-01-31' }), {}, admin, tx));
  const parcelas = await parcelasDe('venda', 9003);
  assert.deepEqual(parcelas.map((p) => String(p.vencimento)), ['2026-01-31', '2026-02-28']);
});

test('reconciliação: edição de total/parcelas ajusta; redução cancela excedente', async () => {
  const s = getStore();
  await s.transaction(async (tx: any) => syncLancamentoVenda(null, vendaFake({ id: 9001, total: 600, fin_parcelas: 2 }), {}, admin, tx));
  const parcelas = await parcelasDe('venda', 9001);
  assert.equal(parcelas.length, 3, 'a parcela 3 continua existindo, porém cancelada');
  assert.equal(parcelas[2].status, 'cancelado');
  const ativas = parcelas.filter((p) => p.status !== 'cancelado');
  assert.deepEqual(ativas.map((p) => Number(p.valor)), [300, 300]);
  assert.deepEqual(ativas.map((p) => Number(p.total_parcelas)), [2, 2]);
});

test('cancelamento do pedido cancela todas as parcelas (mesmo sem fin_status)', async () => {
  const s = getStore();
  await s.transaction(async (tx: any) => syncLancamentoVenda(null, vendaFake({ id: 9004, status: 'cancelada', fin_status: 'a_receber' }), {}, admin, tx));
  // pedido cancelado sem lançamento prévio: nada a criar
  await s.transaction(async (tx: any) => syncLancamentoVenda(null, vendaFake({ id: 9004 }), {}, admin, tx));
  let parcelas = await parcelasDe('venda', 9004);
  assert.equal(parcelas.length, 3);
  await s.transaction(async (tx: any) => syncLancamentoVenda(null, vendaFake({ id: 9004, status: 'cancelada' }), {}, admin, tx));
  parcelas = await parcelasDe('venda', 9004);
  for (const p of parcelas) assert.equal(p.status, 'cancelado');
});

test('compra: parcelamento real também vale para o contas a pagar', async () => {
  const s = getStore();
  const compraFake = { id: 8001, status: 'recebido', fornecedor_id: null, total: 450, fin_status: 'a_pagar', fin_parcelas: 3, fin_vencimento: '2026-10-20', data: '2026-09-14', recebida_em: '2026-09-14' };
  await s.transaction(async (tx: any) => syncLancamentoCompra(null, compraFake, {}, admin, tx));
  const parcelas = await parcelasDe('compra', 8001);
  assert.equal(parcelas.length, 3);
  assert.deepEqual(parcelas.map((p) => String(p.tipo)), ['despesa', 'despesa', 'despesa']);
  assert.equal(parcelas.reduce((acc, p) => acc + Number(p.valor), 0), 450);
});

test('baixa dedicada: juros/multa/desconto viram filhos e o caixa fecha no centavo', async () => {
  const lanc = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'receita', conta_id: 2, descricao: 'Cobrança teste baixa', valor: 1000, status: 'pendente', vencimento: addDias(hoje, -5) },
    admin
  );
  const id = Number(lanc.id);

  // caixa da conta 2 antes da baixa
  const antes = mockRes();
  await resumoFinanceiro(mockReq(), antes);
  const saldoAntes = antes.data.saldoContas.find((c: any) => c.conta_id === 2).saldo;

  const res = mockRes();
  await baixarLancamento(mockReq({ juros: 50, multa: 0, desconto: 100, conta_id: 2, forma_pagamento: 'pix' }, { id: String(id) }), res);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.filhos.length, 2, 'juros + desconto geram 2 filhos');

  const s = getStore();
  const principal = await s.get(getResource('lancamentos_financeiros')!, id);
  assert.equal(principal!.status, 'confirmado');
  assert.match(String(principal!.observacoes), /Baixa em/);

  const filhos = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 10, filter: { referencia_tipo: 'baixa', referencia_id: id } });
  const juros = filhos.rows.find((f) => String(f.descricao).includes('Juros/multa'))!;
  const desconto = filhos.rows.find((f) => String(f.descricao).includes('Desconto'))!;
  assert.equal(juros.tipo, 'receita');
  assert.equal(Number(juros.valor), 50);
  assert.equal(desconto.tipo, 'despesa');
  assert.equal(Number(desconto.valor), 100);

  // caixa: +1000 principal + 50 juros − 100 desconto = 950
  const depois = mockRes();
  await resumoFinanceiro(mockReq(), depois);
  const saldoDepois = depois.data.saldoContas.find((c: any) => c.conta_id === 2).saldo;
  assert.equal(Math.round((saldoDepois - saldoAntes) * 100) / 100, 950);
});

test('baixa dedicada: regras — pendente apenas, valores não negativos', async () => {
  const lanc = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'despesa', conta_id: 2, descricao: 'Pagamento teste baixa', valor: 200, status: 'confirmado' },
    admin
  );
  const id = String(lanc.id);
  await expectHttp(() => baixarLancamento(mockReq({}, { id }), mockRes()), 409, /pendentes/);

  const pendente = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'despesa', conta_id: 2, descricao: 'Pagamento teste baixa 2', valor: 200, status: 'pendente' },
    admin
  );
  await expectHttp(() => baixarLancamento(mockReq({ juros: -10 }, { id: String(pendente.id) }), mockRes()), 400, /juros/);

  // baixa de despesa com desconto: filho é RECEITA (desconto obtido)
  const res = mockRes();
  await baixarLancamento(mockReq({ desconto: 15 }, { id: String(pendente.id) }), res);
  const s = getStore();
  const filhos = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 10, filter: { referencia_tipo: 'baixa', referencia_id: Number(pendente.id) } });
  assert.equal(filhos.rows[0].tipo, 'receita');
  assert.match(String(filhos.rows[0].descricao), /Desconto obtido/);
});

test('aging: faixas de atraso do contas a receber somam corretamente', async () => {
  const base = mockRes();
  await resumoFinanceiro(mockReq(), base);
  const faixasAntes = base.data.agingReceber.faixas;

  const mk = (vencimento: string, valor: number, descricao: string) =>
    createRecord(RESOURCES.lancamentos_financeiros, { data: hoje, tipo: 'receita', conta_id: 2, descricao, valor, status: 'pendente', vencimento }, admin);
  await mk(addDias(hoje, -10), 100, 'Aging 10d');
  await mk(addDias(hoje, -45), 200, 'Aging 45d');
  await mk(addDias(hoje, -75), 300, 'Aging 75d');
  await mk(addDias(hoje, -120), 400, 'Aging 120d');
  await mk(addDias(hoje, 15), 500, 'Aging futuro');

  const res = mockRes();
  await resumoFinanceiro(mockReq(), res);
  const f = res.data.agingReceber.faixas;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  assert.equal(r2(f.vencido_1_30 - faixasAntes.vencido_1_30), 100);
  assert.equal(r2(f.vencido_31_60 - faixasAntes.vencido_31_60), 200);
  assert.equal(r2(f.vencido_61_90 - faixasAntes.vencido_61_90), 300);
  assert.equal(r2(f.vencido_90_mais - faixasAntes.vencido_90_mais), 400);
  assert.equal(r2(f.a_vencer - faixasAntes.a_vencer), 500);
  assert.ok(Array.isArray(res.data.agingReceber.clientes));
});
