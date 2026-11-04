// Ordem Final 2.6 — PIX em SANDBOX (opcional). Camadas de teste PIX deste repositório:
//   1. MOCK ............ commerce-pix-mock-flow.test.ts (gateway simulado; não é integração real).
//   2. CONTRATO ........ adapters declaram o formato de PaymentInput/PaymentResult (testes de contrato).
//   3. INTEGRAÇÃO LOCAL  fetch simulado no adapter; nenhuma rede (commerce-orders-pix.test.ts).
//   4. SANDBOX (este) .. chamada real ao sandbox de UM provedor, SOMENTE com credencial fornecida.
//
// Variáveis declaradas (nomes; os valores NUNCA são impressos):
//   PIX_SANDBOX_PROVEDOR      mercadopago | pagbank
//   PIX_SANDBOX_ACCESS_TOKEN  token de SANDBOX do provedor escolhido (nunca o de produção)
// Sem as duas variáveis o teste é PULADO com motivo explícito. Nenhuma credencial é inventada.
// Com as duas, cria UMA cobrança PIX de R$ 1,00 no ambiente 'teste'. Não cancela, não reembolsa.
// STATUS: ainda NÃO executado contra sandbox real (sem credencial disponível). Não é homologação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MercadoPagoProvider } from '../../modules/payments/providers/mercado-pago';
import { PagBankProvider } from '../../modules/payments/providers/pagbank';

const provedor = String(process.env.PIX_SANDBOX_PROVEDOR || '').trim().toLowerCase();
const tokenSandbox = String(process.env.PIX_SANDBOX_ACCESS_TOKEN || '').trim();
const motivoSkip = !provedor || !tokenSandbox
  ? 'PIX sandbox não configurado (PIX_SANDBOX_PROVEDOR e PIX_SANDBOX_ACCESS_TOKEN ausentes): pulado, sem credencial inventada'
  : (['mercadopago', 'pagbank'].includes(provedor) ? false : 'PIX_SANDBOX_PROVEDOR deve ser mercadopago ou pagbank');

test('PIX sandbox: cria uma cobrança PIX de teste no provedor declarado', { skip: motivoSkip, timeout: 60000 }, async () => {
  const instancia = provedor === 'mercadopago' ? new MercadoPagoProvider() : new PagBankProvider();
  const ctx = {
    empresaId: 1,
    credentials: { access_token: tokenSandbox },
    webhookSecret: null,
    environment: 'teste' as const,
    operationKey: `sandbox-pix-${Date.now()}`,
  };
  const input = {
    amount: 100,
    currency: 'BRL',
    method: 'pix' as const,
    reference: `sbx-pix-${Date.now()}`,
    email: 'comprador-teste@example.com',
    installments: 1,
  };
  const r = await instancia.createPaymentIntent(ctx, input);
  assert.ok(r && typeof r.reference === 'string' && r.reference.length > 0, 'provedor devolve referência da cobrança');
  assert.ok(r.status, 'provedor devolve status');
  // Nenhum valor de credencial pode aparecer no resultado.
  assert.ok(!JSON.stringify(r).includes(tokenSandbox), 'token não aparece no resultado');
});
