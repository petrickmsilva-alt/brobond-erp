// ============================================================
// Fase 6 — Log estruturado e monitoramento opcional (Sentry).
//
//   • NODE_ENV=production → logs como JSON de uma linha (fáceis de filtrar).
//   • SENTRY_DSN definido → inicializa o Sentry (pacote @sentry/node, já
//     instalado) e envia exceções não tratadas. Sem a variável nada acontece.
// ============================================================
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isProd = process.env.NODE_ENV === 'production';

type Nivel = 'info' | 'warn' | 'error';

function emitir(nivel: Nivel, msg: string, extra?: Record<string, unknown>) {
  const linha = { nivel, msg, ...extra, ts: new Date().toISOString() };
  const text = JSON.stringify(linha);
  if (isProd) {
    if (nivel === 'error') console.error(text);
    else if (nivel === 'warn') console.warn(text);
    else console.log(text);
    return;
  }
  const prefixo = nivel === 'error' ? '❌' : nivel === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`${prefixo} ${msg}`);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => emitir('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emitir('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emitir('error', msg, extra),
};

let sentry: any = null;
let tentouInicializar = false;

/** Inicializa o Sentry apenas se SENTRY_DSN estiver definido. */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN || '';
  if (!dsn || tentouInicializar) return;
  tentouInicializar = true;
  try {
    sentry = require('@sentry/node');
    sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: `brobond-erp@${process.env.npm_package_version || '0.4.0'}`,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    });
    log.info('Sentry ativo (SENTRY_DSN definido).');
  } catch (e: any) {
    sentry = null;
    log.warn('SENTRY_DSN definido, mas @sentry/node não pôde ser carregado.', { erro: e?.message });
  }
}

/** Envia exceção ao Sentry quando disponível; sempre loga. */
export function reportarErro(e: unknown, extra?: Record<string, unknown>): void {
  log.error(e instanceof Error ? e.message : String(e), extra);
  if (sentry?.captureException) {
    sentry.captureException(e, { extra: extra ?? {} });
  }
}
