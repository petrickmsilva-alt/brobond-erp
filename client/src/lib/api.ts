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

// Helper de fetch que injeta o token JWT e trata 401 (desloga).
export async function apiFetch(path: string, opts: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });

  // Se for 401, só redireciona se NÃO estiver já na página de login
  // Isso evita loop e permite que a tela de login mostre "Credenciais inválidas"
  if (res.status === 401) {
    const isLoginRequest = path.includes('/auth/login');
    const isOnLoginPage = window.location.pathname === '/login';

    // Limpa token apenas se não for tentativa de login
    if (!isLoginRequest) {
      clearToken();
      if (!isOnLoginPage) {
        window.location.href = '/login';
      }
    }

    // Tenta extrair mensagem de erro do body
    const data = await res.json().catch(() => ({}));
    throw new Error((data && data.error) || (isLoginRequest ? 'Credenciais inválidas' : 'Sessão expirada'));
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error) || 'Erro na requisição');
  }
  return data;
}
