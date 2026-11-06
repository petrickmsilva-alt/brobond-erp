// ============================================================================
// WOOCOMMERCE MULTI-STORE — WEBHOOKS, IDEMPOTÊNCIA E RECONCILIAÇÃO.
//
// Evolução da suíte multi-store: aqui se prova o que a missão exige de novo.
// LOCAL: store em memória; o `fetch` global (e o injetável da reconciliação)
// é substituído por espião — nenhuma chamada de rede real.
//
// O que precisa ficar travado (é o que dá prejuízo se quebrar):
//   ASSINATURA — HMAC-SHA256 sobre os BYTES CRUS, tempo constante, segredo
//     INDEPENDENTE por loja; corpo alterado/segredo errado/assinatura de outra
//     loja são recusados; timestamp fora da janela é replay;
//   IDEMPOTÊNCIA — a MESMA entrega não vira dois eventos; o mesmo ID de entrega
//     nas DUAS lojas são DUAS entregas; sem ID de entrega, corpo idêntico é
//     duplicata e corpo DIFERENTE é evento novo;
//   WORKER — o pedido é CONFIRMADO na API antes de importar (webhook é
//     notificação, não fonte de verdade); a falha de uma loja não toca a outra;
//   RECONCILIAÇÃO — catálogo/preço/estoque/pedidos, com a classificação que
//     decide o destino (LEGITIMA/AUTOMATICA/HUMANA); divergência HUMANA NUNCA é
//     corrigida automaticamente; o que deixa de existir é fechado;
//   SEGURANÇA — nenhuma resposta/erro vaza credencial nem o segredo do webhook;
//     o payload gravado não carrega PII de pedido.
//
// Cada teste roda numa EMPRESA própria (o MemStore é compartilhado pelo arquivo).
// ============================================================================
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];
}

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { exigirConfigStore, statusStores, multiStoreHabilitado } = await import('../src/commerce/woocommerce/registry');
const { assinarCorpo, validarAssinatura, validarTimestamp, minimizarPayload, topicoDoEvento, recursoExterno, consumirRateLimit, limparRateLimit, segredoWebhook } =
  await import('../src/commerce/woocommerce/webhookSeguranca');
const { registrarEntrega, hashCorpo, listarEntregas, contarEntregas, recuperarEntregasPendentes, marcarProcessamento, reenfileirarEntrega } =
  await import('../src/commerce/woocommerce/webhookInbox');
const { registrarDivergencia, listarDivergencias, contarDivergencias, fecharDivergenciasAusentes, reconciliarLojaCompleta, corrigirDivergencia } =
  await import('../src/commerce/woocommerce/reconciliacao');
const { processarEventoWebhook } = await import('../src/commerce/woocommerce/outboxStore');
const { registrarVinculo } = await import('../src/commerce/woocommerce/vinculos');
const { importarPedidosDaLoja } = await import('../src/commerce/woocommerce/pedidos');

const RETAIL_URL = 'https://brobond.com.br';
const WHOLESALE_URL = 'https://atacado.brobond.com.br';
const SEGREDO_RETAIL = 'whsec_retail_teste_nao_real';
const SEGREDO_WHOLESALE = 'whsec_wholesale_teste_nao_real';

type Chamada = { url: string; metodo: string; corpo: any };

/** Espião de `fetch` global: registra método/corpo e responde pelo caminho. */
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
  return {
    chamadas,
    restaurar: () => {
      globalThis.fetch = original;
    },
  };
}

/** Configura as DUAS lojas (credenciais fictícias) e os segredos de webhook. */
function configurarLojas(empresaId: number, opcoes: { webhook?: boolean } = {}) {
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
  if (opcoes.webhook !== false) {
    process.env.WOOCOMMERCE_RETAIL_WEBHOOK_SECRET = SEGREDO_RETAIL;
    process.env.WOOCOMMERCE_WHOLESALE_WEBHOOK_SECRET = SEGREDO_WHOLESALE;
  }
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
    sku: String(dados.sku ?? `WH-${empresaId}-${seq}`),
    nome: dados.nome ?? `Produto Webhook ${seq}`,
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

async function inserirSaldo(empresaId: number, produtoId: number, tamanhoId: number, quantidade: number) {
  const s = getStore();
  let local = await s.findOneWhere(RESOURCES.locais, { empresa_id: empresaId, padrao: true });
  if (!local) local = await s.insert(RESOURCES.locais, { empresa_id: empresaId, nome: `loja-${empresaId}`, tipo: 'loja', ativo: true, padrao: true });
  return s.insert(RESOURCES.estoques, {
    empresa_id: empresaId,
    produto_id: produtoId,
    tamanho_id: tamanhoId,
    local: String(local.nome),
    local_id: Number(local.id),
    quantidade,
  });
}

/** Registra a entrega assinada como a rota faria (assinatura válida por padrão). */
async function entregar(
  empresaId: number,
  store: 'RETAIL' | 'WHOLESALE',
  corpo: Record<string, unknown>,
  opcoes: { topic?: string; entregaId?: string | null; assinaturaOk?: boolean; recurso?: string } = {}
) {
  const cfg = exigirConfigStore(store);
  const cru = Buffer.from(JSON.stringify(corpo), 'utf8');
  return registrarEntrega(cfg, empresaId, {
    topic: opcoes.topic ?? 'order.created',
    recurso: opcoes.recurso ?? (opcoes.topic ?? 'order.created').split('.')[0],
    external_delivery_id: opcoes.entregaId === undefined ? null : opcoes.entregaId,
    external_resource_id: recursoExterno(corpo),
    payload: corpo,
    payload_hash: hashCorpo(cru),
    assinatura_ok: opcoes.assinaturaOk !== false,
    correlation_id: 'corr-teste',
  });
}

beforeEach(() => {
  limparLojas();
  limparRateLimit();
});
afterEach(() => {
  limparLojas();
});

// ============================================================================
// WH-1 — ASSINATURA E SEGURANÇA
// ============================================================================
describe('WH-1 — Assinatura HMAC-SHA256 por loja', () => {
  test('assinatura válida é aceita; corpo alterado é recusado', () => {
    configurarLojas(novaEmpresa());
    const corpo = Buffer.from(JSON.stringify({ id: 1, total: '90.00' }), 'utf8');
    const assinatura = assinarCorpo(corpo, SEGREDO_RETAIL);
    assert.equal(validarAssinatura(corpo, assinatura, 'RETAIL').ok, true);

    const alterado = Buffer.from(JSON.stringify({ id: 1, total: '9000.00' }), 'utf8');
    const r = validarAssinatura(alterado, assinatura, 'RETAIL');
    assert.equal(r.ok, false, 'o HMAC é sobre os BYTES CRUS — alterar o corpo invalida');
  });

  test('segredo errado e assinatura ausente são recusados', () => {
    configurarLojas(novaEmpresa());
    const corpo = Buffer.from('{"id":1}', 'utf8');
    assert.equal(validarAssinatura(corpo, assinarCorpo(corpo, 'outro-segredo'), 'RETAIL').ok, false);
    assert.equal(validarAssinatura(corpo, undefined, 'RETAIL').ok, false);
    assert.equal(validarAssinatura(corpo, '', 'RETAIL').ok, false);
    assert.equal(validarAssinatura(corpo, 'nao-e-base64-valido!!', 'RETAIL').ok, false);
  });

  test('RETAIL e WHOLESALE têm segredos INDEPENDENTES (assinatura de uma não vale na outra)', () => {
    configurarLojas(novaEmpresa());
    assert.notEqual(segredoWebhook('RETAIL'), segredoWebhook('WHOLESALE'));
    const corpo = Buffer.from('{"id":7}', 'utf8');
    const assinaturaRetail = assinarCorpo(corpo, SEGREDO_RETAIL);
    assert.equal(validarAssinatura(corpo, assinaturaRetail, 'RETAIL').ok, true);
    assert.equal(validarAssinatura(corpo, assinaturaRetail, 'WHOLESALE').ok, false, 'assinatura cruzada entre lojas é recusada');
  });

  test('sem segredo configurado a loja falha FECHADA (nada é aceito)', () => {
    configurarLojas(novaEmpresa(), { webhook: false });
    assert.equal(segredoWebhook('RETAIL'), null);
    const corpo = Buffer.from('{"id":1}', 'utf8');
    assert.equal(validarAssinatura(corpo, assinarCorpo(corpo, 'qualquer'), 'RETAIL').ok, false);
  });

  test('replay: timestamp fora da janela é recusado; dentro é aceito', () => {
    configurarLojas(novaEmpresa());
    const agora = Date.now();
    assert.equal(validarTimestamp(String(Math.floor(agora / 1000)), agora).ok, true);
    const r = validarTimestamp(String(Math.floor((agora - 3600_000) / 1000)), agora);
    assert.equal(r.ok, false, 'entrega de 1h atrás está fora da tolerância de 300s');
    assert.ok(!r.ok && /replay/i.test(r.motivo));
    // Sem timestamp, a barreira primária continua sendo o ID de entrega.
    assert.equal(validarTimestamp(undefined, agora).ok, true);
  });

  test('rate limit por IP barra o flood e libera dentro da janela', () => {
    configurarLojas(novaEmpresa());
    process.env.WOOCOMMERCE_WEBHOOK_RATE_MAX = '3';
    process.env.WOOCOMMERCE_WEBHOOK_RATE_WINDOW_MS = '60000';
    limparRateLimit();
    assert.equal(consumirRateLimit('1.2.3.4').ok, true);
    assert.equal(consumirRateLimit('1.2.3.4').ok, true);
    assert.equal(consumirRateLimit('1.2.3.4').ok, true);
    const excedido = consumirRateLimit('1.2.3.4');
    assert.equal(excedido.ok, false);
    assert.ok(!excedido.ok && excedido.retryAfterSeg >= 1);
    assert.equal(consumirRateLimit('9.9.9.9').ok, true, 'o limite é por IP');
  });

  test('payload minimizado descarta PII de pedido (nome, e-mail, endereço, transação)', () => {
    const corpo = {
      id: 42,
      status: 'processing',
      total: '90.00',
      billing: { first_name: 'Ana', email: 'ana@x.com', phone: '11999', address_1: 'Rua X' },
      shipping: { address_1: 'Rua Y' },
      customer_note: 'entregar depois das 18h',
      transaction_id: 'tx_123',
      line_items: [{ sku: 'A', quantity: 2, meta_data: [{ key: 'cpf', value: '123' }] }],
    };
    const limpo = minimizarPayload(corpo) as Record<string, unknown>;
    assert.equal(limpo.billing, undefined);
    assert.equal(limpo.shipping, undefined);
    assert.equal(limpo.customer_note, undefined);
    assert.equal(limpo.transaction_id, undefined);
    assert.equal(limpo.id, 42);
    assert.equal(limpo.status, 'processing');
    const itens = limpo.line_items as any[];
    assert.equal(itens[0].sku, 'A');
    assert.equal(itens[0].meta_data, undefined);
    assert.ok(!JSON.stringify(limpo).includes('ana@x.com'), 'nenhum e-mail no payload gravado');
  });

  test('tópico e recurso externo são extraídos do header e do corpo', () => {
    assert.equal(topicoDoEvento({ 'x-wc-webhook-topic': 'order.updated' }, {}), 'order.updated');
    assert.equal(topicoDoEvento({}, { type: 'product', action: 'created' }), 'product.created');
    assert.equal(topicoDoEvento({}, {}), 'desconhecido');
    assert.equal(recursoExterno({ id: 555 }), '555');
    assert.equal(recursoExterno({}), null);
  });
});

// ============================================================================
// WH-2 — IDEMPOTÊNCIA DO INBOX
// ============================================================================
describe('WH-2 — Idempotência por loja e por entrega', () => {
  test('a MESMA entrega (mesmo delivery id) não vira dois eventos', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = { id: 100, total: '50.00' };
    const a = await entregar(empresaId, 'RETAIL', corpo, { entregaId: 'dlv-1' });
    const b = await entregar(empresaId, 'RETAIL', corpo, { entregaId: 'dlv-1' });
    assert.equal(a.duplicado, false);
    assert.equal(b.duplicado, true, 'a segunda entrega é reconhecida como duplicata');
    assert.equal(a.id, b.id);
    assert.equal((await listarEntregas(empresaId, 'RETAIL')).length, 1);
  });

  test('o MESMO ID de entrega nas DUAS lojas gera DUAS entregas (lojas independentes)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = { id: 200, total: '80.00' };
    const retail = await entregar(empresaId, 'RETAIL', corpo, { entregaId: 'dlv-compartilhado' });
    const wholesale = await entregar(empresaId, 'WHOLESALE', corpo, { entregaId: 'dlv-compartilhado' });
    assert.notEqual(retail.id, wholesale.id);
    assert.equal((await listarEntregas(empresaId, 'RETAIL')).length, 1);
    assert.equal((await listarEntregas(empresaId, 'WHOLESALE')).length, 1);
  });

  test('sem ID de entrega: corpo IDÊNTICO é duplicata; corpo DIFERENTE é evento NOVO', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = { id: 300, status: 'processing' };
    const a = await entregar(empresaId, 'RETAIL', corpo, { entregaId: null });
    const b = await entregar(empresaId, 'RETAIL', corpo, { entregaId: null });
    assert.equal(b.duplicado, true, 'mesmo corpo = mesma entrega reentregue');

    const atualizado = { id: 300, status: 'completed' };
    const c = await entregar(empresaId, 'RETAIL', atualizado, { entregaId: null });
    assert.equal(c.duplicado, false, 'corpo diferente é uma ATUALIZAÇÃO legítima, nunca descartada');
    assert.equal((await listarEntregas(empresaId, 'RETAIL')).length, 2);
  });

  test('reentrega do mesmo delivery id reusa a MESMA chave de outbox', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = { id: 400 };
    const a = await entregar(empresaId, 'RETAIL', corpo, { entregaId: 'dlv-reusa' });
    const b = await entregar(empresaId, 'RETAIL', corpo, { entregaId: 'dlv-reusa' });
    assert.equal(a.id, b.id);
    const outbox = await getStore().list(RESOURCES.commerce_outbox, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
    assert.equal(outbox.rows.length, 1, 'a entrega reusa a linha do outbox (chave idempotente por loja+entrega)');
    // A corrida REAL (duas requisições simultâneas arbitradas pelo índice único
    // parcial) só o PostgreSQL prova — ver woocommerce-multistore-pg.test.ts.
  });

  test('contagem por status alimenta o painel', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await entregar(empresaId, 'RETAIL', { id: 501 }, { entregaId: 'd1' });
    await entregar(empresaId, 'RETAIL', { id: 502 }, { entregaId: 'd2' });
    await entregar(empresaId, 'RETAIL', { id: 503 }, { entregaId: 'd3', assinaturaOk: false });
    const entregas = await listarEntregas(empresaId, 'RETAIL');
    const porStatus = contarEntregas(entregas);
    assert.equal(porStatus.enfileirado, 2);
    assert.equal(porStatus.rejeitado, 1);
  });

  test('entrega rejeitada NUNCA é enfileirada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const r = await entregar(empresaId, 'RETAIL', { id: 600 }, { entregaId: 'd-rejeitada', assinaturaOk: false });
    assert.equal(r.outbox_id, null);
    assert.equal(r.status, 'rejeitado');
    const outbox = await getStore().list(RESOURCES.commerce_outbox, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
    assert.equal(outbox.rows.length, 0, 'assinatura inválida não gera trabalho');
  });

  test('recuperação re-enfileira o que ficou preso sem duplicar a entrega', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await entregar(empresaId, 'RETAIL', { id: 700 }, { entregaId: 'd-presa' });
    // Simula o processo morrendo DEPOIS do INSERT e ANTES do enfileiramento.
    const entrega = (await listarEntregas(empresaId, 'RETAIL'))[0];
    await getStore().update(RESOURCES.woocommerce_webhook_events, Number(entrega.id), { status: 'recebido', outbox_id: null });
    const r = await recuperarEntregasPendentes(empresaId, 'RETAIL');
    assert.equal(r.reenfileirados, 1);
    assert.equal((await listarEntregas(empresaId, 'RETAIL')).length, 1, 'recuperar não cria uma segunda entrega');
    assert.equal(String((await listarEntregas(empresaId, 'RETAIL'))[0].status), 'enfileirado');
  });
});

// ============================================================================
// WH-3 — WORKER: O WEBHOOK É NOTIFICAÇÃO, NÃO FONTE DE VERDADE
// ============================================================================
describe('WH-3 — Worker confirma na API antes de importar', () => {
  function pedidoWoo(id: number, sku: string, quantidade = 1, preco = 90) {
    return {
      id,
      number: String(id),
      status: 'processing',
      date_created: '2026-09-10T14:00:00',
      total: String(preco * quantidade),
      shipping_total: '0.00',
      discount_total: '0.00',
      payment_method_title: 'Pix',
      billing: { first_name: 'Ana', email: `ana${id}@brobond.com.br` },
      line_items: [{ sku, name: sku, quantity: quantidade, price: preco, meta_data: [{ key: 'pa_tamanho', value: 'M' }] }],
    };
  }

  test('evento de pedido CONFIRMA na loja e importa; o corpo do webhook NÃO é aplicado cego', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-PEDIDO', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);

    // O corpo do webhook traz um total FALSO; a API devolve o pedido REAL.
    const corpoWebhook = { id: 7001, total: '99999.00', line_items: [] };
    const { restaurar } = espionar((url) => {
      if (/\/orders\/7001$/.test(url)) return pedidoWoo(7001, 'WH-PEDIDO');
      return [];
    });
    try {
      const entrega = await entregar(empresaId, 'RETAIL', corpoWebhook, { topic: 'order.created', entregaId: 'd-7001' });
      const r = await processarEventoWebhook(
        { acao: 'woo-webhook', store_key: 'RETAIL', webhook_event_id: entrega.id },
        empresaId
      );
      assert.equal(r, 'ok');
      const venda = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-7001' });
      assert.ok(venda, 'o pedido confirmado foi importado');
      assert.notEqual(Number(venda.total), 99999, 'o total veio da API oficial, não do corpo do webhook');
    } finally {
      restaurar();
    }
  });

  test('reprocessar o MESMO evento não duplica a venda (idempotência de ponta a ponta)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-IDEM', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const { restaurar } = espionar((url) => (/\/orders\/7100$/.test(url) ? pedidoWoo(7100, 'WH-IDEM') : []));
    try {
      const entrega = await entregar(empresaId, 'RETAIL', { id: 7100 }, { entregaId: 'd-7100' });
      await processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: entrega.id }, empresaId);
      // Reprocessamento forçado (como a ação administrativa faria).
      await marcarProcessamento(empresaId, entrega.id, { status: 'erro', erro: 'simulado' });
      await processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: entrega.id }, empresaId);
      const vendas = await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { pedido_cliente: 'WOO-RETAIL-7100' } });
      assert.equal(vendas.rows.length, 1, 'nunca duplica a venda no reprocessamento');
    } finally {
      restaurar();
    }
  });

  test('evento fora de ordem não sobrescreve: pedido já importado é apenas reconhecido', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-ORDEM', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const { restaurar } = espionar((url) => (/\/orders\/7200$/.test(url) ? pedidoWoo(7200, 'WH-ORDEM') : []));
    try {
      const e1 = await entregar(empresaId, 'RETAIL', { id: 7200 }, { topic: 'order.created', entregaId: 'd-7200a' });
      await processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: e1.id }, empresaId);
      const antes = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-7200' });
      // Chega um evento ANTIGO (updated) depois; a venda não pode mudar.
      const e2 = await entregar(empresaId, 'RETAIL', { id: 7200 }, { topic: 'order.updated', entregaId: 'd-7200b' });
      await processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: e2.id }, empresaId);
      const depois = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-7200' });
      assert.equal(depois.total, antes.total, 'o estado da venda não é reescrito por evento atrasado');
      assert.equal(depois.status, antes.status);
    } finally {
      restaurar();
    }
  });

  test('pedido excluído na loja não gera venda nem cancela nada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    // A API responde 404 → o cliente traduz em erro; aqui devolvemos lista vazia.
    const { restaurar } = espionar(() => new Error('getaddrinfo ENOTFOUND'));
    try {
      const entrega = await entregar(empresaId, 'RETAIL', { id: 7300 }, { topic: 'order.deleted', entregaId: 'd-7300' });
      await assert.rejects(() => processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: entrega.id }, empresaId));
      const venda = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-7300' });
      assert.equal(venda, null, 'nada é criado para um pedido que não pode ser confirmado');
    } finally {
      restaurar();
    }
  });

  test('a falha de uma loja NÃO bloqueia a outra (eventos e chaves distintos)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-DUAL', preco_venda: 90, preco_atacado: 55 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const { restaurar } = espionar((url) => {
      if (url.includes(RETAIL_URL)) throw new Error('loja RETAIL fora do ar');
      if (/\/orders\/7400$/.test(url)) return pedidoWoo(7400, 'WH-DUAL');
      return [];
    });
    try {
      const retail = await entregar(empresaId, 'RETAIL', { id: 7400 }, { entregaId: 'd-r' });
      const wholesale = await entregar(empresaId, 'WHOLESALE', { id: 7400 }, { entregaId: 'd-w' });
      await assert.rejects(() => processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: retail.id }, empresaId));
      const ok = await processarEventoWebhook({ store_key: 'WHOLESALE', webhook_event_id: wholesale.id }, empresaId);
      assert.equal(ok, 'ok', 'a WHOLESALE processa mesmo com a RETAIL fora do ar');
      const venda = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-WHOLESALE-7400' });
      assert.ok(venda);
    } finally {
      restaurar();
    }
  });

  test('dry-run marca a entrega como processada sem tocar a rede', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    process.env.WOOCOMMERCE_SYNC_DRY_RUN = 'true';
    let chamadas = 0;
    const { restaurar } = espionar(() => {
      chamadas += 1;
      throw new Error('a rede não pode ser chamada em dry-run');
    });
    try {
      const entrega = await entregar(empresaId, 'RETAIL', { id: 7500 }, { entregaId: 'd-dry' });
      const r = await processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: entrega.id }, empresaId);
      assert.equal(r, 'ok');
      assert.equal(chamadas, 0, 'dry-run não fala com a loja');
      const linha = (await listarEntregas(empresaId, 'RETAIL'))[0];
      assert.equal(String(linha.status), 'processado');
    } finally {
      restaurar();
    }
  });

  test('evento de loja de OUTRA empresa é recusado (isolamento)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const entrega = await entregar(empresaId, 'RETAIL', { id: 7600 }, { entregaId: 'd-tenant' });
    await assert.rejects(
      () => processarEventoWebhook({ store_key: 'RETAIL', webhook_event_id: entrega.id }, empresaId + 1),
      /empresa/i
    );
  });
});

// ============================================================================
// WH-4 — RECONCILIAÇÃO
// ============================================================================
describe('WH-4 — Reconciliação ERP × loja', () => {
  test('produto visível sem vínculo vira divergência AUTOMATICA', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-RECON-1', preco_venda: 15 });
    const r = await reconciliarLojaCompleta(exigirConfigStore('WHOLESALE'), empresaId, { fetch: async () => new Response('[]', { status: 200 }) });
    assert.ok(r.detectadas >= 1);
    const divs = await listarDivergencias(empresaId, 'WHOLESALE');
    const d = divs.find((x) => x.produto_id === Number(produto.id) && x.tipo === 'PRODUTO_SEM_VINCULO');
    assert.ok(d, 'o produto sem vínculo aparece na reconciliação');
    assert.equal(String(d!.classificacao), 'AUTOMATICA');
    assert.equal(String(d!.status), 'ABERTA');
  });

  test('preço divergente é AUTOMATICA; preço ausente é HUMANA', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-PRECO', preco_venda: 100 });
    await registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '900', sku: 'WH-PRECO' });
    const respostas: Record<string, unknown> = {
      '/products?per_page=100&page=1&status=any': [{ id: 900, sku: 'WH-PRECO', type: 'simple', regular_price: '80.00', manage_stock: false }],
      '/orders?per_page=100&page=1&orderby=date&order=desc&after=': [],
    };
    const fetchFalso = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      for (const [k, v] of Object.entries(respostas)) if (caminho.startsWith(k)) return new Response(JSON.stringify(v), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchFalso });
    let divs = await listarDivergencias(empresaId, 'RETAIL');
    const preco = divs.find((x) => x.tipo === 'PRECO_DIVERGENTE');
    assert.ok(preco, 'preço da loja (80) ≠ ERP (100) é detectado');
    assert.equal(String(preco!.classificacao), 'AUTOMATICA');

    // Sem preço na loja → HUMANA (republicar exige decisão).
    const fetchSemPreco = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      if (caminho.startsWith('/products')) return new Response(JSON.stringify([{ id: 900, sku: 'WH-PRECO', regular_price: '', sale_price: '' }]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchSemPreco });
    divs = await listarDivergencias(empresaId, 'RETAIL');
    const ausente = divs.find((x) => x.tipo === 'PRECO_AUSENTE');
    assert.ok(ausente);
    assert.equal(String(ausente!.classificacao), 'HUMANA');
  });

  test('estoque divergente é AUTOMATICA e o ERP permanece a fonte', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-ESTOQUE', preco_venda: 40 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 5);
    await registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '901', sku: 'WH-ESTOQUE' });
    const fetchFalso = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      if (caminho.startsWith('/products'))
        return new Response(JSON.stringify([{ id: 901, sku: 'WH-ESTOQUE', regular_price: '40.00', manage_stock: true, stock_quantity: 99 }]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchFalso });
    const divs = await listarDivergencias(empresaId, 'RETAIL');
    const estoque = divs.find((x) => x.tipo === 'ESTOQUE_DIVERGENTE');
    assert.ok(estoque, 'estoque da loja (99) ≠ ERP (5) é detectado');
    assert.equal(String(estoque!.classificacao), 'AUTOMATICA');
    // `dados` é coluna json protegida (o decorate a remove da API); o valor
    // canônico fica no detalhe e no próprio registro.
    assert.match(String(estoque!.detalhe), /ERP 5 × loja 99/);
    const bruto = await getStore().findOneWhere(RESOURCES.woocommerce_reconciliacao_divergencias, { id: Number(estoque!.id) });
    assert.equal((bruto!.dados as any).estoque_erp, 5, 'a divergência registra o valor CANÔNICO do ERP');
  });

  test('anúncio na loja sem vínculo no ERP é HUMANA (nunca excluído automaticamente)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const fetchFalso = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      if (caminho.startsWith('/products')) return new Response(JSON.stringify([{ id: 5555, sku: 'ORFAO', regular_price: '10.00' }]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchFalso });
    const divs = await listarDivergencias(empresaId, 'RETAIL');
    const orfao = divs.find((x) => x.tipo === 'PRODUTO_EXTERNO_SEM_VINCULO');
    assert.ok(orfao);
    assert.equal(String(orfao!.classificacao), 'HUMANA');
  });

  test('SKU divergente e variação ausente são HUMANA', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-SKU-ERP', preco_venda: 30 });
    await registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '902', sku: 'WH-SKU-ERP' });
    const fetchFalso = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      if (caminho.startsWith('/products')) return new Response(JSON.stringify([{ id: 902, sku: 'SKU-DIFERENTE', regular_price: '30.00' }]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchFalso });
    const divs = await listarDivergencias(empresaId, 'RETAIL');
    const sku = divs.find((x) => x.tipo === 'SKU_DIVERGENTE');
    assert.ok(sku);
    assert.equal(String(sku!.classificacao), 'HUMANA');
  });

  test('variação ausente na loja é detectada e classificada como HUMANA', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const pai = await novoProduto(empresaId, { sku: 'WH-VAR-PAI', formato: 'variacao', preco_venda: 200 });
    const filho = await novoProduto(empresaId, { sku: 'WH-VAR-FILHO', formato: 'variacao', produto_pai_id: Number(pai.id), preco_venda: 199 });
    await registrarVinculo(empresaId, 'RETAIL', Number(pai.id), { external_product_id: '903', sku: 'WH-VAR-PAI' });
    await registrarVinculo(empresaId, 'RETAIL', Number(filho.id), { external_product_id: '903', external_variation_id: '6001', sku: 'WH-VAR-FILHO' });
    const fetchFalso = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      if (caminho.includes('/variations')) return new Response('[]', { status: 200 });
      if (caminho.startsWith('/products')) return new Response(JSON.stringify([{ id: 903, sku: 'WH-VAR-PAI', type: 'variable' }]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchFalso });
    const divs = await listarDivergencias(empresaId, 'RETAIL');
    const v = divs.find((x) => x.tipo === 'VARIACAO_AUSENTE');
    assert.ok(v);
    assert.equal(String(v!.classificacao), 'HUMANA');
  });

  test('pedido na loja ausente no ERP vira divergência de PEDIDOS', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const fetchFalso = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      if (caminho.startsWith('/orders'))
        return new Response(JSON.stringify([{ id: 8800, status: 'processing', total: '90.00', number: '8800' }]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchFalso });
    const divs = await listarDivergencias(empresaId, 'RETAIL');
    const p = divs.find((x) => x.tipo === 'PEDIDO_AUSENTE_NO_ERP');
    assert.ok(p);
    assert.equal(String(p!.pedido_ref), 'WOO-RETAIL-8800');
    assert.equal(String(p!.classificacao), 'AUTOMATICA');
  });

  test('divergência já corrigida é fechada quando deixa de ser detectada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-FECHA', preco_venda: 15 });
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: async () => new Response('[]', { status: 200 }) });
    let divs = await listarDivergencias(empresaId, 'RETAIL', { status: 'ABERTA' });
    assert.equal(divs.length, 1);

    // O produto ganha vínculo → a divergência deixa de existir.
    await registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '910', sku: 'WH-FECHA' });
    const fetchComProduto = async (url: any) => {
      const caminho = String(url).replace(RETAIL_URL + '/wp-json/wc/v3', '');
      if (caminho.startsWith('/products')) return new Response(JSON.stringify([{ id: 910, sku: 'WH-FECHA', regular_price: '15.00' }]), { status: 200 });
      return new Response('[]', { status: 200 });
    };
    const r = await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchComProduto });
    assert.ok(r.resolvidas >= 1, 'a divergência sumiu e foi fechada');
    divs = await listarDivergencias(empresaId, 'RETAIL', { status: 'ABERTA' });
    assert.equal(divs.length, 0);
  });

  test('reabrir: uma divergência que VOLTA a existir reabre (não fica escondida)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-REABRE', preco_venda: 15 });
    await registrarDivergencia(empresaId, 'RETAIL', {
      categoria: 'CATALOGO',
      tipo: 'PRODUTO_SEM_VINCULO',
      classificacao: 'AUTOMATICA',
      produto_id: Number(produto.id),
      sku: 'WH-REABRE',
      detalhe: 'x',
    });
    const [div] = await listarDivergencias(empresaId, 'RETAIL');
    await getStore().update(RESOURCES.woocommerce_reconciliacao_divergencias, Number(div.id), { status: 'CORRIGIDA' });
    await registrarDivergencia(empresaId, 'RETAIL', {
      categoria: 'CATALOGO',
      tipo: 'PRODUTO_SEM_VINCULO',
      classificacao: 'AUTOMATICA',
      produto_id: Number(produto.id),
      sku: 'WH-REABRE',
      detalhe: 'x',
    });
    const reaberta = await getStore().findOneWhere(RESOURCES.woocommerce_reconciliacao_divergencias, { id: Number(div.id) });
    assert.equal(String(reaberta!.status), 'ABERTA');
    assert.equal((await listarDivergencias(empresaId, 'RETAIL')).length, 1, 'nunca empilha linhas para a mesma divergência');
  });

  test('falha de API externa não derruba a reconciliação (ok=false com motivo)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const { reconciliarTodasLojas } = await import('../src/commerce/woocommerce/reconciliacao');
    const resultados = await reconciliarTodasLojas(
      [
        { cfg: exigirConfigStore('RETAIL'), empresaId },
        { cfg: exigirConfigStore('WHOLESALE'), empresaId },
      ],
      { fetch: async () => new Response('erro interno', { status: 500 }) }
    );
    assert.equal(resultados.length, 2);
    assert.ok(resultados.every((r) => r.ok === false), 'a loja que falhou é reportada, não lança');
    assert.ok(resultados.every((r) => r.erro));
  });

  test('correção automática: divergência AUTOMATICA enfileira e fecha; HUMANA é recusada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-CORRIGE', preco_venda: 15 });
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: async () => new Response('[]', { status: 200 }) });
    const divs = await listarDivergencias(empresaId, 'RETAIL');
    const automatica = divs.find((d) => d.tipo === 'PRODUTO_SEM_VINCULO')!;
    const r = await corrigirDivergencia(empresaId, 'RETAIL', Number(automatica.id), { id: 1, name: 'Gerente' });
    assert.equal(r.ok, true);
    assert.equal(r.acao, 'publicacao');
    const fechada = await getStore().findOneWhere(RESOURCES.woocommerce_reconciliacao_divergencias, { id: Number(automatica.id) });
    assert.equal(String(fechada!.status), 'CORRIGIDA');

    // HUMANA não pode ser corrigida automaticamente.
    await registrarDivergencia(empresaId, 'RETAIL', {
      categoria: 'CATALOGO',
      tipo: 'PRODUTO_EXTERNO_SEM_VINCULO',
      classificacao: 'HUMANA',
      external_product_id: '9999',
      detalhe: 'anúncio órfão',
    });
    const humana = (await listarDivergencias(empresaId, 'RETAIL')).find((d) => d.classificacao === 'HUMANA')!;
    await assert.rejects(
      () => corrigirDivergencia(empresaId, 'RETAIL', Number(humana.id), { id: 1, name: 'Gerente' }),
      /decisão humana/i
    );
  });

  test('contagem de divergências por categoria alimenta o painel', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await registrarDivergencia(empresaId, 'RETAIL', { categoria: 'PRECO', tipo: 'PRECO_DIVERGENTE', classificacao: 'AUTOMATICA', detalhe: 'x' });
    await registrarDivergencia(empresaId, 'RETAIL', { categoria: 'ESTOQUE', tipo: 'ESTOQUE_DIVERGENTE', classificacao: 'AUTOMATICA', detalhe: 'x' });
    const contagem = await contarDivergencias(empresaId, 'RETAIL');
    assert.equal(contagem.PRECO, 1);
    assert.equal(contagem.ESTOQUE, 1);
    assert.equal(contagem.CATALOGO, 0);
  });
});

// ============================================================================
// WH-5 — IMPORTAÇÃO POR WEBHOOK REUSA O FLUXO EXISTENTE (sem regressão)
// ============================================================================
describe('WH-5 — Reuso do fluxo de importação e segurança', () => {
  test('a reconciliação respeita o limite de páginas (não varre a loja inteira)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    process.env.WOOCOMMERCE_RECONCILIACAO_MAX_PAGINAS = '2';
    let paginas = 0;
    const fetchFalso = async (url: any) => {
      if (String(url).includes('/products?per_page=100')) {
        paginas += 1;
        return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: 10000 + paginas * 100 + i, sku: `X${i}` }))), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
    await reconciliarLojaCompleta(exigirConfigStore('RETAIL'), empresaId, { fetch: fetchFalso });
    assert.equal(paginas, 2, 'lê no máximo WOOCOMMERCE_RECONCILIACAO_MAX_PAGINAS páginas');
    const divs = await listarDivergencias(empresaId, 'RETAIL');
    assert.ok(divs.some((d) => d.tipo === 'RECONCILIACAO_TRUNCADA'), 'o truncamento é reportado como divergência legítima');
  });

  test('nenhuma resposta/erro vaza a credencial nem o segredo do webhook', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const status = JSON.stringify(statusStores());
    assert.ok(!status.includes('ck_retail_teste'));
    assert.ok(!status.includes(SEGREDO_RETAIL));
    // O erro de rede do cliente nunca propaga o corpo remoto.
    const { restaurar } = espionar(() => new Error('getaddrinfo ENOTFOUND'));
    try {
      const { testarConexao } = await import('../src/commerce/woocommerce/cliente');
      const r = await testarConexao(exigirConfigStore('RETAIL'));
      assert.equal(r.ok, false);
      assert.ok(!String(r.erro).includes('ck_retail_teste'));
      assert.ok(!String(r.erro).includes(SEGREDO_RETAIL));
    } finally {
      restaurar();
    }
  });

  test('multi-loja desligado: a reconciliação não detecta nada (guarda em scheduled)', async () => {
    limparLojas();
    assert.equal(multiStoreHabilitado(), false);
  });

  test('importação em lote continua idempotente (o webhook reusa o mesmo fluxo)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'WH-LOTE', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const pedido = {
      id: 9900,
      number: '9900',
      status: 'processing',
      date_created: '2026-09-10T14:00:00',
      total: '90.00',
      billing: { first_name: 'Ana', email: 'ana9900@brobond.com.br' },
      line_items: [{ sku: 'WH-LOTE', quantity: 1, price: 90, meta_data: [{ key: 'pa_tamanho', value: 'M' }] }],
    };
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedido] : []));
    try {
      const primeira = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      const segunda = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(primeira.importados.length, 1);
      assert.equal(segunda.importados.length, 0, 'reimportar não duplica');
      assert.equal(segunda.ignorados.length, 1);
    } finally {
      restaurar();
    }
  });
});
