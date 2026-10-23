// Log mínimo do agente: níveis + timestamp. NUNCA logar segredo — `redact`
// mascara qualquer valor que pareça token antes de sair.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDEM: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function redact(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s
    .replace(/bpa_[0-9a-f]{16,}/gi, 'bpa_***')
    .replace(/("token"\s*:\s*")[^"]+/gi, '$1***')
    .replace(/(lease[_ ]?token["':=\s]+)[0-9a-f]{32,}/gi, '$1***');
}

export class Logger {
  constructor(private level: LogLevel = 'info', private sink: (line: string) => void = (l) => console.log(l)) {}
  private emit(level: LogLevel, msg: string, extra?: unknown) {
    if (ORDEM[level] < ORDEM[this.level]) return;
    const base = `[${new Date().toISOString()}] [${level}] ${msg}`;
    this.sink(extra === undefined ? base : `${base} ${redact(extra)}`);
  }
  debug(m: string, e?: unknown) { this.emit('debug', m, e); }
  info(m: string, e?: unknown) { this.emit('info', m, e); }
  warn(m: string, e?: unknown) { this.emit('warn', m, e); }
  error(m: string, e?: unknown) { this.emit('error', m, e); }
}
