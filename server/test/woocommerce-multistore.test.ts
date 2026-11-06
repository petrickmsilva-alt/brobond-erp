// ============================================================================
// WOOCOMMERCE MULTI-STORE (RETAIL / WHOLESALE) — provas de contrato.
//
// O que precisa ficar travado (é o que dá prejuízo se quebrar):
//   • RETAIL e WHOLESALE são IDENTIDADES imutáveis e independentes;
//   • cada loja tem o SEU preço (preco_venda × preco_atacado) e o SEU vínculo;
//   • um ID externo da RETAIL nunca é usado na WHOLESALE (sem atualização cruzada);
//   • a falha de uma loja NÃO interrompe a outra;
//   • publicação é IDEMPOTENTE (republicar não cria um segundo anúncio);
//   • produto variável NUNCA vira simples e a variação usa o preço DELA;
//   • preço inválido NÃO é publicado;
//   • a importação de pedidos tem referência por loja (WOO-RETAIL-<id> ×
//     WOO-WHOLESALE-<id>) e reimportar não duplica;
//   • a credencial (CK/CS) nunca aparece em resposta, erro ou log.
//
// Cada teste roda numa EMPRESA própria: o MemStore é compartilhado pelo arquivo
// e o recorte por empresa é justamente o isolamento que a missão exige.
// Nenhum teste faz chamada real: `fetch` é substituído por um espião.
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
const { configStore, exigirConfigStore, ehStoreKey, multiStoreHabilitado, statusStores, validarUrlLoja, STORE_KEYS, empresaDaStore } =
  await import('../src/commerce/woocommerce/registry');
const { publicarProdutoNaLoja } = await import('../src/commerce/woocommerce/publicacao');
const { sincronizarEstoqueDaLoja, sincronizarEstoqueTodasLojas } = await import('../src/commerce/woocommerce/estoque');
const { importarPedidosDaLoja, referenciaPedido } = await import('../src/commerce/woocommerce/pedidos');
const { listarVinculos, registrarVinculo } = await import('../src/commerce/woocommerce/vinculos');
const { painelDaLoja, reconciliarLoja } = await import('../src/commerce/woocommerce/painel');
const { precoDaLoja, validarPrecoPublicavel } = await import('../src/commerce/woocommerce/precos');

const RETAIL_URL = 'https://brobond.com.br';
const WHOLESALE_URL = 'https://atacado.brobond.com.br';

type Chamada = { url: string; metodo: string; corpo: any };

/** Espião de fetch: registra método/corpo e responde pelo caminho. */
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

/** Configura as DUAS lojas para UMA empresa (credenciais fictícias, nunca reais). */
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

/** Empresa exclusiva por teste: o recorte por empresa isola os vínculos. */
let empresaSeq = 0;
function novaEmpresa(): number {
  empresaSeq += 1;
  return 1000 + empresaSeq;
}

let seq = 0;
async function novoProduto(empresaId: number, dados: Record<string, unknown> = {}) {
  seq++;
  return getStore().insert(RESOURCES.produtos, {
    empresa_id: empresaId,
    sku: String(dados.sku ?? `MS-${empresaId}-${seq}`),
    nome: dados.nome ?? `Produto Multi ${seq}`,
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


/** Garante um local de estoque ativo (a publicação também calcula o disponível). */
async function garantirLocal(empresaId: number) {
  const s = getStore();
  const local = await s.findOneWhere(RESOURCES.locais, { empresa_id: empresaId, padrao: true });
  if (!local) await s.insert(RESOURCES.locais, { empresa_id: empresaId, nome: `loja-${empresaId}`, tipo: 'loja', ativo: true, padrao: true });
}

beforeEach(() => {
  limparLojas();
});
afterEach(() => {
  limparLojas();
});

describe('WS-1 — Registry: identidades imutáveis e configuração por loja', () => {
  test('RETAIL e WHOLESALE são as únicas chaves e são imutáveis', () => {
    assert.deepEqual([...STORE_KEYS], ['RETAIL', 'WHOLESALE']);
    assert.equal(ehStoreKey('RETAIL'), true);
    assert.equal(ehStoreKey('WHOLESALE'), true);
    assert.equal(ehStoreKey('retail'), false, 'a identidade é case-sensitive — não é rótulo');
    assert.equal(ehStoreKey('LOJA1'), false);
    assert.equal(ehStoreKey(null), false);
  });

  test('cada loja resolve a PRÓPRIA URL, credencial e fonte de preço', () => {
    configurarLojas(novaEmpresa());
    const retail = exigirConfigStore('RETAIL');
    const wholesale = exigirConfigStore('WHOLESALE');
    assert.equal(retail.url, RETAIL_URL);
    assert.equal(wholesale.url, WHOLESALE_URL);
    assert.equal(retail.fontePreco, 'preco_venda');
    assert.equal(wholesale.fontePreco, 'preco_atacado');
    assert.equal(retail.canal, 'site_varejo');
    assert.equal(wholesale.canal, 'site_atacado');
    assert.notEqual(retail.ck, wholesale.ck, 'credenciais independentes por loja');
  });

  test('loja desabilitada ou incompleta devolve null (não derruba a outra)', () => {
    process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_URL = RETAIL_URL;
    process.env.WOOCOMMERCE_RETAIL_CK = 'ck';
    // CS ausente → incompleta.
    assert.equal(configStore('RETAIL'), null);
    assert.equal(configStore('WHOLESALE'), null, 'loja não habilitada');
    assert.throws(() => exigirConfigStore('RETAIL'), /incompleta/);
  });

  test('multi-loja desligado não é "loja configurada por acidente"', () => {
    assert.equal(multiStoreHabilitado(), false);
    configurarLojas(novaEmpresa());
    assert.equal(multiStoreHabilitado(), true);
  });

  test('URL da loja é validada contra SSRF e esquema não-http', () => {
    assert.throws(() => validarUrlLoja('javascript:alert(1)', 'RETAIL'), /inválida/);
    assert.throws(() => validarUrlLoja('http://127.0.0.1:8080', 'RETAIL'), /rede interna/);
    assert.throws(() => validarUrlLoja('http://10.0.0.5', 'WHOLESALE'), /rede interna/);
    assert.throws(() => validarUrlLoja('http://169.254.169.254', 'RETAIL'), /rede interna/);
    assert.equal(validarUrlLoja('brobond.com.br/', 'RETAIL'), RETAIL_URL, 'aceita sem esquema e sem barra final');
  });

  test('diagnóstico por loja NUNCA devolve credencial', () => {
    configurarLojas(novaEmpresa());
    const status = statusStores();
    assert.equal(status.length, 2);
    for (const s of status) {
      assert.equal(s.configurada, true);
      const serializado = JSON.stringify(s);
      assert.ok(!serializado.includes('ck_'), 'nenhuma CK no diagnóstico');
      assert.ok(!serializado.includes('cs_'), 'nenhum CS no diagnóstico');
    }
  });

  test('empresa da loja é explícita por loja e nunca compartilha entre empresas', () => {
    configurarLojas(1);
    assert.equal(empresaDaStore('RETAIL'), 1);
    assert.equal(empresaDaStore('WHOLESALE'), 1);
    process.env.WOOCOMMERCE_WHOLESALE_EMPRESA_ID = '2';
    assert.equal(empresaDaStore('WHOLESALE'), 2);
    assert.equal(empresaDaStore('RETAIL'), 1, 'mudar uma loja não afeta a outra');
  });
});

describe('WS-2 — Preço por loja', () => {
  test('RETAIL usa preco_venda; WHOLESALE usa preco_atacado', () => {
    const produto = { preco_venda: 100, preco_atacado: 60 } as any;
    assert.equal(precoDaLoja(produto, 'RETAIL').preco, 100);
    assert.equal(precoDaLoja(produto, 'WHOLESALE').preco, 60);
  });

  test('preço ausente/zero é recusado na publicação (nunca anúncio sem preço)', () => {
    const semVenda = { preco_venda: 0, preco_atacado: 60 } as any;
    assert.ok(validarPrecoPublicavel(precoDaLoja(semVenda, 'RETAIL'), semVenda, 'RETAIL'));
    assert.equal(validarPrecoPublicavel(precoDaLoja(semVenda, 'WHOLESALE'), semVenda, 'WHOLESALE'), null, 'a outra loja segue válida');

    const semAtacado = { preco_venda: 100, preco_atacado: 0, atacado_min_qtd: 12 } as any;
    assert.ok(validarPrecoPublicavel(precoDaLoja(semAtacado, 'WHOLESALE'), semAtacado, 'WHOLESALE'));
  });
});

describe('WS-3 — Publicação idempotente por loja', () => {
  test('publicar pelo canal WOOCOMMERCE enfileira UMA publicação por loja (multi-loja)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-FANOUT', preco_venda: 80, preco_atacado: 45 });
    await garantirLocal(empresaId);
    const { enfileirarPublicacao } = await import('../src/commerce/catalogo');
    const { montarPayloadPublicacao } = await import('../src/commerce/catalogo');
    const payload = await montarPayloadPublicacao(empresaId, Number(produto.id), 'WOOCOMMERCE');
    await enfileirarPublicacao(empresaId, Number(produto.id), 'WOOCOMMERCE', payload, null, undefined, { storeKey: 'RETAIL' });
    await enfileirarPublicacao(empresaId, Number(produto.id), 'WOOCOMMERCE', payload, null, undefined, { storeKey: 'WHOLESALE' });
    const publicacoes = await getStore().list(RESOURCES.commerce_publicacoes, {
      page: 1,
      pageSize: 100,
      filter: { empresa_id: empresaId, produto_id: Number(produto.id) },
    });
    const lojas = publicacoes.rows.map((r) => String(r.store_key)).sort();
    assert.deepEqual(lojas, ['RETAIL', 'WHOLESALE'], 'uma publicação por loja, nunca uma só');
  });

  test('publica o MESMO produto nas duas lojas com preços diferentes e vínculos separados', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-DUAL', preco_venda: 120, preco_atacado: 70 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 9);

    const criados: { url: string; corpo: any }[] = [];
    let proximoId = 1000;
    const { restaurar } = espionar((url, metodo, corpo) => {
      if (metodo === 'GET' && url.includes('/products?sku=')) return [];
      if (metodo === 'POST' && /\/products$/.test(url)) {
        criados.push({ url, corpo });
        return { id: ++proximoId };
      }
      return [];
    });
    try {
      const retail = await publicarProdutoNaLoja(exigirConfigStore('RETAIL'), empresaId, Number(produto.id));
      const wholesale = await publicarProdutoNaLoja(exigirConfigStore('WHOLESALE'), empresaId, Number(produto.id));

      assert.equal(criados.length, 2, 'um anúncio por loja');
      assert.equal(criados[0].corpo.regular_price, '120.00', 'RETAIL = preco_venda');
      assert.equal(criados[1].corpo.regular_price, '70.00', 'WHOLESALE = preco_atacado');
      assert.equal(criados[0].corpo.type, 'simple');
      assert.notEqual(retail.external_product_id, wholesale.external_product_id);

      const vinculosRetail = await listarVinculos(empresaId, 'RETAIL');
      const vinculosWholesale = await listarVinculos(empresaId, 'WHOLESALE');
      assert.equal(vinculosRetail.length, 1);
      assert.equal(vinculosWholesale.length, 1);
      assert.notEqual(vinculosRetail[0].external_product_id, vinculosWholesale[0].external_product_id);
    } finally {
      restaurar();
    }
  });

  test('republicar NÃO cria um segundo anúncio: usa o vínculo persistido (PUT)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await garantirLocal(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-IDEMP', preco_venda: 50 });
    let criacoes = 0;
    const metodos: string[] = [];
    const { restaurar } = espionar((url, metodo) => {
      metodos.push(metodo);
      if (metodo === 'GET' && url.includes('/products?sku=')) return [];
      if (metodo === 'POST' && /\/products$/.test(url)) {
        criacoes++;
        return { id: 4242 };
      }
      return {};
    });
    try {
      const cfg = exigirConfigStore('RETAIL');
      const primeira = await publicarProdutoNaLoja(cfg, empresaId, Number(produto.id));
      const segunda = await publicarProdutoNaLoja(cfg, empresaId, Number(produto.id));
      assert.equal(criacoes, 1, 'só a primeira publicação cria');
      assert.equal(primeira.external_product_id, '4242');
      assert.equal(segunda.external_product_id, '4242', 'republicação reusa o vínculo');
      assert.ok(metodos.includes('PUT'), 'a segunda publicação é um PUT no anúncio existente');
      assert.equal((await listarVinculos(empresaId, 'RETAIL')).length, 1, 'um único vínculo');
    } finally {
      restaurar();
    }
  });

  test('adota o anúncio existente por SKU antes de criar (sem duplicar)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await garantirLocal(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-JA-EXISTE', preco_venda: 30 });
    let criacoes = 0;
    const { restaurar } = espionar((url, metodo) => {
      if (metodo === 'GET' && url.includes('/products?sku=')) return [{ id: 777, sku: 'MS-JA-EXISTE', type: 'simple' }];
      if (metodo === 'POST' && /\/products$/.test(url)) {
        criacoes++;
        return { id: 999 };
      }
      return {};
    });
    try {
      const r = await publicarProdutoNaLoja(exigirConfigStore('RETAIL'), empresaId, Number(produto.id));
      assert.equal(criacoes, 0, 'nunca cria um segundo anúncio para o mesmo SKU');
      assert.equal(r.external_product_id, '777');
    } finally {
      restaurar();
    }
  });

  test('produto sem preço na loja é recusado com motivo acionável', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await garantirLocal(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-SEM-PRECO', preco_venda: 0, preco_atacado: 0 });
    const { restaurar } = espionar(() => []);
    try {
      await assert.rejects(
        () => publicarProdutoNaLoja(exigirConfigStore('RETAIL'), empresaId, Number(produto.id)),
        (e: any) => /preço/i.test(String(e.message))
      );
    } finally {
      restaurar();
    }
  });

  test('produto VARIÁVEL continua variável e cada variação leva o PRÓPRIO preço', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const pai = await novoProduto(empresaId, { sku: 'MS-VAR', nome: 'Camiseta Variável', formato: 'variacao', preco_venda: 200, preco_atacado: 150 });
    const tamP = await novoTamanho('P');
    const tamG = await novoTamanho('G');
    const filhoP = await getStore().insert(RESOURCES.produtos, {
      empresa_id: empresaId,
      sku: 'MS-VAR-P',
      nome: 'Camiseta Variável P',
      formato: 'variacao',
      produto_pai_id: Number(pai.id),
      variacao_tamanho_id: Number(tamP.id),
      preco_venda: 199,
      preco_atacado: 149,
      ativo: true,
      exibir_site: true,
    });
    const filhoG = await getStore().insert(RESOURCES.produtos, {
      empresa_id: empresaId,
      sku: 'MS-VAR-G',
      nome: 'Camiseta Variável G',
      formato: 'variacao',
      produto_pai_id: Number(pai.id),
      variacao_tamanho_id: Number(tamG.id),
      preco_venda: 209,
      preco_atacado: 159,
      ativo: true,
      exibir_site: true,
    });
    await inserirSaldo(empresaId, Number(filhoP.id), Number(tamP.id), 4);
    await inserirSaldo(empresaId, Number(filhoG.id), Number(tamG.id), 6);

    const chamadas: Chamada[] = [];
    const { restaurar } = espionar((url, metodo, corpo) => {
      chamadas.push({ url, metodo, corpo });
      if (metodo === 'GET' && url.includes('/products?sku=')) return [];
      if (metodo === 'POST' && /\/products$/.test(url)) return { id: 5000 };
      if (metodo === 'GET' && url.includes('/variations?per_page=')) return [];
      if (metodo === 'POST' && /\/variations$/.test(url)) return { id: 6000 + chamadas.length };
      return {};
    });
    try {
      const r = await publicarProdutoNaLoja(exigirConfigStore('RETAIL'), empresaId, Number(pai.id));
      const paiCriado = chamadas.find((c) => c.metodo === 'POST' && /\/products$/.test(c.url));
      assert.equal(paiCriado?.corpo.type, 'variable', 'NUNCA transforma variável em simples');
      assert.ok(Array.isArray(paiCriado?.corpo.attributes) && paiCriado!.corpo.attributes[0].variation === true);

      const variacoes = chamadas.filter((c) => c.metodo === 'POST' && /\/variations$/.test(c.url));
      assert.equal(variacoes.length, 2, 'uma variação por filho');
      const precos = variacoes.map((v) => v.corpo.regular_price).sort();
      assert.deepEqual(precos, ['199.00', '209.00'], 'preço vem da VARIAÇÃO, não do pai (200)');
      assert.equal(r.external_variation_ids.length, 2);

      const vinculos = await listarVinculos(empresaId, 'RETAIL');
      assert.equal(vinculos.filter((v) => v.external_variation_id != null).length, 2, 'vínculo por variação');
    } finally {
      restaurar();
    }
  });
});

describe('WS-4 — Estoque: ERP é a fonte, cada loja recebe a SUA sincronização', () => {
  test('estoque usa o ID EXTERNO do vínculo da loja — sem atualização cruzada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-ESTOQUE', preco_venda: 40 });
    const tamanho = await novoTamanho('UN');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 8);

    await registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '111', sku: 'MS-ESTOQUE' });
    await registrarVinculo(empresaId, 'WHOLESALE', Number(produto.id), { external_product_id: '222', sku: 'MS-ESTOQUE' });

    const lotes: { url: string; update: any[] }[] = [];
    const { restaurar } = espionar((url, metodo, corpo) => {
      if (metodo === 'POST' && url.includes('/products/batch')) {
        lotes.push({ url, update: corpo.update });
        return { update: corpo.update.map((u: any) => ({ id: u.id })) };
      }
      return [];
    });
    try {
      const r1 = await sincronizarEstoqueDaLoja(exigirConfigStore('RETAIL'), empresaId);
      const r2 = await sincronizarEstoqueDaLoja(exigirConfigStore('WHOLESALE'), empresaId);
      assert.equal(r1.atualizados, 1);
      assert.equal(r2.atualizados, 1);
      const ids = lotes.map((l) => l.update[0].id);
      assert.deepEqual(ids.sort(), ['111', '222'], 'cada loja recebeu o PRÓPRIO ID externo');
      for (const l of lotes) assert.equal(l.update[0].stock_quantity, 8, 'saldo disponível do ERP');
    } finally {
      restaurar();
    }
  });

  test('falha da RETAIL não impede a WHOLESALE (independência)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-INDEP', preco_venda: 25 });
    const tamanho = await novoTamanho('XG');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 3);
    await registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '900', sku: 'MS-INDEP' });
    await registrarVinculo(empresaId, 'WHOLESALE', Number(produto.id), { external_product_id: '901', sku: 'MS-INDEP' });

    const { restaurar } = espionar((url, metodo, corpo) => {
      if (metodo === 'POST' && url.includes(RETAIL_URL)) return new Error('ECONNREFUSED');
      if (metodo === 'POST' && url.includes('/products/batch')) return { update: corpo.update.map((u: any) => ({ id: u.id })) };
      return [];
    });
    try {
      const resultados = await sincronizarEstoqueTodasLojas([
        { cfg: exigirConfigStore('RETAIL'), empresaId },
        { cfg: exigirConfigStore('WHOLESALE'), empresaId },
      ]);
      const retail = resultados.find((r) => r.store_key === 'RETAIL')!;
      const wholesale = resultados.find((r) => r.store_key === 'WHOLESALE')!;
      assert.equal(retail.ok, false, 'RETAIL falhou');
      assert.equal(wholesale.ok, true, 'WHOLESALE sincronizou mesmo assim');
      assert.equal(wholesale.atualizados, 1);
    } finally {
      restaurar();
    }
  });

  test('produto sem vínculo não é casado por SKU em outra loja', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-SEM-VINCULO', preco_venda: 10 });
    const tamanho = await novoTamanho('P2');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 5);
    const { restaurar } = espionar(() => []);
    try {
      const r = await sincronizarEstoqueDaLoja(exigirConfigStore('RETAIL'), empresaId);
      assert.equal(r.atualizados, 0);
      assert.equal(r.sem_vinculo, 0, 'sem vínculo: nada a enviar');
    } finally {
      restaurar();
    }
  });
});

describe('WS-5 — Importação de pedidos por loja', () => {
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

  test('referência é WOO-RETAIL-<id> / WOO-WHOLESALE-<id> (identidade imutável)', () => {
    assert.equal(referenciaPedido('RETAIL', 123), 'WOO-RETAIL-123');
    assert.equal(referenciaPedido('WHOLESALE', 123), 'WOO-WHOLESALE-123');
    assert.notEqual(referenciaPedido('RETAIL', 123), referenciaPedido('WHOLESALE', 123));
  });

  test('o MESMO id de pedido nas duas lojas gera DUAS vendas (não colide)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-PEDIDO', preco_venda: 90, preco_atacado: 55 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);

    const { restaurar } = espionar((url) => {
      if (url.includes('/orders?')) return [pedidoWoo(4242, 'MS-PEDIDO')];
      return [];
    });
    try {
      const r1 = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      const r2 = await importarPedidosDaLoja(exigirConfigStore('WHOLESALE'), empresaId, { dias: 7 });
      assert.equal(r1.importados.length, 1);
      assert.equal(r2.importados.length, 1, 'a WHOLESALE importa o próprio pedido 4242');
      assert.notEqual(r1.importados[0].venda_id, r2.importados[0].venda_id);

      const vendaRetail = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-4242' });
      const vendaWholesale = await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-WHOLESALE-4242' });
      assert.ok(vendaRetail);
      assert.ok(vendaWholesale);
      assert.equal(vendaRetail.canal_venda, 'site_varejo');
      assert.equal(vendaWholesale.canal_venda, 'site_atacado');
    } finally {
      restaurar();
    }
  });

  test('reimportar a MESMA loja não duplica (idempotência por loja)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-IDEM-PED', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(5555, 'MS-IDEM-PED')] : []));
    try {
      const cfg = exigirConfigStore('RETAIL');
      const primeira = await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      const segunda = await importarPedidosDaLoja(cfg, empresaId, { dias: 7 });
      assert.equal(primeira.importados.length, 1);
      assert.equal(segunda.importados.length, 0);
      assert.equal(segunda.ignorados.length, 1, 'reconhecido como já importado');
      const vendas = await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { pedido_cliente: 'WOO-RETAIL-5555' } });
      assert.equal(vendas.rows.length, 1);
    } finally {
      restaurar();
    }
  });

  test('adota a referência LEGADA (WOO-<id>) sem criar uma segunda venda', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-LEGADO', preco_venda: 90 });
    const tamanho = await novoTamanho('M');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 20);
    // Venda importada pelo fluxo single-store antes da migração multi-loja.
    const cliente = await getStore().insert(RESOURCES.clientes, { empresa_id: empresaId, nome: 'Cliente Legado', ativo: true });
    await getStore().insert(RESOURCES.vendas, {
      empresa_id: empresaId,
      cliente_id: Number(cliente.id),
      data: '2026-09-01',
      status: 'cotacao',
      canal_venda: 'site_varejo',
      pedido_cliente: 'WOO-8888',
      pedido_externo_canal: 'WOOCOMMERCE',
      pedido_externo_id: '8888',
    });
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(8888, 'MS-LEGADO')] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 0, 'não cria uma segunda venda para o mesmo pedido');
      assert.equal(r.ignorados.length, 1);
    } finally {
      restaurar();
    }
  });

  test('item sem SKU no ERP não entra calado — volta em pendentes', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const { restaurar } = espionar((url) => (url.includes('/orders?') ? [pedidoWoo(9999, 'SKU-INEXISTENTE')] : []));
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(r.importados.length, 0);
      assert.equal(r.pendentes.length, 1);
      assert.match(String(r.pendentes[0].itens[0]), /SKU-INEXISTENTE/);
      assert.equal(await getStore().findOneWhere(RESOURCES.vendas, { pedido_cliente: 'WOO-RETAIL-9999' }), null);
    } finally {
      restaurar();
    }
  });

  test('modo de homologação (dry-run) NÃO escreve na loja nem cria venda', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    process.env.WOOCOMMERCE_SYNC_DRY_RUN = 'true';
    const { chamadas, restaurar } = espionar(() => []);
    try {
      const r = await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7 });
      assert.equal(r.ok, true);
      assert.equal(r.importados.length, 0);
      assert.equal(chamadas.length, 1, 'a chamada foi suprimida antes da rede');
      assert.match(chamadas[0].url, /orders/);
    } finally {
      restaurar();
    }
  });
});

describe('WS-6 — Painel, reconciliação e segurança', () => {
  test('painel devolve a loja sem credencial', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const painel = await painelDaLoja(empresaId, 'RETAIL');
    assert.equal(painel.store_key, 'RETAIL');
    assert.equal(painel.status.configurada, true);
    assert.ok(!JSON.stringify(painel).includes('ck_retail_teste'));
    assert.ok(!JSON.stringify(painel).includes('cs_retail_teste'));
  });

  test('reconciliação aponta produto visível sem vínculo', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-RECON', preco_venda: 15 });
    const divergencias = await reconciliarLoja(empresaId, 'WHOLESALE');
    const doProduto = divergencias.find((d) => d.produto_id === Number(produto.id));
    assert.ok(doProduto, 'produto sem vínculo aparece na reconciliação');
    assert.equal(doProduto?.tipo, 'SEM_VINCULO');
  });

  test('o cron de pedidos enfileira a importação de CADA loja, sem chamar a loja', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const { executarProcessoCron } = await import('../src/scheduled');
    const { restaurar } = espionar(() => {
      throw new Error('o cron não pode chamar a loja — quem fala é o worker');
    });
    try {
      await executarProcessoCron('pedidos');
    } finally {
      restaurar();
    }
    const outbox = await getStore().list(RESOURCES.commerce_outbox, {
      page: 1,
      pageSize: 100,
      filter: { empresa_id: empresaId },
    });
    const chaves = outbox.rows.map((r) => String(r.chave));
    assert.ok(chaves.includes(`woo-pedidos:RETAIL:lote`), 'RETAIL enfileirada');
    assert.ok(chaves.includes(`woo-pedidos:WHOLESALE:lote`), 'WHOLESALE enfileirada');
    assert.ok(chaves.includes(`woo-estoque:RETAIL:lote`), 'estoque da RETAIL enfileirado');
    assert.ok(chaves.includes(`woo-estoque:WHOLESALE:lote`), 'estoque da WHOLESALE enfileirado');
  });

  test('mensagem de erro da loja nunca vaza a credencial', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await garantirLocal(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-ERRO-SEG', preco_venda: 20 });
    const { restaurar } = espionar(() => new Error('getaddrinfo ENOTFOUND'));
    try {
      await assert.rejects(
        () => publicarProdutoNaLoja(exigirConfigStore('RETAIL'), empresaId, Number(produto.id)),
        (e: any) => {
          const texto = `${e.message}`;
          assert.ok(!texto.includes('ck_retail_teste'), 'CK não vaza no erro');
          assert.ok(!texto.includes('cs_retail_teste'), 'CS não vaza no erro');
          return true;
        }
      );
    } finally {
      restaurar();
    }
  });
});

// ============================================================================
// WS-7 — ENDURECIMENTO (regressões reais encontradas na auditoria).
//
// Cada teste aqui trava um defeito que só aparece em produção:
//   • uma URL de loja errada derrubava o painel inteiro (configStore lançava);
//   • o ponto final no host ("10.0.0.5.") furava a checagem de SSRF;
//   • a sincronização de estoque em dry-run terminava em erro;
//   • o dry-run gravava vínculos com ID externo vazio;
//   • a paginação decrescente pulava pedidos na importação incremental;
//   • o cron recorrente sincronizava UMA vez e nunca mais.
// ============================================================================
describe('WS-7 — Endurecimento: config falha fechado, SSRF, dry-run, paginação e cron', () => {
  test('configStore não lança: URL interna em UMA loja não derruba a outra nem o painel', () => {
    process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_URL = 'http://10.0.0.5';
    process.env.WOOCOMMERCE_RETAIL_CK = 'ck_x';
    process.env.WOOCOMMERCE_RETAIL_CS = 'cs_x';
    process.env.WOOCOMMERCE_WHOLESALE_ENABLED = 'true';
    process.env.WOOCOMMERCE_WHOLESALE_URL = WHOLESALE_URL;
    process.env.WOOCOMMERCE_WHOLESALE_CK = 'ck_y';
    process.env.WOOCOMMERCE_WHOLESALE_CS = 'cs_y';

    // Não lança: a leitura degrada para "não configurada".
    assert.equal(configStore('RETAIL'), null);
    assert.equal(configStore('WHOLESALE')?.store_key, 'WHOLESALE', 'a loja sã continua válida');

    const status = statusStores();
    const retail = status.find((s) => s.store_key === 'RETAIL')!;
    const wholesale = status.find((s) => s.store_key === 'WHOLESALE')!;
    assert.equal(retail.configurada, false);
    assert.match(String(retail.motivo), /rede interna/i, 'o motivo acionável é exposto no painel');
    assert.equal(wholesale.configurada, true, 'a outra loja não é afetada');

    // Ainda assim, exigir a loja ruim falha fechado com a mensagem real.
    assert.throws(() => exigirConfigStore('RETAIL'), /rede interna/i);
  });

  test('SSRF: host com ponto final (FQDN raiz) continua sendo interno', async () => {
    const { hostInterno } = await import('../src/urlPublica');
    for (const host of ['localhost.', 'brobond-erp.local.', 'erp.internal.', '10.0.0.5.', '169.254.169.254.', '192.168.0.1.']) {
      assert.equal(hostInterno(host), true, `"${host}" precisa ser recusado como interno`);
    }
    assert.throws(() => validarUrlLoja('http://10.0.0.5.', 'RETAIL'), /rede interna/, 'URL com ponto final não fura o filtro');
    assert.throws(() => validarUrlLoja('http://localhost.', 'RETAIL'), /rede interna/);
  });

  test('dry-run: a sincronização de estoque conclui sem tocar a rede (não falha)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-DRY-ESTOQUE', preco_venda: 30 });
    const tamanho = await novoTamanho('DR');
    await inserirSaldo(empresaId, Number(produto.id), Number(tamanho.id), 4);
    await registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '321', sku: 'MS-DRY-ESTOQUE' });
    process.env.WOOCOMMERCE_SYNC_DRY_RUN = 'true';
    let chamadas = 0;
    const { restaurar } = espionar(() => {
      chamadas += 1;
      throw new Error('a rede não pode ser chamada em dry-run');
    });
    try {
      const r = await sincronizarEstoqueDaLoja(exigirConfigStore('RETAIL'), empresaId);
      assert.equal(r.ok, true, 'dry-run não transforma homologação em erro');
      assert.equal(r.dry_run, true);
      assert.equal(r.atualizados, 1, 'reporta quantos itens SERIAM enviados (valor da homologação)');
      assert.equal(chamadas, 0, 'nenhuma chamada de escrita à rede');
    } finally {
      restaurar();
    }
  });

  test('dry-run: publicar NÃO grava vínculo com ID externo vazio', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    await garantirLocal(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-DRY-PUB', preco_venda: 45 });
    process.env.WOOCOMMERCE_SYNC_DRY_RUN = 'true';
    const { restaurar } = espionar((url) => (String(url).includes('/products?sku=') ? [] : {}));
    try {
      const r = await publicarProdutoNaLoja(exigirConfigStore('RETAIL'), empresaId, Number(produto.id));
      assert.equal(r.dry_run, true);
      assert.equal(await listarVinculos(empresaId, 'RETAIL').then((v) => v.length), 0, 'nenhum vínculo fantasma');
    } finally {
      restaurar();
    }
  });

  test('registrarVinculo recusa ID externo vazio (nunca grava memória falsa)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const produto = await novoProduto(empresaId, { sku: 'MS-VINCULO-VAZIO' });
    await assert.rejects(
      () => registrarVinculo(empresaId, 'RETAIL', Number(produto.id), { external_product_id: '' }),
      /sem ID externo/i
    );
    assert.equal((await listarVinculos(empresaId, 'RETAIL')).length, 0);
  });

  test('paginação da importação incremental é CRESCENTE (não pula os mais novos)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const urls: string[] = [];
    const { restaurar } = espionar((url) => {
      urls.push(String(url));
      return [];
    });
    try {
      await importarPedidosDaLoja(exigirConfigStore('RETAIL'), empresaId, { dias: 7, limite: 250 });
    } finally {
      restaurar();
    }
    assert.ok(urls.length >= 1);
    for (const u of urls) assert.match(u, /order=asc/, 'ordem crescente: a água-marca não salta pedidos');
  });

  test('cron recorrente RE-ARMA o evento terminal (sincroniza de novo, sem duplicar)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const { enfileirarEstoqueDaLoja } = await import('../src/commerce/woocommerce/outboxStore');
    const s = getStore();

    const primeiro = await enfileirarEstoqueDaLoja(empresaId, 'RETAIL');
    assert.equal(String(primeiro.estado), 'PENDENTE');
    // O worker processa o evento.
    await s.update(RESOURCES.commerce_outbox, Number(primeiro.id), { estado: 'PROCESSADO' });

    const segundo = await enfileirarEstoqueDaLoja(empresaId, 'RETAIL');
    assert.equal(String(segundo.estado), 'PENDENTE', 'o cron volta a enfileirar o que já terminou');
    assert.equal(Number(segundo.id), Number(primeiro.id), 'reusa a MESMA linha (sem duplicar)');

    const linhas = await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
    assert.equal(linhas.rows.length, 1, 'uma linha por loja, nunca duas');
  });

  test('cron recorrente NÃO atropela um evento em voo (PENDENTE/PROCESSANDO)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const { enfileirarPedidosDaLoja } = await import('../src/commerce/woocommerce/outboxStore');
    const s = getStore();
    const primeiro = await enfileirarPedidosDaLoja(empresaId, 'WHOLESALE');
    await s.update(RESOURCES.commerce_outbox, Number(primeiro.id), { estado: 'PROCESSANDO' });
    const segundo = await enfileirarPedidosDaLoja(empresaId, 'WHOLESALE');
    assert.equal(String(segundo.estado), 'PROCESSANDO', 'um worker em voo não é re-armado');
  });
});
