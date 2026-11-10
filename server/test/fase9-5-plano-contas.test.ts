// ============================================================================
// FASE 9.5 — PLANO DE CONTAS: hierarquia, ciclo, tipo e classificação.
//
// O que este arquivo trava (banco de demonstração, mesmo contrato do PG):
//   A) hierarquia: a conta aceita um pai SINTÉTICO da MESMA empresa;
//   B) pai analítico é recusado — conta com filhas só agrupa;
//   C) autorreferência é recusada;
//   D) ciclo é recusado (subir a cadeia de pais não pode voltar à conta);
//   E) conta com filhas não pode virar analítica;
//   F) exclusão bloqueada quando há filhas ou lançamento classificado;
//   G) isolamento multiempresa: o pai precisa ser da empresa do ator;
//   H) lançamento só classifica em conta ANALÍTICA da própria empresa.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, deleteRecord, getStore } = await import('../src/services');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;
let gerenteB: any;

const unico = (() => { let n = 0; return () => `${Date.now() % 1000000}${++n}`; })();

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  gerenteB = await criarAtor(2, 'gerente');
});

test('A) hierarquia: conta analítica aceita um pai sintético da mesma empresa', async () => {
  const c = unico();
  const pai = await createRecord(RESOURCES.plano_contas, { codigo: `1.${c}`, nome: 'Ativo', natureza: 'ativo', tipo: 'sintetica' }, admin);
  const filha = await createRecord(RESOURCES.plano_contas, { codigo: `1.${c}.01`, nome: 'Caixa', natureza: 'ativo', tipo: 'analitica', pai_id: Number(pai.id) }, admin);
  assert.equal(Number(filha.pai_id), Number(pai.id));
});

test('B) pai analítico é recusado com 400', async () => {
  const c = unico();
  const analitica = await createRecord(RESOURCES.plano_contas, { codigo: `2.${c}`, nome: 'Receita', natureza: 'receita', tipo: 'analitica' }, admin);
  await esperarErro(
    () => createRecord(RESOURCES.plano_contas, { codigo: `2.${c}.01`, nome: 'Vendas', natureza: 'receita', tipo: 'analitica', pai_id: Number(analitica.id) }, admin),
    400,
    /analítica/
  );
});

test('C) autorreferência é recusada com 400', async () => {
  const c = unico();
  const conta = await createRecord(RESOURCES.plano_contas, { codigo: `3.${c}`, nome: 'Custo', natureza: 'custo', tipo: 'sintetica' }, admin);
  await esperarErro(
    () => updateRecord(RESOURCES.plano_contas, Number(conta.id), { pai_id: Number(conta.id) }, admin),
    400,
    /pai de si mesma/
  );
});

test('D) ciclo é recusado: avô → pai → filho, reatar o avô ao neto falha', async () => {
  const c = unico();
  const avo = await createRecord(RESOURCES.plano_contas, { codigo: `4.${c}`, nome: 'Despesa', natureza: 'despesa', tipo: 'sintetica' }, admin);
  const pai = await createRecord(RESOURCES.plano_contas, { codigo: `4.${c}.01`, nome: 'Administrativa', natureza: 'despesa', tipo: 'sintetica', pai_id: Number(avo.id) }, admin);
  const filho = await createRecord(RESOURCES.plano_contas, { codigo: `4.${c}.01.01`, nome: 'Aluguel', natureza: 'despesa', tipo: 'sintetica', pai_id: Number(pai.id) }, admin);
  await esperarErro(
    () => updateRecord(RESOURCES.plano_contas, Number(avo.id), { pai_id: Number(filho.id) }, admin),
    400,
    /ciclo/i
  );
});

test('E) conta com filhas não pode virar analítica (409)', async () => {
  const c = unico();
  const pai = await createRecord(RESOURCES.plano_contas, { codigo: `5.${c}`, nome: 'Passivo', natureza: 'passivo', tipo: 'sintetica' }, admin);
  await createRecord(RESOURCES.plano_contas, { codigo: `5.${c}.01`, nome: 'Fornecedores', natureza: 'passivo', tipo: 'analitica', pai_id: Number(pai.id) }, admin);
  await esperarErro(
    () => updateRecord(RESOURCES.plano_contas, Number(pai.id), { tipo: 'analitica' }, admin),
    409,
    /filha/
  );
});

test('F) exclusão bloqueada com filhas e com lançamento classificado', async () => {
  const c = unico();
  const pai = await createRecord(RESOURCES.plano_contas, { codigo: `6.${c}`, nome: 'Receitas', natureza: 'receita', tipo: 'sintetica' }, admin);
  await createRecord(RESOURCES.plano_contas, { codigo: `6.${c}.01`, nome: 'Serviços', natureza: 'receita', tipo: 'analitica', pai_id: Number(pai.id) }, admin);
  await esperarErro(() => deleteRecord(RESOURCES.plano_contas, Number(pai.id), admin), 409, /filha/);

  const conta = await createRecord(RESOURCES.plano_contas, { codigo: `6.${c}.02`, nome: 'Produtos', natureza: 'receita', tipo: 'analitica' }, admin);
  await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: '2026-03-10', tipo: 'receita', descricao: `Venda ${c}`, valor: 10, conta_contabil_id: Number(conta.id), natureza_lancamento: 'credito' },
    admin
  );
  await esperarErro(() => deleteRecord(RESOURCES.plano_contas, Number(conta.id), admin), 409, /lançamento/);
});

test('G) isolamento multiempresa: pai de outra empresa é recusado', async () => {
  const c = unico();
  const paiB = await createRecord(RESOURCES.plano_contas, { codigo: `7.${c}`, nome: 'Ativo B', natureza: 'ativo', tipo: 'sintetica' }, { ...gerenteB });
  await esperarErro(
    () => createRecord(RESOURCES.plano_contas, { codigo: `7.${c}.01`, nome: 'Caixa A', natureza: 'ativo', tipo: 'analitica', pai_id: Number(paiB.id) }, admin),
    404
  );
});

test('H) lançamento só classifica em conta ANALÍTICA da própria empresa', async () => {
  const c = unico();
  const sintetica = await createRecord(RESOURCES.plano_contas, { codigo: `8.${c}`, nome: 'Ativo', natureza: 'ativo', tipo: 'sintetica' }, admin);
  await esperarErro(
    () => createRecord(RESOURCES.lancamentos_financeiros, { data: '2026-03-11', tipo: 'despesa', descricao: `X ${c}`, valor: 5, conta_contabil_id: Number(sintetica.id), natureza_lancamento: 'debito' }, admin),
    422,
    /sintética/
  );
  const contaB = await createRecord(RESOURCES.plano_contas, { codigo: `8.${c}.B`, nome: 'Ativo B', natureza: 'ativo', tipo: 'analitica' }, { ...gerenteB });
  await esperarErro(
    () => createRecord(RESOURCES.lancamentos_financeiros, { data: '2026-03-11', tipo: 'despesa', descricao: `Y ${c}`, valor: 5, conta_contabil_id: Number(contaB.id), natureza_lancamento: 'debito' }, admin),
    404
  );
});
