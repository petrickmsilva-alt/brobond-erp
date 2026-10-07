// ============================================================================
// MULTIEMPRESA — teste de SEGURANÇA obrigatório.
//
//   EMPRESA A NÃO PODE ACESSAR DADOS DA EMPRESA B.
//
// Cobre as quatro superfícies por onde o vazamento aconteceria:
//   1) listagem (inclusive tentando injetar `f.empresa_id`);
//   2) leitura direta por id (precisa responder 404, não 403);
//   3) escrita cruzada (editar/excluir o registro da outra empresa);
//   4) referência forjada (venda da A apontando para cliente da B).
//
// Mais: carimbo automático na criação, herança de empresa nas tabelas filhas,
// opções de select recortadas e consolidação como privilégio explícito.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { RESOURCES } = await import('../src/resources');
const { createRecord, deleteRecord, getRecord, listRecords, optionsFor, updateRecord, getStore } = await import('../src/services');
const { escopoDoAtor, escopoIrrestrito } = await import('../src/empresa');

type Ator = {
  id: number;
  name: string;
  perfil: 'admin' | 'gerente' | 'operador';
  empresa_id: number;
  empresas: number[];
  pode_consolidar?: boolean;
  consolidar?: boolean;
};

const EMPRESA_A = 1;
let EMPRESA_B = 0;

const anaDaA: Ator = { id: 101, name: 'Ana (A)', perfil: 'gerente', empresa_id: EMPRESA_A, empresas: [EMPRESA_A] };
let brunoDaB: Ator;
let auditorGrupo: Ator;

async function criarEmpresaB() {
  const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
  const b = await createRecord(RESOURCES.empresas, { nome: 'BROBOND FILIAL SUL', razao_social: 'FILIAL SUL LTDA' }, admin);
  EMPRESA_B = Number(b.id);
  brunoDaB = { id: 102, name: 'Bruno (B)', perfil: 'gerente', empresa_id: EMPRESA_B, empresas: [EMPRESA_B] };
  auditorGrupo = {
    id: 103,
    name: 'Auditor do grupo',
    perfil: 'admin',
    empresa_id: EMPRESA_A,
    empresas: [EMPRESA_A, EMPRESA_B],
    pode_consolidar: true,
  };
}

async function expectStatus(fn: () => Promise<unknown>, status: number, re?: RegExp) {
  try {
    await fn();
    assert.fail(`esperava HTTP ${status}, mas a operação foi permitida`);
  } catch (e: any) {
    assert.equal(e.status, status, `esperava ${status}, veio ${e.status}: ${e.message}`);
    if (re) assert.match(String(e.message), re);
  }
}

test('cenário: duas empresas com cadastros homônimos', async () => {
  await criarEmpresaB();
  assert.ok(EMPRESA_B > EMPRESA_A, 'a empresa B precisa existir');

  const clienteA = await createRecord(RESOURCES.clientes, { nome: 'Loja Centro', cnpj_cpf: '11222333000181' }, anaDaA);
  const clienteB = await createRecord(RESOURCES.clientes, { nome: 'Loja Centro', cnpj_cpf: '11222333000181' }, brunoDaB);

  // A empresa é carimbada pelo SERVIDOR, a partir do ator.
  assert.equal(Number(clienteA.empresa_id), EMPRESA_A);
  assert.equal(Number(clienteB.empresa_id), EMPRESA_B);
  assert.notEqual(Number(clienteA.id), Number(clienteB.id));
});

test('o cliente NÃO escolhe a empresa: empresa_id no corpo é ignorado', async () => {
  const forjado = await createRecord(
    RESOURCES.clientes,
    { nome: 'Tentativa de plantar na B', empresa_id: EMPRESA_B },
    anaDaA
  );
  assert.equal(Number(forjado.empresa_id), EMPRESA_A, 'empresa_id do payload não pode vencer o escopo do ator');
});

test('EMPRESA A não LISTA dados da EMPRESA B', async () => {
  await createRecord(RESOURCES.clientes, { nome: 'Exclusivo da B' }, brunoDaB);

  const vistoPorA = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 200 }, anaDaA);
  const nomesA = vistoPorA.rows.map((r) => String(r.nome));
  assert.ok(!nomesA.includes('Exclusivo da B'), 'A enxergou um cliente da B');
  assert.ok(
    vistoPorA.rows.every((r) => Number(r.empresa_id) === EMPRESA_A),
    'toda linha retornada precisa ser da empresa do ator'
  );

  const vistoPorB = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 200 }, brunoDaB);
  assert.ok(vistoPorB.rows.every((r) => Number(r.empresa_id) === EMPRESA_B));
  assert.ok(vistoPorB.rows.some((r) => String(r.nome) === 'Exclusivo da B'));
});

test('injetar f.empresa_id na query NÃO fura o escopo', async () => {
  const tentativa = await listRecords(
    RESOURCES.clientes,
    { page: 1, pageSize: 200, filter: { empresa_id: EMPRESA_B } },
    anaDaA
  );
  assert.ok(
    tentativa.rows.every((r) => Number(r.empresa_id) === EMPRESA_A),
    'o filtro do cliente sobrescreveu o recorte do servidor'
  );
});

test('EMPRESA A não LÊ por id um registro da EMPRESA B (404, nunca 403)', async () => {
  const daB = await createRecord(RESOURCES.clientes, { nome: 'Sigiloso da B' }, brunoDaB);
  // 404 de propósito: um 403 confirmaria que o id existe.
  await expectStatus(() => getRecord(RESOURCES.clientes, Number(daB.id), anaDaA), 404);
  // E o dono continua lendo normalmente.
  const lido = await getRecord(RESOURCES.clientes, Number(daB.id), brunoDaB);
  assert.equal(String(lido.nome), 'Sigiloso da B');
});

test('EMPRESA A não EDITA nem EXCLUI registro da EMPRESA B', async () => {
  const daB = await createRecord(RESOURCES.clientes, { nome: 'Intocável da B' }, brunoDaB);

  await expectStatus(() => updateRecord(RESOURCES.clientes, Number(daB.id), { nome: 'Sequestrado' }, anaDaA), 404);
  await expectStatus(() => deleteRecord(RESOURCES.clientes, Number(daB.id), anaDaA), 404);

  const intacto = await getRecord(RESOURCES.clientes, Number(daB.id), brunoDaB);
  assert.equal(String(intacto.nome), 'Intocável da B', 'o registro da B não pode ter sido alterado');
});

test('a empresa de um registro é imutável: PUT com empresa_id não transfere', async () => {
  const daA = await createRecord(RESOURCES.clientes, { nome: 'Fica na A' }, anaDaA);
  await updateRecord(RESOURCES.clientes, Number(daA.id), { nome: 'Fica na A mesmo', empresa_id: EMPRESA_B }, anaDaA);
  const depois = await getRecord(RESOURCES.clientes, Number(daA.id), anaDaA);
  assert.equal(Number(depois.empresa_id), EMPRESA_A);
});

test('referência forjada: venda da A não aceita cliente da B', async () => {
  const clienteDaB = await createRecord(RESOURCES.clientes, { nome: 'Cliente só da B' }, brunoDaB);

  await expectStatus(
    () =>
      createRecord(
        RESOURCES.vendas,
        { cliente_id: Number(clienteDaB.id), data: '2026-10-06', status: 'aberta' },
        anaDaA
      ),
    400,
    /não pertence à empresa ativa/i
  );
});

test('tabela filha herda a empresa do pai (espelho do trigger do Postgres)', async () => {
  const produtoB = await createRecord(
    RESOURCES.produtos,
    { sku: 'B-VAR-001', nome: 'Camiseta da Filial', preco_venda: 50 },
    brunoDaB
  );
  assert.equal(Number(produtoB.empresa_id), EMPRESA_B);

  const estoque = await getStore().adjustStock(Number(produtoB.id), 1, 'loja', 5);
  assert.equal(Number(estoque.empresa_id), EMPRESA_B, 'o saldo precisa nascer na empresa do produto');

  // E o saldo da B não aparece para a A.
  const saldosA = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 500 }, anaDaA);
  assert.ok(saldosA.rows.every((r) => Number(r.empresa_id) === EMPRESA_A));
});

test('opções de select só oferecem registros da empresa ativa', async () => {
  const opcoesA = await optionsFor(RESOURCES.clientes, anaDaA);
  const opcoesB = await optionsFor(RESOURCES.clientes, brunoDaB);
  const idsA = new Set(opcoesA.map((o) => o.value));
  const idsB = new Set(opcoesB.map((o) => o.value));
  for (const id of idsB) assert.ok(!idsA.has(id), `o select da A ofereceu o registro ${id} da B`);
  assert.ok(opcoesA.length > 0 && opcoesB.length > 0);
});

test('consolidação é privilégio EXPLÍCITO, não um padrão silencioso', async () => {
  // Sem pedir consolidação, o auditor continua recortado na empresa ativa.
  const recortado = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 300 }, auditorGrupo);
  assert.ok(recortado.rows.every((r) => Number(r.empresa_id) === EMPRESA_A));

  // Pedindo E tendo a permissão, enxerga o grupo.
  const consolidado = await listRecords(
    RESOURCES.clientes,
    { page: 1, pageSize: 300 },
    { ...auditorGrupo, consolidar: true }
  );
  assert.ok(consolidado.rows.some((r) => Number(r.empresa_id) === EMPRESA_B), 'consolidado deveria incluir a B');
  assert.ok(consolidado.total > recortado.total);

  // Pedir sem ter a permissão não consolida nada.
  const semPermissao = await listRecords(
    RESOURCES.clientes,
    { page: 1, pageSize: 300 },
    { ...anaDaA, consolidar: true }
  );
  assert.ok(semPermissao.rows.every((r) => Number(r.empresa_id) === EMPRESA_A), 'consolidou sem pode_consolidar');
});

test('escopoDoAtor: o seletor da sessão só vence quando a empresa foi concedida', async () => {
  // Empresa escolhida está entre as concedidas → vence.
  const ok = escopoDoAtor({ id: 9, empresa_id: EMPRESA_A, empresas: [EMPRESA_A, EMPRESA_B], empresa_sessao: EMPRESA_B });
  assert.equal(ok.empresaId, EMPRESA_B);

  // Empresa escolhida NÃO concedida → cai na padrão, sem erro e sem vazamento.
  const bloqueado = escopoDoAtor({ id: 9, empresa_id: EMPRESA_A, empresas: [EMPRESA_A], empresa_sessao: EMPRESA_B });
  assert.equal(bloqueado.empresaId, EMPRESA_A);

  // Sem ator: escopo de sistema, restrito à empresa padrão.
  assert.equal(escopoDoAtor(null).empresaId, 1);
  assert.equal(escopoDoAtor(null).consolidado, false);

  // Escopo irrestrito é explícito (BI/jobs) e nunca derivável de input.
  assert.equal(escopoIrrestrito().consolidado, true);
});

test('chamada interna sem escopo continua irrestrita (jobs, BI, portal público)', async () => {
  // Compatibilidade: quem não passa escopo (3º argumento) não ganha recorte —
  // é o contrato documentado em empresa.ts para rotinas internas.
  const tudo = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 300 });
  assert.ok(tudo.rows.some((r) => Number(r.empresa_id) === EMPRESA_B));
});
