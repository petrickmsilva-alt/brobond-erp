import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, apiFetch, clearToken, getToken, setToken } from '../lib/api';
import { MetaContext, type Meta } from '../lib/meta';
import { setSentryUser } from '../lib/sentry';

export type Perfil = 'admin' | 'gerente' | 'operador';
export type User = {
  id: number;
  name: string;
  email: string;
  perfil: Perfil;
  /** senha padrão/legada: o sistema pede a troca no primeiro acesso */
  trocar_senha?: boolean;
  lembrar?: boolean;
  perm_catalogos?: string;
  perm_compartilhar?: string;
  perm_metricas?: string;
  perm_politicas?: string;
  perm_aprovar?: string;
  desconto_max_pct?: number | null;
  venda_sem_aprovacao_ate?: number | null;
};

type AuthContextValue = {
  user: User | null;
  meta: Meta | null;
  /** 1º passo do login; quando o usuário tem/precisa de MFA, devolve o ticket em vez de entrar. */
  login: (email: string, password: string, lembrar?: boolean) => Promise<{ mfa_required?: boolean; mfa_setup_required?: boolean; mfa_ticket?: string }>;
  /** QR + segredo para o cadastro TOTP guiado (exige o ticket do 1º passo). */
  mfaDesafio: (ticket: string) => Promise<{ segredo: string; uri: string; qr: string }>;
  /** 2º passo do login (código TOTP ou de recuperação) — conclui a sessão. Na 1ª ativação devolve os códigos de recuperação. */
  concluirLoginMFA: (ticket: string, codigo: string) => Promise<{ mfa_backup_codigos?: string[]; mfa_backup_restantes?: number }>;

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
    setMeta({
      resources: m.resources,
      mode: m.mode,
      uploads: m.uploads,
      uploadsConfigError: m.uploadsConfigError,
      version: m.version,
      smtp: m.smtp,
    });
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

  async function login(email: string, password: string, lembrar = false) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
      throw new Error('E-mail e senha são obrigatórios');
    }
    const d = await api.post('/auth/login', { email: normalizedEmail, password, lembrar });
    // MFA: senha aceita, mas o login só termina com o código TOTP.
    if (d.mfa_required || d.mfa_setup_required) {
      return { mfa_required: d.mfa_required, mfa_setup_required: d.mfa_setup_required, mfa_ticket: d.mfa_ticket };
    }
    if (!d.token || !d.user) throw new Error('Resposta inválida do servidor');
    setToken(d.token);
    setUser(d.user);
    setSentryUser(d.user);
    await refreshMeta();
    return {};
  }

  async function mfaDesafio(ticket: string) {
    return api.post<{ segredo: string; uri: string; qr: string }>('/auth/mfa/desafio', { mfa_ticket: ticket });
  }

  async function concluirLoginMFA(ticket: string, codigo: string) {
    const d = await api.post('/auth/login/mfa', { mfa_ticket: ticket, codigo });
    if (!d.token || !d.user) throw new Error('Resposta inválida do servidor');
    setToken(d.token);
    setUser(d.user);
    setSentryUser(d.user);
    await refreshMeta();
    return d;
  }

  function logout() {
    clearToken();
    setUser(null);
    setMeta(null);
    setSentryUser(null);
    window.location.href = '/login';
  }

  return (
    <Ctx.Provider value={{ user, meta, login, mfaDesafio, concluirLoginMFA, logout, refreshMeta, loading }}>
      <MetaContext.Provider value={meta}>{children}</MetaContext.Provider>
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return c;
}
