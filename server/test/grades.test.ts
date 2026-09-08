// Testes da grade efetiva do produto: endpoint de tamanhos por grade, colunas
// por grade na matriz de estoque e anexação da grade na contagem do inventário.
// Rodam no banco em memória (modo demonstração) — não precisam de Postgres.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

/** req/res falsos suficientes para os handlers de leitura (currentUser = req.user). */
function fakeReq(params: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  return { user: { id: 1, name: 'Admin', email: 'admin@brobond.com.br', perfil: 'admin' }, params, query, body: {}, headers: {}, ip: '127.0.0.1' } as any;
}
function fakeRes() {
  const out: any = { code: 200, body: null as unknown };
  out.json = (b: unknown) => {
    out.body = b;
    return out;
  };
  out.status = (c: number) => {
    out.code = c;
    return out;
  };
  out.setHeader = () => out;
  return out;
}

const s = getStore();
let categoriaComGrade: number;
let categoriaSemGrade: number;
let gradeEsperada: { id: number; nome: string; tamanhos: number[] };
let produtoComGrade: number;
let produtoSemGrade: number;

before(async () => {
  const categorias = (await s.list(RESOURCES.categorias, { page: 1, pageSize: 50 })).rows;
  const grades = (await s.list(RESOURCES.grades, { page: 1, pageSize: 50 })).rows;
  assert.ok(categorias.length && grades.length, 'seed de demonstração deve ter categorias e grades');

  const cat = categorias.find((c) => Number(c.grade_id))!;
  const grade = grades.find((g) => Number(g.id) === Number(cat.grade_id))!;
  const itensGrade = (await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 200, filter: { grade_id: Number(grade.id) }, sort: 'ordem', dir: 'asc' })).rows;
  categoriaComGrade = Number(cat.id);
  gradeEsperada = { id: Number(grade.id), nome: String(grade.nome), tamanhos: itensGrade.map((i) => Number(i.tamanho_id)) };
  assert.ok(gradeEsperada.tamanhos.length >= 2, 'a grade de exemplo precisa ter ao menos 2 tamanhos');

  const semGrade = categorias.find((c) => !Number(c.grade_id) && Number(c.id) !== Number(cat.id))!;
  categoriaSemGrade = Number(semGrade.id);

  const sufixo = Date.now() % 1000000;
  produtoComGrade = Number((await createRecord(RESOURCES.produtos, { sku: `GT-C-${sufixo}`, nome: 'Grad Test Camiseta', categoria_id: categoriaComGrade, custo: 10, preco_venda: 30 }, admin)).id);
  produtoSemGrade = Number((await createRecord(RESOURCES.produtos, { sku: `GT-S-${sufixo}`, nome: 'Grad Test Jaqueta', categoria_id: categoriaSemGrade, custo: 50, preco_venda: 200 }, admin)).id);
});

test('GET /produtos/:id/tamanhos devolve apenas os tamanhos da grade da categoria', async () => {
  const { produtoTamanhos } = await import('../src/detail');
  const res = fakeRes();
  await produtoTamanhos(fakeReq({ id: String(produtoComGrade) }), res);

  assert.equal(res.body.grade.id, gradeEsperada.id);
  assert.equal(res.body.grade.nome, gradeEsperada.nome);
  assert.deepEqual(
    res.body.tamanhos.map((t: any) => t.id),
    gradeEsperada.tamanhos,
    'os tamanhos devem vir na ordem cadastrada na grade'
  );
});

test('GET /produtos/:id/tamanhos não trava para produto sem grade', async () => {
  const { produtoTamanhos } = await import('../src/detail');
  const res = fakeRes();
  await produtoTamanhos(fakeReq({ id: String(produtoSemGrade) }), res);

  const todos = (await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500 })).rows;
  assert.equal(res.body.grade, null);
  assert.equal(res.body.tamanhos.length, todos.length, 'sem grade → lista completa, para não bloquear o lançamento');
});

test('GET /produtos/:id/tamanhos responde 404 para produto inexistente', async () => {
  const { produtoTamanhos } = await import('../src/detail');
  await assert.rejects(() => produtoTamanhos(fakeReq({ id: '999999999' }), fakeRes()), (e: any) => e.status === 404);
});

test('a grade do produto sobrescreve a grade da categoria', async () => {
  const outras = (await s.list(RESOURCES.grades, { page: 1, pageSize: 50 })).rows.filter((g) => Number(g.id) !== gradeEsperada.id);
  let outra: any;
  for (const g of outras) {
    const t = (await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 50, filter: { grade_id: Number(g.id) } })).rows;
    if (t.length) {
      outra = { grade: g, tamanhos: t.map((i) => Number(i.tamanho_id)) };
      break;
    }
  }
  assert.ok(outra, 'seed precisa de outra grade com tamanhos para testar o override');

  const produto = await s.findOneWhere(RESOURCES.produtos, { id: produtoComGrade });
  await s.update(RESOURCES.produtos, produtoComGrade, { grade_id: Number(outra.grade.id) });
  try {
    const { produtoTamanhos } = await import('../src/detail');
    const res = fakeRes();
    await produtoTamanhos(fakeReq({ id: String(produtoComGrade) }), res);
    assert.equal(res.body.grade.nome, String(outra.grade.nome));
    assert.deepEqual(res.body.tamanhos.map((t: any) => t.id), outra.tamanhos);
  } finally {
    await s.update(RESOURCES.produtos, produtoComGrade, { grade_id: produto.grade_id ?? null });
  }
});

test('GET /estoques/grade expõe colunasPorGrade para a tela agrupar por grade', async () => {
  const { estoqueGrade } = await import('../src/estoque');
  const res = fakeRes();
  await estoqueGrade(fakeReq(), res);

  const porGrade = res.body.colunasPorGrade as Record<string, { id: number; codigo: string }[]>;
  assert.ok(porGrade && Object.keys(porGrade).length > 0, 'colunasPorGrade deve listar as grades cadastradas');
  const tamanhos = (await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500 })).rows;
  const codigoPor = new Map(tamanhos.map((t) => [Number(t.id), String(t.codigo)]));
  for (const [gid, cols] of Object.entries(porGrade)) {
    const itensGrade = (await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 500, filter: { grade_id: Number(gid) }, sort: 'ordem', dir: 'asc' })).rows;
    assert.deepEqual(
      cols.map((c) => c.id),
      itensGrade.map((i) => Number(i.tamanho_id)),
      `grade ${gid}: colunas = tamanhos da grade, na ordem dela`
    );
    assert.ok(cols.every((c) => c.codigo === codigoPor.get(c.id)), 'cada coluna precisa do código do tamanho');
  }
});

test('contagem do inventário recebe a grade do produto para agrupar por grade', async () => {
  const { listItensInventario } = await import('../src/estoque');
  const inv = Number(await (async () => {
    const r = await s.insert(RESOURCES.inventarios, { local: 'loja', status: 'aberto' });
    return Number(r.id);
  })());
  await s.insert(RESOURCES.itens_inventario, { inventario_id: inv, produto_id: produtoComGrade, tamanho_id: gradeEsperada.tamanhos[0], saldo_sistema: 5, contado: 4, diferenca: -1 });
  await s.insert(RESOURCES.itens_inventario, { inventario_id: inv, produto_id: produtoSemGrade, tamanho_id: gradeEsperada.tamanhos[1], saldo_sistema: 2, contado: null, diferenca: 0 });

  const res = fakeRes();
  await listItensInventario(fakeReq({ id: String(inv) }), res);
  const linhas = res.body as any[];
  assert.equal(linhas.length, 2);

  const comGrade = linhas.find((l) => Number(l.produto_id) === produtoComGrade)!;
  assert.equal(Number(comGrade.produto_id__grade_id), gradeEsperada.id);
  assert.equal(comGrade.produto_id__grade_nome, gradeEsperada.nome);
  assert.ok(comGrade.produto_id__label, 'o rótulo do produto continua sendo anexado');
  assert.equal(Number(comGrade.diferenca), -1, 'a diferença volta calculada');

  const semGrade = linhas.find((l) => Number(l.produto_id) === produtoSemGrade)!;
  assert.equal(semGrade.produto_id__grade_id, null, 'produto sem grade agrupa em “Sem grade definida”');
  assert.equal(semGrade.produto_id__grade_nome, null);
});
