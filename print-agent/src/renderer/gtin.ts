// ============================================================================
// Utilitários puros e zero-dependência para renderers físicos:
//   1. Sanitização estrita de caracteres de controle (anti-command-injection).
//   2. Codificação determinística CP850 (português acentuado em térmicas).
//   3. Validação matemática GS1 de EAN-8, UPC-A, EAN-13 e GTIN-14 — NUNCA
//      recalcula nem falsifica dígito verificador inválido.
// ============================================================================

import { PrintError } from './renderer.js';

/** Remove todos os bytes de controle ASCII (0x00..0x1F e 0x7F). */
export function stripControlChars(input: string, allowNewline = false): string {
  if (!input) return '';
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (allowNewline && code === 0x0a) {
      out += '\n';
    } else if (code === 0x09 || code === 0x0a) {
      out += ' ';
    } else if (code < 0x20 || code === 0x7f) {
      continue;
    } else {
      out += normalized[i];
    }
  }
  return out;
}

// Mapa Unicode -> byte único Code Page 850 (Multilingual Latin-1)
const CP850_MAP: Record<number, number> = {
  0x00c7: 0x80, // Ç
  0x00fc: 0x81, // ü
  0x00e9: 0x82, // é
  0x00e2: 0x83, // â
  0x00e4: 0x84, // ä
  0x00e0: 0x85, // à
  0x00e5: 0x86, // å
  0x00e7: 0x87, // ç
  0x00ea: 0x88, // ê
  0x00eb: 0x89, // ë
  0x00e8: 0x8a, // è
  0x00ef: 0x8b, // ï
  0x00ee: 0x8c, // î
  0x00ec: 0x8d, // ì
  0x00c4: 0x8e, // Ä
  0x00c5: 0x8f, // Å
  0x00c9: 0x90, // É
  0x00f4: 0x93, // ô
  0x00f6: 0x94, // ö
  0x00f2: 0x95, // ò
  0x00fb: 0x96, // û
  0x00f9: 0x97, // ù
  0x00ff: 0x98, // ÿ
  0x00d6: 0x99, // Ö
  0x00dc: 0x9a, // Ü
  0x00f8: 0x9b, // ø
  0x00a3: 0x9c, // £
  0x00d8: 0x9d, // Ø
  0x00d7: 0x9e, // ×
  0x00e1: 0xa0, // á
  0x00ed: 0xa1, // í
  0x00f3: 0xa2, // ó
  0x00fa: 0xa3, // ú
  0x00f1: 0xa4, // ñ
  0x00d1: 0xa5, // Ñ
  0x00aa: 0xa6, // ª
  0x00ba: 0xa7, // º
  0x00bf: 0xa8, // ¿
  0x00ae: 0xa9, // ®
  0x00ac: 0xaa, // ¬
  0x00bd: 0xab, // ½
  0x00bc: 0xac, // ¼
  0x00a1: 0xad, // ¡
  0x00ab: 0xae, // «
  0x00bb: 0xaf, // »
  0x00c1: 0xb5, // Á
  0x00c2: 0xb6, // Â
  0x00c0: 0xb7, // À
  0x00a9: 0xb8, // ©
  0x00a2: 0xbd, // ¢
  0x00a5: 0xbe, // ¥
  0x00e3: 0xc6, // ã
  0x00c3: 0xc7, // Ã
  0x00ca: 0xd2, // Ê
  0x00cb: 0xd3, // Ë
  0x00c8: 0xd4, // È
  0x00cd: 0xd6, // Í
  0x00ce: 0xd7, // Î
  0x00cf: 0xd8, // Ï
  0x00cc: 0xde, // Ì
  0x00d3: 0xe0, // Ó
  0x00df: 0xe1, // ß
  0x00d4: 0xe2, // Ô
  0x00d2: 0xe3, // Ò
  0x00f5: 0xe4, // õ
  0x00d5: 0xe5, // Õ
  0x00b5: 0xe6, // µ
  0x00da: 0xe9, // Ú
  0x00db: 0xea, // Û
  0x00d9: 0xeb, // Ù
  0x00fd: 0xec, // ý
  0x00dd: 0xed, // Ý
  0x00b0: 0xf8, // °
  0x00a8: 0xf9, // ¨
  0x00b7: 0xfa, // ·
  0x00b9: 0xfb, // ¹
  0x00b3: 0xfc, // ³
  0x00b2: 0xfd, // ²
};

const ASCII_TRANSLIT: Record<string, string> = {
  '•': '*',
  '–': '-',
  '—': '-',
  '―': '-',
  '“': '"',
  '”': '"',
  '„': '"',
  '‘': "'",
  '’': "'",
  '…': '...',
  '€': 'EUR',
  '→': '->',
  '←': '<-',
};

/** Converte texto sanitizado para bytes CP850 sem emitir comandos de controle. */
export function encodeCp850(raw: string, allowNewline = false): Buffer {
  const clean = stripControlChars(raw, allowNewline);
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (allowNewline && ch === '\n') {
      bytes.push(0x0a);
      continue;
    }
    const translit = ASCII_TRANSLIT[ch];
    if (translit) {
      for (let j = 0; j < translit.length; j++) bytes.push(translit.charCodeAt(j) & 0x7f);
      continue;
    }
    const code = ch.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
    } else if (CP850_MAP[code] !== undefined) {
      bytes.push(CP850_MAP[code]);
    } else {
      bytes.push(0x3f); // '?'
    }
  }
  return Buffer.from(bytes);
}

export type GtinSymbology = 'ean8' | 'upca' | 'ean13' | 'gtin14';

export function calcularDigitoGs1(semDigito: string): number {
  let soma = 0;
  for (let i = semDigito.length - 1, pos = 0; i >= 0; i--, pos++) {
    const d = semDigito.charCodeAt(i) - 48;
    soma += d * (pos % 2 === 0 ? 3 : 1);
  }
  return (10 - (soma % 10)) % 10;
}

/**
 * Valida estritamente EAN-8 (8), UPC-A (12), EAN-13 (13) ou GTIN-14 (14).
 * NUNCA corrige ou inventa dígito verificador: dígito errado = inválido.
 */
export function validateGtinStrict(
  raw: string
): { ok: true; symbology: GtinSymbology; digits: string } | { ok: false; reason: string } {
  const digits = String(raw ?? '').trim();
  if (!/^\d+$/.test(digits)) {
    return { ok: false, reason: 'Código GTIN/EAN deve conter apenas dígitos.' };
  }
  const mapLen: Record<number, GtinSymbology> = {
    8: 'ean8',
    12: 'upca',
    13: 'ean13',
    14: 'gtin14',
  };
  const symbology = mapLen[digits.length];
  if (!symbology) {
    return { ok: false, reason: `Comprimento ${digits.length} inválido para GTIN (esperado 8, 12, 13 ou 14).` };
  }
  if (/^0+$/.test(digits)) {
    return { ok: false, reason: 'Código GTIN/EAN todo zerado é inválido.' };
  }
  const esperado = calcularDigitoGs1(digits.slice(0, -1));
  const informado = digits.charCodeAt(digits.length - 1) - 48;
  if (esperado !== informado) {
    return { ok: false, reason: `Dígito verificador GS1 inválido para "${digits}".` };
  }
  return { ok: true, symbology, digits };
}

export type ResolvedBarcode = {
  symbology: GtinSymbology | 'code128';
  value: string;
};

/**
 * Resolve e valida o código de barras do bloco PrintIR.
 * - Se simbologia GTIN foi pedida explicitamente e o código é inválido -> erro permanente INVALID_EAN.
 * - Se `auto` (ou omitido) e o valor tem 8/12/13/14 dígitos numéricos:
 *     • dígito GS1 válido -> usa a simbologia GTIN correspondente;
 *     • dígito GS1 INVÁLIDO -> lança INVALID_EAN (jamais falsifica nem mascara EAN corrompido).
 * - Caso contrário (SKU alfanumérico ou código interno de outro tamanho) -> Code128 ASCII imprimível.
 */
export function resolveBarcodeStrict(rawValue: string, requested?: string): ResolvedBarcode {
  const clean = stripControlChars(String(rawValue ?? '')).trim();
  if (!clean || clean.length > 80) {
    throw new PrintError('IR_INVALID', 'Código de barras vazio ou acima de 80 caracteres.', false);
  }
  const sym = (requested || 'auto').toLowerCase();

  if (sym === 'ean8' || sym === 'upca' || sym === 'ean13' || sym === 'gtin14') {
    const v = validateGtinStrict(clean);
    if (!v.ok) {
      throw new PrintError('INVALID_EAN', v.reason, false);
    }
    if (v.symbology !== sym) {
      throw new PrintError('INVALID_EAN', `Simbologia ${sym} incompatível com código ${v.symbology} (${clean}).`, false);
    }
    return { symbology: v.symbology, value: v.digits };
  }

  if (sym === 'auto') {
    if (/^\d+$/.test(clean) && (clean.length === 8 || clean.length === 12 || clean.length === 13 || clean.length === 14)) {
      const v = validateGtinStrict(clean);
      if (!v.ok) {
        throw new PrintError('INVALID_EAN', v.reason, false);
      }
      return { symbology: v.symbology, value: v.digits };
    }
  } else if (sym !== 'code128') {
    throw new PrintError('RENDER_UNSUPPORTED', `Simbologia de código de barras não suportada: "${sym}".`, false);
  }

  // Code128 Subset B aceita ASCII imprimível 0x20..0x7E
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new PrintError('IR_INVALID', `Caractere não suportado em Code128 na posição ${i + 1}.`, false);
    }
  }
  return { symbology: 'code128', value: clean };
}
