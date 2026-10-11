// ============================================================
// P1-13 (auditoria independente, 2026-10-11): a normalização de data civil.
//
// O Postgres entrega TIMESTAMPTZ como `Date`; `String(date).slice(0, 10)` produz
// "Wed Oct 11" e uma comparação de período passa a DESCARTAR linhas reais. Este
// teste é a prova de unidade do helper único (`utils.diaISO`) — a prova contra o
// driver de verdade está em `test/pg/comissoes-periodo.test.ts`.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diaISO } from '../src/utils';

test('diaISO: Date (o que o driver do Postgres entrega) vira o dia civil', () => {
  assert.equal(diaISO(new Date('2026-03-10T12:34:56Z')), '2026-03-10');
  // Fronteira do fuso: 23:30 de Brasília é 02:30Z do dia seguinte.
  assert.equal(diaISO(new Date('2026-03-11T02:30:00Z')), '2026-03-11');
  assert.equal(diaISO(new Date('invalid')), '');
});

test('diaISO: string ISO (o que o memdb entrega) e vazio/inválido', () => {
  assert.equal(diaISO('2026-03-10'), '2026-03-10');
  assert.equal(diaISO('2026-03-10T12:34:56Z'), '2026-03-10');
  assert.equal(diaISO('  2026-03-10  '), '2026-03-10');
  assert.equal(diaISO(''), '');
  assert.equal(diaISO(null), '');
  assert.equal(diaISO(undefined), '');
  assert.equal(diaISO('não é data'), '');
});

test('diaISO: o valor de um Date NUNCA vira "Wed Oct 1" (o defeito do P1-13)', () => {
  const doDriver = new Date('2026-10-01T00:00:00Z');
  assert.equal(String(doDriver).slice(0, 10), 'Thu Oct 01', 'o defeito é real quando se usa String');
  assert.equal(diaISO(doDriver), '2026-10-01', 'a normalização correta mantém a ordem lexicográfica');
  assert.ok('2026-10-01' <= '2026-10-31' && '2026-10-01' >= '2026-10-01');
});
