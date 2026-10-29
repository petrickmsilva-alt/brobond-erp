import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.COMMERCE_LOJA_EMPRESA_ID = '1';
const { getStore, createRecord, updateRecord } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { estadoLoja, pagamentoDaLoja } = await import('../src/commerce/estado-loja');
const { responsavelCheckout, empresaDaVitrine } = await import('../src/commerce/loja-base');
const { cotarFrete } = await import('../src/commerce/frete');
const vitrine = await import('../src/commerce/vitrine');
const { R_GATEWAY_CONFIGS, R_GATEWAY_COBRANCAS, registrarProvider, mercadopagoProvider, publicGatewayRouter, setOnCobrancaAlterada } = await import('../src/gateway');
const { cifrarSegredo } = await import('../src/segredos');
const s = getStore();
const actor = { id: 1, name: 'Teste isolado', perfil: 'admin' as const, empresa_id: 1 };
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
const app = express();
app.use(express.json());
app.get('/api/loja/config', wrap(vitrine.lojaConfigPublica));
app.get('/api/loja/produtos', wrap(vitrine.lojaProdutosPublicos));
app.get('/api/loja/produtos/:slug', wrap(vitrine.lojaProdutoPublico));
app.post('/api/loja/preview', wrap(vitrine.lojaPreview));
app.post('/api/loja/checkout', wrap(vitrine.lojaCriarCheckout));
app.get('/api/loja/pedidos/:token', wrap(vitrine.lojaPedidoPublico));
app.get('/api/commerce/loja/estado', (req, _res, next) => { (req as any).user = actor; next(); }, wrap(estadoLoja));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => { res.status(err.status || 500).json({ error: err.message }); });

let configId: number;
let produtoId: number;
let cobrancas = 0;
let donoId: number;
let gatewayId: number;
const itens = () => [{ produto_id: produtoId, tamanho_id: null, quantidade: 2 }];
const comprador = { nome: 'Comprador de teste isolado', email: 'teste@example.invalid' };

describe('Commerce exposure — configuração persistida, HTTP público e checkout sem cobrança real', () => {
  test('nenhuma configuração não é confundida com loja pronta; RBAC', async () => {
    const r = await request(app).get('/api/commerce/loja/estado').expect(200);
    assert.equal(r.body.abrir_loja, false);
    assert.equal(r.body.status, 'PENDENTE_DE_CONFIGURACAO');
    assert.ok(r.body.pendencias.some((p: any) => p.codigo === 'frete'));
    await assert.rejects(() => estadoLoja({ user: { ...actor, perfil: 'operador' } } as any, {} as Response), (e: any) => e.status === 403);
    await assert.rejects(() => estadoLoja({} as Request, {} as Response), (e: any) => e.status === 401);
  });

  test('CRUD existente grava configuração de frete real e recusa tabela inválida inclusive PUT parcial', async () => {
    await assert.rejects(() => createRecord(RESOURCES.commerce_configuracoes, { frete_provedor: 'manual', frete_valor: 0 }, actor), (e: any) => e.status === 400);
    const cfg = await createRecord(RESOURCES.commerce_configuracoes, { loja_nome: 'Loja de teste isolado', frete_provedor: 'manual', frete_valor: 18.5, frete_prazo_dias: 3, checkout_expira_minutos: 60 }, actor);
    configId = Number(cfg.id);
    await assert.rejects(() => updateRecord(RESOURCES.commerce_configuracoes, configId, { frete_valor: 0 }, actor), (e: any) => e.status === 400);
    const r = await request(app).get('/api/loja/config').expect(200);
    assert.equal(r.body.frete.disponivel, true);
    assert.equal(r.body.frete.valor, 18.5);
    assert.equal(r.body.checkout_disponivel, false);
    for (const valor of [0, 0.001, -1, NaN, Infinity, 'inválido']) {
      const f = await cotarFrete({ frete_provedor: 'manual', frete_valor: valor }, { subtotal: 100 });
      assert.equal(f.disponivel, false);
      assert.ok(!('valor' in f));
    }
    assert.equal((await cotarFrete({ frete_provedor: 'retirada' }, { subtotal: 100 }) as any).valor, 0);
  });

  test('responsável explícito exige vínculo ativo à empresa (inclusive configuração legada)', async () => {
    const outro = await s.insert(RESOURCES.usuarios, { nome: 'Outro tenant teste', email: 'outro@example.invalid', perfil: 'admin', ativo: true, empresa_id: 2 });
    await assert.rejects(() => responsavelCheckout(1, { checkout_usuario_id: outro.id }), (e: any) => e.status === 409);
    await s.insert(RESOURCES.usuario_empresas, { usuario_id: outro.id, empresa_id: 1 });
    assert.equal(await responsavelCheckout(1, { checkout_usuario_id: outro.id }), Number(outro.id));
    await s.update(RESOURCES.usuarios, Number(outro.id), { ativo: false });
    await assert.rejects(() => responsavelCheckout(1, { checkout_usuario_id: outro.id }), (e: any) => e.status === 409);
    const dono = await s.insert(RESOURCES.usuarios, { nome: 'Responsável teste', email: 'dono@example.invalid', perfil: 'admin', ativo: true, empresa_id: 1 });
    donoId = Number(dono.id);
    await s.insert(RESOURCES.usuario_empresas, { usuario_id: donoId, empresa_id: 1 });
    await updateRecord(RESOURCES.commerce_configuracoes, configId, { checkout_usuario_id: donoId }, actor);
  });

  test('credencial no ambiente/canal não mascara gateway ausente, inválido ou de outro tenant', async () => {
    const anterior = process.env.MERCADOPAGO_ACCESS_TOKEN;
    const webhookAnterior = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'apenas-fixture';
    try {
      await s.insert(R_GATEWAY_CONFIGS, { empresa_id: 2, provider: 'mercadopago', ativo: true, credenciais_cifradas: cifrarSegredo('{"access_token":"teste-outro-tenant"}'), webhook_segredo_cifrado: cifrarSegredo('teste') });
      assert.equal((await pagamentoDaLoja(1)).configurado, false);
      process.env.MERCADOPAGO_WEBHOOK_SECRET = 'webhook-apenas-fixture';
      assert.equal((await pagamentoDaLoja(1)).configurado, true);
      assert.equal((await pagamentoDaLoja(1)).origem, 'ambiente_commerce');
      assert.equal((await s.list(R_GATEWAY_CONFIGS, { page: 1, pageSize: 10, filter: { empresa_id: 1 } })).total, 0, 'não copia credenciais de ambiente para o banco');
      assert.equal((await pagamentoDaLoja(3)).configurado, false, 'fallback jamais é global');
      const cfg = await s.insert(R_GATEWAY_CONFIGS, { empresa_id: 1, provider: 'mercadopago', ativo: true, ambiente: 'sandbox', credenciais_cifradas: 'cifra-inválida' });
      gatewayId = Number(cfg.id);
      assert.equal((await pagamentoDaLoja(1)).tem_token, false, 'linha inválida persistida não é escondida pelo ambiente');
      await s.update(R_GATEWAY_CONFIGS, gatewayId, { credenciais_cifradas: cifrarSegredo('{"access_token":"somente-fixture-de-teste"}'), webhook_segredo_cifrado: cifrarSegredo('webhook-somente-teste') });
      const r = await request(app).get('/api/commerce/loja/estado?empresa_id=2').expect(200);
      assert.equal(r.body.empresa_id, 1);
      assert.equal(r.body.abrir_loja, true, JSON.stringify(r.body));
      assert.equal(r.body.pagamento.conexao_validada, false);
      assert.ok(!JSON.stringify(r.body).includes('somente-fixture'));
      process.env.COMMERCE_LOJA_EMPRESA_ID = '2';
      assert.equal((await request(app).get('/api/commerce/loja/estado')).body.abrir_loja, false);
      process.env.COMMERCE_LOJA_EMPRESA_ID = 'inválido';
      assert.equal(await empresaDaVitrine(), null, 'env inválida nunca escolhe loja por fallback');
    } finally {
      process.env.COMMERCE_LOJA_EMPRESA_ID = '1';
      if (webhookAnterior === undefined) delete process.env.MERCADOPAGO_WEBHOOK_SECRET; else process.env.MERCADOPAGO_WEBHOOK_SECRET = webhookAnterior;
      if (anterior === undefined) delete process.env.MERCADOPAGO_ACCESS_TOKEN; else process.env.MERCADOPAGO_ACCESS_TOKEN = anterior;
    }
  });

  test('produto publicado aparece por slug; itens inválidos, preço zero, estoque e frete são recusados', async () => {
    const p = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: 'EXPOSURE-TEST', nome: 'Fixture isolada', preco_venda: 40, ativo: true });
    produtoId = Number(p.id);
    await s.insert(RESOURCES.commerce_produtos, { empresa_id: 1, produto_id: produtoId, slug: 'fixture-isolada' });
    const pub = await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: 1, produto_id: produtoId, canal: 'BROBOND', estado: 'DRAFT', versao: 1 });
    assert.equal((await request(app).get('/api/loja/produtos')).body.produtos.length, 0);
    await s.update(RESOURCES.commerce_publicacoes, Number(pub.id), { estado: 'PUBLISHED' });
    await s.insert(RESOURCES.estoques, { empresa_id: 1, produto_id: produtoId, local_id: 1, local: 'Acabados', quantidade: 10 });
    const lista = await request(app).get('/api/loja/produtos').expect(200);
    assert.equal(lista.body.produtos[0].slug, 'fixture-isolada');
    const detalhe = await request(app).get('/api/loja/produtos/fixture-isolada').expect(200);
    assert.equal(detalhe.body.produto.preco, 40);
    const preview = await request(app).post('/api/loja/preview').send({ itens: itens() }).expect(200);
    assert.deepEqual(preview.body.totais, { subtotal: 80, frete: 18.5, desconto: 0, total: 98.5 });
    for (const quantidade of [1.5, 0, 100]) await request(app).post('/api/loja/preview').send({ itens: [{ ...itens()[0], quantidade }] }).expect(400);
    await request(app).post('/api/loja/preview').send({ itens: [...itens(), ...itens()] }).expect(400);
    await request(app).post('/api/loja/checkout').send({ chave: 'teste-sem-estoque', comprador, itens: [{ ...itens()[0], quantidade: 11 }] }).expect(409);
    await s.update(RESOURCES.produtos, produtoId, { preco_venda: 0 });
    await request(app).post('/api/loja/preview').send({ itens: itens() }).expect(409);
    await s.update(RESOURCES.produtos, produtoId, { preco_venda: 40 });
    await updateRecord(RESOURCES.commerce_configuracoes, configId, { frete_provedor: 'nenhum' }, actor);
    await request(app).post('/api/loja/checkout').send({ chave: 'teste-sem-frete', comprador, itens: itens() }).expect(409);
    await updateRecord(RESOURCES.commerce_configuracoes, configId, { frete_provedor: 'retirada' }, actor);
  });

  test('checkout com adapter SOMENTE de teste reserva antes do pagamento, persiste pedido, total e token, sem duplicar', async () => {
    registrarProvider({ ...mercadopagoProvider, async criaCobranca(_ctx, input) {
      cobrancas++;
      assert.equal(input.valor, 80, 'valor do cliente não é autoridade');
      const reservas = await s.list(RESOURCES.estoque_reservas, { page: 1, pageSize: 100, filter: { empresa_id: 1, produto_id: produtoId, status: 'ativa' } });
      assert.equal(reservas.total, 1, 'reserva existe antes do adapter de pagamento');
      return { provider_ref: 'somente-teste-sem-rede', status: 'pendente', copia_cola: 'fixture-pix-sem-valor-financeiro' };
    } });
    try {
      const body = { chave: 'checkout-exposure-teste', itens: itens(), comprador, total: 0.01, frete: 0, preco: 0.01 };
      const criado = await request(app).post('/api/loja/checkout').send(body).expect((r) => { assert.equal(r.status, 201, JSON.stringify(r.body)); });
      assert.equal(criado.body.pedido.total, 80);
      assert.equal(criado.body.pedido.estado, 'AGUARDANDO_PAGAMENTO');
      assert.match(criado.body.pedido.checkout_token, /^[a-f0-9]{64}$/);
      const repetido = await request(app).post('/api/loja/checkout').send(body).expect(200);
      assert.equal(repetido.body.idempotente, true);
      assert.equal(repetido.body.sale_id, criado.body.sale_id);
      assert.equal(cobrancas, 1);
      const acompanhamento = await request(app).get(`/api/loja/pedidos/${criado.body.pedido.checkout_token}`).expect(200);
      assert.equal(acompanhamento.body.itens[0].quantidade, 2);
      assert.equal(acompanhamento.body.pagamento.provider, 'mercadopago');
      const pedidos = await s.list(RESOURCES.commerce_pedidos, { page: 1, pageSize: 100, filter: { empresa_id: 1 } });
      assert.equal(pedidos.total, 1);
      assert.equal((await s.get(R_GATEWAY_COBRANCAS, Number(pedidos.rows[0].cobranca_id)))?.valor, 80);
      process.env.COMMERCE_LOJA_EMPRESA_ID = '2';
      await s.insert(RESOURCES.commerce_configuracoes, { empresa_id: 2, loja_nome: 'Tenant teste 2', frete_provedor: 'retirada' });
      await request(app).get(`/api/loja/pedidos/${criado.body.pedido.checkout_token}`).expect(404);
    } finally { registrarProvider(mercadopagoProvider); process.env.COMMERCE_LOJA_EMPRESA_ID = '1'; }
  });

  test('Mercado Pago usa idempotência na API oficial e manifesto de assinatura com ponto e vírgula final', async (t) => {
    const chamadas: RequestInit[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      chamadas.push(init);
      return new globalThis.Response(JSON.stringify({ id: 123, status: 'pending' }), { status: 200 });
    });
    const ctx = { empresaId: 1, config: null, credenciais: { access_token: 'fixture-sem-rede' }, webhookSegredo: 'segredo-teste' };
    await mercadopagoProvider.criaCobranca(ctx, { valor: 80, metodo: 'pix', payer_email: comprador.email, referencia: 'checkout:teste-estavel' });
    assert.equal((chamadas[0].headers as Record<string, string>)['X-Idempotency-Key'], 'checkout:teste-estavel');
    const corpo = JSON.stringify({ id: 'notificacao-1', type: 'payment', data: { id: 'ABC123' } });
    const ts = '1793293200';
    const requestId = 'Request-ID-Com-Maiusculas';
    const assinatura = createHmac('sha256', 'segredo-teste').update(`id:abc123;request-id:${requestId};ts:${ts};`).digest('hex');
    assert.equal(mercadopagoProvider.verificaAssinatura(ctx, corpo, { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${assinatura}` }), true);
    assert.notEqual(mercadopagoProvider.parseWebhook(corpo)?.evento_id, mercadopagoProvider.parseWebhook(corpo.replace('notificacao-1', 'notificacao-2'))?.evento_id);
  });

  test('webhook assinado consulta status real, trata atualizações e duplicatas e mantém pedido rastreável', async () => {
    const webhookApp = express();
    webhookApp.use(publicGatewayRouter);
    const pedidos = await s.list(RESOURCES.commerce_pedidos, { page: 1, pageSize: 10, filter: { empresa_id: 1 } });
    const pedido = pedidos.rows[0];
    const { confirmarPagamentoCobranca } = await import('../src/commerce/pedidos');
    let status = 'pending';
    registrarProvider({ ...mercadopagoProvider, async consultaCobranca(_ctx, ref) {
      return { provider_ref: ref, status: status === 'approved' ? 'paga' : 'pendente', bruto: { status } };
    } });
    setOnCobrancaAlterada(confirmarPagamentoCobranca);
    const enviar = (id: string, assinado = true) => {
      const dataId = 'somente-teste-sem-rede';
      const ts = '1793293200';
      const reqId = 'Request-ID-Teste';
      const sig = createHmac('sha256', 'webhook-somente-teste').update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest('hex');
      return request(webhookApp).post('/api/gateway/webhooks/mercadopago')
        .set('x-request-id', reqId).set('x-signature', `ts=${ts},v1=${assinado ? sig : '0'.repeat(64)}`)
        .send({ id, type: 'payment', data: { id: dataId }, status: 'approved' });
    };
    try {
      await enviar('notif-invalida', false).expect(401);
      await enviar('notif-pendente').expect(200);
      assert.equal((await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))?.status, 'pendente', 'body não assinado não substitui consulta oficial pendente');
      status = 'approved';
      await enviar('notif-aprovada').expect(200);
      const duplicado = await enviar('notif-aprovada').expect(200);
      assert.equal(duplicado.body.duplicado, true);
      const atual = await s.get(RESOURCES.commerce_pedidos, Number(pedido.id));
      assert.ok(['PAGO', 'AGUARDANDO_CORRECAO', 'CONVERTIDO'].includes(String(atual?.estado)));
      assert.equal((await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)))?.status, 'paga');
      const publico = await request(app).get(`/api/loja/pedidos/${pedido.checkout_token}`).expect(200);
      assert.equal(publico.body.pedido.total, 80);
      assert.equal(publico.body.sale_id, pedido.sale_id);
    } finally { setOnCobrancaAlterada(null); registrarProvider(mercadopagoProvider); }
  });

  test('wiring de produção mantém autenticação e todas as rotas públicas; nenhum placeholder em Commerce/Creators', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(index.indexOf("app.get('/api/commerce/loja/estado'") > index.indexOf("app.use('/api', wrap(requireAuth))"));
    const appSource = readFileSync(new URL('../../client/src/App.tsx', import.meta.url), 'utf8');
    for (const route of ['/loja', '/loja/produto/:slug', '/loja/carrinho', '/loja/checkout', '/loja/pedido/:token']) assert.ok(appSource.includes(`path="${route}"`));
    const modules = readFileSync(new URL('../../client/src/modules.ts', import.meta.url), 'utf8');
    const scope = modules.slice(modules.indexOf("id: 'conector-mercadolivre'"), modules.indexOf('// 11. UTILIDADES GLOBAIS'));
    assert.doesNotMatch(scope, /planned\s*:|em breve|coming_soon/i);
    for (const path of ['/commerce/loja', '/creators', '/matches', '/outreach-ai', '/campanhas']) assert.ok(scope.includes(`path: '${path}'`));
  });
});
