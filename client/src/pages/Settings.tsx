import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Database, Eye, EyeOff, KeyRound, Loader2, Server, ShieldCheck, UserRound, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, PageHeader, useToast } from '../components/ui';

const PERFIL_LABEL: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };
const PERFIL_DESC: Record<string, string> = {
  admin: 'Acesso total, incluindo Usuários e Auditoria.',
  gerente: 'Inclui, altera e exclui em todos os módulos, exceto Usuários e Auditoria.',
  operador: 'Inclui e altera registros, mas não exclui.',
};

export default function Settings() {
  const { user, meta } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (location.hash === '#senha') document.getElementById('senha')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="Configurações" description="Sua conta, senha e informações do sistema." />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Minha conta */}
          <section className="card p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <UserRound className="h-4 w-4 text-navy-400" /> Minha conta
            </h2>
            <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="label">Nome</dt>
                <dd className="text-sm font-medium text-slate-800">{user?.name}</dd>
              </div>
              <div>
                <dt className="label">E-mail</dt>
                <dd className="truncate text-sm font-medium text-slate-800">{user?.email}</dd>
              </div>
              <div>
                <dt className="label">Perfil</dt>
                <dd>
                  <Badge tone={user?.perfil === 'admin' ? 'amber' : user?.perfil === 'gerente' ? 'blue' : 'slate'}>{PERFIL_LABEL[user?.perfil || ''] || user?.perfil}</Badge>
                  <p className="mt-1 text-xs text-slate-500">{PERFIL_DESC[user?.perfil || '']}</p>
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-slate-400">Para alterar nome, e-mail ou perfil, peça a um administrador (Configurações › Usuários).</p>
          </section>

          {/* Trocar senha */}
          <section id="senha" className="card p-5 scroll-mt-6">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <KeyRound className="h-4 w-4 text-navy-400" /> Trocar senha
            </h2>
            <ChangePasswordForm disabled={!user || user.id <= 0} />
          </section>
        </div>

        <div className="space-y-4">
          {/* Sistema */}
          <section className="card p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <Server className="h-4 w-4 text-navy-400" /> Sistema
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Versão</dt>
                <dd className="font-medium text-slate-800">BROBOND ERP {meta?.version ?? ''}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1.5 text-slate-500">
                  <Database className="h-3.5 w-3.5" /> Banco de dados
                </dt>
                <dd>{meta?.mode === 'postgres' ? <Badge tone="green">PostgreSQL</Badge> : <Badge tone="amber">Demonstração (memória)</Badge>}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Fotos</dt>
                <dd>{meta?.uploads === 'cloudinary' ? <Badge tone="green">Cloudinary (CDN)</Badge> : <Badge tone="blue">No banco de dados</Badge>}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1.5 text-slate-500">
                  <ShieldCheck className="h-3.5 w-3.5" /> Senhas
                </dt>
                <dd className="font-medium text-slate-800">bcrypt</dd>
              </div>
            </dl>
            {meta?.mode === 'memory' && (
              <div className="mt-4">
                <Alert tone="amber">Sem <code>DATABASE_URL</code> os dados são apagados ao reiniciar o servidor.</Alert>
              </div>
            )}
          </section>

          {user?.perfil === 'admin' && (
            <section className="card p-5">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <Users className="h-4 w-4 text-navy-400" /> Administração
              </h2>
              <p className="mt-2 text-sm text-slate-500">Cadastre usuários, defina perfis e redefina senhas.</p>
              <div className="mt-3 flex flex-col gap-2">
                <Link to="/usuarios" className="btn-primary justify-start">
                  <Users className="h-4 w-4" /> Gerenciar usuários
                </Link>
                <Link to="/auditoria" className="btn-secondary justify-start">
                  <ShieldCheck className="h-4 w-4" /> Ver auditoria
                </Link>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function ChangePasswordForm({ disabled }: { disabled: boolean }) {
  const toast = useToast();
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  function clear() {
    setAtual('');
    setNova('');
    setConfirma('');
    setErrors({});
    setMsg('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const errs: Record<string, string> = {};
    if (!atual) errs.senha_atual = 'Informe a senha atual';
    if (nova.length < 6) errs.senha_nova = 'Mínimo de 6 caracteres';
    if (nova !== confirma) errs.confirma = 'As senhas não conferem';
    if (nova && nova === atual) errs.senha_nova = 'A nova senha deve ser diferente da atual';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    try {
      await api.post('/auth/change-password', { senha_atual: atual, senha_nova: nova });
      toast.success('Senha alterada com sucesso.');
      clear();
    } catch (e: any) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      setMsg(e.message || 'Não foi possível alterar a senha.');
    } finally {
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';

  return (
    <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
      {disabled && <Alert tone="slate">O acesso de emergência não permite trocar a senha por aqui.</Alert>}
      {msg && <Alert tone="red">{msg}</Alert>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="senha_atual">
            Senha atual
          </label>
          <input id="senha_atual" type={type} className={`input ${errors.senha_atual ? 'input-error' : ''}`} value={atual} onChange={(e) => setAtual(e.target.value)} autoComplete="current-password" disabled={disabled || busy} />
          {errors.senha_atual && <p className="mt-1 text-xs font-medium text-red-600">{errors.senha_atual}</p>}
        </div>
        <div>
          <label className="label" htmlFor="senha_nova">
            Nova senha
          </label>
          <input id="senha_nova" type={type} className={`input ${errors.senha_nova ? 'input-error' : ''}`} value={nova} onChange={(e) => setNova(e.target.value)} autoComplete="new-password" disabled={disabled || busy} />
          {errors.senha_nova ? <p className="mt-1 text-xs font-medium text-red-600">{errors.senha_nova}</p> : <p className="mt-1 text-xs text-slate-400">Mínimo de 6 caracteres.</p>}
        </div>
        <div>
          <label className="label" htmlFor="confirma">
            Confirmar nova senha
          </label>
          <input id="confirma" type={type} className={`input ${errors.confirma ? 'input-error' : ''}`} value={confirma} onChange={(e) => setConfirma(e.target.value)} autoComplete="new-password" disabled={disabled || busy} />
          {errors.confirma && <p className="mt-1 text-xs font-medium text-red-600">{errors.confirma}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={() => setShow((s) => !s)}>
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {show ? 'Ocultar senhas' : 'Mostrar senhas'}
        </button>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={clear} disabled={busy}>
            Limpar
          </button>
          <button type="submit" className="btn-primary" disabled={disabled || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar nova senha
          </button>
        </div>
      </div>
    </form>
  );
}
