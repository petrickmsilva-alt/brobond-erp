import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';

const DEMO = { email: 'admin@brobond.com.br', password: 'brobond123' };

export default function Login() {
  const { login, user, loading } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState(DEMO.email);
  const [password, setPassword] = useState(DEMO.password);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Se já estiver logado, redireciona para dashboard
  useEffect(() => {
    if (!loading && user) {
      nav('/', { replace: true });
    }
  }, [user, loading, nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(email, password);
      // Navega para dashboard após login bem-sucedido
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e.message || 'Falha no login');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center text-slate-400">Carregando...</div>;
  }

  // Evita flash da tela de login se já estiver autenticado
  if (user) {
    return null;
  }

  return (
    <div className="h-full grid md:grid-cols-2">
      <div className="hidden md:flex flex-col justify-center items-center bg-gradient-to-br from-brand-700 to-brand-500 text-white p-10">
        <Logo />
        <h1 className="mt-6 text-3xl font-bold text-center">
          Controle de Estoque & Produção
        </h1>
        <p className="mt-2 text-slate-300 text-center max-w-sm">
          Gestão completa da BROBOND: insumos, fabricação, custo e vendas em um
          só lugar.
        </p>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <div className="md:hidden flex justify-center">
            <Logo />
          </div>
          <h2 className="text-xl font-bold text-slate-800">Entrar</h2>

          <div>
            <label className="block text-sm text-slate-600 mb-1">E-mail</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-orange-400"
              autoComplete="email"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-slate-600 mb-1">Senha</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-orange-400"
              autoComplete="current-password"
              required
            />
          </div>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm px-3 py-2 rounded-lg">
              {err}
            </div>
          )}

          <button
            disabled={busy}
            className="w-full py-2.5 rounded-lg bg-brand-600 text-white font-semibold hover:bg-brand-700 disabled:opacity-60 transition-colors"
          >
            {busy ? 'Entrando...' : 'Entrar'}
          </button>

          <p className="text-xs text-slate-400 text-center">
            Acesso demo: {DEMO.email} / {DEMO.password}
          </p>
        </form>
      </div>
    </div>
  );
}
