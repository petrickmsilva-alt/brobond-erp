// ============================================================================
// Módulo Usuários — gestão profissional de acesso (ERP).
//
//   • Painel: KPIs + alertas acionáveis (MFA, convites, bloqueios, expiração)
//   • Caixabox de Filtros de Alto Nível: filtros por usuário, perfil, status,
//     senha, MFA, último acesso, situação com atalhos e chips dinâmicos
//   • Tags & Badges de Alto Nível: formato caixa (rounded-md) com ícones e
//     indicadores de status (sem textos espremidos em bolas)
//   • Ficha do usuário: dados, segurança/sessões e trilha de auditoria
//   • Ciclo de vida: convite, senha temporária (exibição única), ativar/
//     desativar com motivo, desbloquear, encerrar sessões, troca forçada,
//     reset de MFA — ações sensíveis com reautenticação (step-up)
//   • Onda 3/4: gráfico 7d, ações em lote, política de senha, certificação
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  BellRing,
  Briefcase,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
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
  PowerOff,
  Printer,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  User,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import type { ListResult } from '../lib/meta';
import { formatDateTime, formatRelative } from '../lib/format';
import { imprimirFicha } from '../lib/fichaPrint';
import { useAuth } from '../auth/AuthContext';
import { useLocalStorageBool } from '../lib/useLocalStorage';
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
  senhas_expiradas: number;
  senhas_a_vencer: number;
  nao_certificados: number;
  sessoes_ativas: number | null;
};

/** Política de senha configurável (GET/PUT /api/usuarios/politica-senha). */
type PoliticaSenha = {
  tamanho_minimo: number;
  exigir_maiuscula_minuscula: boolean;
  exigir_numero: boolean;
  exigir_simbolo: boolean;
  proibir_obvias: boolean;
  historico_qtd: number;
  expiracao_dias: number;
};

/** Uma linha da matriz de certificação de acessos. */
type LinhaCertificacao = {
  id: number;
  nome: string;
  email: string;
  perfil: string;
  ativo: boolean;
  status_conta: string;
  mfa: boolean;
  ultimo_login: string | null;
  certificado_em: string | null;
  certificado_por: string | null;
  certificado_obs: string | null;
  certificado_ha_dias: number | null;
  precisa_recertificar: boolean;
};

/** Ações sensíveis (exigem reautenticação do administrador logado). */
type TipoSensivel = 'senha' | 'desativar' | 'ativar' | 'encerrar' | 'mfa' | 'bloquear' | 'sessao' | 'certificar';

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
  senha_expirada: { label: 'Senha vencida', tone: 'red' },
  senha_a_vencer: { label: 'Senha a vencer', tone: 'amber' },
  acesso_expirado: { label: 'Acesso expirado', tone: 'red' },
  convite_expirado: { label: 'Convite expirado', tone: 'amber' },
  acesso_a_vencer: { label: 'Acesso a vencer', tone: 'amber' },
};

const AVATAR_BG: Record<string, string> = {
  admin: 'bg-brand-500 dark:bg-brand-600',
  gerente: 'bg-navy-700 dark:bg-navy-600',
  operador: 'bg-slate-600 dark:bg-slate-700',
};

function iniciais(nome: string): string {
  const partes = String(nome || '?').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

// ----------------------------------------------------------------------------
// Sistema visual de etiquetas do módulo (padrão "caixinha").
//
// Regra de ouro da Brobond: nenhuma informação de perfil/status/segurança vive
// dentro de uma bolinha colorida. Cada dado é uma CAIXA — borda, fundo suave,
// cantos de 6 px, rótulo em texto e o ícone dentro de uma caixinha de 16 px.
// Assim a leitura é imediata em lista, ficha e celular, o significado nunca
// depende só da cor (acessibilidade) e o visual fica alinhado ao resto do ERP.
// ----------------------------------------------------------------------------
type Tom = 'verde' | 'amarelo' | 'vermelho' | 'azul' | 'slate';

const TONS: Record<Tom, { caixa: string; icone: string }> = {
  verde: {
    caixa: 'border-emerald-300/80 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    icone: 'bg-emerald-600/15 text-emerald-600 dark:text-emerald-400',
  },
  amarelo: {
    caixa: 'border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-300',
    icone: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
  },
  vermelho: {
    caixa: 'border-red-300/80 bg-red-50 text-red-900 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300',
    icone: 'bg-red-600/15 text-red-600 dark:text-red-400',
  },
  azul: {
    caixa: 'border-blue-300/80 bg-blue-50 text-blue-900 dark:border-navy-700 dark:bg-navy-800/60 dark:text-navy-200',
    icone: 'bg-blue-600/15 text-blue-600 dark:text-navy-300',
  },
  slate: {
    caixa: 'border-slate-300/80 bg-slate-50 text-slate-700 dark:border-navy-700 dark:bg-navy-800/40 dark:text-navy-200',
    icone: 'bg-slate-500/15 text-slate-500 dark:text-navy-300',
  },
};

/** Etiqueta em caixa: ícone em caixinha + rótulo textual (nunca só cor/bola). */
function Tag({ tom, icone: Icone, rotulo, titulo }: { tom: Tom; icone: LucideIcon; rotulo: string; titulo?: string }) {
  const t = TONS[tom];
  return (
    <span title={titulo} className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold leading-5 shadow-2xs ${t.caixa}`}>
      <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-[3px] ${t.icone}`} aria-hidden="true">
        <Icone className="h-3 w-3" />
      </span>
      <span className="truncate">{rotulo}</span>
    </span>
  );
}

/** Avatar em caixa (cantos retos): as iniciais ficam numa plaqueta, não numa bola. */
function AvatarBox({ nome, perfil, tamanho = 'md' }: { nome: string; perfil: string; tamanho?: 'md' | 'lg' }) {
  const cls = tamanho === 'lg' ? 'h-12 w-12 rounded-md text-base' : 'h-9 w-9 rounded-md text-xs';
  return (
    <span
      className={`flex ${cls} shrink-0 items-center justify-center border border-white/10 font-mono font-bold tracking-tight text-white shadow-2xs ${AVATAR_BG[perfil] || 'bg-slate-600'}`}
      aria-hidden="true"
    >
      {iniciais(nome)}
    </span>
  );
}

/** Caixa de Perfil. */
function TagPerfil({ perfil }: { perfil: string }) {
  if (perfil === 'admin') return <Tag tom="amarelo" icone={Shield} rotulo="Administrador" titulo="Acesso total, incluindo usuários e auditoria" />;
  if (perfil === 'gerente') return <Tag tom="azul" icone={Briefcase} rotulo="Gerente" titulo="Inclui, altera e exclui em todos os módulos, exceto usuários e auditoria" />;
  return <Tag tom="slate" icone={User} rotulo="Operador" titulo="Inclui e altera registros, mas não exclui" />;
}

/** Caixa de Situação da conta (ciclo de vida). */
function TagStatus({ row }: { row: Usuario }) {
  const statusKey = row.status_conta || 'ativo';
  if (row.ativo === false) return <Tag tom="slate" icone={PowerOff} rotulo="Desativado" />;
  if (row.conta_bloqueada)
    return (
      <Tag
        tom="vermelho"
        icone={Ban}
        rotulo="Bloqueado"
        titulo={row.bloqueado_ate ? `Bloqueado até ${formatDateTime(row.bloqueado_ate)}${row.motivo_bloqueio ? ` — ${row.motivo_bloqueio}` : ''}` : row.motivo_bloqueio}
      />
    );
  if (row.acesso_expirado) return <Tag tom="vermelho" icone={Clock} rotulo="Acesso expirado" titulo="A conta venceu — renove o prazo na edição do usuário" />;
  if (statusKey === 'convite_pendente') return <Tag tom="azul" icone={Mail} rotulo="Convite pendente" titulo="E-mail enviado: aguardando o aceite (válido por 48 h)" />;
  if (statusKey === 'convite_expirado') return <Tag tom="amarelo" icone={Mail} rotulo="Convite expirado" titulo="O convite venceu — reenvie pela ficha do usuário" />;
  if (statusKey === 'provisoria') return <Tag tom="amarelo" icone={KeyRound} rotulo="Troca pendente" titulo="Senha provisória: troca obrigatória no próximo login" />;
  return <Tag tom="verde" icone={CheckCircle2} rotulo="Ativo" />;
}

/** Caixa do estado da senha. */
function TagSenha({ row }: { row: Usuario }) {
  const st = row.senha_status || 'propria';
  if (st === 'convite_pendente') return <Tag tom="azul" icone={Mail} rotulo="Aguardando convite" titulo="Aguardando o usuário aceitar o convite por e-mail" />;
  if (st === 'provisoria' || row.trocar_senha) return <Tag tom="amarelo" icone={KeyRound} rotulo="Provisória" titulo="Senha provisória — troca obrigatória no próximo login" />;
  return <Tag tom="verde" icone={ShieldCheck} rotulo="Própria" titulo="Senha definida pelo próprio usuário" />;
}

/** Caixa do segundo fator (MFA). */
function TagMfa({ row }: { row: Usuario }) {
  if (row.mfa_ativado_em) return <Tag tom="verde" icone={Smartphone} rotulo="Ativado" titulo="Segundo fator ativo nesta conta" />;
  if (row.perfil === 'admin') return <Tag tom="vermelho" icone={ShieldAlert} rotulo="Pendente" titulo="MFA é obrigatório para administradores" />;
  return <Tag tom="slate" icone={Smartphone} rotulo="Não" titulo="Conta sem segundo fator" />;
}

// ----------------------------------------------------------------------------
// Caixabox de filtro: cada dimensão é uma caixa autocontida (rótulo + controle
// + limpeza individual). Filtro ativo muda a borda e o fundo — dá para ver de
// relance quais dimensões estão estreitando a lista.
// ----------------------------------------------------------------------------
function CaixaFiltro({
  rotulo,
  icone: Icone,
  ativo,
  onLimpar,
  children,
  className = '',
}: {
  rotulo: string;
  icone: LucideIcon;
  ativo: boolean;
  onLimpar?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${
        ativo
          ? 'border-brand-400 bg-brand-50/60 dark:border-brand-600/60 dark:bg-brand-950/30'
          : 'border-slate-200 bg-white hover:border-slate-300 dark:border-navy-700 dark:bg-navy-900 dark:hover:border-navy-600'
      } ${className}`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-navy-300">
          <Icone className="h-3 w-3" /> {rotulo}
        </span>
        {ativo && onLimpar && (
          <button
            type="button"
            onClick={onLimpar}
            className="rounded p-0.5 text-slate-400 transition-colors hover:bg-white hover:text-red-600 dark:hover:bg-navy-800"
            aria-label={`Limpar filtro ${rotulo}`}
            title={`Limpar filtro ${rotulo}`}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** Chip de filtro ativo: categoria + valor + remoção. */
function ChipFiltro({ rotulo, valor, onRemover }: { rotulo: string; valor: string; onRemover: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-navy-200 bg-navy-50/80 py-0.5 pl-2 pr-1 text-xs font-semibold text-navy-900 shadow-2xs dark:border-navy-700 dark:bg-navy-800/80 dark:text-navy-100">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-navy-400">{rotulo}</span>
      <span className="truncate">{valor}</span>
      <button
        type="button"
        onClick={onRemover}
        className="rounded p-0.5 text-slate-400 transition-colors hover:bg-white hover:text-red-600 dark:hover:bg-navy-700"
        aria-label={`Remover filtro ${rotulo}`}
        title={`Remover filtro ${rotulo}`}
      >
        <X className="h-3 w-3" />
      </button>
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
  // `meta` vem do contexto de auth: é dele que lemos smtp/emailLinks (diagnóstico
  // dos links de convite) — null durante o carregamento, por isso o uso é todo opcional.
  const { user: eu, meta } = useAuth();
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

  // Filtros em Caixabox de Alto Nível
  const [fPerfil, setFPerfil] = useState('');
  const [fAtivo, setFAtivo] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fSenha, setFSenha] = useState('');
  const [fMfa, setFMfa] = useState('');
  const [fAcesso, setFAcesso] = useState('');
  const [fParado, setFParado] = useState('');
  // O caixabox de filtros nasce aberto (é o coração do módulo) e a preferência
  // de cada usuário é lembrada no navegador.
  const [filtrosAbertos, setFiltrosAbertos] = useLocalStorageBool('brobond_usuarios_filtros_abertos', true);

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
  // Onda 4: política de senha + certificação de acessos.
  const [politicaAberta, setPoliticaAberta] = useState(false);
  const [politicaForm, setPoliticaForm] = useState<PoliticaSenha | null>(null);
  const [politicaLimites, setPoliticaLimites] = useState<{ tamanho_minimo: { min: number; max: number }; historico_qtd: { min: number; max: number }; expiracao_dias: { min: number; max: number } } | null>(null);
  const [politicaLoading, setPoliticaLoading] = useState(false);
  const [politicaSaving, setPoliticaSaving] = useState(false);
  const [politicaErro, setPoliticaErro] = useState('');
  const [politicaPendente, setPoliticaPendente] = useState(false);
  const [certAberto, setCertAberto] = useState(false);
  const [certDados, setCertDados] = useState<{ total: number; ativos: number; certificados: number; pendentes: number; validade_dias: number; linhas: LinhaCertificacao[] } | null>(null);
  const [certLoading, setCertLoading] = useState(false);
  const [certFiltro, setCertFiltro] = useState<'todas' | 'pendentes' | 'certificadas'>('todas');
  const [certificarRow, setCertificarRow] = useState<Usuario | null>(null);
  const [certObs, setCertObs] = useState('');
  const [acaoBusy, setAcaoBusy] = useState<string | null>(null);
  const [menuAberto, setMenuAberto] = useState<number | null>(null);
  const [alertaBusy, setAlertaBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Usuario | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmAcao, setConfirmAcao] = useState<{ tipo: 'encerrar' | 'mfa' | 'troca' | 'desbloquear'; row: Usuario } | null>(null);

  const filtrosAtivos = [fPerfil, fAtivo, fStatus, fSenha, fMfa, fAcesso, fParado].filter(Boolean).length;

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
    if (fSenha) params.set('f.senha', fSenha);
    if (fMfa) params.set('f.mfa', fMfa);
    if (fAcesso) params.set('f.acesso', fAcesso);
    else if (fParado) params.set('f.parado30d', fParado);
    return params.toString();
  }, [debouncedQ, sort, fPerfil, fAtivo, fStatus, fSenha, fMfa, fAcesso, fParado]);

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
    setFSenha('');
    setFMfa('');
    setFAcesso('');
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
      } else if (a.tipo === 'certificar') {
        await api.post(`/usuarios/${id}/certificar`, { observacao: a.motivo || '' });
        toast.success(`Acesso de ${a.row.nome} certificado.`);
      }
      setConfirmAcao(null);
      setFichaNonce((n) => n + 1); // a ficha aberta recarrega sozinha
      if (certAberto) void recarregarCert();
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

  async function exportarSelecao(formato: 'csv' | 'xlsx' = 'csv') {
    try {
      await downloadFile(`/usuarios/export?format=${formato}&ids=${selecao.map((u) => Number(u.id)).join(',')}`, `usuarios-selecao.${formato}`);
      toast.success(`Seleção exportada (${selecao.length} conta(s)).`);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível exportar a seleção.');
    }
  }

  // ------------------------------------------------------------------
  // Onda 4: política de senha + certificação
  // ------------------------------------------------------------------
  async function abrirPolitica() {
    setPoliticaAberta(true);
    setPoliticaLoading(true);
    setPoliticaErro('');
    try {
      const d = await api.get<{ politica: PoliticaSenha; limites: NonNullable<typeof politicaLimites> }>('/usuarios/politica-senha');
      setPoliticaForm(d.politica);
      setPoliticaLimites(d.limites);
    } catch (e: any) {
      setPoliticaErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a política.');
    } finally {
      setPoliticaLoading(false);
    }
  }

  /** Grava a política (chamado direto e após a reautenticação confirmar). */
  async function salvarPolitica() {
    if (!politicaForm) return;
    setPoliticaErro('');
    setPoliticaSaving(true);
    try {
      await api.put('/usuarios/politica-senha', politicaForm);
      setPoliticaAberta(false);
      toast.success('Política de senha atualizada. Vale para as próximas senhas e logins.');
      await recarregarTudo();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setPoliticaPendente(true);
        return;
      }
      setPoliticaErro(e instanceof ApiError ? e.message : 'Não foi possível salvar a política.');
    } finally {
      setPoliticaSaving(false);
    }
  }

  async function recarregarCert() {
    setCertLoading(true);
    try {
      setCertDados(await api.get<NonNullable<typeof certDados>>('/usuarios/certificacao'));
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível carregar a certificação.');
    } finally {
      setCertLoading(false);
    }
  }

  function abrirCertificacao() {
    setCertAberto(true);
    setCertFiltro('todas');
    void recarregarCert();
  }

  async function exportarCertificacao(formato: 'csv' | 'xlsx') {
    try {
      await downloadFile(`/usuarios/certificacao/export?format=${formato}`, `certificacao-acessos.${formato}`);
      toast.success('Matriz de certificação exportada.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível exportar.');
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
    if (row.senha_definida_em && ativo && !souEu) {
      itens.push({
        key: 'certificar', rotulo: 'Certificar acesso...', icone: <ClipboardCheck className="h-4 w-4" />,
        busy: acaoBusy === `certificar-${id}`, onClick: () => { setCertificarRow(row); setCertObs(''); },
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

  // Visões rápidas: cada botão aplica (ou desfaz) um recorte pronto da base.
  // São a porta de entrada da lista — os caixabox abaixo afinam o resultado.
  const visoes: { id: string; rotulo: string; icone: LucideIcon; total: number; ativo: boolean; aplicar: () => void }[] = [
    { id: 'todos', rotulo: 'Todos', icone: Users, total: t?.total ?? total, ativo: !filtrosAtivos && !q, aplicar: limparFiltros },
    { id: 'ativos', rotulo: 'Ativos', icone: UserRound, total: t?.ativos ?? 0, ativo: fAtivo === 'true', aplicar: () => { limparFiltros(); setFAtivo('true'); } },
    { id: 'admins', rotulo: 'Administradores', icone: Shield, total: t?.admins ?? 0, ativo: fPerfil === 'admin', aplicar: () => { limparFiltros(); setFPerfil('admin'); } },
    { id: 'gerentes', rotulo: 'Gerentes', icone: Briefcase, total: t?.gerentes ?? 0, ativo: fPerfil === 'gerente', aplicar: () => { limparFiltros(); setFPerfil('gerente'); } },
    { id: 'operadores', rotulo: 'Operadores', icone: User, total: t?.operadores ?? 0, ativo: fPerfil === 'operador', aplicar: () => { limparFiltros(); setFPerfil('operador'); } },
    { id: 'convites', rotulo: 'Convites pendentes', icone: Mail, total: t?.convites_pendentes ?? 0, ativo: fStatus === 'convite_pendente', aplicar: () => { limparFiltros(); setFStatus('convite_pendente'); } },
    { id: 'mfa', rotulo: 'Com MFA', icone: Smartphone, total: t?.mfa_ativos ?? 0, ativo: fMfa === 'sim', aplicar: () => { limparFiltros(); setFMfa('sim'); } },
    { id: 'bloqueados', rotulo: 'Bloqueados', icone: Ban, total: t?.bloqueados ?? 0, ativo: fStatus === 'bloqueado', aplicar: () => { limparFiltros(); setFStatus('bloqueado'); } },
    { id: 'inativos', rotulo: 'Desativados', icone: PowerOff, total: t?.inativos ?? 0, ativo: fAtivo === 'false', aplicar: () => { limparFiltros(); setFAtivo('false'); } },
  ];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white shadow-xs">
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
            <button className="btn-secondary" onClick={abrirPolitica} title="Composição, histórico e expiração das senhas">
              <KeyRound className="h-4 w-4" />
              <span className="hidden md:inline">Política de senha</span>
            </button>
            <button className="btn-secondary" onClick={abrirCertificacao} title="Revisão periódica de quem tem acesso a quê">
              <ClipboardCheck className="h-4 w-4" />
              <span className="hidden md:inline">Certificação</span>
              {(t?.nao_certificados ?? 0) > 0 && <span className="badge ml-1 !bg-amber-500 !text-white">{t!.nao_certificados}</span>}
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
                    <button className="btn-secondary flex-1 !px-2 !py-1 text-xs" onClick={() => abrirFicha(a.usuario_id, a.tipo === 'admin_sem_mfa' || a.tipo.startsWith('senha_') ? 'seguranca' : 'resumo')}>
                      <Eye className="h-3.5 w-3.5" /> {a.tipo === 'admin_sem_mfa' || a.tipo.startsWith('senha_') ? 'Ver segurança' : 'Ver ficha'}
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
          cor="bg-navy-600"
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
            <p className="mb-2 text-sm font-bold text-navy-900 dark:text-white">Movimento de acessos — últimos 7 dias</p>
            {resumoLoading || !resumo ? <Spinner /> : <GraficoAcessos serie={resumo.serie_logins_7d || []} />}
          </div>
          <div className="card flex flex-col justify-center gap-3 p-4">
            <p className="text-sm font-bold text-navy-900 dark:text-white">Segurança nas últimas 24h</p>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400">
                <ShieldAlert className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xl font-bold tabular-nums text-navy-900 dark:text-white">{resumoLoading ? '—' : (t?.falhas_24h ?? 0)}</p>
                <p className="text-xs text-slate-500 dark:text-navy-300">tentativa(s) de login falha(s)</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-navy-300">
                <Lock className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xl font-bold tabular-nums text-navy-900 dark:text-white">{resumoLoading ? '—' : (t?.bloqueados ?? 0)}</p>
                <p className="text-xs text-slate-500 dark:text-navy-300">conta(s) bloqueada(s) agora</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                <Smartphone className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xl font-bold tabular-nums text-navy-900 dark:text-white">
                  {resumoLoading ? '—' : resumo!.alertas.filter((a) => a.tipo === 'admin_sem_mfa').length}
                </p>
                <p className="text-xs text-slate-500 dark:text-navy-300">admin(s) sem MFA</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Painel de consulta — barra de comando, visões e filtros em caixabox */}
      <section className="card mb-4 overflow-hidden" aria-label="Consulta de usuários">
        {/* Barra de comando */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-navy-800 sm:px-4">
          <div className="relative min-w-[200px] flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="input pl-9 pr-8 !py-1.5 text-sm"
              placeholder="Buscar por nome, e-mail, cargo ou departamento..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Buscar usuário"
            />
            {q && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600" onClick={() => setQ('')} aria-label="Limpar busca">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="mr-1 hidden text-xs tabular-nums text-slate-500 md:inline dark:text-navy-300">
              {loading && !data
                ? 'Carregando...'
                : total === 0
                  ? 'Nenhum usuário'
                  : `${from}–${to} de ${total} usuário${total === 1 ? '' : 's'}`}
            </span>
            <button
              type="button"
              className={`btn-secondary !py-1.5 text-xs ${filtrosAtivos ? '!border-brand-400 !text-brand-700 dark:!text-brand-300' : ''}`}
              onClick={() => setFiltrosAbertos(!filtrosAbertos)}
              aria-expanded={filtrosAbertos}
              aria-controls="painel-filtros-usuarios"
              title={filtrosAbertos ? 'Ocultar os filtros avançados' : 'Mostrar os filtros avançados'}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Filtros</span>
              {filtrosAtivos > 0 && <span className="badge ml-0.5 !bg-brand-500 !text-white">{filtrosAtivos}</span>}
            </button>
            {(filtrosAtivos > 0 || q) && (
              <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={limparFiltros} title="Limpar a busca e todos os filtros">
                <X className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Limpar</span>
              </button>
            )}
          </div>
        </div>

        {/* Visões rápidas (segmentado) */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-navy-800 dark:bg-navy-950/40 sm:px-4">
          <span className="hidden shrink-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 sm:flex dark:text-navy-400">
            <ListFilter className="h-3.5 w-3.5" /> Visão
          </span>
          <div className="flex gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="Recortes prontos da lista">
            {visoes.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={v.ativo}
                onClick={v.ativo && v.id !== 'todos' ? limparFiltros : v.aplicar}
                title={v.ativo && v.id !== 'todos' ? 'Clique para remover este recorte' : undefined}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  v.ativo
                    ? 'border-navy-800 bg-navy-800 text-white shadow-sm dark:border-brand-500 dark:bg-brand-600'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-navy-700 dark:bg-navy-900 dark:text-navy-200 dark:hover:bg-navy-800'
                }`}
              >
                <v.icone className="h-3.5 w-3.5" />
                {v.rotulo}
                <span
                  className={`rounded px-1 py-px text-[10px] font-bold tabular-nums ${
                    v.ativo ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-navy-300'
                  }`}
                >
                  {v.total}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Caixabox de filtros (dobra, para não roubar espaço da lista) */}
        {filtrosAbertos && (
          <div id="painel-filtros-usuarios" className="border-b border-slate-200 bg-slate-50/40 px-3 py-3 dark:border-navy-800 dark:bg-navy-950/20 sm:px-4">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <CaixaFiltro rotulo="Perfil" icone={UserRound} ativo={!!fPerfil} onLimpar={() => setFPerfil('')}>
                <select className="input !py-1.5 text-xs font-semibold" value={fPerfil} onChange={(e) => { setFPerfil(e.target.value); setPage(1); }} aria-label="Filtrar por perfil">
                  <option value="">Todos os perfis</option>
                  <option value="admin">Administrador</option>
                  <option value="gerente">Gerente</option>
                  <option value="operador">Operador</option>
                </select>
              </CaixaFiltro>

              <CaixaFiltro rotulo="Status da conta" icone={Activity} ativo={!!fStatus} onLimpar={() => setFStatus('')}>
                <select className="input !py-1.5 text-xs font-semibold" value={fStatus} onChange={(e) => { setFStatus(e.target.value); setPage(1); }} aria-label="Filtrar por status da conta">
                  <option value="">Todos os status</option>
                  <option value="ativo">Ativo</option>
                  <option value="convite_pendente">Convite pendente</option>
                  <option value="convite_expirado">Convite expirado</option>
                  <option value="provisoria">Troca de senha pendente</option>
                  <option value="bloqueado">Bloqueado</option>
                  <option value="expirado">Acesso expirado</option>
                  <option value="inativo">Desativado</option>
                </select>
              </CaixaFiltro>

              <CaixaFiltro rotulo="Senha" icone={KeyRound} ativo={!!fSenha} onLimpar={() => setFSenha('')}>
                <select className="input !py-1.5 text-xs font-semibold" value={fSenha} onChange={(e) => { setFSenha(e.target.value); setPage(1); }} aria-label="Filtrar por situação da senha">
                  <option value="">Todas as situações</option>
                  <option value="propria">Definida pelo usuário</option>
                  <option value="provisoria">Provisória (troca pendente)</option>
                  <option value="convite_pendente">Aguardando convite</option>
                </select>
              </CaixaFiltro>

              <CaixaFiltro rotulo="MFA (2 fatores)" icone={Smartphone} ativo={!!fMfa} onLimpar={() => setFMfa('')}>
                <select className="input !py-1.5 text-xs font-semibold" value={fMfa} onChange={(e) => { setFMfa(e.target.value); setPage(1); }} aria-label="Filtrar por segundo fator">
                  <option value="">Com ou sem MFA</option>
                  <option value="sim">Com MFA ativado</option>
                  <option value="nao">Sem MFA</option>
                </select>
              </CaixaFiltro>

              <CaixaFiltro rotulo="Último acesso" icone={Clock} ativo={!!fAcesso || !!fParado} onLimpar={() => { setFAcesso(''); setFParado(''); }}>
                <select
                  className="input !py-1.5 text-xs font-semibold"
                  value={fAcesso || (fParado === 'sim' ? 'parado30d' : '')}
                  onChange={(e) => {
                    const val = e.target.value;
                    setFAcesso(val);
                    setFParado(val === 'parado30d' ? 'sim' : '');
                    setPage(1);
                  }}
                  aria-label="Filtrar por período do último acesso"
                >
                  <option value="">Qualquer período</option>
                  <option value="recente">Nos últimos 7 dias</option>
                  <option value="parado30d">Parado há 30+ dias</option>
                  <option value="nunca">Nunca acessou</option>
                </select>
              </CaixaFiltro>

              <CaixaFiltro rotulo="Situação" icone={Power} ativo={!!fAtivo} onLimpar={() => setFAtivo('')}>
                <select className="input !py-1.5 text-xs font-semibold" value={fAtivo} onChange={(e) => { setFAtivo(e.target.value); setPage(1); }} aria-label="Filtrar por situação (ativo ou desativado)">
                  <option value="">Ativos e desativados</option>
                  <option value="true">Somente ativos</option>
                  <option value="false">Somente desativados</option>
                </select>
              </CaixaFiltro>
            </div>
          </div>
        )}

        {/* Filtros ativos — leitura do que está estreitando a lista */}
        {(filtrosAtivos > 0 || debouncedQ) && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-navy-400">Filtros ativos</span>
            {debouncedQ && <ChipFiltro rotulo="Busca" valor={`"${debouncedQ}"`} onRemover={() => setQ('')} />}
            {fPerfil && <ChipFiltro rotulo="Perfil" valor={PERFIL_META[fPerfil]?.label || fPerfil} onRemover={() => setFPerfil('')} />}
            {fStatus && <ChipFiltro rotulo="Status" valor={STATUS_META[fStatus]?.label || fStatus} onRemover={() => setFStatus('')} />}
            {fSenha && <ChipFiltro rotulo="Senha" valor={SENHA_META[fSenha]?.label || fSenha} onRemover={() => setFSenha('')} />}
            {fMfa && <ChipFiltro rotulo="MFA" valor={fMfa === 'sim' ? 'Com MFA' : 'Sem MFA'} onRemover={() => setFMfa('')} />}
            {(fAcesso || fParado) && (
              <ChipFiltro
                rotulo="Acesso"
                valor={fAcesso === 'recente' ? 'Últimos 7 dias' : fAcesso === 'nunca' ? 'Nunca acessou' : 'Parado há 30+ dias'}
                onRemover={() => { setFAcesso(''); setFParado(''); }}
              />
            )}
            {fAtivo && <ChipFiltro rotulo="Situação" valor={fAtivo === 'true' ? 'Somente ativos' : 'Somente desativados'} onRemover={() => setFAtivo('')} />}
            <button type="button" className="btn-ghost ml-auto !py-0.5 text-xs font-semibold text-brand-600 hover:text-brand-800 dark:text-brand-400" onClick={limparFiltros}>
              Limpar tudo
            </button>
          </div>
        )}
      </section>

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
          <button className="btn-secondary !py-1.5 text-xs" onClick={() => exportarSelecao('csv')}>
            <Download className="h-3.5 w-3.5" /> Exportar CSV
          </button>
          <button className="btn-secondary !py-1.5 text-xs" onClick={() => exportarSelecao('xlsx')}>
            <Download className="h-3.5 w-3.5 text-emerald-600" /> Exportar XLSX
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
                  const souEu = eu && Number(eu.id) === Number(row.id);
                  const ativo = row.ativo !== false;
                  return (
                    <tr key={row.id} onClick={() => abrirFicha(Number(row.id))} title="Ver ficha completa" className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-navy-800/50 ${!ativo ? 'opacity-70 bg-slate-50/50' : ''} ${selecionado(Number(row.id)) ? '!bg-brand-50/60' : ''}`}>
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
                          <AvatarBox nome={row.nome} perfil={row.perfil} />
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-navy-900 dark:text-white">
                              {row.nome} {souEu && <span className="text-xs font-normal text-slate-400">(você)</span>}
                            </p>
                            <p className="truncate text-xs text-slate-500 dark:text-navy-300">{row.email}</p>
                            {row.cargo && <p className="truncate text-xs text-slate-400">{row.cargo}{row.departamento ? ` · ${row.departamento}` : ''}</p>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <TagPerfil perfil={row.perfil} />
                      </td>
                      <td>
                        <TagStatus row={row} />
                      </td>
                      <td>
                        <TagSenha row={row} />
                        {row.tentativas_falhas > 0 && (
                          <p className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-amber-600">
                            <AlertTriangle className="h-3 w-3" /> {row.tentativas_falhas} falha(s)
                          </p>
                        )}
                      </td>
                      <td>
                        <TagMfa row={row} />
                      </td>
                      <td className="whitespace-nowrap text-xs font-medium text-slate-600 dark:text-navy-200" title={formatDateTime(row.ultimo_login)}>
                        {row.ultimo_login ? formatRelative(row.ultimo_login) : <span className="text-slate-400 font-normal">Nunca acessou</span>}
                      </td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5 shadow-2xs dark:border-navy-700 dark:bg-navy-900">
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
          <ul className="divide-y divide-slate-100 lg:hidden dark:divide-navy-800">
            {data.rows.map((row) => {
              const souEu = eu && Number(eu.id) === Number(row.id);
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
                    <AvatarBox nome={row.nome} perfil={row.perfil} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => abrirFicha(Number(row.id))}>
                      <p className="truncate text-sm font-semibold text-navy-900 dark:text-white">
                        {row.nome} {souEu && <span className="font-normal text-slate-400">(você)</span>}
                      </p>
                      <p className="truncate text-xs text-slate-500 dark:text-navy-300">{row.email}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <TagPerfil perfil={row.perfil} />
                        <TagStatus row={row} />
                        <TagSenha row={row} />
                        <TagMfa row={row} />
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2.5 text-sm dark:border-navy-800">
            <span className="flex items-center gap-2 text-slate-500 dark:text-navy-300">
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
          onCertificar={(row) => {
            setCertificarRow(row);
            setCertObs('');
          }}
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
        open={!!reauth || !!lotePendente || politicaPendente}
        onClose={() => {
          // Cancelar a autorização não apaga o motivo já digitado.
          if (reauth?.tipo === 'desativar') {
            setDesativarRow(reauth.row);
            setMotivo(reauth.motivo || '');
          }
          if (reauth?.tipo === 'certificar') {
            setCertificarRow(reauth.row);
            setCertObs(reauth.motivo || '');
          }
          if (lotePendente?.acao === 'desativar') {
            setLoteDesativarIds(lotePendente.ids);
            setMotivo(lotePendente.motivo || '');
          }
          setReauth(null);
          setLotePendente(null);
          setPoliticaPendente(false);
        }}
        onConfirmed={() => {
          if (reauth) void executarSensivel(reauth);
          else if (lotePendente) void executarLote(lotePendente);
          else if (politicaPendente) void salvarPolitica();
          setReauth(null);
          setLotePendente(null);
          setPoliticaPendente(false);
        }}
        titulo={reauth ? tituloReauth(reauth.tipo, reauth.row) : lotePendente ? tituloLote(lotePendente) : politicaPendente ? 'Autorizar política de senha' : 'Autorização necessária'}
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

      {/* Política de senha configurável */}
      <Modal
        open={politicaAberta}
        onClose={() => !politicaSaving && setPoliticaAberta(false)}
        title="Política de senha"
        subtitle="Vale para convites, resets e trocas. A expiração cobra a troca no login."
        size="md"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setPoliticaAberta(false)} disabled={politicaSaving}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={salvarPolitica} disabled={politicaSaving || politicaLoading || !politicaForm}>
              {politicaSaving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar política
            </button>
          </>
        }
      >
        {politicaLoading || !politicaForm ? (
          <Spinner />
        ) : (
          <div className="space-y-4">
            {politicaErro && <Alert tone="red">{politicaErro}</Alert>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="label">Tamanho mínimo</span>
                <input
                  type="number"
                  className="input"
                  min={politicaLimites?.tamanho_minimo.min || 6}
                  max={politicaLimites?.tamanho_minimo.max || 64}
                  value={politicaForm.tamanho_minimo}
                  onChange={(e) => setPoliticaForm({ ...politicaForm, tamanho_minimo: Number(e.target.value) })}
                />
              </label>
              <label className="block">
                <span className="label">Histórico (não repetir)</span>
                <input
                  type="number"
                  className="input"
                  min={0}
                  max={politicaLimites?.historico_qtd.max || 10}
                  value={politicaForm.historico_qtd}
                  onChange={(e) => setPoliticaForm({ ...politicaForm, historico_qtd: Number(e.target.value) })}
                />
                <span className="mt-0.5 block text-[11px] text-slate-400">0 = desligado</span>
              </label>
              <label className="block">
                <span className="label">Expiração da senha</span>
                <select
                  className="input"
                  value={politicaForm.expiracao_dias}
                  onChange={(e) => setPoliticaForm({ ...politicaForm, expiracao_dias: Number(e.target.value) })}
                >
                  <option value={0}>Nunca expira</option>
                  <option value={30}>30 dias</option>
                  <option value={60}>60 dias</option>
                  <option value={90}>90 dias</option>
                  <option value={180}>180 dias</option>
                  <option value={365}>365 dias</option>
                </select>
              </label>
            </div>
            <div className="space-y-1.5">
              {(
                [
                  ['exigir_maiuscula_minuscula', 'Exigir maiúsculas e minúsculas'],
                  ['exigir_numero', 'Exigir ao menos um número'],
                  ['exigir_simbolo', 'Exigir ao menos um símbolo (!@#…)'],
                  ['proibir_obvias', 'Barrar senhas óbvias (123456, senha, nome da marca…)'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={politicaForm[k]}
                    onChange={(e) => setPoliticaForm({ ...politicaForm, [k]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <Alert tone="blue">
              Senhas temporárias (geradas pelo sistema) seguem isentas. Salvar exige a sua senha (reautenticação) e fica na auditoria.
            </Alert>
          </div>
        )}
      </Modal>

      {/* Certificação de acessos */}
      <Modal
        open={certAberto}
        onClose={() => setCertAberto(false)}
        title="Certificação de acessos"
        subtitle={certDados ? `${certDados.certificados} de ${certDados.ativos} acessos certificados · validade de ${certDados.validade_dias} dias` : 'Quem tem acesso a quê, e quando foi revisado.'}
        size="lg"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 text-sm dark:bg-navy-800" role="tablist" aria-label="Filtro da matriz">
            {(
              [
                ['todas', `Todas (${certDados?.total ?? 0})`],
                ['pendentes', `Pendentes (${certDados?.pendentes ?? 0})`],
                ['certificadas', `Certificadas (${certDados?.certificados ?? 0})`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={certFiltro === k}
                className={`rounded-md px-2 py-1.5 font-medium ${certFiltro === k ? 'bg-white shadow text-navy-900 dark:bg-navy-900 dark:text-white' : 'text-slate-500 dark:text-navy-300'}`}
                onClick={() => setCertFiltro(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-1.5">
            <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => exportarCertificacao('csv')} title="Exportar a matriz em CSV">
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
            <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => exportarCertificacao('xlsx')} title="Exportar a matriz em XLSX">
              <Download className="h-3.5 w-3.5 text-emerald-600" /> XLSX
            </button>
            <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={recarregarCert} disabled={certLoading}>
              <RefreshCw className={`h-3.5 w-3.5 ${certLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        {certLoading && !certDados ? (
          <Spinner />
        ) : (
          <ul className={`max-h-[55vh] space-y-2 overflow-auto pr-1 ${certLoading ? 'opacity-60' : ''}`}>
            {(certDados?.linhas || [])
              .filter((l) => (certFiltro === 'pendentes' ? l.precisa_recertificar : certFiltro === 'certificadas' ? !l.precisa_recertificar && l.ativo : true))
              .map((l) => {
                const souEu = eu && Number(eu.id) === l.id;
                return (
                  <li key={l.id} className="rounded-lg border border-slate-200 p-2.5 dark:border-navy-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <AvatarBox nome={l.nome} perfil={l.perfil} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-navy-900 dark:text-white">
                          {l.nome} {souEu && <span className="font-normal text-slate-400">(você)</span>}
                        </p>
                        <p className="truncate text-xs text-slate-500">{l.email}</p>
                      </div>
                      <TagPerfil perfil={l.perfil} />
                      <TagStatus row={l} />
                      {l.mfa ? <Badge tone="green">MFA</Badge> : <Badge tone="slate">Sem MFA</Badge>}
                    </div>
                    <p className="mt-1.5 text-xs text-slate-500 dark:text-navy-300">
                      {l.certificado_em ? (
                        <>
                          Certificado {l.certificado_ha_dias === 0 ? 'hoje' : `há ${l.certificado_ha_dias} dia(s)`} por <strong>{l.certificado_por}</strong>
                          {l.certificado_obs ? ` — ${l.certificado_obs}` : ''}
                          {l.precisa_recertificar && <span className="font-semibold text-amber-600"> · validade vencida, recertifique</span>}
                        </>
                      ) : l.ativo ? (
                        <span className="font-medium text-slate-500">Nunca certificado</span>
                      ) : (
                        <span className="text-slate-400">Conta desativada</span>
                      )}
                      {' '}· {l.ultimo_login ? `último acesso ${formatRelative(l.ultimo_login)}` : 'nunca acessou'}
                    </p>
                    {l.precisa_recertificar && !souEu && (
                      <button
                        className="btn-secondary mt-1.5 !px-2.5 !py-1 text-xs"
                        onClick={() => { setCertificarRow({ id: l.id, nome: l.nome, email: l.email }); setCertObs(''); }}
                        disabled={acaoBusy === `certificar-${l.id}`}
                      >
                        {acaoBusy === `certificar-${l.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />} Certificar
                      </button>
                    )}
                    {l.precisa_recertificar && !!souEu && (
                      <p className="mt-1 text-xs text-slate-400">Seu acesso precisa de outro administrador (quatro olhos).</p>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </Modal>

      {/* Certificar acesso (com observação opcional) */}
      <Modal
        open={!!certificarRow}
        onClose={() => setCertificarRow(null)}
        title={`Certificar acesso de ${certificarRow?.nome || ''}?`}
        subtitle="Você confirma que revisou perfil, permissões e necessidade deste acesso. O carimbo fica na auditoria."
        size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setCertificarRow(null)}>
              Cancelar
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                if (!certificarRow) return;
                pedirSensivel('certificar', certificarRow, { motivo: certObs.trim() || undefined });
                setCertificarRow(null);
              }}
            >
              <ClipboardCheck className="h-4 w-4" /> Certificar acesso
            </button>
          </>
        }
      >
        <label className="block">
          <span className="label">Observação (opcional)</span>
          <textarea
            className="input"
            rows={2}
            value={certObs}
            onChange={(e) => setCertObs(e.target.value)}
            placeholder="Ex.: revisão trimestral — perfil conferido com o RH"
            autoFocus
          />
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

      {/* Convite que não pôde ser entregue por e-mail (sem SMTP ou SMTP com falha) */}
      <Modal
        open={!!conviteLink}
        onClose={() => setConviteLink('')}
        title="Convite de acesso criado — entrega manual"
        subtitle="O e-mail automático não saiu (sem SMTP ou falha no SMTP). Envie o link abaixo para o usuário."
        size="md"
      >
        <div className="space-y-4">
          <Alert tone="blue">
            O convite é válido por <strong>48 horas</strong> e só pode ser usado uma vez. Quem recebe define a própria senha (ela nunca passa pelo administrador).
          </Alert>
          {meta?.emailLinks && (meta.emailLinks.appUrlIgnorada || (meta.emailLinks.base && meta.emailLinks.publica === false)) ? (
            <Alert tone="red">
              <strong>Este link não abre para o usuário.</strong> O endereço do ERP aponta para dentro do servidor
              (localhost, IP privado ou nome sem domínio), então quem recebe vê “URL inválida”. Salve o endereço
              público em{' '}
              <Link to="/config" className="font-medium underline underline-offset-2">Configurações › Sistema</Link> e gere o convite novamente.
            </Alert>
          ) : !meta?.emailLinks?.configurada ? (
            <Alert tone="amber">
              Confira se o endereço abaixo é mesmo o público do ERP: sem <code>APP_URL</code>, o link usa o endereço desta sessão. O ajuste aparece em{' '}
              <Link to="/config" className="font-medium underline underline-offset-2">Configurações</Link>.
            </Alert>
          ) : null}
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
    case 'certificar':
      return `Certificar acesso — ${nome}`;
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
      className={`card flex items-center gap-3 p-3 text-left sm:p-4 ${alerta ? 'border-red-200 bg-red-50/40 dark:border-red-900/40 dark:bg-red-950/30' : ''} ${ativo ? 'ring-2 ring-navy-800 dark:ring-brand-500 ring-offset-1 dark:ring-offset-navy-950' : ''} ${onClick ? 'transition-shadow hover:shadow-modal' : 'cursor-default'}`}
      title={onClick ? (ativo ? 'Clique para remover este filtro' : 'Clique para filtrar a lista') : undefined}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white sm:h-11 sm:w-11 ${cor}`}>{icone}</span>
      <div className="min-w-0">
        <div className="text-xl font-bold tabular-nums text-navy-900 dark:text-white">{valor === null ? <Loader2 className="h-5 w-5 animate-spin text-slate-300" /> : valor}</div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-navy-300">{rotulo}</div>
        <div className="truncate text-xs text-slate-400 dark:text-navy-400">{dica}</div>
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
      <button className="inline-flex items-center gap-1 hover:text-navy-800 dark:hover:text-white transition-colors font-semibold" onClick={() => onSort(field)}>
        {label}
        {sort?.field === field ? sort.dir === 'asc' ? <ArrowUp className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" /> : <ArrowDown className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" /> : <ArrowUpDown className="h-3 w-3 opacity-30" />}
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
          if (aberto) onFechar();
          else onAbrir();
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
            className="fixed z-40 max-h-[70vh] w-60 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-modal animate-fade-in dark:bg-navy-900 dark:border-navy-800"
            style={pos ? { top: pos.top, right: pos.right } : { visibility: 'hidden' }}
          >
            {itens.map((it) => (
              <div key={it.key}>
                {it.separadorAntes && <div className="mx-2 my-1 border-t border-slate-100 dark:border-navy-800" />}
                <button
                  role="menuitem"
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium ${
                    it.perigo ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-navy-800'
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
          <h3 className="mb-2 text-sm font-bold text-navy-900 dark:text-white">Dados do usuário</h3>
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
              <p className="-mt-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-200 sm:col-span-2 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800/60">
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
          <h3 className="mb-2 text-sm font-bold text-navy-900 dark:text-white">Acesso</h3>
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
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-navy-800 dark:bg-navy-800/40">
                <input type="checkbox" className="mt-1" checked={trocarSenha} onChange={(e) => setTrocarSenha(e.target.checked)} />
                <span>
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Exigir troca de senha no próximo acesso</span>
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
          <h3 className="mb-2 text-sm font-bold text-navy-900 dark:text-white">Permissões comerciais</h3>
          <p className="mb-2 text-xs text-slate-500 dark:text-navy-300">“Herdar do perfil” usa a regra do perfil (gerente/admin têm acesso). Permite refinar por pessoa.</p>
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
          <h3 className="mb-2 text-sm font-bold text-navy-900 dark:text-white">Alçadas comerciais</h3>
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
  onCertificar,
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
  onCertificar: (row: Usuario) => void;
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
            <AvatarBox nome={u.nome} perfil={u.perfil} tamanho="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <TagPerfil perfil={u.perfil} />
                <TagStatus row={u} />
                <TagMfa row={u} />
              </div>
              <p className="mt-1 text-sm text-slate-500 dark:text-navy-300">
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

          <div className="flex gap-1 border-b border-slate-200 dark:border-navy-800">
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
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === k ? 'border-navy-800 text-navy-900 dark:border-brand-500 dark:text-white' : 'border-transparent text-slate-400 hover:text-slate-600 dark:text-navy-300'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'resumo' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">E-mail</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{u.email}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Cargo</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{u.cargo || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Departamento</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{u.departamento || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Telefone</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{u.telefone || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Criado em</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{formatDateTime(u.criado_em)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Criado por</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{dados?.criador ? `${dados.criador.nome} (${dados.criador.email})` : '—'}</dd>
                </div>
                {u.acesso_expira_em && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500 dark:text-navy-300">Acesso expira em</dt>
                    <dd className={`font-medium ${u.acesso_expirado ? 'text-red-600' : 'text-slate-800 dark:text-slate-200'}`}>{formatDateTime(u.acesso_expira_em)}</dd>
                  </div>
                )}
              </dl>
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Último acesso</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{u.ultimo_login ? `${formatDateTime(u.ultimo_login)} (${formatRelative(u.ultimo_login)})` : 'Nunca acessou'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Último IP</dt>
                  <dd className="font-mono text-xs text-slate-800 dark:text-slate-200">{u.ultimo_ip || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Logins (30 dias)</dt>
                  <dd className="font-medium tabular-nums text-slate-800 dark:text-slate-200">{dados?.estatisticas.logins_30d ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Eventos (30 dias)</dt>
                  <dd className="font-medium tabular-nums text-slate-800 dark:text-slate-200">{dados?.estatisticas.eventos_30d ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500 dark:text-navy-300">Senha definida em</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{formatDateTime(u.senha_definida_em)}</dd>
                </div>
                {u.desativado_em && (
                  <>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500 dark:text-navy-300">Desativado em</dt>
                      <dd className="font-medium text-slate-800 dark:text-slate-200">{formatDateTime(u.desativado_em)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500 dark:text-navy-300">Desativado por</dt>
                      <dd className="font-medium text-slate-800 dark:text-slate-200">{u.desativado_por || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 dark:text-navy-300">Motivo</dt>
                      <dd className="mt-0.5 rounded-md bg-slate-50 p-2 text-slate-700 dark:bg-navy-800 dark:text-slate-200">{u.desativado_motivo || '—'}</dd>
                    </div>
                  </>
                )}
              </dl>
              {u.observacoes && (
                <div className="sm:col-span-2">
                  <p className="label">Observações internas</p>
                  <p className="rounded-md bg-slate-50 p-2.5 text-sm text-slate-700 dark:bg-navy-800 dark:text-slate-200">{u.observacoes}</p>
                </div>
              )}
              <div className="sm:col-span-2 flex flex-wrap gap-2 border-t border-slate-100 dark:border-navy-800 pt-3">
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
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900 dark:text-white">
                  <KeyRound className="h-4 w-4 text-navy-400" /> Senha e acesso
                </h4>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                  <TagSenha row={u} />
                  {u.trocar_senha && <Badge tone="amber">Troca obrigatória</Badge>}
                  {u.senha_expirada && <Badge tone="red">Senha vencida</Badge>}
                  {!u.senha_expirada && typeof u.senha_vence_em_dias === 'number' && (
                    <span className={`text-xs ${u.senha_vence_em_dias <= 7 ? 'font-semibold text-amber-600' : 'text-slate-500'}`}>
                      Senha vence em {u.senha_vence_em_dias} dia(s)
                    </span>
                  )}
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

              {/* Certificação de acessos */}
              <div className={`rounded-lg border p-3 ${u.acesso_certificado_em ? 'border-slate-200 dark:border-navy-800' : 'border-amber-200 bg-amber-50/50 dark:border-amber-800/60 dark:bg-amber-950/30'}`}>
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900 dark:text-white">
                  <ClipboardCheck className="h-4 w-4 text-navy-400" /> Certificação de acessos
                </h4>
                <p className="mt-1 text-sm text-slate-600 dark:text-navy-300">
                  {u.acesso_certificado_em ? (
                    <>
                      Certificado em {formatDateTime(u.acesso_certificado_em)} por <strong>{u.acesso_certificado_por || '—'}</strong>
                      {u.acesso_certificado_obs ? ` — ${u.acesso_certificado_obs}` : ''}
                      {Date.now() - new Date(String(u.acesso_certificado_em)).getTime() > 365 * 86400000 && (
                        <span className="font-semibold text-amber-600"> · validade de 12 meses vencida, recertifique</span>
                      )}
                    </>
                  ) : (
                    <span className="text-xs">Nunca certificado — confirme perfil, permissões e necessidade deste acesso.</span>
                  )}
                </p>
                {ativo && !!u.senha_definida_em && !souEu && (
                  <button className="btn-secondary mt-2 !px-2.5 !py-1.5 text-xs" onClick={() => onCertificar(u)} disabled={busy === `certificar-${u.id}`}>
                    {busy === `certificar-${u.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
                    {u.acesso_certificado_em ? 'Recertificar' : 'Certificar acesso...'}
                  </button>
                )}
                {souEu && <p className="mt-1 text-xs text-slate-400">Seu acesso precisa de outro administrador (quatro olhos).</p>}
              </div>

              {/* Bloqueio */}
              <div className={`rounded-lg border p-3 ${u.conta_bloqueada ? 'border-red-200 bg-red-50/50 dark:border-red-900/60 dark:bg-red-950/30' : 'border-slate-200 dark:border-navy-800'}`}>
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900 dark:text-white">
                  <ShieldAlert className="h-4 w-4 text-navy-400" /> Bloqueio e tentativas
                </h4>
                <p className="mt-1 text-sm text-slate-600 dark:text-navy-300">
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
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900 dark:text-white">
                  <Smartphone className="h-4 w-4 text-navy-400" /> MFA (dois fatores)
                </h4>
                <p className="mt-1 text-sm text-slate-600 dark:text-navy-300">
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
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                <h4 className="flex items-center gap-1.5 text-sm font-bold text-navy-900 dark:text-white">
                  <MonitorSmartphone className="h-4 w-4 text-navy-400" /> Sessões ativas ({dados?.sessoes.length ?? 0})
                </h4>
                {!dados?.sessoes.length ? (
                  <p className="mt-1 text-sm text-slate-400">Nenhuma sessão ativa.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-100 dark:divide-navy-800">
                    {dados.sessoes.map((s) => (
                      <li key={s.sid} className="flex items-start justify-between gap-2 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-800 dark:text-slate-200">
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
                <h4 className="mb-2 text-sm font-bold text-navy-900 dark:text-white">Últimos acessos ({dados?.acessos_total ?? 0})</h4>
                {!dados?.acessos.length ? (
                  <p className="text-sm text-slate-400">Nenhum acesso registrado.</p>
                ) : (
                  <ol className="relative ml-1 max-h-72 space-y-3 overflow-auto border-l-2 border-slate-100 dark:border-navy-800 py-1 pl-4 pr-1">
                    {dados.acessos.map((a) => (
                      <li key={a.id} className="relative text-xs text-slate-600 dark:text-navy-300">
                        <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-navy-900 ${String(a.descricao || '').startsWith('Falha') ? 'bg-red-500' : 'bg-emerald-500'}`} />
                        <p className="font-medium text-slate-700 dark:text-slate-200">{formatDateTime(a.data)}</p>
                        <p className="mt-0.5">{a.descricao}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-bold text-navy-900 dark:text-white">Trilha da conta ({dados?.historico_total ?? 0})</h4>
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
                  <ol className="relative ml-1 max-h-72 space-y-3 overflow-auto border-l-2 border-slate-100 dark:border-navy-800 py-1 pl-4 pr-1">
                    {historicoFiltrado.map((h) => (
                      <li key={h.id} className="relative text-xs text-slate-600 dark:text-navy-300">
                        <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-navy-900 ${ACAO_DOT[String(h.acao)] || 'bg-slate-300'}`} />
                        <p className="font-medium text-slate-700 dark:text-slate-200">
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
  convite: 'bg-navy-500',
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
    <dl className="mt-1.5 space-y-1 rounded-md border border-slate-200 bg-white p-2 dark:border-navy-800 dark:bg-navy-950/50">
      {entradas.map(([campo, m]) => (
        <div key={campo} className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-5">
          <dt className="font-semibold text-slate-500 dark:text-navy-300">{CAMPO_LABEL[campo] || campo}:</dt>
          <dd className="text-slate-400 line-through">{formatarValorDiff(campo, m.de)}</dd>
          <dd aria-hidden className="text-slate-300">→</dd>
          <dd className="font-medium text-slate-700 dark:text-slate-200">{formatarValorDiff(campo, m.para)}</dd>
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
          <line key={f} x1={0} x2={W} y1={PAD_T + area * (1 - f)} y2={PAD_T + area * (1 - f)} className="stroke-slate-100 dark:stroke-navy-800" strokeWidth={1} />
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
                <text x={cx - 6.5} y={base - hL - 3} textAnchor="middle" className="fill-slate-500 dark:fill-navy-300" fontSize={9}>
                  {p.logins}
                </text>
              )}
              {p.falhas > 0 && (
                <text x={cx + 6.5} y={base - hF - 3} textAnchor="middle" className="fill-red-500" fontSize={9}>
                  {p.falhas}
                </text>
              )}
              <text x={cx} y={H - 8} textAnchor="middle" className="fill-slate-400 dark:fill-navy-400" fontSize={10}>
                {rotulo}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-4 text-xs text-slate-500 dark:text-navy-300">
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
