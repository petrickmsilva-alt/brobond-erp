// ============================================================================
// EscPosRenderer — renderer térmico profissional ESC/POS (P2).
//
// Totalmente desacoplado do PrintIR: consome os blocos semânticos canônicos e
// gera bytes ESC/POS (Epson/Elgin/Bematech padrão) com:
//   • Inicialização (ESC @) + tabela CP850 (ESC t 2) para acentuação PT-BR;
//   • Sanitização estrita contra injeção de comandos ESC/GS/DLE (ex.: abertura
//     indevida de gaveta ESC p ou corte prematuro GS V);
//   • Alinhamento (ESC a), ênfase/negrito (ESC E), tamanhos (GS ! / ESC M);
//   • Tabelas com distribuição inteligente de largura e quebra multi-linha;
//   • Código de barras nativo GS k (EAN-13, EAN-8, UPC-A, Code128 Subset B);
//   • QR Code nativo GS ( k Model 2;
//   • Avanço de segurança + corte parcial de guilhotina (ESC d + GS V 66 0).
// ============================================================================

import { encodeCp850, resolveBarcodeStrict, stripControlChars } from './gtin.js';
import { PRINT_IR_VERSION, PrintError, type PrintAlign, type PrintBlock, type PrintIR, type Renderer } from './renderer.js';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const CMD_INIT = Buffer.from([ESC, 0x40]);
const CMD_CP850 = Buffer.from([ESC, 0x74, 0x02]);
const CMD_ALIGN_LEFT = Buffer.from([ESC, 0x61, 0x00]);
const CMD_ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const CMD_ALIGN_RIGHT = Buffer.from([ESC, 0x61, 0x02]);
const CMD_BOLD_ON = Buffer.from([ESC, 0x45, 0x01]);
const CMD_BOLD_OFF = Buffer.from([ESC, 0x45, 0x00]);
const CMD_FONT_A = Buffer.from([ESC, 0x4d, 0x00]);
const CMD_FONT_B = Buffer.from([ESC, 0x4d, 0x01]);
const CMD_SIZE_NORMAL = Buffer.from([GS, 0x21, 0x00]);
const CMD_SIZE_TALL = Buffer.from([GS, 0x21, 0x01]);   // 1x largura, 2x altura
const CMD_SIZE_DOUBLE = Buffer.from([GS, 0x21, 0x11]); // 2x largura, 2x altura
const CMD_FEED_AND_PARTIAL_CUT = Buffer.from([ESC, 0x64, 0x04, GS, 0x56, 0x42, 0x00]);

function alignCmd(align?: PrintAlign): Buffer {
  if (align === 'center') return CMD_ALIGN_CENTER;
  if (align === 'right') return CMD_ALIGN_RIGHT;
  return CMD_ALIGN_LEFT;
}

function wrapText(raw: string, maxCols: number): string[] {
  const width = Math.max(8, maxCols);
  const paragraphs = stripControlChars(raw, true).split('\n');
  const lines: string[] = [];
  for (const para of paragraphs) {
    const trimmed = para.trimEnd();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of trimmed.split(/\s+/)) {
      if (!word) continue;
      if (word.length > width) {
        if (current) {
          lines.push(current);
          current = '';
        }
        for (let i = 0; i < word.length; i += width) {
          const slice = word.slice(i, i + width);
          if (slice.length === width) lines.push(slice);
          else current = slice;
        }
      } else if (!current) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += ' ' + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

function padCell(text: string, width: number, align: PrintAlign = 'left'): string {
  const s = text.length > width ? text.slice(0, width) : text;
  const pad = width - s.length;
  if (pad <= 0) return s;
  if (align === 'right') return ' '.repeat(pad) + s;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + s + ' '.repeat(pad - left);
  }
  return s + ' '.repeat(pad);
}

function computeColumnWidths(
  columns: { header: string; align?: PrintAlign }[],
  rows: string[][],
  totalCols: number
): number[] {
  const n = columns.length;
  if (n === 1) return [totalCols];
  const gaps = n - 1;
  const usable = Math.max(n * 3, totalCols - gaps);

  const natural = columns.map((c, idx) => {
    let maxLen = stripControlChars(c.header).trim().length;
    for (const r of rows) {
      const len = stripControlChars(r[idx] ?? '').trim().length;
      if (len > maxLen) maxLen = len;
    }
    return Math.max(3, maxLen);
  });

  // Se todas as colunas cabem confortavelmente, distribui a sobra na 1ª coluna (descrição).
  const sumNatural = natural.reduce((a, b) => a + b, 0);
  if (sumNatural <= usable) {
    const widths = [...natural];
    widths[0] += usable - sumNatural;
    return widths;
  }

  // Reserva largura compacta para as colunas finais (qtd, unit, desc, subtotal)
  // e entrega o espaço restante para a 1ª coluna (item/descrição), que faz wrap.
  const widths = new Array<number>(n).fill(4);
  let reservedTail = 0;
  const maxTailCol = Math.max(5, Math.floor((usable * 0.68) / Math.max(1, n - 1)));
  for (let i = 1; i < n; i++) {
    widths[i] = Math.min(natural[i], Math.max(4, maxTailCol));
    reservedTail += widths[i];
  }
  const minFirst = Math.min(12, Math.max(6, Math.floor(usable * 0.28)));
  if (usable - reservedTail < minFirst) {
    // Aperta proporcionalmente as colunas finais se necessário
    const targetTail = Math.max(n - 1, usable - minFirst);
    const scale = targetTail / Math.max(1, reservedTail);
    reservedTail = 0;
    for (let i = 1; i < n; i++) {
      widths[i] = Math.max(3, Math.floor(widths[i] * scale));
      reservedTail += widths[i];
    }
  }
  widths[0] = Math.max(4, usable - reservedTail);
  return widths;
}

function buildBarcodeBytes(value: string, symbology?: string, caption?: string): Buffer {
  const resolved = resolveBarcodeStrict(value, symbology);
  const chunks: Buffer[] = [
    CMD_ALIGN_CENTER,
    Buffer.from([GS, 0x68, 64]), // altura 64 dots
    Buffer.from([GS, 0x77, 0x02]), // largura módulo 2
    Buffer.from([GS, 0x48, caption ? 0x00 : 0x02]), // HRI abaixo se não houver caption customizada
  ];

  if (resolved.symbology === 'ean13') {
    const data = Buffer.from(resolved.value, 'ascii');
    chunks.push(Buffer.from([GS, 0x6b, 67, data.length]), data, Buffer.from([LF]));
  } else if (resolved.symbology === 'ean8') {
    const data = Buffer.from(resolved.value, 'ascii');
    chunks.push(Buffer.from([GS, 0x6b, 68, data.length]), data, Buffer.from([LF]));
  } else if (resolved.symbology === 'upca') {
    const data = Buffer.from(resolved.value, 'ascii');
    chunks.push(Buffer.from([GS, 0x6b, 65, data.length]), data, Buffer.from([LF]));
  } else {
    // Code128 Subset B ({B = 0x7B 0x42); em Code128 '{' literal é escapado como '{{'
    const escaped = resolved.value.replace(/\{/g, '{{');
    const data = Buffer.concat([Buffer.from([0x7b, 0x42]), Buffer.from(escaped, 'ascii')]);
    if (data.length > 255) {
      throw new PrintError('IR_INVALID', 'Código de barras Code128 excede limite do comando ESC/POS.', false);
    }
    chunks.push(Buffer.from([GS, 0x6b, 73, data.length]), data, Buffer.from([LF]));
  }

  if (caption) {
    const capClean = stripControlChars(caption).trim();
    if (capClean) {
      chunks.push(CMD_FONT_B, encodeCp850(capClean), Buffer.from([LF]), CMD_FONT_A);
    }
  }
  chunks.push(CMD_ALIGN_LEFT);
  return Buffer.concat(chunks);
}

function buildQrCodeBytes(value: string, caption?: string): Buffer {
  const clean = stripControlChars(value).trim();
  if (!clean) throw new PrintError('IR_INVALID', 'QR Code vazio.', false);
  const data = Buffer.from(clean, 'utf8');
  if (data.length > 700) {
    throw new PrintError('IR_INVALID', 'Conteúdo do QR Code excede 700 bytes para impressão térmica.', false);
  }
  const storeLen = data.length + 3;
  const pL = storeLen & 0xff;
  const pH = (storeLen >> 8) & 0xff;

  const chunks: Buffer[] = [
    CMD_ALIGN_CENTER,
    // 1. Model 2
    Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    // 2. Module size 5
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x05]),
    // 3. Error correction level M (49 = 0x31)
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
    // 4. Store symbol data
    Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    data,
    // 5. Print QR Code
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
    Buffer.from([LF]),
  ];

  if (caption) {
    const capClean = stripControlChars(caption).trim();
    if (capClean) {
      chunks.push(CMD_FONT_B, encodeCp850(capClean), Buffer.from([LF]), CMD_FONT_A);
    }
  }
  chunks.push(CMD_ALIGN_LEFT);
  return Buffer.concat(chunks);
}

export class EscPosRenderer implements Renderer {
  readonly id = 'escpos';

  constructor(private readonly defaultCols = 48) {}

  async render(ir: PrintIR): Promise<Buffer> {
    if (ir.version !== PRINT_IR_VERSION) {
      throw new PrintError('IR_VERSION', `Versão PrintIR não suportada: ${ir.version}`, false);
    }
    const metaCols = Number(ir.metadata?.widthCols);
    const cols = metaCols === 32 || metaCols === 42 || metaCols === 48 ? metaCols : this.defaultCols;

    const output: Buffer[] = [CMD_INIT, CMD_CP850];
    let sectionChunks: Buffer[] = [];
    let hasFinalCut = false;

    const flushSection = (repeat = 1, withCut = false) => {
      const count = Math.max(1, Math.min(200, Math.trunc(repeat)));
      if (sectionChunks.length === 0 && !withCut) return;
      const body = Buffer.concat(sectionChunks);
      for (let r = 0; r < count; r++) {
        if (body.length > 0) output.push(body);
        if (withCut) output.push(CMD_FEED_AND_PARTIAL_CUT);
      }
      sectionChunks = [];
    };

    for (const b of ir.content) {
      if (b.kind === 'cut') {
        hasFinalCut = true;
        flushSection(b.repeat ?? 1, true);
        continue;
      }
      hasFinalCut = false;
      sectionChunks.push(this.renderBlock(b, cols));
    }

    if (sectionChunks.length > 0) {
      flushSection(1, false);
    }
    if (!hasFinalCut) {
      output.push(CMD_FEED_AND_PARTIAL_CUT);
    }

    return Buffer.concat(output);
  }

  private renderBlock(b: PrintBlock, cols: number): Buffer {
    switch (b.kind) {
      case 'text': {
        const chunks: Buffer[] = [alignCmd(b.align)];
        const isBold = b.emphasis === 'bold' || b.emphasis === 'title';
        let effectiveCols = cols;
        if (b.size === 'large') {
          chunks.push(CMD_FONT_A, CMD_SIZE_DOUBLE);
          effectiveCols = Math.max(12, Math.floor(cols / 2));
        } else if (b.emphasis === 'title') {
          chunks.push(CMD_FONT_A, CMD_SIZE_TALL);
        } else if (b.size === 'small') {
          chunks.push(CMD_FONT_B, CMD_SIZE_NORMAL);
        } else {
          chunks.push(CMD_FONT_A, CMD_SIZE_NORMAL);
        }
        if (isBold) chunks.push(CMD_BOLD_ON);
        for (const line of wrapText(b.text, effectiveCols)) {
          chunks.push(encodeCp850(line), Buffer.from([LF]));
        }
        if (isBold) chunks.push(CMD_BOLD_OFF);
        chunks.push(CMD_FONT_A, CMD_SIZE_NORMAL, CMD_ALIGN_LEFT);
        return Buffer.concat(chunks);
      }

      case 'kv': {
        const label = stripControlChars(b.label).trim();
        const val = stripControlChars(b.value).trim();
        const minGap = 1;
        if (label.length + minGap + val.length <= cols) {
          const line = label + ' '.repeat(cols - label.length - val.length) + val;
          return Buffer.concat([CMD_ALIGN_LEFT, encodeCp850(line), Buffer.from([LF])]);
        }
        // Quando label + valor ultrapassa a largura, quebra o label e alinha o valor à direita.
        const chunks: Buffer[] = [CMD_ALIGN_LEFT];
        for (const l of wrapText(`${label}:`, cols)) {
          chunks.push(encodeCp850(l), Buffer.from([LF]));
        }
        chunks.push(CMD_ALIGN_RIGHT, encodeCp850(val), Buffer.from([LF]), CMD_ALIGN_LEFT);
        return Buffer.concat(chunks);
      }

      case 'separator':
        return Buffer.concat([CMD_ALIGN_LEFT, encodeCp850('-'.repeat(cols)), Buffer.from([LF])]);

      case 'spacer': {
        const n = Math.max(0, Math.min(20, b.lines ?? 1));
        return n > 0 ? Buffer.alloc(n, LF) : Buffer.alloc(0);
      }

      case 'table': {
        const widths = computeColumnWidths(b.columns, b.rows, cols);
        const chunks: Buffer[] = [CMD_ALIGN_LEFT, CMD_BOLD_ON];
        const headerLine = b.columns
          .map((c, i) => padCell(stripControlChars(c.header).trim(), widths[i], c.align ?? 'left'))
          .join(' ');
        chunks.push(encodeCp850(headerLine), Buffer.from([LF]), CMD_BOLD_OFF);
        chunks.push(encodeCp850('-'.repeat(cols)), Buffer.from([LF]));

        for (const row of b.rows) {
          const wrappedCells = b.columns.map((_, i) => wrapText(stripControlChars(row[i] ?? '').trim(), widths[i]));
          const maxLines = Math.max(1, ...wrappedCells.map((w) => w.length));
          for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
            const line = b.columns
              .map((c, colIdx) => {
                // Valores numéricos alinhados à direita aparecem na 1ª linha do item
                const cellPart = wrappedCells[colIdx][lineIdx] ?? '';
                return padCell(cellPart, widths[colIdx], c.align ?? 'left');
              })
              .join(' ');
            chunks.push(encodeCp850(line), Buffer.from([LF]));
          }
        }
        return Buffer.concat(chunks);
      }

      case 'barcode':
        return buildBarcodeBytes(b.value, b.symbology, b.caption);

      case 'qrcode':
        return buildQrCodeBytes(b.value, b.caption);

      case 'cut':
        return CMD_FEED_AND_PARTIAL_CUT;
    }
  }
}
