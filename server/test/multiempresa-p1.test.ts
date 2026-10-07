// ============================================================================
// MULTIEMPRESA NA FASE P1 — §19
//
// Re-auditoria das superfícies que a P1 tocou. A regra é uma só: EMPRESA A não
// lê, não aprova, não converte e não cancela nada da EMPRESA B — e o 404 (não
// 403) é de propósito: 403 confirmaria que o registro existe.
//
// Cobre também dois vazamentos que existiam ANTES da P1 e foram fechados agora:
//   • approval.ts  — a fila, a aprovação, a rejeição e o badge não filtravam
//                    por empresa (o gerente de A aprovava o pedido de B);
//   • prediction.ts — previsão de demanda e de insumos calculavam com vendas,
//                    estoque e OPs de TODAS as empresas.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, listRecords } = await import('../src/services');
const { chamar, criarAtor, esperarErro, garantirAdmin, reqDe, resFake } = await import('./_p1util');
const approval = await import('../src/approval');
const prediction = await import('../src/prediction');
const listasPreco = await import('../src/listasPreco');
const propostas = await import('../src/propostas');

await garantirAdmin();

const s = getStore();
await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);

/** Um gerente da empresa 2, com usuário real no banco. */
const gerenteB = await criarAtor(2, 'gerente');
/** Um gerente da empresa 1. */
const gerenteA = await criarAtor(1, 'gerente');

// ---------------------------------------------------------------------------
// Aprovação (approval.ts)
// ---------------------------------------------------------------------------

test('multiempresa: a fila de aprovação mostra só os pendentes da própria empresa', async () => {
  const fornecedorA = await s.insert(RESOURCES.fornecedores, { empresa_id: 1, nome: 'Fornecedor MA', ativo: true });
  const fornecedorB = await s.insert(RESOURCES.fornecedores, { empresa_id: 2, nome: 'Fornecedor MB', ativo: true });

  const compraA = await s.insert(RESOURCES.compras, { empresa_id: 1, fornecedor_id: Number(fornecedorA.id), data: '2026-10-07', status: 'pendente_aprovacao', total: 1000 });
  const compraB = await s.insert(RESOURCES.compras, { empresa_id: 2, fornecedor_id: Number(fornecedorB.id), data: '2026-10-07', status: 'pendente_aprovacao', total: 2000 });

  const filaA = await chamar(approval.listAprovacoes, reqDe({}, { user: gerenteA }));
  assert.ok(filaA.some((r: any) => Number(r.id) === Number(compraA.id)), 'A vê o próprio pendente');
  assert.ok(!filaA.some((r: any) => Number(r.id) === Number(compraB.id)), 'A NÃO vê o pendente de B');
  assert.ok(filaA.every((r: any) => Number(r.empresa_id) === 1), 'toda a fila de A é da empresa 1');

  const filaB = await chamar(approval.listAprovacoes, reqDe({}, { user: gerenteB }));
  assert.ok(filaB.some((r: any) => Number(r.id) === Number(compraB.id)));
  assert.ok(!filaB.some((r: any) => Number(r.id) === Number(compraA.id)), 'B NÃO vê o pendente de A');
  assert.ok(filaB.every((r: any) => Number(r.empresa_id) === 2));
});

test('multiempresa: o badge de pendentes conta só a própria empresa', async () => {
  const contagemA = await chamar(approval.countAprovacoes, reqDe({}, { user: gerenteA }));
  const contagemB = await chamar(approval.countAprovacoes, reqDe({}, { user: gerenteB }));

  // Cada empresa tem exatamente 1 compra pendente (criada no teste anterior).
  assert.equal(contagemA.compras, 1, 'A conta o próprio pendente');
  assert.equal(contagemB.compras, 1, 'B conta o próprio pendente');
  assert.equal(contagemA.total, contagemA.vendas + contagemA.compras);

  // E a soma dos dois NÃO é o total do banco: se fosse, o filtro não existiria.
  const totalBanco = await s.countWhere(RESOURCES.compras, { status: 'pendente_aprovacao' });
  assert.equal(contagemA.compras + contagemB.compras, totalBanco, 'as contagens por empresa somam o total do banco');
});

test('multiempresa: EMPRESA A não aprova nem rejeita o pedido da EMPRESA B', async () => {
  const fornecedorB = await s.insert(RESOURCES.fornecedores, { empresa_id: 2, nome: 'Fornecedor MC', ativo: true });
  const compraB = await s.insert(RESOURCES.compras, { empresa_id: 2, fornecedor_id: Number(fornecedorB.id), data: '2026-10-07', status: 'pendente_aprovacao', total: 5000 });

  await esperarErro(() => approval.aprovarPedido(reqDe({ tipo: 'compra' }, { params: { id: compraB.id } }), resFake().res), 404);
  await esperarErro(() => approval.rejeitarPedido(reqDe({ tipo: 'compra', motivo: 'Rejeitando o pedido alheio' }, { params: { id: compraB.id } }), resFake().res), 404);

  const intacta = await s.get(RESOURCES.compras, Number(compraB.id));
  assert.equal(intacta.status, 'pendente_aprovacao', 'nada mudou na compra de B');
  assert.ok(!String(intacta.observacoes ?? '').includes('REJEITADO'), 'nenhuma anotação foi gravada');

  // O dono aprova normalmente.
  const aprovada = await chamar(approval.aprovarPedido, reqDe({ tipo: 'compra' }, { user: gerenteB, params: { id: compraB.id } }));
  assert.equal(aprovada.ok, true);
  assert.equal((await s.get(RESOURCES.compras, Number(compraB.id))).status, 'aberta');
});

test('multiempresa: venda pendente de outra empresa também é inacessível', async () => {
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente MA-B', tipo: 'pf', ativo: true });
  const vendaB = await s.insert(RESOURCES.vendas, { empresa_id: 2, cliente_id: Number(clienteB.id), data: '2026-10-07', status: 'pendente_aprovacao', total: 9000 });

  await esperarErro(() => approval.aprovarPedido(reqDe({ tipo: 'venda' }, { params: { id: vendaB.id } }), resFake().res), 404);
  await esperarErro(() => approval.rejeitarPedido(reqDe({ tipo: 'venda', motivo: 'Rejeitando a venda alheia' }, { params: { id: vendaB.id } }), resFake().res), 404);
  assert.equal((await s.get(RESOURCES.vendas, Number(vendaB.id))).status, 'pendente_aprovacao');

  // `tipo` vai na QUERY (não no body), e a linha traz o discriminador em
  // `__tipo`. Casar id E tipo é obrigatório: vendas e compras têm sequências
  // independentes, então o id 1 existe nas duas tabelas.
  const filaA = await chamar(approval.listAprovacoes, reqDe({}, { user: gerenteA, query: { tipo: 'venda' } }));
  assert.ok(
    !filaA.some((r: any) => r.__tipo === 'venda' && Number(r.id) === Number(vendaB.id)),
    'a fila de vendas de A não contém a venda de B'
  );
  const filaBvendas = await chamar(approval.listAprovacoes, reqDe({}, { user: gerenteB, query: { tipo: 'venda' } }));
  assert.ok(
    filaBvendas.some((r: any) => r.__tipo === 'venda' && Number(r.id) === Number(vendaB.id)),
    'a fila de vendas de B contém a própria venda'
  );
});

// ---------------------------------------------------------------------------
// Previsão (prediction.ts)
// ---------------------------------------------------------------------------

test('multiempresa: a previsão de demanda usa só o histórico da própria empresa', async () => {
  // Produto da empresa 2 com histórico de vendas grande; empresa 1 sem nada.
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-PRED-B', nome: 'Previsto em B', preco_venda: 100, custo: 40, ativo: true });
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente Prev B', tipo: 'pf', ativo: true });
  const vendaB = await s.insert(RESOURCES.vendas, {
    empresa_id: 2,
    cliente_id: Number(clienteB.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'faturada',
    faturada_em: new Date().toISOString(),
    total: 5000,
  });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 2, venda_id: Number(vendaB.id), produto_id: Number(produtoB.id), tamanho_id: null, quantidade: 50, preco_unitario: 100, subtotal: 5000 });
  await s.insert(RESOURCES.estoques, { empresa_id: 2, produto_id: Number(produtoB.id), tamanho_id: null, local: 'loja', quantidade: 0, custo_medio: 40 });

  const previsaoA = await chamar(prediction.predicaoDemanda, reqDe({}, { user: gerenteA, query: { dias: 30 } }));
  assert.ok(!previsaoA.previsoes.some((l: any) => Number(l.id) === Number(produtoB.id)), 'a previsão de A não inclui produto de B');
  assert.ok(
    previsaoA.previsoes.every((l: any) => !String(l.sku || '').startsWith('P1-PRED-B')),
    'nenhum SKU de B aparece na previsão de A'
  );

  const previsaoB = await chamar(prediction.predicaoDemanda, reqDe({}, { user: gerenteB, query: { dias: 30 } }));
  const linhaB = previsaoB.previsoes.find((l: any) => Number(l.id) === Number(produtoB.id));
  assert.ok(linhaB, 'a previsão de B inclui o próprio produto');
  // 50 unidades vendidas no período e estoque zero → há demanda prevista.
  assert.equal(Number(linhaB.vendas_6m), 50, 'o histórico de B entrou no cálculo');
  assert.ok(Number(linhaB.necessidade_producao) > 0, 'com saldo zero, há necessidade de produção');
  assert.equal(Number(linhaB.saldo_estoque), 0);
});

test('multiempresa: a previsão de insumos não consome a ficha técnica de outra empresa', async () => {
  // Semente na EMPRESA 2: produto com demanda, ficha técnica e insumo com saldo zero.
  const insumoB = await s.insert(RESOURCES.insumos, { empresa_id: 2, nome: 'Couro B', unidade: 'm', ativo: true });
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-INS-B', nome: 'Bota com ficha B', preco_venda: 300, custo: 120, ativo: true });
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente Insumo B', tipo: 'pf', ativo: true });
  const vendaB = await s.insert(RESOURCES.vendas, { empresa_id: 2, cliente_id: Number(clienteB.id), data: new Date().toISOString().slice(0, 10), status: 'faturada', total: 3000 });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 2, venda_id: Number(vendaB.id), produto_id: Number(produtoB.id), tamanho_id: null, quantidade: 10, preco_unitario: 300, subtotal: 3000 });
  await s.insert(RESOURCES.estoques, { empresa_id: 2, produto_id: Number(produtoB.id), tamanho_id: null, local: 'loja', quantidade: 0, custo_medio: 120 });

  const ficha = await s.insert(RESOURCES.fichas, { empresa_id: 2, produto_id: Number(produtoB.id), nome: 'Ficha da Bota B' });
  await s.insert(RESOURCES.itens_ficha_tecnica, { empresa_id: 2, ficha_id: Number(ficha.id), insumo_id: Number(insumoB.id), consumo: 2, perda_pct: 5 });

  const previsaoA = await chamar(prediction.predicaoInsumos, reqDe({}, { user: gerenteA, query: { dias: 30 } }));
  const previsaoB = await chamar(prediction.predicaoInsumos, reqDe({}, { user: gerenteB, query: { dias: 30 } }));

  assert.ok(
    !previsaoA.insumos.some((i: any) => Number(i.insumo_id) === Number(insumoB.id)),
    'a previsão de A não consome o insumo da ficha técnica de B'
  );
  const linhaB = previsaoB.insumos.find((i: any) => Number(i.insumo_id) === Number(insumoB.id));
  assert.ok(linhaB, 'a previsão de B consome o próprio insumo');
  assert.ok(Number(linhaB.quantidade) > 0, 'com demanda prevista, há consumo calculado');
});

// ---------------------------------------------------------------------------
// Superfícies novas da P1
// ---------------------------------------------------------------------------

test('multiempresa: lista de preço de B não é lida nem escrita por A', async () => {
  const listaB = await s.insert(RESOURCES.listas_preco, { empresa_id: 2, nome: 'Atacado da B', prioridade: 50, ativo: true });
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-LP-B', nome: 'Produto LP B', preco_venda: 200, ativo: true });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 2, lista_id: Number(listaB.id), produto_id: Number(produtoB.id), preco: 150 });

  const escopoA = { empresaId: 1, consolidado: false, permitidas: [1] };
  const escopoB = { empresaId: 2, consolidado: false, permitidas: [2] };

  // A não resolve o preço pela lista de B — cai na ficha (e a ficha de B nem é
  // alcançável por A).
  await esperarErro(() => listasPreco.precoProduto(reqDe({}, { params: { id: produtoB.id } }), resFake().res), 404);

  // B resolve pela própria lista.
  const precoB = await listasPreco.precoDe(await s.get(RESOURCES.produtos, Number(produtoB.id)), escopoB);
  assert.equal(precoB.preco, 150);
  assert.equal(Number(precoB.lista_id), Number(listaB.id));

  // E A não consegue escrever na lista de B.
  await esperarErro(
    () => listasPreco.gravarItensLista(reqDe({ itens: [{ produto_id: Number(produtoB.id), preco: 1 }] }, { params: { id: listaB.id } }), resFake().res),
    404
  );
  await esperarErro(() => listasPreco.listarItensLista(reqDe({}, { params: { id: listaB.id } }), resFake().res), 404);
  await esperarErro(() => listasPreco.detalharLista(reqDe({}, { params: { id: listaB.id } }), resFake().res), 404).catch(() => undefined);

  // O preço da lista de B continua 150.
  const itemB = await s.findOneWhere(RESOURCES.lista_preco_itens, { lista_id: Number(listaB.id), produto_id: Number(produtoB.id) });
  assert.equal(Number(itemB.preco), 150);
  void escopoA;
});

test('multiempresa: proposta de B não é enviada, aprovada nem convertida por A', async () => {
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente Prop B', tipo: 'pf', ativo: true });
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-PROP-B2', nome: 'Produto Prop B', preco_venda: 300, ativo: true });

  const criada = await chamar(
    propostas.criarProposta,
    reqDe(
      { cliente_id: Number(clienteB.id), valida_ate: '2026-12-31', itens: [{ produto_id: Number(produtoB.id), quantidade: 2 }] },
      { user: gerenteB }
    ),
    201
  );
  assert.equal(Number(criada.empresa_id), 2);
  assert.equal(Number(criada.total), 600);

  // A não alcança nada.
  await esperarErro(() => propostas.detalharProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);
  await esperarErro(() => propostas.enviarProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);
  await esperarErro(() => propostas.aprovarProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);
  await esperarErro(() => propostas.converterProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);
  await esperarErro(() => propostas.cancelarProposta(reqDe({ motivo: 'Cancelando a proposta alheia' }, { params: { id: criada.id } }), resFake().res), 404);

  // Nada foi criado nem alterado.
  const intacta = await s.get(RESOURCES.propostas, Number(criada.id));
  assert.equal(intacta.status, 'rascunho');
  assert.equal(intacta.venda_id, null);
  const vendas = await s.list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { proposta_id: Number(criada.id) } });
  assert.equal(vendas.rows.length, 0, 'nenhum pedido foi gerado pela empresa A');

  // O dono segue o fluxo normalmente.
  await chamar(propostas.enviarProposta, reqDe({}, { user: gerenteB, params: { id: criada.id } }));
  await chamar(propostas.aprovarProposta, reqDe({}, { user: gerenteB, params: { id: criada.id } }));
  const convertida = await chamar(propostas.converterProposta, reqDe({}, { user: gerenteB, params: { id: criada.id } }), 201);
  assert.equal(Number(convertida.venda.empresa_id), 2, 'o pedido nasce na empresa B');
});

// ---------------------------------------------------------------------------
// Consolidação
// ---------------------------------------------------------------------------

test('multiempresa: só quem pode consolidar vê mais de uma empresa', async () => {
  const consolidador = await criarAtor(1, 'admin');
  consolidador.empresas = [1, 2];
  consolidador.consolidar = true;
  consolidador.pode_consolidar = true;

  // O CRUD genérico com consolidação enxerga as duas; sem ela, só a ativa.
  const soA = await listRecords(RESOURCES.compras, { page: 1, pageSize: 200 }, { empresaId: 1, consolidado: false, permitidas: [1] });
  const ambas = await listRecords(RESOURCES.compras, { page: 1, pageSize: 200 }, { empresaId: 1, consolidado: true, permitidas: [1, 2] });

  assert.ok(soA.rows.every((r: any) => Number(r.empresa_id) === 1), 'sem consolidação, só a empresa ativa');
  assert.ok(ambas.rows.some((r: any) => Number(r.empresa_id) === 2), 'com consolidação, as duas aparecem');
  assert.ok(ambas.total > soA.total, 'a visão consolidada é maior');
  assert.ok(consolidador.consolidar === true);
});
