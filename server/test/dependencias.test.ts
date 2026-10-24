// ============================================================================
// DIAGNÓSTICO DE VÍNCULOS ANTES DA EXCLUSÃO — modo memória.
//
// A exclusão de um registro referenciado continua PROIBIDA (a FK é a última
// linha de defesa). O que muda é a resposta: em vez de "está em uso em outro
// módulo", o 409 traz QUEM aponta, QUANTOS são, QUAIS ids, de que módulo e por
// quê — e a UI abre o modal "Ver vínculos".
//
// Cobre os cenários A–F do pedido:
//   A) sem dependências → DELETE funciona;
//   B) uma dependência → bloqueado com módulo/quantidade/id;
//   C) várias dependências → todas aparecem;
//   D) venda CANCELADA → continua bloqueada, com os vínculos reais;
//   E) multiempresa: o diagnóstico nunca atravessa a empresa;
//   F) paridade memória ↔ PostgreSQL no mapa declarativo (CASCADE/SET NULL não
//      bloqueiam; NO ACTION bloqueia) — o mesmo cenário roda contra PG em
//      test/pg/dependencias-pg.test.ts.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, deleteRecord, getRecord, listRecords, getStore, diagnosticarDependencias } =
  await import('../src/services');
const { HttpError } = await import('../src/errors');
const { RELACOES_FK } = await import('../src/dependencias');

type Ator = { id: number; name: string; perfil: 'admin' | 'gerente' | 'operador'; empresa_id?: number; empresas?: number[] };

const admin: Ator = { id: 1, name: 'Admin', perfil: 'admin' };

async function expectHttp(fn: () => Promise<unknown>, status: number, re?: RegExp): Promise<HttpError> {
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

async function addItem(vendaId: number, item: Record<string, unknown>) {
  const s = getStore();
  return s.transaction(async (tx) => {
    const { validatePayload } = await import('../src/validate');
    const data = await validatePayload(RESOURCES.itens_venda, item, 'create');
    const row = await s.insert(
      RESOURCES.itens_venda,
      {
        ...data,
        venda_id: vendaId,
        subtotal: Math.round(Number(data.quantidade) * Number(data.preco_unitario) * (1 - Number(data.desconto_pct || 0) / 100) * 100) / 100,
      },
      tx
    );
    const { recalcularTotal } = await import('../src/itens');
    await recalcularTotal('venda', vendaId, tx);
    return row;
  });
}

let produtoId = 0;
let clienteId = 0;
let representanteId = 0;
let setupDone = false;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  getStore();
  const p = await createRecord(RESOURCES.produtos, { sku: 'DEP-001', nome: 'Camisa Diagnóstico', preco_venda: 100 }, admin);
  produtoId = Number(p.id);
  const c = await createRecord(RESOURCES.clientes, { nome: 'Cliente Diagnóstico' }, admin);
  clienteId = Number(c.id);
  const r = await createRecord(RESOURCES.representantes, { nome: 'Rep Diagnóstico', comissao_pct: 5 }, admin);
  representanteId = Number(r.id);
}

// ---------------------------------------------------------------------------
// A) Registro SEM dependências: o diagnóstico libera e o DELETE funciona.
// ---------------------------------------------------------------------------
test('A — registro sem dependências: diagnóstico diz podeExcluir e o DELETE remove', async () => {
  const p = await createRecord(RESOURCES.produtos, { sku: 'LIB-001', nome: 'Produto livre', preco_venda: 10 }, admin);
  const id = Number(p.id);

  const diag = await diagnosticarDependencias(RESOURCES.produtos, id, admin);
  assert.equal(diag.bloqueado, false, 'sem vínculos não há bloqueio');
  assert.equal(diag.podeExcluir, true);
  assert.equal(diag.totalBloqueantes, 0);
  assert.equal(diag.origem, 'memoria');
  assert.equal(diag.recurso, 'produtos');
  assert.equal(diag.id, id);
  assert.match(diag.resumo, /não possui vínculos que impeçam a exclusão/i);

  await deleteRecord(RESOURCES.produtos, id, admin);
  await expectHttp(() => getRecord(RESOURCES.produtos, id), 404);
});

// ---------------------------------------------------------------------------
// B) UMA dependência: bloqueia, diz o módulo, a quantidade e o id.
// ---------------------------------------------------------------------------
test('B — um vínculo: DELETE bloqueado com módulo, quantidade e id no diagnóstico', async () => {
  await ensureSetup();
  const cli = await createRecord(RESOURCES.clientes, { nome: 'Cliente com um pedido' }, admin);
  const cliId = Number(cli.id);
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: cliId, data: '2026-09-10' }, admin);
  const vendaId = Number(venda.id);

  const diag = await diagnosticarDependencias(RESOURCES.clientes, cliId, admin);
  assert.equal(diag.bloqueado, true, 'a venda em aberto já referencia o cliente (FK NO ACTION)');
  assert.equal(diag.empresaId, 1);

  const vinculo = diag.vinculos.find((v) => v.tabela === 'vendas');
  assert.ok(vinculo, 'o vínculo com Vendas aparece');
  assert.equal(vinculo!.modulo, 'Vendas');
  assert.equal(vinculo!.quantidade, 1);
  assert.deepEqual(vinculo!.ids, [vendaId], 'o diagnóstico informa o id do registro dependente');
  assert.equal(vinculo!.tipo, 'historico');
  assert.equal(vinculo!.acao, 'NO_ACTION');
  assert.equal(vinculo!.impeditivo, true);
  assert.equal(vinculo!.bloqueia, true);

  // A trilha de auditoria aparece, mas NÃO bloqueia.
  const auditoria = diag.vinculos.find((v) => v.tabela === 'auditoria');
  assert.ok(auditoria, 'a auditoria é listada');
  assert.equal(auditoria!.tipo, 'trilha');
  assert.equal(auditoria!.bloqueia, false);

  const err = await expectHttp(() => deleteRecord(RESOURCES.clientes, cliId, admin), 409, /existem .*vinculad/i);
  assert.equal(err.code, 'dependencias_vinculadas');
  const detalhe = (err.details as any)?.dependencias;
  assert.equal(detalhe.bloqueado, true);
  assert.equal(detalhe.id, cliId);
  assert.ok(detalhe.vinculos.some((v: any) => v.tabela === 'vendas' && v.quantidade === 1 && v.ids[0] === vendaId));

  // Nada foi apagado.
  assert.ok(await getRecord(RESOURCES.clientes, cliId), 'o cliente continua');
  assert.ok(await getRecord(RESOURCES.vendas, vendaId), 'a venda continua');
});

// ---------------------------------------------------------------------------
// C) VÁRIAS dependências: todas aparecem, com contagem própria.
// ---------------------------------------------------------------------------
test('C — múltiplos vínculos: todos os módulos aparecem com a contagem certa', async () => {
  await ensureSetup();
  const cli = await createRecord(RESOURCES.clientes, { nome: 'Cliente com histórico' }, admin);
  const cliId = Number(cli.id);
  await createRecord(RESOURCES.vendas, { cliente_id: cliId, data: '2026-09-11' }, admin);
  await createRecord(RESOURCES.vendas, { cliente_id: cliId, data: '2026-09-12' }, admin);
  await createRecord(RESOURCES.propostas, { cliente_id: cliId, data: '2026-09-13' }, admin);

  const diag = await diagnosticarDependencias(RESOURCES.clientes, cliId, admin);
  const vendas = diag.vinculos.find((v) => v.tabela === 'vendas');
  const propostas = diag.vinculos.find((v) => v.tabela === 'propostas');
  assert.equal(vendas?.quantidade, 2, 'as duas vendas entram na contagem');
  assert.equal(propostas?.quantidade, 1, 'a proposta também');
  assert.ok(diag.modulosBloqueantes.includes('Vendas'));
  assert.ok(diag.modulosBloqueantes.includes('Propostas'));
  assert.equal(diag.totalBloqueantes, 3);
  assert.match(diag.resumo, /Vendas.*Propostas|Propostas.*Vendas/);

  await expectHttp(() => deleteRecord(RESOURCES.clientes, cliId, admin), 409);
  const depois = await diagnosticarDependencias(RESOURCES.clientes, cliId, admin);
  assert.equal(depois.totalBloqueantes, 3, 'a tentativa bloqueada não apagou nada');
});

// ---------------------------------------------------------------------------
// D) VENDA CANCELADA: o caso central. Histórico real bloqueia a exclusão.
// ---------------------------------------------------------------------------
test('D — venda cancelada: continua bloqueada, com estoque e financeiro reais', async () => {
  await ensureSetup();
  const p = await createRecord(RESOURCES.produtos, { sku: 'DEP-CANC', nome: 'Camisa Cancelada', preco_venda: 100 }, admin);
  const cli = await createRecord(RESOURCES.clientes, { nome: 'Cliente Cancelado' }, admin);
  await createRecord(
    RESOURCES.movimentacoes,
    { tipo: 'entrada', produto_id: Number(p.id), tamanho_id: 3, local: 'loja', quantidade: 10 },
    admin
  );
  const venda = await createRecord(
    RESOURCES.vendas,
    { cliente_id: Number(cli.id), data: '2026-09-20', representante_id: representanteId },
    admin
  );
  const vendaId = Number(venda.id);
  await addItem(vendaId, { produto_id: Number(p.id), tamanho_id: 3, quantidade: 2, preco_unitario: 100 });
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, admin);
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'cancelada' }, admin);
  const cancelada = await getRecord(RESOURCES.vendas, vendaId);
  assert.equal(String(cancelada.status), 'cancelada');

  // Fotografia do histórico ANTES da tentativa de exclusão.
  const auditoriaAntes = await listRecords(RESOURCES.auditoria, { page: 1, pageSize: 500, filter: { recurso: 'vendas', registro_id: vendaId } });
  const movimentosAntes = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  assert.ok(movimentosAntes.rows.length >= 2, 'saída + estorno compõem o histórico da venda cancelada');

  const diag = await diagnosticarDependencias(RESOURCES.vendas, vendaId, admin);
  assert.equal(diag.bloqueado, true, 'venda cancelada preserva histórico e não pode ser apagada');
  assert.equal(diag.podeExcluir, false);

  // Estoque: a saída e o estorno continuam vinculados à venda (FK NO ACTION).
  const mov = diag.vinculos.find((v) => v.tabela === 'movimentacoes');
  assert.ok(mov, 'as movimentações de estoque aparecem');
  assert.ok(mov!.quantidade >= 2, 'saída + estorno continuam no histórico');
  assert.equal(mov!.acao, 'NO_ACTION');
  assert.equal(mov!.bloqueia, true);
  assert.ok(mov!.ids.length > 0);

  // Financeiro: o lançamento cancelado continua apontando para a venda.
  const financeiro = diag.vinculos.find((v) => v.tabela === 'lancamentos_financeiros');
  assert.ok(financeiro, 'o lançamento financeiro aparece');
  assert.equal(financeiro!.politica, 'proteger');
  assert.equal(financeiro!.bloqueia, true);

  // Composição não bloqueia (os itens são removidos junto se a exclusão fosse
  // permitida) e a auditoria é trilha — mas as duas aparecem no diagnóstico.
  const itens = diag.vinculos.find((v) => v.tabela === 'itens_venda');
  assert.equal(itens?.tipo, 'composicao');
  assert.equal(itens?.bloqueia, false);
  assert.equal(diag.vinculos.find((v) => v.tabela === 'auditoria')?.tipo, 'trilha');

  const err = await expectHttp(
    () => deleteRecord(RESOURCES.vendas, vendaId, admin),
    409,
    /Venda cancelada com histórico\. A exclusão física não é permitida/
  );
  assert.equal(err.code, 'dependencias_vinculadas');
  const detalhe = (err.details as any)?.dependencias;
  assert.equal(detalhe.status, 'cancelada');
  assert.ok(detalhe.vinculos.some((v: any) => v.tabela === 'movimentacoes' && v.bloqueia));
  assert.match(detalhe.orientacao, /CANCELADO/);

  // Nada foi apagado e nenhum evento de exclusão foi gravado (sem duplicar
  // auditoria: a tentativa bloqueada não escreve na trilha).
  assert.ok(await getRecord(RESOURCES.vendas, vendaId), 'a venda continua');
  assert.equal((await getRecord(RESOURCES.vendas, vendaId)).status, 'cancelada');
  const itensDepois = await listRecords(RESOURCES.itens_venda, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  assert.equal(itensDepois.rows.length, 1, 'o item continua');
  const movimentosDepois = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  assert.equal(movimentosDepois.rows.length, movimentosAntes.rows.length, 'as movimentações continuam');
  const auditoriaDepois = await listRecords(RESOURCES.auditoria, { page: 1, pageSize: 500, filter: { recurso: 'vendas', registro_id: vendaId } });
  const exclusoes = auditoriaDepois.rows.filter((a) => String(a.acao) === 'excluir');
  assert.equal(exclusoes.length, 0, 'nenhum evento de exclusão foi gravado');
  assert.equal(auditoriaDepois.rows.length, auditoriaAntes.rows.length, 'a tentativa bloqueada não criou evento na trilha');
});

// ---------------------------------------------------------------------------
// E) MULTIEMPRESA: o diagnóstico é sempre recortado pela empresa.
// ---------------------------------------------------------------------------
test('E — multiempresa: vínculos de outra empresa não aparecem nem contam', async () => {
  const b = await createRecord(RESOURCES.empresas, { nome: 'EMPRESA DIAGNÓSTICO B' }, admin);
  const B = Number(b.id);
  const atorA: Ator = { id: 201, name: 'Ana (A)', perfil: 'gerente', empresa_id: 1, empresas: [1] };
  const atorB: Ator = { id: 202, name: 'Bruno (B)', perfil: 'gerente', empresa_id: B, empresas: [B] };

  const cliA = await createRecord(RESOURCES.clientes, { nome: 'Cliente SÓ da A' }, atorA);
  const cliB = await createRecord(RESOURCES.clientes, { nome: 'Cliente SÓ da B' }, atorB);

  const vendaA = await createRecord(RESOURCES.vendas, { cliente_id: Number(cliA.id), data: '2026-09-21' }, atorA);
  const vendaB = await createRecord(RESOURCES.vendas, { cliente_id: Number(cliB.id), data: '2026-09-21' }, atorB);
  // Duas vendas no mesmo cliente da B: a contagem não pode "vazar" para a A.
  await createRecord(RESOURCES.vendas, { cliente_id: Number(cliB.id), data: '2026-09-22' }, atorB);

  const diagA = await diagnosticarDependencias(RESOURCES.clientes, Number(cliA.id), atorA);
  const vendasA = diagA.vinculos.find((v) => v.tabela === 'vendas');
  assert.equal(diagA.empresaId, 1);
  assert.equal(vendasA?.quantidade, 1, 'a empresa A só vê a própria venda');
  assert.deepEqual(vendasA?.ids, [Number(vendaA.id)]);

  const diagB = await diagnosticarDependencias(RESOURCES.clientes, Number(cliB.id), atorB);
  const vendasB = diagB.vinculos.find((v) => v.tabela === 'vendas');
  assert.equal(diagB.empresaId, B);
  assert.equal(vendasB?.quantidade, 2, 'a empresa B vê as suas duas vendas');
  assert.equal(vendasB?.ids.includes(Number(vendaA.id)), false, 'id da empresa A nunca aparece');

  // Registro de outra empresa é 404 — o diagnóstico não é um oráculo de ids.
  await expectHttp(() => diagnosticarDependencias(RESOURCES.clientes, Number(cliB.id), atorA), 404);
  await expectHttp(() => deleteRecord(RESOURCES.clientes, Number(cliB.id), atorA), 404);
  assert.ok(await getRecord(RESOURCES.clientes, Number(cliB.id), atorB), 'o cliente da B continua intacto');
});

// ---------------------------------------------------------------------------
// F) PARIDADE com o PostgreSQL: o mapa declarativo reflete as FKs reais.
//    ON DELETE CASCADE/SET NULL não bloqueiam; NO ACTION/RESTRICT bloqueiam.
// ---------------------------------------------------------------------------
test('F — paridade memória↔PostgreSQL: CASCADE/SET NULL não bloqueiam, NO ACTION bloqueia', async () => {
  await ensureSetup();

  // 1) Composição por CASCADE: preço de lista aponta para o produto com
  //    ON DELETE CASCADE — não impede a exclusão e some junto (como no banco).
  const p = await createRecord(RESOURCES.produtos, { sku: 'DEP-CASC', nome: 'Produto cascata', preco_venda: 10 }, admin);
  const lista = await createRecord(RESOURCES.listas_preco, { nome: 'Lista Diagnóstico' }, admin);
  const s = getStore();
  const item = await s.insert(RESOURCES.lista_preco_itens, {
    empresa_id: 1,
    lista_id: Number(lista.id),
    produto_id: Number(p.id),
    preco: 12,
  } as any);

  const diag = await diagnosticarDependencias(RESOURCES.produtos, Number(p.id), admin);
  const cascata = diag.vinculos.find((v) => v.tabela === 'lista_preco_itens');
  assert.ok(cascata, 'a lista de preço aparece no diagnóstico');
  assert.equal(cascata!.acao, 'CASCADE');
  assert.equal(cascata!.bloqueia, false, 'CASCADE é composição, não bloqueia');
  assert.equal(diag.podeExcluir, true);

  await deleteRecord(RESOURCES.produtos, Number(p.id), admin);
  await expectHttp(() => getRecord(RESOURCES.produtos, Number(p.id)), 404);
  const itemDepois = await s.get(RESOURCES.lista_preco_itens, Number(item.id));
  assert.equal(itemDepois, null, 'a linha CASCADE foi removida junto (paridade com o banco)');

  // 2) Dependência NO ACTION: saldo de estoque impede a exclusão do produto.
  const p2 = await createRecord(RESOURCES.produtos, { sku: 'DEP-NA', nome: 'Produto com saldo', preco_venda: 10 }, admin);
  await createRecord(
    RESOURCES.movimentacoes,
    { tipo: 'entrada', produto_id: Number(p2.id), tamanho_id: 3, local: 'loja', quantidade: 3 },
    admin
  );
  const diag2 = await diagnosticarDependencias(RESOURCES.produtos, Number(p2.id), admin);
  const saldo = diag2.vinculos.find((v) => v.tabela === 'estoques');
  assert.ok(saldo, 'o saldo de estoque aparece');
  assert.equal(saldo!.acao, 'NO_ACTION');
  assert.equal(saldo!.bloqueia, true, 'NO ACTION bloqueia');
  await expectHttp(() => deleteRecord(RESOURCES.produtos, Number(p2.id), admin), 409);
  const saldoDepois = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: Number(p2.id) } });
  assert.equal(saldoDepois.rows.length, 1, 'o saldo continua no lugar');

  // 3) O mapa declarativo é coerente com as FKs reais mapeadas para vendas.
  const vendasFks = RELACOES_FK.filter((r) => r.alvo === 'vendas');
  assert.ok(vendasFks.some((r) => r.tabela === 'movimentacoes' && r.acao === 'NO_ACTION'));
  assert.ok(vendasFks.some((r) => r.tabela === 'itens_venda' && r.acao === 'CASCADE'));
  assert.ok(vendasFks.some((r) => r.tabela === 'documentos_fiscais' && r.acao === 'SET_NULL'));
  assert.ok(vendasFks.some((r) => r.tabela === 'pdv_pagamentos' && r.acao === 'CASCADE'));
});
