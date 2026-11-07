// ============================================================================
// AGENTE 05 / MISSÃO A — Cobrança avulsa do financeiro pelo caminho CANÔNICO.
//
// ADR-001: `modules/payments/` é o único caminho de integração com provedores.
// O gateway legado (`server/src/gateway.ts`) é ADAPTADOR DE COMPATIBILIDADE: ele
// reserva a cobrança, mantém a idempotência e a marcação `UNCERTAIN`, mas NÃO
// cria cobrança por conta própria. Estes testes provam que:
//   • a criação passa pelo adaptador do Payment Engine (não por uma segunda
//     implementação dentro do gateway);
//   • o contrato público legado continua o mesmo (status 201, mesma cobrança);
//   • reenvio idempotente NÃO cria segunda cobrança;
//   • valor e método são validados no backend e chegam ao Engine em centavos;
//   • o vínculo com `gateway_cobrancas` e `lancamentos_financeiros` é preservado.
//
// LOCAL: store em memória, sem rede.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, createRecord } = await import('../src/services');
const { ADMIN, chamar, garantirAdmin, reqDe, esperarErro } = await import('./_p1util');
const gateway = await import('../src/gateway');
const { registrarReautenticacao } = await import('../src/auth');
const { providerRegistry } = await import('../../modules/payments/providers/registry');
const { paymentEngine } = await import('../../modules/payments/orchestration/payment-orchestrator');

await garantirAdmin();
const s = getStore();
const hoje = new Date().toISOString().slice(0, 10);

before(async () => {
  registrarReautenticacao(ADMIN.id);
  await chamar(gateway.configurarGateway, reqDe({ provider: 'mock', ambiente: 'teste', credenciais: { fake: 'cred' } }));
});

async function novoLancamento(descricao: string, valor: number) {
  return createRecord(RESOURCES.lancamentos_financeiros, { data: hoje, status: 'pendente', tipo: 'receita', descricao, valor }, ADMIN);
}

test('avulsa: a criação é executada pelo adaptador do Payment Engine, não pelo gateway', async (t) => {
  const adapter = providerRegistry.get('ACQUIRER_GENERIC');
  const vistos: { amount: number; method: string }[] = [];
  t.mock.method(adapter, 'createPaymentIntent', async (_ctx: any, input: any) => {
    vistos.push({ amount: input.amount, method: input.method });
    // Sentinela: só o Engine pode produzi-la. Se o gateway criasse por conta
    // própria (chamando o mock direto), o provider_ref não seria este.
    return { reference: `engine-sentinel-${input.reference}`, status: 'PENDING' as const, action: { type: 'PIX', code: '000201sentinel' } };
  });

  const lanc = await novoLancamento('Título avulsa via Engine', 137.5);
  const saida = await chamar(
    gateway.criarCobranca,
    reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lanc.id, payer_email: 'cliente@exemplo.com' }),
    201
  );

  assert.equal(vistos.length, 1, 'o Engine é chamado exatamente uma vez');
  assert.equal(vistos[0].amount, 13750, 'o Engine recebe o valor em centavos');
  assert.equal(vistos[0].method, 'PIX');
  assert.match(String(saida.cobranca.provider_ref), /^engine-sentinel-/);
  const cobranca = await s.get(gateway.R_GATEWAY_COBRANCAS, Number(saida.cobranca.id));
  assert.equal(cobranca!.lancamento_id, Number(lanc.id), 'vínculo com o título preservado');
  assert.equal(cobranca!.status, 'pendente');
});

test('avulsa: reenvio idempotente devolve a MESMA cobrança sem segunda chamada ao Engine', async (t) => {
  const adapter = providerRegistry.get('ACQUIRER_GENERIC');
  let chamadas = 0;
  t.mock.method(adapter, 'createPaymentIntent', async (_ctx: any, input: any) => {
    chamadas++;
    return { reference: `engine-idem-${input.reference}`, status: 'PENDING' as const, action: { type: 'PIX', code: '000201idem' } };
  });
  const lanc = await novoLancamento('Título avulsa idempotente', 42);
  const corpo = { provider: 'mock', metodo: 'pix', lancamento_id: lanc.id, payer_email: 'cliente@exemplo.com' };
  const primeira = await chamar(gateway.criarCobranca, reqDe(corpo), 201);
  const repetida = await chamar(gateway.criarCobranca, reqDe(corpo), 200);
  assert.equal(repetida.idempotente, true);
  assert.equal(Number(repetida.cobranca.id), Number(primeira.cobranca.id), 'a mesma cobrança é devolvida');
  assert.equal(chamadas, 1, 'nenhuma segunda criação no Engine');
});

test('avulsa: recusa definitiva do Engine encerra a reserva como falhou (sem ficar PROCESSING)', async (t) => {
  const adapter = providerRegistry.get('ACQUIRER_GENERIC');
  const { PaymentError } = await import('../../modules/payments/domain/payment');
  t.mock.method(adapter, 'createPaymentIntent', async () => {
    throw new PaymentError('PAYMENT_DECLINED');
  });
  const lanc = await novoLancamento('Título avulsa recusado', 55);
  await esperarErro(
    () => gateway.criarCobranca(reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lanc.id, payer_email: 'x@y.z' }), null as any),
    409
  );
  const cobranca = await s.findOneWhere(gateway.R_GATEWAY_COBRANCAS, { empresa_id: 1, lancamento_id: Number(lanc.id) });
  assert.ok(cobranca);
  assert.equal(cobranca!.status, 'falhou', 'recusa não ambígua não deixa a cobrança pendente');
  assert.equal(cobranca!.criacao_operacao_estado, 'FAILED');
});

test('avulsa: falha ambígua do Engine mantém UNCERTAIN (não vira falha definitiva)', async (t) => {
  const adapter = providerRegistry.get('ACQUIRER_GENERIC');
  t.mock.method(adapter, 'createPaymentIntent', async () => {
    throw new TypeError('fetch failed — escrita ambígua, sem rede');
  });
  const lanc = await novoLancamento('Título avulsa incerto', 61);
  await esperarErro(
    () => gateway.criarCobranca(reqDe({ provider: 'mock', metodo: 'pix', lancamento_id: lanc.id, payer_email: 'x@y.z' }), null as any),
    409
  );
  const cobranca = await s.findOneWhere(gateway.R_GATEWAY_COBRANCAS, { empresa_id: 1, lancamento_id: Number(lanc.id) });
  assert.equal(cobranca!.criacao_operacao_estado, 'UNCERTAIN', 'timeout não prova ausência de criação');
});

void paymentEngine;
