// ============================================================================
// LISTAGEM DE CATEGORIAS — busca e filtros no SERVIDOR.
//
// O recurso `categorias` é catálogo GLOBAL (SEC-04): a listagem continua sendo
// servida pelo mesmo `listRecords`, sem endpoint novo. O que estes testes
// travam é o contrato que a tela profissionalizada passou a usar:
//   • busca textual por nome e por descrição (campo `search: true`);
//   • filtro de status (`f.ativo`) e de grade padrão (`f.grade_id`);
//   • filtro de coluna que NÃO pertence ao recurso é ignorado (não vira SQL);
//   • ordenação pela whitelist (nome) e paginação com `total` do conjunto.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { listRecords, createRecord } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin, novoTamanho } = await import('./_p1util');

await garantirAdmin();
const escopo = escopoDeSistema(1);
const ator = await criarAtor(1, 'admin');

const sufixo = `${Date.now() % 1000000}`;

async function novaCategoria(nome: string, extra: Record<string, unknown> = {}) {
  return createRecord(RESOURCES.categorias, { nome, ativo: true, ...extra }, ator);
}

const catCamisa = await novaCategoria(`Camisa ${sufixo}`, { descricao: 'Camisas sociais e casuais' });
const catCamiseta = await novaCategoria(`Camiseta ${sufixo}`, { descricao: 'Malha de algodão' });
const catCalca = await novaCategoria(`Calça ${sufixo}`, { descricao: 'Jeans e sarja', ativo: false });
const catBermuda = await novaCategoria(`Bermuda ${sufixo}`, { descricao: '' });
// Grade real para provar o filtro por referência.
const tam = await novoTamanho(`GC-${sufixo}`);
const grade = await createRecord(RESOURCES.grades, { nome: `Grade Categoria ${sufixo}`, tamanhos: [Number(tam.id)], ativo: true }, ator);
await createRecord(RESOURCES.categorias, { nome: `Calça Jeans ${sufixo}`, ativo: true, grade_id: Number(grade.id) }, ator);

/** Lista só o que este arquivo criou (o seed de demonstração já tem categorias). */
async function listar(p: { page?: number; pageSize?: number; q?: string; sort?: string; dir?: 'asc' | 'desc'; filter?: Record<string, unknown> }) {
  const res = await listRecords(RESOURCES.categorias, { page: 1, pageSize: 500, ...p }, escopo);
  const rows = res.rows.filter((r) => String(r.nome).includes(sufixo));
  return { ...res, rows };
}

test('busca textual encontra por nome e por descrição', async () => {
  const porNome = await listar({ q: `Bermuda ${sufixo}` });
  assert.equal(porNome.rows.length, 1);
  assert.equal(porNome.rows[0].nome, `Bermuda ${sufixo}`);

  // "sociais" só existe na DESCRIÇÃO da categoria Camisa.
  const porDescricao = await listar({ q: 'sociais' });
  assert.ok(
    porDescricao.rows.some((r) => r.nome === `Camisa ${sufixo}`),
    'a busca deve alcançar o campo descricao'
  );
});

test('filtro de status separa ativas de inativas', async () => {
  const ativas = await listar({ filter: { ativo: 'true' } });
  const inativas = await listar({ filter: { ativo: 'false' } });

  assert.ok(ativas.rows.every((r) => r.ativo !== false), 'ativas não incluem a inativa');
  assert.deepEqual(
    inativas.rows.map((r) => r.nome).sort(),
    [`Calça ${sufixo}`],
    'só a categoria desativada aparece no filtro Inativas'
  );
});

test('filtro por grade padrão (referência) devolve só quem usa a grade', async () => {
  const comGrade = await listar({ filter: { grade_id: Number(grade.id) } });
  assert.deepEqual(comGrade.rows.map((r) => r.nome), [`Calça Jeans ${sufixo}`]);
});

test('filtro por coluna inexistente é ignorado — não derruba a lista nem vira SQL', async () => {
  const res = await listar({ filter: { coluna_que_nao_existe: 'x' } });
  assert.equal(res.rows.length, 5, 'todas as categorias do arquivo continuam visíveis');
});

test('ordenação por nome é aceita e o total reflete o conjunto filtrado', async () => {
  const res = await listRecords(RESOURCES.categorias, { page: 1, pageSize: 500, sort: 'nome', dir: 'asc' }, escopo);
  const nomes = res.rows.map((r) => String(r.nome));
  assert.deepEqual(nomes, [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  assert.ok(res.total >= 5);
  // Paginação: 2 por página nunca devolve mais que 2 linhas.
  const pagina = await listRecords(RESOURCES.categorias, { page: 1, pageSize: 2 }, escopo);
  assert.equal(pagina.rows.length, 2);
  assert.equal(pagina.pageSize, 2);
});
