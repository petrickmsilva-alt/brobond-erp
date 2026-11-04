// ============================================================================
// COMMERCE REAL — fluxo PIX ponta a ponta pela arquitetura EXISTENTE.
//
// Nada aqui substitui homologação real: o `fetch` é trocado por um simulador
// da Mercado Pago ORDERS API que devolve EXATAMENTE o formato documentado
// (POST /v1/orders, GET /v1/orders/{id}, webhook type=order assinado). O
// caminho exercitado é o de produção: /api/loja/checkout → Payment Engine →
// adapter Mercado Pago → provider legado (Orders API) → gateway_cobrancas →
// página pública → webhook → GET da Order → máquina de estados → pedido →
// venda operacional → estoque → outbox → notificações.
//
// O que se prova:
//   • contrato dos instrumentos: copia_cola = BR Code EMV (000201…),
//     qr_code_base64 = imagem real (iVBOR…), ticket_url = https; NUNCA
//     base64 = 000201…; ausência total ≠ sucesso;
//   • criação assíncrona: a MESMA Order é relida; nunca uma 2ª cobrança;
//   • regressão do "reembolso fantasma" (Order pendente projetada como
//     reembolsada) que impedia o PAGO e zerava a receita;
//   • estoque: pendente reserva (Físico 8 / Reservado 1 / Disponível 7);
//     pago consome a reserva e baixa o físico (7 / 0 / 7); expirado ou
//     cancelado devolve (8 / 0 / 8); webhook duplicado não baixa 2×;
//   • notificações: 1 mensagem por marco, NÃO CONFIGURADO honesto, SMTP
//     indisponível = retry, WhatsApp Cloud API oficial com 5 parâmetros,
//     idempotência (ENVIADO nunca reenviado);
//   • atualização manual de status: consulta pela referência gravada, sem
//     POST novo, idempotente.
// ============================================================================
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.COMMERCE_LOJA_EMPRESA_ID = '1';
for (const v of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'WHATSAPP_CLOUD_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_TRANSACIONAL', 'MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_WEBHOOK_SECRET']) delete process.env[v];
process.env.APP_URL = 'https://loja.example.invalid';

const { getStore, createRecord, updateRecord } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const vitrine = await import('../src/commerce/vitrine');
const pedidos = await import('../src/commerce/pedidos');
const notificacoes = await import('../src/commerce/notificacoes');
const { R_GATEWAY_CONFIGS, R_GATEWAY_COBRANCAS, R_GATEWAY_WEBHOOK_EVENTS, publicGatewayRouter, mercadopagoProvider } = await import('../src/gateway');
const { cifrarSegredo } = await import('../src/segredos');
const { PIX_REFRESH_DELAYS_MS } = await import('../../modules/payments/providers/mercado-pago');
const { paymentEngine, mensagemPixSemInstrumento } = await import('../../modules/payments/orchestration/payment-orchestrator');
const { R_INTENTS, R_ATTEMPTS } = await import('../../modules/payments/infrastructure/resources');

const s = getStore();
const actor = { id: 1, name: 'Admin teste', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };

// Fixtures no formato do provedor: PNG 1x1 real e BR Code EMV de exemplo.
const PIX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PIX_EMV = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
const TICKET = 'https://www.mercadopago.com.br/payments/123456/ticket?caller_id=1&hash=fixture';
const WEBHOOK_SECRET = 'webhook-fixture-sem-rede';
const ACCESS_TOKEN = 'APP_USR-fixture-sem-rede';

// ---------------------------------------------------------------------------
// Simulador da Mercado Pago Orders API (formato documentado, sem rede).
// ---------------------------------------------------------------------------
type ModoCriacao = 'completo' | 'assincrono' | 'sem_dados';
type Ordem = Record<string, any>;
const mp = {
  modo: 'completo' as ModoCriacao,
  orders: new Map<string, Ordem>(),
  porChave: new Map<string, string>(),
  posts: 0,
  gets: 0,
  ultimoPost: null as null | { headers: Record<string, string>; body: any },
  whatsapp: [] as { url: string; headers: Record<string, string>; body: any }[],
  whatsappStatus: 200,
};
let seq = 0;

function ordemCompleta(o: Ordem): Ordem {
  return {
    ...o,
    transactions: {
      payments: [{
        id: o.pagamento_id,
        amount: o.total_amount,
        status: o.status === 'processed' ? 'processed' : o.status,
        status_detail: o.status_detail,
        date_of_expiration: o.expira,
        payment_method: { id: 'pix', type: 'bank_transfer', ticket_url: TICKET, qr_code: PIX_EMV, qr_code_base64: PIX_PNG },
      }],
    },
  };
}

function respostaOrdem(o: Ordem, comDados: boolean): Ordem {
  const { pagamento_id: _p, expira: _e, dados: _d, ...publico } = o;
  if (!comDados) return { ...publico, transactions: { payments: [{ id: o.pagamento_id, amount: o.total_amount, status: 'processing', payment_method: { id: 'pix', type: 'bank_transfer' } }] } };
  const completa = ordemCompleta(o);
  const { pagamento_id: _p2, expira: _e2, dados: _d2, ...semInternos } = completa;
  return semInternos;
}

function json(body: unknown, status = 200) {
  return new globalThis.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchOriginal = globalThis.fetch;
async function fetchSimulado(url: unknown, init: RequestInit = {}) {
  const u = String(url);
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (u.startsWith('https://graph.facebook.com/')) {
    mp.whatsapp.push({ url: u, headers, body: JSON.parse(String(init.body || '{}')) });
    return mp.whatsappStatus === 200 ? json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.fixture.${mp.whatsapp.length}` }] }) : json({ error: { message: 'indisponível' } }, mp.whatsappStatus);
  }
  if (!u.startsWith('https://api.mercadopago.com/')) return json({ message: 'rota não simulada' }, 404);
  assert.equal(headers.authorization, `Bearer ${ACCESS_TOKEN}`, 'Access Token só no backend, como Bearer');
  if (u === 'https://api.mercadopago.com/v1/orders' && String(init.method).toUpperCase() === 'POST') {
    mp.posts += 1;
    const body = JSON.parse(String(init.body));
    mp.ultimoPost = { headers, body };
    const chave = headers['x-idempotency-key'];
    // Idempotência real do provedor: mesma chave → mesma Order.
    const existente = chave ? mp.porChave.get(chave) : undefined;
    if (existente) return json(respostaOrdem(mp.orders.get(existente)!, mp.orders.get(existente)!.dados));
    const id = `ORD01FIXTURE${String(++seq).padStart(6, '0')}`;
    const ordem: Ordem = {
      id, type: 'online', processing_mode: 'automatic', external_reference: body.external_reference,
      total_amount: body.total_amount, total_paid_amount: '0.00', currency: 'BRL', country_code: 'BRA',
      status: mp.modo === 'completo' ? 'action_required' : 'processing',
      status_detail: mp.modo === 'completo' ? 'waiting_transfer' : 'in_process',
      pagamento_id: `PAY01FIXTURE${String(seq).padStart(6, '0')}`,
      expira: new Date(Date.now() + 60 * 60_000).toISOString(),
      dados: mp.modo === 'completo',
    };
    mp.orders.set(id, ordem);
    if (chave) mp.porChave.set(chave, id);
    return json(respostaOrdem(ordem, ordem.dados));
  }
  const m = u.match(/^https:\/\/api\.mercadopago\.com\/v1\/orders\/([^/?]+)$/);
  if (m && String(init.method || 'GET').toUpperCase() === 'GET') {
    mp.gets += 1;
    const ordem = mp.orders.get(decodeURIComponent(m[1]));
    if (!ordem) return json({ errors: [{ code: 'order_not_found' }] }, 404);
    // Criação assíncrona: na primeira leitura a Order já tem os dados do PIX.
    if (mp.modo === 'assincrono' && !ordem.dados) Object.assign(ordem, { dados: true, status: 'action_required', status_detail: 'waiting_transfer' });
    return json(respostaOrdem(ordem, ordem.dados));
  }
  return json({ message: 'rota não simulada' }, 404);
}

/** Muda o estado da Order no "provedor" (o webhook só AVISA; a verdade é o GET). */
function provedorMuda(id: string, status: string, status_detail: string, pago = false) {
  const ordem = mp.orders.get(id)!;
  Object.assign(ordem, { status, status_detail, total_paid_amount: pago ? ordem.total_amount : '0.00', dados: true });
}

// ---------------------------------------------------------------------------
// App HTTP (rotas públicas reais + rota admin de atualização manual).
// ---------------------------------------------------------------------------
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
const app = express();
app.use(publicGatewayRouter);
app.use(express.json());
app.get('/api/loja/produtos/:slug', wrap(vitrine.lojaProdutoPublico));
app.post('/api/loja/checkout', wrap(vitrine.lojaCriarCheckout));
app.get('/api/loja/pedidos/:token', wrap(vitrine.lojaPedidoPublico));
const admin = (req: Request, _res: Response, next: NextFunction) => { (req as any).user = actor; next(); };
app.get('/api/commerce/pedidos/:saleId', admin, wrap(pedidos.detalharPedidoCommerce));
app.post('/api/commerce/pedidos/:saleId/atualizar-pagamento', admin, wrap(pedidos.atualizarPagamentoPedidoCommerce));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => { res.status(err.status || 500).json({ error: err.message }); });

function webhook(orderId: string, opts: { requestId?: string; assinatura?: 'ok' | 'invalida'; action?: string; status?: string } = {}) {
  const requestId = opts.requestId ?? `req-${orderId}-${Math.random().toString(36).slice(2)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const manifesto = `id:${orderId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = opts.assinatura === 'invalida' ? '0'.repeat(64) : createHmac('sha256', WEBHOOK_SECRET).update(manifesto).digest('hex');
  const ordem = mp.orders.get(orderId);
  return request(app)
    .post(`/api/gateway/webhooks/mercadopago?data.id=${encodeURIComponent(orderId)}&type=order`)
    .set('content-type', 'application/json')
    .set('x-request-id', requestId)
    .set('x-signature', `ts=${ts},v1=${v1}`)
    .send(JSON.stringify({
      action: opts.action ?? 'order.processed', type: 'order', user_id: '123', api_version: 'v1', live_mode: false,
      data: { id: orderId, status: opts.status ?? ordem?.status, external_reference: ordem?.external_reference, transactions: { payments: [{ id: ordem?.pagamento_id, status: opts.status ?? ordem?.status }] } },
    }));
}

// ---------------------------------------------------------------------------
// Estoque: Físico / Reservado / Disponível.
// ---------------------------------------------------------------------------
let produtoId = 0;
const SLUG = 'cotton-b-fixture';
async function estoque() {
  const fisico = (await s.list(RESOURCES.estoques, { page: 1, pageSize: 100, filter: { empresa_id: 1, produto_id: produtoId } })).rows
    .reduce((t, r) => t + Number(r.quantidade || 0), 0);
  const reservado = (await s.list(RESOURCES.estoque_reservas, { page: 1, pageSize: 100, filter: { empresa_id: 1, produto_id: produtoId, status: 'ativa' } })).rows
    .reduce((t, r) => t + Number(r.quantidade || 0), 0);
  const publico = await request(app).get(`/api/loja/produtos/${SLUG}`).expect(200);
  const disponivel = publico.body.tamanhos.reduce((t: number, x: any) => t + Number(x.disponivel || 0), 0);
  return { fisico, reservado, disponivel };
}

const comprador = { nome: '  Maria   Silva ', email: 'Maria@Example.invalid', whatsapp: '(62) 99999-1234', documento: '529.982.247-25', marketing_opt_in: false };
async function checkout(chave: string) {
  return request(app).post('/api/loja/checkout').send({ chave, payment_method: 'PIX', itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 1 }], comprador });
}
async function pedidoPorChave(chave: string) {
  return (await s.findOneWhere(RESOURCES.commerce_pedidos, { empresa_id: 1, chave_checkout: chave }))!;
}
async function linhasNotificacao(pedidoId: number) {
  return (await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 100, filter: { empresa_id: 1, pedido_id: pedidoId }, sort: 'id', dir: 'asc' })).rows;
}
async function trabalhosNotificacao(pedidoId: number) {
  return (await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 200, filter: { empresa_id: 1 } })).rows
    .filter((r) => String(r.chave || '').startsWith(`pedido:${pedidoId}:`));
}
const aguardar = (ms = 25) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  globalThis.fetch = fetchSimulado as typeof fetch;
  PIX_REFRESH_DELAYS_MS.valores = [0];
  pedidos.registrarHooksCommerce();
  const cfg = await createRecord(RESOURCES.commerce_configuracoes, { loja_nome: 'BROBOND Store (teste)', frete_provedor: 'retirada', checkout_expira_minutos: 60 }, actor);
  const dono = await s.insert(RESOURCES.usuarios, { nome: 'Responsável checkout', email: 'dono-pix@example.invalid', perfil: 'admin', ativo: true, empresa_id: 1 });
  await s.insert(RESOURCES.usuario_empresas, { usuario_id: dono.id, empresa_id: 1 });
  await updateRecord(RESOURCES.commerce_configuracoes, Number(cfg.id), { checkout_usuario_id: dono.id }, actor);
  await s.insert(R_GATEWAY_CONFIGS, {
    empresa_id: 1, provider: 'mercadopago', ativo: true, ambiente: 'sandbox',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: ACCESS_TOKEN })),
    webhook_segredo_cifrado: cifrarSegredo(WEBHOOK_SECRET),
  });
  const p = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: 'COTTON-B-FIXTURE', nome: 'COTTON "B"', preco_venda: 80, ativo: true });
  produtoId = Number(p.id);
  await s.insert(RESOURCES.commerce_produtos, { empresa_id: 1, produto_id: produtoId, slug: SLUG });
  await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: 1, produto_id: produtoId, canal: 'BROBOND', estado: 'PUBLISHED', versao: 1 });
  // Saldo no local canônico padrão (id 1 = 'loja'), o mesmo do faturamento.
  await s.insert(RESOURCES.estoques, { empresa_id: 1, produto_id: produtoId, local_id: 1, local: 'loja', quantidade: 8 });
});

after(() => {
  globalThis.fetch = fetchOriginal;
  PIX_REFRESH_DELAYS_MS.valores = [500, 1000];
});

describe('Commerce real — PIX Mercado Pago (Orders API) ponta a ponta', () => {
  let chavePrincipal = '';
  let orderId = '';

  test('checkout: POST /v1/orders correto, instrumentos persistidos cada um no seu campo, estoque 8/1/7', async () => {
    assert.deepEqual(await estoque(), { fisico: 8, reservado: 0, disponivel: 8 });
    chavePrincipal = 'pix-real-flow-principal-0001';
    const criado = await checkout(chavePrincipal);
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.equal(criado.body.pedido.total, 80, 'total do servidor (o navegador não é autoridade)');
    assert.equal(criado.body.pedido.estado, 'AGUARDANDO_PAGAMENTO');
    assert.equal(mp.posts, 1);

    // Contrato do POST /v1/orders.
    const { headers, body } = mp.ultimoPost!;
    assert.match(headers['x-idempotency-key'], /^[a-f0-9]{64}$/, 'chave de idempotência determinística da operação');
    assert.equal(body.external_reference, headers['x-idempotency-key']);
    assert.match(body.external_reference, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(body.type, 'online');
    assert.equal(body.processing_mode, 'automatic');
    assert.equal(body.total_amount, '80.00');
    assert.deepEqual(body.transactions.payments[0].payment_method, { id: 'pix', type: 'bank_transfer' });
    assert.equal(body.payer.email, 'maria@example.invalid');
    assert.deepEqual(body.payer.identification, { type: 'CPF', number: '52998224725' });

    const pedido = await pedidoPorChave(chavePrincipal);
    const cobranca = (await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))!;
    orderId = String(cobranca.provider_ref);
    assert.match(orderId, /^ORD01FIXTURE/, 'provider_order_id persistido');
    assert.equal(cobranca.copia_cola, PIX_EMV);
    assert.equal(cobranca.qr_code, PIX_EMV, 'qr_code guarda o BR Code (texto), nunca a imagem');
    assert.equal(cobranca.qr_code_base64, PIX_PNG);
    assert.doesNotMatch(String(cobranca.qr_code_base64), /^000201/, 'NUNCA base64 = 000201…');
    assert.equal(cobranca.ticket_url, TICKET);

    // Página pública: só o necessário para pagar.
    const publico = await request(app).get(`/api/loja/pedidos/${pedido.checkout_token}`).expect(200);
    assert.equal(publico.body.pagamento.copia_cola, PIX_EMV);
    assert.equal(publico.body.pagamento.qr_code_base64, PIX_PNG);
    assert.equal(publico.body.pagamento.ticket_url, TICKET);
    assert.equal(publico.body.pagamento.metodo, 'pix');
    assert.ok(publico.body.pagamento.expira_em);
    const textoPublico = JSON.stringify(publico.body);
    for (const proibido of ['52998224725', '529.982.247-25', ACCESS_TOKEN, WEBHOOK_SECRET, 'correlation_id', 'engine_status', 'provider_order_id', orderId])
      assert.ok(!textoPublico.includes(proibido), `página pública vazou ${proibido}`);

    // Estoque: pendente RESERVA, não baixa o físico.
    assert.deepEqual(await estoque(), { fisico: 8, reservado: 1, disponivel: 7 });

    // Notificação: UMA mensagem por canal para o pedido recebido.
    await aguardar();
    const linhas = await linhasNotificacao(Number(pedido.id));
    const ativas = linhas.filter((l) => l.estado !== 'IGNORADO');
    assert.deepEqual(ativas.map((l) => `${l.evento}:${l.canal}`).sort(), ['ORDER_CREATED:EMAIL', 'ORDER_CREATED:WHATSAPP']);
    assert.ok(linhas.filter((l) => l.estado === 'IGNORADO').every((l) => l.provider_status === 'CONSOLIDADO'));
    assert.equal(ativas.find((l) => l.canal === 'EMAIL')?.destinatario, 'maria@example.invalid');
    assert.equal(ativas.find((l) => l.canal === 'WHATSAPP')?.destinatario, '5562999991234');
    const trabalhos = await trabalhosNotificacao(Number(pedido.id));
    assert.deepEqual(trabalhos.map((t) => t.chave), [`pedido:${pedido.id}:ORDER_CREATED`]);
  });

  test('checkout repetido (mesma chave) é idempotente: nenhuma segunda cobrança no provedor', async () => {
    const repetido = await checkout(chavePrincipal);
    assert.equal(repetido.status, 200, JSON.stringify(repetido.body));
    assert.equal(repetido.body.idempotente, true);
    assert.equal(mp.posts, 1);
    assert.deepEqual(await estoque(), { fisico: 8, reservado: 1, disponivel: 7 });
  });

  test('webhook pendente (action_required) não projeta reembolso fantasma nem paga', async () => {
    await webhook(orderId, { action: 'order.action_required' }).expect(200);
    const pedido = await pedidoPorChave(chavePrincipal);
    assert.equal(pedido.estado, 'AGUARDANDO_PAGAMENTO');
    const intent = (await s.findOneWhere(R_INTENTS, { empresa_id: 1, order_id: Number(pedido.id) }))!;
    assert.equal(intent.status, 'PENDING');
    const tentativas = (await s.list(R_ATTEMPTS, { page: 1, pageSize: 10, filter: { empresa_id: 1, payment_intent_id: Number(intent.id) } })).rows;
    assert.ok(tentativas.every((t) => !Number(t.refunded_amount)), 'Order pendente NUNCA vira reembolso (causa do 409 "Reembolso divergente")');
    const bruto = (await mercadopagoProvider.consultaCobranca({ empresaId: 1, config: null, credenciais: { access_token: ACCESS_TOKEN }, webhookSegredo: WEBHOOK_SECRET } as any, orderId))!;
    assert.ok([undefined, null, 0].includes((bruto.bruto as any).transaction_amount_refunded), 'pendente nunca projeta valor reembolsado');
    assert.equal(bruto.status, 'pendente');
  });

  test('webhook com assinatura inválida é recusado e não altera nada', async () => {
    provedorMuda(orderId, 'processed', 'accredited', true);
    const r = await webhook(orderId, { assinatura: 'invalida' });
    assert.equal(r.status, 401);
    assert.equal((await pedidoPorChave(chavePrincipal)).estado, 'AGUARDANDO_PAGAMENTO');
    assert.deepEqual(await estoque(), { fisico: 8, reservado: 1, disponivel: 7 });
  });

  test('webhook assinado → GET /v1/orders/{id} → PAGO → venda operacional e baixa física única (7/0/7)', async () => {
    const getsAntes = mp.gets;
    const requestId = 'req-aprovacao-unica';
    await webhook(orderId, { requestId, action: 'order.processed', status: 'processed' }).expect(200);
    assert.ok(mp.gets > getsAntes, 'o webhook só avisa: a verdade vem do GET da Order');
    const pedido = await pedidoPorChave(chavePrincipal);
    assert.ok(['PAGO', 'CONVERTIDO'].includes(String(pedido.estado)), `estado ${pedido.estado} — ${pedido.erro}`);
    assert.equal(pedido.pagamento_estado, 'APPROVED');
    const cobranca = (await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))!;
    assert.equal(cobranca.status, 'paga');
    const intent = (await s.findOneWhere(R_INTENTS, { empresa_id: 1, order_id: Number(pedido.id) }))!;
    assert.equal(intent.status, 'PAID');
    assert.equal(pedido.estado, 'CONVERTIDO', 'pagamento aprovado converte em venda operacional');
    const vendas = (await s.list(RESOURCES.vendas, { page: 1, pageSize: 10, filter: { empresa_id: 1, pedido_externo_id: String(pedido.pedido_externo) } })).rows;
    assert.equal(vendas.length, 1);
    assert.deepEqual(await estoque(), { fisico: 7, reservado: 0, disponivel: 7 });

    // Mesmo aviso reentregue (retry do provedor) → deduplicado.
    const dup = await webhook(orderId, { requestId, action: 'order.processed', status: 'processed' }).expect(200);
    assert.equal(dup.body.duplicado, true);
    // Aviso NOVO do mesmo pagamento (outro event_id) → processado, sem efeito duplo.
    await webhook(orderId, { action: 'order.updated', status: 'processed' }).expect(200);
    const vendasDepois = (await s.list(RESOURCES.vendas, { page: 1, pageSize: 10, filter: { empresa_id: 1, pedido_externo_id: String(pedido.pedido_externo) } })).rows;
    assert.equal(vendasDepois.length, 1, '1 pagamento / 1 venda');
    assert.deepEqual(await estoque(), { fisico: 7, reservado: 0, disponivel: 7 }, '1 saída física');
    const tentativas = (await s.list(R_ATTEMPTS, { page: 1, pageSize: 10, filter: { empresa_id: 1, payment_intent_id: Number(intent.id) } })).rows;
    assert.equal(tentativas.length, 1);
    assert.equal(mp.posts, 1, 'nenhuma nova cobrança');

    // Página pública reflete o pagamento sem F5 manual de backoffice.
    const publico = await request(app).get(`/api/loja/pedidos/${pedido.checkout_token}`).expect(200);
    assert.equal(publico.body.pagamento.status, 'APPROVED');

    // Diagnóstico do backoffice: webhook RECEBIDO, vinculado após o processamento.
    const detalhe = await request(app).get(`/api/commerce/pedidos/${pedido.sale_id}`).expect(200);
    assert.equal(detalhe.body.diagnostico.webhook.estado, 'RECEBIDO');
    assert.ok(detalhe.body.diagnostico.webhook.total >= 2);
    assert.equal(detalhe.body.diagnostico.webhook.ultimo.status, 'processado');
    assert.equal(detalhe.body.diagnostico.pagamento.provider_order_id, orderId);

    // Notificação de pagamento: 1 trabalho; ORDER_PROCESSING consolidado.
    await aguardar();
    const trabalhos = (await trabalhosNotificacao(Number(pedido.id))).map((t) => t.chave).sort();
    assert.deepEqual(trabalhos, [`pedido:${pedido.id}:ORDER_CREATED`, `pedido:${pedido.id}:PAYMENT_APPROVED`]);
  });

  test('webhook de Order desconhecida (outro tenant/ref) não é aceito nem persistido', async () => {
    const antes = (await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 1 })).total;
    const r = await webhook('ORD-DE-OUTRO-TENANT');
    assert.ok([401, 404].includes(r.status), `status ${r.status}`);
    const depois = (await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 1 })).total;
    assert.equal(depois, antes);
  });
});

describe('Commerce real — criação assíncrona, ausência de instrumento, expiração e cancelamento', () => {
  test('criação assíncrona: POST sem dados → GET da MESMA Order completa o PIX (1 POST)', async () => {
    mp.modo = 'assincrono';
    const postsAntes = mp.posts;
    try {
      const r = await checkout('pix-real-flow-assincrono-0001');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(mp.posts - postsAntes, 1);
      const pedido = await pedidoPorChave('pix-real-flow-assincrono-0001');
      const cobranca = (await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))!;
      assert.equal(cobranca.copia_cola, PIX_EMV);
      assert.equal(cobranca.qr_code_base64, PIX_PNG);
      assert.equal(cobranca.ticket_url, TICKET);
    } finally { mp.modo = 'completo'; }
  });

  test('provedor sem QR, Copia e Cola e link → 502 honesto, reserva devolvida, sem 2ª cobrança no retry', async () => {
    mp.modo = 'sem_dados';
    const atrasos = PIX_REFRESH_DELAYS_MS.valores;
    PIX_REFRESH_DELAYS_MS.valores = [];
    const antes = await estoque();
    const postsAntes = mp.posts;
    try {
      const r = await checkout('pix-real-flow-sem-dados-0001');
      assert.equal(r.status, 502);
      assert.equal(r.body.error, mensagemPixSemInstrumento('MERCADO_PAGO'));
      const pedido = await pedidoPorChave('pix-real-flow-sem-dados-0001');
      assert.equal(pedido.estado, 'ERRO');
      assert.deepEqual(await estoque(), antes, 'reserva devolvida');
      const intent = (await s.findOneWhere(R_INTENTS, { empresa_id: 1, order_id: Number(pedido.id) }))!;
      assert.equal(intent.status, 'FAILED');
      const tentativa = (await s.list(R_ATTEMPTS, { page: 1, pageSize: 5, filter: { empresa_id: 1, payment_intent_id: Number(intent.id) } })).rows[0];
      assert.match(String(tentativa.provider_transaction_id), /^ORD01FIXTURE/, 'referência persistida ANTES da validação (sem órfã)');
      await checkout('pix-real-flow-sem-dados-0001');
      assert.equal(mp.posts - postsAntes, 1, 'retry nunca cria segunda cobrança');
    } finally { mp.modo = 'completo'; PIX_REFRESH_DELAYS_MS.valores = atrasos; }
  });

  test('Order expirada no provedor → EXPIRADO, reserva devolvida (8/0/8 relativo) e ORDER_EXPIRED', async () => {
    const r = await checkout('pix-real-flow-expira-0001');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pedido = await pedidoPorChave('pix-real-flow-expira-0001');
    const comReserva = await estoque();
    assert.equal(comReserva.reservado, 2, 'reserva deste pedido + do assíncrono');
    const cobranca = (await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))!;
    provedorMuda(String(cobranca.provider_ref), 'canceled', 'expired');
    await webhook(String(cobranca.provider_ref), { action: 'order.expired', status: 'canceled' }).expect(200);
    const depois = await pedidoPorChave('pix-real-flow-expira-0001');
    assert.equal(depois.estado, 'EXPIRADO');
    const final = await estoque();
    assert.equal(final.reservado, comReserva.reservado - 1);
    assert.equal(final.fisico, comReserva.fisico, 'expiração nunca mexe no físico');
    assert.equal(final.disponivel, comReserva.disponivel + 1);
    await aguardar();
    const eventos = (await linhasNotificacao(Number(pedido.id))).map((l) => l.evento);
    assert.ok(eventos.includes('ORDER_EXPIRED'));
    assert.ok(!eventos.includes('ORDER_CANCELLED'), 'expiração não é "cancelado"');
  });

  test('Order cancelada no provedor → CANCELADO e reserva devolvida', async () => {
    const r = await checkout('pix-real-flow-cancela-0001');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pedido = await pedidoPorChave('pix-real-flow-cancela-0001');
    const comReserva = await estoque();
    const cobranca = (await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))!;
    provedorMuda(String(cobranca.provider_ref), 'canceled', 'canceled');
    await webhook(String(cobranca.provider_ref), { action: 'order.canceled', status: 'canceled' }).expect(200);
    const depois = await pedidoPorChave('pix-real-flow-cancela-0001');
    assert.ok(['CANCELADO', 'EXPIRADO'].includes(String(depois.estado)), `estado ${depois.estado}`);
    const final = await estoque();
    assert.equal(final.reservado, comReserva.reservado - 1);
    assert.equal(final.fisico, comReserva.fisico);
  });

  test('expiração local (varredura) → EXPIRADO, reserva devolvida e ORDER_EXPIRED (não ORDER_CANCELLED)', async () => {
    const pedido = await pedidoPorChave('pix-real-flow-assincrono-0001');
    assert.equal(pedido.estado, 'AGUARDANDO_PAGAMENTO');
    const antes = await estoque();
    await s.update(RESOURCES.commerce_pedidos, Number(pedido.id), { expira_em: new Date(Date.now() - 60_000).toISOString() });
    const expirados = await pedidos.expirarCheckoutsPendentes(new Date());
    assert.ok(expirados >= 1);
    assert.equal((await pedidoPorChave('pix-real-flow-assincrono-0001')).estado, 'EXPIRADO');
    const final = await estoque();
    assert.equal(final.reservado, antes.reservado - 1);
    assert.equal(final.fisico, antes.fisico);
    await aguardar();
    const eventos = (await linhasNotificacao(Number(pedido.id))).map((l) => l.evento);
    assert.ok(eventos.includes('ORDER_EXPIRED'));
    assert.ok(!eventos.includes('ORDER_CANCELLED'));
  });
});

describe('Commerce real — atualização manual do status do pagamento (backoffice)', () => {
  test('consulta pela referência gravada, sem POST novo, idempotente; aprovação converte uma única vez', async () => {
    const r = await checkout('pix-real-flow-manual-0001');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pedido = await pedidoPorChave('pix-real-flow-manual-0001');
    const cobranca = (await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))!;
    const detalhe = await request(app).get(`/api/commerce/pedidos/${pedido.sale_id}`).expect(200);
    assert.equal(detalhe.body.diagnostico.pix.copia_cola, 'DISPONIVEL');
    assert.equal(detalhe.body.diagnostico.pix.qr_code_base64, 'DISPONIVEL');
    assert.equal(detalhe.body.diagnostico.pix.ticket_url, 'DISPONIVEL');
    assert.equal(detalhe.body.diagnostico.webhook.estado, 'NAO_RECEBIDO');
    assert.equal(detalhe.body.diagnostico.pode_atualizar, true);
    assert.ok(!JSON.stringify(detalhe.body.diagnostico).includes(PIX_EMV), 'diagnóstico mostra presença, não o valor');

    const postsAntes = mp.posts;
    const getsAntes = mp.gets;
    provedorMuda(String(cobranca.provider_ref), 'processed', 'accredited', true);
    const antes = await estoque();
    const atualizado = await request(app).post(`/api/commerce/pedidos/${pedido.sale_id}/atualizar-pagamento`).expect(200);
    assert.equal(atualizado.body.atualizado, true);
    assert.ok(mp.gets > getsAntes);
    assert.equal(mp.posts, postsAntes, 'nenhuma nova cobrança');
    const depois = await pedidoPorChave('pix-real-flow-manual-0001');
    assert.equal(depois.estado, 'CONVERTIDO');
    const final = await estoque();
    assert.equal(final.fisico, antes.fisico - 1, 'baixa física única');
    assert.equal(final.reservado, antes.reservado - 1);

    // Repetição imediata: throttle — nada é consultado nem baixado de novo.
    const getsDepois = mp.gets;
    const repetido = await request(app).post(`/api/commerce/pedidos/${pedido.sale_id}/atualizar-pagamento`).expect(200);
    assert.equal(repetido.body.atualizado, false);
    assert.equal(mp.gets, getsDepois);
    assert.deepEqual(await estoque(), final);
    const vendas = (await s.list(RESOURCES.vendas, { page: 1, pageSize: 10, filter: { empresa_id: 1, pedido_externo_id: String(depois.pedido_externo) } })).rows;
    assert.equal(vendas.length, 1);
  });

  test('sem referência do provedor: 409 e nenhuma cobrança nova', async () => {
    const pedido = await pedidoPorChave('pix-real-flow-manual-0001');
    const intent = (await s.findOneWhere(R_INTENTS, { empresa_id: 1, order_id: Number(pedido.id) }))!;
    const tentativa = (await s.list(R_ATTEMPTS, { page: 1, pageSize: 1, filter: { empresa_id: 1, payment_intent_id: Number(intent.id) } })).rows[0];
    const ref = tentativa.provider_transaction_id;
    await s.update(R_ATTEMPTS, Number(tentativa.id), { provider_transaction_id: null });
    const postsAntes = mp.posts;
    try {
      const r = await request(app).post(`/api/commerce/pedidos/${pedido.sale_id}/atualizar-pagamento`);
      assert.equal(r.status, 409);
      assert.match(r.body.error, /Nenhuma nova cobrança será criada/);
      assert.equal(mp.posts, postsAntes);
    } finally { await s.update(R_ATTEMPTS, Number(tentativa.id), { provider_transaction_id: ref }); }
  });
});

describe('Commerce real — notificações (outbox → worker → e-mail / WhatsApp oficial)', () => {
  let pedidoId = 0;
  const payload = () => ({ empresa_id: 1, pedido_id: pedidoId, evento: 'ORDER_CREATED' });

  before(async () => {
    const r = await checkout('pix-real-flow-notifica-0001');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    pedidoId = Number((await pedidoPorChave('pix-real-flow-notifica-0001')).id);
    await aguardar();
  });

  test('conteúdo: assunto "BroBond — Pedido #X recebido", itens, total, PIX real, link; sem CPF', async () => {
    const dados = await notificacoes.carregarDadosPedido(1, pedidoId);
    const { assunto, html } = notificacoes.montarEmailPedido('ORDER_CREATED', dados);
    assert.equal(assunto, `BroBond — Pedido #${dados.numero} recebido`);
    assert.match(html, /Maria/);
    assert.match(html, /COTTON &quot;B&quot;|COTTON "B"/);
    assert.match(html, /R\$\s?80,00/);
    assert.match(html, /PIX/);
    assert.match(html, /aguardando confirmação do pagamento/);
    assert.ok(html.includes(PIX_EMV), 'Copia e Cola REAL do provedor');
    assert.ok(html.includes(TICKET.replace(/&/g, '&amp;')) || html.includes(TICKET), 'link oficial do provedor');
    assert.match(html, /https:\/\/loja\.example\.invalid\/loja\/pedido\/[a-f0-9]{64}/);
    for (const proibido of ['52998224725', '529.982.247-25', 'data:image', ACCESS_TOKEN]) assert.ok(!html.includes(proibido), `e-mail contém ${proibido}`);
    const params = notificacoes.parametrosWhatsApp('ORDER_CREATED', dados);
    assert.equal(params.length, 5);
    assert.equal(params[0], dados.numero);
    assert.match(params[1], /R\$\s?80,00/);
    assert.equal(params[2], 'PIX');
    assert.equal(params[3], 'aguardando confirmação do pagamento');
    assert.match(params[4], /^https:\/\/loja\.example\.invalid\/loja\/pedido\//);
  });

  test('canais sem configuração → PENDENTE + NÃO CONFIGURADO (nunca ENVIADO)', async () => {
    const desfecho = await notificacoes.processarEventoNotificacao(payload());
    assert.equal(desfecho.status, 'retry');
    const linhas = (await linhasNotificacao(pedidoId)).filter((l) => l.evento === 'ORDER_CREATED');
    assert.equal(linhas.length, 2);
    for (const l of linhas) {
      assert.equal(l.estado, 'PENDENTE');
      assert.equal(l.provider_status, 'NAO_CONFIGURADO');
      assert.match(String(l.ultimo_erro), /^NÃO CONFIGURADO: defina /);
    }
    assert.match(String(linhas.find((l) => l.canal === 'EMAIL')?.ultimo_erro), /SMTP_HOST/);
    assert.match(String(linhas.find((l) => l.canal === 'WHATSAPP')?.ultimo_erro), /WHATSAPP_CLOUD_API_TOKEN/);
    const status = notificacoes.statusCanaisNotificacao();
    assert.equal(status.email.status, 'NAO_CONFIGURADO');
    assert.equal(status.whatsapp.status, 'NAO_CONFIGURADO');
    assert.ok(!JSON.stringify(status).includes(ACCESS_TOKEN));
  });

  test('SMTP indisponível → retry (PENDENTE, sem ENVIADO); WhatsApp oficial aceito → ENVIADO com 5 parâmetros', async () => {
    Object.assign(process.env, {
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'fixture', SMTP_PASS: 'fixture-sem-rede',
      WHATSAPP_CLOUD_API_TOKEN: 'EAAG-fixture-sem-rede', WHATSAPP_PHONE_NUMBER_ID: '100000000000001', WHATSAPP_TEMPLATE_TRANSACIONAL: 'brobond_pedido_atualizacao',
    });
    mp.whatsapp = [];
    mp.whatsappStatus = 200;
    try {
      const desfecho = await notificacoes.processarEventoNotificacao(payload());
      assert.equal(desfecho.status, 'retry', 'e-mail fica para retry');
      const linhas = (await linhasNotificacao(pedidoId)).filter((l) => l.evento === 'ORDER_CREATED');
      const email = linhas.find((l) => l.canal === 'EMAIL')!;
      const whats = linhas.find((l) => l.canal === 'WHATSAPP')!;
      assert.equal(email.estado, 'PENDENTE');
      assert.match(String(email.ultimo_erro), /SMTP indisponível/);
      assert.equal(whats.estado, 'ENVIADO');
      assert.equal(whats.provider_status, 'REQUEST_ACCEPTED');
      assert.match(String(whats.provider_message_id), /^wamid\./);
      assert.equal(mp.whatsapp.length, 1);
      const chamada = mp.whatsapp[0];
      assert.equal(chamada.url, 'https://graph.facebook.com/v26.0/100000000000001/messages');
      assert.equal(chamada.headers.authorization, 'Bearer EAAG-fixture-sem-rede');
      assert.equal(chamada.body.messaging_product, 'whatsapp');
      assert.equal(chamada.body.to, '5562999991234');
      assert.equal(chamada.body.type, 'template');
      assert.equal(chamada.body.template.name, 'brobond_pedido_atualizacao');
      assert.equal(chamada.body.template.components[0].parameters.length, 5);

      // Idempotência: reprocessar não reenvia o que já foi ENVIADO.
      await notificacoes.processarEventoNotificacao(payload());
      assert.equal(mp.whatsapp.length, 1, 'WhatsApp ENVIADO nunca é reenviado');
    } finally {
      for (const v of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'WHATSAPP_CLOUD_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_TRANSACIONAL']) delete process.env[v];
    }
  });

  test('WhatsApp Cloud API fora do ar → PENDENTE para retry com motivo genérico (sem token/phone id)', async () => {
    const r = await checkout('pix-real-flow-notifica-0002');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const outroId = Number((await pedidoPorChave('pix-real-flow-notifica-0002')).id);
    await aguardar();
    Object.assign(process.env, { WHATSAPP_CLOUD_API_TOKEN: 'EAAG-fixture-sem-rede', WHATSAPP_PHONE_NUMBER_ID: '100000000000001', WHATSAPP_TEMPLATE_TRANSACIONAL: 'brobond_pedido_atualizacao' });
    mp.whatsappStatus = 500;
    try {
      const desfecho = await notificacoes.processarEventoNotificacao({ empresa_id: 1, pedido_id: outroId, evento: 'ORDER_CREATED' });
      assert.equal(desfecho.status, 'retry');
      const whats = (await linhasNotificacao(outroId)).find((l) => l.evento === 'ORDER_CREATED' && l.canal === 'WHATSAPP')!;
      assert.equal(whats.estado, 'PENDENTE');
      assert.match(String(whats.ultimo_erro), /WhatsApp Cloud API indisponível \(HTTP 500\)/);
      assert.ok(!String(whats.ultimo_erro).includes('EAAG') && !String(whats.ultimo_erro).includes('100000000000001'));
    } finally {
      mp.whatsappStatus = 200;
      for (const v of ['WHATSAPP_CLOUD_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_TRANSACIONAL']) delete process.env[v];
    }
  });

  test('evento repetido não cria linha nem trabalho novo (idempotência do registro)', async () => {
    const pedido = (await s.get(RESOURCES.commerce_pedidos, pedidoId))!;
    const antes = (await linhasNotificacao(pedidoId)).length;
    const trabalhosAntes = (await trabalhosNotificacao(pedidoId)).length;
    const novas = await notificacoes.registrarEventoPedido(
      { email: 'maria@example.invalid', whatsapp: '5562999991234' },
      { empresaId: 1, pedidoId, evento: 'ORDER_CREATED', pedidoExterno: String(pedido.pedido_externo), checkoutToken: String(pedido.checkout_token) } as any
    );
    assert.equal(novas, 0);
    assert.equal((await linhasNotificacao(pedidoId)).length, antes);
    assert.equal((await trabalhosNotificacao(pedidoId)).length, trabalhosAntes);
  });
});
