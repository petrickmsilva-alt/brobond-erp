// ============================================================================
// COTAÇÃO DE COMPRA — E3
//
// O que este arquivo trava (e o que quebra se alguém mexer sem querer):
//
//  1) A decisão gera o pedido de compra UMA única vez. Repetir o POST devolve o
//     mesmo `compra_id`, não um segundo pedido. É a diferença entre um ERP e
//     uma planilha: comprar duas vezes o mesmo lote é prejuízo real.
//  2) Nenhum preço é inventado. Item sem cotação BLOQUEIA a decisão por
//     "menor_preco" — o sistema prefere parar a chutar valor de compra.
//  3) "menor_preco_total" só compara quem cotou TUDO. Total de carrinho
//     incompleto contra total completo não é comparação, é erro.
//  4) Recotar o mesmo (convite, item) ATUALIZA. Reenvio de proposta não
//     duplica linha no comparativo.
//  5) Decidir é ato de gerente. Operador monta, não decide.
//  6) MULTIEMPRESA A → B → A: a cotação da A é invisível e intocável para a B
//     (404, nunca 403 — não confirmar que o id existe).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoFornecedor, novoLocal, reqDe } = await import('./_p1util');
const cc = await import('../src/cotacoesCompra');

await garantirAdmin();
await novoLocal('loja');

const s = () => getStore();
let seqInsumo = 0;

async function novoInsumo(nome?: string, custoMedio = 10) {
  seqInsumo++;
  return s().insert(RESOURCES.insumos, {
    nome: nome ?? `Insumo Cotação ${seqInsumo}`,
    unidade: 'un',
    custo_medio: custoMedio,
    ativo: true,
  });
}

/** Cotação em RASCUNHO já com itens e fornecedores convidados. */
async function novaCotacao(itens: { qtd: number; custo?: number }[] = [{ qtd: 10 }], opts: { criterio?: string; titulo?: string } = {}) {
  const cotacao = await s().insert(RESOURCES.cotacoes_compra, {
    empresa_id: 1,
    titulo: opts.titulo ?? `Cotação ${seqInsumo}-${itens.length}`,
    status: 'rascunho',
    criterio: opts.criterio ?? 'menor_preco',
  });
  const criados: any[] = [];
  for (const it of itens) {
    const insumo = await novoInsumo(undefined, it.custo);
    const r = await chamar(
      cc.criarItemCotacao,
      reqDe({ insumo_id: Number(insumo.id), quantidade: it.qtd }, { params: { id: cotacao.id } }),
      201
    );
    criados.push({ insumo, item: r, id: Number(r.id) });
  }
  return { cotacao, itens: criados };
}

async function convidar(cotacaoId: number, n = 2) {
  const fornecedores: any[] = [];
  for (let i = 0; i < n; i++) fornecedores.push(await novoFornecedor());
  const r = await chamar(
    cc.convidarFornecedores,
    reqDe({ fornecedor_ids: fornecedores.map((f) => Number(f.id)) }, { params: { id: cotacaoId } }),
    201
  );
  const convites = await s().list(RESOURCES.cotacao_compra_fornecedores, { page: 1, pageSize: 50, filter: { cotacao_id: cotacaoId } });
  return { fornecedores, resultado: r, convites: convites.rows };
}

// ---------------------------------------------------------------------------
// 1) FLUXO COMPLETO — rascunho → cotando → decidida → pedido de compra
// ---------------------------------------------------------------------------
test('E3: cotação decidida por menor_preco gera pedido com o menor preço de cada item', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }, { qtd: 5 }]);
  const { convites } = await convidar(Number(cotacao.id), 2);
  const [a, b] = convites;

  // A é mais barata no item 1; B é mais barata no item 2 → escolha item a item.
  await chamar(
    cc.cotarFornecedor,
    reqDe(
      { convite_id: Number(a.id), precos: [
        { item_id: itens[0].id, preco_unitario: 8.5 },
        { item_id: itens[1].id, preco_unitario: 20 },
      ] },
      { params: { id: cotacao.id } }
    ),
    201
  );
  await chamar(
    cc.cotarFornecedor,
    reqDe(
      { convite_id: Number(b.id), frete: 100, precos: [
        { item_id: itens[0].id, preco_unitario: 9 },
        { item_id: itens[1].id, preco_unitario: 12 },
      ] },
      { params: { id: cotacao.id } }
    ),
    201
  );

  // Convidar já tirou a cotação do rascunho.
  const aberta = await s().get(RESOURCES.cotacoes_compra, Number(cotacao.id));
  assert.equal(aberta!.status, 'cotando', 'convidar fornecedores deveria abrir a cotação');

  const comp = await chamar(cc.comparativoCotacao, reqDe({}, { params: { id: cotacao.id } }));
  assert.equal(comp.resumo.itens, 2);
  assert.equal(comp.resumo.fornecedores_que_cotaram, 2);
  assert.equal(comp.itens[0].menor_preco, 8.5, 'menor preço do item 1 deve ser 8.50 (fornecedor A)');
  assert.equal(comp.itens[1].menor_preco, 12, 'menor preço do item 2 deve ser 12.00 (fornecedor B)');
  // Economia = (maior − menor) × quantidade: item1 (9−8.5)×10 + item2 (20−12)×5 = 5 + 40
  assert.equal(comp.resumo.economia_potencial_total, 45, 'economia potencial calculada errado');
  assert.equal(comp.fornecedores[1].total_cotado, 9 * 10 + 12 * 5, 'total cotado do fornecedor B errado');

  const decidido = await chamar(cc.decidirCotacaoCompra, reqDe({ criterio: 'menor_preco' }, { params: { id: cotacao.id } }), 201);
  assert.equal(decidido.idempotente, false);
  assert.equal(decidido.multi_fornecedor, true, 'escolha item a item com vencedores diferentes deve ser sinalizada');
  assert.equal(decidido.total, 8.5 * 10 + 12 * 5, 'total do pedido = 85 + 60');

  const compra = await s().get(RESOURCES.compras, decidido.compra_id);
  assert.ok(compra, 'pedido de compra não foi criado');
  assert.equal(compra!.status, 'pendente', 'pedido gerado por cotação nasce pendente, não recebido');
  assert.equal(Number(compra!.total), 145);
  assert.ok(/cotação #/.test(String(compra!.observacoes)), 'o pedido deve dizer de qual cotação veio');
  assert.ok(/2 fornecedores diferentes/.test(String(compra!.observacoes)), 'divergência de fornecedor precisa estar visível no pedido');

  const linhas = await s().list(RESOURCES.itens_compra, { page: 1, pageSize: 50, filter: { compra_id: decidido.compra_id } });
  assert.equal(linhas.rows.length, 2, 'pedido deve ter uma linha por item cotado');
  const porItem = new Map(linhas.rows.map((l) => [Number(l.insumo_id), Number(l.preco_unitario)]));
  assert.equal(porItem.get(Number(itens[0].insumo.id)), 8.5);
  assert.equal(porItem.get(Number(itens[1].insumo.id)), 12);

  // A trilha da escolha fica gravada no item da cotação.
  const itemCot = await s().get(RESOURCES.cotacao_compra_itens, itens[0].id);
  assert.equal(Number(itemCot!.escolhido_fornecedor_id), Number(a.fornecedor_id), 'a escolha do item 1 deveria ser o fornecedor A');
  assert.equal(Number(itemCot!.escolhido_preco), 8.5);

  const depois = await s().get(RESOURCES.cotacoes_compra, Number(cotacao.id));
  assert.equal(depois!.status, 'decidida');
  assert.equal(Number(depois!.compra_id), decidido.compra_id);
  assert.ok(depois!.decidida_em, 'decidida_em deveria ser carimbado');
});

// ---------------------------------------------------------------------------
// 2) IDEMPOTÊNCIA — a regra mais importante deste módulo
// ---------------------------------------------------------------------------
test('E3: decidir duas vezes devolve o MESMO pedido e não cria outro', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 4 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  await chamar(
    cc.cotarFornecedor,
    reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 15 }] }, { params: { id: cotacao.id } }),
    201
  );

  const antes = await s().list(RESOURCES.compras, { page: 1, pageSize: 5000 });
  const primeiro = await chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 201);
  const segundo = await chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 200);
  const terceiro = await chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 200);

  assert.equal(segundo.compra_id, primeiro.compra_id, 'a segunda decisão criou um pedido diferente');
  assert.equal(terceiro.compra_id, primeiro.compra_id);
  assert.equal(segundo.idempotente, true);
  assert.match(segundo.mensagem, /já gerou o pedido/);

  const depois = await s().list(RESOURCES.compras, { page: 1, pageSize: 5000 });
  assert.equal(depois.rows.length, antes.rows.length + 1, 'mais de um pedido foi criado para a mesma cotação');

  const linhas = await s().list(RESOURCES.itens_compra, { page: 1, pageSize: 50, filter: { compra_id: primeiro.compra_id } });
  assert.equal(linhas.rows.length, 1, 'as linhas do pedido foram duplicadas pela repetição');
});

// ---------------------------------------------------------------------------
// 3) NENHUM PREÇO INVENTADO
// ---------------------------------------------------------------------------
test('E3: item sem cotação bloqueia a decisão — o sistema para em vez de chutar preço', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }, { qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  // Cotou só o primeiro item.
  await chamar(
    cc.cotarFornecedor,
    reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 7 }] }, { params: { id: cotacao.id } }),
    201
  );

  const comp = await chamar(cc.comparativoCotacao, reqDe({}, { params: { id: cotacao.id } }));
  assert.equal(comp.resumo.itens_sem_cotacao, 1, 'o comparativo precisa expor o item órfão');
  assert.equal(comp.itens[1].menor_preco, null, 'item sem cotação não tem "menor preço"');
  assert.equal(comp.itens[1].melhor_fornecedor, null);

  await esperarErro(() => chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 201), 409, /Nenhum fornecedor cotou/);

  // E nada de pedido pela metade.
  const c = await s().get(RESOURCES.cotacoes_compra, Number(cotacao.id));
  assert.equal(c!.status, 'cotando', 'a cotação não pode sair de cotando numa decisão recusada');
  assert.equal(c!.compra_id, null);
});

test('E3: fornecedor que informou indisponibilidade não ganha o item', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 2);
  const [a, b] = convites;
  // A é mais barato mas NÃO TEM; B é mais caro e tem.
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(a.id), precos: [{ item_id: itens[0].id, preco_unitario: 3, disponivel: false }] }, { params: { id: cotacao.id } }), 201);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(b.id), precos: [{ item_id: itens[0].id, preco_unitario: 30 }] }, { params: { id: cotacao.id } }), 201);

  // O preço indisponível APARECE na matriz (o comprador precisa ver que o
  // fornecedor respondeu e disse que não tem), mas não compete no menor preço
  // nem na economia. Esconder a linha faria parecer que ninguém respondeu.
  const comp = await chamar(cc.comparativoCotacao, reqDe({}, { params: { id: cotacao.id } }));
  assert.equal(comp.itens[0].precos.length, 2, 'a proposta indisponível deve continuar visível no comparativo');
  assert.equal(comp.itens[0].precos.filter((p: any) => p.disponivel === false).length, 1);
  assert.equal(comp.itens[0].menor_preco, 30, 'o indisponível de R$ 3 não pode ser o "menor preço"');
  assert.equal(comp.itens[0].melhor_fornecedor, String(comp.fornecedores[1].fornecedor));
  assert.equal(comp.itens[0].economia_potencial, 0, 'com um único preço disponível não há economia a prometer');
  assert.equal(comp.itens[0].cotacoes_recebidas, 1, 'só cotação disponível conta como recebida');

  const decidido = await chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 201);
  assert.equal(decidido.total, 300, 'deveria ter escolhido o disponível (30 × 10), não o mais barato indisponível');
  assert.equal(decidido.multi_fornecedor, false);
});

// ---------------------------------------------------------------------------
// 4) CRITÉRIOS
// ---------------------------------------------------------------------------
test('E3: menor_preco_total só compara quem cotou TUDO, e considera o frete', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }, { qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 3);
  const [a, b, c] = convites;

  // A cotou tudo, total 100+100=200, frete 0 → 200
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(a.id), precos: [{ item_id: itens[0].id, preco_unitario: 10 }, { item_id: itens[1].id, preco_unitario: 10 }] }, { params: { id: cotacao.id } }), 201);
  // B cotou tudo, itens 180, MAS frete 50 → 230. Item a item B seria mais barato
  // no item 1; por total A ganha. O frete é o que decide.
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(b.id), frete: 50, precos: [{ item_id: itens[0].id, preco_unitario: 8 }, { item_id: itens[1].id, preco_unitario: 10 }] }, { params: { id: cotacao.id } }), 201);
  // C cotou só um item → não pode entrar na comparação de total.
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(c.id), precos: [{ item_id: itens[0].id, preco_unitario: 1 }] }, { params: { id: cotacao.id } }), 201);

  const comp = await chamar(cc.comparativoCotacao, reqDe({}, { params: { id: cotacao.id } }));
  assert.equal(comp.fornecedores[2].total_cotado, null, 'fornecedor que não cotou tudo não tem total comparável');

  const decidido = await chamar(cc.decidirCotacaoCompra, reqDe({ criterio: 'menor_preco_total' }, { params: { id: cotacao.id } }), 201);
  assert.equal(decidido.multi_fornecedor, false, 'menor_preco_total é fornecedor único');
  assert.equal(decidido.total, 200, 'deveria escolher A (200) e não B (230 com frete)');

  const linhas = await s().list(RESOURCES.itens_compra, { page: 1, pageSize: 50, filter: { compra_id: decidido.compra_id } });
  assert.equal(linhas.rows.length, 2);
  const compra = await s().get(RESOURCES.compras, decidido.compra_id);
  assert.equal(Number(compra!.fornecedor_id), Number(a.fornecedor_id), 'o pedido deveria ficar com o fornecedor A (menor total com frete)');
  assert.equal(linhas.rows.every((l) => Number(l.insumo_id) > 0), true, 'as linhas do pedido precisam apontar para o insumo');
});

test('E3: menor_preco_total recusa quando ninguém cotou todos os itens', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }, { qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 5 }] }, { params: { id: cotacao.id } }), 201);
  await esperarErro(
    () => chamar(cc.decidirCotacaoCompra, reqDe({ criterio: 'menor_preco_total' }, { params: { id: cotacao.id } }), 201),
    409,
    /Nenhum fornecedor cotou todos os itens/
  );
});

test('E3: critério "prazo" prefere a entrega mais rápida, desempate por preço', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 2);
  const [a, b] = convites;
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(a.id), precos: [{ item_id: itens[0].id, preco_unitario: 5, prazo_entrega_dias: 30 }] }, { params: { id: cotacao.id } }), 201);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(b.id), precos: [{ item_id: itens[0].id, preco_unitario: 50, prazo_entrega_dias: 3 }] }, { params: { id: cotacao.id } }), 201);

  const decidido = await chamar(cc.decidirCotacaoCompra, reqDe({ criterio: 'prazo' }, { params: { id: cotacao.id } }), 201);
  assert.equal(decidido.total, 500, 'pelo critério prazo vale a entrega em 3 dias mesmo custando 10×');
});

test('E3: critério "qualidade" exige escolha explícita de CADA item', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }, { qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  const convite = Number(convites[0].id);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: convite, precos: [{ item_id: itens[0].id, preco_unitario: 5 }, { item_id: itens[1].id, preco_unitario: 6 }] }, { params: { id: cotacao.id } }), 201);

  await esperarErro(
    () => chamar(cc.decidirCotacaoCompra, reqDe({ criterio: 'qualidade', escolhas: [{ item_id: itens[0].id, convite_id: convite }] }, { params: { id: cotacao.id } }), 201),
    400,
    /exige a escolha explícita/
  );
  await esperarErro(
    () => chamar(cc.decidirCotacaoCompra, reqDe({ criterio: 'inexistente' }, { params: { id: cotacao.id } }), 201),
    400,
    /Critério inválido/
  );

  const decidido = await chamar(
    cc.decidirCotacaoCompra,
    reqDe({ criterio: 'qualidade', escolhas: [
      { item_id: itens[0].id, convite_id: convite },
      { item_id: itens[1].id, convite_id: convite },
    ] }, { params: { id: cotacao.id } }),
    201
  );
  assert.equal(decidido.total, 5 * 10 + 6 * 10);
});

// ---------------------------------------------------------------------------
// 5) REGRAS DE ESTADO
// ---------------------------------------------------------------------------
test('E3: depois de decidida a cotação é só leitura (item, convite, edição)', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 5 }] }, { params: { id: cotacao.id } }), 201);
  await chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 201);

  const insumo = await novoInsumo();
  await esperarErro(() => chamar(cc.criarItemCotacao, reqDe({ insumo_id: Number(insumo.id), quantidade: 1 }, { params: { id: cotacao.id } }), 201), 409, /decidida/);
  await esperarErro(() => chamar(cc.atualizarItemCotacao, reqDe({ quantidade: 99 }, { params: { id: cotacao.id, itemId: itens[0].id } })), 409, /decidida/);
  await esperarErro(() => chamar(cc.removerItemCotacao, reqDe({}, { params: { id: cotacao.id, itemId: itens[0].id } })), 409, /decidida/);
  await esperarErro(() => chamar(cc.convidarFornecedores, reqDe({ fornecedor_ids: [1] }, { params: { id: cotacao.id } }), 201), 409, /decidida/);
  await esperarErro(() => chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 1 }] }, { params: { id: cotacao.id } }), 201), 409, /Só se registra cotação/);
  // Cancelar uma cotação que já gerou pedido apagaria a trilha da escolha.
  await esperarErro(() => chamar(cc.cancelarCotacao, reqDe({ motivo: 'x' }, { params: { id: cotacao.id } })), 409, /já gerou o pedido/);
});

test('E3: abrir exige carrinho e fornecedor; recusa marca o convite', async () => {
  const vazia = await s().insert(RESOURCES.cotacoes_compra, { empresa_id: 1, titulo: 'Vazia', status: 'rascunho', criterio: 'menor_preco' });
  await esperarErro(() => chamar(cc.abrirCotacao, reqDe({}, { params: { id: vazia.id } })), 409, /ao menos um item/);

  const { cotacao } = await novaCotacao([{ qtd: 3 }]);
  await esperarErro(() => chamar(cc.abrirCotacao, reqDe({}, { params: { id: cotacao.id } })), 409, /Convide ao menos um fornecedor/);
  // Convidar sem item também é recusado — convite sem carrinho não tem o que orçar.
  await esperarErro(() => chamar(cc.convidarFornecedores, reqDe({ fornecedor_ids: [1] }, { params: { id: vazia.id } }), 201), 409, /antes de convidar/);

  const { convites } = await convidar(Number(cotacao.id), 1);
  const recusada = await chamar(cc.recusarCotacao, reqDe({ convite_id: Number(convites[0].id) }, { params: { id: cotacao.id } }));
  assert.equal(recusada.status, 'recusado');
  assert.ok(recusada.respondeu_em);
});

test('E3: convidar o mesmo fornecedor duas vezes não duplica convite', async () => {
  const { cotacao } = await novaCotacao([{ qtd: 1 }]);
  const f = await novoFornecedor();
  await chamar(cc.convidarFornecedores, reqDe({ fornecedor_ids: [Number(f.id)] }, { params: { id: cotacao.id } }), 201);
  const deNovo = await chamar(cc.convidarFornecedores, reqDe({ fornecedor_ids: [Number(f.id)] }, { params: { id: cotacao.id } }), 201);
  assert.equal(deNovo.convidados, 0);
  assert.deepEqual(deNovo.ja_convidados, [Number(f.id)]);
  const convites = await s().list(RESOURCES.cotacao_compra_fornecedores, { page: 1, pageSize: 50, filter: { cotacao_id: Number(cotacao.id) } });
  assert.equal(convites.rows.length, 1);
});

test('E3: recotar o mesmo item ATUALIZA o preço em vez de duplicar a linha', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  const convite = Number(convites[0].id);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: convite, precos: [{ item_id: itens[0].id, preco_unitario: 50 }] }, { params: { id: cotacao.id } }), 201);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: convite, precos: [{ item_id: itens[0].id, preco_unitario: 20 }] }, { params: { id: cotacao.id } }), 201);

  const precos = await s().list(RESOURCES.cotacao_compra_precos, { page: 1, pageSize: 50, filter: { convite_id: convite } });
  assert.equal(precos.rows.length, 1, 'a recotação duplicou a linha de preço');
  assert.equal(Number(precos.rows[0].preco_unitario), 20, 'a recotação deveria sobrescrever o preço');

  const comp = await chamar(cc.comparativoCotacao, reqDe({}, { params: { id: cotacao.id } }));
  assert.equal(comp.itens[0].cotacoes_recebidas, 1);
  assert.equal(comp.itens[0].menor_preco, 20);
});

test('E3: validações de entrada (quantidade, preço, item alheio, origem dupla)', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  const convite = Number(convites[0].id);

  const insumo = await novoInsumo();
  await esperarErro(() => chamar(cc.criarItemCotacao, reqDe({ insumo_id: Number(insumo.id), quantidade: 0 }, { params: { id: cotacao.id } }), 201), 400, /maior que zero/i);
  await esperarErro(() => chamar(cc.criarItemCotacao, reqDe({ quantidade: 1 }, { params: { id: cotacao.id } }), 201), 400, /insumo ou o produto/i);
  const produto = await (await import('./_p1util')).novoProduto({});
  await esperarErro(() => chamar(cc.criarItemCotacao, reqDe({ insumo_id: Number(insumo.id), produto_id: Number(produto.id), quantidade: 1 }, { params: { id: cotacao.id } }), 201), 400, /OU um produto/);
  await esperarErro(() => chamar(cc.criarItemCotacao, reqDe({ insumo_id: Number(itens[0].insumo.id), quantidade: 2 }, { params: { id: cotacao.id } }), 201), 409, /já está na cotação/);

  // Item que não pertence à cotação não entra na proposta do fornecedor.
  await esperarErro(() => chamar(cc.cotarFornecedor, reqDe({ convite_id: convite, precos: [{ item_id: 999999, preco_unitario: 1 }] }, { params: { id: cotacao.id } }), 201), 404, /não pertence/);
  await esperarErro(() => chamar(cc.cotarFornecedor, reqDe({ convite_id: convite, precos: [] }, { params: { id: cotacao.id } }), 201), 400, /ao menos um preço/);
  await esperarErro(() => chamar(cc.cotarFornecedor, reqDe({ convite_id: 999999, precos: [{ item_id: itens[0].id, preco_unitario: 1 }] }, { params: { id: cotacao.id } }), 201), 404, /Convite não encontrado/);
  // Preço unitário negativo seria crédito ao fornecedor.
  await esperarErro(() => chamar(cc.cotarFornecedor, reqDe({ convite_id: convite, precos: [{ item_id: itens[0].id, preco_unitario: -5 }] }, { params: { id: cotacao.id } }), 201), 400, /Preço inválido/);
  await esperarErro(() => chamar(cc.cotarFornecedor, reqDe({ convite_id: convite, precos: [{ item_id: itens[0].id, preco_unitario: 5, prazo_entrega_dias: -3 }] }, { params: { id: cotacao.id } }), 201), 400, /Prazo inválido/);

  await esperarErro(() => chamar(cc.atualizarItemCotacao, reqDe({ quantidade: 5 }, { params: { id: cotacao.id, itemId: 999999 } })), 404, /não encontrado nesta cotação/);
  await esperarErro(() => chamar(cc.removerItemCotacao, reqDe({}, { params: { id: cotacao.id, itemId: 999999 } })), 404, /não encontrado nesta cotação/);
});

// ---------------------------------------------------------------------------
// 6) ALÇADA — decidir é ato de gerente
// ---------------------------------------------------------------------------
test('E3: operador monta a cotação mas NÃO decide nem cancela', async () => {
  const operador = await criarAtor(1, 'operador');
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 5 }] }, { params: { id: cotacao.id } }), 201);

  // O operador mexe no carrinho normalmente.
  await chamar(cc.atualizarItemCotacao, reqDe({ quantidade: 12 }, { params: { id: cotacao.id, itemId: itens[0].id }, user: operador }));

  await esperarErro(() => chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id }, user: operador }), 201), 403, /Somente gerentes e administradores/);
  await esperarErro(() => chamar(cc.cancelarCotacao, reqDe({}, { params: { id: cotacao.id }, user: operador })), 403, /Somente gerentes e administradores/);

  // Nada vazou: a cotação segue aberta e sem pedido.
  const c = await s().get(RESOURCES.cotacoes_compra, Number(cotacao.id));
  assert.equal(c!.status, 'cotando');
  assert.equal(c!.compra_id, null);
});

// ---------------------------------------------------------------------------
// 7) MULTIEMPRESA A → B → A
// ---------------------------------------------------------------------------
test('E3: a cotação da empresa A é invisível e intocável para a empresa B', async () => {
  const empresaB = await s().insert(RESOURCES.empresas, { nome: 'Empresa B Cotações', cnpj: '33444555000170', ativo: true });
  const gerenteB = await criarAtor(Number(empresaB.id), 'gerente');

  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 5 }] }, { params: { id: cotacao.id } }), 201);

  const insumoB = await s().insert(RESOURCES.insumos, { empresa_id: Number(empresaB.id), nome: 'Insumo da B', unidade: 'un', ativo: true });

  // 404, não 403: a existência de um id alheio não é informação a vazar.
  for (const [nome, fn, corpo, esperado] of [
    ['comparativo', cc.comparativoCotacao, {}, 200],
    ['item', cc.criarItemCotacao, { insumo_id: Number(insumoB.id), quantidade: 1 }, 201],
    ['editar item', cc.atualizarItemCotacao, { quantidade: 2 }, 200],
    ['remover item', cc.removerItemCotacao, {}, 200],
    ['convidar', cc.convidarFornecedores, { fornecedor_ids: [1] }, 201],
    ['abrir', cc.abrirCotacao, {}, 200],
    ['cotar', cc.cotarFornecedor, { convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 1 }] }, 201],
    ['recusar', cc.recusarCotacao, { convite_id: Number(convites[0].id) }, 200],
    ['decidir', cc.decidirCotacaoCompra, {}, 201],
    ['cancelar', cc.cancelarCotacao, {}, 200],
  ] as const) {
    const params: Record<string, unknown> = { id: cotacao.id };
    if (nome === 'editar item' || nome === 'remover item') params.itemId = itens[0].id;
    await esperarErro(
      () => chamar(fn as any, reqDe(corpo as any, { params, user: gerenteB }), esperado as any),
      404
    );
    void nome;
  }

  // O insumo da B também não entra na cotação da A, mesmo com um gerente da A.
  await esperarErro(() => chamar(cc.criarItemCotacao, reqDe({ insumo_id: Number(insumoB.id), quantidade: 1 }, { params: { id: cotacao.id } }), 201), 404);

  // E a A continua operando depois das tentativas.
  const decidido = await chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 201);
  assert.equal(decidido.total, 50);
  const compra = await s().get(RESOURCES.compras, decidido.compra_id);
  assert.equal(Number(compra!.empresa_id), 1, 'o pedido gerado deve herdar a empresa da cotação');

  // O convite de outra empresa não é aceitável nem por id direto.
  await esperarErro(() => chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 1 }] }, { params: { id: cotacao.id }, user: gerenteB }), 201), 404);
});

// ---------------------------------------------------------------------------
// 8) CANCELAMENTO
// ---------------------------------------------------------------------------
test('E3: cancelar uma cotação aberta não cria pedido nem mexe em estoque', async () => {
  const { cotacao, itens } = await novaCotacao([{ qtd: 10 }]);
  const { convites } = await convidar(Number(cotacao.id), 1);
  await chamar(cc.cotarFornecedor, reqDe({ convite_id: Number(convites[0].id), precos: [{ item_id: itens[0].id, preco_unitario: 5 }] }, { params: { id: cotacao.id } }), 201);

  const comprasAntes = await s().list(RESOURCES.compras, { page: 1, pageSize: 5000 });
  const cancelada = await chamar(cc.cancelarCotacao, reqDe({ motivo: 'compramos de outro' }, { params: { id: cotacao.id } }));
  assert.equal(cancelada.status, 'cancelada');
  const comprasDepois = await s().list(RESOURCES.compras, { page: 1, pageSize: 5000 });
  assert.equal(comprasDepois.rows.length, comprasAntes.rows.length, 'cancelar cotação não pode criar pedido');

  await esperarErro(() => chamar(cc.cancelarCotacao, reqDe({}, { params: { id: cotacao.id } })), 409, /já está cancelada/);
  await esperarErro(() => chamar(cc.decidirCotacaoCompra, reqDe({}, { params: { id: cotacao.id } }), 201), 409, /Só se decide uma cotação aberta/);
});
