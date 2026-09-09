// Página pública do convite de acesso: o usuário convidado define a PRÓPRIA
// senha (que nunca passa pelo administrador). Token de uso único, com prazo.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert } from '../components/ui';
import { Logo } from '../components/Logo';
import ForcaSenha, { type PoliticaPublica } from '../components/ForcaSenha';

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <div className="hidden w-1/3 flex-col justify-between bg-navy-900 p-10 text-white lg:flex">
        <Logo variant="light" height={52} withTagline={false} />
        <div>
          <h1 className="text-2xl font-bold leading-tight">Ativação de acesso</h1>
          <p className="mt-3 text-sm text-navy-200">
            Você foi convidado(a) para o BROBOND ERP. Defina agora a sua senha — ela fica protegida por hash Argon2id (irreversível) e nunca é vista por ninguém,
            nem por administradores.
          </p>
          <div className="mt-6 flex items-center gap-2 text-xs text-navy-300">
            <ShieldCheck className="h-4 w-4 text-brand-400" /> BROBOND ERP — v0.6
          </div>
        </div>
        <div className="text-xs text-navy-400">© {new Date().getFullYear()} BROBOND Wear</div>
      </div>
      <div className="flex flex-1 items-center justify-center bg-white p-6 sm:p-10">{children}</div>
    </div>
  );
}

type Info = { nome: string; email: string; expirado: boolean };

export default function Convite() {
  const { token } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState<Info | null>(null);
  const [estado, setEstado] = useState<'carregando' | 'invalido' | 'expirado' | 'pronto' | 'ok'>('carregando');
  const [senha, setSenha] = useState('');
  const [confirma, setConfirma] = useState('');
  const [show, setShow] = useState(false);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const [politica, setPolitica] = useState<PoliticaPublica | undefined>(undefined);

  useEffect(() => {
    (async () => {
      try {
        const d = await api.get<Info>(`/convites/${token}`);
        setInfo(d);
        setEstado(d.expirado ? 'expirado' : 'pronto');
      } catch {
        setEstado('invalido');
      }
      try {
        const p = await api.get<{ politica: PoliticaPublica }>('/auth/politica-senha');
        if (p.politica) setPolitica(p.politica);
      } catch {
        /* sem política: o medidor usa o padrão */
      }
    })();
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErro('');
    if (senha.length < 8) return setErro('A senha deve ter pelo menos 8 caracteres.');
    if (senha !== confirma) return setErro('As senhas não conferem.');
    setBusy(true);
    try {
      await api.post('/convites/aceitar', { token, senha });
      setEstado('ok');
      window.setTimeout(() => nav('/login', { replace: true }), 2600);
    } catch (ex: any) {
      setErro(ex instanceof ApiError ? ex.message : 'Não foi possível concluir. Tente novamente.');
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

        {estado === 'carregando' && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Validando convite...
          </div>
        )}

        {estado === 'expirado' && (
          <div className="space-y-4 text-center">
            <Alert tone="amber">
              <strong>Este convite expirou.</strong> Os convites valem por 48 horas. Peça ao administrador para reenviar o acesso em{' '}
              <strong>Configurações › Usuários</strong> — o novo e-mail chega na hora.
            </Alert>
            <Link to="/login" className="btn-secondary inline-flex">
              Ir para o login
            </Link>
          </div>
        )}

        {estado === 'invalido' && (
          <div className="space-y-4 text-center">
            <Alert tone="red">
              <strong>Não conseguimos validar este link.</strong> Ele pode ter sido usado uma única vez, substituído por um convite mais recente ou cortado pelo
              cliente de e-mail. Peça um novo convite ao administrador do sistema.
            </Alert>
            <Link to="/login" className="btn-secondary inline-flex">
              Ir para o login
            </Link>
          </div>
        )}

        {estado === 'ok' && (
          <div className="space-y-3 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <h2 className="text-xl font-bold text-navy-900">Senha definida!</h2>
            <p className="text-sm text-slate-500">
              Seu acesso está ativo. Você será levado(a) à tela de login em instantes — se o seu usuário é administrador, o sistema pedirá a ativação do MFA no
              primeiro acesso.
            </p>
          </div>
        )}

        {estado === 'pronto' && info && (
          <form onSubmit={submit} noValidate>
            <h2 className="text-2xl font-bold text-navy-900">Olá, {info.nome.split(' ')[0]}!</h2>
            <p className="mt-1 text-sm text-slate-500">
              Defina a sua senha para o e-mail <strong className="text-slate-700">{info.email}</strong>. Ela nunca é exibida nem recuperada — nem por
              administradores.
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="label" htmlFor="convite-senha">
                  Nova senha
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="convite-senha"
                    type={show ? 'text' : 'password'}
                    className="input pl-9 pr-10"
                    autoComplete="new-password"
                    value={senha}
                    onChange={(e) => setSenha(e.target.value)}
                    autoFocus
                    required
                  />
                  <button type="button" tabIndex={-1} className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}>
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <ForcaSenha senha={senha} email={info.email} nome={info.nome} policy={politica} />
              </div>
              <div>
                <label className="label" htmlFor="convite-confirma">
                  Confirmar senha
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="convite-confirma"
                    type={show ? 'text' : 'password'}
                    className="input pl-9"
                    autoComplete="new-password"
                    value={confirma}
                    onChange={(e) => setConfirma(e.target.value)}
                    required
                  />
                </div>
                <p className="mt-1 text-xs text-slate-400">Repita a mesma senha para confirmar.</p>
              </div>

              {erro && <Alert tone="red">{erro}</Alert>}

              <button disabled={busy || !senha || !confirma} className="btn-primary w-full py-2.5">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {busy ? 'Definindo...' : 'Definir senha e ativar acesso'}
              </button>

              <p className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
                <Mail className="h-3.5 w-3.5" /> Já tem acesso?{' '}
                <Link to="/login" className="font-medium text-navy-700 underline-offset-2 hover:underline">
                  Entrar
                </Link>
              </p>
            </div>
          </form>
        )}
      </div>
    </PublicShell>
  );
}
