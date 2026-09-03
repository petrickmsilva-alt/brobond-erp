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
