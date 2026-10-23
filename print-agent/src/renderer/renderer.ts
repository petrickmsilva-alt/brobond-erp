// ============================================================================
// Renderers: PrintIR → bytes/páginas para uma família de impressora.
//
// O contrato canônico é packages/domain/src/print/print-ir.ts. Aqui os
// tipos são espelhados estruturalmente (o agente compila isolado) e um
// teste de conformidade garante que a versão bate com o domínio.
//
// P1 entrega o renderer de TEXTO (dry-run/validação do pipeline). ESC/POS
// chega na P2 e ZPL/EPL2 na P4 implementando esta mesma interface — o
// restante do agente (fila, lease, journal) não muda.
// ============================================================================

export const PRINT_IR_VERSION = 1; // deve igualar packages/domain (teste de conformidade)

export type PrintBlock =
  | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; emphasis?: 'normal' | 'bold' | 'title'; size?: 'normal' | 'small' | 'large' }
  | { kind: 'kv'; label: string; value: string }
  | { kind: 'table'; columns: { header: string; align?: string }[]; rows: string[][] }
  | { kind: 'barcode'; value: string; symbology?: string; caption?: string }
  | { kind: 'qrcode'; value: string; caption?: string }
  | { kind: 'separator' }
  | { kind: 'spacer'; lines?: number }
  | { kind: 'cut' };

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
    const linhas: string[] = [];
    for (const b of ir.content) {
      switch (b.kind) {
        case 'text': {
          const t = b.emphasis === 'title' ? b.text.toUpperCase() : b.text;
          linhas.push(b.align === 'center' ? centro(t, this.largura) : b.align === 'right' ? t.padStart(this.largura) : t);
          break;
        }
        case 'kv': {
          const esq = `${b.label}:`;
          const dir = b.value;
          linhas.push(esq + ' '.repeat(Math.max(1, this.largura - esq.length - dir.length)) + dir);
          break;
        }
        case 'table': {
          linhas.push(b.columns.map((c) => c.header).join('  '));
          for (const row of b.rows) linhas.push(row.join('  '));
          break;
        }
        case 'barcode':
          linhas.push(centro(`[BARCODE ${b.value}]`, this.largura));
          if (b.caption) linhas.push(centro(b.caption, this.largura));
          break;
        case 'qrcode':
          linhas.push(centro(`[QR ${b.value}]`, this.largura));
          if (b.caption) linhas.push(centro(b.caption, this.largura));
          break;
        case 'separator':
          linhas.push('-'.repeat(this.largura));
          break;
        case 'spacer':
          for (let i = 0; i < (b.lines ?? 1); i++) linhas.push('');
          break;
        case 'cut':
          linhas.push('', '- - - - corte - - - -', '');
          break;
        default:
          throw new PrintError('IR_INVALID', `Bloco desconhecido: ${JSON.stringify(b).slice(0, 80)}`, false);
      }
    }
    return Buffer.from(linhas.join('\n') + '\n', 'utf8');
  }
}

/** Registro de renderers por família. P2/P4 registram os físicos aqui. */
export class RendererRegistry {
  private map = new Map<string, Renderer>();
  register(familia: string, r: Renderer) {
    this.map.set(familia, r);
  }
  get(familia: string): Renderer {
    const r = this.map.get(familia);
    if (!r) throw new PrintError('RENDER_UNSUPPORTED', `Renderer "${familia}" não disponível neste agente`, false);
    return r;
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
