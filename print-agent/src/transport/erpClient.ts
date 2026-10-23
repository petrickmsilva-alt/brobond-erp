// ============================================================================
// Cliente do ERP (polling). O agente SEMPRE inicia a conversa:
// heartbeat → claim → printing → printed/fail. Nenhum push do servidor é
// necessário (a Render pode hibernar; a loja pode estar atrás de NAT).
// ============================================================================
import { authHeaders, type MachineIdentity } from '../auth/machineAuth.js';
import type { PrintIR } from '../renderer/renderer.js';

export type ClaimedJob = {
  public_id: string;
  status: string;
  copies: number;
  printer_name: string | null;
  print_ir: PrintIR;
};

export type PairResult = {
  machine_id: string;
  token: string;
  empresa_id: number;
  terminal: string | null;
  nome: string;
};

type FetchFn = typeof fetch;

export class ErpClient {
  constructor(
    private erpUrl: string,
    private identity: MachineIdentity | null,
    private fetchFn: FetchFn = fetch,
    private agentVersion = '0.1.0'
  ) {}

  setIdentity(id: MachineIdentity) {
    this.identity = id;
  }

  get pareado(): boolean {
    return !!this.identity;
  }

  private async post<T>(path: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!this.identity) throw new Error('Agente não pareado');
    const res = await this.fetchFn(`${this.erpUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.identity), ...extraHeaders },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const erro = new Error(data?.error || `ERP respondeu ${res.status}`) as Error & { status?: number };
      erro.status = res.status;
      throw erro;
    }
    return data as T;
  }

  /** Troca o código de pareamento pela machine identity (sem auth prévia). */
  async pair(codigo: string, info: { nome?: string; terminal?: string; platform?: string }): Promise<PairResult> {
    const res = await this.fetchFn(`${this.erpUrl}/api/print/agent/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo, agent_version: this.agentVersion, ...info }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(data?.error || `Pareamento recusado (${res.status})`);
    return data as PairResult;
  }

  async heartbeat(printers: string[]): Promise<void> {
    await this.post('/api/print/agent/heartbeat', {
      agent_version: this.agentVersion,
      platform: process.platform,
      printers,
    });
  }

  async claim(): Promise<{ job: ClaimedJob; leaseToken: string } | null> {
    const data = await this.post<{ job: ClaimedJob | null; lease_token?: string }>('/api/print/agent/claim', {});
    if (!data.job) return null;
    return { job: data.job, leaseToken: String(data.lease_token) };
  }

  private leaseHeader(leaseToken: string) {
    return { 'x-print-lease-token': leaseToken };
  }

  async printing(publicId: string, leaseToken: string): Promise<void> {
    await this.post(`/api/print/agent/jobs/${publicId}/printing`, {}, this.leaseHeader(leaseToken));
  }

  async printed(publicId: string, leaseToken: string, deduplicado = false): Promise<void> {
    await this.post(`/api/print/agent/jobs/${publicId}/printed`, { deduplicado }, this.leaseHeader(leaseToken));
  }

  async fail(publicId: string, leaseToken: string, erro: { code: string; message: string; retryable: boolean }): Promise<void> {
    await this.post(
      `/api/print/agent/jobs/${publicId}/fail`,
      { error_code: erro.code, error: erro.message, retryable: erro.retryable },
      this.leaseHeader(leaseToken)
    );
  }

  async extendLease(publicId: string, leaseToken: string): Promise<void> {
    await this.post(`/api/print/agent/jobs/${publicId}/lease`, {}, this.leaseHeader(leaseToken));
  }
}
