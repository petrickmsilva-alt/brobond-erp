// EAN/GTIN no cliente (P0 §7): o mesmo algoritmo GS1 do servidor.
import { describe, expect, it } from 'vitest';
import { barcodeSvg, eanCheckDigit, erroGtin, gtinKind, isValidEan, isValidGtin } from './barcode';
import { erroCodigoBarras, erroGtinTributario } from './produtos';

describe('ean/gtin', () => {
  it('confere o dígito verificador em EAN-8, UPC-A, EAN-13 e EAN-14', () => {
    expect(eanCheckDigit('789123456789')).toBe(5);
    expect(isValidGtin('7891234567895')).toBe(true); // EAN-13
    expect(isValidGtin('96385074')).toBe(true); // EAN-8 (ex. GS1)
    expect(isValidGtin('036000291452')).toBe(true); // UPC-A (ex. GS1)
    expect(isValidGtin('17891234567892')).toBe(true); // GTIN-14
    expect(gtinKind('036000291452')).toBe('GTIN-12');
  });

  it('recusa dígito incorreto e tamanho incorreto', () => {
    expect(isValidGtin('7891234567890')).toBe(false);
    expect(erroGtin('7891234567890')).toMatch(/dígito verificador/i);
    expect(erroGtin('12345')).toMatch(/8, 12, 13 ou 14/);
    expect(erroGtin('')).toBeNull();
  });

  it('não trata SKU interno como EAN (etiqueta cai para Code 128)', () => {
    expect(isValidGtin('CAMISA-AZUL-M')).toBe(false);
    expect(barcodeSvg('CAMISA-AZUL-M').kind).toBe('CODE128');
    expect(barcodeSvg('7891234567895').kind).toBe('EAN-13');
    expect(isValidEan('7891234567895')).toBe(true);
    // GTIN-14 válido é reconhecido no cadastro mas a simbologia segue Code 128.
    expect(barcodeSvg('17891234567892').kind).toBe('CODE128');
  });

  it('validação do formulário de produto usa o dígito verificador', () => {
    expect(erroCodigoBarras('7891234567895')).toBeNull();
    expect(erroCodigoBarras('7891234567890')).toMatch(/dígito verificador/i);
    expect(erroCodigoBarras('')).toBeNull();
    expect(erroGtinTributario('96385074')).toBeNull();
    expect(erroGtinTributario('96385075')).toMatch(/dígito verificador/i);
  });
});
