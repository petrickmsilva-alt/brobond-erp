// SMART PRODUCT SEARCH — contrato central, ranking, variantes, estoque e tenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const {
  buscarProdutos,
  normalizeProductSearchParams,
  productSearchRank,
  searchProducts,
} = await import('../src/productSearch');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoProduto, novoTamanho, reqDe, resFake, saldoInicial } = await import('./_p1util');
const { estoqueGrade } = await import('../src/estoque');

await garantirAdmin();
const store = getStore();
const empresaA = escopoDeSistema(1);

await store.insert(RESOURCES.empresas, { id: 2, nome: 'EMPRESA SEARCH B', ativo: true }).catch(() => undefined);
const categoria = await store.insert(RESOURCES.categorias, { nome: 'Camiseta Busca', descricao: 'Categoria da busca global', ativo: true });
const cor = await store.insert(RESOURCES.cores, { nome: 'Vermelha Busca', hex: '#FF0000', ativo: true });
const colecao = await store.insert(RESOURCES.colecoes, { nome: 'Coleção Search', temporada: 'Verão', ano: 2026 });
const fornecedor = await store.insert(RESOURCES.fornecedores, { nome: 'Fornecedor Search', ativo: true });
const grade = await store.insert(RESOURCES.grades, { nome: 'Grade Search', ativo: true });
const [eg, g, gg] = await Promise.all([novoTamanho('EG'), novoTamanho('G'), novoTamanho('GG')]);
await Promise.all([eg, g, gg].map((tamanho, ordem) => store.insert(RESOURCES.grade_tamanhos, {
  grade_id: Number(grade.id),
  tamanho_id: Number(tamanho.id),
  ordem,
})));

const pai = await novoProduto({
  sku: 'CAM-BAS-PREM-SEARCH',
  nome: 'CAMISETA BÁSICA PREMIUM SEARCH',
  descricao: 'Malha de algodão penteado com toque macio',
  descricao_curta: 'Camiseta premium de algodão',
  categoria_id: Number(categoria.id),
  colecao_id: Number(colecao.id),
  fornecedor_id: Number(fornecedor.id),
  grade_id: Number(grade.id),
  marca: 'BroBond Search',
  localizacao: 'Corredor B, prateleira Search',
  ncm: '6205.20.00',
  tags: 'básico, premium, verão',
  formato: 'variacao',
  preco_venda: 89.9,
});

async function variante(sku: string, tamanhoId: number, quantidade: number, barcode?: string) {
  const produto = await novoProduto({
    sku,
    nome: `${pai.nome} Vermelha`,
    produto_pai_id: Number(pai.id),
    variacao_chave: `COR:VERMELHA|TAM:${tamanhoId}`,
    variacao_tamanho_id: tamanhoId,
    categoria_id: Number(categoria.id),
    cor_id: Number(cor.id),
    cor: 'Vermelha Busca',
    marca: 'BroBond Search',
    formato: 'variacao',
    codigo_barras: barcode,
    preco_venda: 89.9,
  });
  await saldoInicial(pai, quantidade, { codigoTamanho: tamanhoId === Number(eg.id) ? 'EG' : tamanhoId === Number(g.id) ? 'G' : 'GG' });
  return produto;
}

const varianteEg = await variante('CAM-BAS-PREM-VERM-EG-SEARCH', Number(eg.id), 3);
const varianteG = await variante('CAM-BAS-PREM-VERM-G-SEARCH', Number(g.id), 8, '7895550001112');
await variante('CAM-BAS-PREM-VERM-GG-SEARCH', Number(gg.id), 4);

const semEstoque = await novoProduto({ sku: 'SEM-ESTOQUE-SEARCH', nome: 'Produto sem estoque search', ativo: true });
const inativo = await novoProduto({ sku: 'INATIVO-SEARCH', nome: 'Produto inativo search', ativo: false });
const outroTenant = await store.insert(RESOURCES.produtos, {
  empresa_id: 2,
  sku: 'CAM-BAS-PREM-SEARCH',
  nome: 'CAMISETA BÁSICA PREMIUM SEARCH — TENANT B',
  codigo_barras: '7895550009999',
  ativo: true,
  preco_venda: 10,
});
await saldoInicial(outroTenant, 99);

function ids(result: Awaited<ReturnType<typeof searchProducts>>): number[] {
  return result.rows.map((row) => row.id);
}

async function encontrarPai(q: string) {
  const result = await searchProducts(empresaA, { q });
  assert.ok(ids(result).includes(Number(pai.id)), `"${q}" deveria encontrar o produto pai; retornou ${JSON.stringify(ids(result))}`);
  return result.rows.find((row) => row.id === Number(pai.id))!;
}

test('search: nome, parte do nome, SKU parcial, barcode, cor, descrição, categoria, marca e múltiplas palavras', async () => {
  for (const q of [
    'cam',
    'premium',
    'CAM-BAS-PREM',
    'cam-bas-prem-search',
    '7895550001112',
    'vermelha',
    'algodão penteado',
    'Camiseta Busca',
    'BroBond Search',
    'Fornecedor Search',
    'Coleção Search',
    'Grade Search',
    'Corredor B',
    '6205.20.00',
    'camiseta vermelha',
  ]) {
    await encontrarPai(q);
  }

  const parcialBarcode = await searchProducts(empresaA, { q: '555000111' });
  assert.ok(ids(parcialBarcode).includes(Number(pai.id)), 'parte do barcode encontra a variação e apresenta o pai');
});

test('search: ranking exact > prefix > contains e desempate determinístico', async () => {
  const exactBarcode = await novoProduto({ sku: 'RANK-Z-SEARCH', nome: 'Ranking exato barcode', codigo_barras: '123456789', ativo: true });
  const prefixSku = await novoProduto({ sku: '123456789-X-SEARCH', nome: 'Ranking prefixo SKU', ativo: true });
  const exactSku = await novoProduto({ sku: 'RANK-NAME-SEARCH', nome: 'RANK-NAME-SEARCH', ativo: true });
  const containsName = await novoProduto({ sku: 'RANK-CONTAINS-SEARCH', nome: 'Produto RANK-NAME-SEARCH complemento', ativo: true });

  assert.equal(productSearchRank(exactBarcode, '123456789'), 0);
  assert.equal(productSearchRank(exactSku, 'RANK-NAME-SEARCH'), 1);
  assert.equal(productSearchRank(prefixSku, '123456789'), 3);
  assert.equal(productSearchRank(containsName, 'RANK-NAME-SEARCH'), 5);

  const barcode = await searchProducts(empresaA, { q: '123456789' });
  assert.equal(barcode.rows[0].id, Number(exactBarcode.id));
  const sku = await searchProducts(empresaA, { q: 'RANK-NAME-SEARCH' });
  assert.equal(sku.rows[0].id, Number(exactSku.id));
  assert.ok(ids(sku).includes(Number(containsName.id)));
  assert.deepEqual(ids(sku), ids(await searchProducts(empresaA, { q: 'RANK-NAME-SEARCH' })), 'ordem é estável entre chamadas');
});

test('search: tenant A nunca vê produto de B e tenant B não vê variantes de A', async () => {
  const a = await searchProducts(empresaA, { q: 'CAMISETA BÁSICA PREMIUM SEARCH', includeInactive: true, pageSize: 50 });
  assert.ok(a.rows.every((row) => row.id !== Number(outroTenant.id)));
  assert.ok(a.rows.flatMap((row) => row.variacoes).every((row) => row.id !== Number(outroTenant.id)));

  const b = await searchProducts(escopoDeSistema(2), { q: 'CAMISETA BÁSICA PREMIUM SEARCH', pageSize: 50 });
  assert.deepEqual(ids(b), [Number(outroTenant.id)]);
  assert.equal(b.rows[0].estoque_disponivel, 99);

  const porId = await searchProducts(empresaA, { id: Number(outroTenant.id), q: '' });
  assert.equal(porId.total, 0, 'ID de outro tenant responde como inexistente');
  const injection = await searchProducts(empresaA, { q: "' OR 1=1; DROP TABLE produtos; --" });
  assert.equal(injection.total, 0, 'input hostil é apenas texto parametrizado');
});

test('search: onlyInStock, local e saldos reais por múltiplos tamanhos/variações', async () => {
  const comSaldo = await searchProducts(empresaA, { q: 'search', onlyInStock: true, pageSize: 50 });
  assert.ok(ids(comSaldo).includes(Number(pai.id)));
  assert.ok(!ids(comSaldo).includes(Number(semEstoque.id)));
  assert.ok(!ids(comSaldo).includes(Number(inativo.id)));

  const porIdDaVariacao = await searchProducts(empresaA, { id: Number(varianteG.id), q: '' });
  assert.deepEqual(ids(porIdDaVariacao), [Number(varianteG.id)], 'edição por ID não troca a variação pelo pai');
  assert.equal(porIdDaVariacao.rows[0].variacoes.length, 0);

  const encontrado = await encontrarPai('camiseta vermelha');
  assert.equal(encontrado.variacoes.length, 3);
  assert.equal(encontrado.estoque_disponivel, 15);
  assert.deepEqual(
    encontrado.variacoes.map((v) => ({ sku: v.sku, tamanho: v.tamanhos[0]?.tamanho, quantidade: v.tamanhos[0]?.quantidade })),
    [
      { sku: varianteEg.sku, tamanho: 'EG', quantidade: 3 },
      { sku: varianteG.sku, tamanho: 'G', quantidade: 8 },
      { sku: 'CAM-BAS-PREM-VERM-GG-SEARCH', tamanho: 'GG', quantidade: 4 },
    ].sort((a, b) => a.sku.localeCompare(b.sku)),
  );

  const local = await saldoInicial(pai, 8, { codigoTamanho: 'G' });
  const noLocal = await searchProducts(empresaA, { q: 'camiseta vermelha', localId: Number(local.local_id), onlyInStock: true });
  assert.equal(noLocal.rows[0].estoque_disponivel, 15);
  const localInexistente = await searchProducts(empresaA, { q: 'camiseta vermelha', localId: 999999 });
  assert.equal(localInexistente.rows[0].estoque_disponivel, 0);
});

test('search: paginação, limite, inativos e barcode inexistente', async () => {
  const primeira = await searchProducts(empresaA, { q: 'search', page: 1, pageSize: 2, includeInactive: true });
  const segunda = await searchProducts(empresaA, { q: 'search', page: 2, pageSize: 2, includeInactive: true });
  assert.equal(primeira.rows.length, 2);
  assert.equal(primeira.pageSize, 2);
  assert.equal(primeira.hasMore, true);
  assert.ok(primeira.total > 2);
  assert.ok(segunda.rows.every((row) => !ids(primeira).includes(row.id)));

  const inativos = await searchProducts(empresaA, { q: 'INATIVO-SEARCH', includeInactive: true });
  assert.deepEqual(ids(inativos), [Number(inativo.id)]);
  assert.equal(inativos.rows[0].ativo, false);
  const inexistente = await searchProducts(empresaA, { q: '0000000000000' });
  assert.equal(inexistente.total, 0);
  assert.deepEqual(inexistente.rows, []);

  assert.throws(() => normalizeProductSearchParams({ pageSize: 51 }), /entre 1 e 50/);
  assert.throws(() => normalizeProductSearchParams({ q: 'x'.repeat(121) }), /120 caracteres/);
  assert.throws(() => normalizeProductSearchParams({ onlyInStock: 'talvez' }), /booleano/);
});

test('estoque: a grade reutiliza a busca central sem mover saldo do pai para as variações', async () => {
  const atorA = await criarAtor(1, 'operador');
  const gradeResponse = await chamar(estoqueGrade, reqDe({}, { user: atorA, query: { q: 'algodão penteado' } }));
  const linhaPai = gradeResponse.linhas.find((linha: any) => Number(linha.produto.id) === Number(pai.id));
  assert.ok(linhaPai, 'a descrição encontra a família na grade');
  assert.equal(linhaPai.total, 15);
  assert.deepEqual(linhaPai.celulas.map((celula: any) => celula.quantidade), [3, 8, 4]);
  assert.equal(gradeResponse.busca.total, 1);
  assert.equal(gradeResponse.busca.exibidos, 1);
  assert.ok(gradeResponse.linhas.some((linha: any) => Number(linha.produto.id) === Number(varianteG.id)));
  assert.ok(gradeResponse.linhas.filter((linha: any) => Number(linha.produto.id) !== Number(pai.id)).every((linha: any) => linha.total === 0));
});

test('search API: autenticação/RBAC usa empresa do ator, nunca empresa_id da query', async () => {
  const atorA = await criarAtor(1, 'operador');
  const atorB = await criarAtor(2, 'operador');
  const a = await chamar(buscarProdutos, reqDe({}, { user: atorA, query: { q: 'camiseta vermelha', empresa_id: '2' } }));
  assert.ok(a.rows.some((row: any) => row.id === Number(pai.id)));
  assert.ok(a.rows.every((row: any) => row.id !== Number(outroTenant.id)));

  const b = await chamar(buscarProdutos, reqDe({}, { user: atorB, query: { q: 'CAMISETA BÁSICA PREMIUM SEARCH' } }));
  assert.deepEqual(b.rows.map((row: any) => row.id), [Number(outroTenant.id)]);
  await esperarErro(() => buscarProdutos(reqDe({}, { user: atorA, query: { pageSize: '500' } }), resFake().res), 400);
});
