// ============================================================================
// CUSTO DE RECEBIMENTO DE COMPRA — E3.1 (GAP-COMP-CUSTOS)
//
// O que estes testes existem para provar:
//
//  1) UMA regra só. Recebimento total e parcial passam pela mesma rotina e
//     produzem o MESMO custo para a mesma entrada.
//  2) O custo é o EFETIVO: preço + frete rateado + imposto que compõe custo.
//     Nenhum dos três é inventado — o frete vem de `compras.frete` e o imposto
//     só do que foi informado.
//  3) O rateio de frete fecha no centavo: Σ rateio === frete, sem resíduo perdido.
//  4) A MOVIMENTAÇÃO carrega o custo. Sem isso o estorno teria que adivinhar.
//  5) Receber em dois lotes de preço diferente dá o custo certo — e o estorno
//     desfaz exatamente o que entrou, não o preço de hoje.
//  6) Estorno impossível (estoque já consumido) RECUSA, não zera o custo.
//  7) Empresa A e B não se misturam.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { custoUnitarioEfetivo, mediaPonderada, ratearFretePorValor } = await import('../src/custoRecebimento');
const { chamar, esperarErro, garantirAdmin, novoLocal, reqDe } = await import('./_p1util');
const compras = await import('../src/compras');

await garantirAdmin();
await novoLocal('loja');

const s = () => getStore();
let seq = 0;

async function novoInsumo(custoMedio = 0, empresaId = 1) {
  seq++;
  return s().insert(RESOURCES.insumos, { nome: `Insumo Custo ${seq}`, unidade: 'un', custo_medio: custoMedio, ativo: true, empresa_id: empresaId });
}
async function novoFornecedor(empresaId = 1) {
  seq++;
  return s().insert(RESOURCES.fornecedores, { nome: `Fornecedor Custo ${seq}`, ativo: true, empresa_id: empresaId });
}

/** Compra pendente com N linhas de insumo, preço e quantidade por linha. */
async function novaCompra(linhas: { qtd: number; preco: number }[], opts: { frete?: number; empresa_id?: number } = {}) {
  const empresaId = opts.empresa_id ?? 1;
  const fornecedor = await novoFornecedor(empresaId);
  const compra = await s().insert(RESOURCES.compras, {
    empresa_id: empresaId,
    fornecedor_id: Number(fornecedor.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'pendente',
    frete: opts.frete ?? 0,
    total: 0,
  });
  const itens: any[] = [];
  for (const l of linhas) {
    const insumo = await novoInsumo(0, empresaId);
    itens.push({
      insumo,
      item: await s().insert(RESOURCES.itens_compra, {
        empresa_id: empresaId,
        compra_id: Number(compra.id),
        insumo_id: Number(insumo.id),
        produto_id: null,
        quantidade: l.qtd,
        quantidade_recebida: 0,
        preco_unitario: l.preco,
      }),
    });
  }
  return { compra, itens, fornecedor };
}

async function receber(compraId: number, linhas: { item_compra_id: number; quantidade: number }[], chave?: string) {
  return chamar(
    compras.receberParcial,
    reqDe({ itens: linhas, ...(chave ? { idempotency_key: chave } : {}) }, { params: { id: compraId } }),
    201
  );
}

async function custoMedio(insumoId: number) {
  const row = await s().get(RESOURCES.insumos, insumoId);
  return Number(row?.custo_medio ?? 0);
}
async function saldoInsumo(insumoId: number) {
  return Number(await s().insumoStock(insumoId));
}

// ---------------------------------------------------------------------------
// 1) AS FUNÇÕES PURAS
// ---------------------------------------------------------------------------
test('E3.1: rateio de frete é proporcional ao valor e fecha no centavo', () => {
  // 3 linhas iguais, frete 10 → 3,33 + 3,33 + 3,34 = 10,00 exatos.
  const r = ratearFretePorValor(10, [
    { item_compra_id: 1, quantidade: 10, preco_unitario: 100 },
    { item_compra_id: 2, quantidade: 10, preco_unitario: 100 },
    { item_compra_id: 3, quantidade: 10, preco_unitario: 100 },
  ]);
  const soma = [...r.values()].reduce((a, b) => a + b, 0);
  assert.equal(Math.round(soma * 100) / 100, 10, `o rateio perdeu centavo: somou ${soma}`);
  assert.equal(r.get(1), 3.33);
  assert.equal(r.get(3), 3.34, 'o resíduo deve ir para a última linha');
});

test('E3.1: rateio de frete respeita a proporção de valor, não a de quantidade', () => {
  // Linha A vale 900 (1×900), linha B vale 100 (10×10). Frete 100 → 90/10.
  const r = ratearFretePorValor(100, [
    { item_compra_id: 1, quantidade: 1, preco_unitario: 900 },
    { item_compra_id: 2, quantidade: 10, preco_unitario: 10 },
  ]);
  assert.equal(r.get(1), 90);
  assert.equal(r.get(2), 10);
});

test('E3.1: sem frete não há rateio; pedido de valor zero não divide por zero', () => {
  const zero = ratearFretePorValor(0, [{ item_compra_id: 1, quantidade: 10, preco_unitario: 10 }]);
  assert.equal(zero.get(1), 0);
  const semValor = ratearFretePorValor(50, [{ item_compra_id: 1, quantidade: 0, preco_unitario: 0 }]);
  assert.equal(semValor.get(1), 0, 'divisão por zero no rateio');
  const semLinhas = ratearFretePorValor(50, []);
  assert.equal(semLinhas.size, 0);
});

test('E3.1: custo unitário efetivo soma preço + frete + imposto por unidade', () => {
  // 10 un a R$50, frete rateado R$20, imposto R$10 → 50 + 30/10 = 53
  assert.equal(custoUnitarioEfetivo(50, 10, 20, 10), 53);
  // sem acessórios é o preço puro
  assert.equal(custoUnitarioEfetivo(50, 10), 50);
  assert.equal(custoUnitarioEfetivo(50, 10, 0, 0), 50);
});

test('E3.1: custo efetivo recusa valor negativo (custo não é crédito)', () => {
  assert.throws(() => custoUnitarioEfetivo(-1, 10), /negativo/i);
  assert.throws(() => custoUnitarioEfetivo(10, 10, -5), /Frete rateado negativo/i);
  assert.throws(() => custoUnitarioEfetivo(10, 10, 0, -5), /Impostos negativos/i);
  assert.throws(() => custoUnitarioEfetivo(10, 0), /Quantidade inválida/i);
});

test('E3.1: média ponderada — a fórmula canônica do ERP', () => {
  // 40 un a 50 + 60 un a 60 → (40×50 + 60×60)/100 = 56
  assert.equal(mediaPonderada(40, 50, 60, 60), 56);
  // saldo zero → o custo passa a ser o da entrada (não divide por zero)
  assert.equal(mediaPonderada(0, 999, 10, 25), 25);
  // entrada igual ao custo não move nada
  assert.equal(mediaPonderada(100, 30, 50, 30), 30);
});

// ---------------------------------------------------------------------------
// 2) RECEBIMENTO PARCIAL — o que estava quebrado
// ---------------------------------------------------------------------------
test('E3.1: recebimento parcial ATUALIZA o custo médio e grava custo na movimentação', async () => {
  const { compra, itens } = await novaCompra([{ qtd: 100, preco: 50 }]);
  const insumoId = Number(itens[0].insumo.id);

  await receber(Number(compra.id), [{ item_compra_id: Number(itens[0].item.id), quantidade: 40 }]);

  assert.equal(await saldoInsumo(insumoId), 40, 'o estoque deveria subir 40');
  assert.equal(await custoMedio(insumoId), 50, 'o custo médio deveria ser atualizado pelo recebimento parcial');

  const movs = (await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 100, filter: { insumo_id: insumoId } })).rows;
  const entrada = movs.find((m) => String(m.tipo) === 'entrada');
  assert.ok(entrada, 'a entrada não foi registrada');
  assert.equal(Number(entrada!.custo_unitario), 50, 'a movimentação precisa carregar o custo — é a base do estorno');
  assert.equal(Number(entrada!.compra_id), Number(compra.id), 'a movimentação precisa ter vínculo estrutural com a compra');
  assert.ok(entrada!.recebimento_id, 'a movimentação precisa saber de qual recebimento veio');
  assert.equal(Number(entrada!.item_compra_id), Number(itens[0].item.id));
});

test('E3.1: 40 + 60 em dois lotes de PREÇO DIFERENTE dá o custo certo (não assume o 1º preço)', async () => {
  const { compra, itens } = await novaCompra([{ qtd: 100, preco: 50 }]);
  const insumoId = Number(itens[0].insumo.id);
  const itemId = Number(itens[0].item.id);

  await receber(Number(compra.id), [{ item_compra_id: itemId, quantidade: 40 }]);
  assert.equal(await custoMedio(insumoId), 50);

  // O segundo lote chega MAIS CARO. O pedido continua dizendo 50; o recebido é 60.
  await s().update(RESOURCES.itens_compra, itemId, { preco_unitario: 60 });
  await receber(Number(compra.id), [{ item_compra_id: itemId, quantidade: 60 }]);

  assert.equal(await saldoInsumo(insumoId), 100);
  // (40×50 + 60×60)/100 = 56 — e NÃO 50 (que seria assumir o preço do 1º lote).
  assert.equal(await custoMedio(insumoId), 56, 'o segundo lote precisa entrar pelo custo que realmente teve');

  const movs = (await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 100, filter: { insumo_id: insumoId } })).rows;
  const entradas = movs.filter((m) => String(m.tipo) === 'entrada');
  assert.equal(entradas.length, 2, 'cada lote é uma movimentação própria');
  assert.deepEqual(entradas.map((m) => Number(m.custo_unitario)).sort(), [50, 60], 'cada movimentação guarda o SEU custo');
});

test('E3.1: receber 40+60 é EQUIVALENTE a receber 100 de uma vez (mesmo preço)', async () => {
  // Caminho A: tudo de uma vez.
  const a = await novaCompra([{ qtd: 100, preco: 50 }]);
  await receber(Number(a.compra.id), [{ item_compra_id: Number(a.itens[0].item.id), quantidade: 100 }]);

  // Caminho B: em dois lotes, mesmo preço.
  const b = await novaCompra([{ qtd: 100, preco: 50 }]);
  await receber(Number(b.compra.id), [{ item_compra_id: Number(b.itens[0].item.id), quantidade: 40 }]);
  await receber(Number(b.compra.id), [{ item_compra_id: Number(b.itens[0].item.id), quantidade: 60 }]);

  const insumoA = Number(a.itens[0].insumo.id);
  const insumoB = Number(b.itens[0].insumo.id);
  assert.equal(await saldoInsumo(insumoA), await saldoInsumo(insumoB), 'estoque divergente entre os dois caminhos');
  assert.equal(await custoMedio(insumoA), await custoMedio(insumoB), 'custo médio divergente entre recebimento total e parcial');
  assert.equal(await custoMedio(insumoA), 50);
});

// ---------------------------------------------------------------------------
// 3) FRETE
// ---------------------------------------------------------------------------
test('E3.1: o frete da compra é rateado no custo efetivo e gravado no item', async () => {
  // 2 itens: 10×100 = 1000 e 10×300 = 3000 → total 4000. Frete 400 → 100/300.
  const { compra, itens } = await novaCompra(
    [
      { qtd: 10, preco: 100 },
      { qtd: 10, preco: 300 },
    ],
    { frete: 400 }
  );
  const [i1, i2] = itens;

  await receber(Number(compra.id), [
    { item_compra_id: Number(i1.item.id), quantidade: 10 },
    { item_compra_id: Number(i2.item.id), quantidade: 10 },
  ]);

  // Item 1: 100 + 100/10 = 110. Item 2: 300 + 300/10 = 330.
  assert.equal(await custoMedio(Number(i1.insumo.id)), 110, 'o frete rateado deve compor o custo do item 1');
  assert.equal(await custoMedio(Number(i2.insumo.id)), 330, 'o frete rateado deve compor o custo do item 2');

  const item1 = await s().get(RESOURCES.itens_compra, Number(i1.item.id));
  const item2 = await s().get(RESOURCES.itens_compra, Number(i2.item.id));
  assert.equal(Number(item1!.custo_frete_rateado), 100);
  assert.equal(Number(item2!.custo_frete_rateado), 300);
  assert.equal(Number(item1!.custo_frete_rateado) + Number(item2!.custo_frete_rateado), 400, 'o rateio tem que fechar no frete total');
});

test('E3.1: receber em DOIS lotes não cobra o frete duas vezes', async () => {
  // O frete é da COMPRA, não do lote. Se cada recebimento parcial ratear o frete
  // inteiro de novo, uma compra recebida em duas vezes paga o frete em dobro —
  // e o custo médio fica inflado sem ninguém perceber.
  const { compra, itens } = await novaCompra([{ qtd: 100, preco: 50 }], { frete: 400 });
  const insumoId = Number(itens[0].insumo.id);
  const itemId = Number(itens[0].item.id);

  await receber(Number(compra.id), [{ item_compra_id: itemId, quantidade: 40 }]);
  await receber(Number(compra.id), [{ item_compra_id: itemId, quantidade: 60 }]);

  const item = await s().get(RESOURCES.itens_compra, itemId);
  assert.equal(Number(item!.custo_frete_rateado), 400, `o rateio acumulado deveria somar o frete da compra, somou ${item!.custo_frete_rateado}`);

  // 40 un levam 160 de frete (400×40%) e 60 un levam 240 (400×60%).
  // Custo: (40×(50+4) + 60×(50+4))/100 = 54 — e não 58 (que seria frete em dobro).
  assert.equal(await custoMedio(insumoId), 54, 'o frete foi cobrado mais de uma vez');
  assert.equal(await saldoInsumo(insumoId), 100);
});

test('E3.1: receber em UM lote ou em DOIS dá o mesmo custo, com frete', async () => {
  const um = await novaCompra([{ qtd: 100, preco: 50 }], { frete: 400 });
  await receber(Number(um.compra.id), [{ item_compra_id: Number(um.itens[0].item.id), quantidade: 100 }]);

  const dois = await novaCompra([{ qtd: 100, preco: 50 }], { frete: 400 });
  await receber(Number(dois.compra.id), [{ item_compra_id: Number(dois.itens[0].item.id), quantidade: 40 }]);
  await receber(Number(dois.compra.id), [{ item_compra_id: Number(dois.itens[0].item.id), quantidade: 60 }]);

  const a = await custoMedio(Number(um.itens[0].insumo.id));
  const b = await custoMedio(Number(dois.itens[0].insumo.id));
  assert.equal(a, b, `receber de uma vez deu ${a} e em duas vezes deu ${b} — o frete não pode depender de quantos lotes chegaram`);
  assert.equal(a, 54);
});

test('E3.1: sem frete o custo é o preço puro', async () => {
  const { compra, itens } = await novaCompra([{ qtd: 10, preco: 50 }]);
  await receber(Number(compra.id), [{ item_compra_id: Number(itens[0].item.id), quantidade: 10 }]);
  assert.equal(await custoMedio(Number(itens[0].insumo.id)), 50);
  const item = await s().get(RESOURCES.itens_compra, Number(itens[0].item.id));
  assert.equal(Number(item!.custo_frete_rateado), 0);
});

// ---------------------------------------------------------------------------
// 4) ESTORNO
// ---------------------------------------------------------------------------
test('E3.1: cancelar a compra estorna estoque E restaura o custo médio', async () => {
  const { compra, itens } = await novaCompra([{ qtd: 100, preco: 50 }]);
  const insumoId = Number(itens[0].insumo.id);
  const itemId = Number(itens[0].item.id);

  await receber(Number(compra.id), [{ item_compra_id: itemId, quantidade: 40 }]);
  await s().update(RESOURCES.itens_compra, itemId, { preco_unitario: 60 });
  await receber(Number(compra.id), [{ item_compra_id: itemId, quantidade: 60 }]);
  assert.equal(await custoMedio(insumoId), 56);
  assert.equal(await saldoInsumo(insumoId), 100);

  // recebido → cancelado dispara o estorno. Precisa ir por updateRecord: é lá
  // que mora o hook aplicarRegrasPedido — s().update() cru não dispara nada.
  const { updateRecord } = await import('../src/services');
  const { ADMIN } = await import('./_p1util');
  await updateRecord(RESOURCES.compras, Number(compra.id), { status: 'cancelado' }, ADMIN, { escopo: ADMIN });

  assert.equal(await saldoInsumo(insumoId), 0, 'o estoque deveria voltar a zero');
  assert.equal(await custoMedio(insumoId), 0, 'o custo médio deveria voltar ao que era antes da compra');
});

test('E3.1: estorno de compra recebida PARCIALMENTE também devolve o insumo', async () => {
  // Este é o bug que existia: o estorno procurava a entrada pelo texto do motivo
  // ("Compra #N") e o parcial grava "Recebimento parcial — Compra #N" — então o
  // estoque de insumo ficava para cima para sempre.
  const { compra, itens } = await novaCompra([{ qtd: 100, preco: 50 }]);
  const insumoId = Number(itens[0].insumo.id);

  await receber(Number(compra.id), [{ item_compra_id: Number(itens[0].item.id), quantidade: 40 }]);
  assert.equal(await saldoInsumo(insumoId), 40);

  // Compra ainda parcial: forçar o estorno direto pela rotina canônica.
  const { estornarEntradasDeCompra } = await import('../src/custoRecebimento');
  await s().transaction(async (tx) => {
    await estornarEntradasDeCompra({
      compraId: Number(compra.id),
      actor: { id: 1, name: 'Admin Teste' },
      motivo: 'Estorno de teste',
      tx,
      escopo: { empresaId: 1, consolidado: false, permitidas: [1] },
    });
  });

  assert.equal(await saldoInsumo(insumoId), 0, 'a entrada PARCIAL de insumo precisa ser encontrada e estornada');
  assert.equal(await custoMedio(insumoId), 0);
});

test('E3.1: estorno com estoque já consumido RECUSA em vez de zerar o custo', async () => {
  const { compra, itens } = await novaCompra([{ qtd: 100, preco: 50 }]);
  const insumoId = Number(itens[0].insumo.id);

  await receber(Number(compra.id), [{ item_compra_id: Number(itens[0].item.id), quantidade: 10 }]);
  // Consome quase tudo.
  await s().adjustInsumoStock(insumoId, -8);
  assert.equal(await saldoInsumo(insumoId), 2);

  const { estornarEntradasDeCompra } = await import('../src/custoRecebimento');
  await esperarErro(
    () =>
      s().transaction(async (tx) => {
        await estornarEntradasDeCompra({
          compraId: Number(compra.id),
          actor: { id: 1, name: 'Admin Teste' },
          motivo: 'Estorno impossível',
          tx,
          escopo: { empresaId: 1, consolidado: false, permitidas: [1] },
        });
      }),
    409,
    /já foi consumido/
  );

  // Nada foi tocado: o rollback deixou estoque e custo intactos.
  assert.equal(await saldoInsumo(insumoId), 2, 'o estorno recusado não podia mexer no estoque');
  assert.equal(await custoMedio(insumoId), 50, 'o estorno recusado não podia zerar o custo');
});

// ---------------------------------------------------------------------------
// 5) IDEMPOTÊNCIA
// ---------------------------------------------------------------------------
test('E3.1: repetir o recebimento não duplica estoque nem recalcula o custo', async () => {
  const { compra, itens } = await novaCompra([{ qtd: 100, preco: 50 }]);
  const insumoId = Number(itens[0].insumo.id);
  const itemId = Number(itens[0].item.id);

  const primeiro = await receber(Number(compra.id), [{ item_compra_id: itemId, quantidade: 40 }], 'chave-fixa-1');
  const custoDepoisDo1 = await custoMedio(insumoId);

  const repetido = await chamar(
    compras.receberParcial,
    reqDe({ itens: [{ item_compra_id: itemId, quantidade: 40 }], idempotency_key: 'chave-fixa-1' }, { params: { id: compra.id } }),
    200
  );
  assert.equal(repetido.idempotente, true);

  assert.equal(await saldoInsumo(insumoId), 40, 'a repetição dobrou o estoque');
  assert.equal(await custoMedio(insumoId), custoDepoisDo1, 'a repetição recalculou o custo');

  const movs = (await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 100, filter: { insumo_id: insumoId } })).rows;
  assert.equal(movs.filter((m) => String(m.tipo) === 'entrada').length, 1, 'a repetição duplicou a movimentação');
  void primeiro;
});

// ---------------------------------------------------------------------------
// 6) MULTIEMPRESA
// ---------------------------------------------------------------------------
test('E3.1: o mesmo SKU lógico em A e B tem estoque e custo isolados (A → B → A)', async () => {
  const empresaB = await s().insert(RESOURCES.empresas, { nome: 'Empresa B Custo', cnpj: '44555666000155', ativo: true });
  const bid = Number(empresaB.id);

  // A compra a R$50.
  const a = await novaCompra([{ qtd: 100, preco: 50 }], { empresa_id: 1 });
  await receber(Number(a.compra.id), [{ item_compra_id: Number(a.itens[0].item.id), quantidade: 100 }]);

  // B compra o MESMO insumo lógico (mesmo nome) a R$80.
  const b = await novaCompra([{ qtd: 100, preco: 80 }], { empresa_id: bid });
  const usuarioB = await s().insert(RESOURCES.usuarios, { nome: 'Gerente B Custo', email: `gb-custo-${bid}@brobond.test`, perfil: 'gerente', empresa_id: bid, ativo: true });
  const gerenteB = { id: Number(usuarioB.id), name: 'Gerente B Custo', perfil: 'gerente' as const, empresa_id: bid, empresas: [bid] };
  await chamar(
    compras.receberParcial,
    reqDe({ itens: [{ item_compra_id: Number(b.itens[0].item.id), quantidade: 100 }] }, { params: { id: b.compra.id }, user: gerenteB as any }),
    201
  );

  const insumoA = Number(a.itens[0].insumo.id);
  const insumoB = Number(b.itens[0].insumo.id);
  assert.notEqual(insumoA, insumoB, 'cada empresa precisa ter o próprio insumo');
  assert.equal(await custoMedio(insumoA), 50, 'o custo da A vazou');
  assert.equal(await custoMedio(insumoB), 80, 'o custo da B vazou');
  assert.equal(await saldoInsumo(insumoA), 100);
  assert.equal(await saldoInsumo(insumoB), 100);

  // Movimentações isoladas por empresa.
  const movsA = (await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 100, filter: { insumo_id: insumoA } })).rows;
  assert.ok(movsA.every((m) => Number(m.empresa_id) === 1), 'movimentação da A com empresa errada');
  const movsB = (await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 100, filter: { insumo_id: insumoB } })).rows;
  assert.ok(movsB.every((m) => Number(m.empresa_id) === bid), 'movimentação da B com empresa errada');

  // Voltando para A: nada mudou.
  assert.equal(await custoMedio(insumoA), 50);
});

test('E3.1: a empresa B não recebe a compra da A', async () => {
  const empresaB = await s().insert(RESOURCES.empresas, { nome: 'Empresa B Cross', cnpj: '55666777000100', ativo: true });
  const usuarioB = await s().insert(RESOURCES.usuarios, { nome: 'Gerente B Cross', email: `gb-cross-${Number(empresaB.id)}@brobond.test`, perfil: 'gerente', empresa_id: Number(empresaB.id), ativo: true });
  const gerenteB = { id: Number(usuarioB.id), name: 'Gerente B Cross', perfil: 'gerente' as const, empresa_id: Number(empresaB.id), empresas: [Number(empresaB.id)] };

  const a = await novaCompra([{ qtd: 50, preco: 50 }]);
  const insumoId = Number(a.itens[0].insumo.id);

  await esperarErro(
    () =>
      chamar(
        compras.receberParcial,
        reqDe({ itens: [{ item_compra_id: Number(a.itens[0].item.id), quantidade: 50 }] }, { params: { id: a.compra.id }, user: gerenteB as any }),
        201
      ),
    404
  );
  assert.equal(await saldoInsumo(insumoId), 0, 'a empresa B conseguiu subir estoque da A');
});
