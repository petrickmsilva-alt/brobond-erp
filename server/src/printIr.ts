// ============================================================================
// PrintIR no servidor — cola entre o contrato canônico
// (packages/domain/src/print/print-ir.ts) e a fila persistida (print_jobs).
//
// O contrato vive no pacote de domínio porque é consumido por três lados
// (ERP, agente local, renderers futuros). Aqui ficam só as operações do
// servidor: montar o PrintIR a partir da linha da fila, calcular o hash de
// conteúdo da idempotência e normalizar a entrada da API de criação de jobs.
// ============================================================================
import { createHash } from 'node:crypto';
import { jsonCanônico } from './auditChain';
import type { Row } from './store';
import {
  PRINT_IR_VERSION,
  validatePrintIR,
  type PrintBlock,
  type PrintIR,
} from '../../packages/domain/src/print/print-ir';

export { PRINT_IR_VERSION, validatePrintIR };
export type { PrintBlock, PrintIR };

/**
 * Hash do conteúdo que define "a mesma impressão": tipo, origem, documento,
 * destino, cópias e blocos. Mesma idempotency_key com hash DIFERENTE é uso
 * indevido da chave (409) — mesmo espírito da devolução em expedicao.ts.
 * JSON canônico (auditChain) garante estabilidade entre memória e JSONB.
 */
export function hashConteudoImpressao(parte: {
  docType: string;
  source: string;
  sourceRef: string | null;
  terminal: string | null;
  printerName: string | null;
  copies: number;
  content: unknown;
}): string {
  return createHash('sha256').update(jsonCanônico(parte)).digest('hex');
}

/** Linha de `print_jobs` → PrintIR completo (o que o agente recebe no claim). */
export function jobParaPrintIR(job: Row): PrintIR {
  const empresa = String(job.empresa_id ?? '');
  const related =
    job.source_ref && String(job.source_ref).includes(':')
      ? { type: String(job.source_ref).split(':')[0], id: String(job.source_ref).split(':').slice(1).join(':') }
      : null;
  return {
    version: Number(job.ir_version) || PRINT_IR_VERSION,
    jobId: String(job.public_id),
    tenantId: empresa,
    companyId: empresa,
    requestedBy: {
      userId: job.requested_by ? Number(job.requested_by) : null,
      userName: (job.requested_by__label as string) || null,
    },
    terminal: (job.terminal as string) || null,
    printerName: (job.printer_name as string) || null,
    source: job.source as PrintIR['source'],
    docType: job.doc_type as PrintIR['docType'],
    related,
    copies: Number(job.copies) || 1,
    priority: Number(job.priority) || 0,
    content: (job.payload as PrintBlock[]) || [],
    metadata: (job.metadata as Record<string, unknown>) || {},
    idempotencyKey: String(job.idempotency_key),
    createdAt: new Date(String(job.criado_em)).toISOString(),
  };
}

/** Entrada normalizada de criação de job (corpo da API já saneado). */
export type NovoJobImpressao = {
  docType: string;
  source: string;
  sourceRef: string | null;
  terminal: string | null;
  printerName: string | null;
  copies: number;
  priority: number;
  content: PrintBlock[];
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts: number;
};
