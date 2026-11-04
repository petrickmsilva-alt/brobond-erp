// R-10 (Fase 4.2) — PagBank: o segredo de webhook é próprio e falha fechado quando ausente.
// LOCAL, sem rede. A assinatura é a documentada pelo PagBank (x-authenticity-token =
// SHA-256 hex de "{access_token}-{corpo cru}"); o access token é a CHAVE desse esquema,
// não um fallback de configuração — por isso o teste de assinatura válida usa o token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { PagBankProvider } = await import('../../modules/payments/providers/pagbank/index');
const cfg = await import('../../modules/payments/application/configuration');
const { decifrarSegredo } = await import('../src/segredos');

const TOKEN = 'fixture-access-token-pagbank-0001';
const SEGREDO = 'fixture-segredo-webhook-pagbank-0002';
const RAW = JSON.stringify({ id: 'ORDE_FIXTURE_0001', charges: [] });
const assinatura = (token: string, raw: string) => createHash('sha256').update(`${token}-${raw}`).digest('hex');
const ctx = (webhookSecret: string | null) => ({
  empresaId: 1,
  credentials: { access_token: TOKEN, notification_url: 'https://exemplo.test/n', enabled_methods: 'PIX' },
  webhookSecret,
  environment: 'teste' as const,
  operationKey: '',
});
const p = new PagBankProvider();

test('assinatura válida com segredo próprio configurado é aceita (fluxo legítimo)', () => {
  assert.equal(p.verifyWebhook(ctx(SEGREDO) as any, RAW, { 'x-authenticity-token': assinatura(TOKEN, RAW) }, {}), true);
});

test('assinatura inválida é recusada', () => {
  assert.equal(p.verifyWebhook(ctx(SEGREDO) as any, RAW, { 'x-authenticity-token': assinatura('outro-token', RAW) }, {}), false);
});

test('assinatura ausente ou malformada é recusada', () => {
  assert.equal(p.verifyWebhook(ctx(SEGREDO) as any, RAW, {}, {}), false);
  assert.equal(p.verifyWebhook(ctx(SEGREDO) as any, RAW, { 'x-authenticity-token': 'curta' }, {}), false);
});

test('segredo de webhook AUSENTE: falha fechada mesmo com assinatura calculada corretamente (R-10)', () => {
  // RED antes da correção: a assinatura válida era aceita, porque o verificador não exigia segredo próprio.
  assert.equal(p.verifyWebhook(ctx(null) as any, RAW, { 'x-authenticity-token': assinatura(TOKEN, RAW) }, {}), false);
});

test('segredo de webhook AUSENTE: o provedor não se anuncia como disponível (sem PIX)', () => {
  assert.deepEqual(p.capabilities(ctx(null) as any), []);
});

test('segredo que é igual ao access token é tratado como ausente (configuração legada)', () => {
  assert.equal(cfg.segredoWebhookEfetivo('PAGBANK', TOKEN, { access_token: TOKEN }), null);
  assert.equal(cfg.segredoWebhookEfetivo('PAGBANK', SEGREDO, { access_token: TOKEN }), SEGREDO);
  assert.equal(cfg.segredoWebhookEfetivo('PAGBANK', '', { access_token: TOKEN }), null);
});

test('configuração por ambiente: sem PAGBANK_WEBHOOK_SECRET não cria configuração (nunca grava o token)', () => {
  const env = { PAGBANK_ACCESS_TOKEN: TOKEN, PAGBANK_ENVIRONMENT: 'teste' } as NodeJS.ProcessEnv;
  assert.equal(cfg.configuracaoAmbientePagamento('PAGBANK', env, 1, 'pagbank'), null);
});

test('configuração por ambiente: com segredo próprio, o segredo gravado é o dedicado (não o token)', () => {
  const env = { PAGBANK_ACCESS_TOKEN: TOKEN, PAGBANK_WEBHOOK_SECRET: SEGREDO, PAGBANK_ENVIRONMENT: 'teste' } as NodeJS.ProcessEnv;
  const c = cfg.configuracaoAmbientePagamento('PAGBANK', env, 1, 'pagbank');
  assert.ok(c, 'configuração criada');
  assert.equal(decifrarSegredo(c!.webhook_segredo_cifrado), SEGREDO);
});

test('segredos não aparecem em mensagens de erro do verificador', () => {
  let msg = '';
  try { p.verifyWebhook(ctx(null) as any, RAW, { 'x-authenticity-token': 'x'.repeat(64) }, {}); } catch (e: any) { msg = String(e?.message ?? ''); }
  assert.ok(!msg.includes(TOKEN) && !msg.includes(SEGREDO));
});
