// Fase 3 — pagamentos: caminho canônico (engine), placeholders fechados e
// verificação de webhooks do engine. Sem rede e sem credenciais: contratos
// testados com dublês locais. Isto NÃO é homologação com o provedor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { providerRegistry, provedorImplementado } = await import('../../modules/payments/providers/registry');
const { readiness } = await import('../../modules/payments/application/configuration');
const { PaymentError } = await import('../../modules/payments/domain/payment');

const ctx = (webhookSecret: string | null, credentials: Record<string, string> = {}) =>
  ({ empresaId: 1, credentials, webhookSecret, environment: 'teste', operationKey: 'k' }) as any;

test('prontidão: placeholders sem adaptador ficam marcados como não implementados; provedores reais não', async () => {
  const r = await readiness(1);
  const por = new Map(r.providers.map((p: any) => [p.code, p]));
  for (const code of ['PIX_DIRECT', 'BOLETO_GENERIC']) {
    if (por.has(code)) assert.equal((por.get(code) as any).implementado, false, `${code} não pode aparecer como implementado`);
  }
  for (const code of ['MERCADO_PAGO', 'STRIPE', 'PAGBANK']) {
    assert.equal((por.get(code) as any)?.implementado, true, `${code} tem adaptador real`);
  }
  assert.equal(provedorImplementado(providerRegistry.get('PIX_DIRECT' as any)), false);
});

test('placeholders falham fechados: sem criação e sem webhook aceito', async () => {
  const p = providerRegistry.get('PIX_DIRECT' as any);
  assert.equal(p.verifyWebhook(ctx('segredo'), '{}', { 'x-signature': 'qualquer' }), false);
  assert.equal(p.parseWebhook('{}'), null);
  await assert.rejects(p.createPaymentIntent(ctx('segredo'), {} as any), (e: unknown) => e instanceof PaymentError);
});

test('Stripe (engine): sem segredo nenhuma entrega é aceita', () => {
  const p = providerRegistry.get('STRIPE');
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', 'whsec-teste').update(`${ts}.${raw}`).digest('hex');
  assert.equal(p.verifyWebhook(ctx(null), raw, { 'stripe-signature': `t=${ts},v1=${v1}` }), false);
});

test('Stripe (engine): assinatura válida e dentro de 300 s passa; fora da janela ou adulterada falha', () => {
  const p = providerRegistry.get('STRIPE');
  const raw = JSON.stringify({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: 'cs_2' } } });
  const agora = Math.floor(Date.now() / 1000);
  const assinar = (ts: number, corpo = raw) => createHmac('sha256', 'whsec-teste').update(`${ts}.${corpo}`).digest('hex');
  assert.equal(p.verifyWebhook(ctx('whsec-teste'), raw, { 'stripe-signature': `t=${agora},v1=${assinar(agora)}` }), true);
  assert.equal(p.verifyWebhook(ctx('whsec-teste'), raw, { 'stripe-signature': `t=${agora - 900},v1=${assinar(agora - 900)}` }), false, 'replay fora da janela');
  assert.equal(p.verifyWebhook(ctx('whsec-teste'), raw, { 'stripe-signature': `t=${agora},v1=${assinar(agora, raw.replace('cs_2', 'cs_9'))}` }), false, 'corpo adulterado');
});

test('PagBank (engine): sem token de credencial nenhuma entrega é aceita; com token, o hash confere', () => {
  const p = providerRegistry.get('PAGBANK');
  const raw = JSON.stringify({ id: 'ORDE_TESTE_123', charges: [] });
  const token = 'token-pagbank-teste-0123456789';
  const assinatura = createHash('sha256').update(`${token}-${raw}`).digest('hex');
  assert.equal(p.verifyWebhook(ctx(null, {}), raw, { 'x-authenticity-token': assinatura }), false);
  // R-10 (Fase 4.2): sem segredo de webhook próprio, o access token NÃO basta (falha fechada).
  assert.equal(p.verifyWebhook(ctx(null, { access_token: token }), raw, { 'x-authenticity-token': assinatura }), false);
  assert.equal(p.verifyWebhook(ctx('segredo-webhook-dedicado-teste', { access_token: token }), raw, { 'x-authenticity-token': assinatura }), true);
  assert.equal(p.verifyWebhook(ctx(null, { access_token: token }), raw, { 'x-authenticity-token': '0'.repeat(64) }), false);
});
