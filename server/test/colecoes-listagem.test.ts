// ============================================================================
// LISTAGEM DE COLEÇÕES — busca, filtros, utilização e dependências.
//
// `colecoes` é cadastro POR EMPRESA (empresa: true) servido pelo mesmo
// `listRecords` genérico — sem endpoint novo. O que estes testes travam:
//   • busca textual por nome (campo `search: true`);
//   • filtro de status (`f.ativo`) e de temporada (select);
//   • filtro de coluna que NÃO pertence ao recurso é ignorado (não vira SQL);
//   • UTILIZAÇÃO: `produtos_vinculados` é anotado com UMA consulta agregada
//     (nunca N+1) e recortado por empresa — a contagem de outra empresa não vaza;
//   • exclusão de coleção em uso é BLOQUEADA (409) com diagnóstico de Produtos;
//   • desativar preserva os produtos vinculados;
//   • multiempresa: uma empresa não vê nem edita a coleção de outra;
//   • operador cria/edita (RBAC preservado), mas não exclui.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { listRecords, createRecord, updateRecord, deleteRecord, getRecord, diagnosticarDependencias, checkAccess } =
  await import('../src/services');
const { HttpError } = await import('../src/errors');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = await criarAtor(1, 'admin');
const escopo = escopoDeSistema(1);

const sufixo = `${Date.now() % 1000000}`;

async function novaColecao(nome: string, extra: Record<string, unknown> = {}, ator = admin) {
  return createRecord(RESOURCES.colecoes, { nome, ativo: true, ...extra }, ator);
}

const colVerao = await novaColecao(`VERÃO ${sufixo}`, { temporada: 'Verão', ano: 2026 });
const colVeraoPrem = await novaColecao(`PREMIUM ${sufixo}`, { temporada: 'Verão', ano: 2027 });
const colInverno = await novaColecao(`INVERNO ${sufixo}`, { temporada: 'Inverno', ano: 2026, ativo: false });

// Produto real apontando para a coleção de verão (para a utilização).
await createRecord(RESOURCES.produtos, { sku: `COL-${sufixo}`, nome: `Camisa ${sufixo}`, preco_venda: 50, colecao_id: Number(colVerao.id) }, admin);

/** Lista só o que este arquivo criou (o seed de demonstração já tem coleções). */
async function listar(p: { page?: number; pageSize?: number; q?: string; filter?: Record<string, unknown> }) {
  const res = await listRecords(RESOURCES.colecoes, { page: 1, pageSize: 500, ...p }, escopo);
  const rows = res.rows.filter((r) => String(r.nome).includes(sufixo));
  return { ...res, rows };
}

test('busca textual encontra coleções pelo nome', async () => {
  const res = await listar({ q: `VERÃO ${sufixo}` });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].nome, `VERÃO ${sufixo}`);

  // O sufixo é comum às três: a busca alcança todas, inclusive a inativa.
  const todas = await listar({ q: sufixo });
  assert.equal(todas.rows.length, 3);
});

test('filtro de status separa ativas de inativas', async () => {
  const ativas = await listar({ filter: { ativo: 'true' } });
  const inativas = await listar({ filter: { ativo: 'false' } });
  assert.ok(ativas.rows.every((r) => r.ativo !== false));
  assert.deepEqual(inativas.rows.map((r) => r.nome), [`INVERNO ${sufixo}`]);
});

test('filtro por temporada (select) devolve só a temporada pedida', async () => {
  const inverno = await listar({ filter: { temporada: 'Inverno' } });
  assert.deepEqual(inverno.rows.map((r) => r.nome), [`INVERNO ${sufixo}`]);
});

test('filtro por coluna inexistente é ignorado — não derruba a lista nem vira SQL', async () => {
  const res = await listar({ filter: { coluna_que_nao_existe: 'x' } });
  assert.equal(res.rows.length, 3);
});

test('utilização: produtos_vinculados traz a contagem REAL (agregada, recortada por empresa)', async () => {
  const res = await listar({});
  const comProduto = res.rows.find((r) => r.nome === `VERÃO ${sufixo}`);
  const semProduto = res.rows.find((r) => r.nome === `PREMIUM ${sufixo}`);
  assert.equal(comProduto?.produtos_vinculados, 1, 'a coleção do produto conta 1');
  assert.equal(semProduto?.produtos_vinculados, 0, 'a coleção sem produto conta 0');
});

test('RBAC preservado: operador cria e edita coleção, mas o servidor recusa a EXCLUSÃO', async () => {
  const op = await criarAtor(1, 'operador');
  // Criar/editar: permitido (cadastro por empresa, sem minPerfilEscrita).
  assert.doesNotThrow(() => checkAccess(RESOURCES.colecoes, op, 'create'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.colecoes, op, 'update'));
  const c = await novaColecao(`OP ${sufixo}`, {}, op);
  const editada = await updateRecord(RESOURCES.colecoes, Number(c.id), { nome: `OP EDIT ${sufixo}` }, op);
  assert.equal(editada?.nome, `OP EDIT ${sufixo}`);

  // Excluir: o servidor barra o operador (autoridade no backend, não na UI).
  assert.throws(
    () => checkAccess(RESOURCES.colecoes, op, 'delete'),
    (e: any) => e instanceof HttpError && e.status === 403,
    'operador não exclui'
  );
  assert.ok(await getRecord(RESOURCES.colecoes, Number(c.id), op), 'a coleção do operador continua');
});

test('exclusão bloqueada: coleção em uso por produtos responde 409 com diagnóstico de Produtos', async () => {
  const diag = await diagnosticarDependencias(RESOURCES.colecoes, Number(colVerao.id), admin);
  assert.equal(diag.bloqueado, true, 'a coleção em uso não pode ser excluída');
  const vinculo = diag.vinculos.find((v) => v.tabela === 'produtos');
  assert.ok(vinculo, 'o vínculo com Produtos aparece no diagnóstico');
  assert.equal(vinculo!.quantidade, 1);
  assert.match(diag.orientacao, /[Dd]esative a coleção/);

  await assert.rejects(
    () => deleteRecord(RESOURCES.colecoes, Number(colVerao.id), admin),
    (e: any) => e instanceof HttpError && e.status === 409 && e.code === 'dependencias_vinculadas'
  );
  // Nada foi apagado — nem a coleção, nem o produto.
  assert.ok(await getRecord(RESOURCES.colecoes, Number(colVerao.id), admin));
});

test('coleção SEM vínculos pode seguir a regra atual de exclusão', async () => {
  const livre = await novaColecao(`LIVRE ${sufixo}`);
  const diag = await diagnosticarDependencias(RESOURCES.colecoes, Number(livre.id), admin);
  assert.equal(diag.podeExcluir, true);
  await deleteRecord(RESOURCES.colecoes, Number(livre.id), admin);
  await assert.rejects(
    () => getRecord(RESOURCES.colecoes, Number(livre.id), admin),
    (e: any) => e instanceof HttpError && e.status === 404,
    'a coleção sem vínculos foi removida'
  );
});

test('desativar preserva os produtos vinculados (o histórico continua apontando)', async () => {
  await updateRecord(RESOURCES.colecoes, Number(colVerao.id), { ativo: false }, admin);
  const colecao = await getRecord(RESOURCES.colecoes, Number(colVerao.id), admin);
  assert.equal(colecao?.ativo, false, 'a coleção fica inativa');
  const produtos = await listRecords(RESOURCES.produtos, { page: 1, pageSize: 500, filter: { colecao_id: Number(colVerao.id) } }, escopo);
  assert.equal(produtos.rows.length, 1, 'o produto continua vinculado à coleção desativada');
});

test('multiempresa: coleção de outra empresa não é visível nem editável, e a contagem não vaza', async () => {
  const b = await createRecord(RESOURCES.empresas, { nome: `EMPRESA COL ${sufixo}` }, admin);
  const B = Number(b.id);
  const atorB = await criarAtor(B, 'gerente');

  const colB = await novaColecao(`EXCLUSIVA B ${sufixo}`, {}, atorB);
  await createRecord(RESOURCES.produtos, { sku: `COLB-${sufixo}`, nome: `Produto B ${sufixo}`, preco_venda: 10, colecao_id: Number(colB.id) }, atorB);

  // A empresa A não vê a coleção da B na listagem.
  const listaA = await listar({});
  assert.equal(listaA.rows.some((r) => Number(r.id) === Number(colB.id)), false, 'coleção da B não aparece para a A');

  // A empresa B vê a própria coleção, com a contagem dos SEUS produtos.
  const escopoB = escopoDeSistema(B);
  const listaB = await listRecords(RESOURCES.colecoes, { page: 1, pageSize: 500 }, escopoB);
  const linhaB = listaB.rows.find((r) => Number(r.id) === Number(colB.id));
  assert.equal(linhaB?.produtos_vinculados, 1, 'a contagem da B é dos produtos da B');

  // A empresa A não edita a coleção da B (404, não 403 — não é oráculo de ids).
  await assert.rejects(
    () => updateRecord(RESOURCES.colecoes, Number(colB.id), { nome: 'invasão' }, admin),
    (e: any) => e instanceof HttpError && e.status === 404
  );
  // E não exclui.
  await assert.rejects(
    () => deleteRecord(RESOURCES.colecoes, Number(colB.id), admin),
    (e: any) => e instanceof HttpError && e.status === 404
  );
  assert.ok(await getRecord(RESOURCES.colecoes, Number(colB.id), atorB), 'a coleção da B continua intacta');
});
