// ============================================================================
// Epl2Renderer — renderer térmico profissional EPL2 para etiquetas (P4).
//
// Compatível com impressoras de etiquetas EPL2 (Elgin L42, Zebra TLP2844,
// GC420t modo EPL, Argox compatível):
//   • Codificação CP850 (`I8,A,001`) para acentuação PT-BR;
//   • Escape rigoroso de `\` e `"` e remoção total de `\r`/`\n`/controles
//     (neutraliza injeção de comandos EPL2 como `FK"*"`);
//   • Validação estrita de EAN-8, UPC-A, EAN-13 e GTIN-14 antes de emitir
//     comando `B` — jamais falsifica dígito verificador.
// ============================================================================

import { encodeCp850, resolveBarcodeStrict, stripControlChars } from './gtin.js';
import { PRINT_IR_VERSION, PrintError, type PrintAlign, type PrintBlock, type PrintIR, type Renderer } from './renderer.js';

/**
 * Sanitiza e escapa string para argumento `"..."` do EPL2 em bytes CP850:
 * remove 100% dos controles (incluindo CR/LF) e escapa `\` e `"`.
 */
export function escapeEpl2FieldBytes(raw: string): Buffer {
  const clean = stripControlChars(raw, false);
  const escaped = clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return encodeCp850(escaped, false);
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

function calcX(
  textLen: number,
  charWidthDots: number,
  align: PrintAlign | undefined,
  marginX: number,
  widthDots: number
): number {
  const textWidth = textLen * charWidthDots;
  const usable = widthDots - marginX * 2;
  if (align === 'right') {
    return Math.max(marginX, widthDots - marginX - textWidth);
  }
  if (align === 'center') {
    return Math.max(marginX, marginX + Math.floor((usable - textWidth) / 2));
  }
  return marginX;
}

export class Epl2Renderer implements Renderer {
  readonly id = 'epl2';

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
    const gapDots = Math.round(3 * dotsPerMm);
    const marginX = Math.round(2 * dotsPerMm);

    const pages = splitPages(ir.content);
    if (pages.length === 0) {
      throw new PrintError('IR_INVALID', 'Nenhum conteúdo de etiqueta para renderizar em EPL2.', false);
    }

    const chunks: Buffer[] = [];
    for (const page of pages) {
      chunks.push(this.renderPage(page, widthDots, heightDots, gapDots, marginX, dotsPerMm));
    }
    return Buffer.concat(chunks);
  }

  private renderPage(
    page: LabelPage,
    widthDots: number,
    heightDots: number,
    gapDots: number,
    marginX: number,
    dotsPerMm: number
  ): Buffer {
    const scale = dotsPerMm / 8;
    const compact = heightDots <= Math.round(260 * scale);
    const out: Buffer[] = [
      Buffer.from(`\nN\nI8,A,001\nq${widthDots}\nQ${heightDots},${gapDots}\n`, 'ascii'),
    ];

    const pushTextLine = (raw: string, font: number, hMul: number, vMul: number, align?: PrintAlign, yPos = 0): number => {
      // Largura base aproximada das fontes internas EPL2 (1=8, 2=10, 3=12, 4=14 dots)
      const baseW = font === 1 ? 8 : font === 2 ? 10 : font === 3 ? 12 : 14;
      const baseH = font === 1 ? 12 : font === 2 ? 16 : font === 3 ? 20 : 24;
      const charW = baseW * hMul;
      const maxChars = Math.max(8, Math.floor((widthDots - marginX * 2) / charW));
      const clean = stripControlChars(raw, false).trim();
      const clipped = clean.length > maxChars ? clean.slice(0, maxChars) : clean;
      const x = calcX(clipped.length, charW, align, marginX, widthDots);
      out.push(
        Buffer.from(`A${x},${yPos},0,${font},${hMul},${vMul},N,"`, 'ascii'),
        escapeEpl2FieldBytes(clipped),
        Buffer.from('"\n', 'ascii')
      );
      return baseH * vMul + Math.round(4 * scale);
    };

    let y = Math.round(12 * scale);

    for (const b of page.blocks) {
      switch (b.kind) {
        case 'text': {
          if (!stripControlChars(b.text).trim()) break;
          if (b.size === 'small') {
            y += pushTextLine(b.text, 1, 1, 1, b.align, y);
          } else if (b.size === 'large') {
            y += pushTextLine(b.text, compact ? 3 : 4, 1, compact ? 1 : 2, b.align, y);
          } else if (b.emphasis === 'title') {
            y += pushTextLine(b.text, 3, 1, 1, b.align, y);
          } else {
            y += pushTextLine(b.text, 2, 1, 1, b.align, y);
          }
          break;
        }

        case 'kv': {
          y += pushTextLine(`${b.label.trim()}: ${b.value.trim()}`, compact ? 1 : 2, 1, 1, 'left', y);
          break;
        }

        case 'separator': {
          const lineW = Math.max(40, widthDots - marginX * 2);
          out.push(Buffer.from(`LO${marginX},${y},${lineW},2\n`, 'ascii'));
          y += Math.round(6 * scale);
          break;
        }

        case 'spacer': {
          const n = Math.max(0, Math.min(20, b.lines ?? 1));
          y += n * Math.round(10 * scale);
          break;
        }

        case 'table': {
          y += pushTextLine(b.columns.map((c) => c.header.trim()).join(' | '), 1, 1, 1, 'left', y);
          for (const r of b.rows) {
            y += pushTextLine(r.map((c) => c.trim()).join(' | '), 1, 1, 1, 'left', y);
          }
          break;
        }

        case 'barcode': {
          const resolved = resolveBarcodeStrict(b.value, b.symbology);
          const barH = Math.round((compact ? 46 : 64) * scale);
          let eplSym = '1'; // Code128 auto
          if (resolved.symbology === 'ean13') eplSym = 'E30';
          else if (resolved.symbology === 'ean8') eplSym = 'E80';
          else if (resolved.symbology === 'upca') eplSym = 'UA0';

          const narrow = resolved.value.length > 16 ? 1 : 2;
          const wide = narrow * 2;
          const approxWidth = (resolved.symbology === 'code128' ? resolved.value.length * 11 + 35 : 95) * narrow;
          const barX = Math.max(marginX, Math.round((widthDots - approxWidth) / 2));

          out.push(
            Buffer.from(`B${barX},${y},0,${eplSym},${narrow},${wide},${barH},B,"`, 'ascii'),
            escapeEpl2FieldBytes(resolved.value),
            Buffer.from('"\n', 'ascii')
          );
          y += barH + Math.round(22 * scale);
          if (b.caption && b.caption.trim() && b.caption.trim() !== resolved.value) {
            y += pushTextLine(b.caption.trim(), 1, 1, 1, 'center', y);
          }
          break;
        }

        case 'qrcode': {
          const clean = stripControlChars(b.value).trim();
          if (!clean) throw new PrintError('IR_INVALID', 'QR Code vazio.', false);
          // EPL2 clássico usa comando b (2D) em modelos compatíveis ou imprime referência legível segura:
          out.push(
            Buffer.from(`b${marginX},${y},Q,m2,s4,"`, 'ascii'),
            escapeEpl2FieldBytes(clean),
            Buffer.from('"\n', 'ascii')
          );
          y += Math.round(80 * scale);
          if (b.caption && b.caption.trim()) {
            y += pushTextLine(b.caption.trim(), 1, 1, 1, 'center', y);
          }
          break;
        }

        case 'cut':
          break;
      }
    }

    out.push(Buffer.from(`P${page.repeat}\n`, 'ascii'));
    return Buffer.concat(out);
  }
}
