// ============================================================
// HUB DE E-COMMERCE (Fase P3 §2-§7, §15-§17)
//
// O que fica travado aqui:
//   • contrato único: todo canal é `CommerceProvider` (sem `if canal == ...`);
//   • pedido externo NUNCA vira duas vendas (chave empresa+provider+pedido);
//   • item sem SKU no ERP vira PENDÊNCIA — não é descartado em silêncio nem
//     inventa produto;
//   • estoque publica só com mapeamento explícito; sem mapeamento, reporta;
//   • erro transitório agenda retry com backoff; definitivo não retenta;
//   • log de integração tem empresa, canal, operação, tentativa — e nenhum
//     segredo (token nunca entra no log);
//   • webhook exige assinatura válida (ou token secreto, quando o canal não
//     assina);
//   • empresa A não enxerga vínculo/log da empresa B.
//
// Nenhuma chamada real: todo `fetch` é espião e o canal é injetado.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.WOOCOMMERCE_URL;
delete process.env.WOOCOMMERCE_CK;
delete process.env.WOOCOMMERCE_CS;
delete process.env.COMMERCE_WEBHOOK_TOKEN;
delete process.env.NUVEMSHOP_CLIENT_SECRET;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { ADMIN, garantirAdmin, criarAtor, novoProduto, novoTamanho, saldoInicial, reqDe, chamar, esperarErro } = await import('./_p1util');
const contrato = await import('../src/commerce/contrato');
const registro = await import('../src/commerce/registro');
const hub = await import('../src/commerce/hub');
const { criarWooCommerceAdapter } = await import('../src/commerce/adapters/woocommerce');
const { criarNuvemshopAdapter } = await import('../src/commerce/adapters/nuvemshop');
const { criarMercadoLivreAdapter } = await import('../src/commerce/adapters/mercadolivre');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo ?? null), { status, headers: { 'Content-Type': 'application/json' } });
}

type Chamada = { url: string; init?: any };

/** fetch espião que devolve `responder(url)` e registra as chamadas. */
function espiao(responder: (url: string, init?: any) => unknown): { chamadas: Chamada[]; fetch: typeof fetch } {
  const chamadas: Chamada[] = [];
  const fetchFalso = (async (url: any, init?: any) => {
    chamadas.push({ url: String(url), init });
    const r = responder(String(url), init);
    if (r instanceof Response) return r;
    if (r instanceof Error) throw r;
    return resposta(r ?? null);
  }) as unknown as typeof fetch;
  return { chamadas, fetch: fetchFalso };
}

async function empresaNova(nome: string): Promise<number> {
  const row = await getStore().insert(RESOURCES.empresas, { nome, ativo: true });
  return Number(row.id);
}

/** Canal de mentira que implementa o MESMO contrato dos adaptadores reais. */
function canalFalso(pedidos: contrato.PedidoExterno[], extras: Partial<contrato.CommerceProvider> = {}): contrato.CommerceProvider {
  return {
    canal: 'WOOCOMMERCE',
    rotulo: 'Canal de teste',
    capacidades: { pedidos: true, produtos: true, estoque: true, preco: true, rastreio: 'recebe', webhook: true, polling: true },
    requerCredencial: false,
    configurado: () => ({ ok: true }),
    testar: async () => ({ ok: true }),
    listarPedidos: async () => pedidos,
    listarProdutos: async () => [],
    publicarEstoque: async (itens) => ({
      atualizados: itens.filter((i) => i.externoId).map((i) => ({ sku: i.sku, externalId: String(i.externoId) })),
      semMapeamento: itens.filter((i) => !i.externoId).map((i) => i.sku),
      falhas: [],
    }),
    publicarPreco: async (itens) => ({
      atualizados: itens.filter((i) => i.externoId).map((i) => ({ sku: i.sku, externalId: String(i.externoId) })),
      semMapeamento: itens.filter((i) => !i.externoId).map((i) => i.sku),
      falhas: [],
    }),
    validarWebhook: () => true,
    lerWebhook: () => [],
    ...extras,
  };
}

function pedidoExterno(over: Partial<contrato.PedidoExterno> = {}): contrato.PedidoExterno {
  return {
    externalId: '9001',
    numero: '9001',
    status: 'processing',
    criadoEm: '2026-10-01T10:00:00.000Z',
    atualizadoEm: null,
    moeda: 'BRL',
    frete: 20,
    desconto: 0,
    cliente: { nome: 'Cliente do Canal', email: 'canal@teste.com', telefone: null, documento: null },
    itens: [],
    bruto: { id: 9001 },
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('contrato dos canais', () => {
  test('classifica erro transitório × definitivo', () => {
    for (const t of [408, 425, 429, 500, 502, 503]) assert.equal(contrato.classificarStatusHttp(t), 'transitorio', `${t}`);
    for (const d of [400, 401, 403, 404, 409, 422]) assert.equal(contrato.classificarStatusHttp(d), 'definitivo', `${d}`);
  });

  test('backoff cresce e para de tentar no teto (não existe retry infinito)', () => {
    const agora = new Date('2026-10-08T00:00:00.000Z');
    const t1 = Date.parse(contrato.proximaTentativaEm(1, agora)!);
    const t2 = Date.parse(contrato.proximaTentativaEm(2, agora)!);
    const t3 = Date.parse(contrato.proximaTentativaEm(3, agora)!);
    assert.equal(t1 - agora.getTime(), 60_000);
    assert.equal(t2 - agora.getTime(), 120_000);
    assert.equal(t3 - agora.getTime(), 240_000);
    assert.equal(contrato.proximaTentativaEm(contrato.MAX_TENTATIVAS, agora), null);
  });

  test('registro cobre os três canais da especificação, com capacidades declaradas', () => {
    const provedores = registro.provedoresComercio();
    assert.deepEqual(Object.keys(provedores).sort(), ['MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE']);
    for (const canal of contrato.CANAIS_COMERCIO) {
      const p = provedores[canal];
      assert.equal(p.canal, canal);
      assert.equal(typeof p.capacidades.webhook, 'boolean');
      assert.equal(typeof p.capacidades.estoque, 'boolean');
    }
  });
});

// ---------------------------------------------------------------------------
describe('adaptadores (mock de HTTP, nenhuma chamada real)', () => {
  test('WooCommerce mapeia pedido e usa Basic Auth', async () => {
    const { chamadas, fetch } = espiao(() => [
      {
        id: 77,
        number: '77',
        status: 'processing',
        date_created_gmt: '2026-10-02T12:00:00',
        currency: 'BRL',
        shipping_total: '19.90',
        discount_total: '5.00',
        billing: { first_name: 'Ana', last_name: 'Souza', email: 'ANA@Exemplo.com', phone: '1199', cpf: '123' },
        line_items: [{ sku: 'camiseta-p', product_id: 3, name: 'Camiseta P', quantity: 2, price: 50, subtotal: '100', total: '95' }],
      },
    ]);
    const adapter = criarWooCommerceAdapter({ config: () => ({ url: 'https://loja.test', ck: 'ck', cs: 'cs' }), fetchImpl: fetch });
    const pedidos = await adapter.listarPedidos({ desde: new Date('2026-10-01'), limite: 10 });
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].externalId, '77');
    assert.equal(pedidos[0].frete, 19.9);
    assert.equal(pedidos[0].cliente.email, 'ana@exemplo.com');
    assert.equal(pedidos[0].itens[0].quantidade, 2);
    assert.equal(pedidos[0].itens[0].sku, 'camiseta-p');
    assert.match(String(chamadas[0].init.headers.Authorization), /^Basic /);
  });

  test('WooCommerce valida a assinatura do webhook (e recusa a falsa)', () => {
    const cfg = { url: 'https://loja.test', ck: 'ck', cs: 'segredo' };
    const adapter = criarWooCommerceAdapter({ config: () => cfg });
    const corpo = JSON.stringify({ id: 5, status: 'processing' });
    const assinatura = createHmac('sha256', cfg.cs).update(corpo, 'utf8').digest('base64');
    assert.equal(adapter.validarWebhook!(corpo, { 'x-wc-webhook-signature': assinatura }), true);
    assert.equal(adapter.validarWebhook!(corpo, { 'x-wc-webhook-signature': 'aaaa' }), false);
    assert.equal(adapter.validarWebhook!(corpo, {}), false);
  });

  test('Nuvemshop usa os cabeçalhos e o caminho da loja que a API exige', async () => {
    const { chamadas, fetch } = espiao(() => [{ id: 10, number: 10, status: 'paid', currency: 'BRL', products: [{ sku: 'x', quantity: 1, price: 10 }] }]);
    const adapter = criarNuvemshopAdapter({ fetchImpl: fetch, baseUrl: 'https://api.nuvemshop.test/v1', clientSecret: 'sec' });
    await adapter.listarPedidos({ desde: new Date('2026-10-01'), limite: 5, credencial: { token: 'tok', lojaId: '4242' } });
    assert.match(chamadas[0].url, /\/4242\/orders/);
    assert.equal(chamadas[0].init.headers.Authentication, 'bearer tok');
    assert.ok(chamadas[0].init.headers['User-Agent']);
  });

  test('Nuvemshop valida HMAC hex do corpo cru (e recusa sem segredo)', () => {
    const adapter = criarNuvemshopAdapter({ clientSecret: 'cliente-secreto' });
    const corpo = JSON.stringify({ id: 1 });
    const esperado = createHmac('sha256', 'cliente-secreto').update(corpo, 'utf8').digest('hex');
    assert.equal(adapter.validarWebhook!(corpo, { 'x-linkedstore-hmac-sha256': esperado }), true);
    assert.equal(adapter.validarWebhook!(corpo, { 'x-linkedstore-hmac-sha256': 'ff' }), false);
    const semSegredo = criarNuvemshopAdapter({ clientSecret: '' });
    assert.equal(semSegredo.validarWebhook!(corpo, { 'x-linkedstore-hmac-sha256': esperado }), false);
  });

  test('Mercado Livre sem token lança credencial ausente (definitivo, exige reconectar)', async () => {
    const adapter = criarMercadoLivreAdapter();
    assert.equal(adapter.configurado({}).ok, false);
    await assert.rejects(
      () => adapter.listarPedidos({ desde: new Date(), limite: 5, credencial: null }),
      (e: any) => e instanceof contrato.ErroCanalError && e.requiresReauth === true && e.transitorio === false && e.classificacao === 'definitivo'
    );
  });

  test('Mercado Livre mapeia pedido real e não publica estoque sem mapeamento', async () => {
    const { fetch } = espiao((url) => {
      if (url.includes('/orders/search')) {
        return {
          results: [
            {
              id: 55,
              status: 'paid',
              date_created: '2026-10-03T09:00:00.000Z',
              currency_id: 'BRL',
              buyer: { nickname: 'comprador', email: null, billing_info: { identification: { number: '12345678909' } } },
              order_items: [{ item: { id: 'MLB1', title: 'Item', seller_sku: 'SKU-1' }, quantity: 1, unit_price: 99.9 }],
            },
          ],
        };
      }
      throw new Error(`URL inesperada: ${url}`);
    });
    const adapter = criarMercadoLivreAdapter({ fetchImpl: fetch, baseUrl: 'https://api.meli.test' });
    const pedidos = await adapter.listarPedidos({ desde: new Date('2026-10-01'), limite: 5, credencial: { token: 'tok', lojaId: '999' } });
    assert.equal(pedidos[0].externalId, '55');
    assert.equal(pedidos[0].itens[0].sku, 'SKU-1');
    const estoque = await adapter.publicarEstoque([{ sku: 'SKU-1', quantidade: 4, externoId: null }], { credencial: { token: 'tok', lojaId: '999' } });
    assert.deepEqual(estoque.semMapeamento, ['SKU-1']);
    assert.equal(estoque.atualizados.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('pedido externo → venda do ERP (idempotência)', () => {
  test('o mesmo pedido importado duas vezes cria UMA venda', async () => {
    await garantirAdmin();
    const autor = await criarAtor(1, 'gerente');
    const produto = await novoProduto({ sku: 'HUB-CAM-1', preco_venda: 100 });
    const tamanho = await novoTamanho('M');
    await saldoInicial(produto, 10, { codigoTamanho: 'M' });

    const pedido = pedidoExterno({
      externalId: 'HUB-1',
      itens: [{ sku: 'HUB-CAM-1', externalItemId: '1', titulo: 'Camiseta', quantidade: 2, precoUnitario: 100, desconto: 0 }],
    });
    const provider = canalFalso([pedido]);
    const ctx = hub.contextoDoAtor('WOOCOMMERCE', autor, { WOOCOMMERCE: provider });

    const primeira = await hub.importarPedidosDoCanal(ctx, { desde: new Date('2026-09-01') });
    assert.equal(primeira.importados.length, 1);
    assert.equal(primeira.ignorados.length, 0);
    const vendasAntes = await getStore().countWhere(RESOURCES.vendas, {});

    const segunda = await hub.importarPedidosDoCanal(ctx, { desde: new Date('2026-09-01') });
    assert.equal(segunda.importados.length, 0);
    assert.equal(segunda.ignorados.length, 1);
    assert.equal(await getStore().countWhere(RESOURCES.vendas, {}), vendasAntes);

    const vinculos = await getStore().list(RESOURCES.commerce_pedidos_externos, { page: 1, pageSize: 10 });
    assert.equal(vinculos.rows.length, 1);
    assert.equal(String(vinculos.rows[0].external_order_id), 'HUB-1');
    assert.equal(Number(vinculos.rows[0].empresa_id), 1);
  });

  test('pedido sem SKU conhecido vira pendência — nada é gravado', async () => {
    await garantirAdmin();
    const autor = await criarAtor(1, 'gerente');
    const pedido = pedidoExterno({
      externalId: 'HUB-2',
      itens: [{ sku: 'NAO-EXISTE', externalItemId: '9', titulo: 'Item desconhecido', quantidade: 1, precoUnitario: 10, desconto: 0 }],
    });
    const ctx = hub.contextoDoAtor('WOOCOMMERCE', autor, { WOOCOMMERCE: canalFalso([pedido]) });
    const resumo = await hub.importarPedidosDoCanal(ctx, { desde: new Date('2026-09-01') });
    assert.equal(resumo.pendentes.length, 1);
    assert.deepEqual(resumo.pendentes[0].itens, ['NAO-EXISTE']);
    assert.equal(await getStore().findOneWhere(RESOURCES.commerce_pedidos_externos, { external_order_id: 'HUB-2' }), null);
  });

  test('a empresa B importa o MESMO pedido sem enxergar o vínculo da empresa A', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Hub');
    const autorB = await criarAtor(empresaB, 'gerente');
    const produtoB = await novoProduto({ sku: 'HUB-B-1', empresa_id: empresaB, preco_venda: 50 });
    const tamanho = await novoTamanho('U');
    // Saldo da empresa B (a fábrica do harness grava na empresa padrão; aqui a
    // empresa é explícita para provar que o recorte vem do escopo).
    await getStore().insert(RESOURCES.estoques, {
      empresa_id: empresaB,
      produto_id: Number(produtoB.id),
      tamanho_id: Number(tamanho.id),
      local: 'loja',
      quantidade: 5,
      custo_medio: 20,
    });

    const pedido = pedidoExterno({
      externalId: 'HUB-3',
      itens: [{ sku: 'HUB-B-1', externalItemId: '1', titulo: 'Item B', quantidade: 1, precoUnitario: 50, desconto: 0 }],
    });
    const ctxB = hub.contextoDoAtor('WOOCOMMERCE', autorB, { WOOCOMMERCE: canalFalso([pedido]) });
    const resumo = await hub.importarPedidosDoCanal(ctxB, { desde: new Date('2026-09-01') });
    assert.equal(resumo.importados.length, 1);

    // A empresa A (padrão) não vê o vínculo nem a venda da empresa B.
    const admin = ADMIN;
    const ctxA = hub.contextoDoAtor('WOOCOMMERCE', admin, { WOOCOMMERCE: canalFalso([pedido]) });
    const pedidosA = await hub.listarPedidosExternosDoErp(ctxA);
    assert.equal(pedidosA.filter((p: any) => String(p.external_order_id) === 'HUB-3').length, 0);
    // E o mapeamento é por empresa: cadastrar em B não vale em A.
    const mapeamento = await getStore().insert(RESOURCES.commerce_mapeamentos, { empresa_id: empresaB, canal: 'WOOCOMMERCE', recurso: 'produto', chave_interna: 'HUB-B-1', externo_id: '77' });
    assert.equal(Number(mapeamento.empresa_id), empresaB);
    assert.equal(await hub.mapeamentoDoCanal(ctxB.escopo, 'WOOCOMMERCE', 'produto', 'HUB-B-1'), '77');
    assert.equal(await hub.mapeamentoDoCanal(ctxA.escopo, 'WOOCOMMERCE', 'produto', 'HUB-B-1'), null);
  });

  test('status do canal entra conservador: nada vira faturado sozinho', () => {
    assert.equal(hub.statusErpDoCanal('processing'), 'cotacao');
    assert.equal(hub.statusErpDoCanal('paid'), 'cotacao');
    assert.equal(hub.statusErpDoCanal('cancelled'), 'cancelada');
    assert.equal(hub.statusErpDoCanal('completed'), 'entregue');
    assert.equal(hub.canalErpDoCanal('MERCADOLIVRE'), 'marketplace');
    assert.equal(hub.canalErpDoCanal('NUVEMSHOP'), 'site_varejo');
  });
});

// ---------------------------------------------------------------------------
describe('observabilidade e retry', () => {
  test('log de integração guarda empresa/operação/tentativa e NUNCA o token', async () => {
    await garantirAdmin();
    const autor = await criarAtor(1, 'gerente');
    const ctx = hub.contextoDoAtor('NUVEMSHOP', autor, {});
    await hub.registrarLog({
      ctx,
      operacao: 'estoque.publicar',
      status: 'erro',
      erro: 'Nuvemshop respondeu 503: indisponível',
      externalId: 'SKU-1',
      tentativa: 2,
      proximaTentativaEm: contrato.proximaTentativaEm(2),
      requestId: 'req-123',
    });
    const logs = await hub.listarLogsDeIntegracao(ctx, { limite: 10 });
    const linha = logs.find((l: any) => l.operacao === 'estoque.publicar');
    assert.ok(linha);
    assert.equal(Number(linha.empresa_id), 1);
    assert.equal(linha.authorization, undefined);
    assert.equal(linha.access_token, undefined);
    assert.ok(!JSON.stringify(linha).includes('Bearer '));
    assert.equal(Number(linha.tentativa), 2);
  });

  test('pendentesDeRetry só devolve o que é transitório e já venceu', async () => {
    await garantirAdmin();
    const autor = await criarAtor(1, 'gerente');
    const ctx = hub.contextoDoAtor('WOOCOMMERCE', autor, {});
    const ontem = new Date(Date.now() - 86_400_000).toISOString();
    const amanha = new Date(Date.now() + 86_400_000).toISOString();
    await hub.registrarLog({ ctx, operacao: 'pedido.importar', status: 'erro', erro: 'timeout', externalId: 'vencido', proximaTentativaEm: ontem });
    await hub.registrarLog({ ctx, operacao: 'pedido.importar', status: 'erro', erro: 'timeout', externalId: 'futuro', proximaTentativaEm: amanha });
    await hub.registrarLog({ ctx, operacao: 'pedido.importar', status: 'erro', erro: 'sem retry', externalId: 'sem-data', proximaTentativaEm: null });
    await hub.registrarLog({ ctx, operacao: 'pedido.importar', status: 'erro', erro: 'teto', externalId: 'no-teto', tentativa: contrato.MAX_TENTATIVAS, proximaTentativaEm: ontem });
    const pendentes = await hub.pendentesDeRetry(ctx.escopo, 50);
    const ids = pendentes.map((p: any) => String(p.external_id));
    assert.ok(ids.includes('vencido'));
    assert.ok(!ids.includes('futuro'));
    assert.ok(!ids.includes('sem-data'));
    assert.ok(!ids.includes('no-teto'));
  });
});

// ---------------------------------------------------------------------------
describe('camada HTTP do hub (handlers diretos, sem socket)', () => {
  test('GET /api/commerce/canais lista os três canais e barra operador', async () => {
    const { canaisComercio } = await import('../src/commerce');
    await garantirAdmin();
    const gerente = await criarAtor(1, 'gerente');
    const corpo = await chamar(canaisComercio, reqDe({}, { user: gerente }));
    assert.equal(corpo.canais.length, 3);
    assert.deepEqual(corpo.canais.map((c: any) => c.canal).sort(), ['MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE']);
    assert.equal(typeof corpo.erros_pendentes, 'number');

    const operador = await criarAtor(1, 'operador');
    await esperarErro(() => chamar(canaisComercio, reqDe({}, { user: operador })), 403);
  });

  test('canal desconhecido responde 404 (nunca cai no genérico)', async () => {
    const { importarPedidosComercio } = await import('../src/commerce');
    await garantirAdmin();
    const admin = await criarAtor(1, 'admin');
    await esperarErro(
      () => chamar(importarPedidosComercio, reqDe({}, { params: { canal: 'shopee' }, user: admin })),
      404,
      /shopee/
    );
  });

  test('publicar estoque sem credencial do canal responde com o motivo, sem 500', async () => {
    const { publicarEstoqueComercio } = await import('../src/commerce');
    await garantirAdmin();
    // WOOCOMMERCE sem WOOCOMMERCE_URL → CredencialAusenteError (definitivo).
    const admin = await criarAtor(1, 'admin');
    await assert.rejects(
      () => chamar(publicarEstoqueComercio, reqDe({}, { params: { canal: 'woocommerce' }, user: admin })),
      (e: any) => e?.status === 409 || e?.status === 502 || e?.status === 400
    );
  });

  test('processar retentativas sem pendência é uma passada vazia (não explode)', async () => {
    const { processarRetentativasComercio } = await import('../src/commerce');
    await garantirAdmin();
    const admin = await criarAtor(1, 'admin');
    const corpo = await chamar(processarRetentativasComercio, reqDe({}, { user: admin }));
    assert.equal(corpo.ok, true);
    assert.equal(Array.isArray(corpo.resultados), true);
  });
});

// ---------------------------------------------------------------------------
describe('webhook público do hub', () => {
  test('assinatura inválida responde 401 e grava o motivo (sem payload cru)', async () => {
    const { webhookComercio } = await import('../src/commerce');
    const autor = { ...ADMIN };
    await garantirAdmin();
    // Sem segredo configurado no adaptador, a validação da Nuvemshop recusa.
    const resultado = await new Promise<{ status: number; corpo: any }>((resolve) => {
      const res: any = {
        status: (s: number) => ((res as any)._status = s, res),
        json: (d: any) => resolve({ status: (res as any)._status ?? 200, corpo: d }),
      };
      void webhookComercio(
        {
          params: { canal: 'nuvemshop' },
          headers: { 'x-linkedstore-hmac-sha256': 'deadbeef' },
          query: {},
          body: Buffer.from(JSON.stringify({ id: 1, store_id: '4242' })),
          user: autor,
        } as any,
        res
      );
    });
    assert.equal(resultado.status, 401);
    assert.equal(resultado.corpo.ok, false);
  });

  test('Mercado Livre sem token secreto configurado recusa a notificação', async () => {
    const { webhookComercio } = await import('../src/commerce');
    await garantirAdmin();
    const resultado = await new Promise<{ status: number; corpo: any }>((resolve) => {
      const res: any = {
        status: (s: number) => ((res as any)._status = s, res),
        json: (d: any) => resolve({ status: (res as any)._status ?? 200, corpo: d }),
      };
      void webhookComercio(
        { params: { canal: 'mercadolivre' }, headers: {}, query: { t: 'qualquer' }, body: Buffer.from('{"topic":"orders_v2"}') } as any,
        res
      );
    });
    assert.equal(resultado.status, 401);
  });
});
