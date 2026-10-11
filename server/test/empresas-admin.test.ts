// ============================================================================
// ERP-07 — ADMINISTRAÇÃO DE EMPRESAS (P1-04).
//
// Dois defeitos comprovados antes deste ciclo:
//
//   1) FALTA DE ALÇADA. O recurso `empresas` tinha `ops: ALL_OPS` e **nenhuma**
//      restrição: qualquer operador incluía/alterava empresa e qualquer gerente
//      excluía, tudo pelo CRUD genérico (`POST/PUT/DELETE /api/empresas`), sem
//      tela e sem o `audit:menu` sinalizar (ponto cego do P2-05). Administrar
//      empresa é ato de ADMINISTRADOR — como usuários, auditoria e webhooks.
//      A troca da empresa ATIVA da sessão é outro caminho (`/api/empresas/ativa`)
//      e continua funcionando para quem tem a concessão.
//
//   2) EXCLUSÃO SEM GUARDA. Nada impedia apagar a empresa padrão (id 1 — o alvo
//      do motor analítico e das vendas multicanal) nem uma empresa com usuários
//      vinculados; no modo demonstração (sem FKs) uma empresa com dados
//      operacionais era apagada deixando o histórico órfão.
//
// Este arquivo prova os dois, e prova também o que continua funcionando: o
// administrador cria, edita, desativa e exclui empresa vazia.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, deleteRecord, getRecord, listRecords, updateRecord, getStore } = await import('../src/services');

type Perfil = 'admin' | 'gerente' | 'operador';
type Ator = { id: number; name: string; perfil: Perfil; empresa_id: number; empresas: number[] };

const ADMIN: Ator = { id: 1, name: 'Admin ERP-07', perfil: 'admin', empresa_id: 1, empresas: [1] };
const GERENTE: Ator = { id: 2, name: 'Gerente ERP-07', perfil: 'gerente', empresa_id: 1, empresas: [1] };
const OPERADOR: Ator = { id: 3, name: 'Operador ERP-07', perfil: 'operador', empresa_id: 1, empresas: [1] };

async function esperarErro(fn: () => Promise<unknown>, status: number, re?: RegExp) {
  try {
    await fn();
    assert.fail(`esperava HTTP ${status}, mas a operação foi permitida`);
  } catch (e: any) {
    assert.equal(e.status, status, `esperava ${status}, veio ${e.status}: ${e.message}`);
    if (re) assert.match(String(e.message), re);
  }
}

// ---------------------------------------------------------------------------
// 1) Alçada: só administrador administra empresas
//
// A checagem de permissão é a MESMA função que as rotas do CRUD genérico
// chamam (`checkAccess` em index.ts) — é ela que transforma a declaração do
// recurso em 403/405 na API. O e2e em PostgreSQL (`pg/empresas-admin-e2e.test.ts`)
// prova o mesmo por HTTP, com um token de gerente de verdade.
// ---------------------------------------------------------------------------

test('ERP-07: o recurso `empresas` declara alçada de administrador', async () => {
  assert.equal(RESOURCES.empresas.adminOnly, true, 'sem isto, qualquer perfil administra empresas pela API');
  assert.ok(RESOURCES.empresas.ops.create && RESOURCES.empresas.ops.update && RESOURCES.empresas.ops.delete, 'o CRUD continua existindo — para o administrador');
});

test('ERP-07: operador NÃO cria e NÃO altera empresa (403) — era permitido antes da correção', async () => {
  await esperarErro(async () => checkAccess(RESOURCES.empresas, OPERADOR, 'create'), 403, /administradores/i);
  await esperarErro(async () => checkAccess(RESOURCES.empresas, OPERADOR, 'update'), 403, /administradores/i);
});

test('ERP-07: gerente NÃO cria, NÃO altera e NÃO exclui empresa', async () => {
  await esperarErro(async () => checkAccess(RESOURCES.empresas, GERENTE, 'create'), 403, /administradores/i);
  await esperarErro(async () => checkAccess(RESOURCES.empresas, GERENTE, 'update'), 403, /administradores/i);
  await esperarErro(async () => checkAccess(RESOURCES.empresas, GERENTE, 'delete'), 403, /administradores/i);

  // Administrador passa pela mesma checagem (a tela de Empresas é dele).
  checkAccess(RESOURCES.empresas, ADMIN, 'create');
  checkAccess(RESOURCES.empresas, ADMIN, 'update');
  checkAccess(RESOURCES.empresas, ADMIN, 'delete');
});

test('ERP-07: gerente e operador NÃO leem a lista de empresas pelo CRUD (o seletor tem rota própria)', async () => {
  await esperarErro(async () => checkAccess(RESOURCES.empresas, GERENTE, 'read'), 403, /administradores/i);
  await esperarErro(async () => checkAccess(RESOURCES.empresas, OPERADOR, 'read'), 403, /administradores/i);

  // O administrador continua enxergando — e a empresa padrão está lá.
  const lista = await listRecords(RESOURCES.empresas, { page: 1, pageSize: 50 }, ADMIN);
  assert.ok(lista.rows.some((r) => Number(r.id) === 1), 'a empresa padrão aparece para o administrador');
});

test('ERP-07: administrador cria, edita e desativa empresa', async () => {
  const criada = await createRecord(RESOURCES.empresas, { nome: 'BROBOND FILIAL NORTE', cnpj: '11222333000181' }, ADMIN);
  assert.ok(Number(criada.id) > 0);

  const renomeada = await updateRecord(RESOURCES.empresas, Number(criada.id), { nome: 'BROBOND FILIAL NORTE II' }, ADMIN);
  assert.equal(String(renomeada.nome), 'BROBOND FILIAL NORTE II');

  const desativada = await updateRecord(RESOURCES.empresas, Number(criada.id), { ativo: false }, ADMIN);
  assert.equal(desativada.ativo, false);
});

// ---------------------------------------------------------------------------
// 2) Exclusão: a empresa padrão e a empresa em uso não se apagam
// ---------------------------------------------------------------------------

test('ERP-07: a empresa PADRÃO (id 1) não pode ser excluída — nem pelo administrador', async () => {
  await esperarErro(() => deleteRecord(RESOURCES.empresas, 1, ADMIN), 409, /empresa padrão|BROBOND/i);
  const padrao = await getRecord(RESOURCES.empresas, 1, ADMIN);
  assert.ok(padrao, 'a empresa padrão continua existindo');
});

test('ERP-07: empresa com ACESSO concedido a usuário não é excluída (a FK levaria a concessão junto)', async () => {
  const empresa = await createRecord(RESOURCES.empresas, { nome: 'Empresa Com Acesso' }, ADMIN);
  const empresaId = Number(empresa.id);

  const usuario = await createRecord(
    RESOURCES.usuarios,
    { nome: 'Gestor Filial', email: `erp07-${Date.now().toString(36)}@teste.local`, perfil: 'gerente', ativo: true },
    ADMIN
  );
  await getStore().insert(RESOURCES.usuario_empresas, { usuario_id: Number(usuario.id), empresa_id: empresaId });

  await esperarErro(() => deleteRecord(RESOURCES.empresas, empresaId, ADMIN), 409, /usuário|acesso/i);
  const ainda = await getRecord(RESOURCES.empresas, empresaId, ADMIN);
  assert.ok(ainda, 'a empresa continua existindo');
});

test('ERP-07: empresa com DADOS operacionais não é excluída — a mensagem diz qual vínculo existe', async () => {
  const empresa = await createRecord(RESOURCES.empresas, { nome: 'Empresa Com Produto' }, ADMIN);
  const empresaId = Number(empresa.id);

  // Produto da empresa (caminho normal: o carimbo usa a empresa ativa do ator).
  const atorDaEmpresa: Ator = { id: 1, name: 'Admin ERP-07', perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] };
  await createRecord(RESOURCES.produtos, { sku: `ERP07-${Date.now().toString(36)}`, nome: 'Produto da filial', custo: 10, preco_venda: 20 }, atorDaEmpresa);

  await esperarErro(() => deleteRecord(RESOURCES.empresas, empresaId, ADMIN), 409, /registros de|histórico/i);
  assert.ok(await getRecord(RESOURCES.empresas, empresaId, ADMIN), 'a empresa continua existindo');
});

test('ERP-07: empresa NOVA e vazia o administrador exclui normalmente', async () => {
  const empresa = await createRecord(RESOURCES.empresas, { nome: 'Empresa Descartável' }, ADMIN);
  const empresaId = Number(empresa.id);

  await deleteRecord(RESOURCES.empresas, empresaId, ADMIN);

  const restantes = await listRecords(RESOURCES.empresas, { page: 1, pageSize: 200 }, ADMIN);
  assert.equal(
    restantes.rows.some((r) => Number(r.id) === empresaId),
    false,
    'a empresa vazia foi excluída'
  );
});
