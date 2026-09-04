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

/** Erro de API com status HTTP e erros por campo (quando a validação falha). */
export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
  }
}

// Helper de fetch que injeta o token JWT e trata 401 (desloga).
export async function apiFetch<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    const isLoginRequest = path.includes('/auth/login');
    const isOnLoginPage = window.location.pathname === '/login';
    if (!isLoginRequest) {
      clearToken();
      if (!isOnLoginPage) window.location.href = '/login';
    }
    throw new ApiError(401, data?.error || (isLoginRequest ? 'E-mail ou senha incorretos' : 'Sessão expirada'));
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error || 'Erro na requisição', data?.fields);
  }
  return data as T;
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
    throw new ApiError(res.status, data?.error || 'Não foi possível baixar o arquivo.', data?.fields);
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
