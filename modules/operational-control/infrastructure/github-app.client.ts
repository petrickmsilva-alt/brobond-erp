// ============================================================================
// CONTROL PLANE › INFRA › CLIENTE DA GITHUB APP
//
// Autenticação em duas etapas (nunca PAT pessoal):
//
//   GITHUB APP PRIVATE KEY  →  APP JWT (RS256, ≤10 min)
//      →  POST /app/installations/{id}/access_tokens  →  INSTALLATION TOKEN (1 h)
//      →  GitHub REST API
//
// O installation token é obtido SOB DEMANDA e mantido em cache pelo menor
// tempo possível (expira em ~1 h; renovamos com folga). NUNCA é registrado em
// log nem devolvido ao cliente. A chave privada permanece só no servidor.
//
// `GITHUB_API_BASE_URL` permite apontar para um servidor de teste (homologação)
// sem tocar a API pública — o mesmo código de produção é exercitado.
// ============================================================================
import jwt from 'jsonwebtoken';
import { OperationalError } from '../domain/errors';
import { obterConfigGithubApp, type GithubAppConfig } from './token-vault';

const API_BASE = () => String(process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(/\/+$/, '');
const USER_AGENT = 'brobond-operational-control';
const TIMEOUT_MS = Number(process.env.GITHUB_API_TIMEOUT_MS) || 15000;

export type RespostaGithub<T> = { status: number; data: T; headers: Headers };

/** Transporte injetável — os testes exercitam o cliente real contra um stub. */
export type Transporte = (url: string, init: RequestInit) => Promise<Response>;

export type GithubAppDeps = {
  config?: GithubAppConfig | null;
  fetchImpl?: Transporte;
  agora?: () => number;
};

/** Assina o JWT da aplicação (RS256). `iss` = app id; validade de 9 minutos. */
export function assinarAppJwt(cfg: Pick<GithubAppConfig, 'appId' | 'privateKey'>, agora = Date.now()): string {
  const iat = Math.floor(agora / 1000) - 30; // 30s de folga para relógio adiantado
  return jwt.sign({ iat, exp: iat + 9 * 60, iss: cfg.appId }, cfg.privateKey, { algorithm: 'RS256' });
}

let cacheToken: { valor: string; expiraEm: number } | null = null;

export class GithubAppClient {
  private cfg: GithubAppConfig | null;
  private fetchImpl: Transporte;
  private agora: () => number;

  constructor(deps: GithubAppDeps = {}) {
    this.cfg = deps.config ?? null;
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.agora = deps.agora ?? (() => Date.now());
  }

  /** Resolve a config (parâmetro → ambiente → banco cifrado). */
  private async config(): Promise<GithubAppConfig> {
    if (!this.cfg) this.cfg = await obterConfigGithubApp();
    if (!this.cfg) {
      throw new OperationalError('DEPENDENCIA_INDISPONIVEL', 'A GitHub App não está configurada neste servidor.');
    }
    return this.cfg;
  }

  /** Configurada? (para /capabilities, sem revelar valores) */
  async configurada(): Promise<boolean> {
    try {
      await this.config();
      return true;
    } catch {
      return false;
    }
  }

  /** Installation token, com cache até ~5 min antes do vencimento. */
  async installationToken(): Promise<string> {
    if (cacheToken && cacheToken.expiraEm - 5 * 60_000 > this.agora()) return cacheToken.valor;
    const cfg = await this.config();
    const appJwt = assinarAppJwt(cfg, this.agora());
    const res = await this.requisitar<{ token?: string; expires_at?: string }>(
      `/app/installations/${encodeURIComponent(cfg.installationId)}/access_tokens`,
      { method: 'POST' },
      appJwt
    );
    const token = String(res.data?.token ?? '');
    if (res.status >= 300 || !token) {
      throw new OperationalError('GITHUB_INDISPONIVEL', 'Não foi possível obter o token de instalação da GitHub App.');
    }
    const expiraEm = res.data?.expires_at ? new Date(res.data.expires_at).getTime() : this.agora() + 50 * 60_000;
    cacheToken = { valor: token, expiraEm };
    return token;
  }

  /** Limpa o cache (usado quando o GitHub recusa o token com 401). */
  limparCache(): void {
    cacheToken = null;
  }

  /** Requisição autenticada com installation token (renova e repete uma vez em 401). */
  async comInstalacao<T>(caminho: string, init: RequestInit = {}): Promise<RespostaGithub<T>> {
    const token = await this.installationToken();
    const res = await this.requisitar<T>(caminho, init, token);
    if (res.status === 401) {
      this.limparCache();
      const renovado = await this.installationToken();
      return this.requisitar<T>(caminho, init, renovado);
    }
    return res;
  }

  private async requisitar<T>(caminho: string, init: RequestInit, bearer: string): Promise<RespostaGithub<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${API_BASE()}${caminho}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': USER_AGENT,
          Authorization: `Bearer ${bearer}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (e) {
      throw new OperationalError('GITHUB_INDISPONIVEL', `Falha de comunicação com o GitHub: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    const texto = await res.text().catch(() => '');
    if (texto) {
      try {
        data = JSON.parse(texto);
      } catch {
        data = texto.slice(0, 500);
      }
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}

/** Instância padrão do processo (cache de token compartilhado). */
export const githubApp = new GithubAppClient();
