// ============================================================================
// Printer (saída física) + journal local de impressões.
//
// O JOURNAL é a peça anti-duplicação do agente: a sequência de um job é
//
//   claim → imprimir → GRAVAR NO JOURNAL → ack PRINTED no ERP
//
// Se o agente morrer entre imprimir e o ack, o lease expira e o job volta.
// Quem reivindicá-lo (este ou outro agente DESTA máquina) consulta o
// journal ANTES de imprimir: constando o jobId, não imprime de novo — só
// confirma PRINTED com deduplicado=true. Claim é at-least-once; com o
// journal, a impressão física é effectively-once por máquina.
//
// P1: DryRunPrinter escreve a carga em `outbox/<jobId>.txt` (determinístico:
// reimprimir o mesmo job sobrescreve o mesmo arquivo). As impressoras reais
// (P2 ESC/POS rede/USB, P4 ZPL/EPL2) implementam `Printer` sem tocar no
// journal nem no runner.
// ============================================================================
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrintError } from '../renderer/renderer.js';

export interface Printer {
  readonly id: string;
  print(jobId: string, payload: Buffer, copies: number, printerName?: string | null): Promise<void>;
  printers(): Promise<string[]>;
}

export class PrintJournal {
  private feitos = new Set<string>();
  constructor(private file: string) {
    if (existsSync(file)) {
      for (const linha of readFileSync(file, 'utf8').split('\n')) {
        const id = linha.split(' ')[0]?.trim();
        if (id) this.feitos.add(id);
      }
    }
  }
  jaImprimiu(jobId: string): boolean {
    return this.feitos.has(jobId);
  }
  registrar(jobId: string): void {
    if (this.feitos.has(jobId)) return;
    appendFileSync(this.file, `${jobId} ${new Date().toISOString()}\n`, 'utf8');
    this.feitos.add(jobId);
  }
}

export function journalEm(dir: string): PrintJournal {
  mkdirSync(dir, { recursive: true });
  return new PrintJournal(join(dir, 'printed-journal.log'));
}

/** Saída simulada: um arquivo por job no outbox (idempotente por nome). */
export class DryRunPrinter implements Printer {
  readonly id = 'dry-run';
  constructor(private outboxDir: string) {
    mkdirSync(outboxDir, { recursive: true });
  }
  async print(jobId: string, payload: Buffer, copies: number): Promise<void> {
    const alvo = join(this.outboxDir, `${jobId}.txt`);
    const copia = payload.toString('utf8');
    writeFileSync(alvo, copia.repeat(Math.max(1, copies)), 'utf8');
  }
  async printers(): Promise<string[]> {
    return ['dry-run (arquivo)'];
  }
}

/** Placeholder honesto: família física ainda não implementada (P2/P4). */
export class UnsupportedPrinter implements Printer {
  readonly id = 'unsupported';
  async print(): Promise<void> {
    throw new PrintError('PRINTER_NOT_FOUND', 'Nenhuma impressora física configurada neste agente (dry-run desligado sem driver).', false);
  }
  async printers(): Promise<string[]> {
    return [];
  }
}
