// ============================================================================
// JobRunner: executa UM job reivindicado, do claim ao desfecho.
//
//   validar PrintIR → journal? (sim: ack deduplicado, sem reimprimir)
//   → PRINTING → selecionar renderer (protocol/docType) → render → imprimir
//   → journal → PRINTED
//   qualquer PrintError → fail(código, retryable) — o servidor agenda o
//   retry com backoff ou encerra em FAILED; erro desconhecido = transitório.
// ============================================================================
import type { ErpClient } from '../transport/erpClient.js';
import { PrintError, validarPrintIRLocal, type RendererRegistry } from '../renderer/renderer.js';
import type { PrintJournal, Printer } from '../printer/printer.js';
import type { Logger } from '../logging/logger.js';

export class JobRunner {
  constructor(
    private client: ErpClient,
    private registry: RendererRegistry,
    private printer: Printer,
    private journal: PrintJournal,
    private log: Logger,
    private familiaFallback = 'text'
  ) {}

  /** Processa o próximo job se houver. true = havia job (continuar o loop já). */
  async processarProximo(): Promise<boolean> {
    const claimed = await this.client.claim();
    if (!claimed) return false;
    const { job, leaseToken } = claimed;
    const ir = job.print_ir;
    try {
      validarPrintIRLocal(ir);
      if (this.journal.jaImprimiu(ir.jobId)) {
        this.log.info(`job ${ir.jobId} já consta no journal — confirmando sem reimprimir`);
        await this.client.printed(job.public_id, leaseToken, true);
        return true;
      }
      // Seleciona e valida o renderer ANTES de abrir conexão com a impressora:
      // se o protocolo não for suportado ou um EAN for inválido, falha rápido
      // sem desperdiçar papel nem enviar bytes errados.
      const renderer = this.registry.forJob(ir.docType, ir.metadata, this.familiaFallback);
      const payload = await renderer.render(ir);

      await this.client.printing(job.public_id, leaseToken);
      const targetPrinter = job.printer_name ?? ir.printerName ?? null;
      await this.printer.print(ir.jobId, payload, Math.max(1, Math.min(99, Number(job.copies) || 1)), targetPrinter);
      // Journal ANTES do ack: se cair aqui, o lease expira, o job volta e o
      // journal impede a segunda impressão física.
      this.journal.registrar(ir.jobId);
      await this.client.printed(job.public_id, leaseToken, false);
      this.log.info(`job ${ir.jobId} impresso (${ir.docType} via ${renderer.id})`);
      return true;
    } catch (e) {
      const erro =
        e instanceof PrintError
          ? e
          : new PrintError('TRANSPORT', e instanceof Error ? e.message : String(e), true);
      this.log.warn(`job ${job.public_id} falhou: ${erro.code} ${erro.message}`);
      await this.client
        .fail(job.public_id, leaseToken, { code: erro.code, message: erro.message, retryable: erro.retryable })
        .catch((e2) => this.log.warn(`não consegui reportar a falha (lease cuidará): ${String((e2 as Error).message)}`));
      return true;
    }
  }
}
