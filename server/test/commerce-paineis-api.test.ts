// ============================================================================
// COMMERCE — painéis/fluxos novos (testes de API em memória, NODE_ENV=test):
//
//   · GET /api/commerce/ofertas      → vigência + precedência server-side +
//                                       tenancy (só o tenant do ator);
//   · GET /api/commerce/ofertas/:id  → 404 cross-tenant;
//   · GET /api/commerce/publicacoes/:id → produto + preço do canal +
//                                       metadados + 404 cross-tenant;
//   · GET /api/commerce/erros        → agrega SÓ falhas do tenant e o
//                                       operador não lê (RBAC gerente);
//   · PUT /api/commerce/produtos/:id → REGRESSÃO: a rota usa o ID DO PRODUTO
//                                       (a projeção tem id próprio — editar
//                                       pela projeção gravava a linha errada).
//
// Nenhuma chamada real de rede; banco em memória isolado por processo.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { HttpError } = await import('../src/errors');
const { listarOfertasCommerce, obterOfertaCommerce, obterPublicacaoCommerce, atualizarProdutoCommerce } = await import(
  '../src/commerce/catalogo'
);
const { listarErrosCommerce } = await import('../src/commerce/pedidos');
const { R_GATEWAY_WEBHOOK_EVENTS } = await import('../src/gateway');

type ReqAny = {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  user: Record<string, unknown>;
};

function reqDe(
  perfil: 'admin' | 'gerente' | 'operador' = 'admin',
  params: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
  body: Record<string, unknown> = {}
): ReqAny {
  return { params, query, body, user: { id: 1, name: 'Teste', perfil } };
}

function resFake(): { res: any; saida: { json?: any; status?: number } } {
  const saida: { json?: any; status?: number } = {};
  const res: any = { json: (d: any) => ((saida.json = d), res), status: (s: number) => ((saida.status = s), res) };
  return { res, saida };
}

async function rejeitaCom404(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof HttpError, `esperava HttpError, veio ${String(e)}`);
    assert.equal(e.status, 404);
    return true;
  });
}

describe('commerce — ofertas (preço por canal, vigência, precedência, tenancy)', () => {
  test('lista só o tenant do ator e calcula vigência/precedência no servidor', async () => {
    const s = getStore();
    const produto1 = await s.insert(RESOURCES.produtos, {
      empresa_id: 1,
      sku: 'SKU-OFR-1',
      nome: 'Camiseta Oferta',
      preco_venda: 100,
      ativo: true,
      exibir_site: true,
    });
    const produto2 = await s.insert(RESOURCES.produtos, {
      empresa_id: 2,
      sku: 'SKU-OFR-2',
      nome: 'Produto Outro Tenant',
      preco_venda: 50,
      ativo: true,
      exibir_site: true,
    });
    // ML vigente com promoção INVÁLIDA (>= preço) → servidor ignora a promo.
    await s.insert(RESOURCES.commerce_precos, {
      empresa_id: 1,
      produto_id: Number(produto1.id),
      canal: 'MERCADOLIVRE',
      preco: 120,
      preco_promo: 130,
      vigencia_inicio: '2020-01-01',
      vigencia_fim: '2099-12-31',
    });
    // BROBOND vencida → preço final volta para a TABELA.
    await s.insert(RESOURCES.commerce_precos, {
      empresa_id: 1,
      produto_id: Number(produto1.id),
      canal: 'BROBOND',
      preco: 90,
      preco_promo: 80,
      vigencia_inicio: '2000-01-01',
      vigencia_fim: '2000-12-31',
    });
    // Linha de OUTRO tenant — não pode aparecer.
    await s.insert(RESOURCES.commerce_precos, {
      empresa_id: 2,
      produto_id: Number(produto2.id),
      canal: 'NUVEMSHOP',
      preco: 10,
      preco_promo: null,
      vigencia_inicio: null,
      vigencia_fim: null,
    });

    const { res, saida } = resFake();
    await listarOfertasCommerce(reqDe('admin', {}, {}) as any, res as any);
    const corpo = saida.json!;
    assert.equal(corpo.total, 2, 'só as ofertas do tenant 1');

    const ml = corpo.ofertas.find((o: any) => o.canal === 'MERCADOLIVRE');
    assert.ok(ml, 'oferta ML existe');
    assert.equal(ml.vigente, true);
    assert.equal(ml.preco_efetivo.preco, 120);
    assert.equal(ml.preco_efetivo.origem, 'canal');
    assert.equal(ml.preco_efetivo.promo, null, 'promo >= preço é ignorada pelo servidor');

    const brobond = corpo.ofertas.find((o: any) => o.canal === 'BROBOND');
    assert.ok(brobond, 'oferta BROBOND existe');
    assert.equal(brobond.vigente, false, 'vigência encerrada');
    assert.equal(brobond.preco_efetivo.preco, 100, 'fora da vigência vale a TABELA');
    assert.equal(brobond.preco_efetivo.origem, 'base');

    assert.ok(!corpo.ofertas.some((o: any) => o.canal === 'NUVEMSHOP'), 'tenant 2 nunca aparece');
  });

  test('detalhe: 404 cross-tenant e 200 no próprio tenant', async () => {
    const s = getStore();
    const produto1 = await s.insert(RESOURCES.produtos, {
      empresa_id: 1,
      sku: 'SKU-OFR-3',
      nome: 'Produto Detalhe',
      preco_venda: 10,
      ativo: true,
      exibir_site: true,
    });
    const minha = await s.insert(RESOURCES.commerce_precos, {
      empresa_id: 1,
      produto_id: Number(produto1.id),
      canal: 'WOOCOMMERCE',
      preco: 15,
      preco_promo: null,
      vigencia_inicio: null,
      vigencia_fim: null,
    });
    const produto2 = await s.insert(RESOURCES.produtos, {
      empresa_id: 2,
      sku: 'SKU-OFR-4',
      nome: 'Produto Alheio',
      preco_venda: 10,
      ativo: true,
      exibir_site: true,
    });
    const alheia = await s.insert(RESOURCES.commerce_precos, {
      empresa_id: 2,
      produto_id: Number(produto2.id),
      canal: 'MERCADOLIVRE',
      preco: 99,
      preco_promo: null,
      vigencia_inicio: null,
      vigencia_fim: null,
    });

    await rejeitaCom404(() => obterOfertaCommerce(reqDe('admin', { id: Number(alheia.id) }) as any, resFake().res as any));

    const { res, saida } = resFake();
    await obterOfertaCommerce(reqDe('admin', { id: Number(minha.id) }) as any, res as any);
    assert.equal(saida.json!.oferta.id, Number(minha.id));
    assert.equal(saida.json!.oferta.canal, 'WOOCOMMERCE');
  });
});

describe('commerce — /erros (agregação honesta de falhas + RBAC)', () => {
  test('agrega só falhas DO TENANT e ignora PROCESSADO/ignorado', async () => {
    const s = getStore();
    const produtoErr = await s.insert(RESOURCES.produtos, {
      empresa_id: 1,
      sku: 'SKU-ERR-1',
      nome: 'Produto com erro de publicação',
      preco_venda: 50,
      ativo: true,
      exibir_site: true,
    });
    const produtoOk = await s.insert(RESOURCES.produtos, {
      empresa_id: 1,
      sku: 'SKU-ERR-2',
      nome: 'Produto publicado',
      preco_venda: 50,
      ativo: true,
      exibir_site: true,
    });
    await s.insert(RESOURCES.commerce_publicacoes, {
      empresa_id: 1,
      produto_id: Number(produtoErr.id),
      canal: 'MERCADOLIVRE',
      versao: 1,
      estado: 'ERROR',
      tentativas: 5,
      ultimo_erro: 'Credencial ML inválida',
      atualizado_em: '2026-10-28T11:00:00.000Z',
    });
    await s.insert(RESOURCES.commerce_publicacoes, {
      empresa_id: 1,
      produto_id: Number(produtoOk.id),
      canal: 'BROBOND',
      versao: 1,
      estado: 'PUBLISHED',
      tentativas: 1,
      ultimo_erro: null,
    });
    await s.insert(RESOURCES.commerce_outbox, {
      empresa_id: 1,
      tipo: 'conversao',
      chave: 'sale:SAL-ERR',
      estado: 'ERRO',
      tentativas: 8,
      ultimo_erro: 'Falha ao converter',
      payload: {},
    });
    await s.insert(RESOURCES.commerce_outbox, {
      empresa_id: 1,
      tipo: 'conversao',
      chave: 'sale:SAL-OK',
      estado: 'PROCESSADO',
      tentativas: 1,
      ultimo_erro: null,
      payload: {},
    });
    await s.insert(RESOURCES.commerce_pedidos, {
      empresa_id: 1,
      canal: 'BROBOND',
      pedido_externo: 'LOJA-ERR1',
      estado: 'ERRO',
      erro: 'Não foi possível iniciar o pagamento do pedido.',
    });
    await s.insert(R_GATEWAY_WEBHOOK_EVENTS, {
      empresa_id: 1,
      provider: 'mercadopago',
      evento_id: 'wh-err-1',
      evento: 'payment',
      status: 'erro',
      erro: 'Cobrança não encontrada',
      payload: {},
    });
    // 'ignorado' tem mensagem mas NÃO é falha (sem efeito, por design).
    await s.insert(R_GATEWAY_WEBHOOK_EVENTS, {
      empresa_id: 1,
      provider: 'mercadopago',
      evento_id: 'wh-ign-1',
      evento: 'payment',
      status: 'ignorado',
      erro: 'Evento sem efeito financeiro (status irrelevante).',
      payload: {},
    });
    // Outro tenant com falha — fora do escopo.
    await s.insert(RESOURCES.commerce_outbox, {
      empresa_id: 2,
      tipo: 'conversao',
      chave: 'sale:SAL-T2',
      estado: 'ERRO',
      tentativas: 1,
      ultimo_erro: 'Falha do tenant 2',
      payload: {},
    });

    const { res, saida } = resFake();
    await listarErrosCommerce(reqDe('gerente') as any, res as any);
    const corpo = saida.json!;
    const origens = corpo.erros.map((e: any) => e.origem).sort();
    assert.deepEqual(origens, ['outbox', 'pedido', 'publicacao', 'webhook'], 'exatamente as 4 falhas do tenant 1');
    assert.ok(!corpo.erros.some((e: any) => String(e.mensagem).includes('sem efeito')), 'ignorado não é erro');
    assert.ok(!corpo.erros.some((e: any) => String(e.mensagem).includes('tenant 2')), 'cross-tenant fora');
    const pub = corpo.erros.find((e: any) => e.origem === 'publicacao');
    assert.equal(pub.acao, 'reprocessar');
    assert.equal(pub.link, `/commerce/publicacoes/${pub.id}`);
  });

  test('RBAC: operador NÃO lê /erros (recurso exige gerente)', async () => {
    await assert.rejects(
      () => listarErrosCommerce(reqDe('operador') as any, resFake().res as any),
      (e: unknown) => {
        assert.ok(e instanceof HttpError);
        assert.equal(e.status, 403);
        return true;
      }
    );
  });
});

describe('commerce — detalhe da publicação (produto, preço, metadados)', () => {
  test('200 devolve produto + preço do canal + metadados; 404 cross-tenant', async () => {
    const s = getStore();
    const produto = await s.insert(RESOURCES.produtos, {
      empresa_id: 1,
      sku: 'SKU-PUB-1',
      nome: 'Camiseta Publicação',
      preco_venda: 80,
      ativo: true,
      exibir_site: true,
    });
    await s.insert(RESOURCES.commerce_produtos, {
      empresa_id: 1,
      produto_id: Number(produto.id),
      slug: 'camiseta-publicacao',
      resumo: 'Resumo da vitrine',
      ordem: 0,
      canal_metadados: { ml_category_id: 'MLB123' },
    });
    await s.insert(RESOURCES.commerce_precos, {
      empresa_id: 1,
      produto_id: Number(produto.id),
      canal: 'MERCADOLIVRE',
      preco: 95,
      preco_promo: null,
      vigencia_inicio: null,
      vigencia_fim: null,
    });
    const publicacao = await s.insert(RESOURCES.commerce_publicacoes, {
      empresa_id: 1,
      produto_id: Number(produto.id),
      canal: 'MERCADOLIVRE',
      versao: 2,
      estado: 'ERROR',
      tentativas: 3,
      ultimo_erro: 'Credencial ML inválida',
    });

    const produto2 = await s.insert(RESOURCES.produtos, {
      empresa_id: 2,
      sku: 'SKU-PUB-2',
      nome: 'Produto Alheio',
      preco_venda: 10,
      ativo: true,
      exibir_site: true,
    });
    const publicacaoAlheia = await s.insert(RESOURCES.commerce_publicacoes, {
      empresa_id: 2,
      produto_id: Number(produto2.id),
      canal: 'BROBOND',
      versao: 1,
      estado: 'QUEUED',
      tentativas: 0,
    });

    const { res, saida } = resFake();
    await obterPublicacaoCommerce(reqDe('admin', { id: Number(publicacao.id) }) as any, res as any);
    const corpo = saida.json!;
    assert.equal(corpo.publicacao.estado, 'ERROR');
    assert.equal(corpo.publicacao.ultimo_erro, 'Credencial ML inválida');
    assert.equal(corpo.produto.sku, 'SKU-PUB-1');
    assert.equal(corpo.preco.linha.preco, 95);
    assert.equal(corpo.metadados.ml_category_id, 'MLB123');

    await rejeitaCom404(() =>
      obterPublicacaoCommerce(reqDe('admin', { id: Number(publicacaoAlheia.id) }) as any, resFake().res as any)
    );
  });
});

describe('commerce — edição da vitrine (regressão: id da projeção × id do produto)', () => {
  test('PUT usa o ID DO PRODUTO e não grava na projeção errada', async () => {
    const s = getStore();
    const produto = await s.insert(RESOURCES.produtos, {
      empresa_id: 1,
      sku: 'SKU-EDIT-1',
      nome: 'Produto Editado',
      preco_venda: 70,
      ativo: true,
      exibir_site: true,
    });
    // Projeção DECOY de outro produto, criada ANTES — se a sequência for
    // compartilhada, os ids divergem (ex.: produto 1 × projeção 1-x).
    const outroProduto = await s.insert(RESOURCES.produtos, {
      empresa_id: 1,
      sku: 'SKU-EDIT-2',
      nome: 'Outro Produto',
      preco_venda: 60,
      ativo: true,
      exibir_site: true,
    });
    const projecaoDecoy = await s.insert(RESOURCES.commerce_produtos, {
      empresa_id: 1,
      produto_id: Number(outroProduto.id),
      slug: 'outro-produto',
      resumo: 'Resumo decoy',
      ordem: 0,
      canal_metadados: {},
    });
    const projecao = await s.insert(RESOURCES.commerce_produtos, {
      empresa_id: 1,
      produto_id: Number(produto.id),
      slug: 'produto-editado',
      resumo: 'Resumo antigo',
      ordem: 0,
      canal_metadados: {},
    });
    assert.notEqual(Number(produto.id), Number(projecao.id), 'fixture precisa de ids distintos (produto × projeção)');

    const { res } = resFake();
    await atualizarProdutoCommerce(
      reqDe('admin', { id: Number(produto.id) }, {}, { resumo: 'Resumo novo', canal_metadados: { ml_category_id: 'MLB9' } }) as any,
      res as any
    );

    const consultada = await s.findOneWhere(RESOURCES.commerce_produtos, {
      empresa_id: 1,
      produto_id: Number(produto.id),
    });
    assert.ok(consultada, 'projeção do produto encontrada por produto_id');
    assert.equal(consultada!.resumo, 'Resumo novo', 'a projeção CERTA foi atualizada');
    assert.deepEqual(consultada!.canal_metadados, { ml_category_id: 'MLB9' });

    const decoy = await s.findOneWhere(RESOURCES.commerce_produtos, { id: Number(projecaoDecoy.id) });
    assert.equal(decoy!.resumo, 'Resumo decoy', 'a projeção DECOY não foi tocada');
  });
});
