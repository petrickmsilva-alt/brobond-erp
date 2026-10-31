// ============================================================================
// PREVISÃO DE DEMANDA — série mensal de 6 meses (prediction.ts).
//
// Regressão do defeito de fim de mês: `new Date(); setMonth(getMonth() - m)`
// "transborda" quando o dia atual é 29–31 (31/10 → m=1 vira 01/10, repetindo
// "2026-10"), e o MESMO mês entrava duas vezes na série — dobrando o histórico
// e inflando a demanda prevista. O teste roda em QUALQUER dia: usa a data real
// e exige que os 6 meses sejam DISTINTOS e que a venda do mês corrente conte
// uma única vez.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { chamar, criarAtor, garantirAdmin, reqDe } = await import('./_p1util');
const prediction = await import('../src/prediction');

await garantirAdmin();
const s = getStore();
const gerente = await criarAtor(1, 'gerente');

test('previsão: a série mensal cobre 6 meses distintos e não duplica o mês corrente', async () => {
  const produto = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: 'PRED-SERIE-1', nome: 'Produto Série', preco_venda: 100, custo: 40, ativo: true });
  const cliente = await s.insert(RESOURCES.clientes, { empresa_id: 1, nome: 'Cliente Série', tipo: 'pf', ativo: true });
  const hoje = new Date().toISOString().slice(0, 10);
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    cliente_id: Number(cliente.id),
    data: hoje,
    status: 'faturada',
    faturada_em: new Date().toISOString(),
    total: 700,
  });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(produto.id), tamanho_id: null, quantidade: 7, preco_unitario: 100, subtotal: 700 });
  await s.insert(RESOURCES.estoques, { empresa_id: 1, produto_id: Number(produto.id), tamanho_id: null, local: 'loja', quantidade: 0, custo_medio: 40 });

  const prev = await chamar(prediction.predicaoDemanda, reqDe({}, { user: gerente, query: { dias: 30 } }));
  const linha = prev.previsoes.find((l: any) => Number(l.id) === Number(produto.id));
  assert.ok(linha, 'o produto aparece na previsão');

  // 7 unidades vendidas UMA vez — não 14 (mês contado duas vezes).
  assert.equal(Number(linha.vendas_6m), 7, 'a venda do mês corrente conta uma única vez');
  assert.equal(linha.vendas_por_mes.length, 6, 'a série tem 6 meses');

  // A série (mais antigo → mais recente) tem o total exatamente no último mês
  // e zero nos demais: se um mês se repetisse, haveria dois valores iguais a 7.
  const serie = linha.vendas_por_mes.map((n: any) => Number(n));
  assert.equal(serie.reduce((a: number, b: number) => a + b, 0), 7, 'nada é contado em dobro');
  assert.equal(serie.filter((n: number) => n === 7).length, 1, 'exatamente um mês carrega a venda');
});
