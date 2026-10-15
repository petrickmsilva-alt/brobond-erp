// ============================================================================
// GOLIVE-03 — MARKETPLACE → VENDA OPERACIONAL, em PostgreSQL REAL.
//
// A ingestão de marketplace grava SOMENTE `sales`/`sale_items` (analítico).
// Aqui se prova, contra o banco de verdade, que a ponte converte a ordem
// ingerida numa venda OPERACIONAL (`vendas`/`itens_venda`) reusando os motores
// canônicos — e só isso:
//
//   • a venda nasce com `canal_venda = 'marketplace'`, o rastro do pedido
//     externo e o TOTAL recalculado pelo ERP (nunca o total do marketplace);
//   • o faturamento dá UMA baixa de estoque, UMA movimentação e UM lançamento
//     financeiro;
//   • IDEMPOTÊNCIA: reconverter (e reconverter EM CONCORRÊNCIA) não duplica
//     venda, baixa nem lançamento — a garantia é o índice único do banco;
//   • MULTIEMPRESA: a empresa vem da ordem; o ator de outra empresa recebe 404
//     e nada é escrito no tenant alheio;
//   • FAIL CLOSED: SKU ambíguo/inexistente NÃO vira venda com o produto errado;
//   • BI: a venda aparece UMA vez (a linha analítica original), sem a projeção
//     `vendas → sales` criar uma segunda.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('pg-golive03-marketplace-venda.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query } = await import('../../src/db');
await migrate();
const { RESOURCES } = await import('../../src/resources');
const { getStore } = await import('../../src/services');
const { escopoDoAtor } = await import('../../src/empresa');
const { converterOrdemMarketplaceEmVenda, marketplaceVendaReference } = await import('../../src/marketplaceOperacional');
const { projetarVendasErp } = await import('../../src/negocios');
const { novoLocal, novoProduto, novoTamanho, saldoInicial, saldoDe } = await import('../_p1util');

type Ator = { id: number; name: string; perfil: 'admin'; empresa_id: number; empresas: number[] };

const RODADA = `g03${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;
const unico = (p: string) => `${p}-${RODADA}-${++contador}`;

/** Empresa + usuário reais + Local padrão. */
async function novoTenant(): Promise<{ empresaId: number; ator: Ator }> {
  const cnpj = String(Math.floor(10_000_000_000_000 + Math.random() * 89_999_999_999_999));
  const emp = await query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [unico('Empresa G03'), cnpj]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, 'admin', $3, true) RETURNING id, nome`,
    [unico('Usuário G03'), `${unico('g03')}@brobond.test`, empresaId]
  );
  await novoLocal('loja', empresaId, true);
  return {
    empresaId,
    ator: { id: Number(usr.rows[0].id), name: String(usr.rows[0].nome), perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] },
  };
}

type Produto = { produtoId: number; tamanhoCodigo: string; sku: string; local: string };

/** Produto com saldo; o SKU composto carrega o tamanho como sufixo. */
async function produtoComSaldo(empresaId: number, preco: number, quantidade = 10, tamanhoCodigo = 'M'): Promise<Produto> {
  const sku = unico('MKT-CAM');
  const p = await novoProduto({ empresa_id: empresaId, sku, nome: unico('Camisa G03'), preco_venda: preco, custo: 40, ativo: true });
  const saldo = await saldoInicial(p, quantidade, { codigoTamanho: tamanhoCodigo });
  return { produtoId: Number(p.id), tamanhoCodigo, sku, local: String(saldo.local) };
}

/** Item de `sale_items` já casado com o catálogo — como a ingestão grava. */
async function itemCasado(produto: Produto, quantidade: number, precoCents: number, variacao = 'M') {
  const tam = await novoTamanho(produto.tamanhoCodigo);
  return { sku: produto.sku, titulo: 'Camisa', quantidade, precoCents, variacao, produtoId: produto.produtoId, tamanhoId: Number(tam.id) };
}

/** Cria a ordem ANALÍTICA em `sales`/`sale_items` (o que a ingestão grava). */
async function ingerirOrdem(opts: {
  empresaId: number;
  usuarioId: number;
  channel: string;
  externalOrderId: string;
  itens: Array<{
    sku: string | null;
    titulo: string;
    quantidade: number;
    precoCents: number;
    variacao?: string | null;
    /** Vínculo com o catálogo — é o que `matchCatalogItem` grava na ingestão. */
    produtoId?: number | null;
    tamanhoId?: number | null;
  }>;
  buyerName?: string | null;
  buyerEmail?: string | null;
  status?: string;
}): Promise<string> {
  const s = getStore();
  const quantidade = opts.itens.reduce((n, i) => n + i.quantidade, 0);
  const amountCents = opts.itens.reduce((n, i) => n + i.quantidade * i.precoCents, 0);
  const sale = await s.insert(RESOURCES.sales, {
    id: unico('sale'),
    reference: `empresa:${opts.empresaId}:usuario:${opts.usuarioId}:${opts.channel.toLowerCase()}:${opts.externalOrderId}`,
    quantity: quantidade,
    amount_cents: amountCents,
    currency: 'BRL',
    status: opts.status ?? 'PAID',
    occurred_at: new Date().toISOString(),
    channel: opts.channel,
    external_order_id: opts.externalOrderId,
    usuario_id: opts.usuarioId,
    empresa_id: opts.empresaId,
    buyer_name: opts.buyerName ?? null,
    buyer_email: opts.buyerEmail ?? null,
  });
  for (const item of opts.itens) {
    await s.insert(RESOURCES.sale_items, {
      id: unico('sitem'),
      sale_id: String(sale.id),
      product_id: item.produtoId ?? null,
      size_id: item.tamanhoId ?? null,
      variacao_externa: item.variacao ?? item.titulo,
      quantity: item.quantidade,
      unit_price_cents: item.precoCents,
      discount_cents: 0,
      subtotal_cents: item.quantidade * item.precoCents,
    });
  }
  return String(sale.id);
}

const converter = (saleId: string, ator: Ator) => converterOrdemMarketplaceEmVenda(saleId, escopoDoAtor(ator));

async function contar(tabela: string, where: string, params: unknown[]): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS n FROM ${tabela} WHERE ${where}`, params);
  return Number(r.rows[0].n);
}

// ---------------------------------------------------------------------------
// 1) Conversão feliz — venda operacional real, com estoque e financeiro
// ---------------------------------------------------------------------------
test('GOLIVE-03: converte a ordem do marketplace em venda operacional completa', async () => {
  const t = await novoTenant();
  const produto = await produtoComSaldo(t.empresaId, 100, 10, 'M');
  const pedidoExterno = unico('ML-ORDER');

  const saleId = await ingerirOrdem({
    empresaId: t.empresaId,
    usuarioId: t.ator.id,
    channel: 'MERCADOLIVRE',
    externalOrderId: pedidoExterno,
    itens: [await itemCasado(produto, 2, 9000)],
    buyerName: 'Comprador Teste',
    buyerEmail: `${unico('comprador')}@exemplo.test`,
  });

  const r = await converter(saleId, t.ator);
  assert.equal(r.outcome, 'created');
  assert.equal(r.empresaId, t.empresaId);
  assert.equal(r.canal, 'MERCADOLIVRE');
  assert.equal(r.itemCount, 1);
  // Total recalculado pelo ERP a partir do preço REAL praticado no pedido:
  // 2 × R$90 = R$180.
  assert.equal(r.total, 180);

  const venda = await query(`SELECT * FROM vendas WHERE id = $1`, [r.vendaId]);
  assert.equal(venda.rows.length, 1);
  assert.equal(venda.rows[0].canal_venda, 'marketplace');
  assert.equal(venda.rows[0].pedido_externo_canal, 'MERCADOLIVRE');
  assert.equal(venda.rows[0].pedido_externo_id, pedidoExterno);
  assert.equal(venda.rows[0].empresa_id, t.empresaId);
  assert.equal(Number(venda.rows[0].total), 180);
  assert.equal(venda.rows[0].status, 'faturada');

  // Itens operacionais com o produto/tamanho resolvidos.
  const itens = await query(`SELECT * FROM itens_venda WHERE venda_id = $1`, [r.vendaId]);
  assert.equal(itens.rows.length, 1);
  assert.equal(Number(itens.rows[0].produto_id), produto.produtoId);
  assert.equal(Number(itens.rows[0].quantidade), 2);
  assert.equal(Number(itens.rows[0].preco_unitario), 90);

  // UMA baixa de estoque (2 peças) e UMA movimentação.
  const tamanho = await novoTamanho(produto.tamanhoCodigo);
  assert.equal(await saldoDe(produto.produtoId, Number(tamanho.id), produto.local), 8);
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [r.vendaId]), 1);

  // UM lançamento financeiro de venda.
  assert.equal(await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [r.vendaId]), 1);

  // A linha analítica original passa a APONTAR para a venda operacional.
  const sale = await query(`SELECT operational_venda_id, amount_cents, status FROM sales WHERE id = $1`, [saleId]);
  assert.equal(Number(sale.rows[0].operational_venda_id), r.vendaId);
  assert.equal(Number(sale.rows[0].amount_cents), 18000);
  assert.equal(sale.rows[0].status, 'PAID');
});

// ---------------------------------------------------------------------------
// 2) Idempotência — reconverter não duplica nada
// ---------------------------------------------------------------------------
test('GOLIVE-03: reconverter a mesma ordem devolve a venda existente, sem duplicar efeitos', async () => {
  const t = await novoTenant();
  const produto = await produtoComSaldo(t.empresaId, 50, 10, 'M');
  const pedidoExterno = unico('NS-ORDER');
  const saleId = await ingerirOrdem({
    empresaId: t.empresaId,
    usuarioId: t.ator.id,
    channel: 'NUVEMSHOP',
    externalOrderId: pedidoExterno,
    itens: [await itemCasado(produto, 1, 5000)],
  });

  const primeira = await converter(saleId, t.ator);
  const segunda = await converter(saleId, t.ator);
  assert.equal(primeira.outcome, 'created');
  assert.equal(segunda.outcome, 'existing');
  assert.equal(segunda.vendaId, primeira.vendaId);

  assert.equal(await contar('vendas', 'pedido_externo_canal = $1 AND pedido_externo_id = $2', ['NUVEMSHOP', pedidoExterno]), 1);
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [primeira.vendaId]), 1);
  assert.equal(await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [primeira.vendaId]), 1);

  const tamanho = await novoTamanho(produto.tamanhoCodigo);
  assert.equal(await saldoDe(produto.produtoId, Number(tamanho.id), produto.local), 9);
});

// ---------------------------------------------------------------------------
// 3) Concorrência — duas conversões simultâneas → UMA venda, UMA baixa
// ---------------------------------------------------------------------------
test('GOLIVE-03: conversões concorrentes da mesma ordem produzem UMA venda e UMA baixa', async () => {
  const t = await novoTenant();
  const produto = await produtoComSaldo(t.empresaId, 30, 10, 'M');
  const pedidoExterno = unico('MP-ORDER');
  const saleId = await ingerirOrdem({
    empresaId: t.empresaId,
    usuarioId: t.ator.id,
    channel: 'MERCADOPAGO',
    externalOrderId: pedidoExterno,
    itens: [await itemCasado(produto, 3, 3000)],
  });

  const resultados = await Promise.allSettled([converter(saleId, t.ator), converter(saleId, t.ator), converter(saleId, t.ator)]);
  const ok = resultados.filter((r) => r.status === 'fulfilled').map((r: any) => r.value);
  const falhas = resultados.filter((r) => r.status === 'rejected').map((r: any) => r.reason);
  // As chamadas perdedoras falham por conflito de serialização (400/409) ou
  // reencontram a venda — o que NUNCA pode acontecer é duplicidade.
  assert.ok(ok.length >= 1, `ao menos uma conversão deve vencer; falhas: ${falhas.map((f) => f?.message).join(' | ')}`);
  const vendaIds = new Set(ok.map((r) => r.vendaId));
  assert.equal(vendaIds.size, 1, 'todas as vencedoras apontam para a MESMA venda');
  const vendaId = [...vendaIds][0];

  assert.equal(await contar('vendas', 'pedido_externo_canal = $1 AND pedido_externo_id = $2', ['MERCADOPAGO', pedidoExterno]), 1);
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [vendaId]), 1);
  assert.equal(await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [vendaId]), 1);

  const tamanho = await novoTamanho(produto.tamanhoCodigo);
  assert.equal(await saldoDe(produto.produtoId, Number(tamanho.id), produto.local), 7);
});

// ---------------------------------------------------------------------------
// 4) Multiempresa — a empresa vem da ordem; ator estranho recebe 404
// ---------------------------------------------------------------------------
test('GOLIVE-03: ator de outra empresa não converte a ordem e nada é escrito no tenant alheio', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  const produto = await produtoComSaldo(a.empresaId, 70, 5, 'M');
  const pedidoExterno = unico('TENANT-ORDER');
  const saleId = await ingerirOrdem({
    empresaId: a.empresaId,
    usuarioId: a.ator.id,
    channel: 'MERCADOLIVRE',
    externalOrderId: pedidoExterno,
    itens: [await itemCasado(produto, 1, 7000)],
  });

  await assert.rejects(() => converter(saleId, b.ator), (e: any) => (e?.status ?? e?.statusCode) === 404);

  assert.equal(await contar('vendas', 'pedido_externo_canal = $1 AND pedido_externo_id = $2', ['MERCADOLIVRE', pedidoExterno]), 0);
  const tamanho = await novoTamanho(produto.tamanhoCodigo);
  assert.equal(await saldoDe(produto.produtoId, Number(tamanho.id), produto.local), 5);

  // A empresa dona converte normalmente.
  const r = await converter(saleId, a.ator);
  assert.equal(r.empresaId, a.empresaId);
  const venda = await query(`SELECT empresa_id FROM vendas WHERE id = $1`, [r.vendaId]);
  assert.equal(Number(venda.rows[0].empresa_id), a.empresaId);
});

// ---------------------------------------------------------------------------
// 5) Fail closed — SKU ambíguo ou inexistente nunca vira venda errada
// ---------------------------------------------------------------------------
test('GOLIVE-03: SKU inexistente rejeita a conversão (fail closed, nada é criado)', async () => {
  const t = await novoTenant();
  const pedidoExterno = unico('UNKNOWN-SKU');
  const saleId = await ingerirOrdem({
    empresaId: t.empresaId,
    usuarioId: t.ator.id,
    channel: 'NUVEMSHOP',
    externalOrderId: pedidoExterno,
    itens: [{ sku: unico('SKU-INEXISTENTE'), titulo: 'Produto Fantasma', quantidade: 1, precoCents: 1000 }],
  });

  // Item que a ingestao nao conseguiu casar (product_id NULL) NAO vira venda.
  await assert.rejects(() => converter(saleId, t.ator), (e: any) => (e?.status ?? e?.statusCode) === 409);
  assert.equal(await contar('vendas', 'pedido_externo_canal = $1 AND pedido_externo_id = $2', ['NUVEMSHOP', pedidoExterno]), 0);
  const sale = await query(`SELECT operational_venda_id FROM sales WHERE id = $1`, [saleId]);
  assert.equal(sale.rows[0].operational_venda_id, null);
});

test('GOLIVE-03: item casado com produto de OUTRA empresa rejeita a conversao (vinculo cruzado)', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  const produtoB = await produtoComSaldo(b.empresaId, 10, 10, 'M');
  const pedidoExterno = unico('CROSS-ORDER');
  // Ordem da empresa A, mas o item aponta (indevidamente) para um produto de B.
  const saleId = await ingerirOrdem({
    empresaId: a.empresaId,
    usuarioId: a.ator.id,
    channel: 'MERCADOLIVRE',
    externalOrderId: pedidoExterno,
    itens: [{ sku: produtoB.sku, titulo: 'Camisa', quantidade: 1, precoCents: 1000, produtoId: produtoB.produtoId }],
  });

  await assert.rejects(() => converter(saleId, a.ator), (e: any) => (e?.status ?? e?.statusCode) === 409);
  assert.equal(await contar('vendas', 'pedido_externo_canal = $1 AND pedido_externo_id = $2', ['MERCADOLIVRE', pedidoExterno]), 0);
});

// ---------------------------------------------------------------------------
// 6) BI sem duplicidade — a venda aparece UMA vez
// ---------------------------------------------------------------------------
test('GOLIVE-03: o BI conta a venda do marketplace UMA vez (sem linha duplicada na projeção)', async () => {
  const t = await novoTenant();
  const produto = await produtoComSaldo(t.empresaId, 80, 10, 'M');
  const pedidoExterno = unico('BI-ORDER');
  const saleId = await ingerirOrdem({
    empresaId: t.empresaId,
    usuarioId: t.ator.id,
    channel: 'MERCADOLIVRE',
    externalOrderId: pedidoExterno,
    itens: [await itemCasado(produto, 1, 8000)],
  });

  const r = await converter(saleId, t.ator);

  // A projeção canônica `vendas → sales` roda e NÃO pode criar uma segunda
  // linha para esta venda (ela já é representada pela linha analítica).
  await projetarVendasErp();

  const projecao = await query(`SELECT id FROM sales WHERE id = $1`, [`erp:venda:${r.vendaId}`]);
  assert.equal(projecao.rows.length, 0, 'a venda de marketplace não deve ser projetada de novo');

  const linhasDoPedido = await contar('sales', 'channel = $1 AND external_order_id = $2 AND empresa_id = $3', [
    'MERCADOLIVRE',
    pedidoExterno,
    t.empresaId,
  ]);
  assert.equal(linhasDoPedido, 1, 'o pedido do marketplace deve aparecer exatamente UMA vez no BI');

  // E a linha que existe é a analítica original, já com o vínculo operacional.
  const sale = await query(`SELECT operational_venda_id, amount_cents FROM sales WHERE id = $1`, [saleId]);
  assert.equal(Number(sale.rows[0].operational_venda_id), r.vendaId);
  assert.equal(Number(sale.rows[0].amount_cents), 8000);
});

// ---------------------------------------------------------------------------
// 7) Rollback — falha no meio não deixa estado parcial
// ---------------------------------------------------------------------------
test('GOLIVE-03: falha de conversão (ordem sem itens) não deixa venda nem baixa parciais', async () => {
  const t = await novoTenant();
  const pedidoExterno = unico('EMPTY-ORDER');
  const saleId = await ingerirOrdem({
    empresaId: t.empresaId,
    usuarioId: t.ator.id,
    channel: 'NUVEMSHOP',
    externalOrderId: pedidoExterno,
    itens: [],
  });

  await assert.rejects(() => converter(saleId, t.ator), (e: any) => (e?.status ?? e?.statusCode) === 409);
  assert.equal(await contar('vendas', 'pedido_externo_canal = $1 AND pedido_externo_id = $2', ['NUVEMSHOP', pedidoExterno]), 0);
  const sale = await query(`SELECT operational_venda_id FROM sales WHERE id = $1`, [saleId]);
  assert.equal(sale.rows[0].operational_venda_id, null);
});

// ---------------------------------------------------------------------------
// 8) Referência idempotente é determinística
// ---------------------------------------------------------------------------
test('GOLIVE-03: a referência idempotente é determinística por empresa/canal/pedido', () => {
  assert.equal(marketplaceVendaReference(1, 'MERCADOLIVRE', 'A1'), marketplaceVendaReference(1, 'MERCADOLIVRE', 'A1'));
  assert.notEqual(marketplaceVendaReference(1, 'MERCADOLIVRE', 'A1'), marketplaceVendaReference(2, 'MERCADOLIVRE', 'A1'));
  assert.notEqual(marketplaceVendaReference(1, 'MERCADOLIVRE', 'A1'), marketplaceVendaReference(1, 'NUVEMSHOP', 'A1'));
});
