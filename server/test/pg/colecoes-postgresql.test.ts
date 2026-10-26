// COLEÇÕES — prova no PostgreSQL REAL (job testes-postgres).
// Sem DATABASE_URL este arquivo se auto-pula; nunca usa banco de produção.
//
// O modo memória já cobre o contrato (server/test/colecoes-listagem.test.ts).
// Aqui a pergunta é outra: o SQL que o Postgres EXECUTA — a contagem agregada
// (`countByColumn` → GROUP BY colecao_id), a busca e os filtros de listagem, o
// bloqueio de exclusão por FK e o isolamento por empresa — honra o mesmo
// contrato? São caminhos de código distintos (pgstore.ts monta o SQL).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';
const sufixo = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

test('Coleções no PostgreSQL: utilização agregada, busca, filtros, dependências e tenant', { skip }, async (t) => {
  const { migrate } = await import('../../src/db');
  await migrate();
  const { RESOURCES: R } = await import('../../src/resources');
  const { createRecord, listRecords, updateRecord, deleteRecord, diagnosticarDependencias, escopoDe } = await import('../../src/services');

  const admin = { id: 1, name: 'Admin Coleções PG', perfil: 'admin' as const };
  const empA = await createRecord(R.empresas, { nome: `COLEÇÕES PG A ${sufixo}` }, admin);
  const empB = await createRecord(R.empresas, { nome: `COLEÇÕES PG B ${sufixo}` }, admin);
  const aId = Number(empA.id);
  const bId = Number(empB.id);
  const escopoA = escopoDe({ id: 0, name: 'A', perfil: 'gerente', empresa_id: aId, empresas: [aId] } as any);
  const escopoB = escopoDe({ id: 0, name: 'B', perfil: 'gerente', empresa_id: bId, empresas: [bId] } as any);
  const atorA = { ...admin, empresa_id: aId, empresas: [aId] } as any;
  const atorB = { ...admin, empresa_id: bId, empresas: [bId] } as any;

  const usada = await createRecord(R.colecoes, { nome: `USADA ${sufixo}`, temporada: 'Verão', ano: 2026, ativo: true }, atorA);
  const vazia = await createRecord(R.colecoes, { nome: `VAZIA ${sufixo}`, temporada: 'Inverno', ano: 2026, ativo: true }, atorA);
  const inativa = await createRecord(R.colecoes, { nome: `INATIVA ${sufixo}`, temporada: 'Verão', ano: 2027, ativo: false }, atorA);
  const deB = await createRecord(R.colecoes, { nome: `EXCLUSIVA B ${sufixo}`, temporada: 'Verão', ano: 2026, ativo: true }, atorB);

  // 3 produtos da empresa A apontam para `usada`; 1 produto da B aponta para `deB`.
  for (let i = 1; i <= 3; i++) {
    await createRecord(R.produtos, { sku: `COLP-${i}-${sufixo}`.slice(0, 40), nome: `Produto ${i} ${sufixo}`, preco_venda: 10 * i, colecao_id: Number(usada.id) }, atorA);
  }
  await createRecord(R.produtos, { sku: `COLB-${sufixo}`.slice(0, 40), nome: `Produto B ${sufixo}`, preco_venda: 10, colecao_id: Number(deB.id) }, atorB);

  const listar = (p: any = {}, escopo = escopoA) => listRecords(R.colecoes, { page: 1, pageSize: 500, ...p }, escopo);
  const soMeu = (res: any) => res.rows.filter((r: any) => String(r.nome).includes(sufixo));

  await t.test('utilização: a contagem agregada (GROUP BY) traz o número REAL por coleção', async () => {
    const res = await listar();
    const linhas = soMeu(res);
    const porNome = new Map(linhas.map((r: any) => [String(r.nome), r]));
    assert.equal((porNome.get(`USADA ${sufixo}`) as any)?.produtos_vinculados, 3, 'a usada conta 3');
    assert.equal((porNome.get(`VAZIA ${sufixo}`) as any)?.produtos_vinculados, 0, 'a vazia conta 0');
    assert.equal((porNome.get(`USADA ${sufixo}`) as any)?.em_uso, true);
    assert.equal((porNome.get(`VAZIA ${sufixo}`) as any)?.em_uso, false);
  });

  await t.test('busca por nome no SQL e filtro de status', async () => {
    const porNome = await listar({ q: `USADA ${sufixo}` });
    assert.equal(soMeu(porNome).length, 1);
    const inativas = await listar({ filter: { ativo: false } });
    assert.ok(soMeu(inativas).every((r: any) => r.ativo === false));
    assert.ok(soMeu(inativas).some((r: any) => Number(r.id) === Number(inativa.id)));
    const verao = await listar({ filter: { temporada: 'Verão' } });
    assert.ok(soMeu(verao).every((r: any) => r.temporada === 'Verão'));
  });

  await t.test('exclusão bloqueada: coleção em uso responde 409 com diagnóstico de Produtos', async () => {
    const diag = await diagnosticarDependencias(R.colecoes, Number(usada.id), escopoA);
    assert.ok(diag.bloqueado, 'o diagnóstico marca como bloqueado');
    const grupos = JSON.stringify(diag);
    assert.match(grupos, /Produtos/, 'o diagnóstico aponta o módulo Produtos');
    await assert.rejects(() => deleteRecord(R.colecoes, Number(usada.id), atorA), (e: any) => e.status === 409);
  });

  await t.test('coleção sem vínculos segue a regra atual de exclusão', async () => {
    await deleteRecord(R.colecoes, Number(vazia.id), atorA);
    const res = await listar();
    assert.equal(soMeu(res).some((r: any) => Number(r.id) === Number(vazia.id)), false, 'a vazia foi excluída');
  });

  await t.test('desativar preserva os produtos vinculados', async () => {
    await updateRecord(R.colecoes, Number(usada.id), { ativo: false }, atorA);
    const produtos = await listRecords(R.produtos, { page: 1, pageSize: 500, filter: { colecao_id: Number(usada.id) } }, escopoA);
    assert.equal(produtos.total, 3, 'os 3 produtos continuam apontando para a coleção desativada');
  });

  await t.test('multi-tenant: coleção de outra empresa não é visível nem editável, e a contagem não vaza', async () => {
    const deA = await listar();
    assert.equal(soMeu(deA).some((r: any) => Number(r.id) === Number(deB.id)), false, 'a A não vê a coleção da B');
    const listaB = await listar({}, escopoB);
    const linhaB = listaB.rows.find((r: any) => Number(r.id) === Number(deB.id));
    assert.equal(linhaB?.produtos_vinculados, 1, 'a B conta só o produto dela');
    await assert.rejects(() => updateRecord(R.colecoes, Number(deB.id), { nome: 'invasão' }, atorA), (e: any) => e.status === 404);
    await assert.rejects(() => deleteRecord(R.colecoes, Number(deB.id), atorA), (e: any) => e.status === 404);
  });
});
