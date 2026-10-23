// ============================================================================
// FORMAÇÃO PROFISSIONAL DO PREÇO DA VENDA — suíte canônica do servidor.
//
// Prova, pelo CONTRATO DO BACKEND (não pela tela), que a linha da venda
// distingue: preço de tabela → preço de venda → desconto % → desconto R$ →
// subtotal, e que o resumo fecha em preço bruto → desconto → líquido → frete →
// total, sem o erro "Desconto − R$ 0,00" quando há desconto nas linhas.
//
// Cobre os 12 cenários obrigatórios do pedido de correção.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getRecord, getStore } = await import('../src/services');
const { createItem, updateItem, deleteItem } = await import('../src/itens');
const {
  linhaDePreco,
  normalizarPct,
  pctDeDescontoUnitario,
  pctDePrecoVenda,
  precoVendaDe,
  precoVendaDeDescontoUnitario,
  resumoVenda,
} = await import('../src/precoVenda');
const { garantirAdmin, novoCliente, novoProduto, novoTamanho, reqDe } = await import('./_p1util');

await garantirAdmin();
const gerente = { id: 1, name: 'Admin Teste', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };

const cliente = await novoCliente({ nome: 'Cliente Preço Venda' });
const produto90 = await novoProduto({ sku: 'PV-90', nome: 'Produto Tabela 90', preco_venda: 90 });
const produto80 = await novoProduto({ sku: 'PV-80', nome: 'Produto Tabela 80', preco_venda: 80 });
const produtoSemTabela = await novoProduto({ sku: 'PV-0', nome: 'Produto Sem Preço', preco_venda: 0 });
const tamanho = await novoTamanho('PV-TAM');

function mockItem(vendaId: number, body: Record<string, unknown>, itemId?: number): any {
  const req = reqDe(body, { params: itemId ? { id: String(vendaId), itemId: String(itemId) } : { id: String(vendaId) }, user: gerente });
  req.path = `/api/vendas/${vendaId}/itens${itemId ? `/${itemId}` : ''}`;
  return req;
}

async function novaVenda(extra: Record<string, unknown> = {}) {
  return createRecord(
    RESOURCES.vendas,
    { cliente_id: cliente.id, data: '2026-10-23', status: 'aberta', canal_venda: 'balcao', ...extra },
    gerente
  );
}

async function addItem(vendaId: number, body: Record<string, unknown>) {
  let saida: any;
  await createItem(mockItem(vendaId, body), { status: () => ({ json: (d: any) => (saida = d) }) } as any);
  return saida;
}

async function editarItem(vendaId: number, itemId: number, body: Record<string, unknown>) {
  let saida: any;
  await updateItem(mockItem(vendaId, body, itemId), { json: (d: any) => (saida = d) } as any);
  return saida;
}

async function itensDaVenda(vendaId: number) {
  return (await getStore().list(RESOURCES.itens_venda, { page: 1, pageSize: 100, filter: { venda_id: vendaId } })).rows;
}

// ---------------------------------------------------------------------------
// Funções puras — a base de tudo
// ---------------------------------------------------------------------------

test('cenário 1 — tabela 90 com 20%: preço de venda 72 e desconto R$ 18', () => {
  const linha = linhaDePreco(1, 90, 20);
  assert.equal(linha.tabela, 90);
  assert.equal(linha.precoVenda, 72);
  assert.equal(linha.descontoPct, 20);
  assert.equal(linha.descontoUnitario, 18);
  assert.equal(linha.subtotal, 72);
  assert.equal(linha.desconto, 18);
});

test('cenário 2 — tabela 90 com 20,5%: preço de venda 71,55 e desconto R$ 18,45', () => {
  const linha = linhaDePreco(1, 90, 20.5);
  assert.equal(linha.precoVenda, 71.55);
  assert.equal(linha.descontoUnitario, 18.45);
  assert.equal(linha.subtotal, 71.55);
  assert.equal(linha.desconto, 18.45);
});

test('cenário 3 — tabela 90 e preço de venda 68: desconto R$ 22 e desconto 24,44%', () => {
  const pct = pctDePrecoVenda(90, 68);
  assert.equal(pct, 24.44);
  assert.equal(precoVendaDe(90, pct), 68);
  const linha = linhaDePreco(1, 90, pct);
  assert.equal(linha.descontoUnitario, 22);
  assert.equal(linha.descontoPct, 24.44);
});

test('cenário 4 — tabela 90 e desconto R$ 15: preço de venda 75 e desconto 16,67%', () => {
  const pct = pctDeDescontoUnitario(90, 15);
  assert.equal(pct, 16.67);
  assert.equal(precoVendaDeDescontoUnitario(90, 15), 75);
  const linha = linhaDePreco(1, 90, pct);
  assert.equal(linha.precoVenda, 75);
  assert.equal(linha.descontoUnitario, 15);
});

test('cenário 5 — sem desconto: preço de tabela = preço de venda, desconto 0 e subtotal correto', () => {
  const linha = linhaDePreco(3, 90, 0);
  assert.equal(linha.precoVenda, 90);
  assert.equal(linha.descontoPct, 0);
  assert.equal(linha.descontoUnitario, 0);
  assert.equal(linha.subtotal, 270);
  assert.equal(linha.desconto, 0);
});

test('cenário 6 — quantidade maior que 1: subtotal = preço de venda × quantidade e desconto total correto', () => {
  const linha = linhaDePreco(2, 80, 20);
  assert.equal(linha.precoVenda, 64);
  assert.equal(linha.subtotal, 128);
  assert.equal(linha.bruto, 160);
  assert.equal(linha.desconto, 32);
});

test('cenário 7 — múltiplas linhas com descontos diferentes: o resumo soma corretamente', () => {
  const l1 = linhaDePreco(1, 90, 20); // 72, desc 18
  const l2 = linhaDePreco(1, 90, 0); // 90, desc 0
  const l3 = linhaDePreco(2, 80, 20); // 128, desc 32
  const r = resumoVenda([l1, l2, l3], 0, 0);
  assert.equal(r.bruto, 90 + 90 + 160);
  assert.equal(r.descontoLinhas, 18 + 0 + 32);
  assert.equal(r.subtotalLiquido, 72 + 90 + 128);
  assert.equal(r.total, 72 + 90 + 128);
});

test('cenário 8 — frete: subtotal líquido + frete = total', () => {
  const l = linhaDePreco(1, 90, 20);
  const r = resumoVenda([l], 0, 25);
  assert.equal(r.subtotalLiquido, 72);
  assert.equal(r.frete, 25);
  assert.equal(r.total, 97);
});

test('cenário 9 — 20% em quatro linhas: tabela 430, desconto 86, total 344', () => {
  const linhas = [
    linhaDePreco(1, 90, 20),
    linhaDePreco(1, 90, 20),
    linhaDePreco(1, 90, 20),
    linhaDePreco(2, 80, 20),
  ];
  const r = resumoVenda(linhas, 0, 0);
  assert.equal(r.bruto, 430);
  assert.equal(r.descontoLinhas, 86);
  assert.equal(r.subtotalLiquido, 344);
  assert.equal(r.total, 344);
  assert.equal(r.descontoPct, 20);
});

test('cenário 10 — alterar o preço de venda várias vezes não acumula erro de arredondamento', () => {
  let pct = 0;
  for (const preco of [89.99, 71.55, 68, 90, 45.5, 12.34, 89.99, 68]) {
    pct = pctDePrecoVenda(90, preco);
    const linha = linhaDePreco(1, 90, pct);
    // Volta e fecha sempre no mesmo centavo: tabela − desconto = preço de venda.
    assert.equal(linha.descontoUnitario + linha.precoVenda, 90, `preço ${preco} não fechou`);
  }
  assert.equal(precoVendaDe(90, pctDePrecoVenda(90, 68)), 68);
});

test('cenário 11 — alterar o desconto % várias vezes mantém preço de venda coerente', () => {
  for (const pct of [0, 5, 12.5, 20, 20.5, 33.33, 50, 99.99, 100]) {
    const linha = linhaDePreco(1, 90, pct);
    assert.equal(linha.precoVenda, precoVendaDe(90, pct));
    assert.equal(linha.descontoUnitario + linha.precoVenda, 90, `pct ${pct} não fechou`);
  }
  assert.equal(linhaDePreco(1, 90, 100).precoVenda, 0);
});

test('cenário 12 — valores inválidos/negativos são normalizados para um intervalo seguro', () => {
  assert.equal(normalizarPct(-10), 0);
  assert.equal(normalizarPct(150), 100);
  assert.equal(linhaDePreco(1, 90, -5).precoVenda, 90, 'percentual negativo não aumenta o preço');
  assert.equal(linhaDePreco(1, 90, -5).descontoPct, 0);
  assert.equal(linhaDePreco(1, 90, 120).precoVenda, 0, 'percentual acima de 100 não gera preço negativo');
  assert.equal(linhaDePreco(1, -50, 20).tabela, 0, 'preço de tabela negativo é tratado como 0');
});

// ---------------------------------------------------------------------------
// Contrato HTTP/serviço — o backend é a autoridade
// ---------------------------------------------------------------------------

test('item da venda: grava o snapshot do preço de tabela e calcula subtotal pelo preço de venda', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  assert.equal(Number(item.preco_tabela), 90, 'snapshot do preço de tabela');
  assert.equal(Number(item.preco_unitario), 90, 'base da linha = preço de tabela');
  assert.equal(Number(item.desconto_pct), 20);
  assert.equal(Number(item.subtotal), 72, 'subtotal = preço de venda × quantidade');

  const venda = await getRecord(RESOURCES.vendas, Number(v.id), gerente);
  assert.equal(Number(venda.total), 72);
});

test('item da venda: preço de venda abaixo da tabela deriva o desconto % (24,44%)', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 68 });
  assert.equal(Number(item.preco_tabela), 90);
  assert.equal(Number(item.preco_unitario), 90, 'base continua a tabela');
  assert.equal(Number(item.desconto_pct), 24.44, 'desconto derivado do preço de venda');
  assert.equal(Number(item.subtotal), 68);
});

test('item da venda: preço de venda não pode ser reescrito pelo cliente e a tabela é imutável na linha', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  // O cliente tenta forjar um preço de tabela maior: é ignorado (readonly).
  const editado = await editarItem(Number(v.id), Number(item.id), { preco_tabela: 1000, quantidade: 2 });
  assert.equal(Number(editado.preco_tabela), 90, 'a tabela continua a referência da venda');
  assert.equal(Number(editado.desconto_pct), 20, 'o desconto foi preservado na edição só da quantidade');
  assert.equal(Number(editado.subtotal), 144, '2 × 72');
});

test('item da venda: desconto acima de 100% é recusado pela validação (não gera preço negativo)', async () => {
  const v = await novaVenda();
  await assert.rejects(
    () => addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 150 }),
    (e: any) => e?.status === 400 && e?.fields?.desconto_pct === 'Máximo: 100'
  );
});

test('item da venda: produto sem preço de tabela aceita o preço informado como preço de venda', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produtoSemTabela.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 50 });
  assert.equal(Number(item.preco_tabela), 0);
  assert.equal(Number(item.preco_unitario), 50);
  assert.equal(Number(item.desconto_pct), 0);
  assert.equal(Number(item.subtotal), 50);
});

test('resumo da venda: quatro linhas com 20% mostram desconto real de R$ 86 (não R$ 0,00)', async () => {
  const v = await novaVenda();
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await addItem(Number(v.id), { produto_id: Number(produto80.id), tamanho_id: Number(tamanho.id), quantidade: 2, preco_unitario: 80, desconto_pct: 20 });

  const itens = await itensDaVenda(Number(v.id));
  const linhas = itens.map((it) => ({
    bruto: Number(it.quantidade) * Number(it.preco_tabela ?? it.preco_unitario),
    subtotal: Number(it.subtotal),
  }));
  const r = resumoVenda(linhas, 0, 0);
  assert.equal(r.bruto, 430, 'preço de tabela total');
  assert.equal(r.descontoLinhas, 86, 'desconto real das linhas');
  assert.equal(r.subtotalLiquido, 344);
  assert.equal(r.total, 344);
  assert.equal(r.descontoPct, 20, 'percentual total = desconto / bruto (não média simples)');

  const venda = await getRecord(RESOURCES.vendas, Number(v.id), gerente);
  assert.equal(Number(venda.total), 344, 'total do servidor bate com o resumo');
});

test('resumo da venda: desconto comercial do cabeçalho entra no desconto total e no total', async () => {
  const v = await novaVenda({ desconto: 10, frete: 5 });
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 2, preco_unitario: 90, desconto_pct: 20 });
  const itens = await itensDaVenda(Number(v.id));
  const r = resumoVenda(
    itens.map((it) => ({ bruto: Number(it.quantidade) * Number(it.preco_tabela ?? it.preco_unitario), subtotal: Number(it.subtotal) })),
    10,
    5
  );
  assert.equal(r.subtotalLiquido, 144);
  assert.equal(r.descontoLinhas, 36);
  assert.equal(r.descontoPedido, 10);
  assert.equal(r.descontoTotal, 46);
  assert.equal(r.total, 144 - 10 + 5);
});

test('item da venda: remover item mantém o desconto das linhas restantes no resumo', async () => {
  const v = await novaVenda();
  const a = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await deleteItem(mockItem(Number(v.id), {}, Number(a.id)), { json: () => undefined } as any);
  const itens = await itensDaVenda(Number(v.id));
  assert.equal(itens.length, 1);
  const r = resumoVenda(
    itens.map((it) => ({ bruto: Number(it.quantidade) * Number(it.preco_tabela ?? it.preco_unitario), subtotal: Number(it.subtotal) })),
    0,
    0
  );
  assert.equal(r.bruto, 90);
  assert.equal(r.descontoLinhas, 18);
  assert.equal(r.total, 72);
});

test('item da venda: desconto de linha isolado não zera o resumo (regressão "Desconto − R$ 0,00")', async () => {
  const v = await novaVenda();
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  const itens = await itensDaVenda(Number(v.id));
  const r = resumoVenda(
    itens.map((it) => ({ bruto: Number(it.quantidade) * Number(it.preco_tabela ?? it.preco_unitario), subtotal: Number(it.subtotal) })),
    0,
    0
  );
  assert.notEqual(r.descontoLinhas, 0);
  assert.equal(r.descontoLinhas, 18);
});
