// ============================================================================
// EXPEDIÇÃO E LOGÍSTICA REVERSA — P1 §14 e §15
//
// §14: PEDIDO → SEPARAÇÃO → CONFERÊNCIA → EMBALAGEM → EXPEDIÇÃO, conferindo
//      SKU/quantidade por código de barras, com divergência auditada.
//      Regra que não pode quebrar: conferência reprovada NÃO baixa estoque, e
//      a baixa só acontece na expedição.
// §15: devolução com rastreabilidade — solicitação → autorização → rastreamento
//      → recebimento → conferência → estoque → financeiro. Sem código de
//      rastreio, nada entra no estoque.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { ETAPAS, proximaEtapa, compararLeitura } = await import('../src/expedicao');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoCliente, novoLocal, novoProduto, reqDe, resFake, saldoInicial } = await import('./_p1util');
const exp = await import('../src/expedicao');

await garantirAdmin();
await novoLocal('loja');

/** Venda aberta (não faturada) com itens que TÊM código de barras. */
async function pedidoParaExpedir(quantidades: number[] = [2], opts: { status?: string; comCodigo?: boolean } = {}) {
  const s = getStore();
  const cliente = await novoCliente();
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    cliente_id: Number(cliente.id),
    data: new Date().toISOString().slice(0, 10),
    status: opts.status ?? 'aberta',
    total: 0,
  });
  const codigos: string[] = [];
  const itens: any[] = [];
  for (let i = 0; i < quantidades.length; i++) {
    const qtd = quantidades[i];
    const codigo = opts.comCodigo === false ? null : `78900000${String(i).padStart(5, '0')}${String(Date.now()).slice(-4)}`;
    const p = await novoProduto({ preco_venda: 100, codigo_barras: codigo ?? undefined });
    await saldoInicial(p, 500);
    const est = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(p.id) });
    const item = await s.insert(RESOURCES.itens_venda, {
      empresa_id: 1,
      venda_id: Number(venda.id),
      produto_id: Number(p.id),
      tamanho_id: Number(est.tamanho_id),
      quantidade: qtd,
      preco_unitario: 100,
      subtotal: qtd * 100,
    });
    itens.push({ produto: p, item, tamanho_id: Number(est.tamanho_id) });
    for (let k = 0; k < qtd; k++) codigos.push(String(codigo));
  }
  await s.update(RESOURCES.vendas, Number(venda.id), { total: quantidades.reduce((a, b) => a + b, 0) * 100 });
  return { venda, itens, codigos };
}

// ---------------------------------------------------------------------------
// 1) Máquina de etapas e comparação de leitura (puras)
// ---------------------------------------------------------------------------

test('expedição: a ordem das etapas é fixa e só se avança uma por vez', () => {
  assert.deepEqual(ETAPAS, ['pendente', 'separacao', 'conferida', 'embalada', 'expedida']);
  assert.equal(proximaEtapa('pendente', 'separacao'), true);
  assert.equal(proximaEtapa('separacao', 'conferida'), true);
  assert.equal(proximaEtapa('conferida', 'embalada'), true);
  assert.equal(proximaEtapa('embalada', 'expedida'), true);

  // Pular etapa não pode.
  assert.equal(proximaEtapa('pendente', 'conferida'), false, 'não se confere sem separar');
  assert.equal(proximaEtapa('pendente', 'expedida'), false, 'não se expede direto');
  assert.equal(proximaEtapa('separacao', 'embalada'), false, 'não se embala sem conferir');
  // Voltar também não.
  assert.equal(proximaEtapa('conferida', 'separacao'), false);
  assert.equal(proximaEtapa('expedida', 'embalada'), false);
  // Repetir também não.
  assert.equal(proximaEtapa('separacao', 'separacao'), false);
  assert.equal(proximaEtapa(null, 'separacao'), true, 'ausência de etapa conta como pendente');
  assert.equal(proximaEtapa('pendente', 'etapa_inventada' as any), false);
});

test('expedição: a comparação de leitura pega falta, sobra, repetição e código estranho', () => {
  const esperado = [
    { produto_id: 1, sku: 'A', codigo_barras: '111', tamanho_id: null, quantidade: 2 },
    { produto_id: 2, sku: 'B', codigo_barras: '222', tamanho_id: null, quantidade: 1 },
  ];

  const ok = compararLeitura(esperado, ['111', '111', '222']);
  assert.equal(ok.ok, true);
  assert.equal(ok.esperado_total, 3);
  assert.equal(ok.lido_total, 3);
  assert.equal(ok.faltando.length, 0);
  assert.equal(ok.sobrando.length, 0);

  // Faltou uma unidade do A.
  const falta = compararLeitura(esperado, ['111', '222']);
  assert.equal(falta.ok, false);
  assert.deepEqual(falta.faltando.map((f) => [f.produto_id, f.quantidade]), [[1, 1]]);
  assert.equal(falta.sobrando.length, 0);

  // Repetição: três códigos 111 para duas unidades → a terceira é sobra.
  const repete = compararLeitura(esperado, ['111', '111', '111', '222']);
  assert.equal(repete.ok, false);
  assert.deepEqual(repete.sobrando, [{ codigo: '111', quantidade: 1 }]);
  assert.equal(repete.faltando.length, 0);

  // Código que não pertence ao pedido.
  const estranho = compararLeitura(esperado, ['111', '111', '222', '999', '999']);
  assert.equal(estranho.ok, false);
  assert.deepEqual(estranho.sobrando, [{ codigo: '999', quantidade: 2 }]);

  // Nada lido → tudo falta.
  const vazio = compararLeitura(esperado, []);
  assert.equal(vazio.ok, false);
  assert.equal(vazio.faltando.reduce((a, f) => a + f.quantidade, 0), 3);
});

// ---------------------------------------------------------------------------
// 2) Fluxo de expedição
// ---------------------------------------------------------------------------

test('expedição: separação devolve o que separar e marca a etapa', async () => {
  const { venda, itens } = await pedidoParaExpedir([2]);
  const saida = await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  assert.equal(saida.ok, true);
  assert.equal(saida.etapa, 'separacao');
  assert.equal(saida.itens.length, 1);
  assert.equal(Number(saida.itens[0].quantidade), 2);
  assert.equal(Number(saida.itens[0].produto_id), Number(itens[0].produto.id));

  // Repetir a separação não avança de novo.
  await esperarErro(() => exp.separarPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /Não é possível passar/);
});

test('expedição: não se pula etapa — embalar sem conferir e expedir sem embalar são recusados', async () => {
  const { venda, codigos } = await pedidoParaExpedir([1]);
  await esperarErro(() => exp.embalarPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /Só se embala um pedido conferido/);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /Só se expede um pedido embalado/);

  await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  await esperarErro(() => exp.embalarPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /Só se embala/);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /Só se expede/);

  await chamar(exp.conferirPedido, reqDe({ codigos }, { params: { id: venda.id } }));
  await esperarErro(() => exp.expedirPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /Só se expede um pedido embalado/);
  await chamar(exp.embalarPedido, reqDe({}, { params: { id: venda.id } }));
});

test('expedição: conferência reprovada NÃO baixa estoque, mas grava a divergência', async () => {
  const s = getStore();
  const { venda, itens, codigos } = await pedidoParaExpedir([2]);
  const produto = itens[0].produto;
  const tamanhoId = itens[0].tamanho_id;
  const saldoAntes = await saldoDo(produto, tamanhoId);

  // Lê só um dos dois códigos.
  const erro = await esperarErro(
    () => exp.conferirPedido(reqDe({ codigos: [codigos[0]] }, { params: { id: venda.id } }), resFake().res),
    422,
    /não coincide com o pedido/
  );
  assert.equal(erro.fields.esperado_total, 2);
  assert.equal(erro.fields.lido_total, 1);
  assert.deepEqual(erro.fields.faltando.map((f: any) => [f.produto_id, f.quantidade]), [[Number(produto.id), 1]]);
  assert.ok(Number(erro.fields.divergencia_id) > 0, 'a divergência foi gravada');

  // NENHUMA baixa de estoque.
  const saldoDepois = await saldoDo(produto, tamanhoId);
  assert.equal(saldoDepois, saldoAntes, 'conferência reprovada não mexe no estoque');
  const movs = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { motivo: `Venda #${venda.id}` } });
  assert.equal(movs.rows.length, 0);

  // A divergência existe, com o conteúdo do que divergiu.
  const div = await s.get(RESOURCES.divergencias_conferencia, Number(erro.fields.divergencia_id));
  assert.ok(div, 'a linha de divergência foi persistida');
  assert.equal(Number(div.venda_id), Number(venda.id));
  assert.equal(Array.isArray(div.lido) ? div.lido.length : JSON.parse(div.lido).length, 1, 'o que foi lido ficou gravado');
  const faltandoGravado = Array.isArray(div.faltando) ? div.faltando : JSON.parse(div.faltando);
  assert.equal(faltandoGravado.length, 1);
  assert.equal(Number(faltandoGravado[0].quantidade), 1);

  // E a etapa NÃO avançou.
  const vendaDepois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(vendaDepois.expedicao_etapa, 'pendente', 'reprovação não avança a etapa');
});

test('expedição: conferência aprovada avança a etapa sem baixar estoque', async () => {
  const s = getStore();
  const { venda, itens, codigos } = await pedidoParaExpedir([3]);
  await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  const saldoAntes = await saldoDo(itens[0].produto, itens[0].tamanho_id);

  const conferida = await chamar(exp.conferirPedido, reqDe({ codigos }, { params: { id: venda.id } }));
  assert.equal(conferida.etapa, 'conferida');
  assert.match(conferida.mensagem, /Nenhuma baixa de estoque foi feita ainda/);

  assert.equal(await saldoDo(itens[0].produto, itens[0].tamanho_id), saldoAntes, 'a baixa é só na expedição');
  const movs = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { motivo: `Venda #${venda.id}` } });
  assert.equal(movs.rows.length, 0);

  // Conferir de novo não avança.
  await esperarErro(() => exp.conferirPedido(reqDe({ codigos }, { params: { id: venda.id } }), resFake().res), 409, /Não é possível passar/);
});

test('expedição: expedição fatura, baixa o estoque e lança o financeiro', async () => {
  const s = getStore();
  const { venda, itens, codigos } = await pedidoParaExpedir([3]);
  const produto = itens[0].produto;
  const tamanhoId = itens[0].tamanho_id;
  const saldoAntes = await saldoDo(produto, tamanhoId);

  await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  await chamar(exp.conferirPedido, reqDe({ codigos }, { params: { id: venda.id } }));
  await chamar(exp.embalarPedido, reqDe({}, { params: { id: venda.id } }));

  const expedida = await chamar(exp.expedirPedido, reqDe({}, { params: { id: venda.id } }));
  assert.equal(expedida.status, 'faturada');
  assert.equal(expedida.etapa, 'expedida');

  assert.equal(await saldoDo(produto, tamanhoId), saldoAntes - 3, 'o estoque baixou na expedição');
  const movs = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { motivo: `Venda #${venda.id}` } });
  assert.equal(movs.rows.length, 1);
  assert.equal(movs.rows[0].tipo, 'saida');
  assert.equal(Number(movs.rows[0].quantidade), 3);

  const lanc = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { venda_id: Number(venda.id) } });
  assert.ok(lanc.rows.length >= 1, 'o financeiro foi lançado');

  // Expedir de novo é recusado.
  await esperarErro(() => exp.expedirPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /já está faturado/);
});

test('expedição: pedido cancelado ou já faturado não entra no fluxo', async () => {
  const cancelada = await pedidoParaExpedir([1], { status: 'cancelada' });
  await esperarErro(() => exp.separarPedido(reqDe({}, { params: { id: cancelada.venda.id } }), resFake().res), 409, /cancelado/);
  await esperarErro(() => exp.conferirPedido(reqDe({ codigos: cancelada.codigos }, { params: { id: cancelada.venda.id } }), resFake().res), 409, /cancelado/);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { params: { id: cancelada.venda.id } }), resFake().res), 409, /cancelado/);

  const faturada = await pedidoParaExpedir([1], { status: 'faturada' });
  await esperarErro(() => exp.separarPedido(reqDe({}, { params: { id: faturada.venda.id } }), resFake().res), 409, /já foi faturado/);
});

test('expedição: item sem código de barras impede a conferência por leitura', async () => {
  const { venda } = await pedidoParaExpedir([1], { comCodigo: false });
  await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  const erro = await esperarErro(() => exp.conferirPedido(reqDe({ codigos: ['123'] }, { params: { id: venda.id } }), resFake().res), 409, /sem código de barras/);
  assert.equal(erro.fields.itens_sem_codigo.length, 1);
});

test('expedição: leitura vazia ou malformada é recusada antes de qualquer comparação', async () => {
  const { venda } = await pedidoParaExpedir([1]);
  await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  await esperarErro(() => exp.conferirPedido(reqDe({}, { params: { id: venda.id } }), resFake().res), 400, /Envie os códigos lidos/);
  await esperarErro(() => exp.conferirPedido(reqDe({ codigos: [] }, { params: { id: venda.id } }), resFake().res), 400, /Envie os códigos lidos/);
  await esperarErro(() => exp.conferirPedido(reqDe({ codigos: ['123', ''] }, { params: { id: venda.id } }), resFake().res), 400, /strings não vazias/);
  await esperarErro(() => exp.conferirPedido(reqDe({ codigos: [123] }, { params: { id: venda.id } }), resFake().res), 400, /strings não vazias/);
});

test('expedição: a situação traz etapa, trilha de eventos e divergências', async () => {
  const { venda, codigos } = await pedidoParaExpedir([2]);
  await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  await esperarErro(() => exp.conferirPedido(reqDe({ codigos: [codigos[0]] }, { params: { id: venda.id } }), resFake().res), 422);

  const sit = await chamar(exp.situacaoExpedicao, reqDe({}, { params: { id: venda.id } }));
  assert.equal(sit.venda_id, Number(venda.id));
  assert.equal(sit.etapa, 'separacao', 'a reprovação não avançou a etapa');
  assert.deepEqual(sit.etapas, ETAPAS);
  assert.equal(sit.itens.length, 1);
  assert.equal(sit.itens[0].quantidade, 2);
  // 1 evento da separação + 1 da conferência reprovada.
  assert.equal(sit.eventos.length, 2);
  assert.equal(sit.eventos[0].etapa, 'separacao');
  assert.equal(sit.eventos[1].resultado, 'divergencia');
  assert.equal(sit.divergencias.length, 1);
});

test('expedição: divergência resolvida guarda quem resolveu e não se resolve duas vezes', async () => {
  const s = getStore();
  const { venda, codigos } = await pedidoParaExpedir([2]);
  await chamar(exp.separarPedido, reqDe({}, { params: { id: venda.id } }));
  const erro = await esperarErro(() => exp.conferirPedido(reqDe({ codigos: [codigos[0]] }, { params: { id: venda.id } }), resFake().res), 422);
  const divId = Number(erro.fields.divergencia_id);

  const painel = await chamar(exp.listarDivergencias, reqDe({}, { query: { page: 1, pageSize: 50 } }));
  assert.ok(painel.rows.some((r: any) => Number(r.id) === divId));

  await esperarErro(() => exp.resolverDivergencia(reqDe({}, { params: { id: divId } }), resFake().res), 400, /mínimo 5/);
  const resolvida = await chamar(exp.resolverDivergencia, reqDe({ resolucao: 'Peça reposta na caixa e reconferida' }, { params: { id: divId } }));
  assert.ok(resolvida.resolvido_em);
  assert.equal(Number(resolvida.resolvido_por), 1);
  assert.match(String(resolvida.resolucao), /reposta/);

  await esperarErro(() => exp.resolverDivergencia(reqDe({ resolucao: 'De novo' }, { params: { id: divId } }), resFake().res), 409, /já foi resolvida/);
  assert.ok(await s.get(RESOURCES.divergencias_conferencia, divId));
});

// ---------------------------------------------------------------------------
// 3) Logística reversa — devolução
// ---------------------------------------------------------------------------

/** Venda FATURADA com itens — pré-condição para devolver. */
async function pedidoFaturado(quantidades: number[] = [2]) {
  const { venda, itens, codigos } = await pedidoParaExpedir(quantidades);
  const s = getStore();
  await s.update(RESOURCES.vendas, Number(venda.id), { status: 'faturada' });
  return { venda, itens, codigos };
}

test('devolução: solicitação exige motivo e só vale sobre pedido faturado', async () => {
  const aberta = await pedidoParaExpedir([1]);
  await esperarErro(() => exp.criarDevolucao(reqDe({ venda_id: aberta.venda.id, motivo: 'Não serviu' }), resFake().res), 409, /faturado ou entregue/);

  const { venda, itens } = await pedidoFaturado([3]);
  await esperarErro(() => exp.criarDevolucao(reqDe({ venda_id: venda.id, motivo: 'oi' }), resFake().res), 400, /mínimo 5/);
  await esperarErro(() => exp.criarDevolucao(reqDe({ venda_id: venda.id, motivo: 'Motivo válido', tipo: 'inexistente' }), resFake().res), 400, /tipo deve ser/);

  const criada = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Cliente desistiu da compra', tipo: 'arrependimento' }), 201);
  assert.equal(criada.status, 'solicitada');
  assert.equal(criada.tipo, 'arrependimento');
  assert.equal(Number(criada.venda_id), Number(venda.id));
  // Sem itens explícitos, devolve o pedido inteiro.
  assert.equal(criada.itens.length, 1);
  assert.equal(Number(criada.itens[0].quantidade_solicitada), 3);
  assert.equal(Number(criada.itens[0].produto_id), Number(itens[0].produto.id));
});

test('devolução: não se devolve mais do que o pedido levou — nem somando duas devoluções', async () => {
  const { venda, itens } = await pedidoFaturado([2]);
  const produtoId = Number(itens[0].produto.id);
  const tamanhoId = itens[0].tamanho_id;

  await esperarErro(
    () => exp.criarDevolucao(reqDe({ venda_id: venda.id, motivo: 'Devolvendo demais', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 3 }] }), resFake().res),
    409,
    /Não é possível devolver/
  );

  const primeira = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Primeira devolução parcial', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1 }] }), 201);
  assert.equal(Number(primeira.itens[0].quantidade_solicitada), 1);

  // A segunda pode devolver 1 (o que sobrou), mas não 2.
  await esperarErro(
    () => exp.criarDevolucao(reqDe({ venda_id: venda.id, motivo: 'Segunda devolução', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 2 }] }), resFake().res),
    409,
    /já está\(ão\) em devolução/
  );
  const segunda = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Segunda devolução parcial', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1 }] }), 201);
  assert.equal(Number(segunda.itens[0].quantidade_solicitada), 1);

  await esperarErro(
    () => exp.criarDevolucao(reqDe({ venda_id: venda.id, motivo: 'Terceira devolução', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1 }] }), resFake().res),
    409
  );
});

test('devolução: autorização → rastreamento → recebimento, nessa ordem', async () => {
  const { venda, itens } = await pedidoFaturado([2]);
  const produtoId = Number(itens[0].produto.id);
  const tamanhoId = itens[0].tamanho_id;
  const saldoAntes = await saldoDo(itens[0].produto, tamanhoId);

  const criada = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Produto chegou errado' }), 201);
  const id = Number(criada.id);

  // Receber sem autorizar não pode.
  await esperarErro(() => exp.receberDevolucao(reqDe({}, { params: { id } }), resFake().res), 409, /Autorize a devolução/);
  await esperarErro(() => exp.registrarRastreamento(reqDe({ codigo_rastreamento: 'REV123456BR' }, { params: { id } }), resFake().res), 409, /Autorize a devolução/);

  const autorizada = await chamar(exp.autorizarDevolucao, reqDe({ autorizacao_codigo: 'AUT-9981', transportadora: 'Correios' }, { params: { id } }));
  assert.equal(autorizada.status, 'autorizada');
  assert.equal(autorizada.autorizacao_codigo, 'AUT-9981');
  assert.ok(autorizada.autorizada_em);
  assert.equal(Number(autorizada.autorizado_por), 1);
  await esperarErro(() => exp.autorizarDevolucao(reqDe({}, { params: { id } }), resFake().res), 409, /Só se autoriza uma devolução solicitada/);

  // Receber SEM rastreio não pode: mercadoria sem rastreabilidade não entra.
  await esperarErro(() => exp.receberDevolucao(reqDe({}, { params: { id } }), resFake().res), 409, /sem rastreabilidade/);
  assert.equal(await saldoDo(itens[0].produto, tamanhoId), saldoAntes, 'nada entrou no estoque ainda');

  await esperarErro(() => exp.registrarRastreamento(reqDe({ codigo_rastreamento: 'abc' }, { params: { id } }), resFake().res), 400, /mínimo 5/);
  const emTransito = await chamar(exp.registrarRastreamento, reqDe({ codigo_rastreamento: 'REV123456BR' }, { params: { id } }));
  assert.equal(emTransito.status, 'em_transito');
  assert.equal(emTransito.codigo_rastreamento, 'REV123456BR');

  const recebida = await chamar(exp.receberDevolucao, reqDe({}, { params: { id } }));
  assert.equal(recebida.devolucao.status, 'recebida');
  assert.equal(recebida.total_recebido, 2);
  assert.equal(recebida.local, 'loja');
  assert.equal(await saldoDo(itens[0].produto, tamanhoId), saldoAntes + 2, 'a mercadoria boa voltou ao estoque');
  assert.equal(recebida.financeiro.aplicado, true, 'devolução total reverte o financeiro');
  assert.match(recebida.financeiro.motivo, /venda #\d+ cancelada/);

  const s = getStore();
  const vendaDepois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(vendaDepois.status, 'cancelada', 'devolução total cancela a venda');

  // Receber de novo não sobe o estoque outra vez.
  await esperarErro(() => exp.receberDevolucao(reqDe({}, { params: { id } }), resFake().res), 409, /já foi recebida/);
  assert.equal(await saldoDo(itens[0].produto, tamanhoId), saldoAntes + 2);
});

test('devolução: item avariado NÃO volta ao saldo vendável', async () => {
  const { venda, itens } = await pedidoFaturado([2]);
  const tamanhoId = itens[0].tamanho_id;
  const saldoAntes = await saldoDo(itens[0].produto, tamanhoId);

  const criada = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Chegou quebrado' }), 201);
  const id = Number(criada.id);
  await chamar(exp.autorizarDevolucao, reqDe({}, { params: { id } }));
  await chamar(exp.registrarRastreamento, reqDe({ codigo_rastreamento: 'REV999888BR' }, { params: { id } }));

  const itemDevolucaoId = Number(criada.itens[0].id);
  const recebida = await chamar(
    exp.receberDevolucao,
    reqDe({ itens: [{ id: itemDevolucaoId, quantidade_recebida: 2, estado: 'avariado' }] }, { params: { id } })
  );
  assert.equal(recebida.total_recebido, 2, 'foi recebido e contado');
  assert.equal(recebida.entradas_estoque.length, 0, 'mas nenhuma entrada de estoque');
  assert.equal(await saldoDo(itens[0].produto, tamanhoId), saldoAntes, 'o saldo vendável não mudou');

  const s = getStore();
  const itensDev = await s.list(RESOURCES.devolucao_itens, { page: 1, pageSize: 10, filter: { devolucao_id: id } });
  assert.equal(itensDev.rows[0].estado, 'avariado', 'o estado ficou registrado para descarte/reparo');
  assert.equal(Number(itensDev.rows[0].quantidade_recebida), 2);
});

test('devolução: parcial não reverte o financeiro da venda', async () => {
  const s = getStore();
  const { venda, itens } = await pedidoFaturado([4]);
  const produtoId = Number(itens[0].produto.id);
  const tamanhoId = itens[0].tamanho_id;

  const criada = await chamar(
    exp.criarDevolucao,
    reqDe({ venda_id: venda.id, motivo: 'Duas peças com defeito', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 2 }] }),
    201
  );
  const id = Number(criada.id);
  await chamar(exp.autorizarDevolucao, reqDe({}, { params: { id } }));
  await chamar(exp.registrarRastreamento, reqDe({ codigo_rastreamento: 'REV555444BR' }, { params: { id } }));

  const recebida = await chamar(exp.receberDevolucao, reqDe({}, { params: { id } }));
  assert.equal(recebida.total_recebido, 2);
  assert.equal(recebida.financeiro.aplicado, false, 'devolução parcial não cancela a venda');
  assert.match(recebida.financeiro.motivo, /parcial/);

  const vendaDepois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(vendaDepois.status, 'faturada', 'a venda continua faturada');
});

test('devolução: não se recebe mais do que foi solicitado nem estado inválido', async () => {
  const { venda, itens } = await pedidoFaturado([2]);
  const produtoId = Number(itens[0].produto.id);
  const tamanhoId = itens[0].tamanho_id;
  const criada = await chamar(
    exp.criarDevolucao,
    reqDe({ venda_id: venda.id, motivo: 'Devolução para testar limites', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1 }] }),
    201
  );
  const id = Number(criada.id);
  const itemDevId = Number(criada.itens[0].id);
  await chamar(exp.autorizarDevolucao, reqDe({}, { params: { id } }));
  await chamar(exp.registrarRastreamento, reqDe({ codigo_rastreamento: 'REV111222BR' }, { params: { id } }));

  await esperarErro(
    () => exp.receberDevolucao(reqDe({ itens: [{ id: itemDevId, quantidade_recebida: 5, estado: 'bom' }] }, { params: { id } }), resFake().res),
    409,
    /não pode receber/
  );
  await esperarErro(
    () => exp.receberDevolucao(reqDe({ itens: [{ id: itemDevId, quantidade_recebida: 1, estado: 'derretido' }] }, { params: { id } }), resFake().res),
    400,
    /Estado/
  );
  await esperarErro(
    () => exp.receberDevolucao(reqDe({ itens: [{ id: itemDevId, quantidade_recebida: -1, estado: 'bom' }] }, { params: { id } }), resFake().res),
    400,
    /negativa/
  );
  await esperarErro(() => exp.receberDevolucao(reqDe({ local: 'armazem_inexistente' }, { params: { id } }), resFake().res), 404, /Local não encontrado/);
  // Zero recebido → nada a dar entrada.
  await esperarErro(() => exp.receberDevolucao(reqDe({ itens: [{ id: itemDevId, quantidade_recebida: 0, estado: 'bom' }] }, { params: { id } }), resFake().res), 409, /Nenhuma unidade foi recebida/);
});

test('devolução: recusada e cancelada são terminais', async () => {
  const { venda } = await pedidoFaturado([1]);
  const recusada = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Vai ser recusada' }), 201);
  const r = await chamar(exp.recusarDevolucao, reqDe({ motivo: 'Fora do prazo de devolução' }, { params: { id: recusada.id } }));
  assert.equal(r.status, 'recusada');
  await esperarErro(() => exp.autorizarDevolucao(reqDe({}, { params: { id: recusada.id } }), resFake().res), 409);
  await esperarErro(() => exp.receberDevolucao(reqDe({}, { params: { id: recusada.id } }), resFake().res), 409, /não pode ser recebida/);

  const cancelada = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Vai ser cancelada' }), 201);
  const c = await chamar(exp.cancelarDevolucao, reqDe({ motivo: 'Cliente desistiu da devolução' }, { params: { id: cancelada.id } }));
  assert.equal(c.status, 'cancelada');
  await esperarErro(() => exp.receberDevolucao(reqDe({}, { params: { id: cancelada.id } }), resFake().res), 409, /não pode ser recebida/);
});

// ---------------------------------------------------------------------------
// 4) Multiempresa
// ---------------------------------------------------------------------------

test('expedição e devolução: EMPRESA A não alcança os registros da EMPRESA B', async () => {
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const a = await criarAtor(1, 'gerente');
  const b = await criarAtor(2, 'gerente');

  // Pedido da empresa 2.
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente B', tipo: 'pf', ativo: true });
  const produtoB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'P1-EXP-B', nome: 'Produto B', preco_venda: 100, codigo_barras: '7891110002223', ativo: true });
  const vendaB = await s.insert(RESOURCES.vendas, { empresa_id: 2, cliente_id: Number(clienteB.id), data: new Date().toISOString().slice(0, 10), status: 'faturada', total: 100 });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 2, venda_id: Number(vendaB.id), produto_id: Number(produtoB.id), tamanho_id: null, quantidade: 1, preco_unitario: 100, subtotal: 100 });
  const devB = await chamar(exp.criarDevolucao, reqDe({ venda_id: vendaB.id, motivo: 'Devolução da empresa B' }, { user: b }), 201);

  // A não enxerga nada disso (404, não 403: 403 confirmaria que existe).
  await esperarErro(() => exp.separarPedido(reqDe({}, { params: { id: vendaB.id } }), resFake().res), 404);
  await esperarErro(() => exp.conferirPedido(reqDe({ codigos: ['7891110002223'] }, { params: { id: vendaB.id } }), resFake().res), 404);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { params: { id: vendaB.id } }), resFake().res), 404);
  await esperarErro(() => exp.situacaoExpedicao(reqDe({}, { params: { id: vendaB.id } }), resFake().res), 404);
  await esperarErro(() => exp.obterDevolucao(reqDe({}, { params: { id: devB.id } }), resFake().res), 404);
  await esperarErro(() => exp.autorizarDevolucao(reqDe({}, { params: { id: devB.id } }), resFake().res), 404);
  await esperarErro(() => exp.registrarRastreamento(reqDe({ codigo_rastreamento: 'XXX12345' }, { params: { id: devB.id } }), resFake().res), 404);
  await esperarErro(() => exp.receberDevolucao(reqDe({}, { params: { id: devB.id } }), resFake().res), 404);

  // E a devolução de B continua intacta.
  const intacta = await s.get(RESOURCES.devolucoes, Number(devB.id));
  assert.equal(intacta.status, 'solicitada');

  // O painel de divergências de A não mostra o de B.
  const painelA = await chamar(exp.listarDivergencias, reqDe({}, { query: { page: 1, pageSize: 200 } }));
  assert.ok(painelA.rows.every((r: any) => Number(r.empresa_id) === 1), 'só divergências da empresa A');

  // E o inverso: B não alcança o pedido de A.
  const { venda: vendaA } = await pedidoParaExpedir([1]);
  await esperarErro(() => exp.separarPedido(reqDe({}, { user: b, params: { id: vendaA.id } }), resFake().res), 404);
  void a;
});

// ---------------------------------------------------------------------------
// helper de saldo (o estoque é por produto + tamanho + local)
// ---------------------------------------------------------------------------
async function saldoDo(produto: any, tamanhoId: number | null, local = 'loja'): Promise<number> {
  const row = await getStore().findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: tamanhoId, local });
  return Number(row?.quantidade ?? 0);
}
