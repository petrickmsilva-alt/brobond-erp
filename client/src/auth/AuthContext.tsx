import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, apiFetch, clearToken, getToken, setToken } from '../lib/api';
import { MetaContext, type Meta } from '../lib/meta';

export type Perfil = 'admin' | 'gerente' | 'operador';
export type User = { id: number; name: string; email: string; perfil: Perfil };

type AuthContextValue = {
  user: User | null;
  meta: Meta | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMeta: () => Promise<void>;
  loading: boolean;
};

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMeta = useCallback(async () => {
    const m = await api.get<Meta & { user: User }>('/meta');
    setMeta({ resources: m.resources, mode: m.mode });
    if (m.user) setUser(m.user);
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    apiFetch('/auth/me')
      .then(async (d) => {
        setUser(d.user);
        await refreshMeta();
      })
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [refreshMeta]);

  async function login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = password.trim();
    if (!normalizedEmail || !normalizedPassword) {
      throw new Error('E-mail e senha são obrigatórios');
    }
    const d = await api.post('/auth/login', { email: normalizedEmail, password: normalizedPassword });
    if (!d.token || !d.user) throw new Error('Resposta inválida do servidor');
    setToken(d.token);
    setUser(d.user);
    await refreshMeta();
  }

  function logout() {
    clearToken();
    setUser(null);
    setMeta(null);
    window.location.href = '/login';
  }

  return (
    <Ctx.Provider value={{ user, meta, login, logout, refreshMeta, loading }}>
      <MetaContext.Provider value={meta}>{children}</MetaContext.Provider>
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return c;
}
