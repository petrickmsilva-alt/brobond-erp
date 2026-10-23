// ============================================================================
// Renderers: PrintIR → bytes/páginas para uma família de impressora.
//
// O contrato canônico é packages/domain/src/print/print-ir.ts. Aqui os
// tipos são espelhados estruturalmente (o agente compila isolado) e um
// teste de conformidade garante que a versão bate com o domínio.
//
// Família completa de renderers do agente local:
//   • text   — texto puro / validação / dry-run (P1)
//   • escpos — térmico de recibos e cupons 80mm/58mm (P2)
//   • zpl    — térmico de etiquetas ZPL II / Zebra (P4)
//   • epl2   — térmico de etiquetas EPL2 / Elgin / Zebra legado (P4)
// ============================================================================

export const PRINT_IR_VERSION = 1; // deve igualar packages/domain (teste de conformidade)

export type PrintAlign = 'left' | 'center' | 'right';

export type PrintBlock =
  | { kind: 'text'; text: string; align?: PrintAlign; emphasis?: 'normal' | 'bold' | 'title'; size?: 'normal' | 'small' | 'large' }
  | { kind: 'kv'; label: string; value: string }
  | { kind: 'table'; columns: { header: string; align?: PrintAlign }[]; rows: string[][] }
  | { kind: 'barcode'; value: string; symbology?: string; caption?: string }
  | { kind: 'qrcode'; value: string; caption?: string }
  | { kind: 'separator' }
  | { kind: 'spacer'; lines?: number }
  | { kind: 'cut'; repeat?: number };

export type PrintIR = {
  version: number;
  jobId: string;
  tenantId: string;
  companyId: string;
  requestedBy: { userId: number | null; userName: string | null };
  terminal?: string | null;
  printerName?: string | null;
  source: string;
  docType: string;
  related?: { type: string; id: string } | null;
  copies: number;
  priority: number;
  content: PrintBlock[];
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
};

/** Erro de impressão com código estável (o servidor decide retry por ele). */
export class PrintError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

export interface Renderer {
  readonly id: string;
  /** Converte o PrintIR na carga da impressora UMA vez (cópias são do printer). */
  render(ir: PrintIR): Promise<Buffer>;
}

export type PrintRenderer = Renderer;

function centro(s: string, largura: number): string {
  if (s.length >= largura) return s;
  const pad = Math.floor((largura - s.length) / 2);
  return ' '.repeat(pad) + s;
}

/** Renderer de texto puro (48 colunas) — base de validação e do dry-run. */
export class TextRenderer implements Renderer {
  readonly id = 'text';
  constructor(private largura = 48) {}

  async render(ir: PrintIR): Promise<Buffer> {
    if (ir.version !== PRINT_IR_VERSION) {
      throw new PrintError('IR_VERSION', `Versão de PrintIR não suportada: ${String(ir.version)}`, false);
    }
    const linhasTotais: string[] = [];
    let secao: string[] = [];

    const descarregarSecao = (repeat = 1, comCorte = false) => {
      const n = Math.max(1, Math.min(200, Math.trunc(repeat)));
      for (let r = 0; r < n; r++) {
        linhasTotais.push(...secao);
        if (comCorte) linhasTotais.push('', '- - - - corte - - - -', '');
      }
      secao = [];
    };

    for (const b of ir.content) {
      switch (b.kind) {
        case 'text': {
          const t = (b.emphasis === 'title' ? b.text.toUpperCase() : b.text).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
          secao.push(b.align === 'center' ? centro(t, this.largura) : b.align === 'right' ? t.padStart(this.largura) : t);
          break;
        }
        case 'kv': {
          const esq = `${b.label}:`.replace(/[\x00-\x1f\x7f]/g, '');
          const dir = b.value.replace(/[\x00-\x1f\x7f]/g, '');
          secao.push(esq + ' '.repeat(Math.max(1, this.largura - esq.length - dir.length)) + dir);
          break;
        }
        case 'table': {
          secao.push(b.columns.map((c) => c.header.replace(/[\x00-\x1f\x7f]/g, '')).join('  '));
          for (const row of b.rows) secao.push(row.map((c) => c.replace(/[\x00-\x1f\x7f]/g, '')).join('  '));
          break;
        }
        case 'barcode':
          secao.push(centro(`[BARCODE ${b.value.replace(/[\x00-\x1f\x7f]/g, '')}]`, this.largura));
          if (b.caption) secao.push(centro(b.caption.replace(/[\x00-\x1f\x7f]/g, ''), this.largura));
          break;
        case 'qrcode':
          secao.push(centro(`[QR ${b.value.replace(/[\x00-\x1f\x7f]/g, '')}]`, this.largura));
          if (b.caption) secao.push(centro(b.caption.replace(/[\x00-\x1f\x7f]/g, ''), this.largura));
          break;
        case 'separator':
          secao.push('-'.repeat(this.largura));
          break;
        case 'spacer':
          for (let i = 0; i < (b.lines ?? 1); i++) secao.push('');
          break;
        case 'cut':
          descarregarSecao(b.repeat ?? 1, true);
          break;
        default:
          throw new PrintError('IR_INVALID', `Bloco desconhecido: ${JSON.stringify(b).slice(0, 80)}`, false);
      }
    }
    if (secao.length > 0) descarregarSecao(1, false);
    return Buffer.from(linhasTotais.join('\n') + '\n', 'utf8');
  }
}

/**
 * Registro de renderers por protocolo/família.
 * Nunca imprime em formato errado silenciosamente: protocolo desconhecido
 * informado em `metadata.protocol` gera erro permanente `UNSUPPORTED_PROTOCOL`.
 */
export class RendererRegistry {
  private map = new Map<string, Renderer>();

  register(familia: string, r: Renderer) {
    this.map.set(familia.toLowerCase(), r);
  }

  has(familia: string): boolean {
    return this.map.has(familia.toLowerCase());
  }

  get(familia: string): Renderer {
    const r = this.map.get(familia.toLowerCase());
    if (!r) throw new PrintError('RENDER_UNSUPPORTED', `Renderer "${familia}" não disponível neste agente`, false);
    return r;
  }

  /**
   * Seleciona o renderer para o job:
   * 1. Se `metadata.protocol` vier explícito, EXIGE suporte exato (senão lança
   *    erro permanente `UNSUPPORTED_PROTOCOL` — nunca cai em texto silencioso).
   * 2. Sem `metadata.protocol`, escolhe o protocolo canônico pelo `docType`
   *    (`recibo_pdv` -> `escpos`, `etiqueta_produto` -> `zpl`) quando registrado,
   *    ou usa `fallbackFamilia`.
   */
  forJob(docType: string, metadata?: Record<string, unknown>, fallbackFamilia = 'text'): Renderer {
    const rawProto = typeof metadata?.protocol === 'string' ? metadata.protocol.trim().toLowerCase() : '';
    if (rawProto) {
      const r = this.map.get(rawProto);
      if (!r) {
        throw new PrintError(
          'UNSUPPORTED_PROTOCOL',
          `Protocolo "${rawProto}" não é suportado pelo agente local (suportados: ${this.familias().join(', ') || 'nenhum'}).`,
          false
        );
      }
      return r;
    }
    if (docType === 'recibo_pdv' && this.map.has('escpos')) return this.map.get('escpos')!;
    if (docType === 'etiqueta_produto' && this.map.has('zpl')) return this.map.get('zpl')!;
    return this.get(fallbackFamilia);
  }

  familias(): string[] {
    return [...this.map.keys()];
  }
}

/** Validação defensiva mínima no agente (o servidor já validou o contrato). */
export function validarPrintIRLocal(ir: PrintIR): void {
  if (!ir || typeof ir !== 'object') throw new PrintError('IR_INVALID', 'PrintIR ausente', false);
  if (ir.version !== PRINT_IR_VERSION) {
    throw new PrintError('IR_VERSION', `Versão de PrintIR não suportada: ${String(ir.version)} (agente conhece ${PRINT_IR_VERSION})`, false);
  }
  if (!Array.isArray(ir.content) || ir.content.length === 0) throw new PrintError('IR_INVALID', 'PrintIR sem conteúdo', false);
  if (!ir.jobId) throw new PrintError('IR_INVALID', 'PrintIR sem jobId', false);
}
