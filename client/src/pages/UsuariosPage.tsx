// ============================================================================
// Módulo Usuários — gestão profissional de acesso (ERP).
//
//   • Painel: KPIs + alertas acionáveis (MFA, convites, bloqueios, expiração)
//   • Lista rica: avatar, perfil, status consolidado, acesso, MFA, último login
//   • Filtros server-side (perfil, situação, status, MFA) + busca + ordenação
//   • Ficha do usuário: dados, segurança/sessões e trilha de auditoria
//   • Ciclo de vida: convite, senha temporária (exibição única), ativar/
//     desativar com motivo, desbloquear, encerrar sessões, troca forçada,
//     reset de MFA — ações sensíveis com reautenticação (step-up)
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BellRing,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Inbox,
  KeyRound,
  ListFilter,
  Loader2,
  Lock,
  LockOpen,
  Mail,
  MonitorSmartphone,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldAlert,
  Smartphone,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import type { ListResult } from '../lib/meta';
import { formatDateTime, formatRelative } from '../lib/format';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, EmptyState, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import ReauthModal from '../components/ReauthModal';

type Usuario = Record<string, any>;

type Totais = {
  total: number;
  ativos: number;
  inativos: number;
  admins: number;
  gerentes: number;
  operadores: number;
  convites_pendentes: number;
  convites_expirados: number;
  troca_pendente: number;
  mfa_ativos: number;
  bloqueados: number;
  acesso_expirado: number;
  sem_login_30d: number;
  logins_hoje: number;
  sessoes_ativas: number | null;
};

type Alerta = { tipo: string; usuario_id: number; nome: string; email: string; detalhe: string };

type Atividade = {
  usuario: Usuario;
  criador: { id: number; nome: string; email: string } | null;
  sessoes: { sid: string; criada_em: string; expira_em: string; ip: string | null; user_agent: string | null }[];
  historico: Record<string, any>[];
  historico_total: number;
  acessos: Record<string, any>[];
  acessos_total: number;
  estatisticas: { logins_30d: number; eventos_30d: number; tentativas_falhas: number; ultimo_falha_em: string | null; sessoes_ativas: number };
};

const PAGE_SIZE = 25;

const PERFIL_META: Record<string, { label: string; tone: 'amber' | 'blue' | 'slate' }> = {
  admin: { label: 'Administrador', tone: 'amber' },
  gerente: { label: 'Gerente', tone: 'blue' },
  operador: { label: 'Operador', tone: 'slate' },
};

const STATUS_META: Record<string, { label: string; tone: 'green' | 'blue' | 'amber' | 'red' | 'slate' }> = {
  ativo: { label: 'Ativo', tone: 'green' },
  convite_pendente: { label: 'Convite pendente', tone: 'blue' },
  convite_expirado: { label: 'Convite expirado', tone: 'amber' },
  provisoria: { label: 'Senha provisória', tone: 'amber' },
  bloqueado: { label: 'Bloqueado', tone: 'red' },
  expirado: { label: 'Acesso expirado', tone: 'red' },
  inativo: { label: 'Desativado', tone: 'slate' },
};

const SENHA_META: Record<string, { label: string; tone: 'green' | 'amber' | 'blue' }> = {
  propria: { label: 'Definida pelo usuário', tone: 'green' },
  provisoria: { label: 'Provisória — troca pendente', tone: 'amber' },
  convite_pendente: { label: 'Aguardando convite', tone: 'blue' },
};

const ALERTA_META: Record<string, { label: string; tone: 'amber' | 'red' | 'blue' }> = {
  admin_sem_mfa: { label: 'Admin sem MFA', tone: 'red' },
  bloqueado: { label: 'Bloqueado', tone: 'red' },
  acesso_expirado: { label: 'Acesso expirado', tone: 'red' },
  convite_expirado: { label: 'Convite expirado', tone: 'amber' },
  acesso_a_vencer: { label: 'Acesso a vencer', tone: 'amber' },
};

const AVATAR_BG: Record<string, string> = {
  admin: 'bg-brand-500',
  gerente: 'bg-navy-700',
  operador: 'bg-slate-500',
};

function iniciais(nome: string): string {
  const partes = String(nome || '?').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function Avatar({ nome, perfil, tamanho = 'md' }: { nome: string; perfil: string; tamanho?: 'md' | 'lg' }) {
  const cls = tamanho === 'lg' ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-xs';
  return (
    <span className={`flex ${cls} shrink-0 items-center justify-center rounded-full font-bold text-white ${AVATAR_BG[perfil] || 'bg-slate-500'}`}>
      {iniciais(nome)}
    </span>
  );
}

/** datetime-local (sem fuso) → ISO. */
function toISODateTimeLocal(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** ISO → valor de input datetime-local. */
function fromISO(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function UsuariosPage() {
  const { user: eu } = useAuth();
  const toast = useToast();

  // Painel
  const [resumo, setResumo] = useState<{ totais: Totais; alertas: Alerta[] } | null>(null);
  const [resumoLoading, setResumoLoading] = useState(true);

  // Lista
  const [data, setData] = useState<ListResult<Usuario> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);
  const [showFiltros, setShowFiltros] = useState(false);
  const [fPerfil, setFPerfil] = useState('');
  const [fAtivo, setFAtivo] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fMfa, setFMfa] = useState('');

  // Formulário
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Usuario | null>(null);

  // Ficha
  const [fichaId, setFichaId] = useState<number | null>(null);

  // Fluxos de acesso
  const [senhaTempUser, setSenhaTempUser] = useState<Usuario | null>(null);
  const [senhaTempValor, setSenhaTempValor] = useState('');
  const [conviteLink, setConviteLink] = useState('');
  const [conviteBusyId, setConviteBusyId] = useState<number | null>(null);
  const [reauth, setReauth] = useState<{ tipo: 'senha' | 'desativar' | 'ativar' | 'encerrar' | 'mfa'; row: Usuario; motivo?: string } | null>(null);
  const [desativarRow, setDesativarRow] = useState<Usuario | null>(null);
  const [motivo, setMotivo] = useState('');
  const [acaoBusy, setAcaoBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Usuario | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmAcao, setConfirmAcao] = useState<{ tipo: 'encerrar' | 'mfa' | 'troca' | 'desbloquear'; row: Usuario } | null>(null);

  const filtrosAtivos = [fPerfil, fAtivo, fStatus, fMfa].filter(Boolean).length;

  const paramsAtuais = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set('q', debouncedQ);
    if (sort) {
      params.set('sort', sort.field);
      params.set('dir', sort.dir);
    }
    if (fPerfil) params.set('f.perfil', fPerfil);
    if (fAtivo) params.set('f.ativo', fAtivo);
    if (fStatus) params.set('f.status', fStatus);
    if (fMfa) params.set('f.mfa', fMfa);
    return params.toString();
  }, [debouncedQ, sort, fPerfil, fAtivo, fStatus, fMfa]);

  const carregarResumo = useCallback(async () => {
    setResumoLoading(true);
    try {
      setResumo(await api.get('/usuarios/resumo'));
    } catch {
      setResumo(null);
    } finally {
      setResumoLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<ListResult<Usuario>>(`/usuarios?page=${page}&pageSize=${PAGE_SIZE}${paramsAtuais ? `&${paramsAtuais}` : ''}`);
      setData(d);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / PAGE_SIZE)));
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [page, paramsAtuais]);

  async function recarregarTudo() {
    await Promise.all([load(), carregarResumo()]);
  }

  useEffect(() => {
    carregarResumo();
  }, [carregarResumo]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQ(q.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  function limparFiltros() {
    setFPerfil('');
    setFAtivo('');
    setFStatus('');
    setFMfa('');
    setQ('');
    setDebouncedQ('');
    setPage(1);
  }

  async function exportarLista(formato: 'csv' | 'xlsx') {
    try {
      await downloadFile(`/usuarios/export?format=${formato}&${paramsAtuais}`, `usuarios.${formato}`);
      toast.success(`Exportação ${formato.toUpperCase()} gerada.`);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível exportar.');
    }
  }

  function toggleSort(field: string) {
    setSort((s) => (s?.field === field ? (s.dir === 'asc' ? { field, dir: 'desc' } : null) : { field, dir: 'asc' }));
    setPage(1);
  }

  // ------------------------------------------------------------------
  // Ações de acesso
  // ------------------------------------------------------------------
  async function reenviarConvite(row: Usuario) {
    setConviteBusyId(Number(row.id));
    try {
      const d = await api.post<{ convite_link?: string }>(`/usuarios/${row.id}/reenviar-convite`, {});
      if (d.convite_link) setConviteLink(d.convite_link);
      else toast.success(`Convite reenviado para ${row.email}.`);
      await recarregarTudo();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível reenviar o convite.');
    } finally {
      setConviteBusyId(null);
    }
  }

  /** Executa a ação sensível (chamado após a reautenticação confirmar). */
  async function executarSensivel(a: { tipo: 'senha' | 'desativar' | 'ativar' | 'encerrar' | 'mfa'; row: Usuario; motivo?: string }) {
    const id = Number(a.row.id);
    setAcaoBusy(`${a.tipo}-${id}`);
    try {
      if (a.tipo === 'senha') {
        const d = await api.post<{ senha_temporaria: string }>(`/usuarios/${id}/senha-temporaria`, {});
        setSenhaTempUser(a.row);
        setSenhaTempValor(d.senha_temporaria);
        toast.success(`Senha temporária gerada para ${a.row.email}.`);
      } else if (a.tipo === 'desativar') {
        await api.post(`/usuarios/${id}/desativar`, { motivo: a.motivo || '' });
        toast.success(`${a.row.nome} desativado(a). Sessões encerradas.`);
      } else if (a.tipo === 'ativar') {
        const d = await api.post<{ convite_link?: string }>(`/usuarios/${id}/ativar`, {});
        if (d.convite_link) setConviteLink(d.convite_link);
        else toast.success(`${a.row.nome} reativado(a).`);
      } else if (a.tipo === 'encerrar') {
        const d = await api.post<{ sessoes_encerradas: number }>(`/usuarios/${id}/encerrar-sessoes`, {});
        toast.success(`Sessões encerradas (${d.sessoes_encerradas}).`);
      } else if (a.tipo === 'mfa') {
        await api.post(`/usuarios/${id}/resetar-mfa`, {});
        toast.success(`MFA de ${a.row.email} resetado. O usuário refaz o cadastro no próximo login.`);
      }
      setConfirmAcao(null);
      setFichaId((f) => (f === id ? f : f)); // mantém a ficha aberta; ela recarrega
      await recarregarTudo();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setReauth(a);
        return;
      }
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível concluir a ação.');
    } finally {
      setAcaoBusy(null);
    }
  }

  function pedirSensivel(tipo: 'senha' | 'desativar' | 'ativar' | 'encerrar' | 'mfa', row: Usuario, motivo?: string) {
    setReauth({ tipo, row, motivo });
  }

  async function acaoSimples(tipo: 'desbloquear' | 'troca', row: Usuario) {
    const id = Number(row.id);
    setAcaoBusy(`${tipo}-${id}`);
    try {
      if (tipo === 'desbloquear') {
        await api.post(`/usuarios/${id}/desbloquear`, {});
        toast.success(`${row.nome} desbloqueado(a).`);
      } else {
        await api.post(`/usuarios/${id}/forcar-troca-senha`, {});
        toast.success(`Troca de senha marcada para ${row.email}.`);
      }
      setConfirmAcao(null);
      await recarregarTudo();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível concluir a ação.');
    } finally {
      setAcaoBusy(null);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.del(`/usuarios/${toDelete.id}`);
      toast.success(`${toDelete.nome} excluído(a).`);
      setToDelete(null);
      await recarregarTudo();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível excluir.');
    } finally {
      setDeleting(false);
    }
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, page * PAGE_SIZE);
  const t = resumo?.totais;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Users className="h-5 w-5" />
            </span>
            Usuários
          </span>
        }
        description="Quem acessa o sistema: perfis, convites, senhas, MFA, sessões e ciclo de vida das contas."
        actions={
          <>
            <button className="btn-secondary" onClick={recarregarTudo} disabled={loading} title="Atualizar painel e lista">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
            <button className="btn-secondary" onClick={() => exportarLista('csv')} disabled={loading} title="Exportar a lista atual em CSV (Excel)">
              <Download className="h-4 w-4" />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button className="btn-secondary" onClick={() => exportarLista('xlsx')} disabled={loading} title="Exportar a lista atual em XLSX">
              <Download className="h-4 w-4 text-emerald-600" />
              <span className="hidden md:inline">XLSX</span>
            </button>
            <button
              className="btn-accent"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Novo usuário
            </button>
          </>
        }
      />

      {/* Alertas acionáveis */}
      {resumo && resumo.alertas.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-800">
            <BellRing className="h-4 w-4" /> Atenção necessária ({resumo.alertas.length})
          </p>
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {resumo.alertas.slice(0, 12).map((a) => {
              const meta = ALERTA_META[a.tipo] || { label: a.tipo, tone: 'amber' as const };
              return (
                <li key={`${a.tipo}-${a.usuario_id}`} className="flex min-w-[240px] max-w-[280px] flex-1 flex-col gap-1.5 rounded-lg border border-amber-200 bg-white p-2.5">
                  <div>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </div>
                  <p className="truncate text-sm font-semibold text-navy-900">
                    {a.nome} <span className="block truncate text-xs font-normal text-slate-500">{a.email}</span>
                  </p>
                  <p className="text-xs text-slate-500">{a.detalhe}</p>
                  <button className="btn-secondary mt-auto !px-2 !py-1 text-xs" onClick={() => setFichaId(a.usuario_id)}>
                    <Eye className="h-3.5 w-3.5" /> Ver ficha
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* KPIs */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi
          icone={<UserRound className="h-5 w-5" />}
          cor="bg-navy-800"
          valor={resumoLoading ? null : (t?.ativos ?? 0)}
          rotulo="Ativos"
          dica={t ? `${t.admins} admin · ${t.gerentes} gerente · ${t.operadores} operador` : ''}
          onClick={() => {
            setFAtivo('true');
            setPage(1);
          }}
        />
        <Kpi
          icone={<Mail className="h-5 w-5" />}
          cor="bg-blue-600"
          valor={resumoLoading ? null : (t?.convites_pendentes ?? 0)}
          rotulo="Convites pendentes"
          dica={t?.convites_expirados ? `${t.convites_expirados} expirado(s)` : 'Aguardando aceite'}
          alerta={(t?.convites_expirados ?? 0) > 0}
          onClick={() => {
            setFStatus('convite_pendente');
            setPage(1);
          }}
        />
        <Kpi
          icone={<KeyRound className="h-5 w-5" />}
          cor="bg-brand-500"
          valor={resumoLoading ? null : (t?.troca_pendente ?? 0)}
          rotulo="Troca pendente"
          dica="Senha provisória"
          onClick={() => {
            setFStatus('provisoria');
            setPage(1);
          }}
        />
        <Kpi
          icone={<Smartphone className="h-5 w-5" />}
          cor="bg-emerald-600"
          valor={resumoLoading ? null : (t?.mfa_ativos ?? 0)}
          rotulo="Com MFA"
          dica={t ? `${t.sessoes_ativas ?? '—'} sessões ativas` : ''}
          onClick={() => {
            setFMfa('sim');
            setPage(1);
          }}
        />
        <Kpi
          icone={<Lock className="h-5 w-5" />}
          cor="bg-red-600"
          valor={resumoLoading ? null : (t?.bloqueados ?? 0)}
          rotulo="Bloqueados"
          dica={t?.acesso_expirado ? `${t.acesso_expirado} acesso(s) expirado(s)` : 'Tentativas incorretas'}
          alerta={(t?.bloqueados ?? 0) > 0}
          onClick={() => {
            setFStatus('bloqueado');
            setPage(1);
          }}
        />
        <Kpi
          icone={<MonitorSmartphone className="h-5 w-5" />}
          cor="bg-slate-500"
          valor={resumoLoading ? null : (t?.sem_login_30d ?? 0)}
          rotulo="Parados 30+ dias"
          dica={t ? `${t.logins_hoje} login(s) hoje` : ''}
        />
      </div>

      {/* Filtros */}
      <div className="card mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9 pr-8" placeholder="Buscar por nome, e-mail, cargo..." value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setQ('')} aria-label="Limpar busca">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <select className="input w-auto" value={fPerfil} onChange={(e) => { setFPerfil(e.target.value); setPage(1); }} aria-label="Filtrar por perfil">
            <option value="">Todos os perfis</option>
            <option value="admin">Administrador</option>
            <option value="gerente">Gerente</option>
            <option value="operador">Operador</option>
          </select>
          <select className="input w-auto" value={fAtivo} onChange={(e) => { setFAtivo(e.target.value); setPage(1); }} aria-label="Filtrar por situação">
            <option value="">Ativos e desativados</option>
            <option value="true">Somente ativos</option>
            <option value="false">Somente desativados</option>
          </select>
          <button className={`btn-secondary ${filtrosAtivos ? '!border-brand-400 !text-brand-700' : ''}`} onClick={() => setShowFiltros((v) => !v)}>
            <ListFilter className="h-4 w-4" /> Filtros
            {filtrosAtivos > 0 && <span className="badge ml-1 !bg-brand-500 !text-white">{filtrosAtivos}</span>}
          </button>
          {filtrosAtivos > 0 && (
            <button className="btn-ghost text-xs" onClick={limparFiltros}>
              Limpar
            </button>
          )}
          <div className="ml-auto text-xs text-slate-500">
            {loading && !data ? 'Carregando...' : total === 0 ? 'Nenhum usuário' : `${from}–${to} de ${total} usuário${total === 1 ? '' : 's'}`}
          </div>
        </div>
        {showFiltros && (
          <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="label">Status da conta</span>
              <select className="input" value={fStatus} onChange={(e) => { setFStatus(e.target.value); setPage(1); }}>
                <option value="">Todos</option>
                {Object.entries(STATUS_META).map(([v, m]) => (
                  <option key={v} value={v}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">MFA (dois fatores)</span>
              <select className="input" value={fMfa} onChange={(e) => { setFMfa(e.target.value); setPage(1); }}>
                <option value="">Todos</option>
                <option value="sim">Com MFA ativado</option>
                <option value="nao">Sem MFA</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Lista */}
      <div className="card overflow-hidden">
        {error && (
          <div className="p-4">
            <Alert tone="red">{error}</Alert>
          </div>
        )}
        {!error && loading && !data && <Spinner />}
        {!error && data && data.rows.length === 0 && (
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title={debouncedQ || filtrosAtivos ? 'Nada encontrado' : 'Nenhum usuário cadastrado'}
            description={debouncedQ || filtrosAtivos ? 'Ajuste a busca ou os filtros.' : 'Clique em "Novo usuário" — ele recebe um convite por e-mail para definir a própria senha.'}
            action={
              debouncedQ || filtrosAtivos ? (
                <button className="btn-secondary" onClick={limparFiltros}>
                  Limpar filtros
                </button>
              ) : (
                <button className="btn-accent" onClick={() => { setEditing(null); setFormOpen(true); }}>
                  <Plus className="h-4 w-4" /> Novo usuário
                </button>
              )
            }
          />
        )}

        {!error && data && data.rows.length > 0 && (
          <div className={`hidden overflow-x-auto lg:block ${loading ? 'opacity-60' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <Th label="Usuário" field="nome" sort={sort} onSort={toggleSort} />
                  <Th label="Perfil" field="perfil" sort={sort} onSort={toggleSort} />
                  <th>Status</th>
                  <th>Acesso</th>
                  <th>MFA</th>
                  <Th label="Último acesso" field="ultimo_login" sort={sort} onSort={toggleSort} />
                  <th className="w-44 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const perfil = PERFIL_META[row.perfil] || { label: row.perfil, tone: 'slate' as const };
                  const status = STATUS_META[row.status_conta] || { label: row.status_conta || '—', tone: 'slate' as const };
                  const senha = SENHA_META[row.senha_status] || { label: '—', tone: 'blue' as const };
                  const souEu = eu && Number(eu.id) === Number(row.id);
                  const ativo = row.ativo !== false;
                  return (
                    <tr key={row.id} className={!ativo ? 'opacity-70' : ''}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <Avatar nome={row.nome} perfil={row.perfil} />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-800">
                              {row.nome} {souEu && <span className="text-xs font-normal text-slate-400">(você)</span>}
                            </p>
                            <p className="truncate text-xs text-slate-500">{row.email}</p>
                            {row.cargo && <p className="truncate text-xs text-slate-400">{row.cargo}{row.departamento ? ` · ${row.departamento}` : ''}</p>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <Badge tone={perfil.tone}>{perfil.label}</Badge>
                      </td>
                      <td>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {row.conta_bloqueada && row.bloqueado_ate && (
                          <p className="mt-0.5 text-[11px] text-red-500">até {formatDateTime(row.bloqueado_ate)}</p>
                        )}
                      </td>
                      <td>
                        <Badge tone={senha.tone}>{senha.label}</Badge>
                        {row.tentativas_falhas > 0 && (
                          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-600">
                            <AlertTriangle className="h-3 w-3" /> {row.tentativas_falhas} falha(s)
                          </p>
                        )}
                      </td>
                      <td>
                        {row.mfa_ativado_em ? (
                          <Badge tone="green">Ativado</Badge>
                        ) : (
                          <Badge tone="slate">Não</Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500" title={formatDateTime(row.ultimo_login)}>
                        {row.ultimo_login ? formatRelative(row.ultimo_login) : '—'}
                      </td>
                      <td className="text-right">
                        <div className="inline-flex items-center gap-0.5">
                          <button className="btn-icon" onClick={() => setFichaId(Number(row.id))} title="Ver ficha completa" aria-label="Ver ficha">
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            className="btn-icon"
                            onClick={() => {
                              setEditing(row);
                              setFormOpen(true);
                            }}
                            title="Editar cadastro"
                            aria-label="Editar"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          {!row.senha_definida_em && ativo && (
                            <button
                              className="btn-icon"
                              onClick={() => reenviarConvite(row)}
                              disabled={conviteBusyId === Number(row.id)}
                              title="Reenviar convite de acesso"
                              aria-label="Reenviar convite"
                            >
                              {conviteBusyId === Number(row.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                            </button>
                          )}
                          {!!row.senha_definida_em && ativo && !souEu && (
                            <button
                              className="btn-icon"
                              onClick={() => pedirSensivel('senha', row)}
                              disabled={acaoBusy === `senha-${row.id}`}
                              title="Gerar senha temporária (exibição única)"
                              aria-label="Gerar senha temporária"
                            >
                              {acaoBusy === `senha-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                            </button>
                          )}
                          {!souEu && (
                            ativo ? (
                              <button
                                className="btn-icon hover:!bg-red-50 hover:!text-red-600"
                                onClick={() => {
                                  setDesativarRow(row);
                                  setMotivo('');
                                }}
                                title="Desativar (com motivo)"
                                aria-label="Desativar"
                              >
                                <PowerOff className="h-4 w-4" />
                              </button>
                            ) : (
                              <button
                                className="btn-icon hover:!bg-emerald-50 hover:!text-emerald-600"
                                onClick={() => pedirSensivel('ativar', row)}
                                disabled={acaoBusy === `ativar-${row.id}`}
                                title="Reativar"
                                aria-label="Reativar"
                              >
                                {acaoBusy === `ativar-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Celular: cartões */}
        {!error && data && data.rows.length > 0 && (
          <ul className="divide-y divide-slate-100 lg:hidden">
            {data.rows.map((row) => {
              const perfil = PERFIL_META[row.perfil] || { label: row.perfil, tone: 'slate' as const };
              const status = STATUS_META[row.status_conta] || { label: row.status_conta || '—', tone: 'slate' as const };
              const souEu = eu && Number(eu.id) === Number(row.id);
              const ativo = row.ativo !== false;
              return (
                <li key={row.id} className="px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <Avatar nome={row.nome} perfil={row.perfil} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setFichaId(Number(row.id))}>
                      <p className="truncate text-sm font-semibold text-navy-900">
                        {row.nome} {souEu && <span className="font-normal text-slate-400">(você)</span>}
                      </p>
                      <p className="truncate text-xs text-slate-500">{row.email}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <Badge tone={perfil.tone}>{perfil.label}</Badge>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {row.mfa_ativado_em && <Badge tone="green">MFA</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        {row.ultimo_login ? `Último acesso ${formatRelative(row.ultimo_login)}` : 'Nunca acessou'}
                      </p>
                    </button>
                    <div className="flex shrink-0 flex-col gap-0.5">
                      <button className="btn-icon" onClick={() => { setEditing(row); setFormOpen(true); }} aria-label="Editar">
                        <Pencil className="h-4 w-4" />
                      </button>
                      {!souEu && ativo && (
                        <button
                          className="btn-icon hover:!bg-red-50 hover:!text-red-600"
                          onClick={() => {
                            setDesativarRow(row);
                            setMotivo('');
                          }}
                          aria-label="Desativar"
                        >
                          <PowerOff className="h-4 w-4" />
                        </button>
                      )}
                      {!souEu && !ativo && (
                        <button className="btn-icon hover:!bg-emerald-50 hover:!text-emerald-600" onClick={() => pedirSensivel('ativar', row)} aria-label="Reativar">
                          <Power className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {data && total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5 text-sm">
            <span className="text-slate-500">
              Página {page} de {pages}
            </span>
            <div className="flex items-center gap-1">
              <button className="btn-icon" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Página anterior">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button className="btn-icon" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)} aria-label="Próxima página">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Senhas em hash Argon2id (irreversível) — nunca exibidas. Novos usuários recebem um convite por e-mail (48 h) para definir a própria senha.
        Contas com histórico não são excluídas: desative em vez de apagar.
      </p>

      {/* Celular: FAB */}
      <button
        className="btn-accent fixed bottom-5 right-5 z-40 rounded-full px-4 py-3.5 shadow-modal md:hidden"
        onClick={() => {
          setEditing(null);
          setFormOpen(true);
        }}
        aria-label="Novo usuário"
      >
        <Plus className="h-5 w-5" />
      </button>

      {/* Reautenticação para ações sensíveis */}
      <ReauthModal
        open={!!reauth}
        onClose={() => setReauth(null)}
        onConfirmed={() => {
          if (reauth) void executarSensivel(reauth);
          setReauth(null);
        }}
        titulo={reauth ? tituloReauth(reauth.tipo, reauth.row) : 'Autorização necessária'}
      />

      {/* Desativar com motivo */}
      <Modal
        open={!!desativarRow}
        onClose={() => setDesativarRow(null)}
        title={`Desativar ${desativarRow?.nome || ''}?`}
        subtitle="O acesso é desligado na hora e todas as sessões são encerradas. O histórico é preservado."
        size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setDesativarRow(null)}>
              Cancelar
            </button>
            <button
              className="btn-danger"
              disabled={!motivo.trim()}
              onClick={() => {
                if (!desativarRow) return;
                pedirSensivel('desativar', desativarRow, motivo.trim());
                setDesativarRow(null);
              }}
            >
              Desativar conta
            </button>
          </>
        }
      >
        <label className="block">
          <span className="label">Motivo da desativação *</span>
          <textarea
            className="input"
            rows={3}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ex.: desligamento em 09/09/2026 — saída da loja Centro"
            autoFocus
          />
          <p className="mt-1 text-xs text-slate-400">Obrigatório: fica registrado na auditoria com quem e quando desativou.</p>
        </label>
      </Modal>

      {/* Senha temporária: exibição única */}
      <Modal
        open={!!senhaTempUser && !!senhaTempValor}
        onClose={() => {
          setSenhaTempUser(null);
          setSenhaTempValor('');
        }}
        title="Senha temporária gerada"
        subtitle={senhaTempUser ? `${senhaTempUser.nome} — ${senhaTempUser.email}` : ''}
        size="md"
      >
        <div className="space-y-4">
          <Alert tone="amber">
            <strong>Guarde esta senha agora:</strong> ela é exibida <strong>uma única vez</strong>, não fica salva em lugar nenhum (só o hash irreversível) e não
            pode ser vista depois — nem por administradores. O usuário deverá trocá-la no próximo acesso.
          </Alert>
          <div className="flex gap-2">
            <input className="input flex-1 font-mono" readOnly value={senhaTempValor} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn-secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(senhaTempValor);
                toast.success('Senha copiada. Ela não será exibida novamente.');
              }}
              type="button"
            >
              <Copy className="h-4 w-4" /> Copiar
            </button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">As sessões ativas deste usuário foram encerradas.</p>
            <button
              className="btn-primary"
              onClick={() => {
                setSenhaTempUser(null);
                setSenhaTempValor('');
              }}
              type="button"
            >
              Fechei — não preciso mais dela
            </button>
          </div>
        </div>
      </Modal>

      {/* Convite sem SMTP */}
      <Modal open={!!conviteLink} onClose={() => setConviteLink('')} title="Convite de acesso criado" subtitle="Este ambiente não tem SMTP configurado — entregue o link ao usuário." size="md">
        <div className="space-y-4">
          <Alert tone="blue">
            O convite é válido por <strong>48 horas</strong> e só pode ser usado uma vez. Quem recebe define a própria senha (ela nunca passa pelo administrador).
          </Alert>
          <div className="flex gap-2">
            <input className="input flex-1 font-mono text-xs" readOnly value={conviteLink} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn-secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(conviteLink);
                toast.success('Link do convite copiado.');
              }}
              type="button"
            >
              <Copy className="h-4 w-4" /> Copiar
            </button>
          </div>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={() => setConviteLink('')} type="button">
              Concluído
            </button>
          </div>
        </div>
      </Modal>

      {/* Confirmações (encerrar sessões, reset MFA, troca forçada, desbloqueio) */}
      <ConfirmDialog
        open={!!confirmAcao}
        title={
          confirmAcao?.tipo === 'encerrar'
            ? 'Encerrar todas as sessões?'
            : confirmAcao?.tipo === 'mfa'
              ? 'Resetar o MFA?'
              : confirmAcao?.tipo === 'troca'
                ? 'Forçar troca de senha?'
                : 'Desbloquear acesso?'
        }
        danger={confirmAcao?.tipo === 'encerrar'}
        confirmLabel={confirmAcao?.tipo === 'encerrar' ? 'Encerrar tudo' : confirmAcao?.tipo === 'mfa' ? 'Resetar MFA' : confirmAcao?.tipo === 'troca' ? 'Forçar troca' : 'Desbloquear'}
        busy={!!acaoBusy}
        onCancel={() => setConfirmAcao(null)}
        onConfirm={() => {
          if (!confirmAcao) return;
          if (confirmAcao.tipo === 'encerrar') pedirSensivel('encerrar', confirmAcao.row);
          else if (confirmAcao.tipo === 'mfa') pedirSensivel('mfa', confirmAcao.row);
          else if (confirmAcao.tipo === 'troca') void acaoSimples('troca', confirmAcao.row);
          else void acaoSimples('desbloquear', confirmAcao.row);
          if (confirmAcao.tipo === 'encerrar' || confirmAcao.tipo === 'mfa') setConfirmAcao(null);
        }}
        message={
          confirmAcao?.tipo === 'encerrar' ? (
            <p>
              Todas as sessões de <strong>{confirmAcao.row.nome}</strong> serão derrubadas na hora (todos os dispositivos) e os tokens invalidados. Exige a sua
              senha (reautenticação).
            </p>
          ) : confirmAcao?.tipo === 'mfa' ? (
            <p>
              O MFA de <strong>{confirmAcao.row.nome}</strong> será apagado e as sessões encerradas. No próximo login, o usuário refaz o cadastro do app
              autenticador. Exige a sua senha (reautenticação).
            </p>
          ) : confirmAcao?.tipo === 'troca' ? (
            <p>
              <strong>{confirmAcao.row.nome}</strong> será obrigado(a) a definir uma senha nova no próximo acesso (e só consegue navegar depois da troca).
            </p>
          ) : (
            <p>
              O bloqueio temporário de <strong>{confirmAcao?.row.nome}</strong> será removido e as tentativas falhas zeradas.
            </p>
          )
        }
      />

      {/* Exclusão (só contas virgens) */}
      <ConfirmDialog
        open={!!toDelete}
        title="Excluir usuário?"
        danger
        confirmLabel="Excluir"
        busy={deleting}
        onCancel={() => !deleting && setToDelete(null)}
        onConfirm={confirmDelete}
        message={
          <>
            <p>
              Você está prestes a excluir <strong>{toDelete?.nome}</strong> ({toDelete?.email}). Esta ação não pode ser desfeita.
            </p>
            <p className="mt-2 text-slate-500">
              A exclusão só é permitida para contas que <strong>nunca foram usadas</strong>. Contas com histórico (acessos ou eventos na auditoria) não podem ser
              apagadas — desative em vez disso.
            </p>
          </>
        }
      />

      {/* Cadastro / edição */}
      {formOpen && (
        <UsuarioFormModal
          editing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={(created) => {
            setFormOpen(false);
            if (created?.convite_link) setConviteLink(String(created.convite_link));
            else toast.success(editing ? 'Usuário salvo.' : 'Usuário incluído. Convite de acesso enviado por e-mail.');
            void recarregarTudo();
          }}
        />
      )}

      {/* Ficha do usuário */}
      {fichaId !== null && (
        <FichaUsuarioModal
          id={fichaId}
          souEu={!!eu && Number(eu.id) === fichaId}
          onClose={() => setFichaId(null)}
          onEdit={(row) => {
            setFichaId(null);
            setEditing(row);
            setFormOpen(true);
          }}
          onConvite={reenviarConvite}
          onSensivel={pedirSensivel}
          onConfirmar={setConfirmAcao}
          onExcluir={setToDelete}
          onChanged={recarregarTudo}
          busy={acaoBusy}
          conviteBusyId={conviteBusyId}
        />
      )}
    </div>
  );
}

function tituloReauth(tipo: string, row: Usuario): string {
  const nome = row.nome || row.email || '';
  switch (tipo) {
    case 'senha':
      return `Autorizar senha temporária — ${nome}`;
    case 'desativar':
      return `Autorizar desativação — ${nome}`;
    case 'ativar':
      return `Autorizar reativação — ${nome}`;
    case 'encerrar':
      return `Encerrar sessões — ${nome}`;
    case 'mfa':
      return `Resetar MFA — ${nome}`;
    default:
      return 'Autorização necessária';
  }
}

// ----------------------------------------------------------------------------
// KPI clicável
// ----------------------------------------------------------------------------
function Kpi({
  icone,
  cor,
  valor,
  rotulo,
  dica,
  alerta,
  onClick,
}: {
  icone: React.ReactNode;
  cor: string;
  valor: number | null;
  rotulo: string;
  dica: string;
  alerta?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`card flex items-center gap-3 p-3 text-left sm:p-4 ${alerta ? 'border-red-200 bg-red-50/40' : ''} ${onClick ? 'transition-shadow hover:shadow-modal' : 'cursor-default'}`}
      title={onClick ? 'Clique para filtrar a lista' : undefined}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white sm:h-11 sm:w-11 ${cor}`}>{icone}</span>
      <div className="min-w-0">
        <div className="text-xl font-bold tabular-nums text-navy-900">{valor === null ? <Loader2 className="h-5 w-5 animate-spin text-slate-300" /> : valor}</div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{rotulo}</div>
        <div className="truncate text-xs text-slate-400">{dica}</div>
      </div>
    </button>
  );
}

// ----------------------------------------------------------------------------
// Cabeçalho ordenável
// ----------------------------------------------------------------------------
function Th({ label, field, sort, onSort }: { label: string; field: string; sort: { field: string; dir: 'asc' | 'desc' } | null; onSort: (f: string) => void }) {
  return (
    <th>
      <button className="inline-flex items-center gap-1 hover:text-navy-800" onClick={() => onSort(field)}>
        {label}
        {sort?.field === field ? sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </button>
    </th>
  );
}

// ----------------------------------------------------------------------------
// Cadastro / edição de usuário
// ----------------------------------------------------------------------------
function UsuarioFormModal({ editing, onClose, onSaved }: { editing: Usuario | null; onClose: () => void; onSaved: (created?: Record<string, any>) => void }) {
  const [nome, setNome] = useState(editing?.nome || '');
  const [email, setEmail] = useState(editing?.email || '');
  const [perfil, setPerfil] = useState(editing?.perfil || 'operador');
  const [cargo, setCargo] = useState(editing?.cargo || '');
  const [departamento, setDepartamento] = useState(editing?.departamento || '');
  const [telefone, setTelefone] = useState(editing?.telefone || '');
  const [acessoExpira, setAcessoExpira] = useState(fromISO(editing?.acesso_expira_em));
  const [observacoes, setObservacoes] = useState(editing?.observacoes || '');
  const [trocarSenha, setTrocarSenha] = useState(!!editing?.trocar_senha);
  const [perms, setPerms] = useState<Record<string, string>>({
    perm_catalogos: editing?.perm_catalogos || 'herdar',
    perm_compartilhar: editing?.perm_compartilhar || 'herdar',
    perm_metricas: editing?.perm_metricas || 'herdar',
    perm_politicas: editing?.perm_politicas || 'herdar',
    perm_aprovar: editing?.perm_aprovar || 'herdar',
  });
  const [desconto, setDesconto] = useState(editing?.desconto_max_pct ?? '');
  const [alçada, setAlçada] = useState(editing?.venda_sem_aprovacao_ate ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  function setPerm(k: string, v: string) {
    setPerms((p) => ({ ...p, [k]: v }));
  }

  async function submit() {
    setFormError('');
    const errs: Record<string, string> = {};
    if (!nome.trim()) errs.nome = 'Informe o nome';
    if (!email.trim()) errs.email = 'Informe o e-mail';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) errs.email = 'E-mail inválido';
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Verifique os campos destacados.');
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, any> = {
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        perfil,
        cargo: cargo.trim() || null,
        departamento: departamento.trim() || null,
        telefone: telefone.trim() || null,
        acesso_expira_em: toISODateTimeLocal(acessoExpira) || null,
        observacoes: observacoes.trim() || null,
        ...perms,
        desconto_max_pct: desconto === '' || desconto === null ? null : Number(String(desconto).replace(',', '.')),
        venda_sem_aprovacao_ate: alçada === '' || alçada === null ? null : Number(String(alçada).replace(',', '.')),
      };
      if (editing) payload.trocar_senha = trocarSenha;
      if (editing) {
        await api.put(`/usuarios/${editing.id}`, payload);
        onSaved();
      } else {
        const created = await api.post<Record<string, any>>('/usuarios', payload);
        onSaved(created);
      }
    } catch (e: any) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Editar usuário' : 'Novo usuário'}
      subtitle={editing ? `${editing.nome} — #${editing.id}` : 'O usuário recebe um convite por e-mail (48 h) para definir a própria senha.'}
      size="lg"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {editing ? 'Salvar' : 'Incluir e convidar'}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {formError && <Alert tone="red">{formError}</Alert>}
        {!editing && (
          <Alert tone="blue">
            Nenhuma senha é definida aqui: após incluir, o sistema envia o <strong>convite de acesso</strong> para o e-mail informado. Sem SMTP configurado, o
            link aparece na tela para entrega manual.
          </Alert>
        )}

        <section>
          <h3 className="mb-2 text-sm font-bold text-navy-900">Dados do usuário</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Nome *</span>
              <input className={`input ${errors.nome ? 'input-error' : ''}`} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome completo" maxLength={120} />
              {errors.nome && <p className="mt-1 text-xs font-medium text-red-600">{errors.nome}</p>}
            </label>
            <label className="block">
              <span className="label">E-mail (login) *</span>
              <input className={`input ${errors.email ? 'input-error' : ''}`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@empresa.com.br" maxLength={160} />
              {errors.email && <p className="mt-1 text-xs font-medium text-red-600">{errors.email}</p>}
            </label>
            <label className="block">
              <span className="label">Perfil *</span>
              <select className="input" value={perfil} onChange={(e) => setPerfil(e.target.value)}>
                <option value="operador">Operador — inclui e altera, não exclui</option>
                <option value="gerente">Gerente — tudo, exceto usuários</option>
                <option value="admin">Administrador — acesso total (MFA obrigatório)</option>
              </select>
            </label>
            <label className="block">
              <span className="label">Telefone / WhatsApp</span>
              <input className="input" value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="(11) 99999-9999" maxLength={20} />
            </label>
            <label className="block">
              <span className="label">Cargo / função</span>
              <input className="input" value={cargo} onChange={(e) => setCargo(e.target.value)} placeholder="Ex.: Vendedora, Estoquista..." maxLength={80} />
            </label>
            <label className="block">
              <span className="label">Departamento</span>
              <input className="input" value={departamento} onChange={(e) => setDepartamento(e.target.value)} placeholder="Ex.: Vendas, Estoque, Produção..." maxLength={60} />
            </label>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-bold text-navy-900">Acesso</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Acesso expira em (opcional)</span>
              <input className="input" type="datetime-local" value={acessoExpira} onChange={(e) => setAcessoExpira(e.target.value)} />
              <p className="mt-1 text-xs text-slate-400">Para acessos temporários. Vazio = sem expiração.</p>
            </label>
            {editing && (
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <input type="checkbox" className="mt-1" checked={trocarSenha} onChange={(e) => setTrocarSenha(e.target.checked)} />
                <span>
                  <span className="text-sm font-medium text-slate-700">Exigir troca de senha no próximo acesso</span>
                  <span className="block text-xs text-slate-400">O usuário só navega depois de definir uma senha nova.</span>
                </span>
              </label>
            )}
          </div>
          <label className="mt-3 block">
            <span className="label">Observações internas (só administradores veem)</span>
            <textarea className="input" rows={2} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} placeholder="Turno, loja, responsável pela contratação..." maxLength={1000} />
          </label>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-bold text-navy-900">Permissões comerciais</h3>
          <p className="mb-2 text-xs text-slate-500">“Herdar do perfil” usa a regra do perfil (gerente/admin têm acesso). Permite refinar por pessoa.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ['perm_catalogos', 'Gerenciar catálogos'],
              ['perm_compartilhar', 'Compartilhar catálogos'],
              ['perm_metricas', 'Ver métricas comerciais'],
              ['perm_politicas', 'Gerenciar políticas'],
              ['perm_aprovar', 'Aprovar exceções'],
            ].map(([k, label]) => (
              <label key={k} className="block">
                <span className="label">{label}</span>
                <select className="input" value={perms[k]} onChange={(e) => setPerm(k, e.target.value)}>
                  <option value="herdar">Herdar do perfil</option>
                  <option value="permitir">Permitir</option>
                  <option value="negar">Negar</option>
                </select>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-bold text-navy-900">Alçadas comerciais</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Desconto máximo (%)</span>
              <input className="input" value={desconto} onChange={(e) => setDesconto(e.target.value)} placeholder="Vazio = padrão do perfil" inputMode="decimal" />
            </label>
            <label className="block">
              <span className="label">Venda sem aprovação até (R$)</span>
              <input className="input" value={alçada} onChange={(e) => setAlçada(e.target.value)} placeholder="Vazio = padrão do perfil" inputMode="decimal" />
              <p className="mt-1 text-xs text-slate-400">Acima deste valor, o faturamento exige aprovação.</p>
            </label>
          </div>
        </section>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------
// Ficha do usuário (detalhe com abas)
// ----------------------------------------------------------------------------
function FichaUsuarioModal({
  id,
  souEu,
  onClose,
  onEdit,
  onConvite,
  onSensivel,
  onConfirmar,
  onExcluir,
  onChanged,
  busy,
  conviteBusyId,
}: {
  id: number;
  souEu: boolean;
  onClose: () => void;
  onEdit: (row: Usuario) => void;
  onConvite: (row: Usuario) => void;
  onSensivel: (tipo: 'senha' | 'desativar' | 'ativar' | 'encerrar' | 'mfa', row: Usuario, motivo?: string) => void;
  onConfirmar: (c: { tipo: 'encerrar' | 'mfa' | 'troca' | 'desbloquear'; row: Usuario }) => void;
  onExcluir: (row: Usuario) => void;
  onChanged: () => void;
  busy: string | null;
  conviteBusyId: number | null;
}) {
  const [tab, setTab] = useState<'resumo' | 'seguranca' | 'atividade'>('resumo');
  const [dados, setDados] = useState<Atividade | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      setDados(await api.get<Atividade>(`/usuarios/${id}/atividade`));
    } catch (e: any) {
      setErro(e.message || 'Não foi possível carregar a ficha.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const u = dados?.usuario;
  const perfil = u ? PERFIL_META[u.perfil] || { label: u.perfil, tone: 'slate' as const } : null;
  const status = u ? STATUS_META[u.status_conta] || { label: u.status_conta || '—', tone: 'slate' as const } : null;
  const ativo = u?.ativo !== false;

  return (
    <Modal open onClose={onClose} title={u ? u.nome : `Usuário #${id}`} subtitle={u?.email || ''} size="lg">
      {loading && !dados && <Spinner />}
      {erro && <Alert tone="red">{erro}</Alert>}
      {u && perfil && status && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Avatar nome={u.nome} perfil={u.perfil} tamanho="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={perfil.tone}>{perfil.label}</Badge>
                <Badge tone={status.tone}>{status.label}</Badge>
                {u.mfa_ativado_em ? <Badge tone="green">MFA ativado</Badge> : <Badge tone="slate">Sem MFA</Badge>}
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {u.cargo || '—'}{u.departamento ? ` · ${u.departamento}` : ''}{u.telefone ? ` · ${u.telefone}` : ''}
              </p>
            </div>
            <div className="flex gap-1.5">
              <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onEdit(u)}>
                <Pencil className="h-3.5 w-3.5" /> Editar
              </button>
              <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => { carregar(); onChanged(); }}>
                <RefreshCw className="h-3.5 w-3.5" /> Atualizar
              </button>
            </div>
          </div>

          <div className="flex gap-1 border-b border-slate-200">
            {(
              [
                ['resumo', 'Resumo'],
                ['seguranca', 'Segurança e sessões'],
                ['atividade', `Atividade (${dados?.historico_total ?? 0})`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === k ? 'border-navy-800 text-navy-900' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'resumo' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">E-mail</dt>
                  <dd className="font-medium text-slate-800">{u.email}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Cargo</dt>
                  <dd className="font-medium text-slate-800">{u.cargo || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Departamento</dt>
                  <dd className="font-medium text-slate-800">{u.departamento || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Telefone</dt>
                  <dd className="font-medium text-slate-800">{u.telefone || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Criado em</dt>
                  <dd className="font-medium text-slate-800">{formatDateTime(u.criado_em)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Criado por</dt>
                  <dd className="font-medium text-slate-800">{dados?.criador ? `${dados.criador.nome} (${dados.criador.email})` : '—'}</dd>
                </div>
                {u.acesso_expira_em && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Acesso expira em</dt>
                    <dd className={`font-medium ${u.acesso_expirado ? 'text-red-600' : 'text-slate-800'}`}>{formatDateTime(u.acesso_expira_em)}</dd>
                  </div>
                )}
              </dl>
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Último acesso</dt>
                  <dd className="font-medium text-slate-800">{u.ultimo_login ? `${formatDateTime(u.ultimo_login)} (${formatRelative(u.ultimo_login)})` : 'Nunca acessou'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Último IP</dt>
                  <dd className="font-mono text-xs text-slate-800">{u.ultimo_ip || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Logins (30 dias)</dt>
                  <dd className="font-medium tabular-nums text-slate-800">{dados?.estatisticas.logins_30d ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Eventos (30 dias)</dt>
                  <dd className="font-medium tabular-nums text-slate-800">{dados?.estatisticas.eventos_30d ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Senha definida em</dt>
                  <dd className="font-medium text-slate-800">{formatDateTime(u.senha_definida_em)}</dd>
                </div>
                {u.desativado_em && (
                  <>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Desativado em</dt>
                      <dd className="font-medium text-slate-800">{formatDateTime(u.desativado_em)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Desativado por</dt>
                      <dd className="font-medium text-slate-800">{u.desativado_por || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Motivo</dt>
                      <dd className="mt-0.5 rounded-md bg-slate-50 p-2 text-slate-700">{u.desativado_motivo || '—'}</dd>
                    </div>
                  </>
                )}
              </dl>
              {u.observacoes && (
                <div className="sm:col-span-2">
                  <p className="label">Observações internas</p>
                  <p className="rounded-md bg-slate-50 p-2.5 text-sm text-slate-700">{u.observacoes}</p>
                </div>
              )}
              <div className="sm:col-span-2 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                {!souEu && ativo && (
                  <button className="btn-secondary text-xs" onClick={() => onSensivel('ativar', u)} disabled>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Conta ativa
                  </button>
                )}
                {!souEu && (
                  <button
                    className="btn-secondary text-xs hover:!border-red-300 hover:!text-red-600"
                    onClick={() => {
                      onClose();
                      onExcluir(u);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Excluir (só contas virgens)
                  </button>
                )}
              </div>
            </div>
          )}

          {tab === 'seguranca' && (
            <div className="space-y-4">
              {/* Acesso / senha */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900">
                  <KeyRound className="h-4 w-4 text-navy-400" /> Senha e acesso
                </h4>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                  <Badge tone={(SENHA_META[u.senha_status] || { tone: 'blue' }).tone as 'green' | 'amber' | 'blue'}>
                    {(SENHA_META[u.senha_status] || { label: '—' }).label}
                  </Badge>
                  {u.trocar_senha && <Badge tone="amber">Troca obrigatória</Badge>}
                  {u.convite_expira_em && !u.senha_definida_em && (
                    <span className="text-xs text-slate-500">Convite {u.convite_expirado ? 'expirou' : 'expira'} em {formatDateTime(u.convite_expira_em)}</span>
                  )}
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {!u.senha_definida_em && ativo && (
                    <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onConvite(u)} disabled={conviteBusyId === Number(u.id)}>
                      {conviteBusyId === Number(u.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Reenviar convite
                    </button>
                  )}
                  {!!u.senha_definida_em && ativo && !souEu && (
                    <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onSensivel('senha', u)} disabled={busy === `senha-${u.id}`}>
                      {busy === `senha-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />} Senha temporária
                    </button>
                  )}
                  {!!u.senha_definida_em && ativo && !u.trocar_senha && (
                    <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onConfirmar({ tipo: 'troca', row: u })} disabled={busy === `troca-${u.id}`}>
                      {busy === `troca-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Forçar troca de senha
                    </button>
                  )}
                </div>
              </div>

              {/* Bloqueio */}
              <div className={`rounded-lg border p-3 ${u.conta_bloqueada ? 'border-red-200 bg-red-50/50' : 'border-slate-200'}`}>
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900">
                  <ShieldAlert className="h-4 w-4 text-navy-400" /> Bloqueio e tentativas
                </h4>
                <p className="mt-1 text-sm text-slate-600">
                  {u.conta_bloqueada ? (
                    <>
                      <Badge tone="red">Bloqueado até {formatDateTime(u.bloqueado_ate)}</Badge>
                      <span className="ml-2 text-xs">{u.motivo_bloqueio}</span>
                    </>
                  ) : (
                    <span className="text-xs">
                      {Number(u.tentativas_falhas || 0) > 0
                        ? `${u.tentativas_falhas} falha(s) consecutiva(s) — última em ${formatDateTime(u.ultimo_falha_em)}. ${5 - Number(u.tentativas_falhas)} restante(s) até o bloqueio automático (15 min).`
                        : 'Nenhuma falha recente. 5 senhas erradas seguidas bloqueiam a conta por 15 minutos.'}
                    </span>
                  )}
                </p>
                {(u.conta_bloqueada || Number(u.tentativas_falhas || 0) > 0) && (
                  <button className="btn-secondary mt-2 !px-2.5 !py-1.5 text-xs" onClick={() => onConfirmar({ tipo: 'desbloquear', row: u })} disabled={busy === `desbloquear-${u.id}`}>
                    {busy === `desbloquear-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LockOpen className="h-3.5 w-3.5" />} Desbloquear e zerar falhas
                  </button>
                )}
              </div>

              {/* MFA */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900">
                  <Smartphone className="h-4 w-4 text-navy-400" /> MFA (dois fatores)
                </h4>
                <p className="mt-1 text-sm text-slate-600">
                  {u.mfa_ativado_em ? (
                    <>Ativado em {formatDateTime(u.mfa_ativado_em)}. O login exige o código do app autenticador.</>
                  ) : u.perfil === 'admin' ? (
                    <span className="flex items-center gap-1.5">
                      <Badge tone="red">Pendente — obrigatório para administradores</Badge>
                    </span>
                  ) : (
                    'Não ativado (opcional para este perfil).'
                  )}
                </p>
                {(u.mfa_ativado_em || u.mfa_secret) && !souEu && (
                  <button className="btn-secondary mt-2 !px-2.5 !py-1.5 text-xs" onClick={() => onConfirmar({ tipo: 'mfa', row: u })} disabled={busy === `mfa-${u.id}`}>
                    {busy === `mfa-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Smartphone className="h-3.5 w-3.5" />} Resetar MFA
                  </button>
                )}
              </div>

              {/* Sessões */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900">
                  <MonitorSmartphone className="h-4 w-4 text-navy-400" /> Sessões ativas ({dados?.sessoes.length ?? 0})
                </h4>
                {!dados?.sessoes.length ? (
                  <p className="mt-1 text-sm text-slate-400">Nenhuma sessão ativa.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-100">
                    {dados.sessoes.map((s) => (
                      <li key={s.sid} className="py-2 text-sm">
                        <p className="font-medium text-slate-800">
                          <span className="font-mono text-xs text-slate-400">{s.sid}</span> · {s.ip || 'ip desconhecido'}
                        </p>
                        <p className="truncate text-xs text-slate-400">
                          Entrou em {formatDateTime(s.criada_em)} · expira em {formatDateTime(s.expira_em)} · {s.user_agent || 'agente desconhecido'}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {!!dados?.sessoes.length && !souEu && (
                  <button className="btn-secondary mt-2 !px-2.5 !py-1.5 text-xs" onClick={() => onConfirmar({ tipo: 'encerrar', row: u })} disabled={busy === `encerrar-${u.id}`}>
                    {busy === `encerrar-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />} Encerrar todas as sessões
                  </button>
                )}
              </div>
            </div>
          )}

          {tab === 'atividade' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-sm font-bold text-navy-900">Últimos acessos ({dados?.acessos_total ?? 0})</h4>
                {!dados?.acessos.length ? (
                  <p className="text-sm text-slate-400">Nenhum acesso registrado.</p>
                ) : (
                  <ul className="max-h-72 space-y-2 overflow-auto pr-1">
                    {dados.acessos.map((a) => (
                      <li key={a.id} className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                        <p className="font-medium text-slate-700">{formatDateTime(a.data)}</p>
                        <p className="mt-0.5">{a.descricao}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4 className="mb-2 text-sm font-bold text-navy-900">Trilha da conta ({dados?.historico_total ?? 0})</h4>
                {!dados?.historico.length ? (
                  <p className="text-sm text-slate-400">Nenhum evento sobre esta conta.</p>
                ) : (
                  <ul className="max-h-72 space-y-2 overflow-auto pr-1">
                    {dados.historico.map((h) => (
                      <li key={h.id} className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                        <p className="font-medium text-slate-700">
                          {formatDateTime(h.data)} · {h.usuario || 'sistema'} · {ACAO_LABEL[h.acao] || h.acao}
                        </p>
                        <p className="mt-0.5">{h.descricao}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const ACAO_LABEL: Record<string, string> = {
  criar: 'inclusão',
  editar: 'alteração',
  excluir: 'exclusão',
  login: 'login',
  senha: 'senha',
  mfa: 'MFA',
  seguranca: 'segurança',
  bloqueio: 'bloqueio',
  convite: 'convite',
  importar: 'importação',
  ajuste: 'ajuste',
  estornar: 'estorno',
};
