// ============================================================================
// Impressão P1 no navegador — duas pontes, nenhuma obrigatória para imprimir:
//
//   1. ERP → fila: `enfileirarImpressao` cria o job no servidor
//      (POST /api/print/jobs). É o caminho que as telas passarão a usar nas
//      fases P2/P3 (recibo do PDV, etiquetas) SEM remover a impressão atual
//      do navegador/PDF, que continua como alternativa.
//   2. Navegador → agente local: `detectarAgenteLocal` consulta o agente em
//      http://127.0.0.1:17831 (única origem loopback liberada na CSP) só
//      para MOSTRAR status ("agente conectado") e assistir o pareamento.
//      Se o navegador bloquear essa consulta, a impressão não é afetada:
//      quem busca os jobs é o agente, por polling no ERP.
//
// A chave de idempotência é gerada UMA vez por intenção de impressão e deve
// ser REUSADA em retries (mesma variável no chamador): é ela que impede a
// impressão duplicada em refresh/reconexão.
// ============================================================================
import { api } from './api';

export const PRINT_AGENT_URL = 'http://127.0.0.1:17831';

export type NovoJobCliente = {
  doc_type: string;
  source: string;
  source_ref?: string;
  terminal?: string;
  printer_name?: string;
  copies?: number;
  priority?: number;
  content: unknown[];
  metadata?: Record<string, unknown>;
  idempotency_key: string;
};

export type JobCliente = { public_id: string; status: string; [k: string]: unknown };

/** UUID para chave de idempotência/public_id (navegador moderno tem crypto). */
export function novaChaveIdempotencia(): string {
  return crypto.randomUUID();
}

export async function enfileirarImpressao(job: NovoJobCliente): Promise<{ job: JobCliente; idempotente: boolean }> {
  return api.post('/print/jobs', job);
}

export async function cancelarImpressao(publicId: string): Promise<{ job: JobCliente }> {
  return api.post(`/print/jobs/${publicId}/cancelar`, {});
}

export type StatusAgenteLocal = {
  ok: boolean;
  version?: string;
  machine_id?: string;
  pareado?: boolean;
  printers?: string[];
};

/**
 * Consulta o agente local com timeout curto. Qualquer falha (agente fechado,
 * navegador bloqueando loopback, timeout) vira `{ ok: false }` — nunca lança,
 * porque a ausência do agente é um estado normal da UI, não um erro.
 */
export async function detectarAgenteLocal(timeoutMs = 1200): Promise<StatusAgenteLocal> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${PRINT_AGENT_URL}/health`, { signal: ctrl.signal });
      if (!res.ok) return { ok: false };
      const data = (await res.json()) as StatusAgenteLocal;
      return { ...data, ok: true };
    } finally {
      clearTimeout(t);
    }
  } catch {
    return { ok: false };
  }
}
