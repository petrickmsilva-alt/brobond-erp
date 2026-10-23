// ============================================================================
// JobRunner: executa UM job reivindicado, do claim ao desfecho.
//
//   validar PrintIR → journal? (sim: ack deduplicado, sem reimprimir)
//   → PRINTING → render → imprimir cópias → journal → PRINTED
//   qualquer PrintError → fail(código, retryable) — o servidor agenda o
//   retry com backoff ou encerra em FAILED; erro desconhecido = transitório.
//
// Um job por vez, sempre: impressora térmica/etiqueta é recurso serial, e a
// simplicidade aqui é o que mantém a garantia de não duplicar.
// ============================================================================
import type { ErpClient, ClaimedJob } from '../transport/erpClient.js';
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
    private familia = 'text'
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
      await this.client.printing(job.public_id, leaseToken);
      const renderer = this.registry.get(this.familia);
      const payload = await renderer.render(ir);
      await this.printer.print(ir.jobId, payload, Math.max(1, Number(job.copies) || 1), job.printer_name);
      // Journal ANTES do ack: se cair aqui, o lease expira, o job volta e o
      // journal impede a segunda impressão física.
      this.journal.registrar(ir.jobId);
      await this.client.printed(job.public_id, leaseToken, false);
      this.log.info(`job ${ir.jobId} impresso (${job.print_ir.docType})`);
      return true;
    } catch (e) {
      const erro =
        e instanceof PrintError
          ? e
          : new PrintError('TRANSPORT', e instanceof Error ? e.message : String(e), true);
      this.log.warn(`job ${job.public_id} falhou: ${erro.code} ${erro.message}`);
      // Se até o fail falhar (rede), o lease expira no servidor e o job
      // volta à fila — nada se perde, nada duplica (journal + lease).
      await this.client
        .fail(job.public_id, leaseToken, { code: erro.code, message: erro.message, retryable: erro.retryable })
        .catch((e2) => this.log.warn(`não consegui reportar a falha (lease cuidará): ${String((e2 as Error).message)}`));
      return true;
    }
  }
}
