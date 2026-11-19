// P1-13: normalize civil dates delivered by PostgreSQL and memory stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diaISO } from '../src/utils';

test('diaISO: Date (o que o driver do Postgres entrega) vira o dia civil ISO', () => {
  assert.equal(diaISO(new Date('2026-03-10T12:34:56Z')), '2026-03-10');
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

test('diaISO: Date nunca é convertido para string de locale; retorna YYYY-MM-DD estável', () => {
  const doDriver = new Date('2026-10-01T00:00:00Z');
  const localeDate = String(doDriver).slice(0, 10);
  assert.match(localeDate, /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/);
  assert.equal(diaISO(doDriver), '2026-10-01');
  assert.ok('2026-10-01' <= '2026-10-31' && '2026-10-01' >= '2026-10-01');
});
