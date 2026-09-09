import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle as AlertTriangleIcon,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3 as BarChartIcon,
  CheckCircle2 as CheckCircle2Icon,
  Cog,
  ChevronLeft,
  ChevronRight,
  Download,
  Copy,
  Eye,
  EyeOff,
  Mail,
  Factory as FactoryIcon,
  FileUp,
  Inbox,
  KeyRound,
  ListFilter,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useMeta, type Field, type ListResult, type Option, type PublicFile, type ResourceMeta } from '../lib/meta';
import { ColorDot, ImageField, Lightbox, Thumb } from '../components/ImageField';
import { formatCell } from '../lib/format';
import { BarrasVerticais } from '../components/Charts';
import { DETALHE_DIRETO, type Module } from '../modules';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, EmptyState, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import ReauthModal from '../components/ReauthModal';
import { fieldErrors, initialValues, RecordForm, toPayload, useRefOptions, type FormValues } from '../components/RecordForm';
import { IMPORT_TIPOS, ImportModal } from '../components/ImportModal';
import PlannedModule from './PlannedModule';
import CatalogoShareModal from '../components/CatalogoShareModal';
import CatalogoInsights from '../components/CatalogoInsights';
import PortalAccessModal from '../components/PortalAccessModal';

// Páginas especializadas pesadas: carregadas sob demanda, só quando o módulo
// correspondente é aberto — evitam engordar o bundle de quem só usa cadastros simples.
const EstoqueGradePage = lazy(() => import('./EstoqueGradePage'));
const MedidasPage = lazy(() => import('./MedidasPage'));
const InventarioModulePage = lazy(() => import('./InventarioModulePage'));
const CustoPage = lazy(() => import('./CustoPage'));
const RelatoriosPage = lazy(() => import('./RelatoriosPage'));
const FinanceiroPage = lazy(() => import('./FinanceiroPage'));
const AjudaPage = lazy(() => import('./AjudaPage'));
const UsuariosPage = lazy(() => import('./UsuariosPage'));
const WebhooksPage = lazy(() => import('./WebhooksPage'));

const PAGE_SIZE = 25;

function SubPageLoading() {
  return <Spinner label="Carregando módulo..." />;
}

export default function ModulePage({ module }: { module: Module }) {
  const meta = useMeta();
  const resource = module.resource ? meta.resources[module.resource] : undefined;

  if (module.id === 'usuarios') return <Suspense fallback={<SubPageLoading />}><UsuariosPage /></Suspense>;
  if (module.id === 'webhooks') return <Suspense fallback={<SubPageLoading />}><WebhooksPage /></Suspense>;
  if (module.id === 'estoque') return <Suspense fallback={<SubPageLoading />}><EstoqueGradePage /></Suspense>;
  if (module.id === 'medidas') return <Suspense fallback={<SubPageLoading />}><MedidasPage /></Suspense>;
  if (module.id === 'inventario') return <Suspense fallback={<SubPageLoading />}><InventarioModulePage /></Suspense>;
  if (module.id === 'custo') return <Suspense fallback={<SubPageLoading />}><CustoPage /></Suspense>;
  if (module.id === 'relatorios') return <Suspense fallback={<SubPageLoading />}><RelatoriosPage /></Suspense>;
  if (module.id === 'financeiro') return <Suspense fallback={<SubPageLoading />}><FinanceiroPage /></Suspense>;
  if (module.id === 'ajuda') return <Suspense fallback={<SubPageLoading />}><AjudaPage /></Suspense>;

  if (!module.resource || !resource) return <PlannedModule module={module} />;
  return <ResourceCrud key={resource.key} module={module} resource={resource} />;
}

// ----------------------------------------------------------------------------
// CRUD genérico de um recurso
// ----------------------------------------------------------------------------
function ResourceCrud({ module, resource }: { module: Module; resource: ResourceMeta }) {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const meta = useMeta();
  const defaultLocal = meta?.defaultLocal ?? null;
  const hasImages = !!resource.images;
  const [zoom, setZoom] = useState<{ file: PublicFile; files: PublicFile[] } | null>(null);
  const isOperador = user?.perfil === 'operador';
  const herdaComercial = user?.perfil === 'admin' || user?.perfil === 'gerente';
  const permite = (v: string | undefined) => user?.perfil === 'admin' || v === 'permitir' || (v !== 'negar' && herdaComercial);
  const podeGerirCatalogos = resource.key !== 'catalogos' || permite(user?.perm_catalogos);
  const canCreate = resource.ops.create && podeGerirCatalogos;
  const canUpdate = resource.ops.update && podeGerirCatalogos;
  const canDelete = resource.ops.delete && !isOperador && podeGerirCatalogos;
  const readOnly = !canCreate && !canUpdate && !canDelete;

  // Lista
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [clientePortal, setClientePortal] = useState<Record<string, any> | null>(null);
  const [catalogoCompartilhar, setCatalogoCompartilhar] = useState<Record<string, any> | null>(null);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);

  // Formulário (modal)
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [values, setValues] = useState<FormValues>(() => initialValues(resource, null, defaultLocal));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [optionsKey, setOptionsKey] = useState(0);
  const refOptions = useRefOptions(resource, optionsKey);

  // Movimentações: o tamanho deve vir da grade do produto escolhido — sem isso
  // dá para lançar “PP” numa calça 36-48 e o saldo vira bagunça.
  const gradeAware = resource.key === 'movimentacoes';
  const produtoDoFormulario = gradeAware ? String(values.produto_id ?? '') : '';
  const [tamanhosDaGrade, setTamanhosDaGrade] = useState<Option[] | null>(null);
  const [gradeDoFormulario, setGradeDoFormulario] = useState('');
  useEffect(() => {
    if (!gradeAware || !produtoDoFormulario) {
      setTamanhosDaGrade(null);
      setGradeDoFormulario('');
      return;
    }
    let alive = true;
    api
      .get<{ grade: { id: number; nome: string } | null; tamanhos: { id: number; codigo: string }[] }>(`/produtos/${produtoDoFormulario}/tamanhos`)
      .then((d) => {
        if (!alive) return;
        const lista = (d.tamanhos ?? []).map((t) => ({ value: t.id, label: t.codigo }));
        setTamanhosDaGrade(lista);
        setGradeDoFormulario(d.grade?.nome ?? '');
        if (!lista.length) return;
        // Produto trocado e o tamanho anterior não pertence à nova grade → limpa.
        const validos = new Set(lista.map((t) => t.value));
        setValues((v) => {
          const atual = Number(String(v.tamanho_id ?? ''));
          if (!atual || validos.has(atual)) return v;
          return { ...v, tamanho_id: '' };
        });
      })
      .catch(() => {
        if (!alive) return;
        setTamanhosDaGrade(null);
        setGradeDoFormulario('');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradeAware, produtoDoFormulario]);

  const refOptionsForm = useMemo(
    () => (gradeAware && tamanhosDaGrade && tamanhosDaGrade.length ? { ...refOptions, tamanhos: tamanhosDaGrade } : refOptions),
    [gradeAware, tamanhosDaGrade, refOptions]
  );

  // Fase 5 — exportação, importação e filtros avançados
  const importTipo = IMPORT_TIPOS.find((t) => t.recurso === resource.key);
  const [importOpen, setImportOpen] = useState(false);
  const [showFiltros, setShowFiltros] = useState(false);
  const [filtros, setFiltros] = useState<Record<string, string>>({});

  // Exclusão
  const [toDelete, setToDelete] = useState<Record<string, any> | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Estorno de movimentações
  const [toEstornar, setToEstornar] = useState<Record<string, any> | null>(null);
  const [estornando, setEstornando] = useState(false);

  /** Estorna uma movimentação (cria lançamento inverso e marca como estornada). */
  async function confirmarEstorno() {
    if (!toEstornar) return;
    setEstornando(true);
    try {
      await api.post(`/movimentacoes/${toEstornar.id}/estornar`, {});
      toast.success('Movimentação estornada com sucesso. O lançamento inverso foi criado automaticamente.');
      setToEstornar(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível estornar a movimentação.');
    } finally {
      setEstornando(false);
    }
  }

  // Fluxo profissional de acesso (somente no módulo Usuários):
  // convite por e-mail + senha temporária de EXIBIÇÃO ÚNICA (nunca recuperável).
  const [senhaTempUser, setSenhaTempUser] = useState<Record<string, any> | null>(null);
  const [senhaTempValor, setSenhaTempValor] = useState('');
  const [conviteLink, setConviteLink] = useState('');
  const [reauthAcao, setReauthAcao] = useState<null | 'senha-temporaria'>(null);
  const [conviteBusyId, setConviteBusyId] = useState<number | null>(null);

  /** Reenviar convite de acesso (usuário ainda sem senha definida). */
  async function reenviarConvite(row: Record<string, any>) {
    setConviteBusyId(Number(row.id));
    try {
      const d = await api.post<{ convite_link?: string }>(`/usuarios/${row.id}/reenviar-convite`, {});
      if (d.convite_link) setConviteLink(d.convite_link);
      else toast.success(`Convite reenviado para ${row.email}.`);
      await load();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível reenviar o convite.');
    } finally {
      setConviteBusyId(null);
    }
  }

  /** 1º passo da senha temporária: reautenticação (o servidor exige senha recente). */
  function pedirSenhaTemporaria(row: Record<string, any>) {
    setSenhaTempUser(row);
    setReauthAcao('senha-temporaria');
  }

  /** 2º passo: com a reautenticação validada, gera a senha (mostrada uma única vez). */
  async function gerarSenhaTemporaria() {
    if (!senhaTempUser) return;
    try {
      const d = await api.post<{ senha_temporaria: string; sessoes_encerradas: number }>(`/usuarios/${senhaTempUser.id}/senha-temporaria`, {});
      setSenhaTempValor(d.senha_temporaria);
      toast.success(`Senha temporária gerada para ${senhaTempUser.email}.`);
      await load();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setReauthAcao('senha-temporaria');
        return;
      }
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível gerar a senha temporária.');
      setSenhaTempUser(null);
    }
  }

  // Campos virtuais só entram na tabela se pedirem explicitamente (list: true),
  // ex.: "Senha" em usuários, que mostra o estado e não o valor.
  const listFields = useMemo(() => resource.fields.filter((f) => f.list !== false && (!f.virtual || f.list === true) && f.type !== 'password' && f.type !== 'images'), [resource]);
  const searchable = resource.fields.some((f) => f.search);
  const filtroFields = useMemo(
    () =>
      resource.fields.filter((f) => f.form !== false && !f.readonly && (f.type === 'select' || f.type === 'ref' || f.type === 'boolean' || f.type === 'date')).slice(0, 8),
    [resource]
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQ(q.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const paramsAtuais = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set('q', debouncedQ);
    if (sort) {
      params.set('sort', sort.field);
      params.set('dir', sort.dir);
    }
    for (const [k, v] of Object.entries(filtros)) if (v !== undefined && v !== '') params.set(`f.${k}`, v);
    return params.toString();
  }, [debouncedQ, sort, filtros]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<ListResult>(`/${resource.key}?page=${page}&pageSize=${PAGE_SIZE}${paramsAtuais ? `&${paramsAtuais}` : ''}`);
      setData(d);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / PAGE_SIZE)));
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [resource.key, page, paramsAtuais]);

  /** Exporta a lista atual (honrando busca, ordenação e filtros). */
  async function exportarLista(formato: 'csv' | 'xlsx') {
    try {
      await downloadFile(`/${resource.key}/export?format=${formato}&${paramsAtuais}`, `${resource.key}.${formato}`);
      toast.success(`Exportação ${formato.toUpperCase()} gerada.`);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível exportar.');
    }
  }

  useEffect(() => {
    load();
  }, [load]);

  // --- formulário ---
  function openCreate() {
    setEditing(null);
    setValues(initialValues(resource, null, defaultLocal));
    setErrors({});
    setFormError('');
    setOptionsKey((k) => k + 1);
    setFormOpen(true);
  }

  function openEdit(row: Record<string, any>) {
    // Módulos com página de detalhe própria (OP, ficha técnica): edita lá.
    if (DETALHE_DIRETO.has(module.id)) {
      navigate(`/${resource.key}/${row.id}`);
      return;
    }
    setEditing(row);
    setValues(initialValues(resource, row));
    setErrors({});
    setFormError('');
    setOptionsKey((k) => k + 1);
    setFormOpen(true);
  }

  function clearForm() {
    setValues(initialValues(resource, null, defaultLocal));
    setErrors({});
    setFormError('');
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
  }

  function onChange(name: string, value: string | boolean | string[]) {
    setValues((v) => ({ ...v, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: '' }));
  }

  /** Validação local rápida (obrigatórios) antes de chamar a API. */
  function validateLocal(): boolean {
    const errs: Record<string, string> = {};
    for (const f of resource.fields) {
      if (f.form === false || f.readonly) continue;
      const required = f.required || (!editing && f.requiredOnCreate);
      const v = values[f.name];
      if (required && f.type === 'multiref') {
        if (!Array.isArray(v) || v.length === 0) errs[f.name] = 'Selecione ao menos um item';
      } else if (required && f.type !== 'boolean' && (v === undefined || String(v).trim() === '')) {
        errs[f.name] = 'Campo obrigatório';
      }
      if (f.type === 'password' && typeof v === 'string' && v && f.min && v.length < f.min) errs[f.name] = `Mínimo de ${f.min} caracteres`;
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Preencha os campos obrigatórios destacados.');
      return false;
    }
    return true;
  }

  async function submit() {
    setFormError('');
    if (!validateLocal()) return;
    setSaving(true);
    try {
      const payload = toPayload(resource, values, !!editing);
      if (editing) {
        await api.put(`/${resource.key}/${editing.id}`, payload);
        toast.success(`${resource.singular} salvo(a) com sucesso.`);
        setFormOpen(false);
      } else {
        const created = await api.post<Record<string, any>>(`/${resource.key}`, payload);
        if (resource.key === 'usuarios') {
          // Convite por e-mail: com SMTP o link vai direto para o usuário;
          // sem SMTP o link volta na resposta para ser entregue manualmente.
          if (created?.convite_link) {
            setFormOpen(false);
            setConviteLink(String(created.convite_link));
            await load();
            return;
          }
          toast.success(`${resource.singular} incluído(a). Convite de acesso enviado por e-mail.`);
          setValues(initialValues(resource, null, defaultLocal));
          setErrors({});
          await load();
          return;
        }
        if (resource.key === 'catalogos' && created?.id) {
          toast.success('Catálogo criado. Agora compartilhe o link com seus clientes.');
          setFormOpen(false);
          setCatalogoCompartilhar(created);
          await load();
          return;
        }
        if (resource.detail && !hasImages && created?.id) {
          // Módulos com página de detalhe própria (vendas, compras): abre o pedido
          toast.success(`${resource.singular} incluído(a). Adicione os itens do pedido.`);
          navigate(`/${resource.key}/${created.id}`);
          return;
        }
        if (hasImages && created?.id) {
          // Abre o registro recém-criado em modo edição para permitir anexar fotos
          toast.success(`${resource.singular} incluído(a). Agora você pode adicionar as fotos.`);
          setEditing(created);
          setValues(initialValues(resource, created));
          setErrors({});
        } else {
          toast.success(`${resource.singular} incluído(a) com sucesso.`);
          // Mantém o formulário aberto e limpo para o próximo cadastro
          setValues(initialValues(resource, null, defaultLocal));
          setErrors({});
          document.getElementById(`form-${resource.key}`)?.querySelector<HTMLElement>('input, select, textarea')?.focus();
        }
      }
      await load();
    } catch (e: any) {
      const fe = fieldErrors(e);
      setErrors(fe);
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.del(`/${resource.key}/${toDelete.id}`);
      toast.success(`${resource.singular} excluído(a).`);
      setToDelete(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível excluir.');
    } finally {
      setDeleting(false);
    }
  }

  function toggleSort(f: Field) {
    if (f.virtual) return;
    setSort((s) => (s?.field === f.name ? (s.dir === 'asc' ? { field: f.name, dir: 'desc' } : null) : { field: f.name, dir: 'asc' }));
    setPage(1);
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, page * PAGE_SIZE);
  const Icon = module.icon;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Icon className="h-5 w-5" />
            </span>
            {module.label}
          </span>
        }
        description={module.description}
        actions={
          <>
            <button className="btn-secondary" onClick={load} disabled={loading} title="Atualizar lista">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
            {filtroFields.length > 0 && (
              <button className={`btn-secondary ${Object.keys(filtros).length ? '!border-brand-400 !text-brand-700' : ''}`} onClick={() => setShowFiltros((v) => !v)} title="Filtros avançados">
                <ListFilter className="h-4 w-4" />
                <span className="hidden sm:inline">Filtros</span>
                {Object.keys(filtros).length > 0 && (
                  <span className="badge ml-1 !bg-brand-500 !text-white">{Object.keys(filtros).length}</span>
                )}
              </button>
            )}
            <button className="btn-secondary" onClick={() => exportarLista('csv')} disabled={loading} title="Exportar a lista atual em CSV (Excel)">
              <Download className="h-4 w-4" />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button className="btn-secondary" onClick={() => exportarLista('xlsx')} disabled={loading} title="Exportar a lista atual em XLSX">
              <Download className="h-4 w-4 text-emerald-600" />
              <span className="hidden md:inline">XLSX</span>
            </button>
            {importTipo && !isOperador && (
              <button className="btn-secondary" onClick={() => setImportOpen(true)} title={`Importar ${importTipo.label.toLowerCase()} de CSV/XLSX`}>
                <FileUp className="h-4 w-4" />
                <span className="hidden sm:inline">Importar</span>
              </button>
            )}
            {canCreate && (
              <button className="btn-accent" onClick={openCreate}>
                <Plus className="h-4 w-4" /> Novo {resource.singular.toLowerCase()}
              </button>
            )}
          </>
        }
      />

      {resource.key === 'ordens' && <ProducaoCockpit />}
      {resource.key === 'catalogos' && permite(user?.perm_metricas) && <CatalogoInsights />}

      {resource.notice && (
        <div className="mb-4">
          <Alert tone={readOnly ? 'slate' : 'blue'}>{resource.notice}</Alert>
        </div>
      )}

      {showFiltros && filtroFields.length > 0 && (
        <div className="card mb-4 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-navy-900">Filtros avançados</h3>
            <button className="btn-ghost text-xs" onClick={() => { setFiltros({}); setPage(1); }}>
              Limpar filtros
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtroFields.map((f) => (
              <FiltroCampo
                key={f.name}
                field={f}
                filtros={filtros}
                opcoes={f.type === 'ref' && f.ref ? refOptions[f.ref] : undefined}
                onChange={(chave, valor) => setFiltros((prev) => ({ ...prev, [chave]: valor }))}
              />
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        {/* Barra de ferramentas */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
          {searchable && (
            <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9 pr-8" placeholder={`Buscar em ${module.label.toLowerCase()}...`} value={q} onChange={(e) => setQ(e.target.value)} />
              {q && (
                <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setQ('')} aria-label="Limpar busca">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <div className="ml-auto text-xs text-slate-500">
            {loading && !data ? 'Carregando...' : total === 0 ? 'Nenhum registro' : `${from}–${to} de ${total} registro${total === 1 ? '' : 's'}`}
          </div>
        </div>

        {error && (
          <div className="p-4">
            <Alert tone="red">{error}</Alert>
          </div>
        )}

        {!error && loading && !data && <Spinner />}

        {!error && data && data.rows.length === 0 && (
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title={debouncedQ ? 'Nada encontrado' : `Nenhum(a) ${resource.singular.toLowerCase()} cadastrado(a)`}
            description={debouncedQ ? `Nenhum resultado para "${debouncedQ}".` : canCreate ? `Clique em "Novo ${resource.singular.toLowerCase()}" para fazer o primeiro cadastro.` : undefined}
            action={
              debouncedQ ? (
                <button className="btn-secondary" onClick={() => setQ('')}>
                  Limpar busca
                </button>
              ) : canCreate ? (
                <button className="btn-accent" onClick={openCreate}>
                  <Plus className="h-4 w-4" /> Novo {resource.singular.toLowerCase()}
                </button>
              ) : undefined
            }
          />
        )}

        {!error && data && data.rows.length > 0 && (
          <div className={`hidden overflow-x-auto md:block ${loading ? 'opacity-60' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <th className="w-16">#</th>
                  {hasImages && <th className="w-14">Foto</th>}
                  {listFields.map((f) => (
                    <th key={f.name}>
                      <button className="inline-flex items-center gap-1 hover:text-navy-800" onClick={() => toggleSort(f)}>
                        {f.label}
                        {sort?.field === f.name ? sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-30" />}
                      </button>
                    </th>
                  ))}
                  {(canUpdate || canDelete || resource.detail) && <th className="w-28 text-right">Ações</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`${canUpdate || resource.detail ? 'cursor-pointer' : ''} ${resource.key === 'movimentacoes' && row.estornado ? 'opacity-50 line-through' : ''}`}
                    onDoubleClick={() => (resource.detail ? navigate(`/${resource.key}/${row.id}`) : canUpdate && openEdit(row))}
                  >
                    <td className="font-mono text-xs text-slate-400">{row.id}</td>
                    {hasImages && (
                      <td>
                        <Thumb src={row.foto_url} alt={rowLabel(resource, row)} onClick={row.fotos?.length ? () => setZoom({ file: row.fotos[0], files: row.fotos }) : undefined} />
                      </td>
                    )}
                    {listFields.map((f) => (
                      <td key={f.name} className={f.type === 'money' || f.type === 'number' || f.type === 'integer' || f.type === 'percent' ? 'text-right tabular-nums' : ''}>
                        <Cell f={f} row={row} />
                      </td>
                    ))}
                    {(canUpdate || canDelete || resource.detail) && (
                      <td className="text-right">
                        <div className="inline-flex items-center gap-1">
                          {resource.key === 'clientes' && canUpdate && (
                            <button className="btn-icon !bg-navy-50 !text-navy-700" onClick={() => setClientePortal(row)} title="Portal do cliente" aria-label="Portal do cliente"><KeyRound className="h-4 w-4" /></button>
                          )}
                          {resource.key === 'clientes' && canUpdate && (
                        <button className="btn-icon !bg-navy-50 !text-navy-700" onClick={() => setClientePortal(row)} aria-label="Portal do cliente"><KeyRound className="h-4 w-4" /></button>
                      )}
                      {resource.key === 'catalogos' && permite(user?.perm_compartilhar) && (
                            <button className="btn-icon !bg-brand-50 !text-brand-700 hover:!bg-brand-100" onClick={() => setCatalogoCompartilhar(row)} title="Compartilhar catálogo" aria-label="Compartilhar catálogo">
                              <Share2 className="h-4 w-4" />
                            </button>
                          )}
                          {resource.key === 'usuarios' && canUpdate && !row.senha_definida_em && (
                            <button className="btn-icon" onClick={() => reenviarConvite(row)} disabled={conviteBusyId === Number(row.id)} title="Reenviar convite de acesso" aria-label="Reenviar convite">
                              {conviteBusyId === Number(row.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                            </button>
                          )}
                          {resource.key === 'usuarios' && canUpdate && !!row.senha_definida_em && (
                            <button className="btn-icon" onClick={() => pedirSenhaTemporaria(row)} title="Gerar senha temporária (exibição única)" aria-label="Gerar senha temporária"><KeyRound className="h-4 w-4" /></button>
                          )}
                          {resource.detail && (
                            <button className="btn-icon" onClick={() => navigate(`/${resource.key}/${row.id}`)} title="Ver detalhes" aria-label="Ver detalhes">
                              <Eye className="h-4 w-4" />
                            </button>
                          )}
                          {canUpdate && (
                            <button className="btn-icon" onClick={() => openEdit(row)} title="Editar" aria-label="Editar">
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                          {resource.key === 'movimentacoes' && !row.estornado && (user?.perfil === 'admin' || user?.perfil === 'gerente') && (
                            <button className="btn-icon hover:!bg-amber-50 hover:!text-amber-600" onClick={() => setToEstornar(row)} title="Estornar movimentação (cria lançamento inverso)" aria-label="Estornar">
                              <RotateCcw className="h-4 w-4" />
                            </button>
                          )}
                          {canDelete && (
                            <button className="btn-icon hover:!bg-red-50 hover:!text-red-600" onClick={() => setToDelete(row)} title="Excluir" aria-label="Excluir">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Celular (< 768 px): cartões em vez de tabela */}
        {!error && data && data.rows.length > 0 && (
          <ul className="divide-y divide-slate-100 md:hidden">
            {data.rows.map((row) => {
              const rotulo = rowLabel(resource, row);
              return (
                <li key={row.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      className="min-w-0 text-left"
                      onClick={() => (resource.detail || DETALHE_DIRETO.has(module.id) ? navigate(`/${resource.key}/${row.id}`) : canUpdate ? openEdit(row) : undefined)}
                    >
                      <div className="truncate text-sm font-semibold text-navy-900">{rotulo}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                        {listFields.slice(0, 3).map((f) => (
                          <span key={f.name}>
                            <Cell f={f} row={row} />
                          </span>
                        ))}
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {resource.key === 'catalogos' && permite(user?.perm_compartilhar) && (
                        <button className="btn-icon !bg-brand-50 !text-brand-700" onClick={() => setCatalogoCompartilhar(row)} aria-label="Compartilhar catálogo">
                          <Share2 className="h-4 w-4" />
                        </button>
                      )}
                      {resource.key === 'usuarios' && canUpdate && !row.senha_definida_em && (
                        <button className="btn-icon" onClick={() => reenviarConvite(row)} disabled={conviteBusyId === Number(row.id)} aria-label="Reenviar convite">
                          {conviteBusyId === Number(row.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                        </button>
                      )}
                      {resource.key === 'usuarios' && canUpdate && !!row.senha_definida_em && (
                        <button className="btn-icon" onClick={() => pedirSenhaTemporaria(row)} aria-label="Gerar senha temporária"><KeyRound className="h-4 w-4" /></button>
                      )}
                      {resource.detail && (
                        <button className="btn-icon" onClick={() => navigate(`/${resource.key}/${row.id}`)} aria-label="Ver detalhes">
                          <Eye className="h-4 w-4" />
                        </button>
                      )}
                      {canUpdate && !resource.detail && (
                        <button className="btn-icon" onClick={() => openEdit(row)} aria-label="Editar">
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                      {resource.key === 'movimentacoes' && !row.estornado && (user?.perfil === 'admin' || user?.perfil === 'gerente') && (
                        <button className="btn-icon hover:!bg-amber-50 hover:!text-amber-600" onClick={() => setToEstornar(row)} aria-label="Estornar">
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      )}
                      {canDelete && (
                        <button className="btn-icon hover:!bg-red-50 hover:!text-red-600" onClick={() => setToDelete(row)} aria-label="Excluir">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Paginação */}
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

      {/* Celular: botão flutuante (FAB) para incluir */}
      {canCreate && (
        <button
          className="btn-accent fixed bottom-5 right-5 z-40 rounded-full px-4 py-3.5 shadow-modal md:hidden"
          onClick={openCreate}
          aria-label={`Novo ${resource.singular.toLowerCase()}`}
        >
          <Plus className="h-5 w-5" />
          <span className="sr-only">Novo {resource.singular.toLowerCase()}</span>
        </button>
      )}

      {/* Reautenticação (step-up) para gerar senha temporária */}
      <ReauthModal
        open={reauthAcao === 'senha-temporaria'}
        onClose={() => {
          setReauthAcao(null);
          if (!senhaTempValor) setSenhaTempUser(null);
        }}
        onConfirmed={gerarSenhaTemporaria}
        titulo={senhaTempUser ? `Autorizar senha temporária — ${senhaTempUser.nome}` : 'Autorização necessária'}
      />

      {/* Senha temporária: EXIBIÇÃO ÚNICA — não existe como rever */}
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
            pode ser vista nem por administradores depois desta tela. O usuário deverá trocá-la no próximo acesso.
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

      {/* Convite gerado sem SMTP: link para entregar manualmente */}
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

      <PortalAccessModal cliente={clientePortal} onClose={() => setClientePortal(null)} />
      <CatalogoShareModal catalogo={catalogoCompartilhar} onClose={() => setCatalogoCompartilhar(null)} />

      {importTipo && (
        <ImportModal open={importOpen} onClose={() => setImportOpen(false)} tipoConfig={importTipo} onDone={() => load()} />
      )}

      {/* Modal de cadastro / edição */}
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={editing ? `Editar ${resource.singular.toLowerCase()}` : `Novo ${resource.singular.toLowerCase()}`}
        subtitle={
          editing
            ? `Registro #${editing.id}`
            : hasImages
              ? 'Preencha os dados e clique em Incluir. Depois de salvar você poderá adicionar as fotos.'
              : `Preencha os dados e clique em Incluir. Os campos com * são obrigatórios.`
        }
        size={resource.fields.filter((f) => f.form !== false && !f.readonly).length > 6 ? 'lg' : 'md'}
      >
        {formError && (
          <div className="mb-4">
            <Alert tone="red">{formError}</Alert>
          </div>
        )}
        {gradeAware && produtoDoFormulario && (
          <p className="mb-3 rounded-md bg-navy-50 px-3 py-2 text-xs text-navy-700">
            {gradeDoFormulario ? (
              <>
                Grade do produto: <strong className="font-semibold">{gradeDoFormulario}</strong>. O campo Tamanho lista apenas estes tamanhos.
              </>
            ) : (
              <>Este produto ainda não tem grade definida — a lista mostra todos os tamanhos cadastrados.</>
            )}
          </p>
        )}
        <RecordForm
          resource={resource}
          values={values}
          errors={errors}
          onChange={onChange}
          onSubmit={submit}
          onClear={clearForm}
          editing={!!editing}
          busy={saving}
          refOptions={refOptionsForm}
          before={
            hasImages && editing ? (
              <div>
                <span className="label">Fotos</span>
                <ImageField key={editing.id} resource={resource} recordId={editing.id} initial={editing.fotos} canEdit={canUpdate} onChange={() => load()} />
              </div>
            ) : undefined
          }
        />
      </Modal>

      {zoom && <Lightbox file={zoom.file} files={zoom.files} onClose={() => setZoom(null)} onNav={(f) => setZoom({ ...zoom, file: f })} />}

      <ConfirmDialog
        open={!!toDelete}
        title={`Excluir ${resource.singular.toLowerCase()}?`}
        danger
        confirmLabel="Excluir"
        busy={deleting}
        onCancel={() => !deleting && setToDelete(null)}
        onConfirm={confirmDelete}
        message={
          <>
            <p>
              Você está prestes a excluir <strong>{toDelete ? rowLabel(resource, toDelete) : ''}</strong>. Esta ação não pode ser desfeita.
            </p>
            {resource.key === 'locais' && toDelete ? (
              <LocalExclusaoAviso local={toDelete} isAdmin={user?.perfil === 'admin'} />
            ) : (
              resource.fields.some((f) => f.name === 'ativo') && <p className="mt-2 text-slate-500">Dica: se o registro já foi usado em outro módulo, prefira desmarcar "Ativo" ao editá-lo.</p>
            )}
          </>
        }
      />

      <ConfirmDialog
        open={!!toEstornar}
        title="Estornar movimentação?"
        danger
        confirmLabel="Estornar"
        busy={estornando}
        onCancel={() => !estornando && setToEstornar(null)}
        onConfirm={confirmarEstorno}
        message={
          <>
            <p>
              Você está prestes a estornar a movimentação <strong>#{toEstornar?.id}</strong> ({toEstornar?.tipo} de {toEstornar?.quantidade} peça(s)).
            </p>
            <p className="mt-2 text-slate-600">
              Será criado automaticamente um <strong>lançamento inverso</strong> para reverter o efeito no estoque. A movimentação original será marcada como estornada e permanecerá no histórico para fins de auditoria.
            </p>
          </>
        }
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Aviso de exclusão de local de estoque — gestão livre, decisão do administrador
// ----------------------------------------------------------------------------
function LocalExclusaoAviso({ local, isAdmin }: { local: Record<string, any>; isAdmin: boolean }) {
  const uso = Number(local.uso_saldos) > 0 || Number(local.uso_movimentacoes) > 0 || Number(local.uso_inventarios) > 0;
  const ultimoAtivo = !!local.eh_ultimo_ativo;
  const exigeAdmin = uso || ultimoAtivo;
  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      {uso ? (
        <p>
          Este local <strong>está em uso</strong>: {local.uso_saldos} saldo(s) no Estoque Físico, {local.uso_movimentacoes} movimentação(ões) e {local.uso_inventarios} inventário(s).
        </p>
      ) : (
        <p>Nenhum saldo, movimentação ou inventário usa este local.</p>
      )}
      <p className="mt-1">
        A decisão é do administrador: o local sai do cadastro e <strong>o histórico não é apagado</strong> — saldos e movimentações continuam no sistema com o nome do local.
      </p>
      {ultimoAtivo && (
        <p className="mt-1 font-semibold">Atenção: este é o único local ativo. Depois de excluir, as movimentações usam "loja" como origem até você cadastrar (ou reativar) outro local.</p>
      )}
      {exigeAdmin && !isAdmin && <p className="mt-1 font-semibold">Somente um administrador pode excluir um local em uso (ou o último local ativo).</p>}
      {!uso && !ultimoAtivo && <p className="mt-2 text-slate-500">Dica: se o local ainda vai ser usado mais tarde, prefira desmarcar "Ativo" ao editá-lo.</p>}
    </div>
  );
}

function FiltroCampo({
  field,
  filtros,
  opcoes,
  onChange,
}: {
  field: Field;
  filtros: Record<string, string>;
  opcoes?: Option[];
  onChange: (chave: string, valor: string) => void;
}) {
  const id = `filtro-${field.name}`;
  if (field.type === 'date') {
    return (
      <label className="block" htmlFor={id}>
        <span className="label">{field.label}</span>
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="date" className="input" value={filtros[`${field.name}_de`] ?? ''} onChange={(e) => onChange(`${field.name}_de`, e.target.value)} aria-label={`${field.label} a partir de`} />
          até
          <input type="date" className="input" value={filtros[`${field.name}_ate`] ?? ''} onChange={(e) => onChange(`${field.name}_ate`, e.target.value)} aria-label={`${field.label} até`} />
        </div>
      </label>
    );
  }
  const valor = filtros[field.name] ?? '';
  return (
    <label className="block" htmlFor={id}>
      <span className="label">{field.label}</span>
      {field.type === 'boolean' ? (
        <select id={id} className="input" value={valor} onChange={(e) => onChange(field.name, e.target.value)}>
          <option value="">Qualquer</option>
          <option value="true">Sim</option>
          <option value="false">Não</option>
        </select>
      ) : (
        <select id={id} className="input" value={valor} onChange={(e) => onChange(field.name, e.target.value)}>
          <option value="">Todos</option>
          {field.type === 'select'
            ? field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
            : opcoes?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
        </select>
      )}
    </label>
  );
}

function rowLabel(r: ResourceMeta, row: Record<string, any>): string {
  const parts = r.labelFields.map((f) => row[f]).filter((v) => v !== null && v !== undefined && String(v) !== '');
  if (r.labelFields.length === 1 && r.labelFields[0] === 'id') return `#${row.id}`;
  return parts.length ? parts.join(' — ') : `#${row.id}`;
}

function Cell({ f, row }: { f: Field; row: Record<string, any> }) {
  const v = row[f.name];
  if (f.type === 'boolean') {
    return v ? <Badge tone="green">Sim</Badge> : <Badge tone="slate">Não</Badge>;
  }
  if (f.type === 'select' && f.options) {
    const opt = f.options.find((o) => o.value === String(v));
    if (opt?.tone) return <Badge tone={opt.tone}>{opt.label}</Badge>;
    return <>{opt?.label ?? (v ?? '—')}</>;
  }
  if (f.type === 'color') return <ColorDot hex={v} label={v} />;
  if (f.type === 'multiref') {
    const label = row[`${f.name}__label`];
    return <span className="text-slate-600">{label || (Array.isArray(v) ? `${v.length} item(ns)` : '—')}</span>;
  }
  const text = formatCell(f, row);
  if (f.type === 'ref' && text !== '—') {
    const hex = row[`${f.name}__color`];
    if (hex) return <span className="font-medium text-slate-800"><ColorDot hex={hex} label={text} /></span>;
    return <span className="font-medium text-slate-800">{text}</span>;
  }
  if (text === '—') return <span className="text-slate-300">—</span>;
  return <span className={f.type === 'text' && f.name === 'nome' ? 'font-medium text-slate-800' : ''}>{text}</span>;
}

// ----------------------------------------------------------------------------
// Cockpit da Produção — KPIs das OPs no topo da lista de Ordens de Fabricação
// ----------------------------------------------------------------------------
type PainelProducao = {
  planejadas: number;
  emProducao: number;
  atrasadas: number;
  pecasAbertas: number;
  concluidasMes: number;
  pecasMes: number;
  porSemana: { semana: string; label: string; pecas: number }[];
  alertas: { id: number; produto: string; previsao: string | null; quantidade: number; status: string }[];
};

function ProducaoCockpit() {
  const [painel, setPainel] = useState<PainelProducao | null>(null);

  useEffect(() => {
    api
      .get<PainelProducao>('/producao/painel')
      .then(setPainel)
      .catch(() => {});
  }, []);

  if (!painel) return null;
  const abertas = painel.planejadas + painel.emProducao;

  return (
    <div className="mb-4 space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card flex items-center gap-3 p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-navy-800 text-white">
            <Cog className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="text-xl font-bold tabular-nums text-navy-900">{abertas}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">OPs abertas</div>
            <div className="truncate text-xs text-slate-400">
              {painel.planejadas} planejada(s) · {painel.emProducao} em produção · {formatCellNumber(painel.pecasAbertas)} peças
            </div>
          </div>
        </div>
        <div className={`card flex items-center gap-3 p-4 ${painel.atrasadas > 0 ? 'border-red-200 bg-red-50/40' : ''}`}>
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white ${painel.atrasadas > 0 ? 'bg-red-600' : 'bg-slate-500'}`}>
            <AlertTriangleIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="text-xl font-bold tabular-nums text-navy-900">{painel.atrasadas}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Atrasadas</div>
            <div className="truncate text-xs text-slate-400">{painel.atrasadas > 0 ? 'Previsão de entrega vencida' : 'Nenhuma OP fora do prazo'}</div>
          </div>
        </div>
        <div className="card flex items-center gap-3 p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <CheckCircle2Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="text-xl font-bold tabular-nums text-navy-900">{painel.concluidasMes}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Concluídas no mês</div>
            <div className="truncate text-xs text-slate-400">{formatCellNumber(painel.pecasMes)} peças produzidas</div>
          </div>
        </div>
        <div className="card flex flex-col justify-between p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Atalhos</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Link to="/relatorios?relatorio=producao-periodo" className="btn-secondary !px-2.5 !py-1.5 text-xs">
              <BarChartIcon className="h-3.5 w-3.5" /> Produção por período
            </Link>
            <Link to="/fichas" className="btn-secondary !px-2.5 !py-1.5 text-xs">
              <FactoryIcon className="h-3.5 w-3.5" /> Fichas técnicas
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-navy-900">Peças produzidas — últimas 8 semanas</h3>
          {painel.porSemana.every((s) => s.pecas === 0) ? (
            <p className="py-6 text-center text-sm text-slate-400">Nenhuma OP concluída nas últimas semanas.</p>
          ) : (
            <BarrasVerticais rotulos={painel.porSemana.map((s) => s.label)} valores={painel.porSemana.map((s) => s.pecas)} formatar={formatCellNumber} titulo="Peças por semana" cor="#059669" />
          )}
        </div>
        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-2.5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <AlertTriangleIcon className="h-4 w-4 text-red-500" /> OPs atrasadas
            </h3>
          </div>
          {painel.alertas.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400">Nada atrasado. 🎉</p>
          ) : (
            <ul className="max-h-44 divide-y divide-slate-100 overflow-auto">
              {painel.alertas.map((a) => (
                <li key={a.id}>
                  <Link to={`/ordens/${a.id}`} className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-navy-50/50">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-navy-900">
                        OP #{a.id} — {a.produto}
                      </p>
                      <p className="text-xs text-red-500">Previsão: {a.previsao ? String(a.previsao).split('-').reverse().join('/') : '—'}</p>
                    </div>
                    <span className="shrink-0 text-xs font-bold tabular-nums text-slate-500">{formatCellNumber(a.quantidade)} pçs</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function formatCellNumber(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : '—';
}
