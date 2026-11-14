// ============================================================================
// CONTROL PLANE › INFRA › CLIENTE DO GITHUB ACTIONS
//
// Só o que a política autoriza: DISPARAR o workflow do REGISTRO e CONSULTAR
// execuções/branches/commits/PRs. Nenhum endpoint de escrita além do dispatch
// de workflow é usado. O dispatch NUNCA recebe URL de destino, repositório ou
// arquivo do cliente — tudo vem do registro interno e da operação aprovada.
//
// O dispatch do GitHub responde 204 (SEM corpo): o run id é descoberto por
// consulta à lista de execuções (reconciliação), nunca presumido.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { GithubAppClient, githubApp, type RespostaGithub } from './github-app.client';

export type GithubRun = {
  id: number;
  status: string | null;
  conclusion: string | null;
  html_url: string | null;
  head_branch: string | null;
  run_started_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  name: string | null;
};

export type GithubBranch = { name: string; commit: { sha: string } | null; protected?: boolean };
export type GithubCommit = { sha: string; commit: { message: string; author: { name?: string; date?: string } | null } | null; html_url: string | null };
export type GithubPullRequest = { number: number; title: string; state: string; html_url: string; user: { login: string } | null; head: { ref: string } | null; base: { ref: string } | null };

/** Normaliza o status bruto do GitHub para o estado do ERP (nunca inventa). */
export function normalizarStatusRun(status: string | null | undefined, conclusion: string | null | undefined): 'queued' | 'in_progress' | 'completed' | 'unknown' {
  const s = String(status ?? '').toLowerCase();
  if (s === 'queued' || s === 'requested' || s === 'waiting' || s === 'pending') return 'queued';
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  if (conclusion) return 'completed';
  return 'unknown';
}

export class GithubActionsClient {
  private app: GithubAppClient;

  constructor(app: GithubAppClient = githubApp) {
    this.app = app;
  }

  private async exigirOk<T>(res: RespostaGithub<T>, contexto: string): Promise<T> {
    if (res.status >= 200 && res.status < 300) return res.data;
    throw new OperationalError('GITHUB_INDISPONIVEL', `O GitHub recusou "${contexto}" (HTTP ${res.status}).`);
  }

  /** Dispara um workflow. `ref` e `inputs` vêm do registro/operação — nunca do cliente. */
  async dispatch(repo: string, workflowFile: string, ref: string, inputs: Record<string, unknown> = {}): Promise<{ status: number }> {
    const res = await this.app.comInstalacao<unknown>(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      { method: 'POST', body: JSON.stringify({ ref, inputs }) }
    );
    // O GitHub responde 204 No Content no sucesso.
    if (res.status !== 204 && (res.status < 200 || res.status >= 300)) {
      throw new OperationalError('GITHUB_INDISPONIVEL', `O GitHub recusou o dispatch do workflow (HTTP ${res.status}).`);
    }
    return { status: res.status };
  }

  /** O workflow ainda existe no repositório? (verificação 9 da especificação) */
  async workflowExiste(repo: string, workflowFile: string): Promise<boolean> {
    const res = await this.app.comInstalacao<unknown>(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}`, { method: 'GET' });
    return res.status >= 200 && res.status < 300;
  }

  /** Uma execução por id. */
  async runPorId(repo: string, runId: number): Promise<GithubRun> {
    const res = await this.app.comInstalacao<GithubRun>(`/repos/${repo}/actions/runs/${runId}`, { method: 'GET' });
    return this.exigirOk(res, 'consulta de execução');
  }

  /** Execuções recentes (opcionalmente por workflow/branch). */
  async listarRuns(repo: string, opts: { workflowFile?: string; branch?: string; limit?: number } = {}): Promise<GithubRun[]> {
    const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 50);
    const params = new URLSearchParams({ per_page: String(limit) });
    if (opts.branch) params.set('branch', opts.branch);
    const base = opts.workflowFile
      ? `/repos/${repo}/actions/workflows/${encodeURIComponent(opts.workflowFile)}/runs`
      : `/repos/${repo}/actions/runs`;
    const res = await this.app.comInstalacao<{ workflow_runs?: GithubRun[] }>(`${base}?${params.toString()}`, { method: 'GET' });
    const data = await this.exigirOk(res, 'listagem de execuções');
    return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  }

  /** A execução mais recente de um workflow numa ref (reconciliação do dispatch). */
  async ultimaRun(repo: string, workflowFile: string, ref: string): Promise<GithubRun | null> {
    const runs = await this.listarRuns(repo, { workflowFile, branch: ref, limit: 1 });
    return runs[0] ?? null;
  }

  async branches(repo: string, opts: { query?: string; limit?: number } = {}): Promise<GithubBranch[]> {
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    const res = await this.app.comInstalacao<GithubBranch[]>(`/repos/${repo}/branches?per_page=${limit}`, { method: 'GET' });
    const data = await this.exigirOk(res, 'listagem de branches');
    const q = String(opts.query ?? '').trim().toLowerCase();
    const lista = Array.isArray(data) ? data : [];
    return (q ? lista.filter((b) => String(b.name).toLowerCase().includes(q)) : lista).slice(0, limit);
  }

  async commits(repo: string, branch: string, limit = 10): Promise<GithubCommit[]> {
    const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const res = await this.app.comInstalacao<GithubCommit[]>(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${n}`, { method: 'GET' });
    const data = await this.exigirOk(res, 'listagem de commits');
    return Array.isArray(data) ? data : [];
  }

  async pullRequests(repo: string, opts: { state?: string; limit?: number } = {}): Promise<GithubPullRequest[]> {
    const estado = ['open', 'closed', 'all'].includes(String(opts.state)) ? String(opts.state) : 'open';
    const n = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    const res = await this.app.comInstalacao<GithubPullRequest[]>(`/repos/${repo}/pulls?state=${estado}&per_page=${n}`, { method: 'GET' });
    const data = await this.exigirOk(res, 'listagem de pull requests');
    return Array.isArray(data) ? data : [];
  }
}

export const githubActions = new GithubActionsClient();
