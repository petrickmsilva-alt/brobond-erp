// ============================================================================
// EAN / GTIN — dígito verificador GS1 (P0 §7).
//
// O algoritmo é o MESMO que o front já usa para desenhar o código de barras
// (`eanCheckDigit` em client/src/lib/barcode.ts): pesos 3/1 alternados a
// partir da direita. Ele vale para toda a família GTIN — GTIN-8 (EAN-8),
// GTIN-12 (UPC-A), GTIN-13 (EAN-13) e GTIN-14 — porque o dígito verificador
// GS1 é definido sobre os dígitos à esquerda dele, qualquer que seja o
// comprimento total.
//
// FRONTEIRA IMPORTANTE: isto valida GTIN/EAN de verdade (campos
// `codigo_barras` e `gtin_tributario`, que o cadastro já restringe a 8/12/13/
// 14 dígitos). SKU interno NÃO é EAN: continua texto livre, é impresso em
// Code 128 e nunca passa por aqui.
// ============================================================================

/** Comprimentos da família GTIN aceitos pelo cadastro. */
export const GTIN_LENGTHS = [8, 12, 13, 14] as const;

export type GtinKind = 'GTIN-8' | 'GTIN-12' | 'GTIN-13' | 'GTIN-14';

/** Dígito verificador GS1 dos dígitos dados (sem o próprio dígito). */
export function gtinCheckDigit(digits: string): number {
  let sum = 0;
  const arr = digits.split('').map(Number);
  for (let i = arr.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += arr[i] * w;
  return (10 - (sum % 10)) % 10;
}

/** Classifica o código pela forma (só dígitos + comprimento da família). */
export function gtinKind(code: string): GtinKind | null {
  if (!/^\d+$/.test(code)) return null;
  switch (code.length) {
    case 8: return 'GTIN-8';
    case 12: return 'GTIN-12';
    case 13: return 'GTIN-13';
    case 14: return 'GTIN-14';
    default: return null;
  }
}

/** true quando é GTIN/EAN bem formado E o dígito verificador confere. */
export function isValidGtin(code: string): boolean {
  if (!gtinKind(code)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

/**
 * Mensagem de erro de cadastro para um valor de GTIN/EAN (ou null se serve).
 * Vazio é aceitável (nem todo produto tem código de barras de fábrica — o
 * SKU interno cobre a etiqueta). Valor presente precisa ser GTIN válido:
 * um código com o dígito errado biparia outro produto (ou nada) no caixa.
 */
export function erroGtin(valor: unknown): string | null {
  const s = String(valor ?? '').trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'Código de barras deve conter apenas dígitos.';
  if (!gtinKind(s)) return 'Informe 8, 12, 13 ou 14 dígitos (EAN-8, UPC-A, EAN-13 ou EAN-14).';
  if (!isValidGtin(s)) return 'Dígito verificador do código de barras inválido. Confira o código impresso na embalagem.';
  return null;
}
