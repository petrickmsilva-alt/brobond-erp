// ============================================================================
// Printer (saída física) + journal local de impressões + sanitização segura.
//
// O JOURNAL é a peça anti-duplicação do agente:
//   claim → render → imprimir → GRAVAR NO JOURNAL → ack PRINTED no ERP
//
// Segurança (P6):
//   • `sanitizePrinterName` bloqueia path traversal (.., /, \), flag injection
//     (-o, --), metacaracteres de shell e controles ASCII;
//   • `safeOutboxPath` garante que `jobId` nunca escape de `outboxDir`;
//   • Spooler usa `execFile`/`spawn` com argumentos em array (jamais shell).
// ============================================================================
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { PrintError } from '../renderer/renderer.js';

export interface Printer {
  readonly id: string;
  print(jobId: string, payload: Buffer, copies: number, printerName?: string | null): Promise<void>;
  printers(): Promise<string[]>;
}

const SAFE_SPOOLER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-()]{0,119}$/;
const SAFE_TCP_RE = /^tcp:\/\/([A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*):([1-9][0-9]{0,4})$/i;

export type ValidatedTarget =
  | { kind: 'spooler'; name: string }
  | { kind: 'tcp'; host: string; port: number };

/** Valida e classifica o destino de impressão. Rejeita traversal/injection. */
export function sanitizePrinterTarget(raw: string): ValidatedTarget {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 120 || /[\x00-\x1f\x7f]/.test(s) || s.includes('..')) {
    throw new PrintError('PRINTER_NOT_FOUND', 'Nome de impressora inválido ou inseguro.', false);
  }
  const tcp = SAFE_TCP_RE.exec(s);
  if (tcp) {
    const host = tcp[1];
    const port = Number(tcp[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PrintError('PRINTER_NOT_FOUND', 'Porta TCP de impressora inválida.', false);
    }
    return { kind: 'tcp', host, port };
  }
  if (!SAFE_SPOOLER_RE.test(s)) {
    throw new PrintError('PRINTER_NOT_FOUND', `Nome de impressora contém caracteres não permitidos: "${s.slice(0, 40)}"`, false);
  }
  return { kind: 'spooler', name: s };
}

/** Garante que o arquivo gerado em disco jamais saia de `baseDir`. */
export function safeOutboxPath(baseDir: string, jobId: string, ext = '.txt'): string {
  const root = resolve(baseDir);
  const safeId = String(jobId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  if (!safeId) throw new PrintError('IR_INVALID', 'jobId inválido para gravação segura.', false);
  const full = resolve(root, `${safeId}${ext}`);
  if (!full.startsWith(root + sep)) {
    throw new PrintError('IR_INVALID', 'Tentativa de path traversal bloqueada.', false);
  }
  return full;
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
    const safeId = String(jobId ?? '').replace(/[\r\n\s]/g, '');
    if (!safeId || this.feitos.has(safeId)) return;
    appendFileSync(this.file, `${safeId} ${new Date().toISOString()}\n`, 'utf8');
    this.feitos.add(safeId);
  }
}

export function journalEm(dir: string): PrintJournal {
  mkdirSync(dir, { recursive: true });
  return new PrintJournal(join(dir, 'printed-journal.log'));
}

/** Saída simulada determinística: grava bytes reais no outbox com path seguro. */
export class DryRunPrinter implements Printer {
  readonly id = 'dry-run';
  constructor(private outboxDir: string) {
    mkdirSync(outboxDir, { recursive: true });
  }
  async print(jobId: string, payload: Buffer, copies: number, printerName?: string | null): Promise<void> {
    if (printerName) sanitizePrinterTarget(printerName);
    const alvo = safeOutboxPath(this.outboxDir, jobId, '.txt');
    const n = Math.max(1, Math.min(99, Math.trunc(copies) || 1));
    const total = n === 1 ? payload : Buffer.concat(Array.from({ length: n }, () => payload));
    writeFileSync(alvo, total);
  }
  async printers(): Promise<string[]> {
    const osPrinters = await descobrirImpressorasSistema();
    return ['dry-run (arquivo)', ...osPrinters];
  }
}

function sendTcpRaw(host: string, port: number, data: Buffer, timeoutMs = 8000): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) rejectPromise(err);
      else resolvePromise();
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => done(new PrintError('TIMEOUT', `Timeout conectando à impressora TCP ${host}:${port}`, true)));
    socket.once('error', (err) => done(new PrintError('PRINTER_OFFLINE', `Falha de rede na impressora ${host}:${port}: ${err.message}`, true)));
    socket.once('connect', () => {
      socket.write(data, (err) => {
        if (err) return done(new PrintError('TRANSPORT', `Erro enviando dados para ${host}:${port}: ${err.message}`, true));
        socket.end(() => done());
      });
    });
  });
}

function sendPosixLpRaw(printerName: string, data: Buffer, copies: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ['-d', printerName, '-n', String(copies), '-o', 'raw', '-'];
    const child = spawn('lp', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += String(c).slice(0, 300);
    });
    child.once('error', (err) => {
      rejectPromise(new PrintError('PRINTER_OFFLINE', `Spooler 'lp' indisponível: ${err.message}`, true));
    });
    child.once('close', (code) => {
      if (code === 0) return resolvePromise();
      const msg = stderr.trim() || `lp retornou código ${code}`;
      const notFound = /unknown destination|not exist|no such/i.test(msg);
      rejectPromise(new PrintError(notFound ? 'PRINTER_NOT_FOUND' : 'PRINTER_OFFLINE', msg, !notFound));
    });
    child.stdin.end(data);
  });
}

/**
 * Descobre impressoras instaladas no sistema operacional sem usar shell e sem
 * inventar status falso quando o SO/driver não fornece informações.
 */
export function descobrirImpressorasSistema(): Promise<string[]> {
  return new Promise((resolvePromise) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
        { timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout) return resolvePromise([]);
          const names = stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => SAFE_SPOOLER_RE.test(s))
            .slice(0, 50);
          resolvePromise(names);
        }
      );
      return;
    }
    execFile('lpstat', ['-e'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolvePromise([]);
      const names = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => SAFE_SPOOLER_RE.test(s))
        .slice(0, 50);
      resolvePromise(names);
    });
  });
}

/**
 * Transporte físico real para estações de trabalho (TCP RAW JetDirect 9100
 * ou Spooler CUPS `lp -o raw`).
 */
export class SystemPrinter implements Printer {
  readonly id = 'system';
  constructor(private defaultPrinter: string | null = null) {}

  async print(jobId: string, payload: Buffer, copies: number, printerName?: string | null): Promise<void> {
    const rawTarget = (printerName || this.defaultPrinter || '').trim();
    if (!rawTarget) {
      throw new PrintError('PRINTER_NOT_FOUND', `Job ${jobId} sem impressora definida e agente sem impressora padrão configurada.`, false);
    }
    const target = sanitizePrinterTarget(rawTarget);
    const n = Math.max(1, Math.min(99, Math.trunc(copies) || 1));

    if (target.kind === 'tcp') {
      const full = n === 1 ? payload : Buffer.concat(Array.from({ length: n }, () => payload));
      await sendTcpRaw(target.host, target.port, full);
      return;
    }
    if (process.platform === 'win32') {
      throw new PrintError(
        'PRINTER_NOT_FOUND',
        `Para impressão RAW no Windows configure destino TCP (tcp://IP:9100) ou habilite dry-run para homologação (impressora: ${target.name}).`,
        false
      );
    }
    await sendPosixLpRaw(target.name, payload, n);
  }

  async printers(): Promise<string[]> {
    const detected = await descobrirImpressorasSistema();
    if (this.defaultPrinter && !detected.includes(this.defaultPrinter)) {
      return [this.defaultPrinter, ...detected];
    }
    return detected;
  }
}

/** Mantido para compatibilidade retroativa com importadores P1. */
export class UnsupportedPrinter implements Printer {
  readonly id = 'unsupported';
  async print(): Promise<void> {
    throw new PrintError('PRINTER_NOT_FOUND', 'Nenhuma impressora física configurada neste agente.', false);
  }
  async printers(): Promise<string[]> {
    return [];
  }
}
