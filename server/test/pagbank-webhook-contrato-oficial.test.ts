// ============================================================================
// PagBank — contrato oficial de autenticidade da notificação (Fase 4.3, itens 6/7)
//
// Fonte: documentação oficial "Confirmar autenticidade da notificação"
// (developer.pagbank.com.br/reference/confirmar-autenticidade-da-notificacao):
//   • x-authenticity-token = SHA-256 hex de "{token}-{corpo cru}";
//   • o token é o TOKEN DA CONTA (obtido via access token / iBanking);
//   • o corpo deve ser usado EXATAMENTE como recebido (sem reformatar, sem espaços).
// Não há timestamp nem janela de validade no contrato: nenhum relógio participa.
// LOCAL e sem rede. Não prova comunicação com o provedor (isso é o gate H-8).
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { PagBankProvider } = await import('../../modules/payments/providers/pagbank/index');
const p = new PagBankProvider();

const TOKEN = 'fixture-token-conta-pagbank-0003';
const SEGREDO = 'fixture-segredo-gate-pagbank-0004';
// Corpo de exemplo da documentação oficial, compactado (corpo cru do teste).
const RAW_OFICIAL = '{"id":"ORDE_FIXTURE_OFICIAL_0001","status":"WAITING","created_at":"2019-09-24T18:31:19.027-03:00","amount":{"value":100,"currency":"BRL"},"notification_urls":["https://yourserver.com/nas_ecommerce/fixture/"]}';

const oficial = (token: string, raw: string) => createHash('sha256').update(`${token}-${raw}`).digest('hex');
const ctx = (webhookSecret: string | null = SEGREDO, token = TOKEN) => ({
  empresaId: 1,
  credentials: { access_token: token, notification_url: 'https://exemplo.test/n', enabled_methods: 'PIX' },
  webhookSecret,
  environment: 'teste' as const,
  operationKey: '',
});
const verifica = (raw: string, headers: Record<string, string | undefined>, c = ctx()) =>
  p.verifyWebhook(c as never, raw, headers, {});

describe('PagBank — algoritmo oficial SHA-256("{token}-{corpo cru}")', () => {
  test('assinatura calculada conforme a documentação oficial é aceita', () => {
    assert.equal(verifica(RAW_OFICIAL, { 'x-authenticity-token': oficial(TOKEN, RAW_OFICIAL) }), true);
  });

  test('a chave é o token da conta: token diferente é recusado', () => {
    assert.equal(verifica(RAW_OFICIAL, { 'x-authenticity-token': oficial('outro-token', RAW_OFICIAL) }), false);
  });

  test('corpo alterado em um caractere é recusado', () => {
    const adulterado = RAW_OFICIAL.replace('"BRL"', '"USD"');
    assert.equal(verifica(adulterado, { 'x-authenticity-token': oficial(TOKEN, RAW_OFICIAL) }), false);
  });

  test('corpo reformatado (mesmo conteúdo, outra formatação) é recusado: a assinatura é sobre o corpo cru', () => {
    const reformatado = JSON.stringify(JSON.parse(RAW_OFICIAL), null, 2);
    assert.notEqual(reformatado, RAW_OFICIAL);
    assert.equal(verifica(reformatado, { 'x-authenticity-token': oficial(TOKEN, RAW_OFICIAL) }), false);
  });

  test('espaço acrescentado ao corpo cru invalida a assinatura', () => {
    assert.equal(verifica(`${RAW_OFICIAL} `, { 'x-authenticity-token': oficial(TOKEN, RAW_OFICIAL) }), false);
  });

  test('cabeçalho malformado (tamanho errado, não hexadecimal, vazio) é recusado sem exceção', () => {
    assert.equal(verifica(RAW_OFICIAL, { 'x-authenticity-token': 'a'.repeat(63) }), false);
    assert.equal(verifica(RAW_OFICIAL, { 'x-authenticity-token': 'z'.repeat(64) }), false);
    assert.equal(verifica(RAW_OFICIAL, { 'x-authenticity-token': '' }), false);
    assert.equal(verifica(RAW_OFICIAL, {}), false);
  });
});

describe('PagBank — segredo de presença (gate fail-closed)', () => {
  test('sem segredo cadastrado, nada é aceito mesmo com assinatura oficial correta', () => {
    assert.equal(verifica(RAW_OFICIAL, { 'x-authenticity-token': oficial(TOKEN, RAW_OFICIAL) }, ctx(null)), false);
  });

  test('segredo vazio ou só espaços é tratado como ausente', () => {
    assert.equal(verifica(RAW_OFICIAL, { 'x-authenticity-token': oficial(TOKEN, RAW_OFICIAL) }, ctx('   ')), false);
  });
});

describe('PagBank — repetição e validade temporal', () => {
  test('o mesmo corpo gera sempre o mesmo identificador de evento (base da idempotência)', () => {
    const a = p.parseWebhook(RAW_OFICIAL);
    const b = p.parseWebhook(RAW_OFICIAL);
    assert.ok(a && b);
    assert.equal(a!.id, b!.id);
    const outro = p.parseWebhook(RAW_OFICIAL.replace('ORDE_FIXTURE_OFICIAL_0001', 'ORDE_FIXTURE_OFICIAL_0002'));
    assert.notEqual(outro!.id, a!.id, 'evento diferente não colide com o anterior');
  });

  test('a verificação não depende do horário: data antiga no corpo não altera o resultado', () => {
    const antigo = RAW_OFICIAL.replace('2019-09-24T18:31:19.027-03:00', '2001-01-01T00:00:00.000-03:00');
    assert.equal(verifica(antigo, { 'x-authenticity-token': oficial(TOKEN, antigo) }), true);
  });
});
