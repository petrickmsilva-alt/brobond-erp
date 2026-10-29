import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle as AlertTriangleIcon,
  BarChart3 as BarChartIcon,
  CheckCircle2 as CheckCircle2Icon,
  Cog,
  Download,
  Copy,
  Eye,
  Factory as FactoryIcon,
  FileUp,
  Inbox,
  KeyRound,
  ListFilter,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Ruler,
  Search,
  Share2,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useMeta, type Field, type ListResult, type Option, type PublicFile, type ResourceMeta } from '../lib/meta';
import { ImageField, Lightbox } from '../components/ImageField';
import { BarrasVerticais } from '../components/Charts';
import { DETALHE_DIRETO, FORM_DIRETO, findModuleByResource, type Module } from '../modules';
import { useAuth } from '../auth/AuthContext';
import { Alert, ConfirmacaoInline, EmptyState, PainelInline, PageHeader, Spinner, useToast } from '../components/ui';
import { DocumentPrintButton } from '../components/DocumentPrintButton';
import { Pagination } from '../components/ui-kit';
// Opções de referência usadas pelos FILTROS da listagem (não por formulário:
// o formulário de cadastro vive em página própria — ver RegistroPage).
import { useRefOptions } from '../components/RecordForm';
import { DependenciasModal, type DiagnosticoDependencias } from '../components/DependenciasModal';
import { rotaImportacaoDoRecurso } from '../lib/importacao';
import { useLocalStorageChoice, useLocalStorageInt, useLocalStorageSet } from '../lib/useLocalStorage';
import PlannedModule from './PlannedModule';
import CatalogoShareModal from '../components/CatalogoShareModal';
import CatalogoInsights from '../components/CatalogoInsights';
import PortalAccessModal from '../components/PortalAccessModal';
// Listagem (tabela/visual): apresentação isolada do CRUD genérico.
import { ListaTabela } from '../components/ListaTabela';
import { ListaCards } from '../components/ListaCards';
import { ColunasMenu, DensidadeMenu, ModoVisualizacaoControl } from '../components/ListaControles';
import { ChipsFiltros, FiltroRapido, PainelFiltros } from '../components/ListaFiltros';
import { rowLabel } from '../components/ListaValores';
import {
  CAMPO_AMOSTRA,
  CAMPO_ESTOQUE,
  CAMPO_ID,
  CAMPO_MEDIDAS,
  CAMPO_USO,
  campoDaAmostra,
  camposOrdenados,
  campoTitulo,
  camposDoCard,
  chipsDeFiltros,
  DENSIDADE_PADRAO,
  DENSIDADES,
  densidadeLegada,
  MODO_PADRAO,
  MODOS_VISUALIZACAO,
  contagemDe,
  permiteAlternarAtivo,
  mensagemDeVinculos,
  placeholderBusca,
  rotuloNovo,
  textoContagem,
  textoVazio,
  type ModoVisualizacao,
  usaColunaEstoque,
  usaColunaMedidas,
} from '../lib/lista';

// Páginas especializadas pesadas: carregadas sob demanda, só quando o módulo
// correspondente é aberto — evitam engordar o bundle de quem só usa cadastros simples.
const EstoqueGradePage = lazy(() => import('./EstoqueGradePage'));
const MedidasPage = lazy(() => import('./MedidasPage'));
const InventarioModulePage = lazy(() => import('./InventarioModulePage'));
// Contagem Cíclica ABC — capacidade própria sob Estoque & Suprimentos → Estoque.
const ContagemCiclicaPage = lazy(() => import('./ContagemCiclicaPage'));
const CustoPage = lazy(() => import('./CustoPage'));
const PlanejamentoProducaoPage = lazy(() => import('./PlanejamentoProducaoPage'));
const RelatoriosPage = lazy(() => import('./RelatoriosPage'));
const FinanceiroPage = lazy(() => import('./FinanceiroPage'));
const AjudaPage = lazy(() => import('./AjudaPage'));
const PdvPage = lazy(() => import('./PdvPage'));
const ExpedicaoPage = lazy(() => import('./ExpedicaoPage'));
const CotacoesCompraPage = lazy(() => import('./CotacoesCompraPage'));
const ImportarNfePage = lazy(() => import('./ImportarNfePage'));
const SugestaoCompraPage = lazy(() => import('./SugestaoCompraPage'));
const DevolucoesPage = lazy(() => import('./DevolucoesPage'));
const LogisticaPage = lazy(() => import('./LogisticaPage'));
const UsuariosPage = lazy(() => import('./UsuariosPage'));
const WebhooksPage = lazy(() => import('./WebhooksPage'));
const ConectorPage = lazy(() => import('./ConectorPage'));
const CreatorsModulePage = lazy(() => import('./creators/CreatorsModulePage'));
const CreatorsRecordsPage = lazy(() => import('./creators/CreatorsRecordsPage'));
const CommerceModulePage = lazy(() => import('./CommerceModulePage'));
const NcmPage = lazy(() => import('./NcmPage'));
const ComissoesPage = lazy(() => import('./ComissoesPage'));
const EmpresasPage = lazy(() => import('./EmpresasPage'));
const InutilizacoesPage = lazy(() => import('./InutilizacoesPage'));
const ColecoesPage = lazy(() => import('./ColecoesPage'));
const InsumosPage = lazy(() => import('./InsumosPage'));
const FornecedoresPage = lazy(() => import('./FornecedoresPage'));
const RepresentantesPage = lazy(() => import('./RepresentantesPage'));
// Fundação comercial (MASTER MA-02..MA-08): LISTA → PÁGINA em todas as telas.
const CadastroComercialPage = lazy(() => import('./CadastroComercialPage'));
const TerritoriosPage = lazy(() => import('./TerritoriosPage'));
const MetasPage = lazy(() => import('./MetasPage'));
const PainelComercialPage = lazy(() => import('./PainelComercialPage'));
// CRM 3.0 — painel comercial e agenda (páginas próprias, sem modal).
const CrmPainelPage = lazy(() => import('./CrmPainelPage'));
const CrmAgendaPage = lazy(() => import('./CrmAgendaPage'));
// Estoque 3.0 — transferência formal (documento + estados) e reservas.
const EstoqueTransferenciasPage = lazy(() => import('./EstoqueTransferenciasPage'));
// Compras 3.0 — homologação de fornecedor (processo, não cadastro paralelo).
const ComprasFornecedoresPage = lazy(() => import('./ComprasFornecedoresPage'));
// Produção 3.0 — capacidade/carga/gargalo e MRP (somente leitura).
const ProducaoCapacidadePage = lazy(() => import('./ProducaoCapacidadePage'));
// Fiscal 3.0 — calendário de obrigações acessórias (prazo e prova, sem imposto).
const FiscalCalendarioPage = lazy(() => import('./FiscalCalendarioPage'));
// Financeiro 3.0 — balancete/classificação contábil (leitura do mesmo livro).
const FinanceiroBalancetePage = lazy(() => import('./FinanceiroBalancetePage'));

const PAGE_SIZE = 25;
/** Tamanhos de página oferecidos na listagem (server-side). */
const TAMANHOS_PAGINA = [25, 50, 100];

function SubPageLoading() {
  return <Spinner label="Carregando módulo..." />;
}

export default function ModulePage({ module }: { module: Module }) {
  const meta = useMeta();
  const resource = module.resource ? meta.resources[module.resource] : undefined;

  if (module.connector) return <Suspense fallback={<SubPageLoading />}><ConectorPage module={module} /></Suspense>;
  if (module.space === 'creators') {
    const kind = module.id === 'creators' ? 'profile' : module.id === 'campanhas' ? 'campaign' : module.id === 'creator-matches' ? 'partnership' : null;
    return <Suspense fallback={<SubPageLoading />}>{kind ? <CreatorsRecordsPage kind={kind} /> : <CreatorsModulePage module={module} />}</Suspense>;
  }
  if (module.space === 'commerce') {
    return <Suspense fallback={<SubPageLoading />}><CommerceModulePage module={module} /></Suspense>;
  }
  if (module.id === 'usuarios') return <Suspense fallback={<SubPageLoading />}><UsuariosPage /></Suspense>;
  if (module.id === 'webhooks') return <Suspense fallback={<SubPageLoading />}><WebhooksPage /></Suspense>;
  if (module.id === 'estoque') return <Suspense fallback={<SubPageLoading />}><EstoqueGradePage /></Suspense>;
  if (module.id === 'medidas') return <Suspense fallback={<SubPageLoading />}><MedidasPage /></Suspense>;
  if (module.id === 'inventario') return <Suspense fallback={<SubPageLoading />}><InventarioModulePage /></Suspense>;
  if (module.id === 'contagem-ciclica-abc') return <Suspense fallback={<SubPageLoading />}><ContagemCiclicaPage /></Suspense>;
  if (module.id === 'custo') return <Suspense fallback={<SubPageLoading />}><CustoPage /></Suspense>;
  if (module.id === 'planejamento-producao') return <Suspense fallback={<SubPageLoading />}><PlanejamentoProducaoPage /></Suspense>;
  if (module.id === 'relatorios') return <Suspense fallback={<SubPageLoading />}><RelatoriosPage /></Suspense>;
  if (module.id === 'financeiro') return <Suspense fallback={<SubPageLoading />}><FinanceiroPage /></Suspense>;
  if (module.id === 'ajuda') return <Suspense fallback={<SubPageLoading />}><AjudaPage /></Suspense>;
  if (module.id === 'pdv') return <Suspense fallback={<SubPageLoading />}><PdvPage /></Suspense>;
  if (module.id === 'expedicao') return <Suspense fallback={<SubPageLoading />}><ExpedicaoPage /></Suspense>;
  if (module.id === 'cotacoes-compra') return <Suspense fallback={<SubPageLoading />}><CotacoesCompraPage /></Suspense>;
  if (module.id === 'importar-nfe-compra') return <Suspense fallback={<SubPageLoading />}><ImportarNfePage /></Suspense>;
  if (module.id === 'sugestao-compra') return <Suspense fallback={<SubPageLoading />}><SugestaoCompraPage /></Suspense>;
  if (module.id === 'devolucoes') return <Suspense fallback={<SubPageLoading />}><DevolucoesPage /></Suspense>;
  if (module.id === 'envios') return <Suspense fallback={<SubPageLoading />}><LogisticaPage /></Suspense>;
  if (module.id === 'ncm') return <Suspense fallback={<SubPageLoading />}><NcmPage /></Suspense>;
  if (module.id === 'comissoes') return <Suspense fallback={<SubPageLoading />}><ComissoesPage /></Suspense>;
  if (module.id === 'empresas') return <Suspense fallback={<SubPageLoading />}><EmpresasPage /></Suspense>;
  if (module.id === 'inutilizacoes') return <Suspense fallback={<SubPageLoading />}><InutilizacoesPage /></Suspense>;
  if (module.id === 'colecoes') return <Suspense fallback={<SubPageLoading />}><ColecoesPage /></Suspense>;
  if (module.id === 'insumos') return <Suspense fallback={<SubPageLoading />}><InsumosPage /></Suspense>;
  // Fornecedores: LISTA dedicada no padrão LISTA → PÁGINA (cadastro/edição em
  // /fornecedores/novo e /fornecedores/:id/editar — nunca no modal genérico).
  if (module.id === 'fornecedores') return <Suspense fallback={<SubPageLoading />}><FornecedoresPage /></Suspense>;
  // Representantes: LISTA dedicada no padrão LISTA → PÁGINA (cadastro/edição em
  // /representantes/novo e /representantes/:id/editar — nunca no modal
  // genérico).
  if (module.id === 'representantes') return <Suspense fallback={<SubPageLoading />}><RepresentantesPage /></Suspense>;
  // ESTRUTURA COMERCIAL (MASTER): territórios com árvore, metas com
  // acompanhamento derivado, painel de indicadores — todos em página própria.
  if (module.id === 'territorios') return <Suspense fallback={<SubPageLoading />}><TerritoriosPage /></Suspense>;
  if (module.id === 'metas') return <Suspense fallback={<SubPageLoading />}><MetasPage /></Suspense>;
  if (module.id === 'painel-comercial') return <Suspense fallback={<SubPageLoading />}><PainelComercialPage /></Suspense>;
  if (module.id === 'crm-painel') return <Suspense fallback={<SubPageLoading />}><CrmPainelPage /></Suspense>;
  if (module.id === 'crm-agenda') return <Suspense fallback={<SubPageLoading />}><CrmAgendaPage /></Suspense>;
  if (module.id === 'transferencias-estoque') return <Suspense fallback={<SubPageLoading />}><EstoqueTransferenciasPage /></Suspense>;
  if (module.id === 'homologacao-fornecedores') return <Suspense fallback={<SubPageLoading />}><ComprasFornecedoresPage /></Suspense>;
  if (module.id === 'producao-capacidade') return <Suspense fallback={<SubPageLoading />}><ProducaoCapacidadePage /></Suspense>;
  if (module.id === 'fiscal-calendario') return <Suspense fallback={<SubPageLoading />}><FiscalCalendarioPage /></Suspense>;
  if (module.id === 'balancete') return <Suspense fallback={<SubPageLoading />}><FinanceiroBalancetePage /></Suspense>;
  if (module.id === 'equipes_comerciais') return <Suspense fallback={<SubPageLoading />}><CadastroComercialPage recurso="equipes_comerciais" /></Suspense>;
  if (module.id === 'equipe_membros') return <Suspense fallback={<SubPageLoading />}><CadastroComercialPage recurso="equipe_membros" /></Suspense>;
  if (module.id === 'representante_hierarquia') return <Suspense fallback={<SubPageLoading />}><CadastroComercialPage recurso="representante_hierarquia" /></Suspense>;
  if (module.id === 'representante_cliente') return <Suspense fallback={<SubPageLoading />}><CadastroComercialPage recurso="representante_cliente" /></Suspense>;
  if (module.id === 'venda_atribuicao') return <Suspense fallback={<SubPageLoading />}><CadastroComercialPage recurso="venda_atribuicao" /></Suspense>;
  if (module.id === 'planos_comissao') return <Suspense fallback={<SubPageLoading />}><CadastroComercialPage recurso="planos_comissao" /></Suspense>;
  if (module.id === 'regras_comissao') return <Suspense fallback={<SubPageLoading />}><CadastroComercialPage recurso="regras_comissao" /></Suspense>;

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
  // Caminho-base do cadastro: é o caminho do MÓDULO (ex.: /categorias-insumos),
  // que não coincide com o nome do recurso quando ele tem sublinhado
  // (`categorias_insumos`). Rotas LISTA → PÁGINA são montadas a partir dele.
  const basePath = module.path;
  const defaultLocal = meta?.defaultLocal ?? null;
  const hasImages = !!resource.images;
  const [zoom, setZoom] = useState<{ file: PublicFile; files: PublicFile[] } | null>(null);
  const isOperador = user?.perfil === 'operador';
  const herdaComercial = user?.perfil === 'admin' || user?.perfil === 'gerente';
  const permite = (v: string | undefined) => user?.perfil === 'admin' || v === 'permitir' || (v !== 'negar' && herdaComercial);
  const podeGerirCatalogos = resource.key !== 'catalogos' || permite(user?.perm_catalogos);
  // SEC-04/P1-01: o catálogo compartilhado (categorias/cores/grades/tamanhos) é
  // global — a escrita exige gerente+ no servidor. Espelhamos aqui para o
  // operador não ver botões que receberiam 403 (a autorização real é a API).
  const perfilOkEscrita = !resource.minPerfilEscrita
    || user?.perfil === 'admin'
    || (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const canCreate = resource.ops.create && podeGerirCatalogos && perfilOkEscrita;
  const canUpdate = resource.ops.update && podeGerirCatalogos && perfilOkEscrita;
  const canDelete = resource.ops.delete && !isOperador && podeGerirCatalogos && perfilOkEscrita;
  const readOnly = !canCreate && !canUpdate && !canDelete;

  // Lista
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  // Tamanho da página: preferência do usuário, persistida no navegador.
  const [pageSize, setPageSize] = useLocalStorageInt('brobond_lista_page_size', PAGE_SIZE, TAMANHOS_PAGINA);
  const [clientePortal, setClientePortal] = useState<Record<string, any> | null>(null);
  const [catalogoCompartilhar, setCatalogoCompartilhar] = useState<Record<string, any> | null>(null);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);

  // Opções de referência para os filtros da lista (chips/painel).
  const refOptions = useRefOptions(resource);

  // ZERO MODAL: não existe estado de formulário nesta página. Criar/editar
  // navega para a PÁGINA do recurso (`/recurso/novo` e `/recurso/:id/editar`,
  // ver pages/RegistroPage.tsx). A lista nunca abre superfície sobreposta.
  // Fase 5 — exportação, importação e filtros avançados
  const importRota = rotaImportacaoDoRecurso(resource.key);
  const [showFiltros, setShowFiltros] = useState(false);
  const [filtros, setFiltros] = useState<Record<string, string>>({});

  // Exclusão
  const [toDelete, setToDelete] = useState<Record<string, any> | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Diagnóstico de vínculos devolvido pelo 409 (código 'dependencias_vinculadas').
  const [dependencias, setDependencias] = useState<DiagnosticoDependencias | null>(null);
  // Linha que originou o diagnóstico — permite oferecer a saída recomendada
  // (desativar) sem tentar excluir de novo nem apagar nada.
  const [diagAlvo, setDiagAlvo] = useState<Record<string, any> | null>(null);

  // Ativar/Desativar na linha (recursos marcados na configuração da listagem).
  const podeAlternarAtivo = permiteAlternarAtivo(resource.key) && canUpdate;
  const [alternandoAtivoId, setAlternandoAtivoId] = useState<number | null>(null);
  const alternandoAtivoRef = useRef<number | null>(null);

  // CRM 3.0 — conversão Lead → Oportunidade (mesma rota do backend,
  // POST /api/crm/leads/:id/converter). A tela NÃO decide nada: os valores
  // padrão, a idempotência, o escopo de empresa e a auditoria são do servidor.
  // Aqui só existe o caminho de navegação para o fluxo já implementado.
  const [convertendoLeadId, setConvertendoLeadId] = useState<number | null>(null);
  async function converterLeadEmOportunidade(row: Record<string, any>) {
    const id = Number(row.id);
    setConvertendoLeadId(id);
    try {
      const r = await api.post<{ oportunidade_id: number; idempotente: boolean }>(`/crm/leads/${id}/converter`, {});
      toast.success(
        r.idempotente
          ? `Este lead já estava convertido — oportunidade #${r.oportunidade_id}.`
          : `Lead convertido na oportunidade #${r.oportunidade_id}.`
      );
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível converter o lead.');
    } finally {
      setConvertendoLeadId(null);
    }
  }

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

  // O fluxo de convite/senha temporária vive em UsuariosPage (página própria do
  // módulo `usuarios`); esta listagem genérica nunca o renderiza — por isso não
  // há estado nem ação de usuário aqui.

  // Campos virtuais só entram na tabela se pedirem explicitamente (list: true),
  // ex.: "Senha" em usuários, que mostra o estado e não o valor.
  //
  // Produtos ganham a coluna sintética "Estoque" logo após o preço — ela lê o
  // saldo somente quando o payload já o traz (ver lib/lista.ts) e nunca dispara
  // uma consulta por linha.
  const allListFields = useMemo(() => {
    const base = resource.fields.filter(
      (f) => f.list !== false && (!f.virtual || f.list === true) && f.type !== 'password' && f.type !== 'images'
    );
    // Utilização: contagem real anotada pelo servidor (declarada em `uso`).
    const comUso = resource.uso && !base.some((f) => f.name === CAMPO_USO.name) ? [...base, CAMPO_USO] : base;
    // Grades: estado REAL da tabela de medidas (sem tabela / parcial / completa),
    // anotado pelo servidor no mesmo payload da listagem — nenhuma consulta por
    // linha e nenhuma regra de completude duplicada no front.
    const comMedidas =
      usaColunaMedidas(resource.key) && !comUso.some((f) => f.name === CAMPO_MEDIDAS.name)
        ? [...comUso, CAMPO_MEDIDAS]
        : comUso;
    if (usaColunaEstoque(resource.key)) {
      return comMedidas.some((f) => f.name === CAMPO_ESTOQUE.name) ? comMedidas : [...comMedidas, CAMPO_ESTOQUE];
    }
    // Amostra: a cor ganha presença visual na primeira coluna (e a tabela
    // dispensa a coluna `#`, que não ajuda a ler uma cartela de cores).
    if (campoDaAmostra(resource.key)) {
      return comMedidas.some((f) => f.name === CAMPO_AMOSTRA.name) ? comMedidas : [CAMPO_AMOSTRA, ...comMedidas];
    }
    // Recursos genéricos mantêm a coluna `#` (id) à esquerda, como antes.
    return comMedidas.some((f) => f.name === 'id') ? comMedidas : [CAMPO_ID, ...comMedidas];
  }, [resource]);
  const searchable = resource.fields.some((f) => f.search);
  // Filtros rápidos (Todas/Ativas/Inativas): mesmo contrato `f.<campo>` dos
  // demais filtros, aplicados no servidor. Quando um campo já tem filtro rápido,
  // ele não se repete no painel de filtros avançados.
  const filtrosRapidos = useMemo(() => resource.quickFilters ?? [], [resource]);
  const chavesRapidas = useMemo(() => new Set(filtrosRapidos.map((q) => q.field)), [filtrosRapidos]);
  // Filtros da listagem: quando o recurso declara `filterFields` (ex.: Produtos),
  // a ordem e a escolha são as do domínio — inclusive faixa numérica (preço).
  // Sem declaração, mantém o comportamento anterior (primeiros campos filtráveis).
  const filtroFields = useMemo(() => {
    if (resource.filterFields?.length) {
      const porNome = new Map(resource.fields.map((f) => [f.name, f]));
      return resource.filterFields.map((n) => porNome.get(n)).filter((f): f is Field => !!f);
    }
    return resource.fields
      .filter((f) => f.form !== false && !f.readonly && (f.type === 'select' || f.type === 'ref' || f.type === 'boolean' || f.type === 'date'))
      .slice(0, 8);
  }, [resource]);

  // Colunas visíveis, densidade e modo de visualização: preferências persistidas
  // no navegador. A densidade antiga ("tabela compacta", booleana) migra para
  // os três níveis atuais na primeira visita.
  const [colunasOcultas, setColunasOcultas] = useLocalStorageSet(`brobond_colunas_ocultas_${resource.key}`);
  const [densidade, setDensidade] = useLocalStorageChoice('brobond_lista_densidade', DENSIDADE_PADRAO, DENSIDADES, densidadeLegada);
  const [modoVisualizacao, setModoVisualizacao] = useLocalStorageChoice<ModoVisualizacao>('brobond_lista_modo', MODO_PADRAO, MODOS_VISUALIZACAO);
  const listFields = useMemo(
    () => camposOrdenados(allListFields.filter((f) => !colunasOcultas.has(f.name)), resource.key),
    [allListFields, colunasOcultas, resource.key]
  );

  // A busca é do servidor: espera o operador parar de digitar e volta à 1ª
  // página (o recorte mudou). A guarda evita que o disparo inicial — q vazio,
  // já igual ao debouncedQ — reinicie a página por cima de uma troca de página.
  useEffect(() => {
    const termo = q.trim();
    const t = window.setTimeout(() => {
      setDebouncedQ((atual) => {
        if (atual !== termo) setPage(1);
        return termo;
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  // Filtros ativos como chips removíveis (fonte do contador e da remoção
  // individual). Faixas de data/preço aparecem como um único chip — por isso o
  // contador é o número de CHIPS, não de chaves na query.
  const chipsFiltros = useMemo(
    () => chipsDeFiltros(filtroFields, filtros, refOptions, filtrosRapidos),
    [filtroFields, filtros, refOptions, filtrosRapidos]
  );
  /** Campos que ainda dependem do painel avançado (sem filtro rápido). */
  const filtroFieldsPainel = useMemo(() => filtroFields.filter((f) => !chavesRapidas.has(f.name)), [filtroFields, chavesRapidas]);
  const filtrosAtivos = chipsFiltros.length;
  /** Campos exibidos no modo visual (mesmos dados, outra apresentação). */
  const camposCard = useMemo(() => camposDoCard(listFields, resource.key), [listFields, resource.key]);
  /** Existe algum recorte (busca ou filtro) aplicado? Muda o texto do vazio. */
  const recorteAtivo = debouncedQ !== '' || filtrosAtivos > 0;

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
      const d = await api.get<ListResult>(`/${resource.key}?page=${page}&pageSize=${pageSize}${paramsAtuais ? `&${paramsAtuais}` : ''}`);
      setData(d);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / pageSize)));
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [resource.key, page, pageSize, paramsAtuais]);

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

  // --- navegação do cadastro (LISTA → PÁGINA) ---
  /**
   * Criar SEMPRE navega para a página do recurso. Não há caminho alternativo
   * em modal/drawer: a lista é somente leitura e navegação.
   */
  function openCreate() {
    // O caminho-base vem do MÓDULO (`/categorias-insumos`), nunca do nome do
    // recurso — os dois divergem nos recursos com sublinhado.
    navigate(`${basePath}/novo`);
  }

  /**
   * Editar: módulos com página de detalhe própria continuam indo para o
   * detalhe (OP, ficha técnica, pedidos); os demais abrem a página de edição
   * do recurso.
   */
  function openEdit(row: Record<string, any>) {
    // Módulos cujo ciclo de vida É a página de detalhe (OP, ficha técnica) e
    // pedidos com página dedicada (compras) editam lá — a página de detalhe é
    // quem manda no documento.
    if (DETALHE_DIRETO.has(module.id)) {
      navigate(`/${resource.key}/${row.id}`);
      return;
    }
    // Cadastros com formulário próprio (clientes, produtos, vendas, cores...)
    // e todos os recursos do CRUD genérico editam na PÁGINA de edição.
    if (FORM_DIRETO.has(resource.key) || !resource.detail) {
      navigate(`${basePath}/${row.id}/editar`);
      return;
    }
    navigate(`/${resource.key}/${row.id}`);
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
      // Exclusão bloqueada por vínculos: o servidor manda o diagnóstico
      // completo (módulos, quantidades, ids e o motivo). Em vez do toast
      // genérico, abrimos o "Ver vínculos" — nada foi apagado.
      const diag = e instanceof ApiError && e.details?.dependencias ? (e.details.dependencias as DiagnosticoDependencias) : null;
      if (diag) {
        setDiagAlvo(toDelete);
        setToDelete(null);
        setDependencias(diag);
      } else {
        toast.error(e.message || 'Não foi possível excluir.');
      }
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Ativar/Desativar sem abrir o formulário: um PUT no contrato existente do
   * recurso, com apenas o campo `ativo`. Nada de exclusão — categoria em uso se
   * desativa (o servidor recusa a exclusão de registros referenciados).
   */
  async function alternarAtivo(row: Record<string, any>) {
    const id = Number(row.id);
    // A trava é um ref: dois cliques no mesmo tick não passariam pela checagem
    // de estado (que só atualiza no próximo render).
    if (alternandoAtivoRef.current !== null) return;
    const novo = row.ativo === false;
    alternandoAtivoRef.current = id;
    setAlternandoAtivoId(id);
    try {
      await api.put(`/${resource.key}/${id}`, { ativo: novo });
      const nome = String(row[campoTitulo(resource.key)] ?? resource.singular);
      toast.success(`“${nome}”: status alterado para ${novo ? 'Ativo' : 'Inativo'}.`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Não foi possível alterar o status.');
    } finally {
      alternandoAtivoRef.current = null;
      setAlternandoAtivoId(null);
    }
  }

  /** Trocar o tamanho da página volta para a primeira — o recorte mudou. */
  function mudarTamanhoPagina(n: number) {
    setPageSize(n);
    setPage(1);
  }

  function toggleSort(f: Field) {
    if (f.virtual) return;
    setSort((s) => (s?.field === f.name ? (s.dir === 'asc' ? { field: f.name, dir: 'desc' } : null) : { field: f.name, dir: 'asc' }));
    setPage(1);
  }

  /** Limpa TODOS os filtros e volta à primeira página da listagem normal. */
  function limparFiltros() {
    setFiltros({});
    setPage(1);
  }

  /** Remove um chip (uma faixa inteira, quando for o caso). */
  function removerFiltro(chaves: string[]) {
    setFiltros((prev) => {
      const next = { ...prev };
      for (const chave of chaves) delete next[chave];
      return next;
    });
    setPage(1);
  }

  /**
   * Abre a galeria existente (Lightbox) com todas as fotos da linha — sem sair
   * da listagem e sem buscar nada novo: as fotos já vieram no payload.
   */
  function abrirFoto(row: Record<string, any>) {
    const fotos: PublicFile[] = Array.isArray(row.fotos) ? row.fotos : [];
    if (fotos.length) {
      setZoom({ file: fotos[0], files: fotos });
      return;
    }
    // Fallback: a linha tem miniatura mas não veio a galeria completa — abre a
    // própria miniatura ampliada, sem buscar nada no servidor.
    if (!row.foto_url) return;
    const unica: PublicFile = {
      id: -Number(row.id),
      nome: null,
      mime: null,
      tamanho_bytes: null,
      url: String(row.foto_url),
      thumb_url: String(row.foto_url),
      principal: true,
      ordem: 0,
      criado_em: '',
    };
    setZoom({ file: unica, files: [unica] });
  }

  /** Clique/duplo clique na linha: detalhe quando existe, senão edição. */
  function abrirLinha(row: Record<string, any>) {
    if (resource.detail || DETALHE_DIRETO.has(module.id)) {
      navigate(`/${resource.key}/${row.id}`);
      return;
    }
    if (canUpdate) openEdit(row);
  }

  /** Linhas estornadas continuam visíveis, porém riscadas (histórico/auditoria). */
  function linhaClasse(row: Record<string, any>) {
    return resource.key === 'movimentacoes' && row.estornado ? 'opacity-50 line-through' : '';
  }

  // Grades: o atalho "Tabela de medidas" é só navegação para o módulo existente
  // (leitura), então a coluna de ações continua existindo para perfis sem escrita.
  const temAcoesLinha =
    canUpdate || canDelete || !!resource.detail || podeAlternarAtivo || usaColunaMedidas(resource.key);
  /** A linha só é "clicável" quando existe um destino (detalhe ou edição). */
  const podeAbrirLinha = !!resource.detail || DETALHE_DIRETO.has(module.id) || canUpdate;

  /**
   * Ações da linha — a MESMA lista na tabela e nos cartões (nada de regra
   * duplicada por modo de visualização).
   */
  function renderAcoesLinha(row: Record<string, any>) {
    return (
      <>
        {resource.key === 'clientes' && canUpdate && (
          <button className="btn-icon !bg-navy-50 !text-navy-700" onClick={() => setClientePortal(row)} title="Portal do cliente" aria-label="Portal do cliente">
            <KeyRound className="h-4 w-4" />
          </button>
        )}
        {resource.key === 'catalogos' && permite(user?.perm_compartilhar) && (
          <button className="btn-icon !bg-brand-50 !text-brand-700 hover:!bg-brand-100" onClick={() => setCatalogoCompartilhar(row)} title="Compartilhar catálogo" aria-label="Compartilhar catálogo">
            <Share2 className="h-4 w-4" />
          </button>
        )}
        {resource.key === 'crm_leads' &&
          canUpdate &&
          !row.lead_convertido_em &&
          !['ganho', 'perdido'].includes(String(row.status)) && (
            <button
              className="btn-icon hover:!bg-emerald-50 hover:!text-emerald-700"
              onClick={() => void converterLeadEmOportunidade(row)}
              disabled={convertendoLeadId === Number(row.id)}
              title="Converter em oportunidade"
              aria-label={`Converter ${rowLabel(resource, row)} em oportunidade`}
            >
              {convertendoLeadId === Number(row.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />}
            </button>
          )}
        {resource.key === 'propostas' && (
          <DocumentPrintButton tipo="propostas" documentoId={Number(row.id)} label="Imprimir" compact />
        )}
        {resource.key === 'grades' && (
          // Integração com o módulo de medidas já existente: a grade abre a
          // tabela dela (o módulo recebe `?grade=` e seleciona sozinho). Nada é
          // recriado aqui — é só o caminho até o fluxo atual.
          <button
            className="btn-icon"
            onClick={() => navigate(`/medidas?grade=${Number(row.id)}`)}
            title="Tabela de medidas"
            aria-label={`Tabela de medidas de ${rowLabel(resource, row)}`}
          >
            <Ruler className="h-4 w-4" />
          </button>
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
        {podeAlternarAtivo && (
          <button
            className="btn-icon"
            onClick={() => void alternarAtivo(row)}
            disabled={alternandoAtivoId === Number(row.id)}
            title={row.ativo === false ? 'Ativar' : 'Desativar'}
            aria-label={row.ativo === false ? 'Ativar' : 'Desativar'}
          >
            {alternandoAtivoId === Number(row.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
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
      </>
    );
  }

  const total = data?.total ?? 0;
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
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
            <button className="btn-secondary" onClick={() => exportarLista('csv')} disabled={loading} title="Exportar a lista atual em CSV (Excel)">
              <Download className="h-4 w-4" />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button className="btn-secondary" onClick={() => exportarLista('xlsx')} disabled={loading} title="Exportar a lista atual em XLSX">
              <Download className="h-4 w-4 text-emerald-600" />
              <span className="hidden md:inline">XLSX</span>
            </button>
            {importRota && !isOperador && (
              <button className="btn-secondary" onClick={() => navigate(importRota)} title="Importar de CSV/XLSX">
                <FileUp className="h-4 w-4" />
                <span className="hidden sm:inline">Importar</span>
              </button>
            )}
            {canCreate && (
              <button className="btn-accent" onClick={openCreate}>
                <Plus className="h-4 w-4" /> {rotuloNovo(resource.key, resource.singular)}
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
      {/* SEC-04: catálogo compartilhado tem piso de escrita (gerente+). O
          operador continua LENDO — e entende por que os botões não aparecem.
          A autorização real continua no servidor (checkAccess). */}
      {readOnly && resource.minPerfilEscrita && !resource.notice && (
        <div className="mb-4">
          <Alert tone="slate">
            {resource.minPerfilEscrita === 'admin'
              ? 'Apenas administradores podem incluir, alterar ou excluir este cadastro compartilhado. Você pode consultar a lista normalmente.'
              : 'Apenas gerentes e administradores podem incluir, alterar ou excluir este cadastro compartilhado. Você pode consultar a lista normalmente.'}
          </Alert>
        </div>
      )}

      {/* ------------------------------------------------------------------
          BUSCA + FILTROS — área própria, ACIMA da tabela.
          O painel abre em linha (empurra a lista): nunca sobrepõe a tabela,
          nunca esconde a coluna de foto. Os filtros ativos viram chips com
          remoção individual e contador.
         ------------------------------------------------------------------ */}
      <div className="card mb-4">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          {searchable && (
            <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="input pl-9 pr-8"
                placeholder={placeholderBusca(resource.key, module.label)}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label={placeholderBusca(resource.key, module.label)}
              />
              {q && (
                <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setQ('')} aria-label="Limpar busca">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          {/* Recorte de um clique (Todas / Ativas / Inativas): servidor-side,
              pelo mesmo contrato `f.<campo>` do painel de filtros. */}
          {filtrosRapidos.map((grupo) => (
            <FiltroRapido
              key={grupo.field}
              label={grupo.label}
              opcoes={grupo.options}
              valor={filtros[grupo.field] ?? ''}
              onChange={(valor) => {
                setFiltros((prev) => {
                  const next = { ...prev };
                  if (valor === '') delete next[grupo.field];
                  else next[grupo.field] = valor;
                  return next;
                });
                setPage(1);
              }}
            />
          ))}
          {filtroFieldsPainel.length > 0 && (
            <button
              type="button"
              className={`btn-secondary ${filtrosAtivos || showFiltros ? '!border-brand-400 !text-brand-700' : ''}`}
              onClick={() => setShowFiltros((v) => !v)}
              title={showFiltros ? 'Fechar filtros' : 'Abrir filtros'}
              aria-expanded={showFiltros}
              aria-controls={showFiltros ? 'painel-filtros-listagem' : undefined}
              aria-label={filtrosAtivos > 0 ? `Filtros (${filtrosAtivos} ativo${filtrosAtivos === 1 ? '' : 's'})` : 'Filtros'}
            >
              <ListFilter className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Filtros</span>
              {filtrosAtivos > 0 && <span className="badge ml-1 !bg-brand-500 !text-white">{filtrosAtivos}</span>}
            </button>
          )}
          {filtrosAtivos > 0 && (
            <button type="button" className="btn-ghost text-xs" onClick={limparFiltros} title="Remover todos os filtros">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Limpar filtros
            </button>
          )}
          <div className="ml-auto text-xs text-slate-500" aria-live="polite">
            {loading && !data ? 'Carregando...' : textoContagem(resource.key, from, to, total)}
          </div>
        </div>

        <ChipsFiltros chips={chipsFiltros} onRemover={removerFiltro} />

        {showFiltros && filtroFieldsPainel.length > 0 && (
          <PainelFiltros
            id="painel-filtros-listagem"
            fields={filtroFieldsPainel}
            filtros={filtros}
            opcoes={refOptions}
            onChange={(chave, valor) => setFiltros((prev) => ({ ...prev, [chave]: valor }))}
            onAtualizar={load}
            onFechar={() => setShowFiltros(false)}
            atualizando={loading}
            ativos={filtrosAtivos}
          />
        )}
      </div>

      <div className="card overflow-hidden">
        {/* Barra da listagem: modo de visualização + colunas + densidade */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2.5">
          <span className="text-xs text-slate-400" aria-live="polite">
            {loading && data ? 'Atualizando...' : ''}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ModoVisualizacaoControl valor={modoVisualizacao} onChange={setModoVisualizacao} />
            {modoVisualizacao === 'tabela' && (
              <>
                <DensidadeMenu valor={densidade} onChange={setDensidade} />
                {allListFields.length > 3 && (
                  <ColunasMenu
                    campos={allListFields}
                    recurso={resource.key}
                    ocultas={colunasOcultas}
                    onToggle={(nome) => setColunasOcultas(nome)}
                    comFoto={hasImages}
                  />
                )}
              </>
            )}
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
            title={recorteAtivo ? 'Nada encontrado' : textoVazio(resource.key, resource.singular).titulo}
            description={
              recorteAtivo
                ? `Nenhum resultado para o recorte atual${debouncedQ ? ` (busca: "${debouncedQ}")` : ''}${filtrosAtivos ? ` (${filtrosAtivos} filtro${filtrosAtivos === 1 ? '' : 's'})` : ''}.`
                : canCreate
                  ? textoVazio(resource.key, resource.singular).descricao
                  : undefined
            }
            action={
              recorteAtivo ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {debouncedQ && (
                    <button className="btn-secondary" onClick={() => setQ('')}>
                      Limpar busca
                    </button>
                  )}
                  {filtrosAtivos > 0 && (
                    <button className="btn-secondary" onClick={limparFiltros}>
                      Limpar filtros
                    </button>
                  )}
                </div>
              ) : canCreate ? (
                <button className="btn-accent" onClick={openCreate}>
                  <Plus className="h-4 w-4" /> {rotuloNovo(resource.key, resource.singular)}
                </button>
              ) : undefined
            }
          />
        )}

        {!error && data && data.rows.length > 0 && (
          <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {modoVisualizacao === 'tabela' ? (
              <ListaTabela
                rows={data.rows}
                fields={listFields}
                recurso={resource.key}
                densidade={densidade}
                sort={sort}
                onSort={toggleSort}
                comFoto={hasImages}
                onAbrirFoto={abrirFoto}
                rotuloLinha={(row) => rowLabel(resource, row)}
                renderAcoes={temAcoesLinha ? renderAcoesLinha : undefined}
                onAbrirLinha={podeAbrirLinha ? abrirLinha : undefined}
                linhaClasse={linhaClasse}
                caption={`${module.label} — página ${page} de ${Math.max(1, Math.ceil(total / pageSize))}`}
              />
            ) : (
              <ListaCards
                rows={data.rows}
                fields={camposCard}
                recurso={resource.key}
                campoTitulo={campoTitulo(resource.key)}
                rotuloLinha={(row) => rowLabel(resource, row)}
                onAbrirFoto={abrirFoto}
                onAbrirLinha={podeAbrirLinha ? abrirLinha : undefined}
                renderAcoes={temAcoesLinha ? renderAcoesLinha : undefined}
                linhaClasse={linhaClasse}
              />
            )}
          </div>
        )}

        {/* Paginação server-side: o servidor devolve só a página pedida. */}
        {data && total > 0 && (
          <div className="border-t border-slate-200 px-4 py-3">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              pageSizeOptions={TAMANHOS_PAGINA}
              onPageSizeChange={mudarTamanhoPagina}
              label={`Paginação de ${module.label}`}
              contagem={contagemDe(resource.key)}
            />
          </div>
        )}
      </div>

      {/* Celular: botão flutuante (FAB) para incluir */}
      {canCreate && (
        <button
          className="btn-accent fixed bottom-5 right-5 z-40 rounded-full px-4 py-3.5 shadow-modal md:hidden"
          onClick={openCreate}
          aria-label={rotuloNovo(resource.key, resource.singular)}
        >
          <Plus className="h-5 w-5" />
          <span className="sr-only">{rotuloNovo(resource.key, resource.singular)}</span>
        </button>
      )}

      <PortalAccessModal cliente={clientePortal} onClose={() => setClientePortal(null)} />
      <CatalogoShareModal catalogo={catalogoCompartilhar} onClose={() => setCatalogoCompartilhar(null)} />


      {zoom && <Lightbox file={zoom.file} files={zoom.files} onClose={() => setZoom(null)} onNav={(f) => setZoom({ ...zoom, file: f })} />}

      <DependenciasModal
        diag={dependencias}
        onClose={() => {
          setDependencias(null);
          setDiagAlvo(null);
        }}
        mensagem={mensagemDeVinculos(resource.key)}
        // Regra do ERP: cadastro com histórico NÃO é apagado — desativa-se. O
        // diagnóstico continua somente leitura; a ação é o fluxo normal (PUT).
        // Só faz sentido quando o domínio TEM o campo `ativo` (Cores, Coleções,
        // Categorias...): em Tamanhos e Grades, que não o possuem, oferecer
        // "Desativar" dispararia um PUT inválido — por isso não aparece.
        acaoRecomendada={
          diagAlvo && resource.fields.some((f) => f.name === 'ativo') && diagAlvo.ativo !== false && canUpdate
            ? {
                rotulo: `Desativar ${resource.singular.toLowerCase()}`,
                descricao: 'Mantém o histórico e tira o cadastro das listas de seleção.',
                onClick: () => {
                  const alvo = diagAlvo;
                  setDependencias(null);
                  setDiagAlvo(null);
                  if (alvo) void alternarAtivo(alvo);
                },
              }
            : undefined
        }
        onAbrirModulo={(recurso) => {
          const destino = findModuleByResource(recurso);
          if (!destino) return;
          setDependencias(null);
          navigate(destino.path);
        }}
      />

      <ConfirmacaoInline
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

      <ConfirmacaoInline
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
