// ============================================================================
// EAN/GTIN (P0 §7) — dígito verificador GS1 no cadastro de produto.
// Vetores conferidos à mão pelo algoritmo GS1 (pesos 3/1 da direita):
//   EAN-13  7891234567895  (base 789123456789 -> dv 5)
//   EAN-8   96385074       (exemplo clássico GS1)
//   UPC-A   036000291452   (exemplo clássico GS1)
//   GTIN-14 17891234567892 (base 1789123456789 -> dv 2)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { gtinCheckDigit, isValidGtin, gtinKind, erroGtin } = await import('../src/ean');
const { validatePayload } = await import('../src/validate');
const { RESOURCES } = await import('../src/resources');

test('ean: dígito verificador GS1 confere nos 4 comprimentos', () => {
  assert.equal(gtinCheckDigit('789123456789'), 5);
  assert.equal(isValidGtin('7891234567895'), true);
  assert.equal(isValidGtin('96385074'), true);
  assert.equal(isValidGtin('036000291452'), true);
  assert.equal(isValidGtin('17891234567892'), true);
  assert.equal(gtinKind('96385074'), 'GTIN-8');
  assert.equal(gtinKind('036000291452'), 'GTIN-12');
  assert.equal(gtinKind('7891234567895'), 'GTIN-13');
  assert.equal(gtinKind('17891234567892'), 'GTIN-14');
});

test('ean: dígito incorreto é recusado', () => {
  assert.equal(isValidGtin('7891234567890'), false, 'o placeholder antigo era um EAN inválido');
  assert.equal(isValidGtin('96385075'), false);
  assert.match(erroGtin('7891234567890')!, /dígito verificador/i);
});

test('ean: tamanho incorreto e não-dígito têm mensagens próprias; vazio é permitido', () => {
  assert.match(erroGtin('12345')!, /8, 12, 13 ou 14/);
  assert.match(erroGtin('78912345678A5')!, /apenas dígitos/);
  assert.equal(erroGtin(''), null);
  assert.equal(erroGtin(null), null);
  assert.equal(erroGtin(undefined), null);
});

test('ean: SKU interno não é EAN (não é validado como GTIN nem classificado)', () => {
  assert.equal(gtinKind('CAMISA-AZUL-M'), null);
  assert.equal(isValidGtin('CAMISA-AZUL-M'), false);
  // E o campo sku do cadastro continua texto livre:
  const out = validatePayload(RESOURCES.produtos, { sku: 'CAMISA-AZUL-M', nome: 'Camisa' }, 'create');
  assert.equal(out.sku, 'CAMISA-AZUL-M');
});

test('ean: validatePayload recusa codigo_barras/gtin_tributario com dígito errado e aceita os válidos', () => {
  assert.throws(
    () => validatePayload(RESOURCES.produtos, { sku: 'X1', nome: 'X', codigo_barras: '7891234567890' }, 'create'),
    /dígito verificador/i
  );
  assert.throws(
    () => validatePayload(RESOURCES.produtos, { sku: 'X2', nome: 'X', gtin_tributario: '96385075' }, 'create'),
    /dígito verificador/i
  );
  const ok = validatePayload(RESOURCES.produtos, { sku: 'X3', nome: 'X', codigo_barras: '7891234567895', gtin_tributario: '17891234567892' }, 'create');
  assert.equal(ok.codigo_barras, '7891234567895');
  // Sem código de barras também cadastra (produto sem EAN de fábrica).
  const sem = validatePayload(RESOURCES.produtos, { sku: 'X4', nome: 'X' }, 'create');
  assert.equal(sem.codigo_barras ?? null, null);
});
