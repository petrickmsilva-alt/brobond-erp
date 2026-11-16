import { useEffect, useState, type FormEvent } from 'react';
import { BadgeCheck, Handshake, Mail, MapPin, Phone, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { PageShell } from '../components/ui-kit-negocios';
import { useAuth } from '../auth/AuthContext';

type IdentidadeRepresentante = {
  representante: {
    id: number;
    codigo: string | null;
    nome: string;
    tipo_representante: string | null;
    email: string | null;
    telefone: string | null;
    celular: string | null;
    territorio_id: number | null;
    regiao: string | null;
  };
  empresa_id: number;
  usuario: { nome: string; email: string };
};

export default function RepresentantePortalPage() {
  const [identidade, setIdentidade] = useState<IdentidadeRepresentante | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const { user, refreshMeta } = useAuth();
  const [senhaAtual, setSenhaAtual] = useState('');
  const [senhaNova, setSenhaNova] = useState('');
  const [senhaErro, setSenhaErro] = useState('');
  const [salvandoSenha, setSalvandoSenha] = useState(false);

  useEffect(() => {
    let ativo = true;
    api.get<IdentidadeRepresentante>('/representante/portal/me')
      .then((dados) => { if (ativo) setIdentidade(dados); })
      .catch((e: unknown) => {
        if (ativo) setErro(e instanceof Error ? e.message : 'Não foi possível carregar sua identidade comercial.');
      })
      .finally(() => { if (ativo) setCarregando(false); });
    return () => { ativo = false; };
  }, []);

  async function trocarSenha(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSenhaErro('');
    setSalvandoSenha(true);
    try {
      await api.post('/auth/change-password', { senha_atual: senhaAtual, senha_nova: senhaNova });
      setSenhaAtual('');
      setSenhaNova('');
      await refreshMeta();
    } catch (e) {
      setSenhaErro(e instanceof Error ? e.message : 'Não foi possível atualizar a senha.');
    } finally {
      setSalvandoSenha(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="Portal do Representante"
        description="Seu ambiente comercial Brobond, vinculado à sua identidade e carteira."
      />
      {user?.trocar_senha && (
        <section className="mx-auto mb-6 w-full max-w-2xl rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/30">
          <h2 className="font-semibold text-amber-900 dark:text-amber-200">Atualização obrigatória de senha</h2>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">Antes de acessar sua área comercial, defina uma senha pessoal.</p>
          <form className="mt-4 grid gap-3" onSubmit={trocarSenha}>
            <label className="grid gap-1 text-sm font-medium">Senha atual
              <input type="password" autoComplete="current-password" required value={senhaAtual} onChange={(e) => setSenhaAtual(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
            </label>
            <label className="grid gap-1 text-sm font-medium">Nova senha
              <input type="password" autoComplete="new-password" minLength={12} required value={senhaNova} onChange={(e) => setSenhaNova(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
            </label>
            {senhaErro && <Alert tone="danger">{senhaErro}</Alert>}
            <button type="submit" disabled={salvandoSenha} className="inline-flex w-fit items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900">
              {salvandoSenha ? 'Salvando…' : 'Atualizar senha'}
            </button>
          </form>
        </section>
      )}
      {carregando ? (
        <div className="flex min-h-56 items-center justify-center"><Spinner /></div>
      ) : erro ? (
        <Alert tone="danger">{erro}</Alert>
      ) : identidade ? (
        <div className="mx-auto w-full max-w-4xl space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-start gap-4">
              <div className="rounded-xl bg-slate-100 p-3 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                <Handshake size={28} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold text-slate-950 dark:text-white">{identidade.representante.nome}</h2>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    <BadgeCheck size={14} /> Acesso ativo
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-500">Código {identidade.representante.codigo || 'não informado'} · Empresa vinculada</p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                <Mail size={17} className="text-slate-400" />
                <span>{identidade.representante.email || identidade.usuario.email || 'E-mail não informado'}</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                <Phone size={17} className="text-slate-400" />
                <span>{identidade.representante.celular || identidade.representante.telefone || 'Telefone não informado'}</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                <MapPin size={17} className="text-slate-400" />
                <span>{identidade.representante.regiao || (identidade.representante.territorio_id ? `Território #${identidade.representante.territorio_id}` : 'Território não informado')}</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                <ShieldCheck size={17} className="text-slate-400" />
                <span>Conta autenticada e vinculada</span>
              </div>
            </div>
          </section>
          <section className="rounded-2xl border border-dashed border-slate-300 p-6 dark:border-slate-700">
            <h3 className="font-semibold text-slate-900 dark:text-white">Ambiente comercial</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
              Sua identidade já está vinculada ao cadastro mestre do ERP. As próximas entregas habilitarão sua carteira de clientes, catálogo autorizado, pedidos, cotações e comissões.
            </p>
          </section>
        </div>
      ) : null}
    </PageShell>
  );
}
