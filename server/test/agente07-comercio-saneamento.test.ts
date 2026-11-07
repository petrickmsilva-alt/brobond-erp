// ============================================================================
// AGENTE 07 — SANEAMENTO DA UNIFICAÇÃO COMERCIAL (A06-01 … A06-13).
//
// Prova de regressão dos achados da auditoria Agente 06 nos caminhos que NÃO
// dependem de rede: importação de pedidos (Multi-Store e legado), autoridade de
// preço, mínimo de atacado, identidade de pedido por loja, estoque de variação,
// disponível vendável (reservas), escopo de override por loja, reconciliação de
// item ausente e projeção operacional → analítica (BI).
//
// Nenhuma chamada real: `fetch` é substituído por um espião.
// ============================================================================
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];

const { RESOURCES, getResource } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { exigirConfigStore } = await import('../src/commerce/woocommerce/registry');
const { importarPedidosDaLoja, importarUmPedido, carregarContextoImportacao, referenciaPedido } = await import(
  '../src/commerce/woocommerce/pedidos'
);
const { disponivelDoProdutoVendavel, disponibilidadesPorTamanho } = await import('../src/commerce/catalogo');
const { decidirPrecoItem, precoOficialDoErp } = await import('../src/commerce/woocommerce/precoAutoridade');
const { validarMinimoAtacado, minimoAtacado, precoDaLoja } = await import('../src/commerce/woocommerce/precos');
const { salvarPrecoCanal } = await import('../src/commerce/catalogo');
const { projetarVendasErp } = await import('../src/negocios');

const RETAIL_URL = 'https://brobond.com.br';
const WHOLESALE_URL = 'https://atacado.brobond.com.br';

type Chamada = { url: string; metodo: string; corpo: any };

function espionar(responder: (url: string, metodo: string, corpo: any) => unknown) {
  const chamadas: Chamada[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
    const metodo = String(init?.method || 'GET').toUpperCase();
    chamadas.push({ url: String(url), metodo, corpo });
    const resposta = responder(String(url), metodo, corpo);
    if (resposta instanceof Error) throw resposta;
    return new Response(JSON.stringify(resposta ?? null), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

function configurarLojas(empresaId: number) {
  process.env.WOOCOMMERCE_MULTI_STORE_ENABLED = 'true';
  process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
  process.env.WOOCOMMERCE_RETAIL_URL = RETAIL_URL;
  process.env.WOOCOMMERCE_RETAIL_CK = 'ck_retail_teste';
  process.env.WOOCOMMERCE_RETAIL_CS = 'cs_retail_teste';
  process.env.WOOCOMMERCE_RETAIL_EMPRESA_ID = String(empresaId);
  process.env.WOOCOMMERCE_WHOLESALE_ENABLED = 'true';
  process.env.WOOCOMMERCE_WHOLESALE_URL = WHOLESALE_URL;
  process.env.WOOCOMMERCE_WHOLESALE_CK = 'ck_wholesale_teste';
  process.env.WOOCOMMERCE_WHOLESALE_CS = 'cs_wholesale_teste';
  process.env.WOOCOMMERCE_WHOLESALE_EMPRESA_ID = String(empresaId);
}

function limparLojas() {
  for (const k of Object.keys(process.env)) if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];
}

let empresaSeq = 0;
function novaEmpresa(): number {
  empresaSeq += 1;
  return 5000 + empresaSeq;
}

let seq = 0;
async function novoProduto(empresaId: number, dados: Record<string, unknown> = {}) {
  seq++;
  return getStore().insert(RESOURCES.produtos, {
    empresa_id: empresaId,
    sku: String(dados.sku ?? `A07-${empresaId}-${seq}`),
    nome: dados.nome ?? `Produto A07 ${seq}`,
    preco_venda: dados.preco_venda ?? 100,
    preco_atacado: dados.preco_atacado ?? 60,
    exibir_site: true,
    ativo: true,
    ...dados,
  });
}

async function novoTamanho(codigo: string) {
  const existente = await getStore().findOneWhere(RESOURCES.tamanhos, { codigo });
  if (existente) return existente;
  return getStore().insert(RESOURCES.tamanhos, { codigo, ordem: 1 });
}

async function localPadrao(empresaId: number) {
  const s = getStore();
  let local = await s.findOneWhere(RESOURCES.locais, { empresa_id: empresaId, padrao: true });
  if (!local) local = await s.insert(RESOURCES.locais, { empresa_id: empresaId, nome: `loja-${empresaId}`, tipo: 'loja', ativo: true, padrao: true });
  return local;
}

async function inserirSaldo(empresaId: number, produtoId: number, tamanhoId: number, quantidade: number) {
  const local = await localPadrao(empresaId);
  return getStore().insert(RESOURCES.estoques, {
    empresa_id: empresaId,
    produto_id: produtoId,
    tamanho_id: tamanhoId,
    local: String(local.nome),
    local_id: Number(local.id),
    quantidade,
  });
}

async function inserirReserva(
  empresaId: number,
  produtoId: number,
  tamanhoId: number,
  quantidade: number,
  tipo: 'reserva' | 'empenho' | 'bloqueio' = 'reserva'
) {
  const local = await localPadrao(empresaId);
  return getStore().insert(RESOURCES.estoque_reservas, {
    empresa_id: empresaId,
    produto_id: produtoId,
    tamanho_id: tamanhoId,
    local_id: Number(local.id),
    tipo,
    quantidade,
    status: 'ativa',
    motivo: 'teste A07',
  });
}

function pedidoWoo(id: number, linhas: { sku: string; quantidade?: number; preco?: number; tamanho?: string }[], extra: Record<string, unknown> = {}) {
  return {
    id,
    number: String(id),
    status: 'processing',
    date_created: '2026-10-01T10:00:00',
    total: String(linhas.reduce((s, l) => s + (l.preco ?? 0) * (l.quantidade ?? 1), 0)),
    shipping_total: '0',
    discount_total: '0',
    payment_method_title: 'Boleto',
    billing: { first_name: 'Cliente', last_name: `Woo${id}`, email: `c${id}@teste.com` },
    line_items: linhas.map((l) => ({
      sku: l.sku,
      name: l.sku,
      quantity: l.quantidade ?? 1,
      price: l.preco ?? 0,
      meta_data: l.tamanho ? [{ key: 'pa_tamanho', value: l.tamanho }] : [],
    })),
    ...extra,
  };
}

/** Última venda gravada com a referência dada (e seus itens). */
async function vendaComItens(pedidoCliente: string) {
  const s = getStore();
  const venda = await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: pedidoCliente });
  if (!venda) return { venda: null, itens: [] as any[] };
  const itens = (await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 100, filter: { venda_id: Number(venda.id) } })).rows;
  return { venda, itens };
}

beforeEach(() => limparLojas());
afterEach(() => limparLojas());

// ---------------------------------------------------------------------------
// A06-01 — AUTORIDADE DE PREÇO (ERP vence; remoto é evidência)
// ---------------------------------------------------------------------------
describe('A06-01 — autoridade de preço na importação', () => {
  test('decidirPrecoItem: remoto divergente NUNCA vence o oficial; evidência preservada', () => {
    const r = decidirPrecoItem({ precoErp: 60, fonte: 'preco_atacado', precoRemoto: 1 });
    assert.equal(r.preco, 60, 'prevalece o ERP');
    assert.equal(r.preco_remoto, 1, 'remoto preservado como evidência');
    assert.equal(r.divergente, true);
    assert.equal(r.origem, 'erp');
  });

  test('decidirPrecoItem: preço igual não é divergência; produto sem preço zera (pendente)', () => {
    const igual = decidirPrecoItem({ precoErp: 60, fonte: 'preco_atacado', precoRemoto: 60 });
    assert.equal(igual.preco, 60);
    assert.equal(igual.divergente, false);
    const semPreco = decidirPrecoItem({ precoErp: 0, fonte: 'preco_venda', precoRemoto: 99 });
    assert.equal(semPreco.preco, 0, 'sem preço no ERP o remoto NÃO é usado');
  });

  test('precoOficialDoErp: RETAIL usa preco_venda e WHOLESALE usa preco_atacado', async () => {
    const empresaId = novaEmpresa();
    const produto = await novoProduto(empresaId, { preco_venda: 90, preco_atacado: 55 });
    const retail = await precoOficialDoErp(empresaId, produto, 'RETAIL');
    const wholesale = await precoOficialDoErp(empresaId, produto, 'WHOLESALE');
    assert.equal(retail.preco, 90);
    assert.equal(retail.fonte, 'preco_venda');
    assert.equal(wholesale.preco, 55);
    assert.equal(wholesale.fonte, 'preco_atacado');
  });

  test('importação RETAIL com preço remoto divergente grava o preço do ERP e a evidência', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-RETAIL-PRECO', preco_venda: 80 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 5);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7001, [{ sku: 'A07-RETAIL-PRECO', quantidade: 2, preco: 1, tamanho: 'M' }])] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 1);
      const { itens } = await vendaComItens('WOO-RETAIL-7001');
      assert.equal(itens.length, 1);
      assert.equal(Number(itens[0].preco_unitario), 80, 'preço oficial do ERP (preco_venda)');
      assert.equal(Number(itens[0].preco_externo_recebido), 1, 'preço remoto preservado como evidência');
    } finally {
      restaurar();
    }
  });

  test('importação WHOLESALE divergente usa preco_atacado; cadastro do produto NÃO muda', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-WS-PRECO', preco_venda: 100, preco_atacado: 60 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7002, [{ sku: 'A07-WS-PRECO', quantidade: 3, preco: 1, tamanho: 'M' }])] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('WHOLESALE'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 1);
      const { itens } = await vendaComItens('WOO-WHOLESALE-7002');
      assert.equal(Number(itens[0].preco_unitario), 60, 'preço de atacado do ERP');
      assert.equal(Number(itens[0].preco_externo_recebido), 1);
      const depois = await getStore().get(RESOURCES.produtos, Number(produto.id));
      assert.equal(Number(depois?.preco_atacado), 60, 'importar NUNCA altera o cadastro do produto');
      assert.equal(Number(depois?.preco_venda), 100);
    } finally {
      restaurar();
    }
  });

  test('preço remoto IGUAL ao ERP não gera divergência nem altera o preço', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-IGUAL', preco_venda: 80 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 5);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7003, [{ sku: 'A07-IGUAL', quantidade: 1, preco: 80, tamanho: 'M' }])] : []));
    try {
      await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      const { itens } = await vendaComItens('WOO-RETAIL-7003');
      assert.equal(Number(itens[0].preco_unitario), 80);
      assert.equal(Number(itens[0].preco_externo_recebido), 80);
      const divergencias = await getStore().list(RESOURCES.woocommerce_reconciliacao_divergencias, {
        page: 1,
        pageSize: 50,
        filter: { empresa_id: empresaId, tipo: 'PRECO_REMOTO_DIVERGENTE' },
      });
      assert.equal(divergencias.total, 0, 'preço igual não registra divergência');
    } finally {
      restaurar();
    }
  });

  test('produto sem preço válido no ERP vira PENDENTE (não grava preço remoto)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await novoProduto(empresaId, { sku: 'A07-SEM-PRECO', preco_venda: 0, preco_atacado: 0 });
    const tamanho = await novoTamanho('M');
    void tamanho;
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7004, [{ sku: 'A07-SEM-PRECO', quantidade: 1, preco: 50 }])] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 0);
      assert.equal(r.pendentes.length, 1);
      assert.equal((await vendaComItens('WOO-RETAIL-7004')).venda, null, 'nenhuma venda com preço inventado');
    } finally {
      restaurar();
    }
  });

  test('reprocessamento é idempotente: reimportar não cria segunda venda nem duplica item', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-IDEM', preco_venda: 80 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 5);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7005, [{ sku: 'A07-IDEM', quantidade: 1, preco: 1, tamanho: 'M' }])] : []));
    try {
      const cfg = exigirConfigStore('RETAIL');
      await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      const segunda = await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      assert.equal(segunda.importados.length, 0);
      assert.equal(segunda.ignorados.length, 1);
      const vendas = await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { pedido_cliente: 'WOO-RETAIL-7005' } });
      assert.equal(vendas.total, 1);
      const { itens } = await vendaComItens('WOO-RETAIL-7005');
      assert.equal(itens.length, 1, 'item não duplicado');
    } finally {
      restaurar();
    }
  });
});

// ---------------------------------------------------------------------------
// A06-11 — MÍNIMO DE ATACADO: enforcement no BACKEND do ERP
// ---------------------------------------------------------------------------
describe('A06-11 — enforcement do mínimo de atacado', () => {
  test('validarMinimoAtacado: só WHOLESALE, abaixo do mínimo, sem exceção', () => {
    const produto = { sku: 'X', atacado_min_qtd: 10 } as any;
    assert.match(String(validarMinimoAtacado('WHOLESALE', produto, 2)), /abaixo do mínimo/i);
    assert.equal(validarMinimoAtacado('WHOLESALE', produto, 10), null, 'no mínimo passa');
    assert.equal(validarMinimoAtacado('WHOLESALE', produto, 11), null, 'acima passa');
    assert.equal(validarMinimoAtacado('RETAIL', produto, 1), null, 'varejo não tem mínimo de atacado');
    assert.equal(validarMinimoAtacado('WHOLESALE', produto, 2, { autorizada: true, motivo: 'negociado' }), null, 'exceção auditada');
    assert.equal(minimoAtacado(produto), 10);
  });

  test('pedido WHOLESALE abaixo do mínimo é recusado e a rejeição fica registrada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-MIN', preco_atacado: 60, atacado_min_qtd: 10 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 50);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7100, [{ sku: 'A07-MIN', quantidade: 2, preco: 60, tamanho: 'M' }])] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('WHOLESALE'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 0, 'nada é importado');
      assert.equal(r.pendentes.length, 1);
      assert.equal((await vendaComItens('WOO-WHOLESALE-7100')).venda, null);
      const divergencias = await getStore().list(RESOURCES.woocommerce_reconciliacao_divergencias, {
        page: 1,
        pageSize: 50,
        filter: { empresa_id: empresaId, tipo: 'ATACADO_ABAIXO_MINIMO' },
      });
      assert.equal(divergencias.total, 1, 'rejeição registrada para conferência');
    } finally {
      restaurar();
    }
  });

  test('pedido WHOLESALE no mínimo e acima é aceito; RETAIL não é afetado pelo mínimo', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-MIN-OK', preco_venda: 100, preco_atacado: 60, atacado_min_qtd: 10 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 50);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7101, [{ sku: 'A07-MIN-OK', quantidade: 10, preco: 60, tamanho: 'M' }])] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('WHOLESALE'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 1, 'no mínimo passa');
    } finally {
      restaurar();
    }
    const { restaurar: r2 } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7102, [{ sku: 'A07-MIN-OK', quantidade: 1, preco: 100, tamanho: 'M' }])] : []));
    try {
      const rr = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(rr.importados.length, 1, 'varejo vende 1 unidade sem mínimo de atacado');
    } finally {
      r2();
    }
  });
});

// ---------------------------------------------------------------------------
// A06-03 — IDENTIDADE DE PEDIDO POR LOJA (sem colisão entre lojas)
// ---------------------------------------------------------------------------
describe('A06-03 — identidade de pedido por loja', () => {
  test('referência é única por loja e independe do número externo', () => {
    assert.equal(referenciaPedido('RETAIL', 777), 'WOO-RETAIL-777');
    assert.equal(referenciaPedido('WHOLESALE', 777), 'WOO-WHOLESALE-777');
    assert.notEqual(referenciaPedido('RETAIL', 777), referenciaPedido('WHOLESALE', 777));
  });

  test('o MESMO id externo (777) nas duas lojas gera DUAS vendas', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-777', preco_venda: 90, preco_atacado: 55 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(777, [{ sku: 'A07-777', quantidade: 1, preco: 90, tamanho: 'M' }])] : []));
    try {
      const r1 = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      const r2 = await importarPedidosDaLoja(exigirConfigStore('WHOLESALE'), empresaId, { dias: 7 });
      assert.equal(r1.importados.length, 1);
      assert.equal(r2.importados.length, 1, 'a WHOLESALE importa o próprio 777');
      assert.notEqual(r1.importados[0].venda_id, r2.importados[0].venda_id);
    } finally {
      restaurar();
    }
  });

  test('referência LEGADA da outra loja NÃO suprime o pedido (conflito registrado)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-CONFLITO', preco_venda: 90, preco_atacado: 55 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const s = getStore();
    const cliente = await s.insert(RESOURCES.clientes, { empresa_id: empresaId, nome: 'Cliente Legado', ativo: true });
    // Venda LEGADA da RETAIL (canal por loja explícito) com referência WOO-888.
    await s.insert(RESOURCES.vendas, {
      empresa_id: empresaId,
      cliente_id: Number(cliente.id),
      data: '2026-09-01',
      status: 'cotacao',
      canal_venda: 'site_varejo',
      pedido_cliente: 'WOO-888',
      pedido_externo_canal: 'WOOCOMMERCE_RETAIL',
      pedido_externo_id: '888',
    });
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(888, [{ sku: 'A07-CONFLITO', quantidade: 1, preco: 55, tamanho: 'M' }])] : []));
    try {
      // A WHOLESALE recebe o MESMO número 888: não pode ser suprimida pela legada da RETAIL.
      const r = await importarPedidosDaLoja(exigirConfigStore('WHOLESALE'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 1, 'pedido legítimo da WHOLESALE é importado');
      assert.ok(await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-WHOLESALE-888' }));
      const conflitos = await s.list(RESOURCES.woocommerce_reconciliacao_divergencias, {
        page: 1,
        pageSize: 50,
        filter: { empresa_id: empresaId, tipo: 'IDENTIDADE_PEDIDO_CONFLITANTE' },
      });
      assert.equal(conflitos.total, 1, 'o conflito de identidade fica registrado');
    } finally {
      restaurar();
    }
  });

  test('referência LEGADA da MESMA loja é adotada (não cria segunda venda)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-LEG-SAME', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const s = getStore();
    const cliente = await s.insert(RESOURCES.clientes, { empresa_id: empresaId, nome: 'Cliente Legado 2', ativo: true });
    await s.insert(RESOURCES.vendas, {
      empresa_id: empresaId,
      cliente_id: Number(cliente.id),
      data: '2026-09-01',
      status: 'cotacao',
      canal_venda: 'site_varejo',
      pedido_cliente: 'WOO-999',
      pedido_externo_canal: 'WOOCOMMERCE_RETAIL',
      pedido_externo_id: '999',
    });
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(999, [{ sku: 'A07-LEG-SAME', quantidade: 1, preco: 90, tamanho: 'M' }])] : []));
    try {
      await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      // A legada da MESMA loja é ADOTADA: nenhuma segunda venda é criada.
      assert.equal(await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-999' }), null, 'não cria uma segunda venda');
      const vendas = await s.list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
      assert.equal(vendas.total, 1, 'continua havendo UMA venda para o pedido 999');
      // O item que faltava na venda legada foi reconciliado (mesma venda).
      const legada = await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-999' });
      const itens = await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 50, filter: { venda_id: Number(legada!.id) } });
      assert.equal(itens.total, 1, 'o item do pedido foi anexado à venda legada');
    } finally {
      restaurar();
    }
  });

  test('referência LEGADA AMBÍGUA (sem canal) não é associada automaticamente', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'A07-AMB', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const s = getStore();
    const cliente = await s.insert(RESOURCES.clientes, { empresa_id: empresaId, nome: 'Cliente Ambíguo', ativo: true });
    await s.insert(RESOURCES.vendas, {
      empresa_id: empresaId,
      cliente_id: Number(cliente.id),
      data: '2026-09-01',
      status: 'cotacao',
      canal_venda: '',
      pedido_cliente: 'WOO-321',
      pedido_externo_id: '321',
    });
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(321, [{ sku: 'A07-AMB', quantidade: 1, preco: 90, tamanho: 'M' }])] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 1, 'origem ambígua NÃO suprime o pedido');
      const conflitos = await s.list(RESOURCES.woocommerce_reconciliacao_divergencias, {
        page: 1,
        pageSize: 50,
        filter: { empresa_id: empresaId, tipo: 'IDENTIDADE_PEDIDO_CONFLITANTE' },
      });
      assert.equal(conflitos.total, 1, 'ambiguidade registrada para conferência humana');
    } finally {
      restaurar();
    }
  });
});

// ---------------------------------------------------------------------------
// A06-04 — ESTOQUE DE VARIAÇÃO (saldo no pai + tamanho)
// ---------------------------------------------------------------------------
describe('A06-04 — estoque de variação pelo vínculo canônico', () => {
  test('variação herda o saldo do PAI + tamanho (não publica zero)', async () => {
    const empresaId = novaEmpresa();
    const pai = await novoProduto(empresaId, { sku: 'A07-PAI', formato: 'variacao', preco_venda: 200, preco_atacado: 150 });
    const tamanhoM = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(pai.id), Number(tamanhoM.id), 12);
    const filho = await getStore().insert(RESOURCES.produtos, {
      empresa_id: empresaId,
      sku: 'A07-PAI-M',
      nome: 'Variação M',
      produto_pai_id: Number(pai.id),
      variacao_tamanho_id: Number(tamanhoM.id),
      preco_venda: 199,
      preco_atacado: 149,
      exibir_site: true,
      ativo: true,
    });
    const escopo = escopoDeSistema(empresaId);
    const disponivelFilho = await disponivelDoProdutoVendavel(escopo, filho);
    assert.equal(disponivelFilho, 12, 'o filho resolve o saldo do pai + tamanho');
    const linhasPai = await disponibilidadesPorTamanho(escopo, Number(pai.id));
    const linhaM = linhasPai.find((l) => Number(l.tamanho_id) === Number(tamanhoM.id));
    assert.equal(Number(linhaM?.disponivel), 12);
  });

  test('múltiplas variações do mesmo pai resolvem cada uma o SEU tamanho (sem duplicar)', async () => {
    const empresaId = novaEmpresa();
    const pai = await novoProduto(empresaId, { sku: 'A07-PAI2', formato: 'variacao', preco_venda: 200 });
    const p = await novoTamanho('P');
    const g = await novoTamanho('G');
    await inserirSaldo(empresaId, Number(pai.id), Number(p.id), 4);
    await inserirSaldo(empresaId, Number(pai.id), Number(g.id), 9);
    const escopo = escopoDeSistema(empresaId);
    const filhoP = await getStore().insert(RESOURCES.produtos, { empresa_id: empresaId, sku: 'A07-PAI2-P', nome: 'Var P', produto_pai_id: Number(pai.id), variacao_tamanho_id: Number(p.id), preco_venda: 200, ativo: true, exibir_site: true });
    const filhoG = await getStore().insert(RESOURCES.produtos, { empresa_id: empresaId, sku: 'A07-PAI2-G', nome: 'Var G', produto_pai_id: Number(pai.id), variacao_tamanho_id: Number(g.id), preco_venda: 200, ativo: true, exibir_site: true });
    assert.equal(await disponivelDoProdutoVendavel(escopo, filhoP), 4);
    assert.equal(await disponivelDoProdutoVendavel(escopo, filhoG), 9);
  });

  test('reserva ativa reduz o disponível da variação (não publica físico comprometido)', async () => {
    const empresaId = novaEmpresa();
    const pai = await novoProduto(empresaId, { sku: 'A07-PAI3', formato: 'variacao', preco_venda: 200 });
    const tamanhoM = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(pai.id), Number(tamanhoM.id), 10);
    await inserirReserva(empresaId, Number(pai.id), Number(tamanhoM.id), 8);
    const filho = await getStore().insert(RESOURCES.produtos, { empresa_id: empresaId, sku: 'A07-PAI3-M', nome: 'Var M', produto_pai_id: Number(pai.id), variacao_tamanho_id: Number(tamanhoM.id), preco_venda: 200, ativo: true, exibir_site: true });
    assert.equal(await disponivelDoProdutoVendavel(escopoDeSistema(empresaId), filho), 2, '10 físico − 8 reservado');
  });
});

// ---------------------------------------------------------------------------
// A06-02 — DISPONÍVEL VENDÁVEL (não publica físico reservado)
// ---------------------------------------------------------------------------
describe('A06-02 — disponível vendável = físico − reservas/empenhos/bloqueios', () => {
  test('reserva, empenho e bloqueio reduzem o disponível publicado', async () => {
    const empresaId = novaEmpresa();
    const produto = await novoProduto(empresaId, { sku: 'A07-DISP', preco_venda: 100 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 10);
    await inserirReserva(empresaId, Number(produto.id), Number(tamanho.id), 3, 'reserva');
    await inserirReserva(empresaId, Number(produto.id), Number(tamanho.id), 2, 'empenho');
    await inserirReserva(empresaId, Number(produto.id), Number(tamanho.id), 1, 'bloqueio');
    assert.equal(await disponivelDoProdutoVendavel(escopoDeSistema(empresaId), produto), 4, '10 − 3 − 2 − 1');
  });

  test('estoque totalmente reservado publica 0 (nunca o físico)', async () => {
    const empresaId = novaEmpresa();
    const produto = await novoProduto(empresaId, { sku: 'A07-DISP0', preco_venda: 100 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 10);
    await inserirReserva(empresaId, Number(produto.id), Number(tamanho.id), 10);
    assert.equal(await disponivelDoProdutoVendavel(escopoDeSistema(empresaId), produto), 0);
  });
});

// ---------------------------------------------------------------------------
// A06-12 — commerce_precos COM ESCOPO DE LOJA
// ---------------------------------------------------------------------------
describe('A06-12 — override de preço independente por loja', () => {
  test('override RETAIL não vaza para a WHOLESALE (e vice-versa)', async () => {
    const empresaId = novaEmpresa();
    const produto = await novoProduto(empresaId, { sku: 'A07-OVR', preco_venda: 100, preco_atacado: 60 });
    const s = getStore();
    await s.insert(RESOURCES.commerce_precos, { empresa_id: empresaId, produto_id: Number(produto.id), canal: 'WOOCOMMERCE', store_key: 'RETAIL', preco: 77 });
    const { linhaOverrideDaLoja } = await import('../src/commerce/woocommerce/precoAutoridade');
    const linhaRetail = await linhaOverrideDaLoja(empresaId, Number(produto.id), 'WOOCOMMERCE', 'RETAIL');
    const linhaWholesale = await linhaOverrideDaLoja(empresaId, Number(produto.id), 'WOOCOMMERCE', 'WHOLESALE');
    assert.equal(Number(linhaRetail?.preco), 77);
    assert.equal(linhaWholesale, null, 'a WHOLESALE não herda o override da RETAIL');
    assert.equal(precoDaLoja(produto, 'RETAIL', linhaRetail).preco, 77);
    assert.equal(precoDaLoja(produto, 'WHOLESALE', linhaWholesale).preco, 60, 'atacado usa a base');
  });

  test('salvarPrecoCanal aceita store_key só no canal WOOCOMMERCE e persiste separado', async () => {
    const empresaId = novaEmpresa();
    const produto = await novoProduto(empresaId, { sku: 'A07-OVR2', preco_venda: 100, preco_atacado: 60 });
    const actor = { id: null, name: 'Teste', perfil: 'admin' as const, empresa_id: empresaId, empresas: [empresaId] };
    const chamar = async (body: Record<string, unknown>) => {
      const saida: any = {};
      const res: any = { json: (d: any) => ((saida.json = d), res), status: (s: number) => ((saida.status = s), res) };
      await salvarPrecoCanal({ body, params: { id: String(produto.id) }, user: actor, headers: {}, query: {} } as any, res);
      return saida;
    };
    await chamar({ canal: 'WOOCOMMERCE', preco: 88, store_key: 'RETAIL' });
    await chamar({ canal: 'WOOCOMMERCE', preco: 44, store_key: 'WHOLESALE' });
    const linhas = await getStore().list(RESOURCES.commerce_precos, { page: 1, pageSize: 50, filter: { empresa_id: empresaId, produto_id: Number(produto.id) } });
    const porLoja = new Map(linhas.rows.map((l) => [String(l.store_key), Number(l.preco)]));
    assert.equal(porLoja.get('RETAIL'), 88);
    assert.equal(porLoja.get('WHOLESALE'), 44);
    await assert.rejects(() => chamar({ canal: 'MERCADOLIVRE', preco: 10, store_key: 'RETAIL' }), /WOOCOMMERCE/i);
    await assert.rejects(() => chamar({ canal: 'WOOCOMMERCE', preco: 10, store_key: 'LOJA1' }), /Loja inválida/i);
  });
});

// ---------------------------------------------------------------------------
// A06-13 — RECONCILIAÇÃO DE ITEM AUSENTE NA IMPORTAÇÃO PARCIAL
// ---------------------------------------------------------------------------
describe('A06-13 — reconciliação de itens ausentes', () => {
  test('primeira importação parcial + SKU cadastrado depois: reimportar RECOMPÕE o item', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const ok = await novoProduto(empresaId, { sku: 'A07-OK', preco_venda: 80 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(ok.id), Number(tamanho.id), 10);
    const cfg = exigirConfigStore('RETAIL');
    const { restaurar } = espionar((url) =>
      url.includes('/orders?')
        ? [pedidoWoo(7300, [{ sku: 'A07-OK', quantidade: 1, preco: 80, tamanho: 'M' }, { sku: 'A07-FALTAVA', quantidade: 2, preco: 30, tamanho: 'M' }])]
        : []
    );
    try {
      const primeira = await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      assert.equal(primeira.importados.length, 1);
      assert.equal(primeira.pendentes.length, 1, 'o item sem SKU ficou pendente');
      let { itens } = await vendaComItens('WOO-RETAIL-7300');
      assert.equal(itens.length, 1, 'só o item resolvido entrou');

      // O SKU que faltava é cadastrado e o pedido é reprocessado.
      const novo = await novoProduto(empresaId, { sku: 'A07-FALTAVA', preco_venda: 30 });
      await inserirSaldo(empresaId, Number(novo.id), Number(tamanho.id), 10);
      const segunda = await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      assert.equal(segunda.importados.length, 1, 'a venda existente é reconciliada (item adicionado)');
      ({ itens } = await vendaComItens('WOO-RETAIL-7300'));
      assert.equal(itens.length, 2, 'o item que faltava foi adicionado, sem duplicar o existente');
      assert.ok(itens.some((i) => Number(i.produto_id) === Number(novo.id)));
    } finally {
      restaurar();
    }
  });

  test('venda JÁ FATURADA não é reconciliada (histórico financeiro congelado)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const ok = await novoProduto(empresaId, { sku: 'A07-FAT', preco_venda: 80 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(ok.id), Number(tamanho.id), 10);
    const cfg = exigirConfigStore('RETAIL');
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(7400, [{ sku: 'A07-FAT', quantidade: 1, preco: 80, tamanho: 'M' }])] : []));
    try {
      await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      const venda = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-7400' });
      await getStore().update(RESOURCES.vendas, Number(venda!.id), { status: 'faturada' });
      const segunda = await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      assert.equal(segunda.importados.length, 0, 'venda faturada não é tocada');
      assert.equal(segunda.ignorados.length, 1);
    } finally {
      restaurar();
    }
  });
});

// ---------------------------------------------------------------------------
// A06-05 — VENDAS WOO NO BI (projeção operacional → analítica)
// ---------------------------------------------------------------------------
describe('A06-05 — venda Woo importada aparece no BI', () => {
  test('venda com pedido_externo_id (Woo) é projetada; venda de marketplace com sales própria não é', async () => {
    const empresaId = novaEmpresa();
    const s = getStore();
    const produto = await novoProduto(empresaId, { sku: 'A07-BI', preco_venda: 100 });
    const tamanho = await novoTamanho('M');
    const cliente = await s.insert(RESOURCES.clientes, { empresa_id: empresaId, nome: 'Cliente BI', ativo: true });
    // Venda importada do Woo: tem pedido_externo_id, NÃO tem linha em sales.
    const vendaWoo = await s.insert(RESOURCES.vendas, {
      empresa_id: empresaId,
      cliente_id: Number(cliente.id),
      data: '2026-10-01',
      status: 'faturada',
      canal_venda: 'site_varejo',
      pedido_cliente: 'WOO-RETAIL-8800',
      pedido_externo_canal: 'WOOCOMMERCE_RETAIL',
      pedido_externo_id: '8800',
      total: 100,
    });
    await s.insert(RESOURCES.itens_venda, {
      empresa_id: empresaId,
      venda_id: Number(vendaWoo.id),
      produto_id: Number(produto.id),
      tamanho_id: Number(tamanho.id),
      quantidade: 1,
      preco_unitario: 100,
      desconto_pct: 0,
      subtotal: 100,
    });
    // Venda de marketplace JÁ representada por uma `sales` própria (operational_venda_id).
    const vendaMkt = await s.insert(RESOURCES.vendas, {
      empresa_id: empresaId,
      cliente_id: Number(cliente.id),
      data: '2026-10-01',
      status: 'faturada',
      canal_venda: 'marketplace',
      pedido_externo_id: 'ML-1',
      total: 100,
    });
    await s.insert(RESOURCES.sales, {
      id: 'mkt:1',
      empresa_id: empresaId,
      status: 'PAID',
      channel: 'MERCADOLIVRE',
      operational_venda_id: Number(vendaMkt.id),
      amount_cents: 10000,
      quantity: 1,
      currency: 'BRL',
      occurred_at: '2026-10-01T00:00:00Z',
    });

    const res = await projetarVendasErp([Number(vendaWoo.id), Number(vendaMkt.id)]);
    assert.ok(res.idsProjetados.includes(`erp:venda:${Number(vendaWoo.id)}`), 'a venda Woo é projetada no BI');
    assert.ok(!res.idsProjetados.includes(`erp:venda:${Number(vendaMkt.id)}`), 'a venda de marketplace já representada NÃO é duplicada');
  });
});

// ---------------------------------------------------------------------------
// A06-14 (leve) — o mínimo de atacado não regride a autoridade de preço
// ---------------------------------------------------------------------------
describe('A06 — coerência entre mínimo de atacado e autoridade de preço', () => {
  test('WHOLESALE abaixo do mínimo não grava venda nem preço remoto', async () => {
    const empresaId = novaEmpresa();
    const produto = await novoProduto(empresaId, { sku: 'A07-COER', preco_atacado: 60, atacado_min_qtd: 5 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 10);
    const ctx = await carregarContextoImportacao(empresaId);
    const cfg = { store_key: 'WHOLESALE' as const, url: WHOLESALE_URL, ck: 'ck', cs: 'cs', empresaId, fontePreco: 'preco_atacado' as const, canal: 'site_atacado' as const };
    const desfecho = await importarUmPedido(cfg, ctx, pedidoWoo(7500, [{ sku: 'A07-COER', quantidade: 1, preco: 60, tamanho: 'M' }]) as any);
    assert.equal(desfecho.tipo, 'pendente');
    assert.equal((await vendaComItens('WOO-WHOLESALE-7500')).venda, null);
  });
});
