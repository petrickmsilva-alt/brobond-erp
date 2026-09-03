import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck, Boxes, Cog, Receipt } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';

export default function Login() {
  const { login, user, loading } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) nav('/', { replace: true });
  }, [user, loading, nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(email, password);
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e.message || 'Falha no login');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
      </div>
    );
  }
  if (user) return null;

  return (
    <div className="grid h-full lg:grid-cols-[1.1fr_1fr]">
      {/* Painel institucional (azul-marinho) */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-navy-900 p-12 text-white lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 h-96 w-96 rounded-full bg-navy-500/30 blur-3xl" />

        <div className="relative">
          <Logo variant="light" height={64} />
        </div>

        <div className="relative max-w-md">
          <h1 className="text-3xl font-bold leading-tight tracking-tight">
            Controle de estoque e produção, <span className="text-brand-400">em um só lugar.</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-navy-200">
            Cadastros, saldo por tamanho e local, ordens de fabricação, compras e vendas — com histórico completo de quem fez o quê.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-navy-100">
            <li className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10"><Boxes className="h-4 w-4 text-brand-400" /></span>
              Estoque físico por produto, grade e local
            </li>
            <li className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10"><Cog className="h-4 w-4 text-brand-400" /></span>
              Ordens de fabricação que alimentam o estoque
            </li>
            <li className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10"><Receipt className="h-4 w-4 text-brand-400" /></span>
              Compras, vendas e comissão de representantes
            </li>
            <li className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10"><ShieldCheck className="h-4 w-4 text-brand-400" /></span>
              Usuários com perfis de acesso e auditoria
            </li>
          </ul>
        </div>

        <div className="relative text-xs text-navy-400">© {new Date().getFullYear()} BROBOND Wear · Sistema de gestão interno</div>
      </div>

      {/* Formulário */}
      <div className="flex items-center justify-center bg-white p-6 sm:p-10">
        <form onSubmit={submit} className="w-full max-w-sm animate-fade-in" noValidate>
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo height={56} />
          </div>

          <h2 className="text-2xl font-bold text-navy-900">Acessar o sistema</h2>
          <p className="mt-1 text-sm text-slate-500">Use o e-mail e a senha cadastrados pelo administrador.</p>

          <div className="mt-8 space-y-5">
            <div>
              <label htmlFor="email" className="label">
                E-mail
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9"
                  placeholder="voce@brobond.com.br"
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="label">
                Senha
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="password"
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9 pr-10"
                  placeholder="Sua senha"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
                  onClick={() => setShow((s) => !s)}
                  tabIndex={-1}
                  aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {err && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                {err}
              </div>
            )}

            <button disabled={busy || !email || !password} className="btn-primary w-full py-2.5">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? 'Entrando...' : 'Entrar'}
            </button>
          </div>

          <p className="mt-8 text-center text-xs text-slate-400">
            Esqueceu a senha? Peça ao administrador para redefini-la em <strong>Configurações › Usuários</strong>.
          </p>
        </form>
      </div>
    </div>
  );
}
