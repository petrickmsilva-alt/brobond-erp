import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/ui';
import { Logo } from '../components/Logo';

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <div className="hidden w-1/3 flex-col justify-between bg-navy-900 p-10 text-white lg:flex">
        <Logo variant="light" height={52} withTagline={false} />
        <div>
          <h1 className="text-2xl font-bold leading-tight">Recuperação de acesso</h1>
          <p className="mt-3 text-sm text-navy-200">Segurança em primeiro lugar: tokens de redefinição têm validade de 1 hora e senhas ficam sempre com hash bcrypt.</p>
          <div className="mt-6 flex items-center gap-2 text-xs text-navy-300">
            <ShieldCheck className="h-4 w-4 text-brand-400" /> BROBOND ERP — v0.5
          </div>
        </div>
        <div className="text-xs text-navy-400">© {new Date().getFullYear()} BROBOND Wear</div>
      </div>
      <div className="flex flex-1 items-center justify-center bg-white p-6 sm:p-10">{children}</div>
    </div>
  );
}

export function ForgotPage() {
  const { meta } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const [consoleLink, setConsoleLink] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.post('/auth/forgot', { email });
      setDone(true);
      if (!meta?.smtp?.configurado) {
        setConsoleLink('Neste ambiente o link de redefinição aparece no console do servidor (em desenvolvimento) ou você pode pedir ao administrador para redefinir a senha.');
      }
    } catch (ex: any) {
      setErr(ex instanceof ApiError ? ex.message : 'Falha ao enviar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell>
      <div className="w-full max-w-sm animate-fade-in">
        <div className="mb-8 flex justify-center lg:hidden">
          <Logo height={56} />
        </div>
        {done ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <h2 className="mt-4 text-xl font-bold text-navy-900">Verifique seu e-mail</h2>
            <p className="mt-2 text-sm text-slate-500">
              Se existir uma conta para <strong>{email}</strong>, enviamos um link de redefinição válido por 1 hora.
            </p>
            {consoleLink && (
              <div className="mt-4">
                <Alert tone="amber">{consoleLink}</Alert>
              </div>
            )}
            <Link to="/login" className="btn-primary mt-6 w-full justify-center">
              Voltar para o login
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5" noValidate>
            <h2 className="text-2xl font-bold text-navy-900">Esqueci minha senha</h2>
            <p className="text-sm text-slate-500">Digite o e-mail cadastrado. Você receberá um link para criar uma nova senha.</p>
            {err && <Alert tone="red">{err}</Alert>}
            <div>
              <label className="label" htmlFor="email">
                E-mail
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input id="email" type="email" className="input pl-9" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@brobond.com.br" autoFocus required />
              </div>
            </div>
            <button className="btn-primary w-full justify-center py-2.5" disabled={busy || !email}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enviar link de redefinição
            </button>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-slate-500 hover:text-navy-800">
              <ArrowLeft className="h-4 w-4" /> Voltar para o login
            </Link>
          </form>
        )}
      </div>
    </PublicShell>
  );
}

export function ResetPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [senha, setSenha] = useState('');
  const [confirma, setConfirma] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (senha.length < 8) return setErr('A nova senha deve ter pelo menos 8 caracteres.');
    if (senha !== confirma) return setErr('As senhas não conferem.');
    setBusy(true);
    try {
      await api.post('/auth/reset', { token, senha });
      setDone(true);
      window.setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (ex: any) {
      setErr(ex instanceof ApiError ? ex.message : 'Não foi possível redefinir a senha.');
    } finally {
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';

  return (
    <PublicShell>
      <div className="w-full max-w-sm animate-fade-in">
        <div className="mb-8 flex justify-center lg:hidden">
          <Logo height={56} />
        </div>
        {done ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <h2 className="mt-4 text-xl font-bold text-navy-900">Senha redefinida!</h2>
            <p className="mt-2 text-sm text-slate-500">Suas outras sessões foram encerradas. Redirecionando para o login...</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5" noValidate>
            <h2 className="text-2xl font-bold text-navy-900">Definir nova senha</h2>
            <p className="text-sm text-slate-500">Este link é válido por 1 hora e só pode ser usado uma vez.</p>
            {err && <Alert tone="red">{err}</Alert>}
            <div className="space-y-4">
              <div>
                <label className="label" htmlFor="nova-senha">
                  Nova senha
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input id="nova-senha" type={type} className="input pl-9 pr-10" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="new-password" autoFocus required />
                  <button type="button" className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400" onClick={() => setShow((s) => !s)} tabIndex={-1} aria-label={show ? 'Ocultar' : 'Mostrar'}>
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-400">Mínimo de 8 caracteres, sem palavras óbvias (senha, 123456, nome da marca...).</p>
              </div>
              <div>
                <label className="label" htmlFor="confirma-senha">
                  Confirmar nova senha
                </label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input id="confirma-senha" type={type} className="input pl-9" value={confirma} onChange={(e) => setConfirma(e.target.value)} autoComplete="new-password" required />
                </div>
              </div>
            </div>
            <button className="btn-primary w-full justify-center py-2.5" disabled={busy || !senha || !confirma}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Redefinir senha
            </button>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-slate-500 hover:text-navy-800">
              <ArrowLeft className="h-4 w-4" /> Voltar para o login
            </Link>
          </form>
        )}
      </div>
    </PublicShell>
  );
}
