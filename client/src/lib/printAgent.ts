// ============================================================================
// printAgent.ts — SDK cliente da arquitetura de impressão BroBond ERP (P1..P6).
//
// Nenhum componente React gera ESC/POS, ZPL ou EPL2: o frontend envia apenas a
// intenção de negócio ao backend (autoridade canônica), consulta fila/status e
// aciona contingência segura (PDF/HTML com Bearer token via Blob, sem expor JWT
// na query string).
// ============================================================================
import { api, apiFetch, ApiError, getToken } from './api';

export const PRINT_AGENT_URL = 'http://127.0.0.1:17831';
const PREFERRED_TERMINAL_KEY = 'brobond_preferred_terminal';

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

export type JobCliente = {
  id?: number;
  public_id: string;
  doc_type: string;
  source: string;
  source_ref?: string | null;
  terminal?: string | null;
  printer_name?: string | null;
  printer_protocol?: string | null;
  copies: number;
  priority?: number;
  status: 'QUEUED' | 'CLAIMED' | 'PRINTING' | 'PRINTED' | 'FAILED' | 'CANCELLED' | string;
  attempts?: number;
  max_attempts?: number;
  last_error_code?: string | null;
  last_error?: string | null;
  permanent_error?: boolean;
  reprint_of?: string | null;
  reprint_reason?: string | null;
  requested_by?: number | null;
  requested_by_nome?: string | null;
  claimed_by_agent_id?: number | null;
  agent_nome?: string | null;
  criado_em?: string;
  printed_at?: string | null;
  failed_at?: string | null;
  cancelled_at?: string | null;
  [k: string]: unknown;
};

export type TerminalConfigCliente = {
  id: number;
  codigo: string;
  nome: string;
  agent_id: number | null;
  agent_nome: string | null;
  agent_machine_id: string | null;
  agent_online: boolean;
  agent_printers: string[];
  default_printer: string | null;
  receipt_printer: string | null;
  receipt_protocol: string;
  receipt_width_cols: number;
  label_printer: string | null;
  label_protocol: string;
  document_printer: string | null;
  document_protocol: string;
  fallback_mode: string;
  auto_print_pdv: boolean;
  allow_operator_reprint: boolean;
  copies_recibo: number;
  copies_documento: number;
  ativo: boolean;
};

export type AgenteRemotoCliente = {
  id: number;
  machine_id: string;
  nome: string;
  terminal: string | null;
  token_prefix: string;
  status: 'ativo' | 'revogado';
  online: boolean;
  agent_version: string | null;
  platform: string | null;
  printers: string[];
  last_heartbeat_at: string | null;
  last_ip: string | null;
  criado_em: string;
  revoked_at: string | null;
};

export type ResumoOperacionalImpressao = {
  fila: {
    queued: number;
    claimed: number;
    printing: number;
    failed: number;
    cancelled: number;
    printed_24h: number;
    reprints_24h: number;
    orphan_leases: number;
  };
  agentes: {
    total: number;
    ativos: number;
    online: number;
    revogados: number;
  };
  terminais_ativos: number;
};

/** Terminal preferido salvo nesta estação de trabalho (navegador). */
export function getPreferredTerminal(): string {
  try {
    return localStorage.getItem(PREFERRED_TERMINAL_KEY) || '';
  } catch {
    return '';
  }
}

export function setPreferredTerminal(codigo: string): void {
  try {
    const clean = codigo.trim().toUpperCase();
    if (clean) localStorage.setItem(PREFERRED_TERMINAL_KEY, clean);
    else localStorage.removeItem(PREFERRED_TERMINAL_KEY);
  } catch {
    // ignore storage quota errors
  }
}

export function novaChaveIdempotencia(): string {
  return crypto.randomUUID();
}

// ----------------------------------------------------------------------------
// Fila & Jobs
// ----------------------------------------------------------------------------

export async function enfileirarImpressao(job: NovoJobCliente): Promise<{ job: JobCliente; idempotente: boolean }> {
  return api.post('/print/jobs', job);
}

export async function listarJobsImpressao(params: Record<string, string | number | boolean | undefined> = {}): Promise<{
  rows: JobCliente[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return api.get(`/print/jobs${s ? `?${s}` : ''}`);
}

export async function detalheJobImpressao(publicId: string): Promise<{ job: JobCliente; print_ir: Record<string, unknown> }> {
  return api.get(`/print/jobs/${encodeURIComponent(publicId)}`);
}

export async function cancelarImpressao(publicId: string): Promise<{ job: JobCliente }> {
  return api.post(`/print/jobs/${encodeURIComponent(publicId)}/cancelar`, {});
}

export async function retentarImpressao(publicId: string): Promise<{ job: JobCliente }> {
  return api.post(`/print/jobs/${encodeURIComponent(publicId)}/retry`, {});
}

export async function reimprimirJob(
  publicId: string,
  opts: { motivo?: string; copies?: number; terminal?: string; printer_name?: string; idempotency_key?: string } = {}
): Promise<{ job: JobCliente; idempotente: boolean }> {
  return api.post(`/print/jobs/${encodeURIComponent(publicId)}/reimprimir`, opts);
}

export async function obterResumoImpressao(): Promise<ResumoOperacionalImpressao> {
  return api.get('/print/resumo');
}

export async function executarManutencaoImpressao(): Promise<{ ok: boolean; reabertos: number; falhados: number }> {
  return api.post('/print/manutencao', {});
}

// ----------------------------------------------------------------------------
// P2 (PDV), P3 (Documentos ERP) e P4 (Etiquetas Térmicas)
// ----------------------------------------------------------------------------

export async function reimprimirCupomPdv(
  vendaId: number,
  opts: { motivo?: string; terminal?: string; copies?: number; idempotency_key?: string } = {}
): Promise<{ job: JobCliente; idempotente: boolean; reprint_of: string; fallback_html_url: string; fallback_pdf_url: string }> {
  const terminal = opts.terminal ?? (getPreferredTerminal() || undefined);
  return api.post(`/pdv/vendas/${vendaId}/reimprimir`, { ...opts, terminal });
}

export type TipoDocumentoImprimivel = 'vendas' | 'compras' | 'propostas' | 'cotacoes-compra' | 'ordens' | 'usuarios';

export async function imprimirDocumentoErp(
  tipo: TipoDocumentoImprimivel,
  id: number,
  opts: { copies?: number; terminal?: string; printer_name?: string; protocol?: 'escpos' | 'text'; idempotency_key?: string } = {}
): Promise<{ job: JobCliente; idempotente: boolean; fallback_pdf_url: string; fallback_html_url: string }> {
  const terminal = opts.terminal ?? (getPreferredTerminal() || undefined);
  return api.post(`/print/documentos/${tipo}/${id}`, { ...opts, terminal });
}

export async function reimprimirDocumentoErp(
  tipo: TipoDocumentoImprimivel,
  id: number,
  opts: { motivo?: string; copies?: number; terminal?: string; printer_name?: string; idempotency_key?: string } = {}
): Promise<{ job: JobCliente; idempotente: boolean; fallback_pdf_url: string; fallback_html_url: string }> {
  const terminal = opts.terminal ?? (getPreferredTerminal() || undefined);
  return api.post(`/print/documentos/${tipo}/${id}/reimprimir`, { ...opts, terminal });
}

export async function imprimirEtiquetasTermicas(payload: {
  itens: { produto_id: number; tamanho_id?: number | null; quantidade: number }[];
  protocol?: 'zpl' | 'epl2';
  terminal?: string;
  printer_name?: string;
  copies?: number;
  incluir_preco?: boolean;
  incluir_marca?: boolean;
  label_width_mm?: number;
  label_height_mm?: number;
  dpi?: 203 | 300;
  idempotency_key?: string;
}): Promise<{
  job: JobCliente;
  idempotente: boolean;
  total_etiquetas: number;
  protocol: string;
  fallback_pdf_url: string;
  fallback_html_url: string;
}> {
  const terminal = payload.terminal ?? (getPreferredTerminal() || undefined);
  return api.post('/print/etiquetas', { ...payload, terminal });
}

// ----------------------------------------------------------------------------
// Contingência segura (abre PDF ou HTML em nova aba autenticada sem token na URL)
// ----------------------------------------------------------------------------

export async function abrirContingenciaImpressao(apiUrlOrPath: string): Promise<void> {
  const cleanPath = apiUrlOrPath.startsWith('/api/') ? apiUrlOrPath.slice(4) : apiUrlOrPath;
  const token = getToken();
  const res = await fetch(`/api${cleanPath}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err?.error || 'Não foi possível abrir a contingência de impressão.');
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const w = window.open(blobUrl, '_blank', 'noopener,noreferrer');
  if (!w) {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = blob.type.includes('pdf') ? 'impressao.pdf' : 'impressao.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

// ----------------------------------------------------------------------------
// P5 — Terminais, Agentes e Descoberta de Impressoras
// ----------------------------------------------------------------------------

export async function listarTerminaisImpressao(): Promise<{ rows: TerminalConfigCliente[]; total: number }> {
  return api.get('/print/terminals');
}

export async function criarTerminalImpressao(dados: Partial<TerminalConfigCliente>): Promise<{ terminal: TerminalConfigCliente }> {
  return api.post('/print/terminals', dados);
}

export async function atualizarTerminalImpressao(
  id: number,
  dados: Partial<TerminalConfigCliente>
): Promise<{ terminal: TerminalConfigCliente }> {
  return apiFetch(`/print/terminals/${id}`, { method: 'PATCH', body: JSON.stringify(dados) });
}

export async function removerTerminalImpressao(id: number): Promise<{ ok: boolean }> {
  return api.del(`/print/terminals/${id}`);
}

export async function testarTerminalImpressao(
  id: number,
  uso: 'recibo' | 'etiqueta' | 'documento' = 'recibo'
): Promise<{ job: JobCliente }> {
  return api.post(`/print/terminals/${id}/teste`, { uso });
}

export async function listarAgentesImpressao(): Promise<{ rows: AgenteRemotoCliente[]; total: number }> {
  return api.get('/print/agents');
}

export async function gerarCodigoPareamentoAgente(opts: { nome?: string; terminal?: string } = {}): Promise<{
  codigo: string;
  expires_at: string;
}> {
  return api.post('/print/pairing', opts);
}

export async function atualizarAgenteImpressao(
  idOuMachine: string | number,
  dados: { nome?: string; terminal?: string | null }
): Promise<{ agente: AgenteRemotoCliente }> {
  return apiFetch(`/print/agents/${encodeURIComponent(String(idOuMachine))}`, {
    method: 'PATCH',
    body: JSON.stringify(dados),
  });
}

export async function revogarAgenteImpressao(idOuMachine: string | number): Promise<{ agente: AgenteRemotoCliente }> {
  return api.post(`/print/agents/${encodeURIComponent(String(idOuMachine))}/revogar`, {});
}

export async function reativarAgenteImpressao(idOuMachine: string | number): Promise<{ agente: AgenteRemotoCliente; token: string }> {
  return api.post(`/print/agents/${encodeURIComponent(String(idOuMachine))}/reativar`, {});
}

export async function rotacionarTokenAgenteImpressao(
  idOuMachine: string | number
): Promise<{ agente: AgenteRemotoCliente; token: string }> {
  return api.post(`/print/agents/${encodeURIComponent(String(idOuMachine))}/rotacionar-token`, {});
}

export async function listarImpressorasDetectadas(): Promise<{
  agentes: {
    agent_id: number;
    machine_id: string;
    nome: string;
    terminal: string | null;
    online: boolean;
    last_heartbeat_at: string | null;
    printers: string[];
  }[];
  impressoras: string[];
}> {
  return api.get('/print/impressoras-detectadas');
}

// ----------------------------------------------------------------------------
// Ponte opcional Loopback -> Agente Local (127.0.0.1:17831)
// ----------------------------------------------------------------------------

export type StatusAgenteLocal = {
  ok: boolean;
  version?: string;
  machine_id?: string | null;
  terminal?: string | null;
  pareado?: boolean;
  printers?: string[];
  protocols?: string[];
};

export async function detectarAgenteLocal(timeoutMs = 1200): Promise<StatusAgenteLocal> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${PRINT_AGENT_URL}/status`, { signal: ctrl.signal });
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

export async function parearAgenteLocalLoopback(codigo: string): Promise<{ ok: boolean; machine_id: string; nome: string }> {
  const res = await fetch(`${PRINT_AGENT_URL}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo: codigo.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || 'Falha ao parear com o agente local em 127.0.0.1.');
  }
  return data;
}
