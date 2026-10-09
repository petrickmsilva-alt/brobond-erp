// ============================================================================
// PDV — PONTO DE VENDA — P1 §8
//
// A regra de ouro: O SERVIDOR CALCULA TUDO. A linha pode chegar com `preco_unitario`,
// `subtotal` e `total` inventados — eles não existem no contrato e são ignorados.
// O único preço aceito é `preco_manual`, e mesmo ele vira divergência auditada.
//
// Contrato verificado em src/pdv.ts:
//   abrirCaixa        body {numero|terminal, valor_abertura, local, observacoes} → 201 caixa
//   caixaAberto       query {numero}                                            → {caixa, resumo} | {caixa:null}
//   movimentoCaixa    params {id}, body {tipo, valor, motivo}                   → 201 movimento
//   resumoCaixaHandler params {id}                                              → resumo
//   fecharCaixa       params {id}, body {valor_fechamento}                      → {ok, caixa, resumo, diferenca, alerta}
//   buscarProduto     query {codigo|q|sku}                                      → 1 produto
//   venderPdv         body {itens, pagamentos, ...}                             → 201
//   cancelarVendaPdv  params {id}, body {motivo}
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { ADMIN, chamar, criarAtor, esperarErro, garantirAdmin, novoCliente, novoLocal, novoProduto, novoTamanho, reqDe, resFake, saldoInicial } = await import('./_p1util');
const pdv = await import('../src/pdv');

await garantirAdmin();

const linhaDe = (produto: any, quantidade: number, extra: Record<string, unknown> = {}) => ({
  produto_id: Number(produto.id),
  tamanho_id: null,
  quantidade,
  desconto_pct: 0,
  ...extra,
});

const abrirCaixa = async (valor = 200, numero?: string, user?: any) =>
  chamar(pdv.abrirCaixa, reqDe({ numero, valor_abertura: valor, observacoes: 'Turno da manhã' }, user ? { user } : {}), 201);

async function venderPdv(itens: any[], pagamentos: any[], extra: Record<string, unknown> = {}) {
  return chamar(pdv.venderPdv, reqDe({ itens, pagamentos, ...extra }), 201);
}

/** Fecha todos os caixas abertos — usado para isolar os testes de pré-condição. */
async function fecharTudo() {
  const s = getStore();
  const abertos = await s.list(RESOURCES.pdv_caixas, { page: 1, pageSize: 100, filter: { status: 'aberto' } });
  for (const c of abertos.rows) {
    await s.update(RESOURCES.pdv_caixas, Number(c.id), { status: 'fechado', fechamento_em: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------------------
// 1) Caixa
// ---------------------------------------------------------------------------

test('pdv: abertura de caixa — não se abre duas vezes o mesmo terminal', async () => {
  await fecharTudo();
  const caixa = await abrirCaixa(100, 'CAIXA-A');
  assert.equal(caixa.status, 'aberto');
  assert.equal(caixa.numero, 'CAIXA-A');
  assert.equal(Number(caixa.valor_abertura), 100);
  assert.ok(caixa.abertura_em, 'a abertura fica marcada');
  assert.equal(caixa.fechamento_em, null);
  assert.equal(Number(caixa.empresa_id), 1);

  await esperarErro(() => abrirCaixa(50, 'CAIXA-A'), 409, /já está aberto/);

  // Terminal diferente pode abrir junto: o UNIQUE é (empresa, numero) onde aberto.
  const outro = await abrirCaixa(20, 'CAIXA-B');
  assert.equal(outro.status, 'aberto');
  assert.notEqual(Number(outro.id), Number(caixa.id));
});

test('pdv: suprimento e sangria só entram em caixa aberto', async () => {
  await fecharTudo();
  const caixa = await abrirCaixa(100, 'CAIXA-A');
  await chamar(pdv.movimentoCaixa, reqDe({ tipo: 'suprimento', valor: 80, motivo: 'Reforço de troco' }, { params: { id: caixa.id } }), 201);
  await chamar(pdv.movimentoCaixa, reqDe({ tipo: 'sangria', valor: 30, motivo: 'Retirada para o banco' }, { params: { id: caixa.id } }), 201);

  await esperarErro(() => pdv.movimentoCaixa(reqDe({ tipo: 'gaveta', valor: 5 }, { params: { id: caixa.id } }), resFake().res), 400, /suprimento.*sangria/);
  await esperarErro(() => pdv.movimentoCaixa(reqDe({ tipo: 'sangria', valor: 0 }, { params: { id: caixa.id } }), resFake().res), 400, /maior que zero/);

  const resumo = await chamar(pdv.resumoCaixaHandler, reqDe({}, { params: { id: caixa.id } }));
  assert.equal(Number(resumo.suprimentos), 80);
  assert.equal(Number(resumo.sangrias), 30);
  assert.equal(Number(resumo.valor_abertura), 100);
  assert.equal(Number(resumo.esperado_em_dinheiro), 150, '100 + 0 vendas + 80 − 30');
});

test('pdv: fechamento confere o contado, grava a diferença e mesmo assim fecha', async () => {
  await fecharTudo();
  const caixa = await abrirCaixa(100, 'CAIXA-A');
  await chamar(pdv.movimentoCaixa, reqDe({ tipo: 'suprimento', valor: 50, motivo: 'Reforço' }, { params: { id: caixa.id } }), 201);

  // Sem vendas: esperado = 150. Contado 140 → falta de 10.
  const fechado = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 140, observacoes: 'Faltou troco' }, { params: { id: caixa.id } }));
  assert.equal(fechado.ok, true);
  assert.equal(fechado.caixa.status, 'fechado');
  assert.equal(Number(fechado.resumo.esperado_em_dinheiro), 150);
  assert.equal(Number(fechado.diferenca), -10);
  assert.match(String(fechado.alerta), /Falta de caixa/);
  assert.ok(fechado.caixa.fechamento_em, 'fechou mesmo com diferença');
  assert.equal(Number(fechado.caixa.fechado_por), ADMIN.id, 'quem fechou fica registrado');

  // Sobras também são registradas.
  const c2 = await abrirCaixa(10, 'CAIXA-C');
  const sobra = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 25 }, { params: { id: c2.id } }));
  assert.equal(Number(sobra.diferenca), 15);
  assert.match(String(sobra.alerta), /Sobra de caixa/);

  // Contado obrigatório e não-negativo.
  const c3 = await abrirCaixa(10, 'CAIXA-D');
  await esperarErro(() => pdv.fecharCaixa(reqDe({}, { params: { id: c3.id } }), resFake().res), 400, /valor contado/);
  await esperarErro(() => pdv.fecharCaixa(reqDe({ valor_fechamento: -1 }, { params: { id: c3.id } }), resFake().res), 400, /negativo/);

  // Caixa fechado não aceita mais nada.
  await esperarErro(() => pdv.fecharCaixa(reqDe({ valor_fechamento: 5 }, { params: { id: caixa.id } }), resFake().res), 409, /já (está|foi) fechado/);
  await esperarErro(() => pdv.movimentoCaixa(reqDe({ tipo: 'suprimento', valor: 1 }, { params: { id: caixa.id } }), resFake().res), 409, /já foi fechado/);
});

test('pdv: o terminal aberto é encontrado pela query e some depois do fechamento', async () => {
  await fecharTudo();
  const caixa = await abrirCaixa(100, 'CAIXA-A');
  const aberto = await chamar(pdv.caixaAberto, reqDe({}, { query: { numero: 'CAIXA-A' } }));
  assert.equal(Number(aberto.caixa.id), Number(caixa.id));
  assert.equal(Number(aberto.resumo.valor_abertura), 100);

  await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 100 }, { params: { id: caixa.id } }));
  const depois = await chamar(pdv.caixaAberto, reqDe({}, { query: { numero: 'CAIXA-A' } }));
  assert.equal(depois.caixa, null);
});

// ---------------------------------------------------------------------------
// 2) Busca por código de barras / SKU
// ---------------------------------------------------------------------------

test('pdv: a busca resolve código de barras, SKU e id — e nunca atravessa empresa', async () => {
  const s = getStore();
  const p = await novoProduto({ codigo_barras: '7891234567890' });
  await saldoInicial(p, 500);

  const porCodigo = await chamar(pdv.buscarProduto, reqDe({}, { query: { codigo: '7891234567890' } }));
  assert.equal(Number(porCodigo.produto_id), Number(p.id));
  assert.equal(porCodigo.sku, p.sku);
  assert.equal(Number(porCodigo.preco), 100);
  assert.equal(porCodigo.origem_preco, 'Ficha do produto');

  const porSku = await chamar(pdv.buscarProduto, reqDe({}, { query: { sku: String(p.sku) } }));
  assert.equal(Number(porSku.produto_id), Number(p.id));

  const porId = await chamar(pdv.buscarProduto, reqDe({}, { query: { q: String(p.id) } }));
  assert.equal(Number(porId.produto_id), Number(p.id));

  // Inexistente → 404 (a busca não inventa).
  await esperarErro(() => pdv.buscarProduto(reqDe({}, { query: { q: '0000000000000' } }), resFake().res), 404, /Nenhum produto/);
  await esperarErro(() => pdv.buscarProduto(reqDe({}, { query: {} }), resFake().res), 400, /Informe o código/);

  // Inativo não se vende.
  await s.update(RESOURCES.produtos, Number(p.id), { ativo: false });
  await esperarErro(() => pdv.buscarProduto(reqDe({}, { query: { q: '7891234567890' } }), resFake().res), 409, /inativo/);
  await s.update(RESOURCES.produtos, Number(p.id), { ativo: true });

  // Produto de outra empresa é invisível — inclusive pela busca por id.
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const daB = await s.insert(RESOURCES.produtos, { empresa_id: 2, codigo_barras: '7890000000001', sku: 'P1-B-PDV', nome: 'Produto da B', preco_venda: 10, ativo: true });
  await esperarErro(() => pdv.buscarProduto(reqDe({}, { query: { q: '7890000000001' } }), resFake().res), 404);
  await esperarErro(() => pdv.buscarProduto(reqDe({}, { query: { q: String(daB.id) } }), resFake().res), 404);
});

test('pdv: a busca devolve o preço da lista de preço vigente, não o da ficha', async () => {
  const s = getStore();
  const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Atacado PDV', prioridade: 30, ativo: true });
  const p = await novoProduto({ preco_venda: 100 });
  await saldoInicial(p, 500);
  await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(lista.id), produto_id: Number(p.id), preco: 70 });

  const achado = await chamar(pdv.buscarProduto, reqDe({}, { query: { q: String(p.id) } }));
  assert.equal(Number(achado.preco), 70, 'o preço da lista é o que vale no PDV');
  assert.equal(Number(achado.preco_tabela), 100, 'mas o preço de tabela continua visível');
  assert.equal(Number(achado.lista_preco_id), Number(lista.id));
  assert.match(achado.origem_preco, /Atacado PDV/);
});

// ---------------------------------------------------------------------------
// 3) O servidor calcula tudo
// ---------------------------------------------------------------------------

test('pdv: subtotal, desconto e total são DO SERVIDOR — os números do corpo são ignorados', async () => {
  await fecharTudo();
  await abrirCaixa(100, 'CAIXA-A');
  const p1 = await novoProduto({ preco_venda: 100 });
  await saldoInicial(p1, 500);
  const p2 = await novoProduto({ preco_venda: 40 });
  await saldoInicial(p2, 500);
  const cliente = await novoCliente();

  const venda = await venderPdv(
    [
      // A linha chega "maquiada" com valores falsos.
      { ...linhaDe(p1, 3), preco_unitario: 1, subtotal: 3, total: 1, desconto: 500 },
      linhaDe(p2, 2, { desconto_pct: 25, preco_unitario: 0, subtotal: 0 }),
    ],
    [{ forma: 'pix', valor: 365 }],
    { cliente_id: Number(cliente.id), total: 1, subtotal: 1, frete: 5 }
  );

  // 3×100 = 300 ; 2×40 com 25% = 60 → 360 de itens + 5 de frete = 365.
  assert.equal(Number(venda.calculo.subtotal_itens), 360, 'subtotal calculado pelo servidor');
  assert.equal(Number(venda.calculo.desconto), 0);
  assert.equal(Number(venda.calculo.frete), 5);
  assert.equal(Number(venda.calculo.total), 365);
  assert.equal(Number(venda.calculo.total_pago), 365);
  assert.equal(Number(venda.calculo.troco), 0);
  assert.equal(Number(venda.venda.total), 365);
  assert.equal(venda.venda.canal_venda, 'pdv');
  assert.equal(Number(venda.venda.cliente_id), Number(cliente.id));
  assert.equal(venda.venda.nfe_status, 'nao_emitida', 'PDV não emite nota sozinho');
  assert.equal(Number(venda.itens.length), 2);
  assert.equal(Number(venda.itens[0].preco_unitario), 100, 'o preco_unitario do corpo não valeu');
  assert.equal(Number(venda.itens[1].subtotal), 60);
  assert.equal(venda.itens[0].origem_preco, 'Ficha do produto');
});

test('pdv: desconto do cupom acima do subtotal é recusado, e o percentual é somado ao valor', async () => {
  await fecharTudo();
  await abrirCaixa(100, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 100 });
  await saldoInicial(p, 500);

  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 100 }], { desconto: 9999 }), 400, /não pode ser maior que o subtotal/);

  const comPct = await venderPdv([linhaDe(p, 2)], [{ forma: 'dinheiro', valor: 200 }], { desconto: 20, desconto_pct: 10 });
  // 200 de itens − 20 − 10% de 200 (=20) = 160.
  assert.equal(Number(comPct.calculo.subtotal_itens), 200);
  assert.equal(Number(comPct.calculo.desconto), 40);
  assert.equal(Number(comPct.calculo.total), 160);

  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 100 }], { desconto_pct: 150 }), 400, /entre 0 e 100/);
});

test('pdv: preço manual é aceito, mas vira divergência visível e auditada', async () => {
  await fecharTudo();
  const caixa = await abrirCaixa(100, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 100 });
  await saldoInicial(p, 500);

  const venda = await venderPdv([linhaDe(p, 2, { preco_manual: 70 })], [{ forma: 'dinheiro', valor: 200 }]);
  assert.equal(Number(venda.itens[0].preco_unitario), 70, 'o preço digitado valeu');
  assert.equal(Number(venda.calculo.subtotal_itens), 140);
  assert.equal(venda.divergencias_de_preco.length, 1, 'a diferença não passou em silêncio');
  assert.deepEqual(
    { linha: venda.divergencias_de_preco[0].linha, enviado: Number(venda.divergencias_de_preco[0].enviado), servidor: Number(venda.divergencias_de_preco[0].servidor) },
    { linha: 1, enviado: 70, servidor: 100 }
  );
  assert.equal(Number(venda.itens[0].preco_tabela), 100);

  // E ficou na auditoria da venda. (`dados` é removido da API por projeto — o
  // store apaga o blob nas leituras — então o que se afirma é a trilha existir
  // e a divergência estar visível no contrato da resposta, que é o que a tela usa.)
  const s = getStore();
  const audit = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 200, filter: { recurso: 'vendas', registro_id: venda.venda_id } });
  assert.ok(audit.rows.length >= 1, 'a venda do PDV deixa trilha de auditoria');
  assert.ok(
    audit.rows.some((r: any) => String(r.descricao ?? '').includes('Venda PDV')),
    'a auditoria identifica a venda como PDV'
  );

  // Sem preço manual não há divergência.
  const limpa = await venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 100 }]);
  assert.equal(limpa.divergencias_de_preco.length, 0);
  assert.equal(Number(limpa.caixa.id), Number(caixa.id));
});

test('pdv: recusa itens vazios, produto inexistente, quantidade zero, desconto absurdo e código que não bate', async () => {
  await fecharTudo();
  await abrirCaixa(100, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 10, codigo_barras: '7891111111111' });
  await saldoInicial(p, 500);

  await esperarErro(() => pdv.venderPdv(reqDe({ itens: [], pagamentos: [{ forma: 'dinheiro', valor: 10 }] }), resFake().res), 400, /linhas da venda/);
  await esperarErro(() => venderPdv([{ produto_id: 999999, tamanho_id: null, quantidade: 1, desconto_pct: 0 }], [{ forma: 'dinheiro', valor: 10 }]), 404, /Nenhum produto/);
  await esperarErro(() => venderPdv([linhaDe(p, 0)], [{ forma: 'dinheiro', valor: 10 }]), 400, /quantidade deve ser maior que zero/);
  await esperarErro(() => venderPdv([linhaDe(p, 1, { desconto_pct: 150 })], [{ forma: 'dinheiro', valor: 10 }]), 400, /desconto_pct deve estar entre 0 e 100/);
  await esperarErro(() => venderPdv([linhaDe(p, 1, { desconto_pct: -5 })], [{ forma: 'dinheiro', valor: 10 }]), 400, /desconto_pct/);

  // O código lido aponta para outro produto: o servidor não deixa os dois divergirem.
  const outro = await novoProduto({ codigo_barras: '7892222222222' });
  await saldoInicial(outro, 500);
  await esperarErro(
    () => venderPdv([{ produto_id: Number(outro.id), codigo: '7891111111111', tamanho_id: null, quantidade: 1, desconto_pct: 0 }], [{ forma: 'dinheiro', valor: 10 }]),
    400,
    /não para o/
  );
});

test('pdv: pagamento insuficiente é recusado e só dinheiro gera troco', async () => {
  await fecharTudo();
  await abrirCaixa(100, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 100 });
  await saldoInicial(p, 500);

  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 50 }]), 400, /Pagamento insuficiente/);
  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'bitcoin', valor: 100 }]), 400, /não é aceita/);
  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 0 }]), 400, /maior que zero/);
  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'pix', valor: 100, parcelas: 3 }]), 400, /parcelamento/);
  // Pix acima do total NÃO gera troco: o excedente não pode virar dinheiro na gaveta.
  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'pix', valor: 150 }]), 400, /Só dinheiro gera troco/);

  const comTroco = await venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 130 }]);
  assert.equal(Number(comTroco.calculo.troco), 30);
  assert.equal(Number(comTroco.calculo.total_pago), 130);
});

test('pdv: a venda fica amarrada ao caixa e aparece no resumo por forma de pagamento', async () => {
  await fecharTudo();
  const caixa = await abrirCaixa(50, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 25 });
  await saldoInicial(p, 500);

  const venda = await venderPdv([linhaDe(p, 1)], [
    { forma: 'dinheiro', valor: 30 },
    { forma: 'cartao_credito', valor: 10, parcelas: 3, nsu: 'ABC123', bandeira: 'visa' },
  ]);
  assert.equal(Number(venda.venda.pdv_caixa_id), Number(caixa.id));
  assert.equal(Number(venda.calculo.total), 25);
  assert.equal(Number(venda.calculo.total_pago), 40);
  assert.equal(Number(venda.calculo.troco), 15);
  assert.equal(venda.venda.fin_forma_pagamento, 'outros', 'pagamento misto não cabe numa forma só');

  const resumo = await chamar(pdv.resumoCaixaHandler, reqDe({}, { params: { id: caixa.id } }));
  assert.equal(Number(resumo.quantidade_vendas), 1);
  assert.equal(Number(resumo.total_vendido), 25);
  assert.equal(Number(resumo.por_forma.dinheiro), 30);
  assert.equal(Number(resumo.por_forma.cartao_credito), 10);
  // esperado = 50 abertura + 30 dinheiro + 0 − 0 (troco não sai do esperado:
  // o dinheiro entregue volta como troco e continua na gaveta).
  assert.equal(Number(resumo.esperado_em_dinheiro), 80);

  // Os pagamentos ficam rastreáveis pela venda.
  const pagamentos = await chamar(pdv.pagamentosVenda, reqDe({}, { params: { id: venda.venda_id } }));
  assert.equal(pagamentos.length, 2);
  const credito = pagamentos.find((x: any) => x.forma === 'cartao_credito');
  assert.equal(credito.parcelas, 3);
  assert.equal(credito.nsu, 'ABC123');
  assert.equal(Number(credito.caixa_id), Number(caixa.id));
});

// ---------------------------------------------------------------------------
// 4) Faturamento, estoque e fiscal
// ---------------------------------------------------------------------------

test('pdv: faturar baixa o estoque e gera o lançamento financeiro na mesma transação', async () => {
  await fecharTudo();
  const s = getStore();
  await abrirCaixa(50, 'CAIXA-A');
  const produto = await novoProduto({ preco_venda: 80, custo: 40 });
  await saldoInicial(produto, 500);

  const venda = await venderPdv([linhaDe(produto, 4)], [{ forma: 'dinheiro', valor: 320 }]);
  assert.equal(venda.venda.status, 'faturada');
  assert.equal(venda.venda.fin_status, 'recebido');
  assert.ok(venda.venda.fin_recebido_em);

  // `movimentacoes` não tem coluna venda_id neste ERP: o vínculo com o pedido é
  // o `motivo` gravado pela baixa (itens.ts:faturarVenda → "Venda #<id>").
  const movs = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { motivo: `Venda #${venda.venda_id}` } });
  assert.equal(movs.rows.length, 1, 'a venda baixou o estoque uma vez');
  assert.equal(movs.rows[0].tipo, 'saida');
  assert.equal(Number(movs.rows[0].quantidade), 4);
  assert.equal(Number(movs.rows[0].produto_id), Number(produto.id));

  const lanc = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { venda_id: venda.venda_id } });
  assert.ok(lanc.rows.length >= 1, 'o financeiro foi gerado');
});

test('pdv: faturar=false deixa a venda em aberto, sem baixa de estoque e com financeiro a receber', async () => {
  await fecharTudo();
  const s = getStore();
  await abrirCaixa(50, 'CAIXA-A');
  const produto = await novoProduto({ preco_venda: 80 });
  await saldoInicial(produto, 500);

  const venda = await venderPdv([linhaDe(produto, 2)], [{ forma: 'dinheiro', valor: 160 }], { faturar: false });
  assert.equal(venda.venda.status, 'aberta');
  assert.equal(venda.venda.fin_status, 'a_receber');
  assert.equal(venda.venda.fin_recebido_em, null);
  assert.equal(venda.fiscal.elegivel, false, 'sem faturar não se emite NFC-e');

  const movs = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { motivo: `Venda #${venda.venda_id}` } });
  assert.equal(movs.rows.length, 0, 'nenhuma baixa de estoque antes do faturamento');
});

test('pdv: a venda aponta para a NFC-e como ato separado — nada de nota automática', async () => {
  await fecharTudo();
  await abrirCaixa(50, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 30 });
  await saldoInicial(p, 500);
  const venda = await venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 30 }]);
  assert.equal(venda.venda.nfe_status, 'nao_emitida');
  assert.equal(venda.venda.documento_fiscal_id, null);
  assert.equal(venda.fiscal.modelo, '65', 'balcão é NFC-e');
  assert.equal(venda.fiscal.endpoint, `/api/vendas/${venda.venda_id}/fiscal/emitir`);
  assert.match(venda.fiscal.mensagem, /já está gravada e faturada/);
});

test('pdv: sem caixa aberto não se vende', async () => {
  await fecharTudo();
  const p = await novoProduto({ preco_venda: 10 });
  await saldoInicial(p, 500);
  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 10 }]), 409, /Nenhum caixa aberto/);

  // E o caixa da outra empresa não serve de caixa aberto para a empresa 1.
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  await s.insert(RESOURCES.pdv_caixas, { empresa_id: 2, numero: 'CAIXA-B2', status: 'aberto', abertura_em: new Date().toISOString(), valor_abertura: 0 });
  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 10 }]), 409, /Nenhum caixa aberto/);
});

// ---------------------------------------------------------------------------
// 5) Cancelamento controlado
// ---------------------------------------------------------------------------

test('pdv: cancelamento exige motivo, estorna estoque/financeiro e mantém o registro', async () => {
  await fecharTudo();
  const s = getStore();
  const caixa = await abrirCaixa(100, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 60 });
  await saldoInicial(p, 500);
  const venda = await venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 100 }]);
  assert.equal(Number((await chamar(pdv.resumoCaixaHandler, reqDe({}, { params: { id: caixa.id } }))).total_vendido), 60);

  await esperarErro(() => pdv.cancelarVendaPdv(reqDe({}, { params: { id: venda.venda_id } }), resFake().res), 400, /motivo/);
  await esperarErro(() => pdv.cancelarVendaPdv(reqDe({ motivo: 'oi' }, { params: { id: venda.venda_id } }), resFake().res), 400, /mínimo 5/);

  const cancelada = await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cliente desistiu na hora' }, { params: { id: venda.venda_id } }));
  assert.equal(cancelada.ok, true);
  assert.equal(cancelada.venda.status, 'cancelada');
  assert.match(cancelada.mensagem, /estoque estornado/);

  const resumo = await chamar(pdv.resumoCaixaHandler, reqDe({}, { params: { id: caixa.id } }));
  assert.equal(Number(resumo.total_vendido), 0, 'a venda cancelada saiu do total da caixa');
  assert.equal(Number(resumo.quantidade_vendas), 0);
  assert.equal(Number(resumo.quantidade_canceladas), 1, 'mas continua visível como cancelada');
  assert.equal(Number(resumo.esperado_em_dinheiro), 100, 'o dinheiro do cancelamento não conta mais na gaveta');

  const aindaLa = await s.get(RESOURCES.vendas, venda.venda_id);
  assert.equal(aindaLa.status, 'cancelada', 'cancelamento não é exclusão');

  await esperarErro(() => pdv.cancelarVendaPdv(reqDe({ motivo: 'De novo' }, { params: { id: venda.venda_id } }), resFake().res), 409, /já está cancelada/);
});

test('pdv: venda com documento fiscal autorizado não pode ser cancelada', async () => {
  await fecharTudo();
  const s = getStore();
  await abrirCaixa(100, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 60 });
  await saldoInicial(p, 500);
  const venda = await venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 100 }]);
  await s.insert(RESOURCES.documentos_fiscais, {
    empresa_id: 1,
    tipo: 'nfce',
    modelo: 65,
    operacao: 'saida',
    venda_id: venda.venda_id,
    status: 'autorizado',
    numero: '9001',
    serie: '1',
    valor_total: 60,
    chave_acesso: '35261000000000000001650010000090011000009001',
  });

  const erro = await esperarErro(
    () => pdv.cancelarVendaPdv(reqDe({ motivo: 'Quero cancelar mesmo assim' }, { params: { id: venda.venda_id } }), resFake().res),
    409,
    /documento fiscal autorizado/
  );
  assert.equal(Number(erro.fields.documento_fiscal_id) > 0, true, 'o erro aponta qual nota impede');
  const ainda = await s.get(RESOURCES.vendas, venda.venda_id);
  assert.equal(ainda.status, 'faturada', 'a venda continua faturada — nada foi desfeito pela metade');
});

// ---------------------------------------------------------------------------
// 6) Multiempresa
// ---------------------------------------------------------------------------

test('pdv: a caixa da EMPRESA A é invisível para a EMPRESA B', async () => {
  await fecharTudo();
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const b = await criarAtor(2, 'gerente');
  await novoLocal('loja', 2, true);

  const caixaA = await abrirCaixa(10, 'CAIXA-A');
  assert.equal(Number(caixaA.empresa_id), 1);

  // B não vê a caixa de A, mesmo com o MESMO número de terminal.
  const abertoParaB = await chamar(pdv.caixaAberto, reqDe({}, { user: b, query: { numero: 'CAIXA-A' } }));
  assert.equal(abertoParaB.caixa, null, 'B não enxerga a caixa de A');

  // E não consegue mexer na caixa de A.
  await esperarErro(() => pdv.movimentoCaixa(reqDe({ tipo: 'sangria', valor: 5 }, { user: b, params: { id: caixaA.id } }), resFake().res), 404);
  await esperarErro(() => pdv.fecharCaixa(reqDe({ valor_fechamento: 1 }, { user: b, params: { id: caixaA.id } }), resFake().res), 404);
  await esperarErro(() => pdv.resumoCaixaHandler(reqDe({}, { user: b, params: { id: caixaA.id } }), resFake().res), 404);

  // B abre a sua com o mesmo número, sem colidir com A.
  const caixaB = await abrirCaixa(500, 'CAIXA-A', b);
  assert.equal(Number(caixaB.empresa_id), 2);
  assert.notEqual(Number(caixaB.id), Number(caixaA.id));

  const resumoA = await chamar(pdv.resumoCaixaHandler, reqDe({}, { params: { id: caixaA.id } }));
  assert.equal(Number(resumoA.valor_abertura), 10, 'o resumo de A não contém o troco de B');
});

test('pdv: não se vende para cliente nem com representante de outra empresa', async () => {
  await fecharTudo();
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  await abrirCaixa(100, 'CAIXA-A');
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente da B', tipo: 'pf', ativo: true });
  const repB = await s.insert(RESOURCES.representantes, { empresa_id: 2, nome: 'Rep da B', ativo: true });
  const p = await novoProduto({ preco_venda: 10 });
  await saldoInicial(p, 500);

  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 10 }], { cliente_id: Number(clienteB.id) }), 404);
  await esperarErro(() => venderPdv([linhaDe(p, 1)], [{ forma: 'dinheiro', valor: 10 }], { representante_id: Number(repB.id) }), 404);

  // E a venda não foi criada pela metade.
  const vendas = await s.list(RESOURCES.vendas, { page: 1, pageSize: 100, filter: { canal_venda: 'pdv' } });
  assert.ok(vendas.rows.every((v: any) => Number(v.cliente_id) !== Number(clienteB.id)));
});

test('pdv: operador não abre caixa (RBAC)', async () => {
  await fecharTudo();
  const operador = await criarAtor(1, 'operador');
  await esperarErro(() => pdv.abrirCaixa(reqDe({ valor_abertura: 10 }, { user: operador }), resFake().res), 403);
  // Mas o operador vende: o caixa já está aberto pelo gerente.
  await abrirCaixa(10, 'CAIXA-A');
  const p = await novoProduto({ preco_venda: 5 });
  await saldoInicial(p, 500);
  const venda = await chamar(pdv.venderPdv, reqDe({ itens: [linhaDe(p, 1)], pagamentos: [{ forma: 'dinheiro', valor: 5 }] }, { user: operador }), 201);
  assert.equal(Number(venda.calculo.total), 5);
});
