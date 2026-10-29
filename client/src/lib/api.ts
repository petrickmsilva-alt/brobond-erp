const TOKEN_KEY = 'brobond_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Erro de API com status HTTP, erros por campo e código estável (ex.:
 * 'reauth_necessaria'). `details` carrega dados estruturados do erro — hoje, o
 * diagnóstico de dependências de uma exclusão bloqueada (`{ dependencias }`).
 */
export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  code?: string;
  details?: Record<string, any>;
  constructor(status: number, message: string, fields?: Record<string, string>, code?: string, details?: Record<string, any>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
    this.code = code;
    this.details = details;
  }
}

// Timeout padrão para requisições à API (30s).
const DEFAULT_TIMEOUT_MS = 30_000;

// Helper de fetch que injeta o token JWT, trata 401 (desloga), timeout e retry.
export async function apiFetch<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, DEFAULT_TIMEOUT_MS);
  const external = opts.signal;
  const onAbort = () => controller.abort();
  if (external?.aborted) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  const aborted = () => timedOut
    ? new ApiError(0, 'Tempo limite da requisição excedido. Verifique sua conexão e tente novamente.')
    : new DOMException('Requisição cancelada.', 'AbortError');
  const wait = (ms: number) => new Promise<void>((resolve, reject) => {
    if (controller.signal.aborted) return reject(aborted());
    const stop = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, ms);
    controller.signal.addEventListener('abort', stop, { once: true });
  });
  const method = String(opts.method || 'GET').toUpperCase();
  const maxRetries = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 2 : 0;
  const headers = new Headers(opts.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  let res: Response | undefined;
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (controller.signal.aborted) throw aborted();
      try {
        res = await fetch(`/api${path}`, { ...opts, signal: controller.signal, headers });
        if (res.status < 500 || res.ok || attempt === maxRetries) break;
      } catch (e: any) {
        if (controller.signal.aborted || e?.name === 'AbortError') throw aborted();
        if (attempt === maxRetries) throw new ApiError(0, 'Sem conexão com o servidor. Verifique sua internet e tente novamente.');
      }
      // Apenas leituras seguras são repetidas; abortar durante o backoff
      // interrompe imediatamente em vez de iniciar outra requisição.
      await wait(1000 * Math.pow(2, attempt));
    }
    if (!res) throw new ApiError(0, 'Sem conexão com o servidor.');
    const data = await res.json().catch(() => ({}));
    if (controller.signal.aborted) throw aborted();
    if (res.status === 401) {
      const isLoginRequest = path.includes('/auth/login');
      const isOnLoginPage = window.location.pathname === '/login';
      const isPublicRequest = path.startsWith('/publico/') || path.startsWith('/loja/');
      if (!isLoginRequest && !isPublicRequest && token) {
        clearToken();
        if (!isOnLoginPage) window.location.href = '/login';
      }
      throw new ApiError(401, data?.error || (isLoginRequest ? 'E-mail ou senha incorretos' : 'Sessão expirada'), data?.fields, data?.code, data?.details);
    }
    if (!res.ok) throw new ApiError(res.status, data?.error || 'Erro na requisição', data?.fields, data?.code, data?.details);
    return data as T;
  } finally {
    clearTimeout(timeoutId);
    external?.removeEventListener('abort', onAbort);
  }
}

export const api = {
  get: <T = any>(path: string) => apiFetch<T>(path),
  post: <T = any>(path: string, body: unknown) => apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T = any>(path: string, body: unknown) => apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T = any>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

/**
 * Baixa um arquivo do servidor (exportação CSV/XLSX, backup) com o token JWT
 * e dispara o download no navegador. Usa o Content-Disposition do servidor
 * quando presente.
 */
export async function downloadFile(path: string, fallbackName = 'download'): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error || 'Não foi possível baixar o arquivo.', data?.fields, data?.code, data?.details);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
  const nome = m ? decodeURIComponent(m[1].replace(/"/g, '')) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Lê um arquivo local como texto (CSV) ou base64 (XLSX) para a importação. */
export async function lerArquivoParaImportacao(file: File): Promise<{ conteudo: string; nome: string }> {
  const isXlsx = /\.xlsx?$/i.test(file.name);
  if (isXlsx) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return { conteudo: btoa(bin), nome: file.name };
  }
  return { conteudo: await file.text(), nome: file.name };
}
