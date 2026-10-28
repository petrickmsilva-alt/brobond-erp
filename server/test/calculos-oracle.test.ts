// ============================================================================
// HOMOLOGAÇÃO FINAL — CÁLCULOS CRÍTICOS COM ORÁCULO INDEPENDENTE
// ----------------------------------------------------------------------------
// Regra deste arquivo: o valor esperado NUNCA é produzido pela função que está
// sendo testada. Cada expectativa é derivada de uma fórmula escrita de novo no
// teste (aritmética em centavos inteiros ou fração explícita) a partir do
// enunciado de negócio. Se a implementação divergir do oráculo, o teste falha.
//
// Cobertura:
//   A) custo médio ponderado (primeira entrada, entradas sucessivas, custo zero,
//      estoque zero, arredondamento, propriedade de convergência);
//   B) rateio de frete (Σ rateio === frete, pedido zerado, frete zero, resíduo);
//   C) custo unitário efetivo (frete/imposto por unidade, divisão por zero);
//   D) disponibilidade canônica (disponível = físico − reservado − bloqueado −
//      empenho) e reflexo no faturamento de venda;
//   E) invariante de estoque: saldo = Σ eventos (entrada − saída ± ajuste);
//   F) parcelas (Σ === total, resíduo na última, sem parcela zerada);
//   G) preço de venda: bruto/desconto/subtotal/total e margem × markup.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { mediaPonderada, ratearFretePorValor, custoUnitarioEfetivo } = await import('../src/custoRecebimento');
const { dividirParcelas } = await import('../src/financeiro');
const { linhaDePreco, resumoVenda, pctDeDescontoUnitario, precoLiquidoDePct } = await import('../src/precoVenda');
const { saldoVendavel, saldoDisponivelCelula } = await import('../src/estoqueCanonico');
const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, listRecords, getStore } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarReserva } = await import('../src/estoqueTransferencia');
const { garantirAdmin } = await import('./_p1util');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
const empresaA = escopoDeSistema(1);

/** Arredonda em centavos por aritmética inteira (oráculo, não usa round2 do ERP). */
const centavos = (v: number) => Math.round(v * 100) / 100;

before(async () => {
  await garantirAdmin();
});

// ---------------------------------------------------------------------------
// A) CUSTO MÉDIO PONDERADO
//   novo = (saldo_ant × custo_ant + entrada × custo_entrada) / (saldo_ant + entrada)
// ---------------------------------------------------------------------------
test('custo médio: primeira entrada em estoque zerado assume o custo da entrada', () => {
  // Oráculo: (0×0 + 10×12) / 10 = 12
  const esperado = centavos((0 * 0 + 10 * 12) / (0 + 10));
  assert.equal(mediaPonderada(0, 0, 10, 12), esperado);
  // Custo anterior "sujo" com saldo zero NÃO contamina a média.
  assert.equal(mediaPonderada(0, 99.99, 10, 12), 12);
});

test('custo médio: entradas sucessivas convergem para a média ponderada exata', () => {
  // 10 un a 12,00 → 20,00; entram 5 un a 18,00
  const primeira = centavos((0 * 0 + 10 * 12) / 10); // 12,00
  const segunda = centavos((10 * primeira + 5 * 18) / 15); // (120+90)/15 = 14,00
  assert.equal(mediaPonderada(10, primeira, 5, 18), segunda);
  assert.equal(segunda, 14);

  // Terceira entrada fracionária: 3 un a 21,37
  const terceira = centavos((15 * segunda + 3 * 21.37) / 18); // (210 + 64,11)/18 = 15,2283… → 15,23
  assert.equal(mediaPonderada(15, segunda, 3, 21.37), terceira);
  assert.equal(terceira, 15.23);
});

test('custo médio: entrada de custo ZERO reduz a média (não zera nem ignora)', () => {
  // 10 a 20,00 + 10 a 0,00 = média 10,00 (doação/bonificação não é grátis em média)
  assert.equal(mediaPonderada(10, 20, 10, 0), centavos((10 * 20 + 10 * 0) / 20));
  assert.equal(mediaPonderada(10, 20, 10, 0), 10);
});

test('custo médio: nunca divide por zero (quantidade inválida e saldo negativo)', () => {
  // quantidade 0 com saldo 0 → devolve o custo informado, sem NaN/Infinity
  const r = mediaPonderada(0, 5, 0, 7.5);
  assert.ok(Number.isFinite(r));
  assert.equal(r, 7.5);
  // saldo negativo histórico (−5) + entrada 5 → denominador 0 → custo da entrada
  assert.equal(mediaPonderada(-5, 9, 5, 11), 11);
  assert.ok(!Number.isNaN(mediaPonderada(0, 0, 0, 0)));
});

test('custo médio: propriedade — média fica SEMPRE entre o menor e o maior custo', () => {
  const casos: [number, number, number, number][] = [
    [0, 0, 1, 100],
    [7, 3.33, 5, 9.99],
    [1000, 0.01, 1, 999.99],
    [3, 12.5, 1000, 0.02],
    [1, 1, 1, 1],
  ];
  for (const [saldo, custoAnt, qtd, custoNovo] of casos) {
    const media = mediaPonderada(saldo, custoAnt, qtd, custoNovo);
    const menor = Math.min(custoAnt, custoNovo);
    const maior = Math.max(custoAnt, custoNovo);
    assert.ok(media >= centavos(menor) && media <= maior + 0.01, `média ${media} fora de [${menor}, ${maior}]`);
  }
});

// ---------------------------------------------------------------------------
// B) RATEIO DE FRETE POR VALOR — Σ rateio === frete, ao centavo
// ---------------------------------------------------------------------------
test('rateio de frete: a soma das parcelas é EXATAMENTE o frete (resíduo na última)', () => {
  // 3 linhas iguais dividindo 10,00: sem o resíduo daria 9,99 ou 10,02.
  const linhas = [
    { item_compra_id: 1, quantidade: 1, preco_unitario: 100 },
    { item_compra_id: 2, quantidade: 1, preco_unitario: 100 },
    { item_compra_id: 3, quantidade: 1, preco_unitario: 100 },
  ];
  const frete = 10;
  const mapa = ratearFretePorValor(frete, linhas);
  const soma = [...mapa.values()].reduce((a, b) => a + b, 0);
  assert.equal(Math.round(soma * 100), Math.round(frete * 100)); // 10,00 ao centavo
  // As duas primeiras linhas têm o mesmo valor → mesma parcela
  assert.equal(mapa.get(1), mapa.get(2));
});

test('rateio de frete: proporcional ao valor da linha (não à quantidade)', () => {
  const linhas = [
    { item_compra_id: 1, quantidade: 10, preco_unitario: 1 }, // valor 10
    { item_compra_id: 2, quantidade: 1, preco_unitario: 90 }, // valor 90
  ];
  const mapa = ratearFretePorValor(100, linhas);
  // oráculo: 100 × 10/100 = 10 · 100 × 90/100 = 90
  assert.equal(mapa.get(1), 10);
  assert.equal(mapa.get(2), 90);
});

test('rateio de frete: frete zero, pedido zerado e lista vazia não dividem por zero', () => {
  const linhas = [
    { item_compra_id: 1, quantidade: 1, preco_unitario: 0 },
    { item_compra_id: 2, quantidade: 2, preco_unitario: 0 },
  ];
  assert.deepEqual([...ratearFretePorValor(50, linhas).values()], [0, 0]);
  assert.deepEqual([...ratearFretePorValor(0, linhas).values()], [0, 0]);
  assert.equal(ratearFretePorValor(50, []).size, 0);
});

// ---------------------------------------------------------------------------
// C) CUSTO UNITÁRIO EFETIVO = preço + (frete + impostos) / quantidade
// ---------------------------------------------------------------------------
test('custo unitário efetivo: frete e imposto entram por unidade', () => {
  // oráculo: 40 + (30 + 10) / 4 = 50,00
  assert.equal(custoUnitarioEfetivo(40, 4, 30, 10), centavos(40 + (30 + 10) / 4));
  assert.equal(custoUnitarioEfetivo(40, 4, 30, 10), 50);
  // sem frete/imposto, o custo é o preço
  assert.equal(custoUnitarioEfetivo(12.34, 3), 12.34);
});

test('custo unitário efetivo: quantidade inválida e valores negativos são recusados', () => {
  assert.throws(() => custoUnitarioEfetivo(10, 0), /Quantidade inválida/);
  assert.throws(() => custoUnitarioEfetivo(-1, 2), /negativo/);
  assert.throws(() => custoUnitarioEfetivo(10, 2, -1), /negativo/);
  assert.throws(() => custoUnitarioEfetivo(10, 2, 0, -1), /negativo/);
});

// ---------------------------------------------------------------------------
// D) DISPONIBILIDADE = FÍSICO − RESERVADO − EMPENHADO − BLOQUEADO
// ---------------------------------------------------------------------------
test('disponibilidade: bloqueio de qualidade reduz o disponível e é o que o faturamento baixa', async () => {
  const produto = await createRecord(RESOURCES.produtos, { sku: `ORAC-${Date.now()}-1`, nome: 'Oráculo Bloqueio', preco_venda: 100 }, admin);
  const produtoId = Number(produto.id);
  const local = (await listRecords(RESOURCES.locais, { page: 1, pageSize: 1 })).rows[0];
  const localId = Number(local.id);

  // Entrada física de 10 peças via movimentação (motor canônico).
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, local: local.nome, quantidade: 10 }, admin);

  // Oráculo: físico 10, sem reservas → disponível 10.
  const antes = await saldoDisponivelCelula(empresaA, produtoId, null, localId);
  assert.deepEqual(antes, { fisico: 10, reservado: 0, disponivel: 10 });

  // 4 peças BLOQUEADAS pela qualidade (reserva tipo bloqueio).
  await criarReserva({ body: { produto_id: produtoId, local_id: localId, tipo: 'bloqueio', quantidade: 4, motivo: 'peça com defeito' }, user: admin } as never, { json: () => {} } as never);

  // Oráculo: 10 − 4 = 6 disponíveis; o físico continua 10.
  const depois = await saldoDisponivelCelula(empresaA, produtoId, null, localId);
  assert.deepEqual(depois, { fisico: 10, reservado: 4, disponivel: 6 });

  // A tela (saldoVendavel) mostra 6 — a MESMA regra do faturamento.
  const vendavel = await saldoVendavel(empresaA, produtoId, null, localId);
  assert.equal(vendavel.quantidade, 6);
  assert.equal(vendavel.fisico, 10);

  // Faturar 7 deve ser RECUSADO (não há 7 disponíveis, embora haja 10 físicos).
  const cliente = await createRecord(RESOURCES.clientes, { nome: 'Cliente Oráculo' }, admin);
  // A venda sai do MESMO local onde o saldo foi constituído (o canônico).
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: Number(cliente.id), data: '2026-10-20', local_saida: local.nome }, admin);
  const s = getStore();
  await s.transaction(async (tx) => {
    await s.insert(RESOURCES.itens_venda, { venda_id: Number(venda.id), produto_id: produtoId, quantidade: 7, preco_unitario: 100, subtotal: 700 }, tx);
  });
  await assert.rejects(
    () => updateRecord(RESOURCES.vendas, Number(venda.id), { status: 'faturada' }, admin),
    (e: any) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /reservado\/empenhado\/bloqueado/);
      assert.match(e.message, /disponível/);
      return true;
    }
  );

  // Faturar 6 passa e o físico cai para 4 (o bloqueio fica intacto).
  await s.transaction(async (tx) => {
    const itens = await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 10, filter: { venda_id: Number(venda.id) } }, tx);
    await s.update(RESOURCES.itens_venda, Number(itens.rows[0].id), { quantidade: 6, subtotal: 600 }, tx);
    await s.update(RESOURCES.vendas, Number(venda.id), { total: 600 }, tx);
  });
  await updateRecord(RESOURCES.vendas, Number(venda.id), { status: 'faturada' }, admin);
  const final = await saldoDisponivelCelula(empresaA, produtoId, null, localId);
  assert.equal(final.fisico, 4);
  assert.equal(final.reservado, 4);
  assert.equal(final.disponivel, 0);
});

// ---------------------------------------------------------------------------
// E) INVARIANTE DE ESTOQUE: saldo = Σ eventos
// ---------------------------------------------------------------------------
test('invariante: depois de qualquer sequência válida, saldo = Σ(entradas) − Σ(saídas)', async () => {
  const produto = await createRecord(RESOURCES.produtos, { sku: `ORAC-${Date.now()}-2`, nome: 'Oráculo Invariante', preco_venda: 50 }, admin);
  const produtoId = Number(produto.id);
  const local = (await listRecords(RESOURCES.locais, { page: 1, pageSize: 1 })).rows[0];

  // Sequência determinística (o oráculo soma os eventos à mão, em unidades).
  const eventos: Array<{ tipo: 'entrada' | 'saida' | 'ajuste'; quantidade: number }> = [
    { tipo: 'entrada', quantidade: 10 },
    { tipo: 'saida', quantidade: 3 },
    { tipo: 'entrada', quantidade: 7 },
    { tipo: 'saida', quantidade: 5 },
    { tipo: 'ajuste', quantidade: -2 }, // ajuste negativo = perda inventariada
  ];
  for (const e of eventos) {
    await createRecord(RESOURCES.movimentacoes, { tipo: e.tipo, produto_id: produtoId, local: local.nome, quantidade: e.quantidade }, admin);
  }

  const esperado = eventos.reduce(
    (total, e) => total + (e.tipo === 'saida' ? -Math.abs(e.quantidade) : e.quantidade),
    0
  ); // 10 − 3 + 7 − 5 − 2 = 7
  assert.equal(esperado, 7);

  const saldos = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId } });
  const saldoFinal = saldos.rows.reduce((a, r) => a + Number(r.quantidade ?? 0), 0);
  assert.equal(saldoFinal, esperado);

  const movimentos = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 100, filter: { produto_id: produtoId } });
  const somaEventos = movimentos.rows.reduce(
    (a, m) => a + (String(m.tipo) === 'saida' ? -Math.abs(Number(m.quantidade)) : Number(m.quantidade)),
    0
  );
  assert.equal(somaEventos, saldoFinal, 'o saldo precisa ser exatamente a soma dos eventos');
});

// ---------------------------------------------------------------------------
// F) PARCELAS — Σ === total, sem parcela zerada
// ---------------------------------------------------------------------------
test('parcelas: Σ parcelas === total ao centavo (35,56 em 3× → 11,85 + 11,85 + 11,86)', () => {
  const total = 35.56;
  const plano = dividirParcelas(total, 3);
  const somaCentavos = plano.reduce((a, p) => a + Math.round(p * 100), 0);
  assert.equal(somaCentavos, Math.round(total * 100));
  assert.deepEqual(plano, [11.85, 11.85, 11.86]);
  // nenhuma parcela zerada ou negativa
  assert.ok(plano.every((p) => p > 0));
  // distribuição equilibrada: diferença máxima de 1 centavo
  assert.ok(Math.max(...plano) - Math.min(...plano) <= 0.01);
});

test('parcelas: casos-limite recusam em vez de gerar parcela zerada', () => {
  assert.throws(() => dividirParcelas(0.02, 3), /nenhuma parcela pode ficar zerada/);
  assert.throws(() => dividirParcelas(0, 1), /maior que zero/);
  assert.throws(() => dividirParcelas(100, 0), /inteiro maior ou igual a 1/);
  // 1 parcela devolve o próprio total
  assert.deepEqual(dividirParcelas(10.01, 1), [10.01]);
});

// ---------------------------------------------------------------------------
// G) PREÇO DE VENDA — bruto, desconto, subtotal, total e margem × markup
// ---------------------------------------------------------------------------
test('venda: linha = qtd × (preço − desconto unitário), com arredondamento por linha', () => {
  const linha = linhaDePreco(3, 19.99, 10, 24.9);
  // oráculo: desconto unitário = 19,99 × 10% = 2,00 (2 casas) → líquido 17,99
  assert.equal(linha.descontoUnitario, centavos(19.99 * 0.1)); // 2,00
  assert.equal(linha.subtotal, centavos(3 * centavos(19.99 - 2))); // 3 × 17,99 = 53,97
  assert.equal(linha.bruto, centavos(3 * 19.99)); // 59,97
  assert.equal(linha.desconto, centavos(linha.bruto - linha.subtotal));
  // preço de tabela é só referência: não entra em conta nenhuma
  assert.equal(linha.tabela, 24.9);
});

test('venda: resumo usa desconto total / bruto (nunca a média dos percentuais)', () => {
  const l1 = linhaDePreco(1, 100, 0); // 100
  const l2 = linhaDePreco(1, 100, 50); // 50
  const r = resumoVenda([l1, l2], 10, 5);
  // oráculo: bruto 200; subtotal líquido 150; desconto linhas 50 + pedido 10 = 60
  assert.equal(r.bruto, 200);
  assert.equal(r.subtotalLiquido, 150);
  assert.equal(r.descontoLinhas, 50);
  assert.equal(r.descontoPedido, 10);
  assert.equal(r.descontoTotal, 60);
  assert.equal(r.descontoPct, 30); // 60/200, não a média (0+50)/2 = 25
  assert.equal(r.total, centavos(150 - 10 + 5)); // 145
});

test('venda: desconto percentual e preço líquido são inversos (ida e volta)', () => {
  const preco = 249.9;
  const liquido = precoLiquidoDePct(preco, 12.5);
  const pct = pctDeDescontoUnitario(preco, centavos(preco - liquido));
  assert.ok(Math.abs(pct - 12.5) < 0.01, `ida e volta do percentual: ${pct}`);
});
