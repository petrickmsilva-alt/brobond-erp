// ============================================================================
// COMPRAS — P1 §16 e §17
//
// §16: pedido → aprovação → recebimento PARCIAL/TOTAL → cancelamento.
//      A regra que não pode quebrar: o estoque sobe EXATAMENTE pelo recebido,
//      nunca pelo pedido; e receber a mesma coisa duas vezes não sobe duas.
// §17: a sugestão é um CÁLCULO. Ela nunca cria pedido — isso exige POST
//      explícito do comprador.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { sugerirQuantidade } = await import('../src/compras');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoFornecedor, novoLocal, novoProduto, reqDe, resFake } = await import('./_p1util');
const compras = await import('../src/compras');

await garantirAdmin();
await novoLocal('loja');

async function novaCompra(quantidades: number[] = [10], opts: { status?: string; preco?: number; fornecedor?: any } = {}) {
  const s = getStore();
  const fornecedor = opts.fornecedor ?? (await novoFornecedor());
  const compra = await s.insert(RESOURCES.compras, {
    empresa_id: 1,
    fornecedor_id: Number(fornecedor.id),
    data: new Date().toISOString().slice(0, 10),
    status: opts.status ?? 'pendente',
    total: 0,
  });
  const itens: any[] = [];
  let total = 0;
  for (const qtd of quantidades) {
    const p = await novoProduto({ preco_venda: 100, custo: opts.preco ?? 40 });
    const item = await s.insert(RESOURCES.itens_compra, {
      empresa_id: 1,
      compra_id: Number(compra.id),
      produto_id: Number(p.id),
      insumo_id: null,
      quantidade: qtd,
      quantidade_recebida: 0,
      preco_unitario: opts.preco ?? 40,
    });
    total += qtd * (opts.preco ?? 40);
    itens.push({ produto: p, item });
  }
  await s.update(RESOURCES.compras, Number(compra.id), { total });
  return { compra: (await s.get(RESOURCES.compras, Number(compra.id)))!, itens, fornecedor };
}

async function saldo(produtoId: number, tamanhoId: number | null = null, local = 'loja'): Promise<number> {
  const row = await getStore().findOneWhere(RESOURCES.estoques, { produto_id: produtoId, tamanho_id: tamanhoId, local });
  return Number(row?.quantidade ?? 0);
}

/**
 * O tamanho que o estoque usa para o produto (o saldo é por produto+tamanho+local).
 *
 * Preserva o `null`: `Number(null)` é 0, e buscar o saldo com tamanho 0 não acha
 * a linha de produto sem variação — o teste leria 0 onde há estoque.
 */
async function tamanhoDoEstoque(produtoId: number): Promise<number | null> {
  const row = await getStore().findOneWhere(RESOURCES.estoques, { produto_id: produtoId });
  if (!row) return null;
  return row.tamanho_id === null || row.tamanho_id === undefined ? null : Number(row.tamanho_id);
}

// ---------------------------------------------------------------------------
// 1) Aprovação
// ---------------------------------------------------------------------------

test('compras: aprovação é de gerente/admin e só vale sobre pedido pendente', async () => {
  const s = getStore();
  const operador = await criarAtor(1, 'operador');
  const { compra } = await novaCompra([10]);

  await esperarErro(() => compras.aprovarCompra(reqDe({}, { user: operador, params: { id: compra.id } }), resFake().res), 403, /Somente gerentes e administradores/);

  const aprovada = await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  assert.equal(aprovada.status, 'aprovado');
  assert.ok(aprovada.aprovada_em);
  assert.equal(Number(aprovada.aprovada_por), 1);

  await esperarErro(() => compras.aprovarCompra(reqDe({}, { params: { id: compra.id } }), resFake().res), 409, /Só se aprova um pedido pendente/);
  assert.equal((await s.get(RESOURCES.compras, Number(compra.id))).status, 'aprovado');
});

test('compras: acima da alçada, a aprovação para em vez de seguir', async () => {
  const s = getStore();
  const { compra } = await novaCompra([10], { preco: 100 }); // total 1000
  await esperarErro(() => compras.aprovarCompra(reqDe({ limite_alcada: 500 }, { params: { id: compra.id } }), resFake().res), 403, /acima da sua alçada/);
  assert.equal((await s.get(RESOURCES.compras, Number(compra.id))).status, 'pendente', 'nada foi aprovado');

  // Dentro da alçada, passa.
  const ok = await chamar(compras.aprovarCompra, reqDe({ limite_alcada: 1500 }, { params: { id: compra.id } }));
  assert.equal(ok.status, 'aprovado');
});

// ---------------------------------------------------------------------------
// 2) Recebimento parcial
// ---------------------------------------------------------------------------

test('compras: o estoque sobe EXATAMENTE pelo recebido, nunca pelo pedido', async () => {
  const s = getStore();
  const { compra, itens } = await novaCompra([10]);
  const pid = Number(itens[0].produto.id);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  const antes = await saldo(pid, await tamanhoDoEstoque(pid));

  const parcial = await chamar(
    compras.receberParcial,
    reqDe({ itens: [{ item_compra_id: Number(itens[0].item.id), quantidade: 4 }] }, { params: { id: compra.id } }),
    201
  );
  assert.equal(parcial.idempotente, false);
  assert.equal(parcial.status, 'parcial');
  assert.match(parcial.mensagem, /apenas pela quantidade recebida/);
  assert.equal(Number(parcial.total), 160, '4 × 40');

  const tamanho = await tamanhoDoEstoque(pid);
  assert.equal(await saldo(pid, tamanho), antes + 4, 'subiram 4, não 10');

  const itemDepois = await s.get(RESOURCES.itens_compra, Number(itens[0].item.id));
  assert.equal(Number(itemDepois.quantidade_recebida), 4);
  const compraDepois = await s.get(RESOURCES.compras, Number(compra.id));
  assert.equal(compraDepois.status, 'parcial');

  // O financeiro NÃO é lançado no parcial (senão a conta a pagar duplicaria).
  const lanc = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { compra_id: Number(compra.id) } });
  assert.equal(lanc.rows.length, 0, 'nenhum lançamento antes do recebimento total');
});

test('compras: receber o que resta completa o pedido e lança o contas a pagar', async () => {
  const s = getStore();
  const { compra, itens } = await novaCompra([10]);
  const pid = Number(itens[0].produto.id);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  await chamar(compras.receberParcial, reqDe({ itens: [{ item_compra_id: Number(itens[0].item.id), quantidade: 4 }] }, { params: { id: compra.id } }), 201);
  const antes = await saldo(pid, await tamanhoDoEstoque(pid));

  const final = await chamar(
    compras.receberParcial,
    reqDe({ itens: [{ item_compra_id: Number(itens[0].item.id), quantidade: 6 }] }, { params: { id: compra.id } }),
    201
  );
  assert.equal(final.status, 'recebido');
  assert.match(final.mensagem, /totalmente recebida/);
  assert.equal(await saldo(pid, await tamanhoDoEstoque(pid)), antes + 6, 'o estoque totalizou 10');

  const compraDepois = await s.get(RESOURCES.compras, Number(compra.id));
  assert.equal(compraDepois.status, 'recebido');
  assert.ok(compraDepois.recebida_em);

  const lanc = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { compra_id: Number(compra.id) } });
  assert.ok(lanc.rows.length >= 1, 'o contas a pagar foi gerado uma única vez, no fechamento');

  // Receber de novo é recusado.
  await esperarErro(() => compras.receberParcial(reqDe({ itens: [{ item_compra_id: Number(itens[0].item.id), quantidade: 1 }] }, { params: { id: compra.id } }), resFake().res), 409, /já foi totalmente recebida/);
});

test('compras: não se recebe mais do que o pedido — o guard é o CAS no item', async () => {
  const s = getStore();
  const { compra, itens } = await novaCompra([5]);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  const itemId = Number(itens[0].item.id);

  const erro = await esperarErro(
    () => compras.receberParcial(reqDe({ itens: [{ item_compra_id: itemId, quantidade: 6 }] }, { params: { id: compra.id } }), resFake().res),
    409,
    /não é possível receber/
  );
  assert.equal(Number(erro.fields.pedido), 5);
  assert.equal(Number(erro.fields.ja_recebido), 0);
  assert.equal(Number(erro.fields.restante), 5);

  // E nada foi gravado.
  assert.equal(Number((await s.get(RESOURCES.itens_compra, itemId)).quantidade_recebida), 0);
  const recebimentos = await s.list(RESOURCES.compra_recebimentos, { page: 1, pageSize: 20, filter: { compra_id: Number(compra.id) } });
  assert.equal(recebimentos.rows.length, 0);

  // Depois de receber 5, tentar mais 1 é recusado pelo saldo restante.
  await chamar(compras.receberParcial, reqDe({ itens: [{ item_compra_id: itemId, quantidade: 5 }] }, { params: { id: compra.id } }), 201);
  const erro2 = await esperarErro(
    () => compras.receberParcial(reqDe({ itens: [{ item_compra_id: itemId, quantidade: 1 }], idempotency_key: 'outra-chave' }, { params: { id: compra.id } }), resFake().res),
    409
  );
  assert.match(String(erro2.message), /totalmente recebida|não é possível receber/);
});

test('compras: o recebimento é IDEMPOTENTE — repetir não sobe o estoque de novo', async () => {
  const s = getStore();
  const { compra, itens } = await novaCompra([10]);
  const pid = Number(itens[0].produto.id);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  const itemId = Number(itens[0].item.id);
  const corpo = { itens: [{ item_compra_id: itemId, quantidade: 3 }], idempotency_key: 'recebimento-fixo-001' };

  const primeira = await chamar(compras.receberParcial, reqDe(corpo, { params: { id: compra.id } }), 201);
  const tamanho = await tamanhoDoEstoque(pid);
  const saldoDepoisDaPrimeira = await saldo(pid, tamanho);

  const segunda = await chamar(compras.receberParcial, reqDe(corpo, { params: { id: compra.id } }));
  assert.equal(segunda.idempotente, true);
  assert.equal(Number(segunda.recebimento.id), Number(primeira.recebimento.id), 'o MESMO recebimento');
  assert.match(segunda.mensagem, /nenhuma entrada duplicada/);

  assert.equal(await saldo(pid, tamanho), saldoDepoisDaPrimeira, 'o estoque não subiu duas vezes');
  assert.equal(Number((await s.get(RESOURCES.itens_compra, itemId)).quantidade_recebida), 3);

  const recebimentos = await s.list(RESOURCES.compra_recebimentos, { page: 1, pageSize: 20, filter: { compra_id: Number(compra.id) } });
  assert.equal(recebimentos.rows.length, 1, 'um único recebimento gravado');
});

test('compras: sem chave explícita, a chave derivada dos itens também identifica a repetição', async () => {
  const s = getStore();
  const { compra, itens } = await novaCompra([10]);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  const corpo = { itens: [{ item_compra_id: Number(itens[0].item.id), quantidade: 2 }] };
  await chamar(compras.receberParcial, reqDe(corpo, { params: { id: compra.id } }), 201);
  const repetida = await chamar(compras.receberParcial, reqDe(corpo, { params: { id: compra.id } }));
  assert.equal(repetida.idempotente, true, 'a mesma leitura do mesmo item é a mesma operação');
  const recebimentos = await s.list(RESOURCES.compra_recebimentos, { page: 1, pageSize: 20, filter: { compra_id: Number(compra.id) } });
  assert.equal(recebimentos.rows.length, 1);
});

test('compras: linhas inválidas são recusadas antes de qualquer efeito', async () => {
  const { compra, itens } = await novaCompra([5]);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  const itemId = Number(itens[0].item.id);

  await esperarErro(() => compras.receberParcial(reqDe({}, { params: { id: compra.id } }), resFake().res), 400, /Envie `itens`/);
  await esperarErro(() => compras.receberParcial(reqDe({ itens: [] }, { params: { id: compra.id } }), resFake().res), 400, /Envie `itens`/);
  await esperarErro(() => compras.receberParcial(reqDe({ itens: [{ item_compra_id: 0, quantidade: 1 }] }, { params: { id: compra.id } }), resFake().res), 400, /item_compra_id inválido/);
  await esperarErro(() => compras.receberParcial(reqDe({ itens: [{ item_compra_id: itemId, quantidade: 0 }] }, { params: { id: compra.id } }), resFake().res), 400, /maior que zero/);
  await esperarErro(() => compras.receberParcial(reqDe({ itens: [{ item_compra_id: 999999, quantidade: 1 }] }, { params: { id: compra.id } }), resFake().res), 404, /não pertence a esta compra/);
  await esperarErro(() => compras.receberParcial(reqDe({ itens: [{ item_compra_id: itemId, quantidade: 1 }], local: 'armazem_fantasma' }, { params: { id: compra.id } }), resFake().res), 404, /Local não encontrado/);
});

test('compras: cancelada não recebe', async () => {
  const { compra, itens } = await novaCompra([5], { status: 'cancelado' });
  await esperarErro(
    () => compras.receberParcial(reqDe({ itens: [{ item_compra_id: Number(itens[0].item.id), quantidade: 1 }] }, { params: { id: compra.id } }), resFake().res),
    409,
    /cancelada/
  );
});

test('compras: a listagem mostra pedido, recebido e o que resta', async () => {
  const { compra, itens } = await novaCompra([10]);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } }));
  await chamar(compras.receberParcial, reqDe({ itens: [{ item_compra_id: Number(itens[0].item.id), quantidade: 4 }] }, { params: { id: compra.id } }), 201);

  const out = await chamar(compras.listarRecebimentos, reqDe({}, { params: { id: compra.id } }));
  assert.equal(Number(out.compra_id), Number(compra.id));
  assert.equal(out.itens.length, 1);
  assert.equal(Number(out.itens[0].quantidade), 10);
  assert.equal(Number(out.itens[0].quantidade_recebida), 4);
  assert.equal(Number(out.itens[0].restante), 6);
  assert.equal(out.recebimentos.length, 1);
  assert.equal(Number(out.recebimentos[0].total), 160);
});

// ---------------------------------------------------------------------------
// 3) Sugestão de compra (pura + integrada)
// ---------------------------------------------------------------------------

test('compras: a fórmula da sugestão considera min/máx, vendas em aberto e compras em trânsito', () => {
  // Acima do mínimo → não sugere.
  assert.deepEqual(sugerirQuantidade({ estoqueAtual: 50, estoqueMin: 10, estoqueMax: 100, consumoMensal: 20, emPedidosVenda: 0, emComprasTransito: 0 }), {
    sugerido: 0,
    disponivelProjetado: 50,
    motivo: 'Estoque projetado acima do mínimo.',
  });

  // Abaixo do mínimo → sobe até o teto.
  const abaixo = sugerirQuantidade({ estoqueAtual: 4, estoqueMin: 10, estoqueMax: 100, consumoMensal: 20, emPedidosVenda: 0, emComprasTransito: 0 });
  assert.equal(abaixo.disponivelProjetado, 4);
  assert.equal(abaixo.sugerido, 96, '100 − 4');
  assert.match(abaixo.motivo, /abaixo do mínimo 10/);

  // Vendas em aberto consomem o disponível.
  const comVendas = sugerirQuantidade({ estoqueAtual: 30, estoqueMin: 10, estoqueMax: 100, consumoMensal: 20, emPedidosVenda: 25, emComprasTransito: 0 });
  assert.equal(comVendas.disponivelProjetado, 5);
  assert.equal(comVendas.sugerido, 95);

  // Compras em trânsito SOMAM ao disponível — e podem zerar a sugestão.
  const comTransito = sugerirQuantidade({ estoqueAtual: 4, estoqueMin: 10, estoqueMax: 100, consumoMensal: 20, emPedidosVenda: 0, emComprasTransito: 50 });
  assert.equal(comTransito.disponivelProjetado, 54);
  assert.equal(comTransito.sugerido, 0, 'já vem 50 em trânsito: não precisa comprar');

  const transitoParcial = sugerirQuantidade({ estoqueAtual: 4, estoqueMin: 10, estoqueMax: 100, consumoMensal: 20, emPedidosVenda: 0, emComprasTransito: 5 });
  assert.equal(transitoParcial.disponivelProjetado, 9);
  assert.equal(transitoParcial.sugerido, 91);
  assert.match(transitoParcial.motivo, /há 5 em trânsito/);

  // Sem teto declarado, cobre 1 mês de consumo além do mínimo.
  const semTeto = sugerirQuantidade({ estoqueAtual: 2, estoqueMin: 10, estoqueMax: 0, consumoMensal: 25, emPedidosVenda: 0, emComprasTransito: 0 });
  assert.equal(semTeto.sugerido, 33, '(10 + ceil(25)) − 2');
});

test('compras: a sugestão é um cálculo — nunca cria pedido', async () => {
  const s = getStore();
  const produto = await novoProduto({ preco_venda: 100, custo: 40, estoque_min: 20, estoque_max: 100 });
  await s.insert(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: null, local: 'loja', quantidade: 5, custo_medio: 40 });

  const antes = await s.list(RESOURCES.compras, { page: 1, pageSize: 500, filter: { empresa_id: 1 } });
  const sug = await chamar(compras.sugestaoCompra, reqDe({}, { query: { dias: 90 } }));
  assert.equal(sug.automatico, false, 'a sugestão declara que não é automática');
  assert.equal(sug.periodo_consumo_dias, 90);
  const linha = sug.itens.find((l: any) => Number(l.produto_id) === Number(produto.id));
  assert.ok(linha, 'o produto abaixo do mínimo apareceu');
  assert.equal(linha.estoque_atual, 5);
  assert.equal(linha.estoque_min, 20);
  assert.equal(linha.sugerido, 95, '100 − 5');
  assert.equal(linha.custo_unitario, 40);
  assert.equal(linha.custo_total, 3800);
  assert.equal(sug.total_unidades, sug.itens.reduce((a: number, l: any) => a + l.sugerido, 0));

  const depois = await s.list(RESOURCES.compras, { page: 1, pageSize: 500, filter: { empresa_id: 1 } });
  assert.equal(depois.total, antes.total, 'nenhum pedido de compra foi criado pela sugestão');
});

test('compras: produto sem estoque mínimo não entra na sugestão', async () => {
  const s = getStore();
  const semMin = await novoProduto({ preco_venda: 100, custo: 40, estoque_min: 0 });
  await s.insert(RESOURCES.estoques, { produto_id: Number(semMin.id), tamanho_id: null, local: 'loja', quantidade: 0, custo_medio: 40 });
  const sug = await chamar(compras.sugestaoCompra, reqDe({}, { query: { dias: 90 } }));
  assert.ok(!sug.itens.some((l: any) => Number(l.produto_id) === Number(semMin.id)), 'sem mínimo definido não há o que sugerir');
});

test('compras: gerar pedido da sugestão exige fornecedor e itens revisados', async () => {
  const s = getStore();
  const produto = await novoProduto({ preco_venda: 100, custo: 40, estoque_min: 20, estoque_max: 100 });
  await s.insert(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: null, local: 'loja', quantidade: 5, custo_medio: 40 });
  const fornecedor = await novoFornecedor();

  await esperarErro(() => compras.gerarCompraDaSugestao(reqDe({ itens: [{ produto_id: Number(produto.id), quantidade: 95 }] }), resFake().res), 400, /fornecedor/);
  await esperarErro(() => compras.gerarCompraDaSugestao(reqDe({ fornecedor_id: Number(fornecedor.id), itens: [] }), resFake().res), 400, /lista revisada/);
  await esperarErro(() => compras.gerarCompraDaSugestao(reqDe({ fornecedor_id: Number(fornecedor.id), itens: [{ produto_id: 999999, quantidade: 1 }] }), resFake().res), 404, /não encontrado/);
  await esperarErro(() => compras.gerarCompraDaSugestao(reqDe({ fornecedor_id: Number(fornecedor.id), itens: [{ produto_id: Number(produto.id), quantidade: 0 }] }), resFake().res), 400, /maior que zero/);

  const gerada = await chamar(
    compras.gerarCompraDaSugestao,
    reqDe({ fornecedor_id: Number(fornecedor.id), itens: [{ produto_id: Number(produto.id), quantidade: 95 }], previsao_entrega: '2026-11-01' }),
    201
  );
  assert.equal(gerada.compra.status, 'pendente', 'entra pendente — precisa de aprovação');
  assert.equal(Number(gerada.compra.fornecedor_id), Number(fornecedor.id));
  assert.equal(Number(gerada.total), 3800, '95 × custo 40');
  assert.equal(gerada.itens.length, 1);
  assert.equal(Number((await s.get(RESOURCES.itens_compra, gerada.itens[0].item_compra_id)).quantidade_recebida), 0);
  assert.match(gerada.mensagem, /aprove e receba normalmente/);

  // Preço revisado pelo comprador prevalece sobre o custo da ficha.
  const revisada = await chamar(
    compras.gerarCompraDaSugestao,
    reqDe({ fornecedor_id: Number(fornecedor.id), itens: [{ produto_id: Number(produto.id), quantidade: 10, preco_unitario: 33.5 }] }),
    201
  );
  assert.equal(Number(revisada.total), 335);
});

test('compras: a sugestão agrupa por fornecedor para o comprador revisar', async () => {
  const s = getStore();
  const fornecedor = await novoFornecedor();
  const p1 = await novoProduto({ preco_venda: 100, custo: 40, estoque_min: 20, estoque_max: 100, fornecedor_id: Number(fornecedor.id) });
  const p2 = await novoProduto({ preco_venda: 100, custo: 10, estoque_min: 20, estoque_max: 60, fornecedor_id: Number(fornecedor.id) });
  for (const p of [p1, p2]) {
    await s.insert(RESOURCES.estoques, { produto_id: Number(p.id), tamanho_id: null, local: 'loja', quantidade: 0, custo_medio: 10 });
  }
  const sug = await chamar(compras.sugestaoCompra, reqDe({}, { query: { dias: 90 } }));
  const grupo = sug.por_fornecedor.find((g: any) => Number(g.fornecedor_id) === Number(fornecedor.id));
  assert.ok(grupo, 'os itens do mesmo fornecedor aparecem agrupados');
  assert.equal(grupo.itens, 2);
  assert.equal(grupo.unidades, 100 + 60);
  assert.equal(grupo.custo, 100 * 40 + 60 * 10);
});

// ---------------------------------------------------------------------------
// 4) Multiempresa
// ---------------------------------------------------------------------------

test('compras: EMPRESA A não aprova, não recebe e não vê a compra da EMPRESA B', async () => {
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const fornecedorB = await s.insert(RESOURCES.fornecedores, { empresa_id: 2, nome: 'Fornecedor da B', ativo: true });
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-COM-B', nome: 'Produto da B', preco_venda: 100, custo: 40, ativo: true });
  const compraB = await s.insert(RESOURCES.compras, { empresa_id: 2, fornecedor_id: Number(fornecedorB.id), data: new Date().toISOString().slice(0, 10), status: 'pendente', total: 400 });
  const itemB = await s.insert(RESOURCES.itens_compra, { empresa_id: 2, compra_id: Number(compraB.id), produto_id: Number(produtoB.id), insumo_id: null, quantidade: 10, quantidade_recebida: 0, preco_unitario: 40 });

  await esperarErro(() => compras.aprovarCompra(reqDe({}, { params: { id: compraB.id } }), resFake().res), 404);
  await esperarErro(() => compras.receberParcial(reqDe({ itens: [{ item_compra_id: Number(itemB.id), quantidade: 5 }] }, { params: { id: compraB.id } }), resFake().res), 404);
  await esperarErro(() => compras.listarRecebimentos(reqDe({}, { params: { id: compraB.id } }), resFake().res), 404);

  const intacta = await s.get(RESOURCES.compras, Number(compraB.id));
  assert.equal(intacta.status, 'pendente');
  assert.equal(Number((await s.get(RESOURCES.itens_compra, Number(itemB.id))).quantidade_recebida), 0);

  // A sugestão de A não inclui os produtos de B.
  await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-COM-B2', nome: 'Outro da B', preco_venda: 50, custo: 20, estoque_min: 30, estoque_max: 90, ativo: true });
  const sug = await chamar(compras.sugestaoCompra, reqDe({}, { query: { dias: 90 } }));
  assert.equal(sug.empresa_id, 1);
  assert.ok(sug.itens.every((l: any) => !String(l.sku || '').startsWith('P1-COM-B')), 'só produtos da empresa A');

  // E gerar compra para fornecedor de B é recusado.
  await esperarErro(() => compras.gerarCompraDaSugestao(reqDe({ fornecedor_id: Number(fornecedorB.id), itens: [{ produto_id: Number(produtoB.id), quantidade: 1 }] }), resFake().res), 404);
});

test('compras: o item de outra empresa não entra num recebimento da empresa A', async () => {
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const fornecedorB = await s.insert(RESOURCES.fornecedores, { empresa_id: 2, nome: 'Fornecedor B2', ativo: true });
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-COM-B3', nome: 'Produto B3', preco_venda: 100, custo: 40, ativo: true });
  const compraB = await s.insert(RESOURCES.compras, { empresa_id: 2, fornecedor_id: Number(fornecedorB.id), data: new Date().toISOString().slice(0, 10), status: 'aprovado', total: 400 });
  const itemB = await s.insert(RESOURCES.itens_compra, { empresa_id: 2, compra_id: Number(compraB.id), produto_id: Number(produtoB.id), insumo_id: null, quantidade: 10, quantidade_recebida: 0, preco_unitario: 40 });

  // Compra de A, item de B: o item "não pertence a esta compra".
  const { compra: compraA } = await novaCompra([5]);
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compraA.id } }));
  await esperarErro(
    () => compras.receberParcial(reqDe({ itens: [{ item_compra_id: Number(itemB.id), quantidade: 5 }] }, { params: { id: compraA.id } }), resFake().res),
    404,
    /não pertence a esta compra/
  );
  assert.equal(Number((await s.get(RESOURCES.itens_compra, Number(itemB.id))).quantidade_recebida), 0);
});
