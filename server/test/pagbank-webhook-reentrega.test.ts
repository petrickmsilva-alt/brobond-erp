// ============================================================================
// P3-02 — PagBank: reentrega e deduplicação por identificador OFICIAL.
//
// Contrato oficial (developer.pagbank.com.br/reference/webhooks): o payload do
// webhook de Order é a própria Order (mesmo formato do response síncrono da
// API) e, para PIX, traz o identificador OFICIAL da notificação
// (`charges[].payment_method.pix.notification_id`, formato `NTF_...`).
// Deduplicar pelo hash do corpo fazia uma reentrega do MESMO evento com bytes
// diferentes (ordem de chaves, espaços, campos irrelevantes) parecer um evento
// NOVO.
//
// A identidade agora usa, em ordem:
//   1. os `notification_id` oficiais, quando presentes;
//   2. senão, a Order + o conjunto normalizado de cobranças e estados.
// De modo que:
//   • reentrega do mesmo evento, com bytes diferentes, DEDUPLICA;
//   • mudança legítima de estado da MESMA cobrança é um evento NOVO;
//   • uma nova cobrança na mesma Order é um evento NOVO.
// O hash do corpo permanece como evidência complementar (`payload_hash`), nunca
// como chave de deduplicação.
//
// LOCAL e sem rede: apenas o contrato de identificação do adapter.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { PagBankProvider } = await import('../../modules/payments/providers/pagbank/index');
const p = new PagBankProvider();

const order = (id: string, charges: { id: string; status: string }[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, reference_id: 'ex-1', created_at: '2020-11-21T23:23:22.69-03:00', charges, ...extra });

const chargePix = (id: string, status: string, notificationId: string) => ({
  id,
  status,
  payment_method: { type: 'PIX', pix: { notification_id: notificationId } },
});

const ORDE = 'ORDE_F87334AC-BB8B-42E2-AA85-8579F70AA328';
const WAITING = [{ id: 'CHAR_F1F10115', status: 'WAITING' }];
const NTF = 'NTF_13EE7E12-E1E0-4A32-8E1B-B7C06EA49B7F';

describe('PagBank — identidade de evento pelo identificador oficial (P3-02)', () => {
  test('o notification_id OFICIAL é usado como identidade quando presente', () => {
    const a = p.parseWebhook(order(ORDE, [chargePix('CHAR_1', 'PAID', NTF)]));
    assert.ok(a);
    assert.match(a!.id, /NTF_13EE7E12/);
    assert.equal(a!.reference, ORDE);
  });

  test('reentrega com notification_id igual deduplica mesmo com bytes MUITO diferentes', () => {
    const a = p.parseWebhook(order(ORDE, [chargePix('CHAR_1', 'PAID', NTF)]));
    const b = p.parseWebhook(
      JSON.stringify({ charges: [chargePix('CHAR_1', 'PAID', NTF)], id: ORDE, reference_id: 'ex-1', extra: 'x' })
    );
    assert.ok(a && b);
    assert.equal(a!.id, b!.id, 'a identidade é o notification_id, não o hash do corpo');
  });

  test('notification_id diferente (aviso novo) é evento NOVO, ainda que a Order seja a mesma', () => {
    const a = p.parseWebhook(order(ORDE, [chargePix('CHAR_1', 'PAID', NTF)]));
    const b = p.parseWebhook(order(ORDE, [chargePix('CHAR_1', 'PAID', 'NTF_AAAAAAAA-0000-0000-0000-000000000000')]));
    assert.ok(a && b);
    assert.notEqual(a!.id, b!.id);
  });

  test('sem notification_id, usa a composição Order + cobranças como fallback', () => {
    const a = p.parseWebhook(order(ORDE, WAITING));
    assert.ok(a);
    assert.equal(a!.id, `${ORDE}:CHAR_F1F10115:WAITING`);
  });

  test('reentrega do mesmo evento com bytes diferentes deduplica (mesma identidade)', () => {
    const a = p.parseWebhook(order(ORDE, WAITING));
    // Mesmo evento, reescrito com outra formatação e campos irrelevantes.
    const reescrito = JSON.stringify({
      charges: [{ status: 'WAITING', id: 'CHAR_F1F10115', created_at: '2020-11-21T23:30:22.695-03:00' }],
      id: ORDE,
      reference_id: 'ex-1',
      extra_field: 'ignorado',
    });
    const b = p.parseWebhook(reescrito);
    assert.ok(a && b);
    assert.equal(a!.id, b!.id, 'a reentrega deve ter a MESMA identidade');
    assert.equal(a!.reference, b!.reference);
  });

  test('mudança legítima de estado da MESMA cobrança é um evento NOVO', () => {
    const waiting = p.parseWebhook(order(ORDE, [{ id: 'CHAR_1', status: 'WAITING' }]));
    const paid = p.parseWebhook(order(ORDE, [{ id: 'CHAR_1', status: 'PAID' }]));
    assert.ok(waiting && paid);
    assert.notEqual(waiting!.id, paid!.id, 'estado novo não pode ser descartado como duplicata');
    assert.equal(waiting!.reference, paid!.reference);
  });

  test('nova cobrança na mesma Order é um evento NOVO', () => {
    const one = p.parseWebhook(order(ORDE, [{ id: 'CHAR_1', status: 'PAID' }]));
    const two = p.parseWebhook(order(ORDE, [{ id: 'CHAR_1', status: 'PAID' }, { id: 'CHAR_2', status: 'WAITING' }]));
    assert.ok(one && two);
    assert.notEqual(one!.id, two!.id);
  });

  test('a ordem das cobranças não altera a identidade (conjunto normalizado)', () => {
    const a = p.parseWebhook(order(ORDE, [{ id: 'CHAR_A', status: 'PAID' }, { id: 'CHAR_B', status: 'WAITING' }]));
    const b = p.parseWebhook(order(ORDE, [{ id: 'CHAR_B', status: 'WAITING' }, { id: 'CHAR_A', status: 'PAID' }]));
    assert.ok(a && b);
    assert.equal(a!.id, b!.id);
  });

  test('evento de outra Order não colide', () => {
    const a = p.parseWebhook(order(ORDE, WAITING));
    const b = p.parseWebhook(order('ORDE_OUTRA_0002', WAITING));
    assert.ok(a && b);
    assert.notEqual(a!.id, b!.id);
  });

  test('Order sem charges usa o status da própria Order como parte da identidade', () => {
    const a = p.parseWebhook(JSON.stringify({ id: ORDE, status: 'WAITING' }));
    const b = p.parseWebhook(JSON.stringify({ id: ORDE, status: 'PAID' }));
    assert.ok(a && b);
    assert.notEqual(a!.id, b!.id);
    assert.equal(a!.id, p.parseWebhook(JSON.stringify({ id: ORDE, status: 'WAITING' }))!.id, 'reentrega idêntica deduplica');
  });

  test('notification_id malformado (não NTF_) é ignorado no fallback', () => {
    const a = p.parseWebhook(order(ORDE, [{ id: 'CHAR_1', status: 'PAID', payment_method: { type: 'PIX', pix: { notification_id: 'lixo' } } }]));
    assert.ok(a);
    assert.equal(a!.id, `${ORDE}:CHAR_1:PAID`, 'id inválido não entra na identidade');
  });

  test('identificador não-Order continua ignorado (fora do escopo de pagamento)', () => {
    assert.equal(p.parseWebhook(JSON.stringify({ id: 'CHAR_123', status: 'PAID' })), null);
    assert.equal(p.parseWebhook('notificação não-json'), null);
  });
});
