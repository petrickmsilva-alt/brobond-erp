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
//   • UX: linhas clicáveis, menu de ações por linha, KPIs que filtram
//     (liga/desliga), alertas com ação rápida e ficha auto-recarregável
//   • Onda 3: gráfico de acessos 7 dias, ações em lote (troca/encerrar/
//     desativar/exportar seleção), bloqueio manual com prazo, revogação de
//     sessão individual, trilha com diff de alterações e ficha impressa
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  BellRing,
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
  MoreVertical,
  Pencil,
  Plus,
  Power,
  Printer,
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
import { imprimirFicha } from '../lib/fichaPrint';
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
  falhas_24h: number;
  sessoes_ativas: number | null;
};

/** Ações sensíveis (exigem reautenticação do administrador logado). */
type TipoSensivel = 'senha' | 'desativar' | 'ativar' | 'encerrar' | 'mfa' | 'bloquear' | 'sessao';

/** Ação em lote pendente de confirmação (e de reautenticação, quando sensível). */
type LoteAcao = { acao: 'desativar' | 'encerrar' | 'troca'; ids: number[]; motivo?: string };

/** Um dia da série de acessos (gráfico de 7 dias do painel). */
type PontoSerie = { dia: string; logins: number; falhas: number };

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

type TabFicha = 'resumo' | 'seguranca' | 'atividade';

type MenuItem = {
  key: string;
  rotulo: string;
  icone: React.ReactNode;
  perigo?: boolean;
  separadorAntes?: boolean;
  busy?: boolean;
  onClick: () => void;
};

const PAGE_SIZES = [10, 25, 50];
const DEFAULT_PAGE_SIZE = 25;

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
  const [resumo, setResumo] = useState<{ totais: Totais; alertas: Alerta[]; serie_logins_7d: PontoSerie[] } | null>(null);
  const [resumoLoading, setResumoLoading] = useState(true);

  // Lista
  const [data, setData] = useState<ListResult<Usuario> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);
  const [showFiltros, setShowFiltros] = useState(false);
  const [fPerfil, setFPerfil] = useState('');
  const [fAtivo, setFAtivo] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fMfa, setFMfa] = useState('');
  const [fParado, setFParado] = useState('');

  // Formulário
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Usuario | null>(null);

  // Ficha
  const [fichaId, setFichaId] = useState<number | null>(null);
  const [fichaTab, setFichaTab] = useState<TabFicha>('resumo');
  const [fichaNonce, setFichaNonce] = useState(0);

  // Fluxos de acesso
  const [senhaTempUser, setSenhaTempUser] = useState<Usuario | null>(null);
  const [senhaTempValor, setSenhaTempValor] = useState('');
  const [conviteLink, setConviteLink] = useState('');
  const [conviteBusyId, setConviteBusyId] = useState<number | null>(null);
  const [reauth, setReauth] = useState<{ tipo: TipoSensivel; row: Usuario; motivo?: string; sid?: string; duracao?: string } | null>(null);
  const [desativarRow, setDesativarRow] = useState<Usuario | null>(null);
  const [motivo, setMotivo] = useState('');
  // Seleção em lote (persiste entre páginas) + ação em lote pendente.
  const [selecao, setSelecao] = useState<Usuario[]>([]);
  const [bulkBusy, setBulkBusy] = useState<LoteAcao['acao'] | null>(null);
  const [loteDesativarIds, setLoteDesativarIds] = useState<number[] | null>(null);
  const [lotePendente, setLotePendente] = useState<LoteAcao | null>(null);
  // Bloqueio manual de acesso.
  const [bloquearRow, setBloquearRow] = useState<Usuario | null>(null);
  const [bloquearMotivo, setBloquearMotivo] = useState('');
  const [bloquearDuracao, setBloquearDuracao] = useState('');
  const [acaoBusy, setAcaoBusy] = useState<string | null>(null);
  const [menuAberto, setMenuAberto] = useState<number | null>(null);
  const [alertaBusy, setAlertaBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Usuario | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmAcao, setConfirmAcao] = useState<{ tipo: 'encerrar' | 'mfa' | 'troca' | 'desbloquear'; row: Usuario } | null>(null);

  const filtrosAtivos = [fPerfil, fAtivo, fStatus, fMfa, fParado].filter(Boolean).length;

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
    if (fParado) params.set('f.parado30d', fParado);
    return params.toString();
  }, [debouncedQ, sort, fPerfil, fAtivo, fStatus, fMfa, fParado]);

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
      const d = await api.get<ListResult<Usuario>>(`/usuarios?page=${page}&pageSize=${pageSize}${paramsAtuais ? `&${paramsAtuais}` : ''}`);
      setData(d);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / pageSize)));
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, paramsAtuais]);

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
    setFParado('');
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
  async function executarSensivel(a: { tipo: TipoSensivel; row: Usuario; motivo?: string; sid?: string; duracao?: string }) {
    const id = Number(a.row.id);
    setAcaoBusy(a.tipo === 'sessao' && a.sid ? `sessao-${a.sid}` : `${a.tipo}-${id}`);
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
      } else if (a.tipo === 'bloquear') {
        await api.post(`/usuarios/${id}/bloquear`, { motivo: a.motivo || '', ...(a.duracao ? { duracao_minutos: Number(a.duracao) } : {}) });
        toast.success(`${a.row.nome} bloqueado(a).${a.duracao ? '' : ' O acesso só volta com desbloqueio manual.'}`);
      } else if (a.tipo === 'sessao' && a.sid) {
        await api.post(`/usuarios/${id}/sessoes/${encodeURIComponent(a.sid)}/encerrar`, {});
        toast.success('Sessão revogada. Os demais dispositivos continuam conectados.');
      }
      setConfirmAcao(null);
      setFichaNonce((n) => n + 1); // a ficha aberta recarrega sozinha
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

  function pedirSensivel(tipo: TipoSensivel, row: Usuario, opts?: { motivo?: string; sid?: string; duracao?: string }) {
    setReauth({ tipo, row, ...opts });
  }

  // ------------------------------------------------------------------
  // Ações em lote (checkboxes da lista)
  // ------------------------------------------------------------------
  const selecionado = useCallback((id: number) => selecao.some((u) => Number(u.id) === id), [selecao]);

  function toggleSelecao(row: Usuario) {
    const id = Number(row.id);
    setSelecao((sel) => (sel.some((u) => Number(u.id) === id) ? sel.filter((u) => Number(u.id) !== id) : [...sel, row]));
  }

  function togglePagina(rows: Usuario[]) {
    const idsPagina = new Set(rows.map((r) => Number(r.id)));
    const todos = rows.length > 0 && rows.every((r) => selecionado(Number(r.id)));
    setSelecao((sel) => (todos ? sel.filter((u) => !idsPagina.has(Number(u.id))) : [...sel.filter((u) => !idsPagina.has(Number(u.id))), ...rows]));
  }

  /** Filtra os elegíveis por ação (o servidor valida de novo, um por um). */
  function elegiveis(acao: LoteAcao['acao']): { rows: Usuario[]; ignorados: number } {
    const rows = selecao.filter((u) => {
      if (eu && Number(eu.id) === Number(u.id)) return false; // nunca mexe na própria conta
      if (u.ativo === false) return false;
      if (acao === 'troca') return !!u.senha_definida_em && !u.trocar_senha;
      return true;
    });
    return { rows, ignorados: selecao.length - rows.length };
  }

  async function executarLote(lote: LoteAcao) {
    setBulkBusy(lote.acao);
    let ok = 0;
    const erros: string[] = [];
    let parouPorReauth = false;
    let i = 0;
    for (; i < lote.ids.length; i++) {
      const id = lote.ids[i];
      try {
        if (lote.acao === 'desativar') await api.post(`/usuarios/${id}/desativar`, { motivo: lote.motivo || '' });
        else if (lote.acao === 'encerrar') await api.post(`/usuarios/${id}/encerrar-sessoes`, {});
        else await api.post(`/usuarios/${id}/forcar-troca-senha`, {});
        ok++;
      } catch (e: any) {
        if (e instanceof ApiError && e.code === 'reauth_necessaria') {
          parouPorReauth = true;
          break; // reautentica e retoma do ponto onde parou
        }
        erros.push(`#${id}: ${e instanceof ApiError ? e.message : 'falhou'}`);
      }
    }
    setBulkBusy(null);
    if (parouPorReauth) {
      setLotePendente({ ...lote, ids: lote.ids.slice(i) });
      return;
    }
    setLotePendente(null);
    if (ok > 0) {
      setSelecao((sel) => sel.filter((u) => !lote.ids.includes(Number(u.id))));
      setFichaNonce((n) => n + 1);
      await recarregarTudo();
      toast.success(`${ok} de ${lote.ids.length} conta(s) concluída(s).`);
    }
    if (erros.length) toast.error(erros.slice(0, 3).join(' · ') + (erros.length > 3 ? ` (+${erros.length - 3} outro(s))` : ''));
    if (!ok && !erros.length) toast.error('Nenhuma conta foi processada.');
  }

  function iniciarLote(acao: LoteAcao['acao']) {
    const { rows, ignorados } = elegiveis(acao);
    if (!rows.length) {
      toast.error('Nenhuma conta elegível na seleção (a sua, desativadas e — na troca — sem senha ou já marcadas ficam de fora).');
      return;
    }
    if (ignorados > 0) toast.success(`${ignorados} conta(s) ignorada(s): fora do perfil desta ação.`);
    const ids = rows.map((u) => Number(u.id));
    if (acao === 'desativar') {
      setLoteDesativarIds(ids);
      setMotivo('');
      return;
    }
    if (acao === 'troca') {
      void executarLote({ acao, ids });
      return;
    }
    // encerrar sessões é sensível: pré-autoriza antes de executar
    setLotePendente({ acao, ids });
  }

  async function exportarSelecao() {
    try {
      await downloadFile(`/usuarios/export?format=csv&ids=${selecao.map((u) => Number(u.id)).join(',')}`, 'usuarios-selecao.csv');
      toast.success(`Seleção exportada (${selecao.length} conta(s)).`);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível exportar a seleção.');
    }
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
      setFichaNonce((n) => n + 1); // a ficha aberta recarrega sozinha
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

  function abrirFicha(id: number, tab: TabFicha = 'resumo') {
    setFichaTab(tab);
    setFichaId(id);
  }

  /** Abre o cadastro para edição a partir de um ID (usado pelos alertas). */
  async function abrirEdicao(id: number, chaveBusy: string) {
    setAlertaBusy(chaveBusy);
    try {
      const row = await api.get<Usuario>(`/usuarios/${id}`);
      setEditing(row);
      setFormOpen(true);
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível abrir o cadastro.');
    } finally {
      setAlertaBusy(null);
    }
  }

  async function copiarEmail(row: Usuario) {
    try {
      await navigator.clipboard.writeText(String(row.email || ''));
      toast.success('E-mail copiado.');
    } catch {
      toast.error('Não foi possível copiar.');
    }
  }

  const fecharMenu = useCallback(() => setMenuAberto(null), []);

  /** Itens do menu de ações de cada linha (tabela e celular). */
  function menuItens(row: Usuario, souEu: boolean): MenuItem[] {
    const id = Number(row.id);
    const ativo = row.ativo !== false;
    const itens: MenuItem[] = [
      { key: 'ficha', rotulo: 'Ver ficha completa', icone: <Eye className="h-4 w-4" />, onClick: () => abrirFicha(id) },
      { key: 'email', rotulo: 'Copiar e-mail', icone: <Copy className="h-4 w-4" />, onClick: () => copiarEmail(row) },
    ];
    if (!row.senha_definida_em && ativo) {
      itens.push({
        key: 'convite', rotulo: 'Reenviar convite', icone: <Mail className="h-4 w-4" />,
        busy: conviteBusyId === id, onClick: () => reenviarConvite(row),
      });
    }
    if (row.senha_definida_em && ativo && !souEu) {
      itens.push({
        key: 'senha', rotulo: 'Gerar senha temporária', icone: <KeyRound className="h-4 w-4" />,
        busy: acaoBusy === `senha-${id}`, onClick: () => pedirSensivel('senha', row),
      });
    }
    if (row.senha_definida_em && ativo && !row.trocar_senha) {
      itens.push({
        key: 'troca', rotulo: 'Forçar troca de senha', icone: <ShieldCheck className="h-4 w-4" />,
        busy: acaoBusy === `troca-${id}`, onClick: () => setConfirmAcao({ tipo: 'troca', row }),
      });
    }
    if (row.mfa_ativado_em && !souEu) {
      itens.push({
        key: 'mfa', rotulo: 'Resetar MFA', icone: <Smartphone className="h-4 w-4" />,
        busy: acaoBusy === `mfa-${id}`, onClick: () => setConfirmAcao({ tipo: 'mfa', row }),
      });
    }
    if (ativo && !souEu) {
      itens.push({
        key: 'encerrar', rotulo: 'Encerrar todas as sessões', icone: <Lock className="h-4 w-4" />,
        busy: acaoBusy === `encerrar-${id}`, onClick: () => setConfirmAcao({ tipo: 'encerrar', row }),
      });
    }
    if (row.conta_bloqueada || Number(row.tentativas_falhas || 0) > 0) {
      itens.push({
        key: 'desbloquear', rotulo: 'Desbloquear e zerar falhas', icone: <LockOpen className="h-4 w-4" />,
        busy: acaoBusy === `desbloquear-${id}`, onClick: () => setConfirmAcao({ tipo: 'desbloquear', row }),
      });
    }
    if (ativo && !row.conta_bloqueada && !souEu) {
      itens.push({
        key: 'bloquear', rotulo: 'Bloquear acesso...', icone: <Ban className="h-4 w-4" />, perigo: true,
        busy: acaoBusy === `bloquear-${id}`,
        onClick: () => { setBloquearRow(row); setBloquearMotivo(''); setBloquearDuracao(''); },
      });
    }
    if (!souEu) {
      itens.push(
        ativo
          ? {
              key: 'desativar', rotulo: 'Desativar conta...', icone: <PowerOff className="h-4 w-4" />,
              perigo: true, separadorAntes: true,
              onClick: () => { setDesativarRow(row); setMotivo(''); },
            }
          : {
              key: 'ativar', rotulo: 'Reativar conta', icone: <Power className="h-4 w-4" />,
              separadorAntes: true, busy: acaoBusy === `ativar-${id}`,
              onClick: () => pedirSensivel('ativar', row),
            },
        { key: 'excluir', rotulo: 'Excluir...', icone: <Trash2 className="h-4 w-4" />, perigo: true, onClick: () => setToDelete(row) }
      );
    }
    return itens;
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
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
                  <div className="mt-auto flex gap-1.5">
                    {a.tipo === 'convite_expirado' && (
                      <button
                        className="btn-secondary flex-1 !px-2 !py-1 text-xs"
                        disabled={conviteBusyId === a.usuario_id}
                        onClick={() => reenviarConvite({ id: a.usuario_id, nome: a.nome, email: a.email })}
                      >
                        {conviteBusyId === a.usuario_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Reenviar
                      </button>
                    )}
                    {a.tipo === 'bloqueado' && (
                      <button
                        className="btn-secondary flex-1 !px-2 !py-1 text-xs"
                        onClick={() => setConfirmAcao({ tipo: 'desbloquear', row: { id: a.usuario_id, nome: a.nome } })}
                      >
                        <LockOpen className="h-3.5 w-3.5" /> Desbloquear
                      </button>
                    )}
                    {(a.tipo === 'acesso_expirado' || a.tipo === 'acesso_a_vencer') && (
                      <button
                        className="btn-secondary flex-1 !px-2 !py-1 text-xs"
                        disabled={alertaBusy === `renovar-${a.usuario_id}`}
                        onClick={() => abrirEdicao(a.usuario_id, `renovar-${a.usuario_id}`)}
                      >
                        {alertaBusy === `renovar-${a.usuario_id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />} Renovar
                      </button>
                    )}
                    <button className="btn-secondary flex-1 !px-2 !py-1 text-xs" onClick={() => abrirFicha(a.usuario_id, a.tipo === 'admin_sem_mfa' ? 'seguranca' : 'resumo')}>
                      <Eye className="h-3.5 w-3.5" /> {a.tipo === 'admin_sem_mfa' ? 'Ver segurança' : 'Ver ficha'}
                    </button>
                  </div>
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
          ativo={fAtivo === 'true'}
          onClick={() => {
            setFAtivo((v) => (v === 'true' ? '' : 'true'));
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
          ativo={fStatus === 'convite_pendente'}
          onClick={() => {
            setFStatus((v) => (v === 'convite_pendente' ? '' : 'convite_pendente'));
            setPage(1);
          }}
        />
        <Kpi
          icone={<KeyRound className="h-5 w-5" />}
          cor="bg-brand-500"
          valor={resumoLoading ? null : (t?.troca_pendente ?? 0)}
          rotulo="Troca pendente"
          dica="Senha provisória"
          ativo={fStatus === 'provisoria'}
          onClick={() => {
            setFStatus((v) => (v === 'provisoria' ? '' : 'provisoria'));
            setPage(1);
          }}
        />
        <Kpi
          icone={<Smartphone className="h-5 w-5" />}
          cor="bg-emerald-600"
          valor={resumoLoading ? null : (t?.mfa_ativos ?? 0)}
          rotulo="Com MFA"
          dica={t ? `${t.sessoes_ativas ?? '—'} sessões ativas` : ''}
          ativo={fMfa === 'sim'}
          onClick={() => {
            setFMfa((v) => (v === 'sim' ? '' : 'sim'));
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
          ativo={fStatus === 'bloqueado'}
          onClick={() => {
            setFStatus((v) => (v === 'bloqueado' ? '' : 'bloqueado'));
            setPage(1);
          }}
        />
        <Kpi
          icone={<MonitorSmartphone className="h-5 w-5" />}
          cor="bg-slate-500"
          valor={resumoLoading ? null : (t?.sem_login_30d ?? 0)}
          rotulo="Parados 30+ dias"
          dica={t ? `${t.logins_hoje} login(s) hoje` : ''}
          ativo={fParado === 'sim'}
          onClick={() => {
            setFParado((v) => (v === 'sim' ? '' : 'sim'));
            setPage(1);
          }}
        />
      </div>

      {/* Movimento de acessos + segurança (24h) */}
      {(resumoLoading || resumo) && (
        <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="card p-4 lg:col-span-2">
            <p className="mb-2 text-sm font-bold text-navy-900">Movimento de acessos — últimos 7 dias</p>
            {resumoLoading || !resumo ? <Spinner /> : <GraficoAcessos serie={resumo.serie_logins_7d || []} />}
          </div>
          <div className="card flex flex-col justify-center gap-3 p-4">
            <p className="text-sm font-bold text-navy-900">Segurança nas últimas 24h</p>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-100 text-red-600">
                <ShieldAlert className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xl font-bold tabular-nums text-navy-900">{resumoLoading ? '—' : (t?.falhas_24h ?? 0)}</p>
                <p className="text-xs text-slate-500">tentativa(s) de login falha(s)</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                <Lock className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xl font-bold tabular-nums text-navy-900">{resumoLoading ? '—' : (t?.bloqueados ?? 0)}</p>
                <p className="text-xs text-slate-500">conta(s) bloqueada(s) agora</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                <Smartphone className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xl font-bold tabular-nums text-navy-900">
                  {resumoLoading ? '—' : resumo!.alertas.filter((a) => a.tipo === 'admin_sem_mfa').length}
                </p>
                <p className="text-xs text-slate-500">admin(s) sem MFA</p>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {/* Barra de ações em lote */}
      {selecao.length > 0 && (
        <div className="card mb-3 flex flex-wrap items-center gap-2 border-brand-200 bg-brand-50/60 p-3">
          <p className="mr-auto text-sm font-semibold text-navy-900">
            {selecao.length} conta(s) selecionada(s)
            <span className="ml-1.5 font-normal text-slate-500">a sua conta e as desativadas ficam sempre de fora</span>
          </p>
          <button className="btn-secondary !py-1.5 text-xs" onClick={() => iniciarLote('troca')} disabled={!!bulkBusy}>
            {bulkBusy === 'troca' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Forçar troca
          </button>
          <button className="btn-secondary !py-1.5 text-xs" onClick={() => iniciarLote('encerrar')} disabled={!!bulkBusy}>
            {bulkBusy === 'encerrar' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />} Encerrar sessões
          </button>
          <button className="btn-secondary !py-1.5 text-xs hover:!border-red-300 hover:!text-red-600" onClick={() => iniciarLote('desativar')} disabled={!!bulkBusy}>
            {bulkBusy === 'desativar' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />} Desativar...
          </button>
          <button className="btn-secondary !py-1.5 text-xs" onClick={exportarSelecao}>
            <Download className="h-3.5 w-3.5" /> Exportar CSV
          </button>
          <button className="btn-ghost !py-1.5 text-xs" onClick={() => setSelecao([])}>
            <X className="h-3.5 w-3.5" /> Limpar
          </button>
        </div>
      )}

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
                  <th className="w-10">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300"
                      aria-label="Selecionar página"
                      checked={data.rows.length > 0 && data.rows.every((r) => selecionado(Number(r.id)))}
                      ref={(el) => {
                        if (el) el.indeterminate = data.rows.some((r) => selecionado(Number(r.id))) && !data.rows.every((r) => selecionado(Number(r.id)));
                      }}
                      onChange={() => togglePagina(data.rows)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </th>
                  <Th label="Usuário" field="nome" sort={sort} onSort={toggleSort} />
                  <Th label="Perfil" field="perfil" sort={sort} onSort={toggleSort} />
                  <th>Status</th>
                  <th>Senha</th>
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
                    <tr key={row.id} onClick={() => abrirFicha(Number(row.id))} title="Ver ficha completa" className={`cursor-pointer hover:bg-slate-50 ${!ativo ? 'opacity-70' : ''} ${selecionado(Number(row.id)) ? '!bg-brand-50/60' : ''}`}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300"
                          aria-label={`Selecionar ${row.nome}`}
                          checked={selecionado(Number(row.id))}
                          onChange={() => toggleSelecao(row)}
                        />
                      </td>
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
                        {row.conta_bloqueada && row.bloqueio_manual && (
                          <p className="mt-0.5 text-[11px] font-semibold text-red-500">bloqueio manual (sem prazo)</p>
                        )}
                      </td>
                      <td>
                        <Badge tone={senha.tone}>{senha.label}</Badge>
                        {row.senha_status === 'convite_pendente' && row.convite_expira_em && (
                          <p className={`mt-0.5 text-[11px] ${row.convite_expirado ? 'text-red-500' : 'text-slate-400'}`} title={formatDateTime(row.convite_expira_em)}>
                            {row.convite_expirado ? `expirou ${formatRelative(row.convite_expira_em)}` : `expira ${formatRelative(row.convite_expira_em)}`}
                          </p>
                        )}
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
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center gap-0.5">
                          <button className="btn-icon" onClick={() => abrirFicha(Number(row.id))} title="Ver ficha completa" aria-label="Ver ficha">
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
                          <MenuAcoes
                            itens={menuItens(row, !!souEu)}
                            aberto={menuAberto === Number(row.id)}
                            onAbrir={() => setMenuAberto(Number(row.id))}
                            onFechar={fecharMenu}
                          />
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
                <li key={row.id} className={`px-4 py-3 ${selecionado(Number(row.id)) ? 'bg-brand-50/60' : ''}`}>
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      className="mt-2 h-4 w-4 shrink-0 rounded border-slate-300"
                      aria-label={`Selecionar ${row.nome}`}
                      checked={selecionado(Number(row.id))}
                      onChange={() => toggleSelecao(row)}
                    />
                    <Avatar nome={row.nome} perfil={row.perfil} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => abrirFicha(Number(row.id))}>
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
                      <MenuAcoes
                        itens={menuItens(row, !!souEu)}
                        aberto={menuAberto === Number(row.id)}
                        onAbrir={() => setMenuAberto(Number(row.id))}
                        onFechar={fecharMenu}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {data && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2 text-slate-500">
              <select
                className="input !w-auto !py-1 text-xs"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Itens por página"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} por página
                  </option>
                ))}
              </select>
              <span className="hidden sm:inline">
                Página {page} de {pages}
              </span>
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

      {/* Ficha do usuário (antes dos modais de ação: eles abrem por cima dela) */}
      {fichaId !== null && (
        <FichaUsuarioModal
          key={fichaId}
          id={fichaId}
          souEu={!!eu && Number(eu.id) === fichaId}
          tabInicial={fichaTab}
          refreshKey={fichaNonce}
          onClose={() => setFichaId(null)}
          onEdit={(row) => {
            setFichaId(null);
            setEditing(row);
            setFormOpen(true);
          }}
          onConvite={reenviarConvite}
          onSensivel={pedirSensivel}
          onBloquear={(row) => {
            setBloquearRow(row);
            setBloquearMotivo('');
            setBloquearDuracao('');
          }}
          onImprimir={(dados) => {
            if (!imprimirFicha(dados, eu?.name || 'Administrador')) toast.error('O navegador bloqueou a janela de impressão. Permita popups e tente de novo.');
          }}
          onDesativar={(row) => {
            setDesativarRow(row);
            setMotivo('');
          }}
          onConfirmar={setConfirmAcao}
          onExcluir={setToDelete}
          onChanged={recarregarTudo}
          busy={acaoBusy}
          conviteBusyId={conviteBusyId}
        />
      )}

      {/* Reautenticação para ações sensíveis */}
      <ReauthModal
        open={!!reauth || !!lotePendente}
        onClose={() => {
          // Cancelar a autorização não apaga o motivo já digitado.
          if (reauth?.tipo === 'desativar') {
            setDesativarRow(reauth.row);
            setMotivo(reauth.motivo || '');
          }
          if (lotePendente?.acao === 'desativar') {
            setLoteDesativarIds(lotePendente.ids);
            setMotivo(lotePendente.motivo || '');
          }
          setReauth(null);
          setLotePendente(null);
        }}
        onConfirmed={() => {
          if (reauth) void executarSensivel(reauth);
          else if (lotePendente) void executarLote(lotePendente);
          setReauth(null);
          setLotePendente(null);
        }}
        titulo={reauth ? tituloReauth(reauth.tipo, reauth.row) : lotePendente ? tituloLote(lotePendente) : 'Autorização necessária'}
      />

      {/* Desativar com motivo (individual ou em lote) */}
      <Modal
        open={!!desativarRow || !!loteDesativarIds}
        onClose={() => {
          setDesativarRow(null);
          setLoteDesativarIds(null);
        }}
        title={loteDesativarIds ? `Desativar ${loteDesativarIds.length} contas?` : `Desativar ${desativarRow?.nome || ''}?`}
        subtitle="O acesso é desligado na hora e todas as sessões são encerradas. O histórico é preservado."
        size="sm"
        footer={
          <>
            <button
              className="btn-secondary"
              onClick={() => {
                setDesativarRow(null);
                setLoteDesativarIds(null);
              }}
            >
              Cancelar
            </button>
            <button
              className="btn-danger"
              disabled={!motivo.trim()}
              onClick={() => {
                if (loteDesativarIds) {
                  setLotePendente({ acao: 'desativar', ids: loteDesativarIds, motivo: motivo.trim() });
                  setLoteDesativarIds(null);
                  setDesativarRow(null);
                  return;
                }
                if (!desativarRow) return;
                pedirSensivel('desativar', desativarRow, { motivo: motivo.trim() });
                setDesativarRow(null);
              }}
            >
              Desativar {loteDesativarIds ? `${loteDesativarIds.length} contas` : 'conta'}
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

      {/* Bloqueio manual de acesso */}
      <Modal
        open={!!bloquearRow}
        onClose={() => setBloquearRow(null)}
        title={`Bloquear acesso de ${bloquearRow?.nome || ''}?`}
        subtitle="Conta bloqueada não entra no sistema — nem com a senha e o MFA certos. Use em suspeitas de fraude ou vazamento."
        size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setBloquearRow(null)}>
              Cancelar
            </button>
            <button
              className="btn-danger"
              disabled={!bloquearMotivo.trim()}
              onClick={() => {
                if (!bloquearRow) return;
                pedirSensivel('bloquear', bloquearRow, { motivo: bloquearMotivo.trim(), duracao: bloquearDuracao || undefined });
                setBloquearRow(null);
              }}
            >
              <Ban className="h-4 w-4" /> Bloquear acesso
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="label">Motivo do bloqueio *</span>
            <textarea
              className="input"
              rows={3}
              value={bloquearMotivo}
              onChange={(e) => setBloquearMotivo(e.target.value)}
              placeholder="Ex.: suspeita de fraude no caixa — acesso suspenso até a apuração"
              autoFocus
            />
            <p className="mt-1 text-xs text-slate-400">Obrigatório: aparece na tela de login do usuário e na auditoria.</p>
          </label>
          <label className="block">
            <span className="label">Prazo</span>
            <select className="input" value={bloquearDuracao} onChange={(e) => setBloquearDuracao(e.target.value)}>
              <option value="">Sem prazo — até alguém desbloquear</option>
              <option value="60">1 hora</option>
              <option value="480">8 horas</option>
              <option value="1440">24 horas</option>
              <option value="10080">7 dias</option>
            </select>
          </label>
        </div>
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
    case 'bloquear':
      return `Bloquear acesso — ${nome}`;
    case 'sessao':
      return `Revogar sessão — ${nome}`;
    default:
      return 'Autorização necessária';
  }
}

const LOTE_LABEL: Record<LoteAcao['acao'], string> = {
  desativar: 'desativação',
  encerrar: 'encerramento de sessões',
  troca: 'troca forçada de senha',
};

function tituloLote(lote: LoteAcao): string {
  return `Autorizar ${LOTE_LABEL[lote.acao]} em ${lote.ids.length} conta(s)`;
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
  ativo,
  onClick,
}: {
  icone: React.ReactNode;
  cor: string;
  valor: number | null;
  rotulo: string;
  dica: string;
  alerta?: boolean;
  ativo?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? !!ativo : undefined}
      className={`card flex items-center gap-3 p-3 text-left sm:p-4 ${alerta ? 'border-red-200 bg-red-50/40' : ''} ${ativo ? 'ring-2 ring-navy-800 ring-offset-1' : ''} ${onClick ? 'transition-shadow hover:shadow-modal' : 'cursor-default'}`}
      title={onClick ? (ativo ? 'Clique para remover este filtro' : 'Clique para filtrar a lista') : undefined}
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
// Menu de ações da linha (posicionamento fixo: não é cortado pela tabela)
// ----------------------------------------------------------------------------
function MenuAcoes({ itens, aberto, onAbrir, onFechar }: { itens: MenuItem[]; aberto: boolean; onAbrir: () => void; onFechar: () => void }) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!aberto) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // Abre para cima quando não há espaço abaixo (últimas linhas).
      const altura = Math.min(itens.length * 40 + 16, window.innerHeight * 0.7);
      const top = r.bottom + 6 + altura > window.innerHeight ? Math.max(8, r.top - 6 - altura) : r.bottom + 6;
      setPos({ top, right: Math.max(8, window.innerWidth - r.right) });
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onFechar();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onFechar);
    window.addEventListener('scroll', onFechar, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onFechar);
      window.removeEventListener('scroll', onFechar, true);
    };
  }, [aberto, onFechar, itens.length]);

  return (
    <>
      <button
        ref={btnRef}
        className="btn-icon"
        onClick={(e) => {
          e.stopPropagation();
          aberto ? onFechar() : onAbrir();
        }}
        aria-label="Mais ações"
        aria-haspopup="menu"
        aria-expanded={aberto}
        title="Mais ações"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {aberto && (
        <>
          <div
            className="fixed inset-0 z-30 cursor-default"
            onClick={(e) => {
              e.stopPropagation();
              onFechar();
            }}
          />
          <div
            role="menu"
            className="fixed z-40 max-h-[70vh] w-60 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-modal animate-fade-in"
            style={pos ? { top: pos.top, right: pos.right } : { visibility: 'hidden' }}
          >
            {itens.map((it) => (
              <div key={it.key}>
                {it.separadorAntes && <div className="mx-2 my-1 border-t border-slate-100" />}
                <button
                  role="menuitem"
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${
                    it.perigo ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-100'
                  }`}
                  disabled={it.busy}
                  onClick={() => {
                    onFechar();
                    it.onClick();
                  }}
                >
                  {it.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : it.icone}
                  {it.rotulo}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
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
            {perfil === 'admin' && (
              <p className="-mt-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-200 sm:col-span-2">
                Administrador tem acesso total ao ERP e <strong>MFA obrigatório</strong> a partir do primeiro login.
              </p>
            )}
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
              <div className="mt-1.5 flex flex-wrap gap-1">
                {[7, 30, 90].map((dias) => (
                  <button
                    key={dias}
                    type="button"
                    className="btn-ghost !px-2 !py-0.5 text-xs"
                    onClick={() => setAcessoExpira(fromISO(new Date(Date.now() + dias * 86400000).toISOString()))}
                  >
                    +{dias} dias
                  </button>
                ))}
                {acessoExpira && (
                  <button type="button" className="btn-ghost !px-2 !py-0.5 text-xs" onClick={() => setAcessoExpira('')}>
                    Limpar
                  </button>
                )}
              </div>
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
  tabInicial,
  refreshKey,
  onClose,
  onEdit,
  onConvite,
  onSensivel,
  onBloquear,
  onImprimir,
  onDesativar,
  onConfirmar,
  onExcluir,
  onChanged,
  busy,
  conviteBusyId,
}: {
  id: number;
  souEu: boolean;
  tabInicial: TabFicha;
  refreshKey: number;
  onClose: () => void;
  onEdit: (row: Usuario) => void;
  onConvite: (row: Usuario) => void;
  onSensivel: (tipo: TipoSensivel, row: Usuario, opts?: { motivo?: string; sid?: string; duracao?: string }) => void;
  onBloquear: (row: Usuario) => void;
  onImprimir: (dados: Atividade) => void;
  onDesativar: (row: Usuario) => void;
  onConfirmar: (c: { tipo: 'encerrar' | 'mfa' | 'troca' | 'desbloquear'; row: Usuario }) => void;
  onExcluir: (row: Usuario) => void;
  onChanged: () => void;
  busy: string | null;
  conviteBusyId: number | null;
}) {
  const [tab, setTab] = useState<TabFicha>(tabInicial);
  const [dados, setDados] = useState<Atividade | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [filtroAcao, setFiltroAcao] = useState('');

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
  }, [carregar, refreshKey]);

  const acoesDisponiveis = useMemo(() => [...new Set((dados?.historico || []).map((h) => String(h.acao)))], [dados]);
  const historicoFiltrado = filtroAcao ? (dados?.historico || []).filter((h) => String(h.acao) === filtroAcao) : dados?.historico || [];

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
            <div className="flex flex-wrap gap-1.5">
              {!souEu &&
                (ativo ? (
                  <button className="btn-secondary !px-2.5 !py-1.5 text-xs hover:!border-red-300 hover:!text-red-600" onClick={() => onDesativar(u)}>
                    <PowerOff className="h-3.5 w-3.5" /> Desativar
                  </button>
                ) : (
                  <button
                    className="btn-secondary !px-2.5 !py-1.5 text-xs hover:!border-emerald-300 hover:!text-emerald-600"
                    onClick={() => onSensivel('ativar', u)}
                    disabled={busy === `ativar-${u.id}`}
                  >
                    {busy === `ativar-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />} Reativar
                  </button>
                ))}
              <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onEdit(u)}>
                <Pencil className="h-3.5 w-3.5" /> Editar
              </button>
              <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => { carregar(); onChanged(); }}>
                <RefreshCw className="h-3.5 w-3.5" /> Atualizar
              </button>
              <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => dados && onImprimir(dados)} title="Imprimir o dossiê completo (RH/arquivo)">
                <Printer className="h-3.5 w-3.5" /> Imprimir ficha
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
                    <span className="text-xs text-slate-500" title={formatDateTime(u.convite_expira_em)}>
                      Convite {u.convite_expirado ? `expirou ${formatRelative(u.convite_expira_em)}` : `expira ${formatRelative(u.convite_expira_em)}`}
                    </span>
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
                      <Badge tone="red">{u.bloqueio_manual ? 'Bloqueio manual (sem prazo)' : `Bloqueado até ${formatDateTime(u.bloqueado_ate)}`}</Badge>
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
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(u.conta_bloqueada || Number(u.tentativas_falhas || 0) > 0) && (
                    <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onConfirmar({ tipo: 'desbloquear', row: u })} disabled={busy === `desbloquear-${u.id}`}>
                      {busy === `desbloquear-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LockOpen className="h-3.5 w-3.5" />} Desbloquear e zerar falhas
                    </button>
                  )}
                  {ativo && !u.conta_bloqueada && !souEu && (
                    <button className="btn-secondary !px-2.5 !py-1.5 text-xs hover:!border-red-300 hover:!text-red-600" onClick={() => onBloquear(u)} disabled={busy === `bloquear-${u.id}`}>
                      {busy === `bloquear-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />} Bloquear acesso...
                    </button>
                  )}
                </div>
              </div>

              {/* MFA */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900">
                  <Smartphone className="h-4 w-4 text-navy-400" /> MFA (dois fatores)
                </h4>
                <p className="mt-1 text-sm text-slate-600">
                  {u.mfa_ativado_em ? (
                    <>
                      Ativado em {formatDateTime(u.mfa_ativado_em)}. O login exige o código do app autenticador.
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {Number(u.mfa_backup_restantes ?? 0)} código(s) de recuperação restantes
                        {Number(u.mfa_backup_restantes ?? 0) === 0 && ' — oriente o usuário a gerar um lote em Configurações → MFA.'}
                      </span>
                    </>
                  ) : u.perfil === 'admin' ? (
                    <span className="flex items-center gap-1.5">
                      <Badge tone="red">Pendente — obrigatório para administradores</Badge>
                    </span>
                  ) : (
                    'Não ativado (opcional para este perfil).'
                  )}
                </p>
                {u.mfa_ativado_em && Number(u.mfa_backup_restantes ?? 0) === 0 && !souEu && (
                  <p className="mt-1 flex items-start gap-1 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Sem códigos válidos: se o usuário perder o celular, só o reset do MFA devolve o acesso.
                  </p>
                )}
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
                      <li key={s.sid} className="flex items-start justify-between gap-2 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-800">
                            <span className="font-mono text-xs text-slate-400" title={s.sid}>{String(s.sid).slice(0, 8)}</span> · {s.ip || 'ip desconhecido'}
                          </p>
                          <p className="truncate text-xs text-slate-400">
                            Entrou em {formatDateTime(s.criada_em)} · expira em {formatDateTime(s.expira_em)} · {s.user_agent || 'agente desconhecido'}
                          </p>
                        </div>
                        {!souEu && (
                          <button
                            className="btn-ghost shrink-0 !px-2 !py-1 text-xs hover:!text-red-600"
                            title="Revogar apenas esta sessão (os demais dispositivos continuam conectados)"
                            onClick={() => onSensivel('sessao', u, { sid: s.sid })}
                            disabled={busy === `sessao-${s.sid}`}
                          >
                            {busy === `sessao-${s.sid}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Revogar
                          </button>
                        )}
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
                  <ol className="relative ml-1 max-h-72 space-y-3 overflow-auto border-l-2 border-slate-100 py-1 pl-4 pr-1">
                    {dados.acessos.map((a) => (
                      <li key={a.id} className="relative text-xs text-slate-600">
                        <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${String(a.descricao || '').startsWith('Falha') ? 'bg-red-500' : 'bg-emerald-500'}`} />
                        <p className="font-medium text-slate-700">{formatDateTime(a.data)}</p>
                        <p className="mt-0.5">{a.descricao}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-bold text-navy-900">Trilha da conta ({dados?.historico_total ?? 0})</h4>
                  {!!acoesDisponiveis.length && (
                    <select
                      className="input !w-auto !py-1 text-xs"
                      value={filtroAcao}
                      onChange={(e) => setFiltroAcao(e.target.value)}
                      aria-label="Filtrar eventos por tipo"
                    >
                      <option value="">Todos os eventos</option>
                      {acoesDisponiveis.map((a) => (
                        <option key={a} value={a}>
                          {ACAO_LABEL[a] || a}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {!dados?.historico.length ? (
                  <p className="text-sm text-slate-400">Nenhum evento sobre esta conta.</p>
                ) : !historicoFiltrado.length ? (
                  <p className="text-sm text-slate-400">Nenhum evento deste tipo nos últimos registros.</p>
                ) : (
                  <ol className="relative ml-1 max-h-72 space-y-3 overflow-auto border-l-2 border-slate-100 py-1 pl-4 pr-1">
                    {historicoFiltrado.map((h) => (
                      <li key={h.id} className="relative text-xs text-slate-600">
                        <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${ACAO_DOT[String(h.acao)] || 'bg-slate-300'}`} />
                        <p className="font-medium text-slate-700">
                          {formatDateTime(h.data)} · {h.usuario || 'sistema'} · {ACAO_LABEL[h.acao] || h.acao}
                        </p>
                        <p className="mt-0.5">{h.descricao}</p>
                        {h.dados && typeof h.dados === 'object' && <DiffMudancas dados={h.dados} />}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// Cor do ponto da timeline por tipo de evento.
const ACAO_DOT: Record<string, string> = {
  login: 'bg-emerald-500',
  login_falha: 'bg-red-500',
  bloqueio: 'bg-red-500',
  seguranca: 'bg-red-400',
  senha: 'bg-amber-500',
  mfa: 'bg-violet-500',
  convite: 'bg-blue-500',
  criar: 'bg-emerald-400',
  editar: 'bg-sky-500',
  excluir: 'bg-red-600',
};

// Rótulos amigáveis dos campos do cadastro (diff do "antes × depois").
const CAMPO_LABEL: Record<string, string> = {
  nome: 'Nome', email: 'E-mail', perfil: 'Perfil', ativo: 'Situação da conta',
  cargo: 'Cargo', departamento: 'Departamento', telefone: 'Telefone',
  observacoes: 'Observações internas', acesso_expira_em: 'Acesso expira em',
  desconto_max_pct: 'Desconto máximo', venda_sem_aprovacao_ate: 'Venda sem aprovação até',
  perm_catalogos: 'Permissão: catálogos', perm_compartilhar: 'Permissão: compartilhar',
  perm_metricas: 'Permissão: métricas', perm_politicas: 'Permissão: políticas',
  perm_aprovar: 'Permissão: aprovar',
};

const PERFIL_SIMPLES: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };

function formatarValorDiff(campo: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return campo === 'ativo' ? (v ? 'Ativa' : 'Desativada') : v ? 'Sim' : 'Não';
  if (campo === 'perfil') return PERFIL_SIMPLES[String(v)] || String(v);
  if (campo === 'acesso_expira_em') return formatDateTime(String(v));
  if (campo === 'desconto_max_pct') return `${v}%`;
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** Diff "antes × depois" de um evento de alteração do cadastro. */
function DiffMudancas({ dados }: { dados: Record<string, { de: unknown; para: unknown }> }) {
  const entradas = Object.entries(dados || {}).filter(([, m]) => m && typeof m === 'object' && 'de' in m && 'para' in m);
  if (!entradas.length) return null;
  return (
    <dl className="mt-1.5 space-y-1 rounded-md border border-slate-200 bg-white p-2">
      {entradas.map(([campo, m]) => (
        <div key={campo} className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-5">
          <dt className="font-semibold text-slate-500">{CAMPO_LABEL[campo] || campo}:</dt>
          <dd className="text-slate-400 line-through">{formatarValorDiff(campo, m.de)}</dd>
          <dd aria-hidden className="text-slate-300">→</dd>
          <dd className="font-medium text-slate-700">{formatarValorDiff(campo, m.para)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Gráfico de barras (SVG puro) com logins × falhas dos últimos 7 dias. */
function GraficoAcessos({ serie }: { serie: PontoSerie[] }) {
  const totalLogins = serie.reduce((a, p) => a + p.logins, 0);
  const totalFalhas = serie.reduce((a, p) => a + p.falhas, 0);
  const max = Math.max(1, ...serie.map((p) => Math.max(p.logins, p.falhas)));
  const W = 560;
  const H = 176;
  const PAD_T = 16;
  const PAD_B = 24;
  const area = H - PAD_T - PAD_B;
  const gw = W / Math.max(1, serie.length);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Logins e falhas dos últimos 7 dias: ${totalLogins} logins, ${totalFalhas} falhas`}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={PAD_T + area * (1 - f)} y2={PAD_T + area * (1 - f)} className="stroke-slate-100" strokeWidth={1} />
        ))}
        {serie.map((p, i) => {
          const cx = gw * i + gw / 2;
          const hL = (p.logins / max) * area;
          const hF = (p.falhas / max) * area;
          const base = PAD_T + area;
          const rotulo = `${p.dia.slice(8, 10)}/${p.dia.slice(5, 7)}`;
          return (
            <g key={p.dia}>
              <title>{`${rotulo}: ${p.logins} login(s), ${p.falhas} falha(s)`}</title>
              <rect x={cx - 12} y={base - hL} width={11} height={Math.max(hL, p.logins ? 2 : 0)} rx={2} className="fill-emerald-500" />
              <rect x={cx + 1} y={base - hF} width={11} height={Math.max(hF, p.falhas ? 2 : 0)} rx={2} className="fill-red-400" />
              {p.logins > 0 && (
                <text x={cx - 6.5} y={base - hL - 3} textAnchor="middle" className="fill-slate-500" fontSize={9}>
                  {p.logins}
                </text>
              )}
              {p.falhas > 0 && (
                <text x={cx + 6.5} y={base - hF - 3} textAnchor="middle" className="fill-red-500" fontSize={9}>
                  {p.falhas}
                </text>
              )}
              <text x={cx} y={H - 8} textAnchor="middle" className="fill-slate-400" fontSize={10}>
                {rotulo}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Logins ({totalLogins})
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-red-400" /> Falhas ({totalFalhas})
        </span>
      </div>
    </div>
  );
}

const ACAO_LABEL: Record<string, string> = {
  criar: 'inclusão',
  editar: 'alteração',
  excluir: 'exclusão',
  login: 'login',
  login_falha: 'login (falha)',
  senha: 'senha',
  mfa: 'MFA',
  seguranca: 'segurança',
  bloqueio: 'bloqueio',
  convite: 'convite',
  importar: 'importação',
  ajuste: 'ajuste',
  estornar: 'estorno',
};
