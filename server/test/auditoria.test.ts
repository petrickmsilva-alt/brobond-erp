// Testes de integridade encontrados na auditoria de 2026-09-08:
//  1. estorno não pode deixar saldo negativo;
//  2. tamanho fora da grade do produto é rejeitado na API (não só na tela);
//  3. abrir inventário pelo CRUD já congela o saldo (status 'aberto' no create).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore } = await import('../src/services');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
const s = getStore();

async function saldoTotal(produtoId: number, local?: string): Promise<number> {
  const r = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 100, filter: local ? { produto_id: produtoId, local } : { produto_id: produtoId } });
  return r.rows.reduce((a: number, e) => a + Number(e.quantidade || 0), 0);
}

function fakeReq(params: Record<string, unknown>, perfil: string = 'admin') {
  return { user: { id: 1, name: 'Admin', email: 'admin@brobond.com.br', perfil }, params, query: {}, body: {}, headers: {}, ip: '127.0.0.1' } as any;
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

let produto: number;
let sku: string;
let tamDaGrade: number;
let tamForaDaGrade: number;
let produtoSemGrade: number;
let invId: number;
let localAud: { id: number; nome: string };

before(async () => {
  const categorias = (await s.list(RESOURCES.categorias, { page: 1, pageSize: 50 })).rows;
  const grades = (await s.list(RESOURCES.grades, { page: 1, pageSize: 50 })).rows;
  const tamanhos = (await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 100 })).rows;
  const cat = categorias.find((c) => Number(c.grade_id))!;
  const grade = grades.find((g) => Number(g.id) === Number(cat.grade_id))!;
  const itens = (await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 100, filter: { grade_id: Number(grade.id) }, sort: 'ordem', dir: 'asc' })).rows;
  tamDaGrade = Number(itens[0].tamanho_id);
  tamForaDaGrade = Number(tamanhos.find((t) => !itens.some((i) => Number(i.tamanho_id) === Number(t.id)))!.id);
  const semGrade = categorias.find((c) => !Number(c.grade_id) && Number(c.id) !== Number(cat.id))!;

  const sufixo = Date.now() % 1000000;
  sku = `AUD-${sufixo}`;
  produto = Number((await createRecord(RESOURCES.produtos, { sku, nome: 'Auditoria Peça', categoria_id: Number(cat.id), custo: 10, preco_venda: 30 }, admin)).id);
  produtoSemGrade = Number((await createRecord(RESOURCES.produtos, { sku: `${sku}-LIVRE`, nome: 'Auditoria Sem Grade', categoria_id: Number(semGrade.id), custo: 10, preco_venda: 30 }, admin)).id);
  const loc = await createRecord(RESOURCES.locais, { nome: `aud-${sufixo}` }, admin);
  localAud = { id: Number(loc.id), nome: String(loc.nome) };
});

test('movimentação aceita o tamanho da grade e rejeita tamanho de outra grade', async () => {
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produto, tamanho_id: tamDaGrade, quantidade: 4, local_id: localAud.id }, admin);
  assert.equal(await saldoTotal(produto, localAud.nome), 4);

  const err = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produto, tamanho_id: tamForaDaGrade, quantidade: 1, local_id: localAud.id }, admin).catch((e: any) => e);
  assert.equal(err.status, 400, 'tamanho fora da grade precisa ser barrado na API');
  assert.match(err.message, /não faz parte da grade/);
  assert.ok(String(err.fields?.tamanho_id).length > 0, 'o erro precisa apontar o campo e a lista aceita');
  assert.equal(await saldoTotal(produto, localAud.nome), 4, 'nada pode ter sido gravado');
});

test('produto sem grade continua aceitando qualquer tamanho', async () => {
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoSemGrade, tamanho_id: tamForaDaGrade, quantidade: 2, local_id: localAud.id }, admin);
  assert.equal(await saldoTotal(produtoSemGrade, localAud.nome), 2);
});

test('ajuste negativo que zera o saldo é permitido; retirar mais que o saldo não', async () => {
  await createRecord(RESOURCES.movimentacoes, { tipo: 'ajuste', produto_id: produtoSemGrade, tamanho_id: tamForaDaGrade, quantidade: -2, local_id: localAud.id }, admin);
  assert.equal(await saldoTotal(produtoSemGrade, localAud.nome), 0);
  const err = await createRecord(RESOURCES.movimentacoes, { tipo: 'saida', produto_id: produtoSemGrade, tamanho_id: tamForaDaGrade, quantidade: 3, local_id: localAud.id }, admin).catch((e: any) => e);
  assert.equal(err.status, 409);
});

test('estorno não deixa o saldo negativo — pede para estornar antes o que consumiu', async () => {
  const entrada = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produto, tamanho_id: tamDaGrade, quantidade: 6, local_id: localAud.id }, admin);
  await createRecord(RESOURCES.movimentacoes, { tipo: 'saida', produto_id: produto, tamanho_id: tamDaGrade, quantidade: 6, local_id: localAud.id }, admin);
  assert.equal(await saldoTotal(produto, localAud.nome), 4, 'saldo anterior (4) + 6 - 6');

  const { estornarMovimentacao } = await import('../src/estoque');
  const res = fakeRes();
  let status = 200;
  try {
    await estornarMovimentacao(fakeReq({ id: String(entrada.id) }), res);
  } catch (e: any) {
    status = e.status;
    res.body = { error: e.message };
  }
  assert.equal(status, 409, `estorno que estoura o saldo devia falhar (corpo: ${JSON.stringify(res.body).slice(0, 120)})`);
  assert.match(String((res.body as any).error), /estornar primeiro|só há/i);
  assert.equal(await saldoTotal(produto, localAud.nome), 4, 'o saldo não pode ter mudado');

  // Estornar a SAÍDA (devolve as peças) continua livre.
  const saidas = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { produto_id: produto, tipo: 'saida' }, sort: 'id', dir: 'desc' });
  const saida = saidas.rows[0];
  const ok = fakeRes();
  await estornarMovimentacao(fakeReq({ id: String(saida.id) }), ok);
  assert.equal(ok.code, 200);
  assert.equal(await saldoTotal(produto, localAud.nome), 10);
});

test('operador não pode estornar (somente gerente/admin)', async () => {
  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 5, sort: 'id', dir: 'desc' });
  const { estornarMovimentacao } = await import('../src/estoque');
  await assert.rejects(
    () => estornarMovimentacao(fakeReq({ id: String(movs.rows[0].id) }, 'operador'), fakeRes()),
    (e: any) => e.status === 403
  );
});

test('inventário aberto pelo CRUD já congela o saldo do local', async () => {
  const inv = await createRecord(RESOURCES.inventarios, { local_id: localAud.id }, admin);
  invId = Number(inv.id);
  assert.equal(inv.status, 'aberto', 'o create precisa marcar como aberto (o campo é readonly na API)');
  assert.ok(inv.aberto_em || inv.aberto_por, 'a abertura deve registrar quem/quando');
  assert.equal(String(inv.local), localAud.nome);

  const itens = await listRecords(RESOURCES.itens_inventario, { page: 1, pageSize: 200, filter: { inventario_id: Number(inv.id) } });
  const daPeça = itens.rows.find((i: any) => Number(i.produto_id) === produto);
  assert.ok(daPeça, 'a contagem precisa nascer com o saldo congelado do local');
  assert.equal(Number(daPeça.saldo_sistema), 10);
  assert.equal(daPeça.contado, null, 'linha nasce não contada');
});

test('fechar o inventário gera o ajuste, aplica no saldo e não se repete', async () => {
  const { fecharInventario } = await import('../src/estoque');
  const itens = await listRecords(RESOURCES.itens_inventario, { page: 1, pageSize: 200, filter: { inventario_id: invId } });
  const linha = itens.rows.find((i: any) => Number(i.produto_id) === produto)!;
  // contagem divergente: achou 6 onde o sistema dizia 10
  await s.update(RESOURCES.itens_inventario, Number(linha.id), { contado: 6, diferenca: 6 - Number(linha.saldo_sistema) });

  const res = fakeRes();
  await fecharInventario(fakeReq({ id: String(invId) }), res);
  assert.equal((res.body as any).ajustes, 1, 'uma divergência → um ajuste');

  assert.equal(await saldoTotal(produto, localAud.nome), 6, 'o saldo precisa virar o contado');
  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 20, filter: { produto_id: produto }, sort: 'id', dir: 'desc' });
  const ajuste = movs.rows.find((m: any) => String(m.motivo || '').includes(`Inventário #${invId}`));
  assert.ok(ajuste, 'o ajuste do inventário precisa aparecer nas movimentações (rastreabilidade)');
  assert.equal(Number(ajuste!.quantidade), -4);

  const fechado = await getStore().findOneWhere(RESOURCES.inventarios, { id: invId });
  assert.equal(String(fechado!.status), 'fechado');
  assert.ok(fechado!.fechado_por, 'registra quem fechou');

  const err = await fecharInventario(fakeReq({ id: String(invId) }), fakeRes()).catch((e: any) => e);
  assert.equal(err.status, 409, 'fechar duas vezes não pode gerar ajuste duas vezes');
});
