import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const catalogos = await import('../src/catalogos');
const { esperarErro, garantirAdmin, criarAtor, novoTamanho, reqDe } = await import('./_p1util');

await garantirAdmin();
const store = getStore();
await store.insert(RESOURCES.empresas, { id: 2, nome: `Empresa P0-01 ${randomUUID()}`, ativo: true }).catch(() => undefined);

async function fixtureCatalogos() {
  const sufixo = randomUUID().replace(/-/g, '');
  const tamanho = await novoTamanho(`P0${sufixo.slice(0, 8)}`);
  const colecaoA = await store.insert(RESOURCES.colecoes, { empresa_id: 1, nome: `Coleção A ${sufixo}` });
  const colecaoB = await store.insert(RESOURCES.colecoes, { empresa_id: 2, nome: `Coleção B ${sufixo}` });
  const catalogoA = await store.insert(RESOURCES.catalogos, {
    empresa_id: 1, nome: `Catálogo A ${sufixo}`, token: `a${sufixo}`, colecao_id: Number(colecaoA.id), ativo: true,
    aceita_pedido_site: true, mostrar_preco: true, mostrar_saldo: true,
  });
  const catalogoB = await store.insert(RESOURCES.catalogos, {
    empresa_id: 2, nome: `Catálogo B ${sufixo}`, token: `b${sufixo}`, colecao_id: Number(colecaoB.id), ativo: true,
    aceita_pedido_site: true, mostrar_preco: true, mostrar_saldo: true,
  });
  const skuCompartilhado = `P0-SKU-${sufixo}`;
  const produtoA = await store.insert(RESOURCES.produtos, {
    empresa_id: 1, sku: skuCompartilhado, nome: `Produto igual ${sufixo}`, colecao_id: Number(colecaoA.id),
    preco_venda: 10, ativo: true, exibir_site: true,
  });
  const produtoB = await store.insert(RESOURCES.produtos, {
    empresa_id: 2, sku: skuCompartilhado, nome: `Produto igual ${sufixo}`, colecao_id: Number(colecaoB.id),
    preco_venda: 99, ativo: true, exibir_site: true,
  });
  await store.insert(RESOURCES.estoques, { empresa_id: 1, produto_id: Number(produtoA.id), tamanho_id: Number(tamanho.id), local: `P0-A-${sufixo}`, quantidade: 3 });
  await store.insert(RESOURCES.estoques, { empresa_id: 2, produto_id: Number(produtoB.id), tamanho_id: Number(tamanho.id), local: `P0-B-${sufixo}`, quantidade: 77 });
  const clienteB = await store.insert(RESOURCES.clientes, { empresa_id: 2, nome: `Cliente B ${sufixo}`, tipo: 'pf', ativo: true });
  return { sufixo, tamanho, colecaoA, colecaoB, catalogoA, catalogoB, produtoA, produtoB, clienteB };
}

function response() {
  const value: { body?: unknown; status?: number } = {};
  const res: any = {
    json(body: unknown) { value.body = body; return res; },
    status(status: number) { value.status = status; return res; },
    send(body: unknown) { value.body = body; return res; },
    setHeader() { return res; },
    removeHeader() { return res; },
    end() { return res; },
  };
  return { res, value };
}

test('P0-01: catálogo público e embed derivam empresa do catálogo e não mostram produto/estoque de outro tenant', async () => {
  const f = await fixtureCatalogos();
  const json = response();
  await catalogos.catalogoPublico(reqDe({}, { params: { token: f.catalogoA.token } }), json.res);
  const body = json.value.body as any;
  assert.equal(body.total, 1);
  assert.deepEqual(body.produtos.map((p: any) => [p.id, p.sku, p.preco_venda, p.tamanhos[0]?.quantidade]), [
    [Number(f.produtoA.id), f.produtoA.sku, 10, 3],
  ]);

  const embed = response();
  await catalogos.catalogoEmbed(reqDe({}, { params: { token: f.catalogoA.token } }), embed.res);
  assert.equal((String(embed.value.body).match(/<article /g) ?? []).length, 1, 'embed tem somente o card da Empresa A');
  assert.ok(!String(embed.value.body).includes('99,00'), 'embed não expõe o preço da Empresa B');
});

test('P0-01: tentativa de filtrar o catálogo A por coleção B é recusada', async () => {
  const f = await fixtureCatalogos();
  const catalogoAdulterado = await store.insert(RESOURCES.catalogos, {
    empresa_id: 1, nome: `Catálogo com filtro cruzado ${f.sufixo}`, token: `c${f.sufixo}`,
    colecao_id: Number(f.colecaoB.id), ativo: true,
  });
  await esperarErro(
    () => catalogos.catalogoPublico(reqDe({}, { params: { token: catalogoAdulterado.token } }), response().res),
    404,
    /Catálogo não encontrado/
  );
});

test('P0-01: pedido público não aceita produto de B pela URL/token A nem cria linhas em A', async () => {
  const f = await fixtureCatalogos();
  const antes = await store.list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { empresa_id: 1 } });
  await esperarErro(
    () => catalogos.criarPedidoCatalogo(reqDe({
      nome: `Tentativa cross-tenant ${f.sufixo}`,
      email: `cross-${f.sufixo}@example.test`,
      itens: [{ produto_id: Number(f.produtoB.id), tamanho_id: Number(f.tamanho.id), quantidade: 1 }],
    }, { params: { token: f.catalogoA.token } }), response().res),
    400,
    /item inválido/
  );
  const depois = await store.list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { empresa_id: 1 } });
  assert.equal(depois.total, antes.total, 'a transação recusada não cria venda parcial');
});

test('P0-01: compartilhamento adulterado para cliente de outra empresa falha fechado', async () => {
  const f = await fixtureCatalogos();
  const tokenIndividual = randomUUID().replace(/-/g, '');
  await store.insert(RESOURCES.catalogo_compartilhamentos, {
    catalogo_id: Number(f.catalogoA.id), cliente_id: Number(f.clienteB.id),
    token_hash: catalogos.hashTokenPublico(tokenIndividual), canal: 'link', acessos: 0,
  });
  await esperarErro(
    () => catalogos.catalogoPublico(reqDe({}, { params: { token: tokenIndividual } }), response().res),
    404,
    /Compartilhamento não encontrado/
  );
  assert.equal(await store.countWhere(RESOURCES.catalogo_eventos, { catalogo_id: Number(f.catalogoA.id) }), 0, 'link inválido não registra abertura');
});

test('P0-01: política geral de outra empresa não altera preço do catálogo A', async () => {
  const f = await fixtureCatalogos();
  const gerenteB = await criarAtor(2, 'gerente');
  await createRecord(RESOURCES.politicas_comerciais, {
    empresa_id: 1, nome: `Regra geral A ${f.sufixo}`, escopo: 'geral', desconto_pct: 5, prioridade: 1, multiplo_qtd: 1, ativo: true,
  }, (await criarAtor(1, 'gerente')) as any);
  await createRecord(RESOURCES.politicas_comerciais, {
    empresa_id: 2, nome: `Regra geral B ${f.sufixo}`, escopo: 'geral', desconto_pct: 90, prioridade: 999, multiplo_qtd: 1, ativo: true,
  }, gerenteB as any);
  const aplicada = await (await import('../src/politicasComerciais')).resolverPoliticaComercial({
    empresaId: 1,
    catalogo: f.catalogoA,
    canal: 'varejo',
  });
  assert.equal(aplicada?.nome, `Regra geral A ${f.sufixo}`);
  assert.equal(aplicada?.desconto_pct, 5);
});
