// ============================================================================
// PROPOSTAS COMERCIAIS — P1
//
// O que precisa ficar travado:
//   • a máquina de estados é explícita e fechada (transição inválida → 409);
//   • o TOTAL É DO SERVIDOR (um `total` enviado no corpo é ignorado);
//   • A CONVERSÃO É IDEMPOTENTE: repetir devolve o MESMO pedido, nunca um segundo;
//   • proposta expirada não converte;
//   • o preço fica congelado no item (lista_preco_id / preco_tabela);
//   • EMPRESA A não enxerga nem converte proposta da EMPRESA B.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { podeTransicionar, propostaExpirada } = await import('../src/propostas');
const {
  ADMIN,
  criarAtor,
  garantirAdmin,
  chamar,
  esperarErro,
  novoCliente,
  novoProduto,
  reqDe,
  resFake,
} = await import('./_p1util');
const propostas = await import('../src/propostas');

await garantirAdmin();

const dia = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1) Máquina de estados
// ---------------------------------------------------------------------------

test('proposta: a máquina de estados só permite as transições declaradas', () => {
  const ok: [string, string][] = [
    ['rascunho', 'enviada'],
    ['rascunho', 'cancelada'],
    ['enviada', 'aprovada'],
    ['enviada', 'recusada'],
    ['enviada', 'cancelada'],
    ['aprovada', 'convertida'],
    ['aprovada', 'expirada'],
  ];
  for (const [de, para] of ok) assert.equal(podeTransicionar(de, para), true, `${de} → ${para} deve ser permitida`);

  const proibidas: [string, string][] = [
    ['rascunho', 'aprovada'], // não se aprova o que não foi enviado
    ['rascunho', 'convertida'], // nem se converte
    ['aprovada', 'enviada'], // não volta
    ['convertida', 'convertida'], // não converte duas vezes
    ['convertida', 'cancelada'], // convertida é terminal
    ['recusada', 'aprovada'], // recusada é terminal
    ['cancelada', 'enviada'], // cancelada é terminal
    ['expirada', 'convertida'], // expirada não vira pedido
  ];
  for (const [de, para] of proibidas) assert.equal(podeTransicionar(de, para), false, `${de} → ${para} NÃO deve ser permitida`);
});

test('proposta: aprovada com validade vencida está expirada', () => {
  assert.equal(propostaExpirada({ status: 'aprovada', valida_ate: dia(-1) } as any), true);
  assert.equal(propostaExpirada({ status: 'aprovada', valida_ate: dia(1) } as any), false);
  assert.equal(propostaExpirada({ status: 'aprovada', valida_ate: null } as any), false, 'sem validade não expira');
  assert.equal(propostaExpirada({ status: 'enviada', valida_ate: dia(-5) } as any), false, 'só a aprovada expira');
});

// ---------------------------------------------------------------------------
// 2) Criação e cálculo pelo servidor
// ---------------------------------------------------------------------------

test('proposta: o total é calculado pelo servidor — o valor enviado no corpo é ignorado', async () => {
  const p1 = await novoProduto({ preco_venda: 100 });
  const p2 = await novoProduto({ preco_venda: 50 });
  const cliente = await novoCliente();

  const criada = await chamar(propostas.criarProposta, reqDe({
      cliente_id: Number(cliente.id),
      valida_ate: dia(10),
      total: 1, // ← tentativa de fraude: o servidor ignora
      desconto: 20,
      frete: 15,
      itens: [
        { produto_id: Number(p1.id), quantidade: 2 },
        { produto_id: Number(p2.id), quantidade: 1, desconto_pct: 10 },
      ],
    }), 201);

  // 2×100 = 200 ; 1×50 com 10% = 45 → subtotal 245 ; − 20 desconto + 15 frete = 240
  assert.equal(Number(criada.subtotal_itens), 245, 'subtotal dos itens');
  assert.equal(Number(criada.total), 240, 'total do servidor (não o 1 enviado)');
  assert.equal(criada.status, 'rascunho');
  assert.equal(criada.itens.length, 2);
  assert.equal(Number(criada.itens[0].preco_unitario), 100, 'preço veio da ficha');
  assert.equal(Number(criada.itens[1].subtotal), 45);
  assert.equal(criada.eventos.length, 1, 'a criação deixa evento');
});

test('proposta: desconto acima do subtotal e item inexistente são recusados', async () => {
  const cliente = await novoCliente();
  const p1 = await novoProduto({ preco_venda: 10 });

  await esperarErro(
    () => propostas.criarProposta(reqDe({ cliente_id: Number(cliente.id), itens: [{ produto_id: Number(p1.id), quantidade: 1, desconto_pct: 150 }] }), resFake().res),
    400,
    /desconto_pct/
  );
  await esperarErro(
    () => propostas.criarProposta(reqDe({ cliente_id: Number(cliente.id), itens: [{ produto_id: 999999, quantidade: 1 }] }), resFake().res),
    404,
    /não encontrado/
  );
  await esperarErro(() => propostas.criarProposta(reqDe({ itens: [] }), resFake().res), 400, /cliente/i);
  await esperarErro(
    () => propostas.criarProposta(reqDe({ cliente_id: Number(cliente.id), itens: [] }), resFake().res),
    400,
    /ao menos um item/
  );
});

test('proposta: sem validade não se envia', async () => {
  const cliente = await novoCliente();
  const p1 = await novoProduto({ preco_venda: 30 });
  const criada = await chamar(propostas.criarProposta, reqDe({ cliente_id: Number(cliente.id), itens: [{ produto_id: Number(p1.id), quantidade: 1 }] }), 201);
  await esperarErro(
    () => propostas.enviarProposta(reqDe({}, { params: { id: criada.id } }), resFake().res),
    400,
    /validade/
  );
});

// ---------------------------------------------------------------------------
// 3) Fluxo completo até a conversão
// ---------------------------------------------------------------------------

async function propostaAprovada(opts: { validade?: number; preco?: number } = {}) {
  const produto = await novoProduto({ preco_venda: opts.preco ?? 100 });
  const cliente = await novoCliente();
  const criada = await chamar(propostas.criarProposta, reqDe({ cliente_id: Number(cliente.id), valida_ate: dia(opts.validade ?? 10), itens: [{ produto_id: Number(produto.id), quantidade: 2 }] }), 201);
  await chamar(propostas.enviarProposta, reqDe({}, { params: { id: criada.id } }));
  const aprovada = await chamar(propostas.aprovarProposta, reqDe({}, { params: { id: criada.id } }));
  return { produto, cliente, proposta: aprovada };
}

test('proposta: rascunho → enviada → aprovada → convertida gera o pedido com os itens', async () => {
  const { proposta, produto } = await propostaAprovada();
  assert.equal(proposta.status, 'aprovada');

  const conversao = await chamar(propostas.converterProposta, reqDe({}, { params: { id: proposta.id } }), 201);
  assert.equal(conversao.ok, true);
  assert.equal(conversao.idempotente, false);
  assert.ok(conversao.venda_id > 0);
  assert.equal(Number(conversao.venda.total), 200, '2 × 100');
  assert.equal(conversao.venda.status, 'aberta');
  assert.equal(Number(conversao.venda.proposta_id), Number(proposta.id));

  const s = getStore();
  const itens = await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 50, filter: { venda_id: conversao.venda_id } });
  assert.equal(itens.rows.length, 1);
  assert.equal(Number(itens.rows[0].produto_id), Number(produto.id));
  assert.equal(Number(itens.rows[0].quantidade), 2);
  assert.equal(Number(itens.rows[0].preco_unitario), 100, 'o preço da proposta foi preservado');

  const depois = await s.get(RESOURCES.propostas, Number(proposta.id));
  assert.equal(depois.status, 'convertida');
  assert.equal(Number(depois.venda_id), conversao.venda_id);
  assert.ok(depois.convertido_em, 'a data da conversão fica registrada');

  const eventos = await chamar(propostas.eventosProposta, reqDe({}, { params: { id: proposta.id } }));
  const sequencia = eventos.map((e: any) => e.para_status);
  assert.deepEqual(sequencia, ['rascunho', 'enviada', 'aprovada', 'convertida'], 'a trilha de estados é completa');
});

test('proposta: a conversão é IDEMPOTENTE — repetir devolve o mesmo pedido, não um segundo', async () => {
  const { proposta } = await propostaAprovada();
  const primeira = await chamar(propostas.converterProposta, reqDe({}, { params: { id: proposta.id } }), 201);
  const segunda = await chamar(propostas.converterProposta, reqDe({}, { params: { id: proposta.id } }));
  const terceira = await chamar(propostas.converterProposta, reqDe({}, { params: { id: proposta.id } }));

  assert.equal(primeira.idempotente, false);
  assert.equal(segunda.idempotente, true, 'a segunda chamada reconhece a conversão');
  assert.equal(terceira.idempotente, true);
  assert.equal(segunda.venda_id, primeira.venda_id, 'mesmo pedido');
  assert.equal(terceira.venda_id, primeira.venda_id);

  const s = getStore();
  const vendasDaProposta = await s.list(RESOURCES.vendas, { page: 1, pageSize: 50, filter: { proposta_id: Number(proposta.id) } });
  assert.equal(vendasDaProposta.rows.length, 1, 'UMA venda por proposta — nunca duas');
  const itens = await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 100, filter: { venda_id: primeira.venda_id } });
  assert.equal(itens.rows.length, 1, 'os itens também não foram duplicados');
});

test('proposta: transições inválidas respondem 409 e não mudam o estado', async () => {
  const { proposta } = await propostaAprovada();
  const s = getStore();

  await esperarErro(() => propostas.aprovarProposta(reqDe({}, { params: { id: proposta.id } }), resFake().res), 409, /Aprovada/);
  await esperarErro(() => propostas.enviarProposta(reqDe({}, { params: { id: proposta.id } }), resFake().res), 409);
  await esperarErro(() => propostas.cancelarProposta(reqDe({}, { params: { id: proposta.id } }), resFake().res), 409);

  const inalterada = await s.get(RESOURCES.propostas, Number(proposta.id));
  assert.equal(inalterada.status, 'aprovada');
});

test('proposta: expirada não vira pedido', async () => {
  // A proposta nasce válida (o ERP recusa validade no passado na criação) e o
  // tempo passa: é assim que uma proposta aprovada expira de verdade.
  const { proposta } = await propostaAprovada({ validade: 10 });
  const s = getStore();
  await s.update(RESOURCES.propostas, Number(proposta.id), { valida_ate: dia(-1) });

  const erro = await esperarErro(
    () => propostas.converterProposta(reqDe({}, { params: { id: proposta.id } }), resFake().res),
    409,
    /venceu/
  );
  assert.match(String(erro.message), /não pode mais virar pedido/);

  const vendas = await s.list(RESOURCES.vendas, { page: 1, pageSize: 50, filter: { proposta_id: Number(proposta.id) } });
  assert.equal(vendas.rows.length, 0, 'nenhum pedido foi criado');
});

test('proposta: recusada guarda o motivo e é terminal', async () => {
  const cliente = await novoCliente();
  const p1 = await novoProduto({ preco_venda: 10 });
  const criada = await chamar(propostas.criarProposta, reqDe({ cliente_id: Number(cliente.id), valida_ate: dia(5), itens: [{ produto_id: Number(p1.id), quantidade: 1 }] }), 201);
  await chamar(propostas.enviarProposta, reqDe({}, { params: { id: criada.id } }));
  const recusada = await chamar(propostas.recusarProposta, reqDe({ motivo: 'Cliente achou caro' }, { params: { id: criada.id } }));
  assert.equal(recusada.status, 'recusada');
  assert.match(String(recusada.recusado_motivo), /achou caro/);
  await esperarErro(() => propostas.aprovarProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 409);
  await esperarErro(() => propostas.converterProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 409);
});

test('proposta: os itens só podem ser reescritos em rascunho', async () => {
  const cliente = await novoCliente();
  const p1 = await novoProduto({ preco_venda: 10 });
  const p2 = await novoProduto({ preco_venda: 20 });
  const criada = await chamar(propostas.criarProposta, reqDe({ cliente_id: Number(cliente.id), valida_ate: dia(5), itens: [{ produto_id: Number(p1.id), quantidade: 1 }] }), 201);

  const reescrita = await chamar(propostas.reescreverItens, reqDe({ itens: [{ produto_id: Number(p2.id), quantidade: 3 }] }, { params: { id: criada.id } }));
  assert.equal(Number(reescrita.total), 60, '3 × 20 recalculado pelo servidor');

  await chamar(propostas.enviarProposta, reqDe({}, { params: { id: criada.id } }));
  await esperarErro(
    () => propostas.reescreverItens(reqDe({ itens: [{ produto_id: Number(p1.id), quantidade: 1 }] }, { params: { id: criada.id } }), resFake().res),
    409,
    /rascunho/
  );
});

// ---------------------------------------------------------------------------
// 4) Preço congelado
// ---------------------------------------------------------------------------

test('proposta: o item guarda a lista de preço e o preço de tabela do momento', async () => {
  const s = getStore();
  const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Atacado Proposta', prioridade: 20, ativo: true });
  const produto = await novoProduto({ preco_venda: 100 });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(lista.id), produto_id: Number(produto.id), preco: 70 });
  const cliente = await novoCliente();

  const criada = await chamar(propostas.criarProposta, reqDe({ cliente_id: Number(cliente.id), valida_ate: dia(5), itens: [{ produto_id: Number(produto.id), quantidade: 1 }] }), 201);
  assert.equal(Number(criada.itens[0].preco_unitario), 70, 'o preço da lista foi aplicado');
  assert.equal(Number(criada.itens[0].preco_tabela), 100);
  assert.equal(Number(criada.itens[0].lista_preco_id), Number(lista.id));

  // A lista muda; a proposta não.
  const itemLista = await s.findOneWhere(RESOURCES.lista_preco_itens, { lista_id: Number(lista.id), produto_id: Number(produto.id) });
  await s.update(RESOURCES.lista_preco_itens, Number(itemLista.id), { preco: 5 });
  const depois = await chamar(propostas.detalharProposta, reqDe({}, { params: { id: criada.id } }));
  assert.equal(Number(depois.itens[0].preco_unitario), 70, 'a proposta não foi reescrita');
  assert.equal(Number(depois.total), 70);
});

// ---------------------------------------------------------------------------
// 5) Isolamento por empresa
// ---------------------------------------------------------------------------

test('proposta: EMPRESA A não lê, não aprova e não converte proposta da EMPRESA B', async () => {
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const b = await criarAtor(2, 'gerente');
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente da B', tipo: 'pf', ativo: true });
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-PROP-B', nome: 'Produto da B', preco_venda: 300, ativo: true });

  const criada = await chamar(propostas.criarProposta, reqDe({ cliente_id: Number(clienteB.id), valida_ate: dia(5), itens: [{ produto_id: Number(produtoB.id), quantidade: 1 }] }, { user: b }), 201);
  assert.equal(Number(criada.empresa_id), 2, 'a proposta nasceu na empresa B');

  // Leitura pela A → 404 (não 403: 403 confirmaria que existe).
  await esperarErro(() => propostas.detalharProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);
  await esperarErro(() => propostas.aprovarProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);
  await esperarErro(() => propostas.converterProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);
  await esperarErro(() => propostas.eventosProposta(reqDe({}, { params: { id: criada.id } }), resFake().res), 404);

  // E nenhuma venda foi criada na empresa A a partir dela.
  const vendas = await s.list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { proposta_id: Number(criada.id) } });
  assert.equal(vendas.rows.length, 0);
});

test('proposta: cliente de outra empresa é recusado na criação', async () => {
  const s = getStore();
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente B2', tipo: 'pf', ativo: true });
  const p1 = await novoProduto({ preco_venda: 10 });
  await esperarErro(
    () => propostas.criarProposta(reqDe({ cliente_id: Number(clienteB.id), itens: [{ produto_id: Number(p1.id), quantidade: 1 }] }), resFake().res),
    404
  );
});
