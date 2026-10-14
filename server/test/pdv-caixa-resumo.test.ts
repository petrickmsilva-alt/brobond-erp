// ============================================================================
// P1-01 — PDV / CAIXA
//
// DEFEITO REPRODUZIDO (auditoria ERP-COMMERCE-01-GO-LIVE):
//
//   O resumo do caixa superestimava o dinheiro da gaveta em R$ 15,00.
//
// Reprodução exata: abertura de R$ 50,00 e UMA venda de R$ 25,00 paga com
// R$ 30,00 em dinheiro (troco de R$ 15,00) + R$ 10,00 no cartão.
//
//   • o dinheiro que o cliente ENTREGOU (30,00) virava MOVIMENTO de caixa;
//   • o resumo somava 30,00 de dinheiro onde a gaveta guardou 15,00;
//   • `esperado_em_dinheiro` respondia 80,00 (50 + 30) em vez de 65,00
//     (50 + 15) — exatamente os R$ 15,00 da auditoria;
//   • `total_vendido` somava os PAGAMENTOS (40,00) em vez das VENDAS (25,00).
//
// A correção não cria um segundo caixa: o MOVIMENTO passa a valer o efeito
// líquido na gaveta (entregue − troco) e o resumo é DERIVADO desses movimentos
// válidos, venda a venda. O que este arquivo prova:
//
//   • `saldo inicial + entradas − saídas = saldo final` — o fechamento bate;
//   • `saldo calculado = soma dos movimentos válidos` — venda cancelada fora,
//     cada forma de pagamento contada UMA vez;
//   • dinheiro, cartão, múltiplas formas, suprimento, sangria, estorno,
//     fechamento, idempotência e duas empresas.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const pdv = await import('../src/pdv');
const { ADMIN, chamar, criarAtor, esperarErro, garantirAdmin, novoLocal, novoProduto, reqDe, resFake, saldoInicial } = await import('./_p1util');

await garantirAdmin();

type Ator = typeof ADMIN;
type Fixture = {
  ator: Ator;
  caixaId: number;
  produtoId: number;
  tamanhoId: number;
};

let seq = 0;

const num = (v: unknown) => Number(v ?? 0);

/** Produto com saldo, local canônico e código de barras — o insumo do PDV. */
async function produto(empresaId = 1, quantidade = 100, preco = 100) {
  seq++;
  const p = await novoProduto({ empresa_id: empresaId, sku: `PDVCAIXA-${empresaId}-${seq}`, nome: `Camiseta caixa ${seq}`, preco_venda: preco, custo: 30 });
  const saldo = await saldoInicial(p, quantidade);
  return { produto: p, produtoId: Number(p.id), tamanhoId: Number(saldo.tamanho.id), local: saldo.local, codigo: `7899${String(Date.now()).slice(-8)}${seq}` };
}

/** Caixa aberto e isolado por cenário: o resumo é sempre lido com o id certo. */
async function caixa(empresaId = 1, abertura = 0, ator: Ator = ADMIN): Promise<number> {
  seq++;
  const c = await chamar(pdv.abrirCaixa, reqDe({ numero: `CAIXA-${empresaId}-${seq}`, valor_abertura: abertura }, { user: ator }), 201);
  return Number(c.id);
}

function vender(f: Fixture, produtoId: number, tamanhoId: number, pagamentos: unknown[], extra: Record<string, unknown> = {}, esperado = 201) {
  return chamar(
    pdv.venderPdv,
    reqDe(
      {
        itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1, desconto_pct: 0 }],
        pagamentos,
        caixa_id: f.caixaId,
        ...extra,
      },
      { user: f.ator }
    ),
    esperado
  );
}

const resumo = (f: Fixture) => chamar(pdv.resumoCaixaHandler, reqDe({}, { user: f.ator, params: { id: f.caixaId } }));

async function pagamentosDaVenda(vendaId: number) {
  const r = await getStore().list(RESOURCES.pdv_pagamentos, { page: 1, pageSize: 100, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' });
  return r.rows;
}

async function movimentosDaGaveta(f: Fixture) {
  const r = await getStore().list(RESOURCES.pdv_caixa_movimentos, { page: 1, pageSize: 100, filter: { caixa_id: f.caixaId }, sort: 'id', dir: 'asc' });
  return r.rows;
}

async function saldoDoProduto(produtoId: number, tamanhoId: number, local: string, empresaId = 1): Promise<number> {
  const row = await getStore().findOneWhere(RESOURCES.estoques, { empresa_id: empresaId, produto_id: produtoId, tamanho_id: tamanhoId, local });
  return num(row?.quantidade);
}

/**
 * Prova aritmética exigida nas duas pontas:
 *   1) `saldo inicial + entradas − saídas = saldo final` (a gaveta fecha);
 *   2) `saldo calculado = soma dos movimentos válidos` (nada contado duas vezes).
 */
async function provarAritmetica(f: Fixture, abertura: number, esperadoFinal: number) {
  const r = await resumo(f);
  const entradas = num(r.por_forma?.dinheiro) + num(r.suprimentos);
  const saidas = num(r.sangrias);
  assert.equal(
    Number((abertura + entradas - saidas).toFixed(2)),
    Number(num(r.esperado_em_dinheiro).toFixed(2)),
    'saldo inicial + entradas − saídas = saldo esperado (o resumo é derivado)'
  );
  assert.equal(Number(num(r.esperado_em_dinheiro).toFixed(2)), esperadoFinal, 'o esperado é o que a gaveta de fato tem');
  return r;
}

// ---------------------------------------------------------------------------
// A) B) C) D) venda presencial: uma forma, cartão, múltiplas formas
// ---------------------------------------------------------------------------

test('P1-01 (A): venda em dinheiro sem troco — movimento = total, resumo bate', async () => {
  const p = await produto();
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 50), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  const venda = await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }]);
  assert.equal(num(venda.calculo.total), 100);
  assert.equal(num(venda.calculo.troco), 0);

  const pagamentos = await pagamentosDaVenda(Number(venda.venda_id));
  assert.equal(pagamentos.length, 1);
  assert.equal(num(pagamentos[0].valor), 100, 'a venda inteira entrou na gaveta');

  const r = await provarAritmetica(f, 50, 150);
  assert.equal(num(r.total_vendido), 100, 'vendido = vendas, não pagamentos');
  assert.equal(num(r.por_forma.dinheiro), 100, 'soma dos movimentos de dinheiro');
  assert.equal(await saldoDoProduto(p.produtoId, p.tamanhoId, p.local), 99, 'estoque baixado uma vez');
});

test('P1-01 (B): venda no cartão não movimenta a gaveta', async () => {
  const p = await produto();
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 20), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'cartao_credito', valor: 100, parcelas: 2 }]);
  const r = await provarAritmetica(f, 20, 20);
  assert.equal(num(r.total_vendido), 100, 'a venda entra no total vendido');
  assert.equal(num(r.por_forma.dinheiro ?? 0), 0, 'nada de dinheiro na gaveta');
  assert.equal(num(r.por_forma.cartao_credito), 100, 'o cartão aparece pela forma');
  assert.equal((await movimentosDaGaveta(f)).length, 0, 'cartão não cria suprimento/sangria');
});

test('P1-01 (C): venda com múltiplas formas — cada movimento entra UMA vez', async () => {
  const p = await produto();
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 0), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  await vender(f, p.produtoId, p.tamanhoId, [
    { forma: 'dinheiro', valor: 60 },
    { forma: 'pix', valor: 30 },
    { forma: 'cartao_debito', valor: 10 },
  ]);

  const r = await provarAritmetica(f, 0, 60);
  assert.equal(num(r.por_forma.dinheiro), 60);
  assert.equal(num(r.por_forma.pix), 30);
  assert.equal(num(r.por_forma.cartao_debito), 10);
  // Σ por_forma = Σ movimentos válidos = total vendido (sem dinheiro de troco).
  const somaFormas = Object.values(r.por_forma as Record<string, number>).reduce((a, b) => a + num(b), 0);
  assert.equal(Number(somaFormas.toFixed(2)), num(r.total_vendido), 'a soma das formas é o vendido');
});

test('P1-01 (D): o resumo é derivado dos movimentos da venda + gaveta (venda a venda)', async () => {
  const p = await produto();
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 100), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  const a = await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }]);
  const b = await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }]);
  await chamar(pdv.movimentoCaixa, reqDe({ tipo: 'suprimento', valor: 20, motivo: 'Troco' }, { user: f.ator, params: { id: f.caixaId } }), 201);
  await chamar(pdv.movimentoCaixa, reqDe({ tipo: 'sangria', valor: 30, motivo: 'Depósito' }, { user: f.ator, params: { id: f.caixaId } }), 201);

  const r = await provarAritmetica(f, 100, 100 + 100 + 100 + 20 - 30);
  assert.equal(num(r.quantidade_vendas), 2);
  assert.equal(num(r.total_vendido), 200, 'soma das vendas vivas — não dos pagamentos');
  assert.equal(num(r.suprimentos), 20);
  assert.equal(num(r.sangrias), 30);
  assert.equal(num(r.por_forma.dinheiro), 200, 'exatamente os movimentos das duas vendas');
  assert.equal(num(a.calculo.troco), 0);
  assert.equal(num(b.calculo.troco), 0);
});

test('P1-01 (E/F): suprimento e sangria movem a gaveta sem tocar no vendido', async () => {
  const p = await produto();
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 0), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  await chamar(pdv.movimentoCaixa, reqDe({ tipo: 'suprimento', valor: 50, motivo: 'Aporte de troco' }, { user: f.ator, params: { id: f.caixaId } }), 201);
  let r = await provarAritmetica(f, 0, 50);
  assert.equal(num(r.total_vendido), 0);

  await chamar(pdv.movimentoCaixa, reqDe({ tipo: 'sangria', valor: 20, motivo: 'Retirada para o cofre' }, { user: f.ator, params: { id: f.caixaId } }), 201);
  r = await provarAritmetica(f, 0, 30);
  assert.equal(num(r.suprimentos), 50);
  assert.equal(num(r.sangrias), 20);
  assert.equal((await movimentosDaGaveta(f)).length, 2, 'a gaveta tem exatamente dois movimentos');
});

// ---------------------------------------------------------------------------
// G) Estorno/cancelamento
// ---------------------------------------------------------------------------

test('P1-01 (G): venda cancelada sai do resumo e o estoque volta UMA vez', async () => {
  const p = await produto();
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 40), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  const venda = await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }]);
  const vendaId = Number(venda.venda_id);
  assert.equal(await saldoDoProduto(p.produtoId, p.tamanhoId, p.local), 99);

  await provarAritmetica(f, 40, 140);
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cliente desistiu da compra' }, { user: f.ator, params: { id: vendaId } }));

  const r = await provarAritmetica(f, 40, 40);
  assert.equal(num(r.total_vendido), 0, 'venda cancelada não é receita');
  assert.equal(num(r.quantidade_vendas), 0);
  assert.equal(num(r.quantidade_canceladas), 1);
  assert.equal(num(r.por_forma.dinheiro), 0, 'o dinheiro saiu da gaveta');
  assert.equal(await saldoDoProduto(p.produtoId, p.tamanhoId, p.local), 100, 'estoque estornado uma única vez');

  const movs = await getStore().list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  assert.equal(movs.rows.filter((m: any) => String(m.tipo) === 'saida').length, 1);
  assert.equal(movs.rows.filter((m: any) => String(m.tipo) === 'entrada').length, 1, 'um estorno, não dois');
  assert.equal(String((await getStore().get(RESOURCES.vendas, vendaId))!.status), 'cancelada');
});

// ---------------------------------------------------------------------------
// H) Fechamento
// ---------------------------------------------------------------------------

test('P1-01 (H): fechamento grava o esperado dos movimentos e a diferença contada', async () => {
  const p = await produto(1, 100, 70);
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 30), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 70 }]);
  await provarAritmetica(f, 30, 100);

  // Contagem com sobra de R$ 0,50: o caixa fecha e a diferença fica registrada.
  const fechamento = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 100.5 }, { user: f.ator, params: { id: f.caixaId } }));
  assert.equal(num(fechamento.diferenca), 0.5);
  assert.equal(num(fechamento.caixa.valor_sistema), 100, 'valor_sistema = soma dos movimentos válidos');
  assert.equal(num(fechamento.caixa.valor_fechamento), 100.5);
  assert.equal(String(fechamento.caixa.status), 'fechado');

  // Caixa fechado recusa fechar de novo e recusa vender.
  await esperarErro(() => pdv.fecharCaixa(reqDe({ valor_fechamento: 100 }, { user: f.ator, params: { id: f.caixaId } }), resFake().res), 409);
  await esperarErro(() => vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }], {}, 409), 409, /caixa/i);
});

// ---------------------------------------------------------------------------
// I) Concorrência
// ---------------------------------------------------------------------------

test('P1-01 (I): duas vendas simultâneas não duplicam movimento nem estoque', async () => {
  const p = await produto(1, 100, 100);
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 0), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  const tentar = () =>
    vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }]).then(
      (r: any) => ({ ok: true, vendaId: Number(r.venda_id) }),
      (e: any) => ({ ok: false, status: Number(e?.status) })
    );
  const resultados = await Promise.all([tentar(), tentar()]);
  const aceitas = resultados.filter((r: any) => r.ok) as { vendaId: number }[];

  for (const v of aceitas) {
    assert.equal((await pagamentosDaVenda(v.vendaId)).length, 1, 'um movimento por venda aceita');
  }
  for (const perdedora of resultados.filter((r: any) => !r.ok)) {
    assert.ok([409, 422].includes(perdedora.status), `perdedora com conflito controlado: ${JSON.stringify(perdedora)}`);
  }

  const usados = aceitas.length;
  const r = await provarAritmetica(f, 0, 100 * usados);
  assert.equal(num(r.total_vendido), 100 * usados);
  assert.equal(num(r.por_forma.dinheiro), 100 * usados, 'Σ movimentos = Σ vendas aceitas');
  assert.equal(await saldoDoProduto(p.produtoId, p.tamanhoId, p.local), 100 - usados, 'uma peça por venda, nunca duas');
});

test('P1-01 (I): dois fechamentos simultâneos — um vence, o outro é recusado', async () => {
  const p = await produto(1, 100, 25);
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 0), produtoId: p.produtoId, tamanhoId: p.tamanhoId };
  await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 25 }]);

  const fechar = () =>
    chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 25 }, { user: f.ator, params: { id: f.caixaId } })).then(
      () => 'ok',
      (e: any) => String(e?.status)
    );
  const resultados = (await Promise.all([fechar(), fechar()])).sort();
  const vencedores = resultados.filter((r: string) => r === 'ok');
  // O MemStore NÃO tem isolamento de transação de verdade: as duas transações
  // compartilham o mesmo snapshot (ver server/test/pg-concorrencia.test.ts), e o
  // rollback de uma pode desfazer a outra. Aqui se prova o que NUNCA pode
  // acontecer — dois fechamentos gravados. A corrida com vencedor único é
  // provada em PostgreSQL, em pg/e424-golive-02-postgresql.test.ts.
  assert.ok(vencedores.length <= 1, `no máximo um fechamento vence: ${resultados.join(',')}`);
  for (const perdedora of resultados.filter((r: string) => r !== 'ok')) {
    assert.equal(perdedora, '409', 'a perdedora recebe conflito controlado');
  }

  // Estado final: ou o caixa fechou com o esperado dos movimentos, ou segue
  // aberto e intacto. Nunca "meio fechado", nunca dois fechamentos. (No MemStore
  // um "ok" isolado pode não sobreviver ao rollback da transação paralela; o
  // desfecho com UM vencedor é o que a prova de PostgreSQL exige.)
  const c = await getStore().get(RESOURCES.pdv_caixas, f.caixaId);
  if (String(c!.status) === 'fechado') {
    assert.equal(vencedores.length, 1, 'fechado exige exatamente um vencedor');
    assert.equal(num(c!.valor_sistema), 25, 'o esperado gravado é o dos movimentos válidos');
    assert.equal(num(c!.diferenca), 0);
    assert.equal(num(c!.valor_fechamento), 25);
  } else {
    assert.equal(String(c!.status), 'aberto', 'sem fechamento gravado o caixa permanece aberto');
    assert.equal(c!.valor_sistema ?? null, null);
    assert.equal(c!.valor_fechamento ?? null, null);
  }
});

// ---------------------------------------------------------------------------
// J) Idempotência
// ---------------------------------------------------------------------------

test('P1-01 (J): ler o resumo não move dinheiro e repetir a venda não duplica movimento', async () => {
  const p = await produto();
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 0), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  const venda = await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }]);
  const r1 = await resumo(f);
  const r2 = await resumo(f);
  const r3 = await resumo(f);
  assert.deepEqual(r2, r1, 'ler o resumo é idempotente — não cria movimento');
  assert.deepEqual(r3, r1);

  // Sem chave de idempotência, cada POST é uma venda NOVA — mas o movimento de
  // cada uma entra uma única vez: 2 vendas = 2 movimentos, nunca 4.
  const outra = await vender(f, p.produtoId, p.tamanhoId, [{ forma: 'dinheiro', valor: 100 }]);
  assert.notEqual(Number(outra.venda_id), Number(venda.venda_id));
  assert.equal((await pagamentosDaVenda(Number(venda.venda_id))).length, 1);
  assert.equal((await pagamentosDaVenda(Number(outra.venda_id))).length, 1);

  const r4 = await resumo(f);
  assert.equal(num(r4.total_vendido), 200);
  assert.equal(num(r4.por_forma.dinheiro), 200);
  assert.equal(num(r4.quantidade_vendas), 2);
  // A prova aritmética da gaveta continua fechando depois da repetição.
  await provarAritmetica(f, 0, 200);
});

// ---------------------------------------------------------------------------
// K) Multiempresa
// ---------------------------------------------------------------------------

/** Empresa 2 de verdade: exige a empresa, o local padrão e o usuário dela. */
async function prepararEmpresa2(): Promise<Ator> {
  const s = getStore();
  if (!(await s.get(RESOURCES.empresas, 2))) {
    await s.insert(RESOURCES.empresas, { id: 2, nome: 'Empresa B (P1-01)', razao_social: 'EMPRESA B LTDA', cnpj: '11222333000262', ativo: true });
  }
  await novoLocal('loja', 2, true);
  return criarAtor(2, 'gerente');
}

test('P1-01 (K): caixas de empresas diferentes não se misturam (e B não opera o caixa de A)', async () => {
  const s = getStore();
  const atorB = await prepararEmpresa2();

  const pa = await produto(1, 100, 30);
  const pb = await produto(2, 100, 90);
  const fa: Fixture = { ator: ADMIN, caixaId: await caixa(1, 100, ADMIN), produtoId: pa.produtoId, tamanhoId: pa.tamanhoId };
  const fb: Fixture = { ator: atorB as Ator, caixaId: await caixa(2, 500, atorB as Ator), produtoId: pb.produtoId, tamanhoId: pb.tamanhoId };

  // Vendas simultâneas, uma em cada empresa.
  const [va, vb] = await Promise.all([
    vender(fa, pa.produtoId, pa.tamanhoId, [{ forma: 'dinheiro', valor: 30 }]),
    vender(fb, pb.produtoId, pb.tamanhoId, [{ forma: 'dinheiro', valor: 90 }]),
  ]);
  assert.equal(num(va.calculo.troco), 0);
  assert.equal(num(vb.calculo.troco), 0);

  const ra = await provarAritmetica(fa, 100, 130);
  const rb = await provarAritmetica(fb, 500, 590);
  assert.equal(num(ra.total_vendido), 30);
  assert.equal(num(rb.total_vendido), 90);
  assert.equal(num(rb.por_forma.dinheiro), 90, 'o caixa de B só tem os movimentos de B');

  // O movimento de cada venda nasce na empresa dona da venda.
  assert.equal(Number((await pagamentosDaVenda(Number(va.venda_id)))[0].empresa_id), 1);
  assert.equal(Number((await pagamentosDaVenda(Number(vb.venda_id)))[0].empresa_id), 2);

  // B não lê nem opera o caixa de A.
  await esperarErro(() => chamar(pdv.resumoCaixaHandler, reqDe({}, { user: atorB, params: { id: fa.caixaId } })), 404);
  await esperarErro(() => pdv.movimentoCaixa(reqDe({ tipo: 'sangria', valor: 1 }, { user: atorB, params: { id: fa.caixaId } }), resFake().res), 404);
  await esperarErro(() => pdv.fecharCaixa(reqDe({ valor_fechamento: 0 }, { user: atorB, params: { id: fa.caixaId } }), resFake().res), 404);
  const raDepois = await resumo(fa);
  assert.equal(num(raDepois.total_vendido), 30, 'A intocado pelas tentativas de B');
});

// ---------------------------------------------------------------------------
// L) A REPRODUÇÃO EXATA DOS R$ 15,00
// ---------------------------------------------------------------------------

test('P1-01 (L): venda de R$ 25,00 paga com R$ 30,00 (troco de R$ 15,00) — o resumo não superestima R$ 15,00', async () => {
  const p = await produto(1, 10, 25);
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 50), produtoId: p.produtoId, tamanhoId: p.tamanhoId };

  // Dinheiro 30,00 (troco 15,00) + cartão 10,00 — o cenário da auditoria.
  const venda = await vender(f, p.produtoId, p.tamanhoId, [
    { forma: 'dinheiro', valor: 30 },
    { forma: 'cartao_credito', valor: 10 },
  ]);
  assert.equal(num(venda.calculo.total), 25);
  assert.equal(num(venda.calculo.troco), 15, 'o troco continua no contrato da resposta');

  // 1) O RESUMO — primeiro o que o operador vê. ANTES da correção este número
  // era 80,00 (50 de abertura + os 30,00 ENTREGUES): R$ 15,00 a mais do que a
  // gaveta; `total_vendido` somava os pagamentos (40,00) e não a venda (25,00).
  const r = await provarAritmetica(f, 50, 65);
  assert.equal(num(r.esperado_em_dinheiro), 65, '50,00 de abertura + 15,00 que ficaram');
  assert.equal(num(r.total_vendido), 25, 'vendido = a venda de 25,00');
  assert.equal(num(r.por_forma.dinheiro), 15, 'o troco NÃO fica na gaveta');
  assert.equal(num(r.por_forma.cartao_credito), 10);

  // 2) O MOVIMENTO: 30 entregues − 15 devolvidos = 15 na gaveta.
  const pagamentos = await pagamentosDaVenda(Number(venda.venda_id));
  const porForma = Object.fromEntries(pagamentos.map((x: any) => [String(x.forma), num(x.valor)]));
  assert.equal(porForma.dinheiro, 15, 'a gaveta guardou 15,00 — não os 30,00 entregues');
  assert.equal(porForma.cartao_credito, 10);
  assert.equal(num(porForma.dinheiro) + num(porForma.cartao_credito), 25, 'Σ movimentos = total da venda');

  // Fechar contando a gaveta real (65,00) não gera divergência — é o teste
  // definitivo de que os R$ 15,00 deixaram de ser superestimados.
  const fechamento = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 65 }, { user: f.ator, params: { id: f.caixaId } }));
  assert.equal(num(fechamento.diferenca), 0, 'a gaveta fecha exatamente no esperado');
  assert.equal(num(fechamento.caixa.valor_sistema), 65);

  // E a venda de R$ 25,00 continua sendo UMA venda: um pagamento por forma,
  // uma baixa de estoque, um lançamento.
  assert.equal(pagamentos.length, 2, 'dinheiro + cartão, cada um uma vez');
  assert.equal(await saldoDoProduto(p.produtoId, p.tamanhoId, p.local), 9);
  const lancamentos = await getStore().list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'venda', referencia_id: Number(venda.venda_id) } });
  assert.equal(lancamentos.rows.length, 1, 'um único lançamento para a venda');
  assert.equal(num(lancamentos.rows[0].valor), 25, 'o financeiro reconhece 25,00 — não 30,00 de dinheiro entregue');
});

test('P1-01 (L/legado): linhas gravadas ANTES da correção (valor BRUTO, com troco) não reintroduzem a divergência', async () => {
  // O comentário de `dinheiroNaGaveta` afirma que a regra de leitura mantém
  // AUDITÁVEIS as linhas gravadas pelo código antigo — quando a coluna `valor`
  // recebia o dinheiro ENTREGUE, incluindo o troco. Esta é a prova: o cenário
  // exato da auditoria (venda de 25,00 paga com 30,00 em dinheiro + 10,00 no
  // cartão) gravado do jeito ANTIGO continua respondendo 65,00 — nunca 80,00.
  const p = await produto(1, 10, 25);
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 50), produtoId: p.produtoId, tamanhoId: p.tamanhoId };
  const s = getStore();

  // Venda + pagamentos com a semântica ANTIGA: dinheiro 30 entregue (o troco
  // de 15 não aparece em lugar nenhum, como no banco legado).
  const legada = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    status: 'faturada',
    canal_venda: 'balcao',
    pdv_caixa_id: f.caixaId,
    data: new Date().toISOString().slice(0, 10),
    total: 25,
  });
  await s.insert(RESOURCES.pdv_pagamentos, { empresa_id: 1, venda_id: Number(legada.id), caixa_id: f.caixaId, forma: 'dinheiro', valor: 30, parcelas: null });
  await s.insert(RESOURCES.pdv_pagamentos, { empresa_id: 1, venda_id: Number(legada.id), caixa_id: f.caixaId, forma: 'cartao_credito', valor: 10, parcelas: null });

  let r = await provarAritmetica(f, 50, 65);
  assert.equal(num(r.por_forma.dinheiro), 15, 'a leitura normaliza a linha legada: só 15,00 ficaram na gaveta');
  assert.equal(num(r.por_forma.cartao_credito), 10);
  assert.equal(num(r.total_vendido), 25, 'vendido = a venda, não o bruto entregue');

  // A linha NOVA convive com a legada e não é abatida duas vezes: o pagamento
  // corrigido (15,00 em dinheiro + 10,00 no cartão) já é líquido e continua
  // valendo 15,00 na gaveta.
  const corrigida = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    status: 'faturada',
    canal_venda: 'balcao',
    pdv_caixa_id: f.caixaId,
    data: new Date().toISOString().slice(0, 10),
    total: 25,
  });
  await s.insert(RESOURCES.pdv_pagamentos, { empresa_id: 1, venda_id: Number(corrigida.id), caixa_id: f.caixaId, forma: 'dinheiro', valor: 15, parcelas: null });
  await s.insert(RESOURCES.pdv_pagamentos, { empresa_id: 1, venda_id: Number(corrigida.id), caixa_id: f.caixaId, forma: 'cartao_credito', valor: 10, parcelas: null });

  r = await provarAritmetica(f, 50, 80);
  assert.equal(num(r.por_forma.dinheiro), 30, '15,00 da venda legada + 15,00 da venda corrigida');
  assert.equal(num(r.por_forma.cartao_credito), 20);
  assert.equal(num(r.total_vendido), 50, 'duas vendas de 25,00');
  assert.equal(num(r.quantidade_vendas), 2);
});

test('P1-01 (L): troco maior que o dinheiro recebido é recusado ANTES de qualquer movimento', async () => {
  const p = await produto(1, 10, 25);
  const f: Fixture = { ator: ADMIN, caixaId: await caixa(1, 0), produtoId: p.produtoId, tamanhoId: p.tamanhoId };
  const vendasAntes = (await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 10, filter: { empresa_id: 1 } })).total;

  // 30,00 no cartão para uma venda de 25,00 com 30,00 em dinheiro: o troco
  // (35,00) não cabe no dinheiro recebido (30,00).
  await esperarErro(
    () =>
      vender(f, p.produtoId, p.tamanhoId, [
        { forma: 'dinheiro', valor: 30 },
        { forma: 'cartao_credito', valor: 30 },
      ]),
    400,
    /troco/i
  );

  const r = await resumo(f);
  assert.equal(num(r.total_vendido), 0, 'nada foi vendido');
  assert.equal(num(r.esperado_em_dinheiro), 0);
  assert.equal(await saldoDoProduto(p.produtoId, p.tamanhoId, p.local), 10, 'estoque intacto');
  assert.equal((await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 10, filter: { empresa_id: 1 } })).total, vendasAntes, 'nenhuma venda gravada');
});
