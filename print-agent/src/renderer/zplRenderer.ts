// ============================================================================
// ZplRenderer — renderer térmico profissional ZPL II para etiquetas (P4).
//
// Gera ZPL II determinístico (^XA ... ^XZ) com UTF-8 (^CI28) e escape
// hexadecimal (^FH\) contra command injection (^XZ, ~SD, ^JUF etc.).
// Valida estritamente EAN-8, UPC-A, EAN-13 e GTIN-14 antes de emitir os
// comandos de código de barras — jamais falsifica dígito verificador.
// ============================================================================

import { resolveBarcodeStrict, stripControlChars } from './gtin.js';
import { PRINT_IR_VERSION, PrintError, type PrintAlign, type PrintBlock, type PrintIR, type Renderer } from './renderer.js';

/**
 * Escapa texto de usuário para uso em campo `^FH\^FD...^FS` no ZPL II:
 * 1. Remove qualquer caractere de controle ASCII (0x00..0x1F, 0x7F);
 * 2. Converte `\`, `^` e `~` em sequências hexadecimais `\5C`, `\5E`, `\7E`
 *    impedindo que dados de produto/cliente injetem comandos ZPL.
 */
export function escapeZplField(raw: string): string {
  const clean = stripControlChars(raw, false);
  let out = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '\\') out += '\\5C';
    else if (ch === '^') out += '\\5E';
    else if (ch === '~') out += '\\7E';
    else out += ch;
  }
  return out;
}

type LabelPage = {
  blocks: PrintBlock[];
  repeat: number;
};

function splitPages(blocks: PrintBlock[]): LabelPage[] {
  const pages: LabelPage[] = [];
  let current: PrintBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'cut') {
      if (current.length > 0) {
        pages.push({ blocks: current, repeat: Math.max(1, Math.min(200, b.repeat ?? 1)) });
        current = [];
      }
      continue;
    }
    current.push(b);
  }
  if (current.length > 0) {
    pages.push({ blocks: current, repeat: 1 });
  }
  return pages;
}

function zplAlign(align?: PrintAlign): 'L' | 'C' | 'R' {
  if (align === 'center') return 'C';
  if (align === 'right') return 'R';
  return 'L';
}

export class ZplRenderer implements Renderer {
  readonly id = 'zpl';

  async render(ir: PrintIR): Promise<Buffer> {
    if (ir.version !== PRINT_IR_VERSION) {
      throw new PrintError('IR_VERSION', `Versão PrintIR não suportada: ${ir.version}`, false);
    }

    const dpi = Number(ir.metadata?.dpi) === 300 ? 300 : 203;
    const dotsPerMm = dpi === 300 ? 12 : 8;
    const widthMm = Math.max(25, Math.min(150, Number(ir.metadata?.labelWidthMm) || 50));
    const heightMm = Math.max(15, Math.min(200, Number(ir.metadata?.labelHeightMm) || 30));

    const widthDots = Math.round(widthMm * dotsPerMm);
    const heightDots = Math.round(heightMm * dotsPerMm);
    const marginX = Math.round(2 * dotsPerMm);
    const contentWidth = Math.max(80, widthDots - marginX * 2);

    const pages = splitPages(ir.content);
    if (pages.length === 0) {
      throw new PrintError('IR_INVALID', 'Nenhum conteúdo de etiqueta para renderizar em ZPL.', false);
    }

    const labelsZpl: string[] = [];
    for (const page of pages) {
      labelsZpl.push(this.renderPage(page, widthDots, heightDots, marginX, contentWidth, dotsPerMm));
    }

    return Buffer.from(labelsZpl.join('\n') + '\n', 'utf8');
  }

  private renderPage(
    page: LabelPage,
    widthDots: number,
    heightDots: number,
    marginX: number,
    contentWidth: number,
    dotsPerMm: number
  ): string {
    const scale = dotsPerMm / 8; // 1.0 @ 203dpi, 1.5 @ 300dpi
    const lines: string[] = [
      '^XA',
      '^CI28',
      `^PW${widthDots}`,
      `^LL${heightDots}`,
      '^LH0,0',
    ];

    let y = Math.round(12 * scale);
    const compact = heightDots <= Math.round(260 * scale);

    for (const b of page.blocks) {
      switch (b.kind) {
        case 'text': {
          const text = escapeZplField(b.text.trim());
          if (!text) break;
          let fontH = Math.round((compact ? 20 : 24) * scale);
          let fontW = Math.round((compact ? 18 : 22) * scale);
          let maxLines = 2;
          if (b.size === 'small') {
            fontH = Math.round(16 * scale);
            fontW = Math.round(15 * scale);
            maxLines = 1;
          } else if (b.size === 'large') {
            fontH = Math.round((compact ? 28 : 34) * scale);
            fontW = Math.round((compact ? 26 : 32) * scale);
            maxLines = 1;
          } else if (b.emphasis === 'title') {
            fontH = Math.round((compact ? 22 : 28) * scale);
            fontW = Math.round((compact ? 20 : 26) * scale);
            maxLines = 2;
          }
          const align = zplAlign(b.align);
          lines.push(`^FO${marginX},${y}^A0N,${fontH},${fontW}^FB${contentWidth},${maxLines},0,${align},0^FH\\^FD${text}^FS`);
          const estCharsPerLine = Math.max(10, Math.floor(contentWidth / Math.max(8, fontW * 0.6)));
          const usedLines = Math.min(maxLines, Math.max(1, Math.ceil(b.text.trim().length / estCharsPerLine)));
          y += usedLines * (fontH + Math.round(4 * scale));
          break;
        }

        case 'kv': {
          const kvText = escapeZplField(`${b.label.trim()}: ${b.value.trim()}`);
          const fontH = Math.round((compact ? 17 : 20) * scale);
          const fontW = Math.round((compact ? 16 : 18) * scale);
          lines.push(`^FO${marginX},${y}^A0N,${fontH},${fontW}^FB${contentWidth},1,0,L,0^FH\\^FD${kvText}^FS`);
          y += fontH + Math.round(4 * scale);
          break;
        }

        case 'separator': {
          lines.push(`^FO${marginX},${y}^GB${contentWidth},2,2^FS`);
          y += Math.round(6 * scale);
          break;
        }

        case 'spacer': {
          const n = Math.max(0, Math.min(20, b.lines ?? 1));
          y += n * Math.round(10 * scale);
          break;
        }

        case 'table': {
          const fontH = Math.round(16 * scale);
          const fontW = Math.round(15 * scale);
          const header = escapeZplField(b.columns.map((c) => c.header.trim()).join(' | '));
          lines.push(`^FO${marginX},${y}^A0N,${fontH},${fontW}^FB${contentWidth},1,0,L,0^FH\\^FD${header}^FS`);
          y += fontH + Math.round(3 * scale);
          for (const r of b.rows) {
            const rowTxt = escapeZplField(r.map((c) => c.trim()).join(' | '));
            lines.push(`^FO${marginX},${y}^A0N,${fontH},${fontW}^FB${contentWidth},1,0,L,0^FH\\^FD${rowTxt}^FS`);
            y += fontH + Math.round(3 * scale);
          }
          break;
        }

        case 'barcode': {
          const resolved = resolveBarcodeStrict(b.value, b.symbology);
          const barH = Math.round((compact ? 48 : 68) * scale);
          const moduleW = resolved.value.length > 16 ? Math.max(1, Math.round(1.5 * scale)) : Math.round(2 * scale);
          // Centraliza aproximadamente o código de barras na largura útil
          const approxModules = resolved.symbology === 'code128' ? resolved.value.length * 11 + 35 : 95;
          const approxWidth = approxModules * moduleW;
          const barX = Math.max(marginX, Math.round((widthDots - approxWidth) / 2));

          lines.push(`^BY${moduleW},2,${barH}`);
          if (resolved.symbology === 'ean13') {
            lines.push(`^FO${barX},${y}^BEN,${barH},Y,N^FD${resolved.value}^FS`);
          } else if (resolved.symbology === 'ean8') {
            lines.push(`^FO${barX},${y}^B8N,${barH},Y,N^FD${resolved.value}^FS`);
          } else if (resolved.symbology === 'upca') {
            lines.push(`^FO${barX},${y}^BUN,${barH},Y,N^FD${resolved.value}^FS`);
          } else {
            const escapedCode = escapeZplField(resolved.value);
            lines.push(`^FO${barX},${y}^BCN,${barH},Y,N,N^FH\\^FD${escapedCode}^FS`);
          }
          y += barH + Math.round(22 * scale);
          if (b.caption && b.caption.trim() && b.caption.trim() !== resolved.value) {
            const cap = escapeZplField(b.caption.trim());
            const capH = Math.round(15 * scale);
            lines.push(`^FO${marginX},${y}^A0N,${capH},${capH}^FB${contentWidth},1,0,C,0^FH\\^FD${cap}^FS`);
            y += capH + Math.round(4 * scale);
          }
          break;
        }

        case 'qrcode': {
          const clean = stripControlChars(b.value).trim();
          if (!clean) throw new PrintError('IR_INVALID', 'QR Code vazio.', false);
          const escaped = escapeZplField(clean);
          const mag = Math.max(3, Math.round(4 * scale));
          lines.push(`^FO${marginX},${y}^BQN,2,${mag}^FH\\^FDMA,${escaped}^FS`);
          y += Math.round(90 * scale);
          if (b.caption && b.caption.trim()) {
            const cap = escapeZplField(b.caption.trim());
            const capH = Math.round(15 * scale);
            lines.push(`^FO${marginX},${y}^A0N,${capH},${capH}^FB${contentWidth},1,0,C,0^FH\\^FD${cap}^FS`);
            y += capH + Math.round(4 * scale);
          }
          break;
        }

        case 'cut':
          break;
      }
    }

    lines.push(`^PQ${page.repeat},0,1,Y`);
    lines.push('^XZ');
    return lines.join('\n');
  }
}
