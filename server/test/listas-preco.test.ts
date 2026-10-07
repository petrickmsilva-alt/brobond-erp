// ============================================================================
// LISTAS DE PREÇO — P1
//
// O que precisa ficar travado:
//   • a resolução é determinística: ativa → vigência → prioridade → mais recente;
//   • o preço aplicado fica CONGELADO no item da venda (mudar a lista depois
//     não reescreve a venda);
//   • toda mudança de preço deixa histórico;
//   • a lista de outra empresa não interfere (isolamento);
//   • sem lista aplicável, cai no preço da ficha — nunca inventa valor.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { escopoDoAtor } = await import('../src/empresa');
const { ordenarListas, listaVigente, precoDe, listarItensLista, gravarItensLista, historicoLista, resolverLista, removerItemLista } = await import('../src/listasPreco');
const { ADMIN, garantirAdmin, reqDe, resFake, chamar, esperarErro, novoProduto, novoCliente } = await import('./_p1util');

await garantirAdmin();

const ESCOPO = escopoDoAtor(ADMIN as any);
const dia = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1) Regras puras de resolução
// ---------------------------------------------------------------------------

test('lista de preço: desempate por prioridade e, em empate, pela mais recente', () => {
  const baixa = { id: 1, prioridade: 0, ativo: true };
  const antiga = { id: 2, prioridade: 5, ativo: true };
  const nova = { id: 3, prioridade: 5, ativo: true };
  const altissima = { id: 4, prioridade: 99, ativo: true };
  const ordem = ordenarListas([baixa, antiga, nova, altissima] as any[]).map((l) => l.id);
  assert.deepEqual(ordem, [4, 3, 2, 1], 'prioridade desc; empate → maior id primeiro');
});

test('lista de preço: vigência decide antes da prioridade', () => {
  const futura = { id: 1, prioridade: 99, ativo: true, inicio_em: dia(5), fim_em: dia(30) };
  const vencida = { id: 2, prioridade: 98, ativo: true, inicio_em: dia(-30), fim_em: dia(-1) };
  const inativa = { id: 3, prioridade: 97, ativo: false, inicio_em: null, fim_em: null };
  const valida = { id: 4, prioridade: 1, ativo: true, inicio_em: dia(-1), fim_em: dia(10) };
  assert.equal(listaVigente(futura as any), false, 'ainda não começou');
  assert.equal(listaVigente(vencida as any), false, 'já venceu');
  assert.equal(listaVigente(inativa as any), false, 'desativada');
  assert.equal(listaVigente(valida as any), true, 'dentro da vigência');
  // Sem vigência informada, vale sempre (enquanto ativa).
  assert.equal(listaVigente({ id: 5, ativo: true } as any), true);
});

// ---------------------------------------------------------------------------
// 2) Resolução contra o banco
// ---------------------------------------------------------------------------

test('lista de preço: a lista ativa de maior prioridade vence e o resto é ignorado', async () => {
  const produto = await novoProduto({ preco_venda: 100 });
  const s = getStore();

  const varejo = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Varejo', prioridade: 1, ativo: true });
  const atacado = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Atacado', prioridade: 10, ativo: true });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(varejo.id), produto_id: Number(produto.id), preco: 95 });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(atacado.id), produto_id: Number(produto.id), preco: 70 });

  const resolvido = await precoDe(produto, ESCOPO);
  assert.equal(resolvido.preco, 70, 'Atacado (prioridade 10) vence');
  assert.equal(resolvido.origem, 'lista');
  assert.equal(resolvido.lista_id, Number(atacado.id));
  assert.equal(resolvido.lista_nome, 'Atacado');
  assert.equal(resolvido.preco_tabela, 100, 'o preço da ficha fica registrado ao lado');

  // Desativar o Atacado faz o Varejo assumir.
  await s.update(RESOURCES.listas_preco, Number(atacado.id), { ativo: false });
  const depois = await precoDe(produto, ESCOPO);
  assert.equal(depois.preco, 95);
  assert.equal(depois.lista_id, Number(varejo.id));

  // Sem nenhuma lista aplicável, cai na ficha — nunca inventa.
  await s.update(RESOURCES.listas_preco, Number(varejo.id), { ativo: false });
  const semLista = await precoDe(produto, ESCOPO);
  assert.equal(semLista.preco, 100);
  assert.equal(semLista.origem, 'produto');
  assert.equal(semLista.lista_id, null);
});

test('lista de preço: fora da vigência não se aplica, mesmo sendo a de maior prioridade', async () => {
  const produto = await novoProduto({ preco_venda: 200 });
  const s = getStore();
  const blackFriday = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Black Friday', prioridade: 100, ativo: true, inicio_em: dia(10), fim_em: dia(20) });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(blackFriday.id), produto_id: Number(produto.id), preco: 50 });

  const hoje = await precoDe(produto, ESCOPO);
  assert.equal(hoje.preco, 200, 'a promoção ainda não começou');

  // Daqui a 12 dias ela vale.
  const naPromo = await precoDe(produto, ESCOPO, null, dia(12));
  assert.equal(naPromo.preco, 50);
  assert.equal(naPromo.lista_id, Number(blackFriday.id));
});

// ---------------------------------------------------------------------------
// 3) Gravação em lote + histórico
// ---------------------------------------------------------------------------

test('lista de preço: gravação em lote valida produto/empresa e deixa histórico', async () => {
  const s = getStore();
  const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Revenda', prioridade: 2, ativo: true });
  const p1 = await novoProduto({ preco_venda: 50 });
  const p2 = await novoProduto({ preco_venda: 60 });

  const primeira = await chamar(
    gravarItensLista,
    reqDe({ itens: [{ produto_id: Number(p1.id), preco: 45 }, { produto_id: Number(p2.id), preco: 54 }] }, { params: { id: lista.id } })
  );
  assert.equal(primeira.ok, true);
  assert.equal(primeira.criados, 2);
  assert.equal(primeira.alterados, 0);

  // Alterar um preço gera histórico; repetir o mesmo valor não.
  const segunda = await chamar(
    gravarItensLista,
    reqDe({ itens: [{ produto_id: Number(p1.id), preco: 40 }, { produto_id: Number(p2.id), preco: 54 }] }, { params: { id: lista.id } })
  );
  assert.equal(segunda.alterados, 1);
  assert.equal(segunda.inalterados, 1);

  const historico = await chamar(historicoLista, reqDe({}, { params: { id: lista.id } }));
  assert.equal(historico.length, 3, '2 criações + 1 alteração');
  const alteracao = historico.find((h: any) => h.preco_anterior !== null && h.preco_novo !== null);
  assert.equal(Number(alteracao.preco_anterior), 45);
  assert.equal(Number(alteracao.preco_novo), 40);

  // Produto inexistente: quando NENHUMA linha passa, o endpoint recusa com 422
  // em vez de responder "ok" para uma gravação que não aconteceu.
  const erroInexistente = await esperarErro(
    () => gravarItensLista(reqDe({ itens: [{ produto_id: 999999, preco: 10 }] }, { params: { id: lista.id } }), resFake().res),
    422,
    /Nenhum preço pôde ser gravado/
  );
  assert.match(erroInexistente.fields.erros[0].mensagem, /não encontrado nesta empresa/);

  // Preço negativo também é recusado.
  const erroNegativo = await esperarErro(
    () => gravarItensLista(reqDe({ itens: [{ produto_id: Number(p1.id), preco: -5 }] }, { params: { id: lista.id } }), resFake().res),
    422
  );
  assert.match(erroNegativo.fields.erros[0].mensagem, /maior|≥ 0|inválido|>= 0/i);
});

test('lista de preço: remover um preço volta para a ficha e registra no histórico', async () => {
  const s = getStore();
  const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Temporária', prioridade: 3, ativo: true });
  const produto = await novoProduto({ preco_venda: 80 });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(lista.id), produto_id: Number(produto.id), preco: 60 });

  assert.equal((await precoDe(produto, ESCOPO)).preco, 60);
  await chamar(removerItemLista, reqDe({}, { params: { id: lista.id, produtoId: produto.id } }));
  assert.equal((await precoDe(produto, ESCOPO)).preco, 80, 'volta ao preço da ficha');

  const historico = await chamar(historicoLista, reqDe({}, { params: { id: lista.id } }));
  const remocao = historico.find((h: any) => h.preco_novo === null);
  assert.ok(remocao, 'a remoção fica registrada');
  assert.equal(Number(remocao.preco_anterior), 60);
});

test('lista de preço: a listagem mostra a diferença contra a ficha', async () => {
  const s = getStore();
  const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Diferença', prioridade: 1, ativo: true });
  const produto = await novoProduto({ preco_venda: 100 });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(lista.id), produto_id: Number(produto.id), preco: 80 });

  const out = await chamar(listarItensLista, reqDe({}, { params: { id: lista.id } }));
  assert.equal(out.lista.nome, 'Diferença');
  assert.equal(out.itens.length, 1);
  assert.equal(Number(out.itens[0].preco), 80);
  assert.equal(Number(out.itens[0].preco_ficha), 100);
  assert.equal(Number(out.itens[0].diferenca_pct), -20);
});

// ---------------------------------------------------------------------------
// 4) Isolamento por empresa
// ---------------------------------------------------------------------------

test('lista de preço: a lista da EMPRESA B não altera o preço na EMPRESA A', async () => {
  const s = getStore();
  const produto = await novoProduto({ preco_venda: 120 });
  const b = await s.insert(RESOURCES.listas_preco, { empresa_id: 2, nome: 'Atacado da B', prioridade: 999, ativo: true });
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 2, lista_id: Number(b.id), produto_id: Number(produto.id), preco: 1 });

  const naA = await precoDe(produto, ESCOPO);
  assert.equal(naA.preco, 120, 'a lista de outra empresa é invisível');
  assert.equal(naA.origem, 'produto');

  // E a listagem/resolução pela API também não a enxerga.
  const out = await chamar(resolverLista, reqDe({}, { query: { produto_id: produto.id } }));
  assert.equal(out.candidatas.length, 0);
  assert.equal(out.aplicado.preco, 120);
});

test('lista de preço: gravar preço em produto de outra empresa é recusado', async () => {
  const s = getStore();
  const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Da A', prioridade: 1, ativo: true });
  const produtoDaB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-PRODUTO-DA-B', nome: 'Produto da B', preco_venda: 10, ativo: true });

  const erro = await esperarErro(
    () => gravarItensLista(reqDe({ itens: [{ produto_id: Number(produtoDaB.id), preco: 1 }] }, { params: { id: lista.id } }), resFake().res),
    422
  );
  assert.match(erro.fields.erros[0].mensagem, /não encontrado nesta empresa/);
  // E nada foi gravado.
  const itens = await s.list(RESOURCES.lista_preco_itens, { page: 1, pageSize: 100, filter: { lista_id: Number(lista.id) } });
  assert.equal(itens.rows.length, 0, 'nenhum preço vazou para a lista da empresa A');
});

// ---------------------------------------------------------------------------
// 5) O preço fica congelado na venda
// ---------------------------------------------------------------------------

test('lista de preço: o preço usado fica congelado no item da venda', async () => {
  const s = getStore();
  const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Congelada', prioridade: 50, ativo: true });
  const produto = await novoProduto({ preco_venda: 100 });
  const cliente = await novoCliente();
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(lista.id), produto_id: Number(produto.id), preco: 75 });

  // Simula o que o PDV/proposta fazem: resolver e gravar o preço na hora.
  const resolvido = await precoDe(produto, ESCOPO);
  const venda = await s.insert(RESOURCES.vendas, { empresa_id: 1, cliente_id: Number(cliente.id), data: '2026-10-07', status: 'aberta', canal_venda: 'balcao', total: 75 });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: 1,
    venda_id: Number(venda.id),
    produto_id: Number(produto.id),
    tamanho_id: null,
    quantidade: 1,
    preco_unitario: resolvido.preco,
    desconto_pct: 0,
    subtotal: resolvido.preco,
    lista_preco_id: resolvido.lista_id,
    preco_tabela: resolvido.preco_tabela,
  });

  // Agora a lista muda de preço.
  const itemLista = await s.findOneWhere(RESOURCES.lista_preco_itens, { lista_id: Number(lista.id), produto_id: Number(produto.id) });
  await s.update(RESOURCES.lista_preco_itens, Number(itemLista.id), { preco: 10 });

  const item = (await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 10, filter: { venda_id: Number(venda.id) } })).rows[0];
  assert.equal(Number(item.preco_unitario), 75, 'a venda NÃO foi reescrita');
  assert.equal(Number(item.subtotal), 75);
  assert.equal(Number(item.lista_preco_id), Number(lista.id), 'fica registrado qual lista deu o preço');
  assert.equal(Number(item.preco_tabela), 100, 'e qual era o preço de tabela');

  // Uma venda NOVA pega o preço novo.
  const nova = await precoDe(produto, ESCOPO);
  assert.equal(nova.preco, 10);
});
