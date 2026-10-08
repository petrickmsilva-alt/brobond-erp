// ============================================================================
// Testes da FASE P2 — financeiro, caixa, gateways, webhooks e conciliação.
// Modo memória (sem banco). Concorrência e índices únicos ficam nos testes
// pg-p2.test.ts (Postgres real).
//
// Cobre:
//   • multiempresa no financeiro (resumo, baixa, conciliação, carimbo);
//   • comissões efetivadas por RECEBIMENTO (parcial, quitação, estorno, PDV);
//   • caixa: bloqueio de alteração retroativa após fechamento;
//   • recebíveis de cartão (bruto × taxa × líquido);
//   • gateway adapter (mock): cobranças, idempotência, cancelamento, estorno;
//   • webhooks de entrada: assinatura, idempotência (sem dupla baixa), retry;
//   • extrato OFX persistente: FITID, importação sem duplicata, manual;
//   • CNAB 240: liquidação por identificação (nunca posição), idempotência.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { ADMIN, chamar, criarAtor, esperarErro, garantirAdmin, novoProduto, reqDe, saldoInicial } = await import('./_p1util');
const fin = await import('../src/financeiro');
const pdv = await import('../src/pdv');
const gateway = await import('../src/gateway');
const extrato = await import('../src/extrato');
const cnab = await import('../src/cnab');
const comissoes = await import('../src/comissoes');
const { registrarReautenticacao } = await import('../src/auth');

await garantirAdmin();

const hoje = new Date().toISOString().slice(0, 10);
const s = getStore();

let atorE2: any = null;

before(async () => {
  // Empresa B para os testes de isolamento.
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P2', razao_social: 'FILIAL P2 LTDA', ativo: true }).catch(() => undefined);
  atorE2 = await criarAtor(2, 'admin');
});

async function novoLancamento(dados: Record<string, unknown>, ator: any = ADMIN) {
  return createRecord(RESOURCES.lancamentos_financeiros, { data: hoje, status: 'pendente', tipo: 'receita', ...dados }, ator);
}

// ----------------------------------------------------------------------------
// 1) MULTIEMPRESA no financeiro
// ----------------------------------------------------------------------------

test('P2 multiempresa: resumo financeiro não atravessa empresa', async () => {
  // Conta e título da empresa B.
  const contaB = await createRecord(RESOURCES.contas_financeiras, { nome: `Banco B P2 ${Date.now()}`, tipo: 'banco', saldo_inicial: 0 }, atorE2);
  await novoLancamento({ conta_id: contaB.id, descricao: 'Título isolado P2', valor: 321.5, vencimento: hoje }, atorE2);

  const resA = await chamar(fin.resumoFinanceiro, reqDe());
  assert.ok(!resA.saldoContas.some((c: any) => c.conta_id === Number(contaB.id)), 'conta da empresa B não pode aparecer no resumo da A');
  assert.ok(!resA.aReceberLista.some((l: any) => l.nome === 'Título isolado P2' || Number(l.valor) === 321.5), 'título da empresa B não pode aparecer no contas a receber da A');

  const resB = await chamar(fin.resumoFinanceiro, reqDe({}, { user: atorE2 }));
  assert.ok(resB.saldoContas.some((c: any) => c.conta_id === Number(contaB.id)), 'a empresa B vê a própria conta');
  assert.ok(resB.aReceberLista.some((l: any) => Number(l.valor) === 321.5), 'a empresa B vê o próprio título');
});

test('P2 multiempresa: baixa em título de outra empresa responde 404', async () => {
  const lancB = await novoLancamento({ descricao: 'Título da B p/ baixa bloqueada', valor: 90 }, atorE2);
  await esperarErro(() => fin.baixarLancamento(reqDe({}, { params: { id: lancB.id } }), null as any), 404);
  const recarregado = await s.get(RESOURCES.lancamentos_financeiros, Number(lancB.id));
  assert.equal(recarregado!.status, 'pendente', 'nada pode ter mudado');
  // E a empresa B baixa o próprio título normalmente.
  await chamar(fin.baixarLancamento, reqDe({}, { params: { id: lancB.id }, user: atorE2 }));
  const depois = await s.get(RESOURCES.lancamentos_financeiros, Number(lancB.id));
  assert.equal(depois!.status, 'confirmado');
});

test('P2 multiempresa: conciliação só casa títulos do próprio escopo', async () => {
  const lancB = await novoLancamento({ descricao: 'Somente da B 555', valor: 555.55, vencimento: '2026-11-05' }, atorE2);
  const fora = await chamar(fin.conciliarExtrato, reqDe({ texto: '2026-11-05;555.55;Somente da B 555' }));
  assert.equal(fora.confirmados.length, 0, 'a empresa A não pode conciliar título da B');
  assert.equal(fora.naoConfirmados.length, 1);
  const intacto = await s.get(RESOURCES.lancamentos_financeiros, Number(lancB.id));
  assert.equal(intacto!.status, 'pendente');
});

test('P2 multiempresa: lançamento automático carimba a empresa da origem', async () => {
  // Simula o gancho que services.ts chama dentro da transação da venda.
  const vendaB = await s.insert(RESOURCES.vendas, { empresa_id: 2, status: 'faturada', faturada_em: new Date().toISOString(), total: 300, fin_parcelas: 1, fin_status: 'a_receber', data: hoje, canal_venda: 'balcao' });
  await s.transaction(async (tx) => {
    await fin.syncLancamentoVenda(null, vendaB!, {}, ADMIN, tx);
  });
  // Consulta direta ao store (sem escopo) para VER o carimbo da empresa B.
  const parcelas = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 10, filter: { referencia_tipo: 'venda', referencia_id: vendaB!.id } });
  assert.equal(parcelas.rows.length, 1);
  assert.equal(Number(parcelas.rows[0].empresa_id), 2, 'a parcela nasce na empresa da venda');
});

// ----------------------------------------------------------------------------
// 2) COMISSÕES — efetivadas conforme RECEBIMENTO
// ----------------------------------------------------------------------------

async function vendaComRepresentante(total: number, representanteId: number) {
  const venda = await s.insert(RESOURCES.vendas, { empresa_id: 1, status: 'faturada', faturada_em: new Date().toISOString(), data: hoje, total, fin_parcelas: 1, fin_status: 'a_receber', canal_venda: 'representante', representante_id: representanteId, comissao_pct: 10, comissao_valor: total * 0.1 });
  const lanc = await s.insert(RESOURCES.lancamentos_financeiros, { empresa_id: 1, data: hoje, tipo: 'receita', descricao: `Venda #${venda!.id} — P2 comissão`, valor: total, status: 'pendente', vencimento: hoje, parcela: 1, total_parcelas: 1, referencia_tipo: 'venda', referencia_id: venda!.id });
  return { venda: venda!, lanc: lanc! };
}

test('P2 comissão: pagamento parcial efetiva a parte proporcional', async () => {
  const rep = await createRecord(RESOURCES.representantes, { nome: 'Rep P2 Parcial', comissao_pct: 10, ativo: true }, ADMIN);
  const { venda, lanc } = await vendaComRepresentante(1000, Number(rep.id));

  // Recebe 400 de 1000 → comissão efetivada 40 (10% de 400).
  await chamar(fin.baixarLancamento, reqDe({ valor: 400 }, { params: { id: lanc.id } }));
  const livro1 = await chamar(comissoes.comissoesDaVenda, reqDe({}, { params: { id: venda.id } }));
  assert.equal(livro1.apurada, 100);
  assert.equal(livro1.efetivada, 40);
  assert.equal(livro1.pendente, 60);
  assert.equal(livro1.eventos.length, 1);
  assert.equal(livro1.eventos[0].tipo, 'realizada');
  assert.equal(livro1.eventos[0].origem, 'baixa');
});

test('P2 comissão: quitação efetiva o restante e nada além da apuração', async () => {
  const rep = await createRecord(RESOURCES.representantes, { nome: 'Rep P2 Quitação', comissao_pct: 10, ativo: true }, ADMIN);
  const { venda, lanc } = await vendaComRepresentante(1000, Number(rep.id));

  await chamar(fin.baixarLancamento, reqDe({ valor: 400 }, { params: { id: lanc.id } }));
  const restante = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  await chamar(fin.baixarLancamento, reqDe({}, { params: { id: restante!.id } }));

  const livro = await chamar(comissoes.comissoesDaVenda, reqDe({}, { params: { id: venda.id } }));
  assert.equal(livro.efetivada, 100, '40 + 60 = apuração integral');
  assert.equal(livro.pendente, 0);
  assert.equal(livro.eventos.filter((e: any) => e.tipo === 'realizada').length, 2);

  // Rebaixar o mesmo lançamento não duplica: título já confirmado → 409.
  await esperarErro(() => fin.baixarLancamento(reqDe({}, { params: { id: lanc.id } }), null as any), 409);
  const livro2 = await chamar(comissoes.comissoesDaVenda, reqDe({}, { params: { id: venda.id } }));
  assert.equal(livro2.efetivada, 100);
});

test('P2 comissão: sem representante ou sem apuração, nada é efetivado', async () => {
  const lanc = await novoLancamento({ descricao: 'Título sem representante', valor: 500 });
  await chamar(fin.baixarLancamento, reqDe({}, { params: { id: lanc.id } }));
  const eventos = await s.list(comissoes.R_COMISSOES_EVENTOS, { page: 1, pageSize: 10, filter: { lancamento_id: lanc.id } });
  assert.equal(eventos.rows.length, 0);
});

test('P2 comissão: venda no balcão (recebida no ato) efetiva no faturamento', async () => {
  // PDV: o dinheiro entra junto com a venda → comissão efetivada na hora,
  // proporcional à parcela confirmada (aqui, o total).
  const rep = await createRecord(RESOURCES.representantes, { nome: 'Rep P2 PDV', comissao_pct: 5, ativo: true }, ADMIN);
  const p = await novoProduto({ preco_venda: 100 });
  await saldoInicial(p, 50);
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: `CX-P2-${Date.now()}`, valor_abertura: 0 }), 201);

  const saida = await chamar(
    pdv.venderPdv,
    reqDe({ itens: [{ produto_id: Number(p.id), quantidade: 2, desconto_pct: 0 }], pagamentos: [{ forma: 'pix', valor: 200 }], representante_id: rep.id }),
    201
  );
  const vendaId = saida.venda_id;
  const livro = await chamar(comissoes.comissoesDaVenda, reqDe({}, { params: { id: vendaId } }));
  assert.equal(livro.apurada, 10, '5% de 200 congelados no faturamento');
  assert.equal(livro.efetivada, 10, 'recebido no ato → efetivada integral');
  assert.equal(livro.pendente, 0);

  // Cancelamento (caixa ainda aberto) estorna a comissão efetivada.
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cliente desistiu no balcão' }, { params: { id: vendaId } }));
  const depois = await chamar(comissoes.comissoesDaVenda, reqDe({}, { params: { id: vendaId } }));
  const realizadoBruto = depois.eventos.filter((e: any) => e.tipo === 'realizada').reduce((acc: number, e: any) => acc + e.valor, 0);
  const estornado = depois.eventos.filter((e: any) => e.tipo === 'estornada').reduce((acc: number, e: any) => acc + e.valor, 0);
  assert.equal(realizadoBruto, 10, 'a efetivação original fica registrada');
  assert.equal(depois.eventos.some((e: any) => e.tipo === 'estornada' && e.valor === 10), true, 'estorno cobre o efetivado');
  assert.equal(estornado, 10);
  assert.equal(depois.efetivada, 0, 'efetivada é líquida: realizada − estornada');
  void caixa;
});

test('P2 comissão: relatório contrapõe apurado × efetivado por representante', async () => {
  const resumo = await chamar(comissoes.resumoComissoes, reqDe());
  assert.ok(resumo.resumo.apurada >= 110, 'apurado das vendas do teste');
  assert.ok(resumo.resumo.efetivada > 0);
  assert.ok(Array.isArray(resumo.linhas));
  for (const l of resumo.linhas) {
    assert.ok(l.apurada >= 0 && l.efetivada >= 0);
  }
});

// ----------------------------------------------------------------------------
// 3) CAIXA DIÁRIO — histórico fechado não se reescreve sem permissão
// ----------------------------------------------------------------------------

test('P2 caixa: venda de caixa FECHADO não se cancela sem permissão admin', async () => {
  const p = await novoProduto({ preco_venda: 80 });
  await saldoInicial(p, 30);
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: `CX-FECHADO-${Date.now()}`, valor_abertura: 10 }), 201);
  const saida = await chamar(pdv.venderPdv, reqDe({ itens: [{ produto_id: Number(p.id), quantidade: 1, desconto_pct: 0 }], pagamentos: [{ forma: 'dinheiro', valor: 80 }], caixa_id: caixa.id }), 201);

  await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 90, justificativa: 'Conferido com a gaveta' }, { params: { id: caixa.id } }));

  // Operador/gerente não reescreve caixa fechado.
  const gerente = await criarAtor(1, 'gerente');
  await esperarErro(() => pdv.cancelarVendaPdv(reqDe({ motivo: 'Quero cancelar depois do fechamento' }, { params: { id: saida.venda_id }, user: gerente }), null as any), 409, /caixa fechado|fechado/i);

  // Admin pode — com auditoria explícita da retroatividade.
  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Devolução autorizada pela gerência' }, { params: { id: saida.venda_id } }));
  const venda = await s.get(RESOURCES.vendas, saida.venda_id);
  assert.equal(venda!.status, 'cancelada');
  const auditRetro = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 50, filter: { recurso: 'pdv_caixas' }, sort: 'id', dir: 'desc' });
  assert.ok(auditRetro.rows.some((a) => /RETROATIVO/i.test(String(a.descricao))), 'a retroatividade fica marcada na auditoria');
});

test('P2 caixa: suprimento/sangria seguem bloqueados após o fechamento', async () => {
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: `CX-MOV-${Date.now()}`, valor_abertura: 5 }), 201);
  await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 5 }, { params: { id: caixa.id } }));
  await esperarErro(() => pdv.movimentoCaixa(reqDe({ tipo: 'suprimento', valor: 10, motivo: 'Depois do fechamento' }, { params: { id: caixa.id } }), null as any), 409, /fechado/);
});

// ----------------------------------------------------------------------------
// 4) RECEBÍVEIS DE CARTÃO
// ----------------------------------------------------------------------------

test('P2 cartão: recebíveis projetam bruto × taxa × líquido por vencimento', async () => {
  await novoLancamento({ descricao: 'Card P2 1', valor: 1000, taxa_pct: 5, valor_liquido: 950, forma_pagamento: 'cartao_credito', vencimento: '2026-11-10' });
  await novoLancamento({ descricao: 'Card P2 2', valor: 500, taxa_pct: 4, valor_liquido: 480, forma_pagamento: 'cartao_credito', vencimento: '2026-11-10' });
  await novoLancamento({ descricao: 'Card P2 3', valor: 300, taxa_pct: 10, valor_liquido: 270, forma_pagamento: 'cartao_debito', vencimento: '2026-12-01' });

  const out = await chamar(fin.recebiveisCartao, reqDe());
  assert.ok(out.titulos >= 3);
  const dia10 = out.por_vencimento.find((l: any) => l.vencimento === '2026-11-10');
  assert.ok(dia10, 'agrupa por vencimento');
  assert.equal(dia10.bruto, 1500);
  assert.equal(dia10.liquido, 1430);
  assert.equal(dia10.taxas, 70);
  assert.ok(out.liquido <= out.bruto, 'líquido nunca passa do bruto');
});

// ----------------------------------------------------------------------------
// 5) GATEWAY — adapter, cobranças e webhooks
// ----------------------------------------------------------------------------

async function configurarMock(providerId: string, extra: Record<string, unknown> = {}) {
  registrarReautenticacao(ADMIN.id);
  return chamar(gateway.configurarGateway, reqDe({ provider: providerId, ambiente: 'teste', credenciais: { fake: 'cred' }, ...extra }));
}

test('P2 gateway: sem configuração, cobrança responde 503 (nunca inventa)', async () => {
  await s.list(gateway.R_GATEWAY_CONFIGS, { page: 1, pageSize: 100 }).then(async (l) => {
    for (const c of l.rows) await s.remove(gateway.R_GATEWAY_CONFIGS, Number(c.id));
  });
  const lanc = await novoLancamento({ descricao: 'Título p/ gateway sem config', valor: 120 });
  await esperarErro(() => gateway.criarCobranca(reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lanc.id }), null as any), 503, /não configurado/i);
});

let cobrancaPixId: number;
let providerRef: string;
let lancDoGateway: any;

test('P2 gateway: criação de cobrança PIX é idempotente pela chave', async () => {
  await configurarMock('mock');
  lancDoGateway = await novoLancamento({ descricao: 'Título p/ gateway PIX', valor: 250, vencimento: hoje });

  const primeira = await chamar(gateway.criarCobranca, reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lancDoGateway.id, payer_email: 'cliente@exemplo.com' }), 201);
  assert.equal(primeira.cobranca.status, 'pendente');
  assert.ok(primeira.cobranca.qr_code, 'PIX devolve QR');
  assert.ok(primeira.cobranca.copia_cola, 'PIX devolve copia-e-cola');
  assert.equal(Number(primeira.cobranca.valor), 250);
  cobrancaPixId = Number(primeira.cobranca.id);
  providerRef = String(primeira.cobranca.provider_ref);

  // Mesma chave (derivada do lançamento) → devolve a MESMA cobrança.
  const repetida = await chamar(gateway.criarCobranca, reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lancDoGateway.id, payer_email: 'cliente@exemplo.com' }), 200);
  assert.equal(repetida.idempotente, true);
  assert.equal(Number(repetida.cobranca.id), cobrancaPixId);
});

test('P2 webhook: pagamento confirma cobrança + baixa o título UMA vez', async () => {
  const app = express();
  app.use(gateway.publicGatewayRouter);

  const payload = { event: 'payment.paid', data: { id: providerRef }, status: 'pago' };
  const r1 = await request(app).post('/api/gateway/webhooks/mock').send(payload);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.processado, true, JSON.stringify(r1.body));

  const cobranca = await s.get(gateway.R_GATEWAY_COBRANCAS, cobrancaPixId);
  assert.equal(cobranca!.status, 'paga');
  const lanc = await s.get(RESOURCES.lancamentos_financeiros, Number(lancDoGateway.id));
  assert.equal(lanc!.status, 'confirmado', 'o webhook baixou o título');
  assert.match(String(lanc!.observacoes), /webhook/i);

  // A MESMA notificação de novo: duplicada, sem segunda baixa.
  const r2 = await request(app).post('/api/gateway/webhooks/mock').send(payload);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicado, true);
  const lanc2 = await s.get(RESOURCES.lancamentos_financeiros, Number(lancDoGateway.id));
  assert.equal(lanc2!.status, 'confirmado');
  const baixasFilhas = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'baixa', referencia_id: lancDoGateway.id } });
  assert.equal(baixasFilhas.rows.length, 0, 'baixa total não gera filho duplicado');
  const eventos = await s.list(gateway.R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 20, filter: { provider: 'mock' } });
  assert.equal(eventos.rows.length, 1, 'um único evento persistido');
  assert.equal(eventos.rows[0].status, 'processado');
});

test('P2 webhook: assinatura inválida é rejeitada; válida processa', async () => {
  await configurarMock('mock', { webhook_secret: 'segredo-p2' });
  const lanc = await novoLancamento({ descricao: 'Título p/ webhook assinado', valor: 77 });
  const cob = await chamar(gateway.criarCobranca, reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lanc.id, payer_email: 'x@y.z' }), 201);
  const ref = String(cob.cobranca.provider_ref);

  const app = express();
  app.use(gateway.publicGatewayRouter);
  const payload = JSON.stringify({ event: 'payment.paid', data: { id: ref }, status: 'pago' });

  // Sem assinatura → 401 e nada processado.
  const semAssinatura = await request(app).post('/api/gateway/webhooks/mock').set('Content-Type', 'application/json').send(payload);
  assert.equal(semAssinatura.status, 401);
  const lancIntacto = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(lancIntacto!.status, 'pendente');

  // Assinatura errada → 401.
  const errada = await request(app).post('/api/gateway/webhooks/mock').set('Content-Type', 'application/json').set('x-mock-signature', 'assinatura-falsa').send(payload);
  assert.equal(errada.status, 401);

  // Assinatura correta → processa.
  const assinatura = createHmac('sha256', 'segredo-p2').update(payload, 'utf8').digest('hex');
  const ok = await request(app).post('/api/gateway/webhooks/mock').set('Content-Type', 'application/json').set('x-mock-signature', assinatura).send(payload);
  assert.equal(ok.status, 200);
  const evento = await s.findOneWhere(gateway.R_GATEWAY_WEBHOOK_EVENTS, { provider: 'mock', cobranca_id: Number(cob.cobranca.id) });
  assert.equal(evento!.assinatura_ok, true);
  const lancBaixado = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(lancBaixado!.status, 'confirmado');
});

test('P2 webhook: evento com erro fica para retry sem duplicar efeito', async () => {
  // Configuração ativa, mas o lançamento-alvo já baixado por fora: o evento
  // processa sem efeito duplo (idempotência de ponta a ponta).
  const lanc = await novoLancamento({ descricao: 'Título já baixado antes do webhook', valor: 60 });
  const cob = await chamar(gateway.criarCobranca, reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lanc.id, payer_email: 'x@y.z' }), 201);
  await chamar(fin.baixarLancamento, reqDe({}, { params: { id: lanc.id } }));

  const evento = await s.insert(gateway.R_GATEWAY_WEBHOOK_EVENTS, { provider: 'mock', evento_id: `retry-${cob.cobranca.id}`, evento: 'payment.paid', payload: JSON.stringify({ event: 'payment.paid', data: { id: cob.cobranca.provider_ref }, status: 'pago' }), assinatura_ok: true, status: 'erro', tentativas: 1, recebido_em: new Date().toISOString() });
  const out = await gateway.processarEvento(evento!);
  assert.equal(out.resultado, 'paga');
  const recarregado = await s.get(gateway.R_GATEWAY_WEBHOOK_EVENTS, Number(evento!.id));
  assert.equal(recarregado!.status, 'processado');
  const lanc2 = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(lanc2!.status, 'confirmado', 'continua baixado uma única vez');

  // Retry manual em evento já processado é recusado.
  await esperarErro(() => gateway.reprocessarEvento(reqDe({}, { params: { id: evento!.id } }), null as any), 409, /já processado/i);
});

test('P2 gateway: cancelamento e estorno com reversão financeira', async () => {
  // O teste anterior deixou segredo de webhook configurado — limpa para que o
  // webhook pago abaixo (sem assinatura, ambiente de teste) seja processado.
  await configurarMock('mock', { webhook_secret: null });

  // Cancelar pendente.
  const lancC = await novoLancamento({ descricao: 'Cobrança para cancelar', valor: 45 });
  const cobC = await chamar(gateway.criarCobranca, reqDe({ provider: 'mock', metodo: 'boleto', lancamento_id: lancC.id, payer_email: 'x@y.z', vencimento: hoje }), 201);
  assert.ok(cobC.cobranca.linha_digitavel, 'boleto devolve linha digitável');
  assert.ok(cobC.cobranca.nosso_numero, 'boleto devolve nosso número');
  await chamar(gateway.cancelarCobranca, reqDe({}, { params: { id: cobC.cobranca.id } }));
  const cancelada = await s.get(gateway.R_GATEWAY_COBRANCAS, Number(cobC.cobranca.id));
  assert.equal(cancelada!.status, 'cancelada');
  const lancC2 = await s.get(RESOURCES.lancamentos_financeiros, Number(lancC.id));
  assert.equal(lancC2!.status, 'pendente', 'cancelar a cobrança não perdoa a dívida');

  // Estornar exige paga: paga via webhook e estorna.
  const lancE = await novoLancamento({ descricao: 'Cobrança para estornar', valor: 90 });
  const cobE = await chamar(gateway.criarCobranca, reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lancE.id, payer_email: 'x@y.z' }), 201);
  await esperarErro(() => gateway.estornarCobranca(reqDe({}, { params: { id: cobE.cobranca.id } }), null as any), 409, /paga/i);
  const app = express();
  app.use(gateway.publicGatewayRouter);
  await request(app).post('/api/gateway/webhooks/mock').send({ event: 'payment.paid', data: { id: cobE.cobranca.provider_ref }, status: 'pago' });
  const estorno = await chamar(gateway.estornarCobranca, reqDe({}, { params: { id: cobE.cobranca.id } }));
  assert.equal(estorno.cobranca.status, 'estornada');
  assert.ok(estorno.estorno_lancamento_id, 'o dinheiro devolvido vira lançamento de estorno');
  const lancEstorno = await s.get(RESOURCES.lancamentos_financeiros, Number(estorno.estorno_lancamento_id));
  assert.equal(lancEstorno!.tipo, 'despesa', 'devolução de receita sai como despesa de estorno');
  assert.equal(Number(lancEstorno!.valor), 90);
});

// ----------------------------------------------------------------------------
// 6) EXTRATO PERSISTENTE (OFX) — FITID e idempotência
// ----------------------------------------------------------------------------

const ofxDeTeste = (fitid: string, valor: number, data: string, nome: string) => `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>${data.replace(/-/g, '')}120000
<TRNAMT>${valor.toFixed(2)}
<FITID>${fitid}
<NAME>${nome}
</STMTTRN>
</BANKTRANLIST>
</OFX>`;

test('P2 OFX: importação persiste FITID e não duplica na reimportação', async () => {
  const conta = await createRecord(RESOURCES.contas_financeiras, { nome: `Conta OFX P2 ${Date.now()}`, tipo: 'banco', saldo_inicial: 0 }, ADMIN);
  const lanc = await novoLancamento({ conta_id: conta.id, descricao: 'Cliente OFX P2', valor: 444.44, vencimento: '2026-10-20' });

  const out1 = await chamar(extrato.importarExtrato, reqDe({ conta_id: conta.id, conteudo: ofxDeTeste('FITID-P2-1', 444.44, '2026-10-20', 'PIX CLIENTE OFX P2') }));
  assert.equal(out1.fonte, 'ofx');
  assert.equal(out1.importadas, 1);
  assert.equal(out1.duplicadas, 0);
  assert.equal(out1.conciliadas, 1, 'match único por valor+data concilia sozinho');
  assert.equal(out1.conciliadas_detalhe[0].lancamento_id, Number(lanc.id));
  const baixado = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(baixado!.status, 'confirmado');

  // Reimportar o MESMO extrato: nada muda, nada duplica.
  const out2 = await chamar(extrato.importarExtrato, reqDe({ conta_id: conta.id, conteudo: ofxDeTeste('FITID-P2-1', 444.44, '2026-10-20', 'PIX CLIENTE OFX P2') }));
  assert.equal(out2.importadas, 0);
  assert.equal(out2.duplicadas, 1, 'o FITID já importado é ignorado');
  assert.equal(out2.conciliadas, 0);

  const linha = await s.findOneWhere(extrato.R_EXTRATO, { conta_id: Number(conta.id), fitid: 'FITID-P2-1' });
  assert.ok(linha, 'o FITID fica persistido para a conciliação futura');
  assert.equal(linha!.status, 'conciliada');
});

test('P2 OFX: linha sem match fica pendente → confirmação manual ou divergência', async () => {
  const conta = await createRecord(RESOURCES.contas_financeiras, { nome: `Conta OFX Manual ${Date.now()}`, tipo: 'banco', saldo_inicial: 0 }, ADMIN);
  const out = await chamar(extrato.importarExtrato, reqDe({ conta_id: conta.id, conteudo: ofxDeTeste('FITID-P2-2', 999.99, '2026-10-21', 'DEPOSITO SEM TITULO') }));
  assert.equal(out.importadas, 1);
  assert.equal(out.conciliadas, 0);
  const linhaId = out.pendentes[0].extrato_id;

  // Divergência exige motivo.
  await esperarErro(() => extrato.marcarDivergencia(reqDe({ motivo: 'x' }, { params: { id: linhaId } }), null as any), 400, /mínimo/i);

  // Cria o título depois e confirma manualmente.
  const lanc = await novoLancamento({ conta_id: conta.id, descricao: 'Depósito identificado depois', valor: 999.99, vencimento: '2026-10-21' });
  await chamar(extrato.conciliarLinhaManual, reqDe({ lancamento_id: lanc.id }, { params: { id: linhaId } }));
  const linha = await s.get(extrato.R_EXTRATO, linhaId);
  assert.equal(linha!.status, 'conciliada');
  const baixado = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(baixado!.status, 'confirmado');
  // Linha já conciliada não se diverge.
  await esperarErro(() => extrato.marcarDivergencia(reqDe({ motivo: 'tarde demais' }, { params: { id: linhaId } }), null as any), 409);
});

// ----------------------------------------------------------------------------
// 7) CNAB 240 — liquidação por IDENTIFICAÇÃO, nunca por posição
// ----------------------------------------------------------------------------

type Campo = [ini: number, fim: number, valor: string];

// Datas no CNAB240 são DDMMYYYY (FEBRABAN). Converte ISO → DDMMYYYY.
const dataCnab = (iso: string) => {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}${m}${a}`;
};

function linhaCnab(campos: Campo[]): string {
  const arr = ' '.repeat(240).split('');
  for (const [ini, fim, bruto] of campos) {
    const v = bruto.padEnd(fim - ini + 1).slice(0, fim - ini + 1);
    for (let i = 0; i < v.length; i++) arr[ini - 1 + i] = v[i];
  }
  return arr.join('');
}

function arquivoCnab(detalhes: { nossoNumero: string; movimento: string; valorTitulo: number; valorPago?: number; documento?: string; data?: string }[]): string {
  const linhas: string[] = [];
  linhas.push(linhaCnab([[1, 3, '237'], [8, 8, '0']])); // header do arquivo
  let seq = 0;
  for (const d of detalhes) {
    seq++;
    linhas.push(
      linhaCnab([
        [8, 8, '3'],
        [9, 13, String(seq).padStart(5, '0')],
        [14, 14, 'T'],
        [16, 17, d.movimento],
        [38, 57, d.nossoNumero.padStart(20, ' ')],
        [59, 73, String(d.documento || '').padStart(15, '0')],
        [82, 96, String(Math.round(d.valorTitulo * 100)).padStart(15, '0')],
      ])
    );
    seq++;
    linhas.push(
      linhaCnab([
        [8, 8, '3'],
        [9, 13, String(seq).padStart(5, '0')],
        [14, 14, 'U'],
        [16, 17, d.movimento],
        [78, 92, String(Math.round((d.valorPago ?? d.valorTitulo) * 100)).padStart(15, '0')],
        [138, 145, dataCnab(d.data || hoje)],
        [146, 153, dataCnab(d.data || hoje)],
      ])
    );
  }
  linhas.push(linhaCnab([[8, 8, '9']])); // trailer
  return linhas.join('\n');
}

test('P2 CNAB: parser lê T/U e classifica movimentos', () => {
  assert.ok(cnab.cnab240Parser.detecta(arquivoCnab([{ nossoNumero: '1', movimento: '06', valorTitulo: 100 }])));
  const linhas = cnab.cnab240Parser.parseRetorno(
    arquivoCnab([
      { nossoNumero: '111', movimento: '06', valorTitulo: 100, valorPago: 100, data: '2026-10-01' },
      { nossoNumero: '222', movimento: '03', valorTitulo: 50 },
      { nossoNumero: '333', movimento: '10', valorTitulo: 70 },
    ])
  );
  assert.equal(linhas.length, 3);
  assert.equal(linhas[0].tipo, 'liquidacao');
  assert.equal(linhas[0].valor_pago, 100);
  assert.equal(linhas[0].data_ocorrencia, '2026-10-01');
  assert.equal(linhas[0].nosso_numero, '111');
  assert.equal(linhas[1].tipo, 'rejeicao');
  assert.equal(linhas[2].tipo, 'baixa', 'liquidação ambígua não vira liquidação automática');
});

test('P2 CNAB: liquidação identificada por nosso número baixa o título uma vez', async () => {
  const conta = await createRecord(RESOURCES.contas_financeiras, { nome: `Conta CNAB ${Date.now()}`, tipo: 'banco', saldo_inicial: 0 }, ADMIN);
  const lanc = await novoLancamento({ descricao: 'Boleto CNAB P2', valor: 480, vencimento: hoje });
  // Cobrança emitida com nosso número (como o gateway faria).
  await s.insert(gateway.R_GATEWAY_COBRANCAS, { empresa_id: 1, provider: 'mock', metodo: 'boleto', lancamento_id: lanc.id, conta_id: conta.id, valor: 480, status: 'pendente', nosso_numero: 'NN-P2-001', provider_ref: 'mock-cnab-1' });

  const arquivo = arquivoCnab([
    { nossoNumero: 'NN-P2-001', movimento: '06', valorTitulo: 480, valorPago: 480 },
    { nossoNumero: 'NN-DESCONHECIDO', movimento: '06', valorTitulo: 999 },
    { nossoNumero: 'NN-P2-REJ', movimento: '03', valorTitulo: 10 },
  ]);
  const out = await chamar(cnab.importarCnab, reqDe({ conta_id: conta.id, conteudo: arquivo }));
  assert.equal(out.parser, 'cnab240');
  assert.equal(out.liquidadas, 1);
  assert.equal(out.divergentes, 2, 'NN desconhecido + rejeição viram divergência');
  const baixado = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(baixado!.status, 'confirmado');
  assert.match(String(baixado!.observacoes), /CNAB/);

  // Reimportação: idempotência total.
  const out2 = await chamar(cnab.importarCnab, reqDe({ conta_id: conta.id, conteudo: arquivo }));
  assert.equal(out2.duplicadas, 3);
  assert.equal(out2.liquidadas, 0);
  const ainda = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(ainda!.status, 'confirmado');
});

// ----------------------------------------------------------------------------
// 8) LIQUIDAÇÃO — unidade (juros/multa/desconto, método, operador, auditoria)
// ----------------------------------------------------------------------------

test('P2 liquidação: método, conta, operador e auditoria ficam registrados', async () => {
  const conta = await createRecord(RESOURCES.contas_financeiras, { nome: `Conta Liq P2 ${Date.now()}`, tipo: 'banco', saldo_inicial: 0 }, ADMIN);
  const lanc = await novoLancamento({ descricao: 'Título p/ liquidação auditada', valor: 200, vencimento: '2026-09-01' });
  await chamar(fin.baixarLancamento, reqDe({ conta_id: conta.id, forma_pagamento: 'pix', juros: 5, multa: 2, data: '2026-09-05' }, { params: { id: lanc.id } }));

  const confirmado = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(confirmado!.status, 'confirmado');
  assert.equal(Number(confirmado!.conta_id), Number(conta.id));
  assert.equal(confirmado!.forma_pagamento, 'pix');
  assert.match(String(confirmado!.observacoes), /Baixa em 2026-09-05.*juros\/multa.*por Admin/i);

  const filhos = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 20, filter: { referencia_tipo: 'baixa', referencia_id: lanc.id } });
  const jurosMulta = filhos.rows.find((f) => /Juros\/multa/.test(String(f.descricao)));
  assert.ok(jurosMulta, 'juros+multa viram lançamento filho');
  assert.equal(Number(jurosMulta!.valor), 7);

  const auditoria = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 20, filter: { recurso: 'lancamentos_financeiros', registro_id: lanc.id }, sort: 'id', dir: 'desc' });
  assert.ok(auditoria.rows.some((a) => /Baixa —/.test(String(a.descricao))), 'a baixa fica auditada');
});

test('P2 liquidação: valor acima do saldo do título é recusado', async () => {
  const lanc = await novoLancamento({ descricao: 'Título p/ excesso', valor: 100 });
  await esperarErro(() => fin.baixarLancamento(reqDe({ valor: 150 }, { params: { id: lanc.id } }), null as any), 400, /não pode exceder/i);
  const intacto = await s.get(RESOURCES.lancamentos_financeiros, Number(lanc.id));
  assert.equal(intacto!.status, 'pendente');
});
