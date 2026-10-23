// ============================================================================
// PrintIR — contrato de impressão do BroBond ERP (P0).
//
// PrintIR é a representação INTERMEDIÁRIA, tipada e versionada, de "o que
// deve ser impresso". Ele NÃO conhece ESC/POS, ZPL, EPL2, HTML ou PDF: quem
// conhece a impressora é o renderer (browser/PDF hoje; ESC/POS na P2; ZPL/
// EPL2 na P4). O mesmo PrintIR alimenta todos eles.
//
//   ERP ──► PrintIR ──► Print Queue ──► Agente Local ──► Renderer ──► Impressora
//
// Este arquivo é a FONTE CANÔNICA do contrato: tipos + validador puro, sem
// dependência de framework, banco ou ambiente (roda em servidor, agente e
// testes). A persistência (fila) espelha o envelope em colunas indexáveis e
// guarda `content`/`metadata` como JSON — ver server/src/printJobs.ts.
//
// VERSIONAMENTO: `PRINT_IR_VERSION` só sobe com mudança incompatível.
// Renderers devem recusar (erro permanente) uma versão que não conhecem —
// nunca "tentar imprimir mesmo assim".
// ============================================================================

export const PRINT_IR_VERSION = 1 as const;

/** Tipos de documento que o ERP sabe pedir para imprimir. */
export const PRINT_DOC_TYPES = [
  'etiqueta_produto', // LabelSheet (A4 / 50x30 hoje; ZPL/EPL2 na P4)
  'recibo_pdv',       // comprovante de venda do PDV (ESC/POS na P2/P3)
  'pedido',           // pedido/orçamento (PDF hoje via OrderPage)
  'compra',           // pedido de compra (PDF hoje)
  'ficha_usuario',    // dossiê do usuário (fichaPrint)
  'relatorio',        // relatórios/expedição/medidas
  'teste',            // página de teste do agente/impressora
  'generico',         // conteúdo livre validado (blocos abaixo)
] as const;
export type PrintDocType = (typeof PRINT_DOC_TYPES)[number];

/** De onde o pedido de impressão nasceu (auditoria + roteamento). */
export const PRINT_SOURCES = ['pdv', 'produto', 'pedido', 'compra', 'usuario', 'relatorio', 'sistema', 'agente'] as const;
export type PrintSource = (typeof PRINT_SOURCES)[number];

/**
 * Blocos semânticos de conteúdo. São intencionais e pequenos: descrevem
 * INTENÇÃO (título, linha chave/valor, tabela, código de barras), nunca
 * comandos de impressora. `align`/`emphasis`/`size` são DICAS que cada
 * renderer traduz como pode (HTML usa CSS; ESC/POS usa comandos de fonte;
 * ZPL usa ^A/^CF). Um bloco desconhecido é erro de validação — o contrato
 * cresce por versão, não por improviso.
 */
export type PrintAlign = 'left' | 'center' | 'right';
export type PrintBlock =
  | { kind: 'text'; text: string; align?: PrintAlign; emphasis?: 'normal' | 'bold' | 'title'; size?: 'normal' | 'small' | 'large' }
  | { kind: 'kv'; label: string; value: string }
  | { kind: 'table'; columns: { header: string; align?: PrintAlign }[]; rows: string[][] }
  | { kind: 'barcode'; value: string; symbology?: 'auto' | 'ean13' | 'ean8' | 'code128'; caption?: string }
  | { kind: 'qrcode'; value: string; caption?: string }
  | { kind: 'separator' }
  | { kind: 'spacer'; lines?: number }
  | { kind: 'cut' }; // dica de corte/avanco — renderers sem guilhotina ignoram

export type PrintIR = {
  /** Versão do contrato (PRINT_IR_VERSION). */
  version: number;
  /** Id público do job (UUID) — é o id que o agente e a auditoria citam. */
  jobId: string;
  /** Tenant (empresa) dona do job. Nunca vem do corpo sem carimbo do servidor. */
  tenantId: string;
  /**
   * Organização/empresa operacional. Hoje tenant == empresa no BroBond; os
   * campos são distintos para o contrato não quebrar quando grupos com
   * várias empresas compartilharem um tenant.
   */
  companyId: string;
  /** Usuário que pediu a impressão (id + nome de exibição para o rodapé). */
  requestedBy: { userId: number | null; userName: string | null };
  /** Terminal/caixa de destino (roteamento). Ausente = qualquer agente da empresa. */
  terminal?: string | null;
  /** Impressora lógica pedida (nome configurado no agente). Ausente = padrão do agente. */
  printerName?: string | null;
  source: PrintSource;
  docType: PrintDocType;
  /** Documento relacionado, ex.: { type: 'venda', id: '123' }. */
  related?: { type: string; id: string } | null;
  copies: number;
  /** Maior primeiro. Faixa 0..100; 0 = normal. */
  priority: number;
  content: PrintBlock[];
  /** Metadados livres PEQUENOS (rótulos, origem de UI) — sem segredos. */
  metadata: Record<string, unknown>;
  /**
   * Chave de idempotência: mesma (empresa, chave) = mesmo job, para sempre.
   * Refresh, retry, timeout e reinício do agente nunca imprimem duas vezes.
   */
  idempotencyKey: string;
  createdAt: string; // ISO-8601 UTC
};

// ----------------------------------------------------------------------------
// Validação (pura — servidor é a autoridade; agente revalida por defesa)
// ----------------------------------------------------------------------------

export const PRINT_LIMITS = {
  copiesMin: 1,
  copiesMax: 99,
  priorityMin: 0,
  priorityMax: 100,
  maxBlocks: 500,
  maxTextLength: 2000,
  maxTableRows: 500,
  maxTableColumns: 12,
  maxBarcodeLength: 80,
  maxMetadataBytes: 4096,
  idempotencyKeyMax: 160,
  terminalMax: 60,
  printerNameMax: 120,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validarBloco(b: unknown, i: number, erros: string[]): void {
  const onde = `content[${i}]`;
  if (!isRecord(b) || typeof b.kind !== 'string') {
    erros.push(`${onde}: bloco inválido`);
    return;
  }
  switch (b.kind) {
    case 'text':
      if (typeof b.text !== 'string' || b.text.length > PRINT_LIMITS.maxTextLength) erros.push(`${onde}: text obrigatório (máx. ${PRINT_LIMITS.maxTextLength})`);
      break;
    case 'kv':
      if (typeof b.label !== 'string' || typeof b.value !== 'string') erros.push(`${onde}: kv exige label e value`);
      break;
    case 'table': {
      const cols = b.columns;
      const rows = b.rows;
      if (!Array.isArray(cols) || cols.length === 0 || cols.length > PRINT_LIMITS.maxTableColumns) erros.push(`${onde}: table exige 1..${PRINT_LIMITS.maxTableColumns} colunas`);
      if (!Array.isArray(rows) || rows.length > PRINT_LIMITS.maxTableRows) erros.push(`${onde}: table com linhas demais`);
      else if (Array.isArray(cols) && rows.some((r) => !Array.isArray(r) || r.length !== cols.length)) erros.push(`${onde}: linha de tabela com número de células diferente das colunas`);
      break;
    }
    case 'barcode':
      if (typeof b.value !== 'string' || !b.value || b.value.length > PRINT_LIMITS.maxBarcodeLength) erros.push(`${onde}: barcode exige value (máx. ${PRINT_LIMITS.maxBarcodeLength})`);
      break;
    case 'qrcode':
      if (typeof b.value !== 'string' || !b.value || b.value.length > 1024) erros.push(`${onde}: qrcode exige value`);
      break;
    case 'separator':
    case 'cut':
      break;
    case 'spacer':
      if (b.lines !== undefined && (!Number.isInteger(b.lines) || Number(b.lines) < 0 || Number(b.lines) > 20)) erros.push(`${onde}: spacer.lines deve ser 0..20`);
      break;
    default:
      erros.push(`${onde}: kind desconhecido "${String(b.kind)}"`);
  }
}

/**
 * Valida um PrintIR completo. Devolve a lista de problemas (vazia = válido).
 * Não lança: quem chama decide o status HTTP / código de erro do agente.
 */
export function validatePrintIR(input: unknown): string[] {
  const erros: string[] = [];
  if (!isRecord(input)) return ['PrintIR deve ser um objeto'];
  const ir = input as Partial<PrintIR>;

  if (ir.version !== PRINT_IR_VERSION) erros.push(`version deve ser ${PRINT_IR_VERSION} (recebido: ${String(ir.version)})`);
  if (typeof ir.jobId !== 'string' || !UUID_RE.test(ir.jobId)) erros.push('jobId deve ser um UUID');
  if (!ir.tenantId || typeof ir.tenantId !== 'string') erros.push('tenantId é obrigatório');
  if (!ir.companyId || typeof ir.companyId !== 'string') erros.push('companyId é obrigatório');
  if (!isRecord(ir.requestedBy)) erros.push('requestedBy é obrigatório');
  if (typeof ir.source !== 'string' || !(PRINT_SOURCES as readonly string[]).includes(ir.source)) erros.push(`source inválida: ${String(ir.source)}`);
  if (typeof ir.docType !== 'string' || !(PRINT_DOC_TYPES as readonly string[]).includes(ir.docType)) erros.push(`docType inválido: ${String(ir.docType)}`);
  if (!Number.isInteger(ir.copies) || Number(ir.copies) < PRINT_LIMITS.copiesMin || Number(ir.copies) > PRINT_LIMITS.copiesMax) {
    erros.push(`copies deve ser ${PRINT_LIMITS.copiesMin}..${PRINT_LIMITS.copiesMax}`);
  }
  if (!Number.isInteger(ir.priority) || Number(ir.priority) < PRINT_LIMITS.priorityMin || Number(ir.priority) > PRINT_LIMITS.priorityMax) {
    erros.push(`priority deve ser ${PRINT_LIMITS.priorityMin}..${PRINT_LIMITS.priorityMax}`);
  }
  if (ir.terminal != null && (typeof ir.terminal !== 'string' || ir.terminal.length > PRINT_LIMITS.terminalMax)) erros.push('terminal inválido');
  if (ir.printerName != null && (typeof ir.printerName !== 'string' || ir.printerName.length > PRINT_LIMITS.printerNameMax)) erros.push('printerName inválido');
  if (ir.related != null && (!isRecord(ir.related) || typeof ir.related.type !== 'string' || typeof ir.related.id !== 'string')) erros.push('related deve ser {type, id}');
  if (typeof ir.idempotencyKey !== 'string' || !ir.idempotencyKey.trim() || ir.idempotencyKey.length > PRINT_LIMITS.idempotencyKeyMax) {
    erros.push('idempotencyKey é obrigatória');
  }
  if (typeof ir.createdAt !== 'string' || Number.isNaN(Date.parse(ir.createdAt))) erros.push('createdAt deve ser ISO-8601');
  if (!Array.isArray(ir.content) || ir.content.length === 0) erros.push('content deve ter ao menos um bloco');
  else if (ir.content.length > PRINT_LIMITS.maxBlocks) erros.push(`content excede ${PRINT_LIMITS.maxBlocks} blocos`);
  else ir.content.forEach((b, i) => validarBloco(b, i, erros));
  if (!isRecord(ir.metadata)) erros.push('metadata deve ser um objeto');
  else if (JSON.stringify(ir.metadata).length > PRINT_LIMITS.maxMetadataBytes) erros.push('metadata grande demais');

  return erros;
}

/** Estados persistidos do job na fila (espelho do CHECK da migration 0037). */
export const PRINT_JOB_STATUSES = ['QUEUED', 'CLAIMED', 'PRINTING', 'PRINTED', 'FAILED', 'CANCELLED'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/** Códigos de erro estáveis que o agente pode devolver (retry decide por aqui). */
export const PRINT_ERROR_CODES = [
  'PRINTER_OFFLINE',
  'PRINTER_NOT_FOUND',
  'PAPER_OUT',
  'RENDER_UNSUPPORTED', // permanente: renderer não sabe este PrintIR/docType
  'IR_INVALID',         // permanente: PrintIR não validou no agente
  'IR_VERSION',         // permanente: versão desconhecida do contrato
  'TRANSPORT',          // transitório: rede/USB/serial
  'TIMEOUT',
  'UNKNOWN',
] as const;
export type PrintErrorCode = (typeof PRINT_ERROR_CODES)[number];

/** Erros que NUNCA devem ser retentados automaticamente. */
export const PRINT_PERMANENT_ERRORS: ReadonlySet<string> = new Set(['RENDER_UNSUPPORTED', 'IR_INVALID', 'IR_VERSION', 'PRINTER_NOT_FOUND']);
