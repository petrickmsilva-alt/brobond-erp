// ============================================================
// Integração com a loja (WooCommerce) — server/src/loja.ts
//
// O que precisa ficar travado aqui (é o que dá prejuízo se quebrar):
//   • importar pedido cria a Venda com os itens certos e o canal da loja;
//   • reimportar NÃO duplica (idempotência por vendas.pedido_cliente);
//   • item sem SKU no ERP não entra calado — volta em `pendentes`;
//   • o estoque enviado usa o saldo do ERP e nunca inventa produto na loja;
//   • falha de rede/credencial vira 502 com mensagem em português (não 500);
//   • sem variáveis de ambiente, o endpoint avisa 409 em vez de quebrar.
//
// Nenhum teste faz chamada real: `fetch` é substituído por um espião.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.WOOCOMMERCE_URL;
delete process.env.WOOCOMMERCE_CK;
delete process.env.WOOCOMMERCE_CS;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { configLoja, importarPedidosLoja, sincronizarEstoqueLoja } = await import('../src/loja');

const LOJA = 'https://brobond.com.br';

type Chamada = { url: string; init?: RequestInit };

/** Substitui o fetch global por um espião que responde conforme o caminho. */
function espionarFetch(responder: (url: string, init?: RequestInit) => unknown): { chamadas: Chamada[]; restaurar: () => void } {
  const chamadas: Chamada[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    const corpo = responder(String(url), init);
    if (corpo instanceof Error) throw corpo;
    return new Response(JSON.stringify(corpo ?? null), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    chamadas,
    restaurar: () => {
      globalThis.fetch = original;
    },
  };
}

function comLoja<T>(fn: () => Promise<T>): Promise<T> {
  process.env.WOOCOMMERCE_URL = LOJA;
  process.env.WOOCOMMERCE_CK = 'ck_teste';
  process.env.WOOCOMMERCE_CS = 'cs_teste';
  return fn().finally(() => {
    delete process.env.WOOCOMMERCE_URL;
    delete process.env.WOOCOMMERCE_CK;
    delete process.env.WOOCOMMERCE_CS;
  });
}

function reqDe(perfil: 'admin' | 'operador' = 'admin', body: Record<string, unknown> = {}): any {
  return {
    headers: {},
    params: {},
    query: {},
    body,
    user: { id: 1, name: 'Admin Teste', perfil },
    socket: { remoteAddress: '203.0.113.10' },
  };
}

function resFake(): { res: any; saida: { json?: any; status?: number } } {
  const saida: { json?: any; status?: number } = {};
  const res: any = { json: (d: any) => ((saida.json = d), res), status: (s: number) => ((saida.status = s), res) };
  return { res, saida };
}

let seq = 0;
async function novoProduto(dados: Record<string, unknown> = {}) {
  seq++;
  return getStore().insert(RESOURCES.produtos, {
    sku: String(dados.sku ?? `SKU-${seq}`),
    nome: dados.nome ?? `Produto ${seq}`,
    preco_venda: dados.preco_venda ?? 90,
    preco_atacado: dados.preco_atacado ?? 70,
    exibir_site: true,
    ativo: true,
    ...dados,
  });
}

/** Reaproveita o tamanho se ele já existir (o banco em memória é compartilhado). */
async function novoTamanho(codigo: string) {
  const existente = await getStore().findOneWhere(RESOURCES.tamanhos, { codigo });
  if (existente) return existente;
  return getStore().insert(RESOURCES.tamanhos, { codigo, ordem: 1 });
}

describe('configLoja — configuração', () => {
  test('sem variáveis de ambiente a loja fica desconfigurada', () => {
    assert.equal(configLoja(), null);
  });

  test('aceita a URL com ou sem esquema e sem barra final', () => {
    process.env.WOOCOMMERCE_URL = 'brobond.com.br/';
    process.env.WOOCOMMERCE_CK = 'ck';
    process.env.WOOCOMMERCE_CS = 'cs';
    try {
      assert.deepEqual(configLoja(), { url: LOJA, ck: 'ck', cs: 'cs' });
    } finally {
      delete process.env.WOOCOMMERCE_URL;
      delete process.env.WOOCOMMERCE_CK;
      delete process.env.WOOCOMMERCE_CS;
    }
  });

  test('URL que não é http(s) não configura a loja', () => {
    process.env.WOOCOMMERCE_URL = 'javascript:alert(1)';
    process.env.WOOCOMMERCE_CK = 'ck';
    process.env.WOOCOMMERCE_CS = 'cs';
    try {
      assert.equal(configLoja(), null);
    } finally {
      delete process.env.WOOCOMMERCE_URL;
      delete process.env.WOOCOMMERCE_CK;
      delete process.env.WOOCOMMERCE_CS;
    }
  });

  test('sem configuração o endpoint avisa 409 em vez de quebrar', async () => {
    const { res } = resFake();
    await assert.rejects(
      () => importarPedidosLoja(reqDe(), res),
      (e: any) => e.status === 409
    );
  });
});

describe('Importação de pedidos da loja', () => {
  test('pedido da loja vira Venda com itens, cliente e canal site_varejo', async () => {
    await comLoja(async () => {
      const produto = await novoProduto({ sku: 'CAM-BB-AZUL', nome: 'Camiseta Bordada BB Azul', preco_venda: 90 });
      const tamanho = await novoTamanho('M');
      await getStore().insert(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(tamanho.id), quantidade: 12 });

      const { chamadas, restaurar } = espionarFetch((url) =>
        url.includes('/orders?')
          ? [
              {
                id: 5001,
                number: '5001',
                status: 'processing',
                date_created: '2026-09-10T14:00:00',
                total: '190.00',
                shipping_total: '10.00',
                discount_total: '0.00',
                payment_method_title: 'Pix',
                billing: { first_name: 'João', last_name: 'Silva', email: 'joao@brobond.com.br', phone: '62999998888' },
                line_items: [
                  {
                    sku: 'CAM-BB-AZUL',
                    name: 'Camiseta Bordada BB Azul',
                    quantity: 2,
                    price: 90,
                    meta_data: [{ key: 'pa_tamanho', value: 'M' }],
                  },
                ],
              },
            ]
          : []
      );
      try {
        const { res, saida } = resFake();
        await importarPedidosLoja(reqDe('admin', { dias: 7 }), res);
        assert.equal(saida.json.ok, true);
        assert.equal(saida.json.importados.length, 1, 'pedido importado');
        assert.equal(saida.json.pendentes.length, 0);

        const venda = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-5001' });
        assert.ok(venda, 'venda gravada com a referência do pedido');
        assert.equal(venda.canal_venda, 'site_varejo');
        assert.equal(venda.status, 'cotacao', 'entra como pedido do site (não baixa estoque)');
        assert.equal(Number(venda.frete), 10);
        assert.equal(Number(venda.cliente_id) > 0, true);

        const itens = await getStore().list(RESOURCES.itens_venda, { page: 1, pageSize: 50, filter: { venda_id: Number(venda.id) } });
        assert.equal(itens.rows.length, 1);
        assert.equal(Number(itens.rows[0].produto_id), Number(produto.id));
        assert.equal(Number(itens.rows[0].tamanho_id), Number(tamanho.id), 'tamanho vindo da variação');
        assert.equal(Number(itens.rows[0].quantidade), 2);
        assert.equal(Number(itens.rows[0].preco_unitario), 90);

        const cliente = await getStore().get(RESOURCES.clientes, Number(venda.cliente_id));
        assert.equal(String(cliente?.email), 'joao@brobond.com.br');
        assert.equal(String(cliente?.tipo), 'varejo');

        // Autenticação: Basic com consumer key/secret, na URL da loja.
        const chamadaPedidos = chamadas.find((c) => c.url.includes('/orders?'));
        assert.ok(chamadaPedidos?.url.startsWith(`${LOJA}/wp-json/wc/v3/orders?`));
        const auth = String((chamadaPedidos?.init?.headers as Record<string, string>)?.Authorization || '');
        assert.equal(auth, `Basic ${Buffer.from('ck_teste:cs_teste').toString('base64')}`);
      } finally {
        restaurar();
      }
    });
  });

  test('reimportar o mesmo pedido NÃO duplica (idempotência)', async () => {
    await comLoja(async () => {
      const { restaurar } = espionarFetch((url) =>
        url.includes('/orders?')
          ? [
              {
                id: 6001,
                number: '6001',
                date_created: '2026-09-10T14:00:00',
                billing: { first_name: 'Maria', email: 'maria@brobond.com.br' },
                line_items: [{ sku: 'CAM-BB-AZUL', quantity: 1, price: 90, meta_data: [{ key: 'pa_tamanho', value: 'M' }] }],
              },
            ]
          : []
      );
      try {
        const primeira = resFake();
        await importarPedidosLoja(reqDe('admin', { dias: 7 }), primeira.res);
        assert.equal(primeira.saida.json.importados.length, 1);

        const segunda = resFake();
        await importarPedidosLoja(reqDe('admin', { dias: 7 }), segunda.res);
        assert.equal(segunda.saida.json.importados.length, 0, 'nada importado de novo');
        assert.equal(segunda.saida.json.ignorados.length, 1, 'pedido reconhecido como já importado');

        const vendas = await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 500, filter: { pedido_cliente: 'WOO-6001' } });
        assert.equal(vendas.rows.length, 1, 'exatamente uma venda para o pedido');
      } finally {
        restaurar();
      }
    });
  });

  test('item sem SKU no ERP não entra calado: volta em pendentes', async () => {
    await comLoja(async () => {
      const { restaurar } = espionarFetch((url) =>
        url.includes('/orders?')
          ? [
              {
                id: 7001,
                number: '7001',
                date_created: '2026-09-10T14:00:00',
                billing: { first_name: 'Carlos', email: 'carlos@brobond.com.br' },
                line_items: [{ sku: 'SKU-QUE-NAO-EXISTE', name: 'Produto novo da loja', quantity: 1, price: 50 }],
              },
            ]
          : []
      );
      try {
        const { res, saida } = resFake();
        await importarPedidosLoja(reqDe('admin', { dias: 7 }), res);
        assert.equal(saida.json.importados.length, 0, 'não cria venda vazia');
        assert.equal(saida.json.pendentes.length, 1);
        assert.match(String(saida.json.pendentes[0].itens[0]), /SKU-QUE-NAO-EXISTE/);
        const venda = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-7001' });
        assert.equal(venda, null, 'nada gravado');
      } finally {
        restaurar();
      }
    });
  });

  test('falha de rede na loja vira 502 com mensagem em português', async () => {
    await comLoja(async () => {
      const { restaurar } = espionarFetch(() => new Error('getaddrinfo ENOTFOUND'));
      try {
        await assert.rejects(
          () => importarPedidosLoja(reqDe('admin'), resFake().res),
          (e: any) => e.status === 502 && /loja/i.test(String(e.message))
        );
      } finally {
        restaurar();
      }
    });
  });

  test('operador não importa pedidos (403)', async () => {
    await comLoja(async () => {
      await assert.rejects(
        () => importarPedidosLoja(reqDe('operador'), resFake().res),
        (e: any) => e.status === 403
      );
    });
  });
});

describe('Estoque: ERP → loja', () => {
  test('envia o saldo do ERP para o produto simples da loja (batch)', async () => {
    await comLoja(async () => {
      const produto = await novoProduto({ sku: 'CALCA-JEANS-CLARA', nome: 'Calça Jeans Clara' });
      const tamanho = await novoTamanho('40');
      await getStore().insert(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(tamanho.id), quantidade: 7 });

      const enviados: { url: string; corpo: any }[] = [];
      const { restaurar } = espionarFetch((url, init) => {
        if (url.includes('/products?'))
          return [{ id: 321, sku: 'CALCA-JEANS-CLARA', type: 'simple', permalink: `${LOJA}/produto/calca-jeans-clara/` }];
        if (url.includes('/products/batch')) {
          enviados.push({ url, corpo: JSON.parse(String((init as any)?.body || '{}')) });
          return { update: [] };
        }
        return [];
      });
      try {
        const { res, saida } = resFake();
        await sincronizarEstoqueLoja(reqDe('admin'), res);
        assert.equal(saida.json.total_atualizados, 1);
        assert.equal(enviados.length, 1, 'uma chamada de lote');
        const atualizacao = enviados[0]!.corpo.update[0];
        assert.equal(atualizacao.id, 321);
        assert.equal(atualizacao.stock_quantity, 7, 'saldo do ERP');
        assert.equal(atualizacao.manage_stock, true);
      } finally {
        restaurar();
      }
    });
  });

  test('variação é casada por SKU e por SKU-TAMANHO, sem inventar produto', async () => {
    await comLoja(async () => {
      const produto = await novoProduto({ sku: 'CAM-BASICA', nome: 'Camiseta Básica' });
      const p = await novoTamanho('P');
      const g = await novoTamanho('G');
      await getStore().insert(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(p.id), quantidade: 3 });
      await getStore().insert(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(g.id), quantidade: 5 });

      const enviados: any[] = [];
      const { restaurar } = espionarFetch((url, init) => {
        if (url.includes('/products?')) return [{ id: 900, sku: 'CAM-BASICA', type: 'variable' }];
        if (url.includes('/variations?'))
          return [
            { id: 901, sku: 'CAM-BASICA-P' },
            { id: 902, sku: 'CAM-BASICA-G' },
          ];
        if (url.includes('/variations/batch')) {
          enviados.push(JSON.parse(String((init as any)?.body || '{}')));
          return { update: [] };
        }
        return [];
      });
      try {
        const { res, saida } = resFake();
        await sincronizarEstoqueLoja(reqDe('admin'), res);
        assert.equal(saida.json.total_atualizados, 2);
        const porId = new Map(enviados[0]!.update.map((u: any) => [u.id, u.stock_quantity]));
        assert.equal(porId.get(901), 3, 'variação P');
        assert.equal(porId.get(902), 5, 'variação G');
      } finally {
        restaurar();
      }
    });
  });
});
