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
import { createHash } from 'node:crypto';
import { log } from '../../../server/src/log';
import { OperationalError } from '../domain/errors';
import { resolverConfigGithubApp, type GithubAppConfig } from './token-vault';

const API_BASE = () => String(process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(/\/+$/, '');
const USER_AGENT = 'brobond-operational-control';
const timeoutMs = () => { const n = Number(process.env.GITHUB_API_TIMEOUT_MS); return Number.isFinite(n) && n >= 100 && n <= 120000 ? n : 15000; };

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

export class GithubAppClient {
  private cfg: GithubAppConfig | null;
  private cacheToken: { valor: string; expiraEm: number; fingerprint: string } | null = null;
  private fetchImpl: Transporte;
  private agora: () => number;

  constructor(deps: GithubAppDeps = {}) {
    this.cfg = deps.config ?? null;
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.agora = deps.agora ?? (() => Date.now());
  }

  /** Resolve a config (parâmetro → ambiente → banco cifrado). */
  private async config(): Promise<GithubAppConfig> {
    if (this.cfg) return this.cfg;
    const { config, diagnostico } = await resolverConfigGithubApp();
    if (!config) {
      this.cacheToken = null;
      log.warn('github_app_config_indisponivel', { ...diagnostico });
      throw new OperationalError('DEPENDENCIA_INDISPONIVEL', 'Configuração da GitHub App indisponível ou inválida; consulte o diagnóstico seguro do servidor.');
    }
    return config;
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
    const cfg = await this.config();
    // Cache pertence à instância e é invalidado quando identidade ou chave mudam.
    const fingerprint = createHash('sha256').update(JSON.stringify([cfg.appId, cfg.installationId, cfg.privateKey])).digest('hex');
    if (this.cacheToken && this.cacheToken.fingerprint === fingerprint && this.cacheToken.expiraEm - 5 * 60_000 > this.agora()) return this.cacheToken.valor;
    this.cacheToken = null;
    let appJwt: string;
    try { appJwt = assinarAppJwt(cfg, this.agora()); }
    catch { throw new OperationalError('DEPENDENCIA_INDISPONIVEL', 'Não foi possível assinar o JWT da GitHub App com a chave configurada.'); }
    const res = await this.requisitar<{ token?: string; expires_at?: string }>(
      `/app/installations/${encodeURIComponent(cfg.installationId)}/access_tokens`,
      { method: 'POST' },
      appJwt
    );
    const token = String(res.data?.token ?? '');
    if (res.status >= 300 || !token) {
      const motivo = res.status === 401 ? 'autenticação da App recusada' : res.status === 403 ? 'acesso da App negado' : res.status === 404 ? 'instalação não encontrada ou inacessível' : res.status === 422 ? 'pedido de token inválido' : 'erro da API';
      log.warn('github_app_token_falhou', { etapa: 'installation_token', status: res.status, motivo });
      throw new OperationalError('GITHUB_INDISPONIVEL', `GitHub: ${motivo} (HTTP ${res.status}).`);
    }
    const expiraEm = res.data?.expires_at ? new Date(res.data.expires_at).getTime() : this.agora() + 50 * 60_000;
    if (!Number.isFinite(expiraEm) || expiraEm <= this.agora()) throw new OperationalError('GITHUB_INDISPONIVEL', 'GitHub retornou expiração inválida para o token de instalação.');
    this.cacheToken = { valor: token, expiraEm, fingerprint };
    return token;
  }

  /** Limpa o cache (usado quando o GitHub recusa o token com 401). */
  limparCache(): void {
    this.cacheToken = null;
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
    const timer = setTimeout(() => controller.abort(), timeoutMs());
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
    } catch {
      const motivo = controller.signal.aborted ? 'timeout' : 'indisponibilidade externa';
      log.warn('github_api_indisponivel', { motivo });
      throw new OperationalError('GITHUB_INDISPONIVEL', `Falha de comunicação com o GitHub: ${motivo}.`);
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

/** Instância padrão do processo (cache de token isolado por cliente). */
export const githubApp = new GithubAppClient();
