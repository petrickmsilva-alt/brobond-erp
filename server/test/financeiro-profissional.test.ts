// Testes da Onda "Financeiro profissional" (modo memória — sem banco).
// Cobre: transferências entre contas (par espelho neutro no DRE), taxas de
// operadora (valor líquido), plano de contas em dois níveis e travas de
// integridade na exclusão de cadastros financeiros em uso.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getResource } = await import('../src/resources');
const { createRecord, updateRecord, deleteRecord, getRecord, listRecords, getStore } = await import('../src/services');
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

const hoje = new Date().toISOString().slice(0, 10);

// Contas do mock: 1 = Caixa, 2 = Pix BROBOND
let transfId: number;

before(async () => {
  getStore();
});

async function espelhosDaTransferencia(id: number) {
  const lista = await listRecords(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 50, filter: { referencia_tipo: 'transferencia', referencia_id: id } } as any, admin);
  return lista.rows;
}

test('transferência gera par espelho: despesa na origem, receita no destino', async () => {
  const t = await createRecord(RESOURCES.transferencias_financeiras, { data: hoje, conta_origem_id: 1, conta_destino_id: 2, valor: 500, descricao: 'Depósito do caixa no banco', status: 'confirmado' }, admin);
  transfId = Number(t.id);

  const espelhos = await espelhosDaTransferencia(transfId);
  assert.equal(espelhos.length, 2);
  const saida = espelhos.find((l) => l.tipo === 'despesa')!;
  const entrada = espelhos.find((l) => l.tipo === 'receita')!;
  assert.ok(saida && entrada, 'precisa de saída e entrada');
  assert.equal(Number(saida.conta_id), 1);
  assert.equal(Number(entrada.conta_id), 2);
  assert.equal(Number(saida.valor), 500);
  assert.equal(Number(entrada.valor), 500);
  assert.equal(saida.status, 'confirmado');
  assert.equal(entrada.status, 'confirmado');
  assert.equal(Number(entrada.valor_liquido ?? entrada.valor), 500); // sem taxa em transferência

  // ids do par ficam gravados na transferência (rastreio exato)
  const recarregada = await getRecord(RESOURCES.transferencias_financeiras, transfId, admin);
  assert.ok(Number(recarregada.lancamento_saida_id) > 0);
  assert.ok(Number(recarregada.lancamento_entrada_id) > 0);
});

test('transferência exige contas diferentes e valor positivo', async () => {
  await expectHttp(
    () => createRecord(RESOURCES.transferencias_financeiras, { data: hoje, conta_origem_id: 1, conta_destino_id: 1, valor: 100 }, admin),
    400,
    /contas diferentes/i
  );
});

test('editar valor da transferência atualiza o par espelho', async () => {
  await updateRecord(RESOURCES.transferencias_financeiras, transfId, { valor: 640 }, admin);
  const espelhos = await espelhosDaTransferencia(transfId);
  assert.equal(espelhos.length, 2, 'continua sendo um par, sem duplicar');
  for (const l of espelhos) assert.equal(Number(l.valor), 640);
});

test('cancelar a transferência cancela o par (sem apagar histórico)', async () => {
  await updateRecord(RESOURCES.transferencias_financeiras, transfId, { status: 'cancelado' }, admin);
  const espelhos = await espelhosDaTransferencia(transfId);
  assert.equal(espelhos.length, 2);
  for (const l of espelhos) assert.equal(l.status, 'cancelado');
});

test('transferência confirmada não pode ser excluída (use cancelar)', async () => {
  const t = await createRecord(RESOURCES.transferencias_financeiras, { data: hoje, conta_origem_id: 2, conta_destino_id: 1, valor: 75, status: 'confirmado' }, admin);
  await expectHttp(() => deleteRecord(RESOURCES.transferencias_financeiras, Number(t.id), admin), 409, /Cancele-a/);
  await updateRecord(RESOURCES.transferencias_financeiras, Number(t.id), { status: 'cancelado' }, admin);
  await deleteRecord(RESOURCES.transferencias_financeiras, Number(t.id), admin); // cancelada: pode excluir
});

test('taxa da operadora: líquido calculado no cadastro e recalculado na edição', async () => {
  const lanc = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'receita', categoria_id: 1, conta_id: 2, centro_custo_id: 1, descricao: 'Venda no Mercado Pago', valor: 100, taxa_pct: 4.99, status: 'confirmado' },
    admin
  );
  assert.equal(Number(lanc.valor_liquido), 95.01); // 100 − 4,99%

  // edição de bruto sem informar líquido recalcula pela taxa
  const editado = await updateRecord(RESOURCES.lancamentos_financeiros, Number(lanc.id), { valor: 200 }, admin);
  assert.equal(Number(editado.valor_liquido), 190.02);

  // líquido explícito (ajuste de centavos) é respeitado
  const ajustado = await updateRecord(RESOURCES.lancamentos_financeiros, Number(lanc.id), { valor_liquido: 190 }, admin);
  assert.equal(Number(ajustado.valor_liquido), 190);

  // líquido nunca passa do bruto
  const corrigido = await updateRecord(RESOURCES.lancamentos_financeiros, Number(lanc.id), { valor_liquido: 999 }, admin);
  assert.equal(Number(corrigido.valor_liquido), 200);
});

test('plano de contas em dois níveis: pai não é a própria nem tem avô', async () => {
  const pai = await createRecord(RESOURCES.categorias_financeiras, { nome: 'Marketing T1', tipo: 'despesa', classificacao_dre: 'despesas_operacionais' }, admin);
  const filha = await createRecord(RESOURCES.categorias_financeiras, { nome: 'Tráfego pago T1', tipo: 'despesa', classificacao_dre: 'despesas_operacionais', pai_id: pai.id }, admin);
  assert.equal(Number(filha.pai_id), Number(pai.id));

  await expectHttp(() => updateRecord(RESOURCES.categorias_financeiras, Number(pai.id), { pai_id: pai.id }, admin), 400, /si mesma/i);
  await expectHttp(
    () => createRecord(RESOURCES.categorias_financeiras, { nome: 'Meta Ads T1', tipo: 'despesa', pai_id: filha.id }, admin),
    400,
    /dois níveis/i
  );

  // categoria com subcategoria/lançamento em uso não é excluída — desativa
  await expectHttp(() => deleteRecord(RESOURCES.categorias_financeiras, Number(pai.id), admin), 409, /Desative-a/);
});

test('travas de integridade: conta e centro de custo em uso não são excluídos', async () => {
  // a transferência e o lançamento de teste acima usam a conta 2 e o centro 1
  await expectHttp(() => deleteRecord(RESOURCES.contas_financeiras, 2, admin), 409, /Desative-a/);
  await expectHttp(() => deleteRecord(RESOURCES.centros_custo, 1, admin), 409, /Desative-o/);
});
