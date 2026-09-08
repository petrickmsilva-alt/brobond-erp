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

// ---------------------------------------------------------------------------
// P1-A · a checagem e o abate do saldo têm de ser um passo só
// ---------------------------------------------------------------------------
test('o abate condicionado não grava nada quando o saldo não cobre (e cobre exatamente, quando zera)', async () => {
  const catId = Number((await s.findOneWhere(RESOURCES.produtos, { id: produto }))!.categoria_id);
  const p = await createRecord(RESOURCES.produtos, { sku: `${sku}-GUARDA`, nome: 'Auditoria Guarda de Saldo', categoria_id: catId, custo: 10, preco_venda: 30 }, admin);
  const pid = Number(p.id);
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: pid, tamanho_id: tamDaGrade, quantidade: 1, local_id: localAud.id }, admin);

  // condição avaliada na própria escrita: retirar 2 de 1 não escreve nada
  const falho = await s.tryAdjustStock(pid, tamDaGrade, localAud.nome, -2);
  assert.equal(falho, null, 'sem saldo → nenhuma linha alterada');
  assert.equal(await saldoTotal(pid, localAud.nome), 1);
  // ... e zerar o saldo é permitido (>= 0, não > 0)
  const ok = await s.tryAdjustStock(pid, tamDaGrade, localAud.nome, -1);
  assert.ok(ok);
  assert.equal(Number(ok!.quantidade), 0);
  assert.equal(await s.tryAdjustStock(pid, tamDaGrade, localAud.nome, -1).then((r) => r), null, 'o segundo abate não pode passar');
  assert.equal(await saldoTotal(pid, localAud.nome), 0, 'jamais negativo');
});

test('limitação do modo demonstração: rollback de uma transação desfaz a escrita concorrente', async () => {
  // O memdb implementa `transaction` com snapshot do banco INTEIRO (memdb.ts:68)
  // e restaura quando o handler joga — então uma requisição que falha desfaz a
  // escrita de outra que passou. É por isso que a atomicidade do saldo é provada
  // em test/pg-concorrencia.test.ts (job testes-postgres), não aqui.
  // Se um dia o modo demonstração ganhar isolamento por transação, este teste
  // passa a falhar: apague-o e mova a prova de concorrência para cá.
  const antes = Number((await s.get(RESOURCES.produtos, produto))!.custo);
  let liberar!: () => void;
  const porta = new Promise<void>((r) => {
    liberar = r;
  });
  const queFalha = s.transaction(async () => {
    await porta;
    throw new Error('outra requisição deu erro');
  });
  await s.update(RESOURCES.produtos, produto, { custo: antes + 5 }); // escrita "de fora", já confirmada
  liberar();
  await assert.rejects(() => queFalha);
  assert.equal(Number((await s.get(RESOURCES.produtos, produto))!.custo), antes, 'a escrita alheia foi desfeita junto com o rollback');
});

// ---------------------------------------------------------------------------
// P1-B · fechar a contagem contra o saldo atual, não contra o congelado
// ---------------------------------------------------------------------------
test('fechar inventário ajusta contra o saldo ATUAL e avisa do que se moveu durante a contagem', async () => {
  const inv = await createRecord(RESOURCES.inventarios, { local_id: localAud.id }, admin);
  const itens = await listRecords(RESOURCES.itens_inventario, { page: 1, pageSize: 200, filter: { inventario_id: Number(inv.id) } });
  const linha = itens.rows.find((i: any) => Number(i.produto_id) === produto)!;
  assert.equal(Number(linha.saldo_sistema), 6, 'ponto de partida do teste');
  await s.update(RESOURCES.itens_inventario, Number(linha.id), { contado: 5, diferenca: -1 });

  // com a contagem aberta, saem 2 peças: o saldo real passa a ser 4
  await createRecord(RESOURCES.movimentacoes, { tipo: 'saida', produto_id: produto, tamanho_id: tamDaGrade, quantidade: 2, local_id: localAud.id }, admin);
  assert.equal(await saldoTotal(produto, localAud.nome), 4);

  const { fecharInventario } = await import('../src/estoque');
  const res = fakeRes();
  await fecharInventario(fakeReq({ id: String(inv.id) }), res);
  const corpo = res.body as any;
  assert.equal(corpo.ajustes, 1);
  assert.equal(Number(corpo.deslocados?.length), 1, 'a divergência congelado → atual tem de ser reportada');
  assert.match(String(corpo.deslocados[0]), /congelado 6 → atual 4/);
  assert.equal(await saldoTotal(produto, localAud.nome), 5, 'fechar deixa o estoque igual ao CONTADO (5), não 6-1=3 nem 4-1');

  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 20, filter: { produto_id: produto }, sort: 'id', dir: 'desc' });
  const ajuste = movs.rows.find((m: any) => String(m.motivo || '').includes(`Inventário #${inv.id}`));
  assert.ok(ajuste, 'o ajuste tem de aparecer nas movimentações');
  assert.equal(Number(ajuste!.quantidade), 1, 'de 4 para 5 = +1');
});

// ---------------------------------------------------------------------------
// P1-C · NF-e: simulação não se faz passar por documento emitido
// ---------------------------------------------------------------------------
test('NF-e: sem provedor é 409, com provedor sem integração é 503, e a simulação fica marcada como tal', async () => {
  const cliente = await createRecord(RESOURCES.clientes, { nome: 'Cliente NF-e', email: `nfe${Date.now()}@brobond.com.br` }, admin);
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: Number(cliente.id), data: new Date().toISOString().slice(0, 10) }, admin);
  const req = fakeReq({ id: String(venda.id) });
  const { nfeEmitir, nfeStatus } = await import('../src/nfe');

  delete process.env.NFE_PROVIDER;
  delete process.env.NFE_API_KEY;
  delete process.env.NFE_MODO;
  const semConfig = await nfeEmitir(req, fakeRes()).catch((e: any) => e);
  assert.equal(semConfig.status, 409, 'sem nada configurado, não se emite');
  assert.match(String(semConfig.message), /não configurado/i);

  process.env.NFE_PROVIDER = 'nfe.io';
  process.env.NFE_API_KEY = 'chave-de-teste';
  const semModo = await nfeEmitir(req, fakeRes()).catch((e: any) => e);
  assert.equal(semModo.status, 503, 'provedor configurado sem cliente de integração real não pode forjar nota emitida');
  assert.match(String(semModo.message), /ainda não está implementada/);
  assert.equal(String((await getStore().findOneWhere(RESOURCES.vendas, { id: Number(venda.id) }))!.nfe_status), 'nao_emitida');

  process.env.NFE_MODO = 'simulacao';
  const res = fakeRes();
  await nfeEmitir(req, res);
  const corpo = res.body as any;
  assert.equal(corpo.simulacao, true);
  assert.equal(corpo.nfe_status, 'simulada');
  assert.match(String(corpo.nfe_numero), /^SIM-/);
  assert.match(String(corpo.mensagem), /não tem valor fiscal/i);

  const gravado = (await getStore().findOneWhere(RESOURCES.vendas, { id: Number(venda.id) }))!;
  assert.equal(String(gravado.nfe_status), 'simulada', 'o estado tem de ficar no registro, não só na resposta');
  assert.ok(gravado.nfe_emitida_em, 'a simulação registra o momento');

  const st = fakeRes();
  await nfeStatus(req, st);
  assert.equal((st.body as any).nfe_status, 'simulada');
  assert.equal((st.body as any).simulacao, true);

  const repetir = await nfeEmitir(req, fakeRes()).catch((e: any) => e);
  assert.equal(repetir.status, 409, 'não se emite duas vezes para o mesmo pedido');

  // o CRUD genérico não é caminho para o estado fiscal
  const { updateRecord } = await import('../src/services');
  const forjado = await updateRecord(RESOURCES.vendas, Number(venda.id), { nfe_status: 'emitida', nfe_numero: 'NOTA-FALSA' }, admin);
  assert.equal(String(forjado.nfe_status), 'simulada', 'editar à mão não cria documento fiscal');
  assert.notEqual(forjado.nfe_numero, 'NOTA-FALSA');

  delete process.env.NFE_PROVIDER;
  delete process.env.NFE_API_KEY;
  delete process.env.NFE_MODO;
});

// ---------------------------------------------------------------------------
// P1-D · senha provisória não é credencial de escrita
// ---------------------------------------------------------------------------
test('senha provisória: escrita bloqueada, leitura e fluxo de troca de senha liberados', async () => {
  const { bloquearSenhaProvisoria, senhaProvisoriaLiberada } = await import('../src/security');
  assert.ok(senhaProvisoriaLiberada('/auth/change-password'));
  assert.ok(senhaProvisoriaLiberada('/auth/mfa/desafio'));
  assert.ok(senhaProvisoriaLiberada('/auth/logout'));
  assert.ok(!senhaProvisoriaLiberada('/movimentacoes'), 'o resto da API não é liberado');

  const roda = (method: string, path: string) => {
    let passou = false;
    let codigo = 0;
    let corpo: any = null;
    bloquearSenhaProvisoria(
      { user: { id: 2, name: 'Convidado', trocar_senha: true }, method, path } as any,
      { status: (c: number) => ({ json: (b: unknown) => { codigo = c; corpo = b; } }) } as any,
      () => {
        passou = true;
      }
    );
    return { passou, codigo, corpo };
  };

  const escrita = roda('POST', '/estoques');
  assert.equal(escrita.passou, false, 'escrita com senha provisória tem de ser barrada');
  assert.equal(escrita.codigo, 403);
  assert.equal(escrita.corpo.code, 'SENHA_PROVISORIA');
  assert.match(String(escrita.corpo.error), /Configurações → Senha/);
  assert.equal(roda('GET', '/estoques').passou, true, 'ler continua liberado');
  assert.equal(roda('POST', '/auth/change-password').passou, true, 'trocar a senha é justamente o que se espera');

  const jaTrocou = (method: string) => {
    let passou = false;
    bloquearSenhaProvisoria({ user: { id: 1, trocar_senha: false }, method, path: '/estoques' } as any, { status: () => ({ json: () => undefined }) } as any, () => {
      passou = true;
    });
    return passou;
  };
  assert.equal(jaTrocou('POST'), true, 'conta com senha definitiva não é afetada');
});

// ---------------------------------------------------------------------------
// P2-B · regra de domínio também no modo demonstração / escrita condicionada
// ---------------------------------------------------------------------------
test('saldo editado à mão não pode ficar negativo (paridade com o CHECK do banco)', async () => {
  const { updateRecord } = await import('../src/services');
  const linha = (await listRecords(RESOURCES.estoques, { page: 1, pageSize: 50, filter: { produto_id: produto, local: localAud.nome } })).rows[0];
  const err = await updateRecord(RESOURCES.estoques, Number(linha.id), { quantidade: -3 }, admin).catch((e: any) => e);
  assert.equal(err.status, 400);
  assert.match(String(err.message), /não pode ser negativo/);
  assert.equal(Number((await s.get(RESOURCES.estoques, Number(linha.id)))!.quantidade), 5, 'nada foi gravado');
});

test('tryUpdateIf só grava se o valor lido continua valendo', async () => {
  const antes = (await s.get(RESOURCES.produtos, produto))!;
  const nulo = await s.tryUpdateIf(RESOURCES.produtos, produto, { nome: 'nome que não existe' }, { nome: 'Deveria Falhar' });
  assert.equal(nulo, null, 'esperado obsoleto → nenhuma linha alterada');
  const ok = await s.tryUpdateIf(RESOURCES.produtos, produto, { nome: antes.nome }, { nome: 'Renomeado' });
  assert.equal(String(ok!.nome), 'Renomeado');
  await s.update(RESOURCES.produtos, produto, { nome: antes.nome });
});

// ---------------------------------------------------------------------------
// P2-F · dinheiro somado em centavos
// ---------------------------------------------------------------------------
test('somaMoeda elimina o centavo que anda em agregação longa', async () => {
  const { somaMoeda, round2 } = await import('../src/utils');
  assert.notEqual(0.1 + 0.2, 0.3, 'o problema é de fato de ponto flutuante');
  assert.equal(somaMoeda([0.1, 0.2, 0.3]), 0.6);
  assert.equal(somaMoeda([1.005, 2.005]), 3.01);
  assert.equal(somaMoeda([]), 0);
  assert.equal(somaMoeda([0.1, 0.2]) , round2(0.1 + 0.2), 'coerente com o arredondamento compartilhado');
});
