// ============================================================================
// MOTOR DE FRETE › CAMADA DE TRANSPORTADORAS › HTTP SEGURO
//
// Toda chamada externa do módulo passa por aqui. Concentrar isto num único
// lugar é o que torna as garantias auditáveis:
//
//   • TIMEOUT em toda requisição (AbortSignal.timeout) — nenhuma chamada
//     externa pode prender um worker;
//   • RETRY com backoff exponencial APENAS em falha transitória (rede/5xx),
//     nunca em 4xx (recusa do operador é decisão, não instabilidade);
//   • SSRF: a URL de destino precisa ser http(s) pública — endereços internos
//     são recusados antes de qualquer conexão (ver urlPublica.hostInterno);
//   • LIMITE de corpo: a resposta é lida com teto de bytes;
//   • o corpo remoto NUNCA é propagado em mensagem de erro (pode carregar
//     credencial, token ou PII);
//   • LOGS sem segredo: só status, host e duração.
// ============================================================================
import { hostInterno } from '../../../server/src/urlPublica';
import { sleep } from '../../../server/src/utils';

export type OpcoesHttp = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** tentativas ADICIONAIS após a primeira (default: 1) */
  retries?: number;
  fetchImpl?: typeof fetch;
  /** teto de bytes lidos da resposta (default: 1 MiB) */
  maxBytes?: number;
};

export type RespostaHttp = {
  status: number;
  ok: boolean;
  /** corpo já parseado (JSON quando possível, senão texto) */
  body: unknown;
  /** corpo cru em texto (para validar assinatura/guardar evidência) */
  texto: string;
};

export class HttpExternaError extends Error {
  constructor(
    message: string,
    readonly transitorio: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'HttpExternaError';
  }
}

const TIMEOUT_PADRAO_MS = 15_000;
const MAX_BYTES_PADRAO = 1_048_576;
const MAX_RETRIES = 3;

/** Recusa destino não-http(s) ou apontando para rede interna (SSRF). */
export function validarDestinoExterno(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpExternaError('URL externa inválida.', false);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpExternaError('Apenas http(s) é permitido para chamadas externas.', false);
  }
  if (hostInterno(parsed.hostname)) {
    throw new HttpExternaError(`Destino aponta para rede interna (${parsed.hostname}) — recusado por segurança.`, false);
  }
}

function backoffMs(tentativa: number): number {
  // 250ms, 500ms, 1000ms — com jitter para não sincronizar réplicas.
  const base = 250 * 2 ** tentativa;
  const jitter = Math.floor(Math.random() * 100);
  return base + jitter;
}

/**
 * Executa uma chamada HTTP externa com timeout, retry e SSRF guard.
 * Lança `HttpExternaError` — nunca propaga o corpo remoto.
 */
export async function httpExterno(url: string, opcoes: OpcoesHttp = {}): Promise<RespostaHttp> {
  validarDestinoExterno(url);
  const metodo = opcoes.method ?? 'GET';
  const timeoutMs = Math.min(Math.max(Number(opcoes.timeoutMs) || TIMEOUT_PADRAO_MS, 500), 60_000);
  const maxBytes = Math.min(Math.max(Number(opcoes.maxBytes) || MAX_BYTES_PADRAO, 1024), 8 * 1024 * 1024);
  const retries = Math.min(Math.max(Number(opcoes.retries ?? 1), 0), MAX_RETRIES);
  const doFetch = opcoes.fetchImpl ?? fetch;

  let ultimoErro: HttpExternaError = new HttpExternaError('Falha externa desconhecida.', true);
  for (let tentativa = 0; tentativa <= retries; tentativa++) {
    try {
      const resp = await doFetch(url, {
        method: metodo,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: 'application/json',
          ...(opcoes.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(opcoes.headers ?? {}),
        },
        ...(opcoes.body === undefined ? {} : { body: typeof opcoes.body === 'string' ? opcoes.body : JSON.stringify(opcoes.body) }),
      });
      const texto = await lerLimitado(resp, maxBytes);
      let body: unknown = texto;
      try {
        body = texto ? JSON.parse(texto) : null;
      } catch {
        body = texto;
      }
      // 5xx e 429 são transitórios; 4xx é recusa definitiva.
      if (resp.status >= 500 || resp.status === 429) {
        ultimoErro = new HttpExternaError(`O operador respondeu ${resp.status}.`, true, resp.status);
        if (tentativa < retries) {
          await sleep(backoffMs(tentativa));
          continue;
        }
        throw ultimoErro;
      }
      return { status: resp.status, ok: resp.ok, body, texto };
    } catch (e) {
      if (e instanceof HttpExternaError) {
        if (!e.transitorio) throw e;
        ultimoErro = e;
      } else {
        // Timeout/abort/erro de rede → transitório.
        ultimoErro = new HttpExternaError('Falha de rede ao falar com o operador.', true);
      }
      if (tentativa < retries) {
        await sleep(backoffMs(tentativa));
        continue;
      }
    }
  }
  throw ultimoErro;
}

/** Lê o corpo com teto de bytes (evita resposta gigante travar o processo). */
async function lerLimitado(resp: Response, maxBytes: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return (await resp.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8').slice(0, maxBytes);
}
