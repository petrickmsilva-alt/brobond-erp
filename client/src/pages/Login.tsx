import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Loader2, Lock, Mail, ShieldCheck, Boxes, Cog, Receipt, Smartphone, Copy } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { Alert } from '../components/ui';

export default function Login() {
  const { login, mfaDesafio, concluirLoginMFA, user, loading } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [lembrar, setLembrar] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // MFA: 'mfa' = desafio TOTP; 'setup' = cadastro obrigatório (administradores);
  // 'codigos' = exibe os códigos de recuperação recém-emitidos (exibição única).
  const [etapa, setEtapa] = useState<'form' | 'mfa' | 'setup' | 'codigos'>('form');
  const [modoCodigo, setModoCodigo] = useState<'totp' | 'backup'>('totp');
  const [codigosRecuperacao, setCodigosRecuperacao] = useState<string[] | null>(null);
  const [ticket, setTicket] = useState('');
  const [codigo, setCodigo] = useState('');
  const [qr, setQr] = useState('');
  const [segredo, setSegredo] = useState('');
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    if (!loading && user) nav('/', { replace: true });
  }, [user, loading, nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await login(email, password, lembrar);
      if (r.mfa_required && r.mfa_ticket) {
        setTicket(r.mfa_ticket);
        setEtapa('mfa');
        return;
      }
      if (r.mfa_setup_required && r.mfa_ticket) {
        setTicket(r.mfa_ticket);
        setQr('');
        setSegredo('');
        setEtapa('setup');
        return;
      }
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e.message || 'Falha no login');
    } finally {
      setBusy(false);
    }
  }

  /** Busca o QR/segredo quando a etapa de cadastro MFA abre. */
  useEffect(() => {
    if (etapa !== 'setup' || qr || segredo) return;
    (async () => {
      try {
        const d = await mfaDesafio(ticket);
        setQr(d.qr);
        setSegredo(d.segredo);
      } catch (e: any) {
        setErr(e.message || 'Não foi possível carregar o QR do autenticador.');
      }
    })();
  }, [etapa, ticket, qr, segredo, mfaDesafio]);

  function formatarBackup(v: string): string {
    const limpo = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return limpo.length > 4 ? `${limpo.slice(0, 4)}-${limpo.slice(4)}` : limpo;
  }

  const codigoValido = modoCodigo === 'totp' ? codigo.length === 6 : codigo.replace(/[^A-Z0-9]/gi, '').length === 8;

  async function confirmarCodigo(e?: React.FormEvent) {
    e?.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const d = await concluirLoginMFA(ticket, codigo);
      // 1ª ativação: o servidor emite os códigos de recuperação junto —
      // é a única chance de guardá-los.
      if (etapa === 'setup' && d.mfa_backup_codigos?.length) {
        setCodigosRecuperacao(d.mfa_backup_codigos);
        setEtapa('codigos');
        return;
      }
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e.message || 'Código inválido.');
    } finally {
      setBusy(false);
    }
  }

  function voltar() {
    setEtapa('form');
    setModoCodigo('totp');
    setCodigo('');
    setErr('');
    setQr('');
    setSegredo('');
    setCodigosRecuperacao(null);
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
        {(etapa === 'mfa' || etapa === 'setup') && (
          <form onSubmit={confirmarCodigo} className="w-full max-w-sm animate-fade-in" noValidate>
            <div className="mb-8 flex justify-center lg:hidden">
              <Logo height={56} />
            </div>

            <h2 className="flex items-center gap-2 text-2xl font-bold text-navy-900">
              <Smartphone className="h-6 w-6 text-brand-500" /> Verificação em dois fatores
            </h2>

            {etapa === 'mfa' ? (
              <p className="mt-1 text-sm text-slate-500">Digite o código de 6 dígitos do seu app autenticador para concluir o acesso.</p>
            ) : (
              <div className="mt-1 text-sm text-slate-500">
                <p>
                  <strong>Sua conta de administrador exige MFA.</strong> Escaneie o QR abaixo com um app autenticador (Google Authenticator, Aegis, 1Password…) e
                  informe o código atual para ativar e entrar.
                </p>
                <div className="mt-4 flex flex-col items-center gap-3">
                  {qr ? (
                    <img src={qr} alt="QR Code do autenticador" className="h-48 w-48 rounded-lg border border-slate-200 bg-white p-1" />
                  ) : (
                    <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-slate-200 text-slate-400">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  )}
                  {segredo && (
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs text-slate-500 underline-offset-2 hover:underline"
                      onClick={async () => {
                        await navigator.clipboard.writeText(segredo);
                        setCopiado(true);
                        window.setTimeout(() => setCopiado(false), 2000);
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" /> {copiado ? 'Segredo copiado!' : 'Copiar segredo manualmente'}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="mt-6 space-y-5">
              {etapa === 'mfa' && (
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm" role="tablist" aria-label="Tipo de código">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={modoCodigo === 'totp'}
                    className={`rounded-md px-2 py-1.5 font-medium ${modoCodigo === 'totp' ? 'bg-white shadow text-navy-900' : 'text-slate-500'}`}
                    onClick={() => {
                      setModoCodigo('totp');
                      setCodigo('');
                      setErr('');
                    }}
                  >
                    App autenticador
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={modoCodigo === 'backup'}
                    className={`rounded-md px-2 py-1.5 font-medium ${modoCodigo === 'backup' ? 'bg-white shadow text-navy-900' : 'text-slate-500'}`}
                    onClick={() => {
                      setModoCodigo('backup');
                      setCodigo('');
                      setErr('');
                    }}
                  >
                    Recuperação
                  </button>
                </div>
              )}
              <div>
                <label htmlFor="mfa-codigo" className="label">
                  {modoCodigo === 'totp' ? 'Código do app autenticador' : 'Código de recuperação'}
                </label>
                {modoCodigo === 'totp' ? (
                  <input
                    id="mfa-codigo"
                    className="input text-center font-mono text-lg tracking-[0.4em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    value={codigo}
                    onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
                    autoFocus
                  />
                ) : (
                  <>
                    <input
                      id="mfa-codigo"
                      className="input text-center font-mono text-lg tracking-[0.2em]"
                      autoComplete="off"
                      maxLength={9}
                      placeholder="XXXX-XXXX"
                      value={codigo}
                      onChange={(e) => setCodigo(formatarBackup(e.target.value))}
                      autoFocus
                    />
                    <p className="mt-1 text-xs text-slate-400">Sem o celular? Cada código de recuperação vale um acesso. Gerencie os seus em Configurações → MFA.</p>
                  </>
                )}
              </div>

              {err && <Alert tone="red">{err}</Alert>}

              <button disabled={busy || !codigoValido} className="btn-primary w-full py-2.5">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {busy ? 'Verificando...' : etapa === 'mfa' ? 'Concluir acesso' : 'Ativar MFA e entrar'}
              </button>

              <button type="button" className="w-full text-center text-xs text-slate-400 hover:text-slate-600" onClick={voltar}>
                Voltar para o login
              </button>
            </div>
          </form>
        )}

        {etapa === 'codigos' && codigosRecuperacao && (
          <div className="w-full max-w-sm animate-fade-in">
            <div className="mb-8 flex justify-center lg:hidden">
              <Logo height={56} />
            </div>
            <h2 className="flex items-center gap-2 text-2xl font-bold text-navy-900">
              <KeyRound className="h-6 w-6 text-brand-500" /> Guarde os códigos de recuperação
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Seu MFA está ativado. Estes <strong>10 códigos</strong> são o seu acesso reserva — cada um vale <strong>um login</strong> sem o celular. Eles aparecem{' '}
              <strong>somente agora</strong>.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-3">
              {codigosRecuperacao.map((c) => (
                <span key={c} className="rounded-md bg-white px-2 py-1.5 text-center font-mono text-sm font-semibold tracking-wider text-navy-900 ring-1 ring-slate-200">
                  {c}
                </span>
              ))}
            </div>
            <div className="mt-4 space-y-2.5">
              <button
                type="button"
                className="btn-secondary w-full py-2"
                onClick={async () => {
                  await navigator.clipboard.writeText(codigosRecuperacao.join('\n'));
                  setCopiado(true);
                  window.setTimeout(() => setCopiado(false), 2000);
                }}
              >
                <Copy className="h-4 w-4" /> {copiado ? 'Códigos copiados!' : 'Copiar os 10 códigos'}
              </button>
              <button className="btn-primary w-full py-2.5" onClick={() => nav('/', { replace: true })}>
                Guardei — entrar no sistema
              </button>
            </div>
          </div>
        )}

        {etapa === 'form' && (
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
                  title={show ? 'Ocultar senha' : 'Mostrar senha'}
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

            <label className="flex cursor-pointer items-center justify-between gap-2 text-sm text-slate-600">
              <span className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400" checked={lembrar} onChange={(e) => setLembrar(e.target.checked)} />
                Lembrar-me por 30 dias
              </span>
              <span className="text-xs text-slate-400">neste dispositivo</span>
            </label>

            <button disabled={busy || !email || !password} className="btn-primary w-full py-2.5">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? 'Entrando...' : 'Entrar'}
            </button>
          </div>

          <p className="mt-8 text-center text-xs text-slate-400">
            Esqueceu a senha? <Link to="/esqueci" className="font-medium text-navy-700 underline-offset-2 hover:underline">Solicite um link de redefinição</Link> — ou peça ao administrador.
          </p>
        </form>
        )}
      </div>
    </div>
  );
}
