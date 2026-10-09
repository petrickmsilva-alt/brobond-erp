// Testes da gestão livre de Locais de estoque (modo memória — não precisa de banco).
// Regra: o local não fica preso ao sistema — o ADMINISTRADOR decide incluir,
// alterar (renomear, com propagação) e excluir mesmo com o local em uso.
// Rodar: npm test (na pasta server) ou npm test na raiz.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, deleteRecord, listRecords, getStore } = await import('../src/services');
const { HttpError } = await import('../src/errors');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
const gerente = { id: 3, name: 'Gerente', perfil: 'gerente' as const };

async function expectHttp(fn: () => Promise<unknown>, status: number, re?: RegExp) {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(e instanceof HttpError, `esperava HttpError, veio ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.status, status, `status ${e.status} ≠ ${status}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail(`esperava erro ${status}`);
}

async function localPorNome(nome: string) {
  const lista = await listRecords(RESOURCES.locais, { page: 1, pageSize: 500 });
  return lista.rows.find((l: any) => String(l.nome) === nome);
}

let produtoId: number;
let localId: number; // 'deposito-central' com saldo e movimentação
let saldoId: number;
let movId: number;

before(async () => {
  getStore();
  const p = await createRecord(RESOURCES.produtos, { sku: 'LOC-001', nome: 'Camisa Local', custo: 10, preco_venda: 25 }, admin);
  produtoId = Number(p.id);
  const l = await createRecord(RESOURCES.locais, { nome: 'deposito-central', tipo: 'loja' }, admin);
  localId = Number(l.id);
  const mov = await createRecord(
    RESOURCES.movimentacoes,
    { tipo: 'entrada', produto_id: produtoId, tamanho_id: 3, quantidade: 5, local_id: localId },
    admin
  );
  movId = Number(mov.id);
  const saldos = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 50, filter: { produto_id: produtoId } });
  saldoId = Number(saldos.rows[0].id);
});

test('listagem de locais anota o uso (saldos, movimentações) para a UI', async () => {
  const l = await localPorNome('deposito-central');
  assert.ok(l, 'local criado deve existir');
  assert.equal(l.em_uso, true);
  assert.equal(Number(l.uso_saldos), 1);
  assert.ok(Number(l.uso_movimentacoes) >= 1);
  assert.equal(l.eh_ultimo_ativo, false);
  const fantasma = await localPorNome('loja');
  assert.equal(fantasma?.em_uso ?? false, false);
});

test('gerente NÃO pode excluir local em uso — decisão do administrador', async () => {
  await expectHttp(() => deleteRecord(RESOURCES.locais, localId, gerente), 403, /decisão do administrador/);
});

test('gerente pode excluir local SEM uso (comportamento normal mantido)', async () => {
  const f = await createRecord(RESOURCES.locais, { nome: 'temporario-x', tipo: 'expedicao' }, admin);
  await deleteRecord(RESOURCES.locais, Number(f.id), gerente); // não deve lançar
  const sumiu = await localPorNome('temporario-x');
  assert.equal(sumiu, undefined);
});

test('ADMIN exclui local em uso: cadastro sai, saldo e movimentação permanecem com o nome', async () => {
  await deleteRecord(RESOURCES.locais, localId, admin); // não deve lançar
  const sumiu = await localPorNome('deposito-central');
  assert.equal(sumiu, undefined, 'local deve sair do cadastro');

  const saldo = await getStore().get(RESOURCES.estoques, saldoId);
  assert.ok(saldo, 'saldo permanece no sistema');
  assert.equal(String(saldo.local), 'deposito-central', 'saldo mantém o nome do local como histórico');
  assert.equal(saldo.local_id ?? null, null, 'vínculo (FK) desfeito');

  const mov = await getStore().get(RESOURCES.movimentacoes, movId);
  assert.ok(mov, 'movimentação permanece no sistema');
  assert.equal(String(mov.local), 'deposito-central');
  assert.equal(mov.local_id ?? null, null, 'vínculo (FK) desfeito');
});

test('renomear local em uso: gerente 403; admin renomeia e o novo nome se propaga', async () => {
  const a = await createRecord(RESOURCES.locais, { nome: 'faccao-a', tipo: 'faccao' }, admin);
  const idA = Number(a.id);
  await createRecord(
    RESOURCES.movimentacoes,
    { tipo: 'entrada', produto_id: produtoId, tamanho_id: 3, quantidade: 2, local_id: idA },
    admin
  );
  await createRecord(RESOURCES.inventarios, { local_id: idA }, admin);
  // venda com local de saída gravado (inserção direta no store: o teste foca na propagação do nome)
  getStore().insert(RESOURCES.vendas, { status: 'aberta', local_saida: 'faccao-a' });

  await expectHttp(() => updateRecord(RESOURCES.locais, idA, { nome: 'faccao-b' }, gerente), 403, /decisão do administrador/);

  await updateRecord(RESOURCES.locais, idA, { nome: 'faccao-b' }, admin);
  const renomeado = await localPorNome('faccao-b');
  assert.ok(renomeado, 'local renomeado no cadastro');

  const saldos = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 100, filter: { produto_id: produtoId } });
  const saldoFaccao = saldos.rows.find((e: any) => String(e.local) === 'faccao-b');
  assert.ok(saldoFaccao, 'saldo do local renomeado existe');
  assert.equal(String(saldoFaccao.local), 'faccao-b', 'saldo recebe o novo nome');

  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 200, filter: { produto_id: produtoId } });
  const movFaccao = movs.rows.find((m: any) => Number(m.local_id) === idA);
  assert.equal(String(movFaccao.local), 'faccao-b', 'movimentação recebe o novo nome');

  const invs = await listRecords(RESOURCES.inventarios, { page: 1, pageSize: 100 });
  const inv = invs.rows.find((i: any) => Number(i.local_id) === idA);
  assert.equal(String(inv.local), 'faccao-b', 'inventário recebe o novo nome');

  const vendas = await listRecords(RESOURCES.vendas, { page: 1, pageSize: 100 });
  assert.ok(
    vendas.rows.some((v: any) => String(v.local_saida) === 'faccao-b'),
    'venda recebe o novo nome'
  );
});

test('renomear não pode colidir com outro local já cadastrado', async () => {
  const x = await createRecord(RESOURCES.locais, { nome: 'loja-x', tipo: 'loja' }, admin);
  await createRecord(RESOURCES.locais, { nome: 'loja-y', tipo: 'loja' }, admin);
  await expectHttp(() => updateRecord(RESOURCES.locais, Number(x.id), { nome: 'loja-y' }, admin), 409, /Já existe outro local/);
});

test('renomear não pode colidir com saldos já gravados sob outro nome', async () => {
  const f = await localPorNome('faccao-b');
  // saldo órfão com o nome-alvo (sem local no cadastro)
  getStore().insert(RESOURCES.estoques, { produto_id: produtoId, tamanho_id: 3, local: 'orfao-saldos', quantidade: 1 });
  await expectHttp(() => updateRecord(RESOURCES.locais, Number(f.id), { nome: 'orfao-saldos' }, admin), 409, /saldos de estoque gravados/);
});

test('excluir o Local padrão promove o primeiro local ativo restante', async () => {
  const p = await createRecord(RESOURCES.locais, { nome: 'padrao-temp', tipo: 'loja', padrao: true }, admin);
  assert.equal((await localPorNome('padrao-temp'))?.padrao, true);
  await deleteRecord(RESOURCES.locais, Number(p.id), admin);
  const lista = await listRecords(RESOURCES.locais, { page: 1, pageSize: 500 });
  const padroes = lista.rows.filter((l: any) => l.padrao === true);
  assert.equal(padroes.length, 1, 'sempre há um local padrão');
});

test('excluir o ÚLTIMO local ativo: gerente 403, admin decide; movimentações exigem recadastro', async () => {
  // Esvazia o cadastro de locais (como um administrador limparia tudo).
  for (;;) {
    const lista = await listRecords(RESOURCES.locais, { page: 1, pageSize: 500 });
    if (!lista.rows.length) break;
    const ultimo = lista.rows[lista.rows.length - 1];
    const restantes = lista.rows.length;
    if (restantes === 1) {
      await expectHttp(() => deleteRecord(RESOURCES.locais, Number(ultimo.id), gerente), 403, /único local ativo/);
    }
    await deleteRecord(RESOURCES.locais, Number(ultimo.id), admin);
  }
  const vazios = await listRecords(RESOURCES.locais, { page: 1, pageSize: 10 });
  assert.equal(vazios.rows.length, 0, 'cadastro pode ficar vazio (decisão do admin)');

  const movimentosAntes = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 100, filter: { produto_id: produtoId } });
  await expectHttp(
    () => createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: 3, quantidade: 1 }, admin),
    409,
    /não possui um local de estoque ativo/
  );
  const movimentosDepois = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 100, filter: { produto_id: produtoId } });
  assert.equal(movimentosDepois.total, movimentosAntes.total, 'a operação bloqueada não cria movimento');

  const restaurado = await createRecord(RESOURCES.locais, { nome: 'restaurado', tipo: 'loja', padrao: true }, admin);
  const movimento = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: 3, quantidade: 1 }, admin);
  assert.equal(Number(movimento.local_id), Number(restaurado.id), 'o movimento reaberto usa o ID canônico do novo local');
});
