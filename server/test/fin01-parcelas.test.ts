// ============================================================================
// FIN-01 / P1-03 — PARCELAS VÁLIDAS NO SERVIDOR (modo memória).
//
// A auditoria forense provou que combinações de total × parcelas geravam parcela
// ZERO ou NEGATIVA: R$ 0,01 em 3x virava [0, 0, 0.01] e o centavo residual de
// totais pequenos com muitas parcelas produzia valor negativo na última.
// No MemStore isso era persistido; no PostgreSQL o CHECK valor > 0 recusava —
// ou seja, os dois stores DIVERGIAM e a regra dependia do banco para aparecer.
//
// Este teste prova, no fluxo de serviço REAL (`syncLancamentoVenda` /
// `syncLancamentoCompra` dentro da transação), que:
//   A) nenhuma parcela é <= 0;
//   B) a soma é EXATAMENTE o total (sem perder/ganhar centavo);
//   C) o centavo residual vai para a última parcela, de forma determinística;
//   D) total zero é rejeitado (nada é persistido);
//   E) total negativo é rejeitado;
//   F) parcelas = 0 é rejeitado;
//   G) parcelas negativo é rejeitado;
//   H) parcelas fracionário é rejeitado;
//   I) total < número de parcelas é rejeitado;
//   J) a falha acontece ANTES da persistência (atomicidade: nada sobra);
//   K) rollback completo (contagem de lançamentos permanece 0);
//   L) a MESMA regra canônica é usada para venda e compra;
//   M) retry não duplica;
//   O) desconto/juros/frete (já embutidos no total) não quebram a invariância.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { ADMIN, garantirAdmin } = await import('./_p1util');
const fin = await import('../src/financeiro');

await garantirAdmin();

const s = getStore();
const hoje = new Date().toISOString().slice(0, 10);

/** Soma em CENTAVOS inteiros — imune ao ruído de ponto flutuante. */
function somaCentavos(valores: number[]): number {
  return Math.round(valores.reduce((a, b) => a + Number(b), 0) * 100);
}

async function parcelasDe(tipo: string, refId: number) {
  const lista = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 100, filter: { referencia_tipo: tipo, referencia_id: refId } });
  return lista.rows.sort((a: any, b: any) => Number(a.parcela) - Number(b.parcela));
}

const venda = (over: Record<string, unknown> = {}) => ({
  id: 7001,
  status: 'faturada',
  cliente_id: null,
  total: 100,
  fin_status: 'a_receber',
  fin_parcelas: 1,
  fin_vencimento: '2026-11-01',
  canal_venda: 'balcao',
  data: hoje,
  faturada_em: hoje,
  ...over,
});

/** Executa a reconciliação da venda dentro de uma transação real (rollback se falhar). */
async function sincronizarVenda(campos: Record<string, unknown>) {
  const v = venda(campos);
  await s.transaction(async (tx) => fin.syncLancamentoVenda(null, v, {}, ADMIN, tx));
  return v;
}

// ----------------------------------------------------------------------------
// 1) FUNÇÃO CANÔNICA — casos limite do enunciado (A–I, L, O).
// ----------------------------------------------------------------------------

test('FIN-01 canônica: R$ 10.000,00 em 1x = [10000]', () => {
  assert.deepEqual(fin.dividirParcelas(10000, 1), [10000]);
});

test('FIN-01 canônica: R$ 10.000,00 em 2x = [5000, 5000]', () => {
  assert.deepEqual(fin.dividirParcelas(10000, 2), [5000, 5000]);
});

test('FIN-01 canônica: R$ 100,00 em 3x = [33,33, 33,33, 33,34] (10000 centavos exatos)', () => {
  const p = fin.dividirParcelas(100, 3);
  assert.deepEqual(p, [33.33, 33.33, 33.34]);
  assert.equal(somaCentavos(p), 10000);
});

test('FIN-01 canônica: 1 centavo / 1 = [0.01]', () => {
  assert.deepEqual(fin.dividirParcelas(0.01, 1), [0.01]);
});

test('FIN-01 canônica: 1 centavo em 2x e 3x é IMPOSSÍVEL (rejeita, não zera parcela)', () => {
  assert.throws(() => fin.dividirParcelas(0.01, 2), /zerada/);
  assert.throws(() => fin.dividirParcelas(0.01, 3), /zerada/);
});

test('FIN-01 canônica: 1 centavo em 100x é IMPOSSÍVEL (rejeita)', () => {
  assert.throws(() => fin.dividirParcelas(0.01, 100), /zerada/);
});

test('FIN-01 canônica: R$ 1,00 em 100x = 100 parcelas de 1 centavo (soma exata)', () => {
  const p = fin.dividirParcelas(1, 100);
  assert.equal(p.length, 100);
  assert.ok(p.every((v) => v === 0.01), 'todas as parcelas precisam ser 1 centavo');
  assert.equal(somaCentavos(p), 100);
});

test('FIN-01 canônica: parcelas = 0, negativo ou fracionário são rejeitados', () => {
  assert.throws(() => fin.dividirParcelas(100, 0), /inteiro maior ou igual a 1/);
  assert.throws(() => fin.dividirParcelas(100, -1), /inteiro maior ou igual a 1/);
  assert.throws(() => fin.dividirParcelas(100, 2.5), /inteiro maior ou igual a 1/);
});

test('FIN-01 canônica: total zero ou negativo é rejeitado', () => {
  assert.throws(() => fin.dividirParcelas(0, 1), /maior que zero/);
  assert.throws(() => fin.dividirParcelas(-1, 1), /maior que zero/);
});

test('FIN-01 canônica: total < número de parcelas é rejeitado (0,02 em 3x)', () => {
  assert.throws(() => fin.dividirParcelas(0.02, 3), /zerada/);
});

test('FIN-01 canônica: 0,10 em 3x é VÁLIDO = [0,03, 0,03, 0,04] (10 centavos ≥ 3)', () => {
  const p = fin.dividirParcelas(0.1, 3);
  assert.deepEqual(p, [0.03, 0.03, 0.04]);
  assert.equal(somaCentavos(p), 10);
});

test('FIN-01 canônica: valores grandes dentro do limite (1.000.000 em 7x) somam exato', () => {
  const p = fin.dividirParcelas(1_000_000, 7);
  assert.equal(p.length, 7);
  assert.equal(somaCentavos(p), 100_000_000);
  assert.ok(p.every((v) => v > 0));
});

test('FIN-01 canônica: 35,56 em 3x = [11,85, 11,85, 11,86] (resíduo na última)', () => {
  assert.deepEqual(fin.dividirParcelas(35.56, 3), [11.85, 11.85, 11.86]);
});

test('FIN-01 canônica: múltiplas chamadas idênticas são determinísticas', () => {
  const a = fin.dividirParcelas(100, 3);
  const b = fin.dividirParcelas(100, 3);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [33.33, 33.33, 33.34]);
});

// ----------------------------------------------------------------------------
// 2) FLUXO DE SERVIÇO REAL — venda faturada (persistência em memória).
// ----------------------------------------------------------------------------

test('FIN-01 venda: 100,00 em 3x persiste [33,33, 33,33, 33,34] e soma 100', async () => {
  await sincronizarVenda({ id: 7101, total: 100, fin_parcelas: 3 });
  const p = await parcelasDe('venda', 7101);
  assert.deepEqual(p.map((x) => Number(x.valor)), [33.33, 33.33, 33.34]);
  assert.equal(somaCentavos(p.map((x) => Number(x.valor))), 10000);
  assert.ok(p.every((x) => Number(x.valor) > 0));
});

test('FIN-01 venda: R$ 10.000,00 em 3x persiste [3333,33, 3333,33, 3333,34]', async () => {
  await sincronizarVenda({ id: 7102, total: 10000, fin_parcelas: 3 });
  const p = await parcelasDe('venda', 7102);
  assert.deepEqual(p.map((x) => Number(x.valor)), [3333.33, 3333.33, 3333.34]);
  assert.equal(somaCentavos(p.map((x) => Number(x.valor))), 1_000_000);
});

test('FIN-01 venda: 0,02 em 2x = [0,01, 0,01] (cada parcela positiva)', async () => {
  await sincronizarVenda({ id: 7103, total: 0.02, fin_parcelas: 2 });
  const p = await parcelasDe('venda', 7103);
  assert.deepEqual(p.map((x) => Number(x.valor)), [0.01, 0.01]);
});

test('FIN-01 venda: 0,01 em 1x = [0,01]', async () => {
  await sincronizarVenda({ id: 7104, total: 0.01, fin_parcelas: 1 });
  const p = await parcelasDe('venda', 7104);
  assert.deepEqual(p.map((x) => Number(x.valor)), [0.01]);
});

test('FIN-01 venda: R$ 1,00 em 60x mantém todas as parcelas positivas e soma exata', async () => {
  // O serviço limita o plano a 60 parcelas (regra pré-existente de
  // `reconciliarParcelasPedido`); a canônica aceita 100x, exercitada acima.
  await sincronizarVenda({ id: 7105, total: 1, fin_parcelas: 60 });
  const p = await parcelasDe('venda', 7105);
  assert.equal(p.length, 60);
  assert.ok(p.every((x) => Number(x.valor) > 0), 'nenhuma parcela pode ser zero');
  assert.equal(somaCentavos(p.map((x) => Number(x.valor))), 100);
});

// ----------------------------------------------------------------------------
// 3) ATOMICIDADE — a rejeição acontece ANTES de qualquer persistência.
// ----------------------------------------------------------------------------

test('FIN-01 atomicidade: 0,01 em 3x falha e NENHUMA parcela é criada', async () => {
  await assert.rejects(
    () => sincronizarVenda({ id: 7201, total: 0.01, fin_parcelas: 3 }),
    (e: any) => e.status === 422 && /zerada/.test(e.message)
  );
  assert.equal((await parcelasDe('venda', 7201)).length, 0, 'a falha não pode deixar parcela');
});

test('FIN-01 atomicidade: 0,02 em 3x (total < parcelas) falha sem persistir', async () => {
  await assert.rejects(
    () => sincronizarVenda({ id: 7202, total: 0.02, fin_parcelas: 3 }),
    (e: any) => e.status === 422 && /zerada/.test(e.message)
  );
  assert.equal((await parcelasDe('venda', 7202)).length, 0);
});

test('FIN-01 atomicidade: total zero NÃO cria parcela (nem zero, nem cancelada)', async () => {
  await sincronizarVenda({ id: 7203, total: 0, fin_parcelas: 1 });
  assert.equal((await parcelasDe('venda', 7203)).length, 0);
});

test('FIN-01 atomicidade: total negativo não cria parcela', async () => {
  await sincronizarVenda({ id: 7204, total: -5, fin_parcelas: 1 });
  assert.equal((await parcelasDe('venda', 7204)).length, 0);
});

// ----------------------------------------------------------------------------
// 4) COMPRA — a MESMA regra canônica vale para o contas a pagar.
// ----------------------------------------------------------------------------

test('FIN-01 compra: 100,00 em 3x soma exato; 0,01 em 3x é rejeitado', async () => {
  const compraOk = { id: 7301, status: 'recebido', fornecedor_id: null, total: 100, fin_status: 'a_pagar', fin_parcelas: 3, fin_vencimento: '2026-11-01', data: hoje, recebida_em: hoje };
  await s.transaction(async (tx) => fin.syncLancamentoCompra(null, compraOk, {}, ADMIN, tx));
  const p = await parcelasDe('compra', 7301);
  assert.deepEqual(p.map((x) => Number(x.valor)), [33.33, 33.33, 33.34]);
  assert.equal(somaCentavos(p.map((x) => Number(x.valor))), 10000);

  const compraRuim = { ...compraOk, id: 7302, total: 0.01, fin_parcelas: 3 };
  await assert.rejects(() => s.transaction(async (tx) => fin.syncLancamentoCompra(null, compraRuim, {}, ADMIN, tx)), (e: any) => e.status === 422);
  assert.equal((await parcelasDe('compra', 7302)).length, 0);
});

// ----------------------------------------------------------------------------
// 5) IDEMPOTÊNCIA / RETRY — repetir a mesma operação não duplica.
// ----------------------------------------------------------------------------

test('FIN-01 retry: reconciliar a mesma venda duas vezes não duplica parcelas', async () => {
  await sincronizarVenda({ id: 7401, total: 100, fin_parcelas: 3 });
  await sincronizarVenda({ id: 7401, total: 100, fin_parcelas: 3 });
  const p = await parcelasDe('venda', 7401);
  assert.equal(p.length, 3, 'o retry não pode criar um segundo plano de parcelas');
  assert.deepEqual(p.map((x) => Number(x.valor)), [33.33, 33.33, 33.34]);
});

// ----------------------------------------------------------------------------
// 6) DESCONTO + JUROS + FRETE — já embutidos no total, a soma continua exata.
// ----------------------------------------------------------------------------

test('FIN-01 desconto/juros/frete: total 100,01 em 3x mantém Σ === total', async () => {
  // O total já chega calculado (itens − desconto + frete + juros); aqui provamos
  // que o parcelamento não introduz nem perde centavo sobre esse total.
  await sincronizarVenda({ id: 7501, total: 100.01, fin_parcelas: 3 });
  const p = await parcelasDe('venda', 7501);
  assert.equal(somaCentavos(p.map((x) => Number(x.valor))), 10001);
  assert.ok(p.every((x) => Number(x.valor) > 0));
});

test('FIN-01 detalhes do XML: duplicatas positivas mandam; a última fecha o total', async () => {
  // Duplicatas do documento (ex.: 40 + 30 + 30,01) devem ser respeitadas.
  await sincronizarVenda({ id: 7502, total: 100.01, fin_parcelas: 3, fin_parcelas_detalhes: [{ parcela: 1, valor: 40 }, { parcela: 2, valor: 30 }, { parcela: 3, valor: 30.01 }] });
  const p = await parcelasDe('venda', 7502);
  assert.deepEqual(p.map((x) => Number(x.valor)), [40, 30, 30.01]);
  assert.equal(somaCentavos(p.map((x) => Number(x.valor))), 10001);
});
