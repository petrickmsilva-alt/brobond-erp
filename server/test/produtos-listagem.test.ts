// ============================================================================
// LISTAGEM DE PRODUTOS EM ESCALA — paginação, busca, filtros e ordenação.
//
// O que este arquivo trava:
//   • paginação SERVER-SIDE: a página pedida é a página recebida, com `total`
//     do conjunto inteiro (não do que veio na resposta);
//   • tamanhos de página 25/50/100, primeira/última/anterior/próxima e contador;
//   • busca por nome, SKU, código de barras e parcial, com múltiplas palavras;
//   • busca em campos de REFERÊNCIA (categoria, coleção, cor, grade, marca);
//   • filtros por categoria, coleção, cor, grade, formato, status, fornecedor;
//   • filtro de FAIXA de preço (mín/máx) no servidor;
//   • ordenação por whitelist de colunas reais, com direção;
//   • preservação de busca + filtro + ordenação ao trocar de página;
//   • isolamento por empresa (tenant) em lista, busca e filtro;
//   • whitelist de ordenação: nome de coluna arbitrário não vira SQL.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { listRecords, createRecord } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const atorA = await criarAtor(1, 'admin');

// --- empresa B: existe só para provar que nada dela vaza para A -------------
const empresaB = escopoDeSistema(2);
const atorB = await criarAtor(2, 'admin');

const categoria = await createRecord(RESOURCES.categorias, { nome: 'Categoria Escala', ativo: true }, atorA);
const colecao = await createRecord(RESOURCES.colecoes, { nome: 'Coleção Escala', temporada: 'Verão', ano: 2026 }, atorA);
const cor = await createRecord(RESOURCES.cores, { nome: 'Azul Escala', hex: '#1234AB', ativo: true }, atorA);
const tamanho = await createRecord(RESOURCES.tamanhos, { codigo: 'ESC-M', ativo: true }, atorA);
const grade = await createRecord(RESOURCES.grades, { nome: 'Grade Escala', tamanhos: [Number(tamanho.id)], ativo: true }, atorA);
const fornecedor = await createRecord(RESOURCES.fornecedores, { nome: 'Fornecedor Escala', ativo: true }, atorA);

// 120 produtos: suficiente para 5 páginas de 25, 3 de 50 e 2 de 100.
const TOTAL_A = 120;
const produtosA: Record<string, any>[] = [];
for (let i = 1; i <= TOTAL_A; i++) {
  const n = String(i).padStart(3, '0');
  produtosA.push(
    await createRecord(
      RESOURCES.produtos,
      {
        sku: `ESC-${n}`,
        nome: `Produto Escala ${n}`,
        categoria_id: Number(categoria.id),
        colecao_id: Number(colecao.id),
        cor_id: Number(cor.id),
        grade_id: Number(grade.id),
        fornecedor_id: Number(fornecedor.id),
        formato: i % 3 === 0 ? 'variacao' : 'simples',
        ativo: i % 10 !== 0,
        preco_venda: i * 10,
        codigo_barras: i === 7 ? '7891234500007' : null,
        marca: i === 5 ? 'MarcaBusca' : null,
      },
      atorA
    )
  );
}

// Produto da empresa B com o MESMO padrão de nome: não pode aparecer para A.
const produtoB = await createRecord(
  RESOURCES.produtos,
  { sku: 'ESC-B-001', nome: 'Produto Escala 001 da B', empresa_id: 2, ativo: true },
  atorB
);

async function pagina(p: { page: number; pageSize: number; q?: string; sort?: string; dir?: 'asc' | 'desc'; filter?: Record<string, unknown> }) {
  return listRecords(RESOURCES.produtos, p, empresaA);
}

test('paginação: a página pedida volta com o total do conjunto inteiro', async () => {
  const p1 = await pagina({ page: 1, pageSize: 25 });
  assert.equal(p1.rows.length, 25, 'página 1 traz 25 linhas');
  assert.equal(p1.total, TOTAL_A, 'total é o do conjunto filtrado, não o da página');
  assert.equal(p1.page, 1);
  assert.equal(p1.pageSize, 25);

  const p5 = await pagina({ page: 5, pageSize: 25 });
  assert.equal(p5.rows.length, 20, 'última página de 25 traz só o resto (120 - 100)');

  // Não há 6ª página de 25 — o servidor devolve vazio, não "repete a última".
  const p6 = await pagina({ page: 6, pageSize: 25 });
  assert.equal(p6.rows.length, 0);
});

test('paginação: 50 e 100 por página respeitam o recorte', async () => {
  const p50 = await pagina({ page: 1, pageSize: 50 });
  assert.equal(p50.rows.length, 50);
  assert.equal(p50.total, TOTAL_A);

  const p100 = await pagina({ page: 1, pageSize: 100 });
  assert.equal(p100.rows.length, 100);

  const p100b = await pagina({ page: 2, pageSize: 100 });
  assert.equal(p100b.rows.length, TOTAL_A - 100, 'última página de 100 traz só o resto');
});

test('paginação: páginas consecutivas não repetem nem pulam registros', async () => {
  const a = await pagina({ page: 1, pageSize: 25, sort: 'sku', dir: 'asc' });
  const b = await pagina({ page: 2, pageSize: 25, sort: 'sku', dir: 'asc' });
  const idsA = new Set(a.rows.map((r) => Number(r.id)));
  const sobrepostos = b.rows.filter((r) => idsA.has(Number(r.id)));
  assert.equal(sobrepostos.length, 0, 'nenhum registro aparece em duas páginas');
  assert.equal(a.rows.length + b.rows.length, 50);
});

test('busca: nome, SKU, código de barras e parcial', async () => {
  const porNome = await pagina({ page: 1, pageSize: 25, q: 'Produto Escala 042' });
  assert.ok(porNome.rows.some((r) => r.sku === 'ESC-042'), 'acha por nome completo');

  const porSku = await pagina({ page: 1, pageSize: 25, q: 'ESC-077' });
  assert.equal(porSku.total, 1);
  assert.equal(porSku.rows[0].sku, 'ESC-077');

  const porBarcode = await pagina({ page: 1, pageSize: 25, q: '7891234500007' });
  assert.equal(porBarcode.total, 1);
  assert.equal(porBarcode.rows[0].sku, 'ESC-007');

  const parcial = await pagina({ page: 1, pageSize: 25, q: 'Escala 01' });
  assert.ok(parcial.total >= 10, 'busca parcial devolve o conjunto, não só a página');

  const vazio = await pagina({ page: 1, pageSize: 25, q: 'nao-existe-nada-disso' });
  assert.equal(vazio.total, 0);
  assert.equal(vazio.rows.length, 0);
});

test('busca: múltiplas palavras são combinadas com E (AND)', async () => {
  const duas = await pagina({ page: 1, pageSize: 25, q: 'Produto 042' });
  assert.equal(duas.total, 1, 'as duas palavras precisam estar no mesmo produto');

  const impossivel = await pagina({ page: 1, pageSize: 25, q: 'Produto inexistente' });
  assert.equal(impossivel.total, 0);
});

test('busca: alcança campos de referência (categoria, coleção, cor, grade, marca)', async () => {
  for (const termo of ['Categoria Escala', 'Coleção Escala', 'Azul Escala', 'Grade Escala']) {
    const r = await pagina({ page: 1, pageSize: 5, q: termo });
    assert.equal(r.total, TOTAL_A, `busca por "${termo}" alcança os produtos ligados à referência`);
  }
  const marca = await pagina({ page: 1, pageSize: 5, q: 'MarcaBusca' });
  assert.equal(marca.total, 1);
});

test('filtros: categoria, coleção, cor, grade, formato, status e fornecedor', async () => {
  const porCategoria = await pagina({ page: 1, pageSize: 10, filter: { categoria_id: Number(categoria.id) } });
  assert.equal(porCategoria.total, TOTAL_A);

  const porColecao = await pagina({ page: 1, pageSize: 10, filter: { colecao_id: Number(colecao.id) } });
  assert.equal(porColecao.total, TOTAL_A);

  const porCor = await pagina({ page: 1, pageSize: 10, filter: { cor_id: Number(cor.id) } });
  assert.equal(porCor.total, TOTAL_A);

  const porGrade = await pagina({ page: 1, pageSize: 10, filter: { grade_id: Number(grade.id) } });
  assert.equal(porGrade.total, TOTAL_A);

  const porFormato = await pagina({ page: 1, pageSize: 10, filter: { formato: 'variacao' } });
  assert.equal(porFormato.total, 40, 'i % 3 === 0 → 40 produtos com variação');

  const inativos = await pagina({ page: 1, pageSize: 10, filter: { ativo: false } });
  assert.equal(inativos.total, 12, 'i % 10 === 0 → 12 inativos');

  const porFornecedor = await pagina({ page: 1, pageSize: 10, filter: { fornecedor_id: Number(fornecedor.id) } });
  assert.equal(porFornecedor.total, TOTAL_A);
});

test('filtro de faixa de preço: mínimo e máximo no servidor', async () => {
  const ate300 = await pagina({ page: 1, pageSize: 5, filter: { preco_venda_max: 300 } });
  assert.equal(ate300.total, 30, 'preço = i*10 → i<=30');

  const de1000 = await pagina({ page: 1, pageSize: 5, filter: { preco_venda_min: 1000 } });
  assert.equal(de1000.total, 21, 'preço = i*10 → i>=100 (100..120)');

  const faixa = await pagina({ page: 1, pageSize: 5, filter: { preco_venda_min: 500, preco_venda_max: 600 } });
  assert.equal(faixa.total, 11, 'i de 50 a 60');
});

test('ordenação: whitelist por coluna real, com direção', async () => {
  const asc = await pagina({ page: 1, pageSize: 5, sort: 'sku', dir: 'asc' });
  assert.equal(asc.rows[0].sku, 'ESC-001');

  const desc = await pagina({ page: 1, pageSize: 5, sort: 'sku', dir: 'desc' });
  assert.equal(desc.rows[0].sku, 'ESC-120');

  const preco = await pagina({ page: 1, pageSize: 3, sort: 'preco_venda', dir: 'desc' });
  assert.deepEqual(
    preco.rows.map((r) => Number(r.preco_venda)),
    [1200, 1190, 1180]
  );
});

test('ordenação: coluna fora da whitelist cai na ordem padrão (sem SQL injetado)', async () => {
  const r = await pagina({ page: 1, pageSize: 5, sort: 'nome; DROP TABLE produtos', dir: 'asc' });
  assert.equal(r.rows.length, 5, 'a listagem continua respondendo');
  assert.equal(r.total, TOTAL_A);
});

test('estado preservado: busca + filtro + ordenação sobrevivem à troca de página', async () => {
  const filtro = { categoria_id: Number(categoria.id), preco_venda_min: 200 };
  const p1 = await pagina({ page: 1, pageSize: 10, q: 'Escala', sort: 'sku', dir: 'asc', filter: filtro });
  const p2 = await pagina({ page: 2, pageSize: 10, q: 'Escala', sort: 'sku', dir: 'asc', filter: filtro });
  assert.equal(p1.total, p2.total, 'o total não muda ao paginar');
  assert.equal(p1.rows[0].sku, 'ESC-020', 'menor SKU com preço >= 200');
  assert.equal(p2.rows[0].sku, 'ESC-030', 'a página seguinte continua a mesma ordenação');
});

test('multi-tenant: a lista, a busca e o filtro não vazam produto de outra empresa', async () => {
  const lista = await pagina({ page: 1, pageSize: 200 });
  assert.equal(lista.total, TOTAL_A, 'só os produtos da empresa ativa');
  assert.ok(!lista.rows.some((r) => Number(r.id) === Number(produtoB.id)), 'produto da empresa B fora da lista');

  const busca = await pagina({ page: 1, pageSize: 50, q: 'da B' });
  assert.equal(busca.total, 0, 'a busca não encontra o produto de outra empresa');

  // Empresa B enxerga o próprio produto e não os 120 da A.
  const listaB = await listRecords(RESOURCES.produtos, { page: 1, pageSize: 200 }, empresaB);
  assert.equal(listaB.total, 1);
  assert.equal(Number(listaB.rows[0].id), Number(produtoB.id));

  // Um `f.empresa_id` forjado pelo cliente é descartado pelo serviço.
  const forjado = await pagina({ page: 1, pageSize: 200, filter: { empresa_id: 2 } });
  assert.equal(forjado.total, TOTAL_A, 'o recorte do ator vence o filtro injetado');
});
