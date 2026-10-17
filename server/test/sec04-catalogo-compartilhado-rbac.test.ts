// ============================================================================
// SEC-04 / P1-01 — CATÁLOGO COMPARTILHADO + RBAC (contrato do guard).
//
// `categorias`, `cores`, `grades` e `tamanhos` são catálogo GLOBAL: as tabelas
// não têm `empresa_id` (db/schema.sql) e a mesma lista vale para todas as
// empresas. O finding: um OPERADOR autenticado conseguia incluir/alterar esses
// cadastros (só a exclusão já era barrada), reescrevendo nomenclatura que
// afeta as outras empresas.
//
// A LEITURA precisa continuar aberta: telas operacionais (vendas, compras,
// estoque, inventário, ordens, expedição) consomem `/options` desses recursos.
// O guard canônico é `checkAccess(r, actor, op)`; este ciclo acrescenta o piso
// de ESCRITA `minPerfilEscrita` sem tocar em leitura, multiempresa ou RBAC
// existente.
//
// Aqui provamos o contrato no harness em memória; a prova HTTP real contra
// PostgreSQL está no arquivo irmão `pg/sec04-catalogo-compartilhado-rbac.test.ts`.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, getStore, listRecords, updateRecord, deleteRecord } = await import('../src/services');
const { ADMIN, criarAtor, esperarErro } = await import('./_p1util');

const CATALOGO_GLOBAL = ['categorias', 'cores', 'grades', 'tamanhos'] as const;
const OPS = ['create', 'update', 'delete'] as const;

test('SEC-04/P1-01: catálogo compartilhado declara piso de ESCRITA gerente (não de leitura)', () => {
  for (const key of CATALOGO_GLOBAL) {
    const r = RESOURCES[key];
    assert.equal(r.minPerfilEscrita, 'gerente', `${key} deve exigir gerente para escrever`);
    // Leitura permanece aberta: sem minPerfil/adminOnly que a bloqueie.
    assert.equal(r.minPerfil, undefined, `${key} não pode exigir perfil para LER (telas operacionais usam /options)`);
    assert.equal(r.adminOnly, undefined, `${key} não é adminOnly`);
    assert.equal(r.ops.create, true, `${key} mantém a operação declarada (o piso é quem decide)`);
    assert.equal(r.ops.update, true, `${key} mantém update declarado`);
    assert.equal(r.ops.delete, true, `${key} mantém delete declarado`);
  }
});

test('SEC-04/P1-01: OPERADOR lê o catálogo global, mas não inclui/altera/exclui', async () => {
  const operador = await criarAtor(1, 'operador');
  for (const key of CATALOGO_GLOBAL) {
    const r = RESOURCES[key];
    // Leitura operacional continua permitida (dropdowns de venda/estoque/ordem).
    assert.doesNotThrow(() => checkAccess(r, operador as any, 'read'), `${key}: operador precisa LER`);
    for (const op of OPS) {
      assert.throws(
        () => checkAccess(r, operador as any, op),
        (e: any) => e.status === 403 && /gerentes e administradores/i.test(String(e.message)),
        `${key}: operador não pode ${op}`
      );
    }
  }
});

test('SEC-04/P1-01: GERENTE e ADMIN gerenciam o catálogo compartilhado', async () => {
  const gerente = await criarAtor(1, 'gerente');
  for (const key of CATALOGO_GLOBAL) {
    const r = RESOURCES[key];
    for (const op of ['read', ...OPS] as const) {
      assert.doesNotThrow(() => checkAccess(r, gerente as any, op), `${key}: gerente deve poder ${op}`);
      assert.doesNotThrow(() => checkAccess(r, ADMIN as any, op), `${key}: admin deve poder ${op}`);
    }
  }
});

test('SEC-04/P1-01: spoofing de role/perfil/empresa_id no ator não eleva privilégio', async () => {
  const operador = await criarAtor(1, 'operador');
  // Campos que um cliente malicioso poderia tentar injetar no corpo/headers não
  // existem no Ator; o perfil vem do cadastro. Simulamos o pior caso: o objeto
  // do ator com propriedades extras — `checkAccess` só olha `perfil`.
  const forjado = { ...operador, role: 'admin', is_admin: true, admin: true, perfil_admin: true } as any;
  for (const key of CATALOGO_GLOBAL) {
    const r = RESOURCES[key];
    for (const op of OPS) {
      assert.throws(
        () => checkAccess(r, forjado, op),
        (e: any) => e.status === 403,
        `${key}: campos forjados não podem liberar ${op}`
      );
    }
  }
  // E um operador de OUTRA empresa (com empresa_id válida) também não escreve.
  const operadorB = await criarAtor(2, 'operador');
  for (const key of CATALOGO_GLOBAL) {
    assert.throws(() => checkAccess(RESOURCES[key], operadorB as any, 'create'), (e: any) => e.status === 403, `${key}: operador da empresa B`);
  }
});

test('SEC-04/P1-01: a escrita passa pelo guard da rota e o serviço grava (ADMIN/GERENTE)', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');
  const store = getStore();

  // A autorização vive na ROTA (o handler chama checkAccess ANTES do serviço).
  // Reproduzimos essa composição: guard + createRecord.
  const escrever = async (actor: any, op: 'create' | 'update' | 'delete', fn: () => Promise<any>) => {
    checkAccess(RESOURCES.categorias, actor, op);
    return fn();
  };

  // OPERADOR: a rota recusa incluir categoria global (403), sem gravar nada.
  await esperarErro(() => escrever(operador, 'create', () => createRecord(RESOURCES.categorias, { nome: `SEC04-op-${Date.now()}` }, operador)), 403);

  // GERENTE: a rota deixa passar e o serviço grava de verdade.
  const nome = `SEC04-g-${Date.now()}`;
  const criada = await escrever(gerente, 'create', () => createRecord(RESOURCES.categorias, { nome }, gerente));
  assert.ok(Number(criada.id) > 0, 'gerente precisa incluir categoria');
  const alterada = await escrever(gerente, 'update', () => updateRecord(RESOURCES.categorias, Number(criada.id), { descricao: 'SEC-04' }, gerente));
  assert.equal(String(alterada.descricao), 'SEC-04');

  // OPERADOR tentando alterar/excluir a mesma categoria: recusado pelo guard.
  await esperarErro(() => escrever(operador, 'update', () => updateRecord(RESOURCES.categorias, Number(criada.id), { descricao: 'hack' }, operador)), 403);
  await esperarErro(() => escrever(operador, 'delete', () => deleteRecord(RESOURCES.categorias, Number(criada.id), operador)), 403);

  // A leitura operacional continua funcionando e vê o registro.
  const lista = await listRecords(RESOURCES.categorias, { page: 1, pageSize: 200, filter: { nome } }, operador as any);
  assert.ok(lista.rows.some((row: any) => Number(row.id) === Number(criada.id)), 'operador precisa LER o catálogo');

  // Limpeza (gerente pode excluir).
  await deleteRecord(RESOURCES.categorias, Number(criada.id), gerente as any);
  void store;
});
