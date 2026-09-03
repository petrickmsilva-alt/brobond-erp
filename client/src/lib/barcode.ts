// Geração de códigos de barras em SVG, sem dependências.
//   • EAN-13 / EAN-8 (quando o produto tem código de barras válido)
//   • Code 128 (subconjunto B) para qualquer texto — ex.: SKU interno

// ---------------------------------------------------------------- EAN
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function eanCheckDigit(digits: string): number {
  let sum = 0;
  const arr = digits.split('').map(Number);
  // pesos 3/1 a partir da direita
  for (let i = arr.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += arr[i] * w;
  return (10 - (sum % 10)) % 10;
}

export function isValidEan(code: string): boolean {
  if (!/^\d{8}$|^\d{13}$/.test(code)) return false;
  return eanCheckDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

function eanPattern(code: string): string {
  if (code.length === 13) {
    const first = Number(code[0]);
    const par = PARITY[first];
    let bits = '101';
    for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? L : G)[Number(code[i])];
    bits += '01010';
    for (let i = 7; i <= 12; i++) bits += R[Number(code[i])];
    return bits + '101';
  }
  // EAN-8
  let bits = '101';
  for (let i = 0; i < 4; i++) bits += L[Number(code[i])];
  bits += '01010';
  for (let i = 4; i < 8; i++) bits += R[Number(code[i])];
  return bits + '101';
}

// ---------------------------------------------------------------- Code 128 B
const C128 = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000', '11010011100', '1100011101011',
];
const START_B = 104;
const STOP = 106;

function code128Pattern(text: string): string {
  const clean = text.replace(/[^\x20-\x7e]/g, '?');
  let sum = START_B;
  let bits = C128[START_B];
  for (let i = 0; i < clean.length; i++) {
    const v = clean.charCodeAt(i) - 32;
    sum += v * (i + 1);
    bits += C128[v];
  }
  bits += C128[sum % 103];
  bits += C128[STOP];
  return bits;
}

// ---------------------------------------------------------------- SVG
export type BarcodeOpts = { height?: number; module?: number; text?: boolean; fontSize?: number };

function bitsToSvg(bits: string, human: string, o: BarcodeOpts): string {
  const module = o.module ?? 1.2;
  const height = o.height ?? 36;
  const fontSize = o.fontSize ?? 9;
  const quiet = 8 * module;
  const width = bits.length * module + quiet * 2;
  const textH = o.text === false ? 0 : fontSize + 3;
  let rects = '';
  let x = quiet;
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === '1') {
      let j = i;
      while (j < bits.length && bits[j] === '1') j++;
      rects += `<rect x="${x.toFixed(2)}" y="0" width="${((j - i) * module).toFixed(2)}" height="${height}"/>`;
      x += (j - i) * module;
      i = j;
    } else {
      x += module;
      i++;
    }
  }
  const label = o.text === false ? '' : `<text x="${(width / 2).toFixed(2)}" y="${height + fontSize + 1}" font-family="ui-monospace, Menlo, monospace" font-size="${fontSize}" text-anchor="middle" letter-spacing="1">${escapeXml(human)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height + textH}" width="${width.toFixed(0)}" height="${height + textH}" shape-rendering="crispEdges" fill="#000">${rects}${label}</svg>`;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** SVG de um código de barras. Usa EAN se `code` for EAN válido; senão Code 128. */
export function barcodeSvg(code: string, o: BarcodeOpts = {}): { svg: string; kind: 'EAN-13' | 'EAN-8' | 'CODE128' } {
  const c = code.trim();
  if (isValidEan(c)) {
    return { svg: bitsToSvg(eanPattern(c), c, o), kind: c.length === 13 ? 'EAN-13' : 'EAN-8' };
  }
  return { svg: bitsToSvg(code128Pattern(c), c, o), kind: 'CODE128' };
}
