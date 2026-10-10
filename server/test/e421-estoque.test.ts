// ============================================================================
// E4.2.1 — integridade do estoque na devolução, no estorno e no local de venda.
//
// Aqui (memória) ficam os testes de REGRA: devolução 1–12, venda_id 1–7,
// PDV/local 1–9 e a matriz E2E. Eles NÃO são a prova final: a concorrência e o
// isolamento multiempresa com IDs reais só são provados contra PostgreSQL em
// test/pg/e421-estoque-integridade.test.ts (npm run test:pg).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, createRecord, updateRecord } = await import('../src/services');
const exp = await import('../src/expedicao');
const pdv = await import('../src/pdv');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoCliente, novoLocal, novoProduto, reqDe, resFake, saldoInicial, ADMIN } = await import('./_p1util');

await garantirAdmin();
await novoLocal('loja', 1, true);

let seq = 0;

/** Produto com código de barras único: a expedição confere por leitura. */
async function produtoComCodigo(preco = 100) {
  seq++;
  const codigo = `78904212${String(seq).padStart(4, '0')}${String(Date.now()).slice(-5)}`;
  return novoProduto({ preco_venda: preco, codigo_barras: codigo });
}

/** Local com saldo próprio, sem mexer no padrão da empresa. */
async function saldoEm(produto: any, quantidade: number, nomeLocal: string, empresaId = 1) {
  const s = getStore();
  const local = await novoLocal(nomeLocal, empresaId, false);
  const tam = await s.findOneWhere(RESOURCES.tamanhos, { codigo: 'U' }) ?? await s.insert(RESOURCES.tamanhos, { codigo: 'U', nome: 'U', ativo: true });
  return s.insert(RESOURCES.estoques, {
    empresa_id: empresaId,
    produto_id: Number(produto.id),
    tamanho_id: Number(tam.id),
    local: String(local.nome),
    local_id: Number(local.id),
    quantidade,
    custo_medio: 40,
  });
}

async function saldo(produto: any, nomeLocal = 'loja'): Promise<number> {
  const s = getStore();
  const local = await s.findOneWhere(RESOURCES.locais, { empresa_id: 1, nome: nomeLocal });
  const row = await s.findOneWhere(RESOURCES.estoques, { empresa_id: 1, produto_id: Number(produto.id), local_id: Number(local!.id) });
  return Number(row?.quantidade ?? 0);
}

/** Pedido já FATURADO pela expedição real: baixa o estoque com venda_id. */
async function pedidoFaturado(saldoInicialQtd: number, quantidade: number, opts: { local?: string } = {}) {
  const s = getStore();
  seq++;
  const codigo = `78904210${String(seq).padStart(4, '0')}${String(Date.now()).slice(-5)}`;
  const produto = await novoProduto({ preco_venda: 100, codigo_barras: codigo });
  if (opts.local) await saldoEm(produto, saldoInicialQtd, opts.local);
  else await saldoInicial(produto, saldoInicialQtd);
  const est = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id) });
  const cliente = await novoCliente();
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    cliente_id: Number(cliente.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'aberta',
    total: quantidade * 100,
    ...(opts.local ? { local_saida: opts.local } : {}),
  });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: 1,
    venda_id: Number(venda.id),
    produto_id: Number(produto.id),
    tamanho_id: Number(est.tamanho_id),
    quantidade,
    preco_unitario: 100,
    subtotal: quantidade * 100,
  });
  await expedir(Number(venda.id), Array(quantidade).fill(codigo));
  return { venda: (await s.get(RESOURCES.vendas, Number(venda.id)))!, produto, tamanhoId: Number(est.tamanho_id), codigo };
}

async function expedir(vendaId: number, codigos: string[]) {
  const req = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: vendaId } });
  await chamar(exp.separarPedido, req());
  await chamar(exp.conferirPedido, req({ codigos }));
  await chamar(exp.embalarPedido, req());
  await chamar(exp.expedirPedido, req());
}

async function criarDev(vendaId: number, itens?: { produto_id: number; tamanho_id: number | null; quantidade: number }[], extra: Record<string, unknown> = {}) {
  return chamar(exp.criarDevolucao, reqDe({ venda_id: vendaId, motivo: 'Cliente devolveu o produto', ...(itens ? { itens } : {}), ...extra }), 201);
}

async function tentarCriarDev(vendaId: number, itens: { produto_id: number; tamanho_id: number | null; quantidade: number }[]) {
  return exp.criarDevolucao(reqDe({ venda_id: vendaId, motivo: 'Cliente devolveu o produto', itens }), resFake().res);
}

async function autorizarERastrear(devId: number, codigo = 'REV421BR') {
  await chamar(exp.autorizarDevolucao, reqDe({ autorizacao_codigo: 'AUT-421' }, { params: { id: devId } }));
  await chamar(exp.registrarRastreamento, reqDe({ codigo_rastreamento: codigo }, { params: { id: devId } }));
}

async function receber(devId: number, itens?: Record<string, unknown>[]) {
  return chamar(exp.receberDevolucao, reqDe(itens ? { itens } : {}, { params: { id: devId } }));
}

async function devolverTudo(devId: number, itens: { id: number; quantidade_recebida: number; estado?: string }[]) {
  await autorizarERastrear(devId);
  return receber(devId, itens.map((i) => ({ id: i.id, quantidade_recebida: i.quantidade_recebida, estado: i.estado ?? 'bom' })));
}

async function itensDaDevolucao(devId: number) {
  return getStore().list(RESOURCES.devolucao_itens, { page: 1, pageSize: 100, filter: { devolucao_id: devId }, sort: 'id', dir: 'asc' });
}

async function movimentosDaVenda(vendaId: number) {
  const r = await getStore().list(RESOURCES.movimentacoes, { page: 1, pageSize: 200, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' });
  return r.rows;
}

async function devolucoesDaVenda(vendaId: number) {
  const r = await getStore().list(RESOURCES.devolucoes, { page: 1, pageSize: 200, filter: { venda_id: vendaId } });
  return r.rows;
}

// ---------------------------------------------------------------------------
// DEVOLUÇÃO 1–12
// ---------------------------------------------------------------------------

test('devolução 1: parcial de 1 de 2 devolve 1 ao saldo e mantém a venda faturada', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  assert.equal(await saldo(produto), 3);
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  const [item] = (await itensDaDevolucao(Number(dev.id))).rows;
  await devolverTudo(Number(dev.id), [{ id: Number(item.id), quantidade_recebida: 1 }]);
  assert.equal(await saldo(produto), 4);
  assert.equal((await getStore().get(RESOURCES.vendas, Number(venda.id)))!.status, 'faturada');
});

test('devolução 2: acumulada — 1 + 1 de 2 fecha a venda e o saldo volta a 5, sem dobrar', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  const pid = Number(produto.id);
  const d1 = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 1 }]);
  await devolverTudo(Number(d1.id), [{ id: Number((await itensDaDevolucao(Number(d1.id))).rows[0].id), quantidade_recebida: 1 }]);
  const d2 = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 1 }]);
  await devolverTudo(Number(d2.id), [{ id: Number((await itensDaDevolucao(Number(d2.id))).rows[0].id), quantidade_recebida: 1 }]);
  assert.equal(await saldo(produto), 5);
  assert.equal((await getStore().get(RESOURCES.vendas, Number(venda.id)))!.status, 'cancelada');
});

test('devolução 3: 5 → venda 2 → 3 → devolução total boa 2 → 5 (não 7), e o estorno posterior não restaura de novo', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  assert.equal(await saldo(produto), 3);
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 2 }]);
  const out = await devolverTudo(Number(dev.id), [{ id: Number((await itensDaDevolucao(Number(dev.id))).rows[0].id), quantidade_recebida: 2 }]);
  assert.equal(out.financeiro.aplicado, true, 'devolução total cancela a venda');
  assert.equal(await saldo(produto), 5, 'saldo 5, não 7');
  const estornos = (await movimentosDaVenda(Number(venda.id))).filter((m) => String(m.motivo).startsWith('Estorno'));
  assert.equal(estornos.length, 0, 'nada a estornar: tudo já voltou pela devolução');
  // Tentar de novo a mesma venda cancelada não restaura nada.
  await esperarErro(() => receber(Number(dev.id)), 409, /já foi recebida/);
  assert.equal(await saldo(produto), 5);
});

test('devolução 4: acima do vendido → 409, transacional: nenhuma devolução e nenhum movimento', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  const antesMov = (await movimentosDaVenda(Number(venda.id))).length;
  await esperarErro(() => tentarCriarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 3 }]), 409, /Não é possível devolver/);
  assert.equal((await devolucoesDaVenda(Number(venda.id))).length, 0, 'a solicitação recusada não deixou cabeçalho órfão');
  assert.equal((await movimentosDaVenda(Number(venda.id))).length, antesMov);
  assert.equal(await saldo(produto), 3);
});

test('devolução 5: duas solicitações que somam mais que o vendido — a segunda é recusada', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  const pid = Number(produto.id);
  await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 2 }]);
  await esperarErro(() => tentarCriarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 1 }]), 409, /já está\(ão\) em devolução/);
});

test('devolução 6: produto danificado (avariado) NÃO volta ao estoque vendável', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 3);
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  const out = await devolverTudo(Number(dev.id), [{ id: Number((await itensDaDevolucao(Number(dev.id))).rows[0].id), quantidade_recebida: 1, estado: 'avariado' }]);
  assert.equal(out.entradas_estoque.length, 0);
  assert.equal(await saldo(produto), 2, 'continua 2: a peça avariada não entrou');
  assert.equal((await movimentosDaVenda(Number(venda.id))).filter((m) => m.tipo === 'entrada').length, 0);
});

test('devolução 7: o cliente NÃO força a entrada de item avariado com devolucao_estoque=true', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 3);
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  const itemId = Number((await itensDaDevolucao(Number(dev.id))).rows[0].id);
  await autorizarERastrear(Number(dev.id));
  const out = await receber(Number(dev.id), [{ id: itemId, quantidade_recebida: 1, estado: 'avariado', devolucao_estoque: true }]);
  assert.equal(out.entradas_estoque.length, 0);
  assert.equal(await saldo(produto), 2);
});

test('devolução 8: estorno de venda com devolução parcial restaura só o que ainda não voltou (PDV)', async () => {
  // Venda PDV de 3 peças (5 → 2). Devolve 1 boa (→ 3). Cancela a venda: restaura 3 − 1 = 2 → 5.
  const { produto, tamanhoId, vendaId } = await vendaPdv(5, 3);
  const dev = await criarDev(vendaId, [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  await devolverTudo(Number(dev.id), [{ id: Number((await itensDaDevolucao(Number(dev.id))).rows[0].id), quantidade_recebida: 1 }]);
  assert.equal(await saldo(produto), 3);
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cliente desistiu da compra inteira' }, { params: { id: vendaId } }));
  assert.equal(await saldo(produto), 5, 'restaurou exatamente as 2 peças ainda não devolvidas');
});

test('devolução 9: estorno de venda com item avariado devolvido NÃO restaura a peça danificada (PDV)', async () => {
  const { produto, tamanhoId, vendaId } = await vendaPdv(5, 3);
  const dev = await criarDev(vendaId, [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  await devolverTudo(Number(dev.id), [{ id: Number((await itensDaDevolucao(Number(dev.id))).rows[0].id), quantidade_recebida: 1, estado: 'avariado' }]);
  assert.equal(await saldo(produto), 2, 'avariada não voltou');
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cancelamento com peça avariada devolvida' }, { params: { id: vendaId } }));
  assert.equal(await saldo(produto), 4, '5 − 1 danificada = 4: a avaria não vira estoque vendável');
});

test('devolução 10: criação idempotente — mesma chave devolve a mesma devolução, sem duplicar', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  const itens = [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }];
  const primeira = await criarDev(Number(venda.id), itens, { idempotency_key: 'devolucao-421-abc' });
  const repetida = await chamar(exp.criarDevolucao, reqDe({ venda_id: venda.id, motivo: 'Cliente devolveu o produto', itens, idempotency_key: 'devolucao-421-abc' }), 200);
  assert.equal(Number(repetida.id), Number(primeira.id));
  assert.equal(repetida.idempotente, true);
  assert.equal((await devolucoesDaVenda(Number(venda.id))).length, 1);
  assert.equal((await itensDaDevolucao(Number(primeira.id))).rows.length, 1);
});

test('devolução 11: receber duas vezes não sobe o estoque duas vezes', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 3);
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  const itemId = Number((await itensDaDevolucao(Number(dev.id))).rows[0].id);
  await devolverTudo(Number(dev.id), [{ id: itemId, quantidade_recebida: 1 }]);
  await esperarErro(() => receber(Number(dev.id), [{ id: itemId, quantidade_recebida: 1 }]), 409, /já foi recebida/);
  assert.equal(await saldo(produto), 3, 'subiu uma única vez: 2 + 1');
});

test('devolução 12: venda cancelada não aceita nova devolução nem recebimento pendente', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  await autorizarERastrear(Number(dev.id));
  // Cancela a venda por fora do fluxo de devolução (estorno de venda cancelada).
  const s = getStore();
  await s.update(RESOURCES.vendas, Number(venda.id), { status: 'cancelada' });
  await esperarErro(() => receber(Number(dev.id)), 409, /cancelada/);
  await esperarErro(() => tentarCriarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]), 409, /faturado ou entregue/);
  assert.equal(await saldo(produto), 3, 'nenhum recebimento depois do cancelamento');
});

// ---------------------------------------------------------------------------
// VENDA_ID 1–7
// ---------------------------------------------------------------------------

test('venda_id 1: baixa do faturamento grava venda_id na saída', async () => {
  const { venda } = await pedidoFaturado(5, 2);
  const movs = await movimentosDaVenda(Number(venda.id));
  assert.equal(movs.length, 1);
  assert.equal(movs[0].tipo, 'saida');
  assert.equal(Number(movs[0].venda_id), Number(venda.id));
  assert.equal(Number(movs[0].quantidade), 2);
});

test('venda_id 2: lançamento manual de entrada não recebe venda_id', async () => {
  const produto = await novoProduto({});
  await saldoInicial(produto, 1);
  const lancado = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: Number(produto.id), quantidade: 4, local: 'loja' }, ADMIN);
  assert.equal(lancado.venda_id ?? null, null);
});

test('venda_id 3: entrada de devolução boa grava venda_id', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 1 }]);
  await devolverTudo(Number(dev.id), [{ id: Number((await itensDaDevolucao(Number(dev.id))).rows[0].id), quantidade_recebida: 1 }]);
  const entradas = (await movimentosDaVenda(Number(venda.id))).filter((m) => m.tipo === 'entrada');
  assert.equal(entradas.length, 1);
  assert.equal(Number(entradas[0].venda_id), Number(venda.id));
});

test('venda_id 4: estorno grava venda_id na entrada de restauração', async () => {
  const { produto, tamanhoId, vendaId } = await vendaPdv(5, 3);
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cliente desistiu da compra' }, { params: { id: vendaId } }));
  const estornos = (await movimentosDaVenda(vendaId)).filter((m) => String(m.motivo).startsWith('Estorno'));
  assert.equal(estornos.length, 1);
  assert.equal(Number(estornos[0].venda_id), vendaId);
  assert.equal(Number(estornos[0].quantidade), 3);
  assert.equal(await saldo(produto), 5);
});

test('venda_id 5: lançamento manual com venda_id é recusado (vínculo não se forja)', async () => {
  const produto = await novoProduto({});
  await saldoInicial(produto, 2);
  const { venda } = await pedidoFaturado(5, 2);
  await esperarErro(
    () => createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: Number(produto.id), quantidade: 1, local: 'loja', venda_id: Number(venda.id) }, ADMIN),
    400,
    /Vínculos de compra, produção e estorno/
  );
});

test('venda_id 6: o estorno usa venda_id, não o texto do motivo', async () => {
  const { produto, tamanhoId, vendaId } = await vendaPdv(5, 3);
  const saida = (await movimentosDaVenda(vendaId)).find((m) => m.tipo === 'saida')!;
  await getStore().update(RESOURCES.movimentacoes, Number(saida.id), { motivo: 'texto qualquer, sem o número da venda' });
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cancelamento após texto alterado' }, { params: { id: vendaId } }));
  assert.equal(await saldo(produto), 5, 'mesmo com o motivo alterado, a saída foi localizada pelo venda_id');
});

test('venda_id 7: saída legada (sem venda_id) é estornada pelo texto exato da mesma empresa, sem backfill', async () => {
  const { produto, vendaId } = await vendaPdv(5, 3);
  const saida = (await movimentosDaVenda(vendaId)).find((m) => m.tipo === 'saida')!;
  // Simula linha anterior à E4.2.1: sem venda_id.
  await getStore().update(RESOURCES.movimentacoes, Number(saida.id), { venda_id: null });
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cancelamento de venda legada' }, { params: { id: vendaId } }));
  assert.equal(await saldo(produto), 5, 'venda legada continua restaurando o estoque');
  const depois = await getStore().get(RESOURCES.movimentacoes, Number(saida.id));
  assert.equal(depois!.venda_id, null, 'a linha legada não foi reescrita com venda_id');
});

// ---------------------------------------------------------------------------
// PDV / LOCAL 1–9
// ---------------------------------------------------------------------------

/** Venda de balcão já faturada (baixa imediata) em caixa aberto. */
async function vendaPdv(saldoQtd: number, quantidade: number, opts: { localId?: number; caixaLocal?: string; localSaidaId?: number } = {}) {
  const s = getStore();
  seq++;
  const codigo = `78904211${String(seq).padStart(4, '0')}${String(Date.now()).slice(-5)}`;
  const produto = await novoProduto({ preco_venda: 100, codigo_barras: codigo });
  await saldoInicial(produto, saldoQtd);
  const est = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id) });
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: `CX-421-${seq}`, valor_abertura: 0, ...(opts.caixaLocal ? { local: opts.caixaLocal } : {}) }), 201);
  const corpo: Record<string, unknown> = {
    itens: [{ produto_id: Number(produto.id), quantidade, desconto_pct: 0 }],
    pagamentos: [{ forma: 'pix', valor: quantidade * 100 }],
    caixa_id: caixa.id,
  };
  if (opts.localSaidaId !== undefined) corpo.local_saida_id = opts.localSaidaId;
  const saida = await chamar(pdv.venderPdv, reqDe(corpo), 201);
  return { produto, tamanhoId: Number(est.tamanho_id), caixa, vendaId: Number(saida.venda_id) };
}

test('PDV/local 1: venda de balcão grava local_saida_id a partir do caixa', async () => {
  const { caixa, vendaId } = await vendaPdv(5, 1);
  const venda = await getStore().get(RESOURCES.vendas, vendaId);
  assert.ok(caixa.local_id, 'o caixa já nasce com local canônico');
  assert.equal(Number(venda!.local_saida_id), Number(caixa.local_id));
});

test('PDV/local 2: local_saida_id explícito na venda vale sobre o do caixa e a baixa sai dele', async () => {
  const s = getStore();
  const produto = await novoProduto({ preco_venda: 100 });
  await saldoInicial(produto, 5);
  const depo = await saldoEm(produto, 4, 'Depósito PDV2');
  const depoLocal = await s.findOneWhere(RESOURCES.locais, { empresa_id: 1, nome: 'Depósito PDV2' });
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: 'CX-421-P2', valor_abertura: 0 }), 201);
  const saida = await chamar(pdv.venderPdv, reqDe({
    itens: [{ produto_id: Number(produto.id), quantidade: 2, desconto_pct: 0 }],
    pagamentos: [{ forma: 'pix', valor: 200 }],
    caixa_id: caixa.id,
    local_saida_id: Number(depoLocal!.id),
  }), 201);
  const venda = await s.get(RESOURCES.vendas, Number(saida.venda_id));
  assert.equal(Number(venda!.local_saida_id), Number(depoLocal!.id));
  assert.equal(depo.quantidade, 4);
  const linha = (await movimentosDaVenda(Number(saida.venda_id)))[0];
  assert.equal(Number(linha.local_id), Number(depoLocal!.id), 'a saída saiu do local explícito');
  assert.equal(await saldo(produto, 'Depósito PDV2'), 2);
  assert.equal(await saldo(produto, 'loja'), 5, 'o local padrão não foi tocado');
});

test('PDV/local 3: local_saida_id de OUTRA empresa é recusado (404, sem vazar o registro)', async () => {
  const outra = await criarAtor(2, 'gerente');
  const localB = await novoLocal('Loja da B', 2, false);
  const produto = await novoProduto({ preco_venda: 100 });
  await saldoInicial(produto, 3);
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: 'CX-421-P3', valor_abertura: 0 }), 201);
  await esperarErro(
    () => pdv.venderPdv(reqDe({
      itens: [{ produto_id: Number(produto.id), quantidade: 1, desconto_pct: 0 }],
      pagamentos: [{ forma: 'pix', valor: 100 }],
      caixa_id: caixa.id,
      local_saida_id: Number(localB.id),
    }, { user: ADMIN }), resFake().res),
    404
  );
  void outra;
});

test('PDV/local 4: local renomeado — venda pendente ainda baixa do MESMO local (ID), não de um homônimo', async () => {
  const s = getStore();
  const produto = await produtoComCodigo();
  await saldoInicial(produto, 5);
  const origem = await saldoEm(produto, 4, 'Balcão Norte');
  void origem;
  const localNorte = await s.findOneWhere(RESOURCES.locais, { empresa_id: 1, nome: 'Balcão Norte' });
  const cliente = await novoCliente();
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    cliente_id: Number(cliente.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'aberta',
    total: 100,
    local_saida: 'Balcão Norte',
    local_saida_id: Number(localNorte!.id),
  });
  const est = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), local_id: Number(localNorte!.id) });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(produto.id), tamanho_id: Number(est!.tamanho_id), quantidade: 1, preco_unitario: 100, subtotal: 100 });
  // Renomeia o local e cria um NOVO local com o nome antigo.
  // Rename pelo caminho real (propaga o texto dos saldos e das vendas).
  await updateRecord(RESOURCES.locais, Number(localNorte!.id), { nome: 'Balcão Norte (antigo)' }, ADMIN);
  await novoLocal('Balcão Norte', 1, false);
  await expedir(Number(venda.id), [String(produto.codigo_barras)]);
  assert.equal(await saldo(produto, 'Balcão Norte (antigo)'), 3, 'baixou do local canônico');
  assert.equal(await saldo(produto, 'Balcão Norte'), 0, 'não baixou do homônimo');
});

test('PDV/local 5: texto de local desatualizado NÃO desvia a baixa de uma venda com local_saida_id', async () => {
  const s = getStore();
  const produto = await produtoComCodigo();
  await saldoInicial(produto, 5);
  await saldoEm(produto, 4, 'Depósito Texto');
  const localLoja = await s.findOneWhere(RESOURCES.locais, { empresa_id: 1, nome: 'loja' });
  const cliente = await novoCliente();
  const est = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), local_id: Number(localLoja!.id) });
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1, cliente_id: Number(cliente.id), data: new Date().toISOString().slice(0, 10), status: 'aberta', total: 100,
    local_saida: 'Depósito Texto', local_saida_id: Number(localLoja!.id),
  });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(produto.id), tamanho_id: Number(est!.tamanho_id), quantidade: 1, preco_unitario: 100, subtotal: 100 });
  await expedir(Number(venda.id), [String(produto.codigo_barras)]);
  assert.equal(await saldo(produto, 'loja'), 4, 'saiu do canônico (loja), não do texto');
  assert.equal(await saldo(produto, 'Depósito Texto'), 4);
});

test('PDV/local 6: venda LEGADA (local_saida_id NULL) continua usando o texto e NÃO ganha ID por backfill', async () => {
  const s = getStore();
  const produto = await produtoComCodigo();
  await saldoInicial(produto, 5);
  await saldoEm(produto, 4, 'Depósito Legado');
  const legado = await novoLocal('Depósito Legado', 1, false);
  const cliente = await novoCliente();
  const est = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), local_id: Number(legado.id) });
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1, cliente_id: Number(cliente.id), data: new Date().toISOString().slice(0, 10), status: 'aberta', total: 100,
    local_saida: 'Depósito Legado',
  });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(produto.id), tamanho_id: Number(est!.tamanho_id), quantidade: 1, preco_unitario: 100, subtotal: 100 });
  await expedir(Number(venda.id), [String(produto.codigo_barras)]);
  assert.equal(await saldo(produto, 'Depósito Legado'), 3, 'legado usa o texto e baixa do local nomeado');
  const depois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(depois!.local_saida_id ?? null, null, 'nenhum ID foi inferido para a venda legada');
});

test('PDV/local 7: editar o texto local_saida zera o ID canônico (o texto digitado passa a valer)', async () => {
  const s = getStore();
  const produto = await novoProduto({ preco_venda: 100 });
  await saldoInicial(produto, 1);
  const cliente = await novoCliente();
  const loja = await s.findOneWhere(RESOURCES.locais, { empresa_id: 1, nome: 'loja' });
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1, cliente_id: Number(cliente.id), data: new Date().toISOString().slice(0, 10), status: 'aberta', total: 100,
    local_saida: 'loja', local_saida_id: Number(loja!.id),
  });
  await updateRecord(RESOURCES.vendas, Number(venda.id), { local_saida: 'Outro texto' }, ADMIN);
  const depois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(depois!.local_saida_id ?? null, null);
  assert.equal(depois!.local_saida, 'Outro texto');
});

test('PDV/local 8: caixa legado sem local_id resolve o local canônico na NOVA venda (sem backfill do caixa)', async () => {
  const s = getStore();
  const loja = await s.findOneWhere(RESOURCES.locais, { empresa_id: 1, nome: 'loja' });
  const caixa = await s.insert(RESOURCES.pdv_caixas, { empresa_id: 1, numero: 'CX-421-LEGADO', status: 'aberto', abertura_em: new Date().toISOString(), valor_abertura: 0, local: 'loja', local_id: null });
  const produto = await novoProduto({ preco_venda: 100 });
  await saldoInicial(produto, 2);
  const saida = await chamar(pdv.venderPdv, reqDe({
    itens: [{ produto_id: Number(produto.id), quantidade: 1, desconto_pct: 0 }],
    pagamentos: [{ forma: 'pix', valor: 100 }],
    caixa_id: caixa.id,
  }), 201);
  const venda = await s.get(RESOURCES.vendas, Number(saida.venda_id));
  assert.equal(Number(venda!.local_saida_id), Number(loja!.id), 'a nova venda já nasce com o ID resolvido');
  const caixaDepois = await s.get(RESOURCES.pdv_caixas, Number(caixa.id));
  assert.equal(caixaDepois!.local_id ?? null, null, 'o caixa legado não foi reescrito');
});

test('PDV/local 9: local_saida_id inexistente ou de outra empresa não baixa estoque', async () => {
  const produto = await novoProduto({ preco_venda: 100 });
  await saldoInicial(produto, 2);
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: 'CX-421-P9', valor_abertura: 0 }), 201);
  await esperarErro(
    () => pdv.venderPdv(reqDe({
      itens: [{ produto_id: Number(produto.id), quantidade: 1, desconto_pct: 0 }],
      pagamentos: [{ forma: 'pix', valor: 100 }],
      caixa_id: caixa.id,
      local_saida_id: 987654,
    }), resFake().res),
    404
  );
  assert.equal(await saldo(produto), 2, 'nenhum saldo mudou');
});

// ---------------------------------------------------------------------------
// MATRIZ E2E (memória)
// ---------------------------------------------------------------------------

test('PDV/local 10: o cliente NÃO grava local_saida_id por POST nem por PUT (só o PDV grava o ID canônico)', async () => {
  const s = getStore();
  const produto = await produtoComCodigo();
  await saldoInicial(produto, 5);
  const outro = await novoLocal('Depósito Forjado', 1, false);
  const cliente = await novoCliente();
  // Criação com ID forjado e texto diferente: o ID não pode vencer o texto no faturamento.
  const criada = await createRecord(RESOURCES.vendas, {
    cliente_id: Number(cliente.id), data: new Date().toISOString().slice(0, 10), status: 'aberta', total: 100,
    local_saida: 'loja', local_saida_id: Number(outro.id),
  }, ADMIN);
  const gravada = await s.get(RESOURCES.vendas, Number(criada.id));
  assert.equal(gravada!.local_saida_id ?? null, null, 'POST não grava o ID canônico vindo do cliente');
  // Edição sem mudar o texto também não pode colocar o ID.
  await updateRecord(RESOURCES.vendas, Number(criada.id), { local_saida_id: Number(outro.id) }, ADMIN);
  const editada = await s.get(RESOURCES.vendas, Number(criada.id));
  assert.equal(editada!.local_saida_id ?? null, null, 'PUT não grava o ID canônico vindo do cliente');
});

test('E2E-1: 5 → venda 2 → 3 → devolução boa 2 → 5 → estorno indevido não restaura — cancelado', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 2);
  const trilha = [await saldo(produto)];
  const dev = await criarDev(Number(venda.id), [{ produto_id: Number(produto.id), tamanho_id: tamanhoId, quantidade: 2 }]);
  await devolverTudo(Number(dev.id), [{ id: Number((await itensDaDevolucao(Number(dev.id))).rows[0].id), quantidade_recebida: 2 }]);
  trilha.push(await saldo(produto));
  assert.deepEqual(trilha, [3, 5]);
  assert.equal((await getStore().get(RESOURCES.vendas, Number(venda.id)))!.status, 'cancelada');
});

test('E2E-2: 10 → venda 6 → 4 → devolve 2 (6) → devolve 2 (8) → tenta 3 com 2 restantes (409, sem movimento) → devolve 2 (10)', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(10, 6);
  const pid = Number(produto.id);
  const trilha = [await saldo(produto)];
  assert.equal(trilha[0], 4);
  const d1 = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 2 }]);
  await devolverTudo(Number(d1.id), [{ id: Number((await itensDaDevolucao(Number(d1.id))).rows[0].id), quantidade_recebida: 2 }]);
  trilha.push(await saldo(produto));
  const d2 = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 2 }]);
  await devolverTudo(Number(d2.id), [{ id: Number((await itensDaDevolucao(Number(d2.id))).rows[0].id), quantidade_recebida: 2 }]);
  trilha.push(await saldo(produto));
  assert.deepEqual(trilha, [4, 6, 8]);
  const movsAntes = (await movimentosDaVenda(Number(venda.id))).length;
  await esperarErro(() => tentarCriarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 3 }]), 409, /Não é possível devolver/);
  assert.equal((await movimentosDaVenda(Number(venda.id))).length, movsAntes, 'a recusa não gerou movimento');
  assert.equal(await saldo(produto), 8);
  const d3 = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 2 }]);
  await devolverTudo(Number(d3.id), [{ id: Number((await itensDaDevolucao(Number(d3.id))).rows[0].id), quantidade_recebida: 2 }]);
  assert.equal(await saldo(produto), 10);
  assert.equal((await getStore().get(RESOURCES.vendas, Number(venda.id)))!.status, 'cancelada');
});

test('E2E-3: danificado — 3 vendidos (5 → 2), 1 bom e 1 danificado devolvidos, 3ª peça volta boa → saldo 4 (5 − 1 danificada)', async () => {
  const { venda, produto, tamanhoId } = await pedidoFaturado(5, 3);
  const pid = Number(produto.id);
  assert.equal(await saldo(produto), 2);
  const dev = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 2 }]);
  const bom = Number((await itensDaDevolucao(Number(dev.id))).rows[0].id);
  await autorizarERastrear(Number(dev.id));
  await receber(Number(dev.id), [{ id: bom, quantidade_recebida: 1, estado: 'bom' }]);
  assert.equal(await saldo(produto), 3, 'a boa voltou');
  assert.equal((await getStore().get(RESOURCES.vendas, Number(venda.id)))!.status, 'faturada');
  // Segunda devolução: a peça danificada, recebida como avariada.
  const d2 = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 1 }]);
  await devolverTudo(Number(d2.id), [{ id: Number((await itensDaDevolucao(Number(d2.id))).rows[0].id), quantidade_recebida: 1, estado: 'avariado' }]);
  assert.equal(await saldo(produto), 3, 'a danificada não entrou');
  // Terceira peça volta boa → venda inteira devolvida.
  const d3 = await criarDev(Number(venda.id), [{ produto_id: pid, tamanho_id: tamanhoId, quantidade: 1 }]);
  await devolverTudo(Number(d3.id), [{ id: Number((await itensDaDevolucao(Number(d3.id))).rows[0].id), quantidade_recebida: 1 }]);
  assert.equal(await saldo(produto), 4, '5 − 1 danificada = 4');
  assert.equal((await getStore().get(RESOURCES.vendas, Number(venda.id)))!.status, 'cancelada');
});
