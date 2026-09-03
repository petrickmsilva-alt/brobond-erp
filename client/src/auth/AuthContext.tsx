import { createContext, useContext, useEffect, useState } from 'react';
import { apiFetch, getToken, setToken, clearToken } from '../lib/api';

export type User = { id: number; name: string; email: string };

type AuthContextValue = {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
};

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    apiFetch('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = password.trim();

    if (!normalizedEmail || !normalizedPassword) {
      throw new Error('E-mail e senha são obrigatórios');
    }

    const d = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: normalizedEmail, password: normalizedPassword }),
    });

    if (!d.token || !d.user) {
      throw new Error('Resposta inválida do servidor');
    }

    setToken(d.token);
    setUser(d.user);
  }

  function logout() {
    clearToken();
    setUser(null);
    // Redireciona para login após logout
    window.location.href = '/login';
  }

  return (
    <Ctx.Provider value={{ user, login, logout, loading }}>{children}</Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return c;
}
