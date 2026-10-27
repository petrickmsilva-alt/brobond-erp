// ============================================================================
// CADASTRO DE INSUMOS — LISTA (tela principal) no padrão do BROBOND ERP.
//
// O cadastro/edição NÃO é uma superfície sobreposta: vive em PÁGINA PRÓPRIA
// (`/insumos/novo`, `/insumos/:id/editar` — ver InsumoFormPage), exatamente
// como Cores, Coleções e Grades. Aqui só existe a LISTA; "Novo insumo" e
// "Editar" NAVEGAM, nunca abrem modal/drawer/overlay.
//
// NÃO inventa campos nem endpoints: usa o contrato existente do recurso
// `insumos` (nome, unidade, custo_medio, fornecedor_id, ativo) em
// GET/POST/PUT/DELETE /api/insumos. O servidor revalida tudo
// (validatePayload + checkAccess); a UI só reflete.
//
// COLUNAS — todas com dado REAL no backend:
//   • Insumo     → `insumos.nome`
//   • Unidade    → `insumos.unidade` (dicionário UNIDADES)
//   • Fornecedor → `insumos.fornecedor_id` (rótulo do servidor: `__label`)
//   • Custo médio→ `insumos.custo_medio`
//   • Estoque    → `estoque_sumos`… não: `estoque_insumos.quantidade`, agregada
//                  NO SERVIDOR em UMA consulta por página (`sumByColumn`) —
//                  nunca um N+1, nunca um número inventado.
//   • Status     → `insumos.ativo`
//   • Utilização → fichas técnicas que consomem o insumo
//                  (`itens_ficha_tecnica.insumo_id`, contagem agregada no
//                  servidor — a mesma contagem do diagnóstico de vínculos).
//
// ESTOQUE MÍNIMO / MÁXIMO: NÃO existem em `insumos`. A tabela tem apenas
// nome, unidade, custo_medio, fornecedor_id, ativo, criado_em e atualizado_em.
// O estoque mínimo vive na tabela `estoque_insumos` (sem máximo) e continua
// editável no módulo "Estoque de Insumos" — nada foi inventado aqui.
//
// Exclusão: se o insumo estiver em uso, o DELETE responde 409 com o
// diagnóstico de dependências e a tela abre o "Ver vínculos" (o mesmo mecanismo
// dos demais módulos). A saída é DESATIVAR: histórico (compras, movimentações,
// fichas, produção) permanece.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Field, type ListResult, type Option } from '../lib/meta';
import { Alert, ConfirmDialog, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { Dropdown, Pagination } from '../components/ui-kit';
import { ListaTabela } from '../components/ListaTabela';
import { ListaCards } from '../components/ListaCards';
import { ColunasMenu, DensidadeMenu, ModoVisualizacaoControl } from '../components/ListaControles';
import { FiltroRapido } from '../components/ListaFiltros';
import { DependenciasModal, type DiagnosticoDependencias } from '../components/DependenciasModal';
import { useAuth } from '../auth/AuthContext';
import { useLocalStorageChoice, useLocalStorageInt, useLocalStorageSet } from '../lib/useLocalStorage';
import {
  camposOrdenados,
  camposDoCard,
  campoTitulo,
  contagemDe,
  DENSIDADES,
  DENSIDADE_PADRAO,
  densidadeLegada,
  MODO_PADRAO,
  MODOS_VISUALIZACAO,
  placeholderBusca,
  rotuloNovo,
  textoVazio,
  type Densidade,
  type ModoVisualizacao,
} from '../lib/lista';

type Insumo = {
  id: number;
  codigo_insumo?: string | null;
  nome: string | null;
  categoria_id?: number | null;
  categoria_id__label?: string | null;
  unidade: string | null;
  custo_medio: number | null;
  fornecedor_id: number | null;
  fornecedor_id__label?: string | null;
  ativo?: boolean;
  /** Saldo real de `estoque_insumos` (agregado no servidor); null = sem saldo. */
  estoque_saldo?: number | null;
  /** Mínimo cadastrado em `estoque_insumos` (agregado no servidor). */
  estoque_min?: number | null;
  /** Situação derivada: sem_registro | sem_estoque | abaixo_minimo | normal. */
  estoque_status?: string | null;
  /** Contagem real de fichas técnicas que consomem o insumo. */
  uso_vinculado?: number;
  uso_vinculado_label?: string;
};

const PAGE_SIZE = 25;
const TAMANHOS_PAGINA = [25, 50, 100];

/**
 * Colunas da listagem.
 *
 * `estoque_saldo`, `estoque_min`, `estoque_status` e `uso_vinculado` são campos
 * VIRTUAIS: não existem como coluna em `insumos` — o servidor os anota na
 * listagem (agregados, uma consulta por página). Nenhum outro dado é
 * apresentado.
 */
const COLUNAS: Field[] = [
  { name: 'codigo_insumo', label: 'Código', type: 'text', list: true },
  { name: 'nome', label: 'Insumo', type: 'text', list: true },
  { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias_insumos', list: true },
  { name: 'unidade', label: 'Unidade', type: 'select', list: true },
  { name: 'fornecedor_id', label: 'Fornecedor', type: 'ref', ref: 'fornecedores', list: true },
  { name: 'estoque_saldo', label: 'Estoque', type: 'number', virtual: true, list: true, hint: 'Saldo real de estoque_insumos, agregado no servidor.' },
  { name: 'custo_medio', label: 'Custo médio', type: 'money', list: true },
  { name: 'ativo', label: 'Status', type: 'boolean', list: true },
  { name: 'uso_vinculado', label: 'Utilização', type: 'integer', virtual: true, list: true, hint: 'Fichas técnicas que consomem este insumo.' },
];

/** Texto de identificação da linha (o nome do insumo). */
function rotuloDaLinha(row: Record<string, any>): string {
  return String(row.nome ?? '').trim() || `#${row.id}`;
}

export default function InsumosPage() {
  const toast = useToast();
  const meta = useMeta();
  const navigate = useNavigate();
  const { user } = useAuth();
  const resource = meta.resources['insumos'];

  // RBAC: espelha o servidor (checkAccess). A autoridade real é a API — aqui só
  // evitamos exibir um botão que receberia 403. Insumos é cadastro POR
  // EMPRESA: não há `minPerfilEscrita` (isso é do catálogo GLOBAL).
  const isOperador = user?.perfil === 'operador';
  const perfilOkEscrita =
    !resource?.minPerfilEscrita ||
    user?.perfil === 'admin' ||
    (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const canCreate = !!resource?.ops.create && perfilOkEscrita;
  const canUpdate = !!resource?.ops.update && perfilOkEscrita;
  const canDelete = !!resource?.ops.delete && !isOperador && perfilOkEscrita;

  const [carregando, setCarregando] = useState(true);
  const [linhas, setLinhas] = useState<Insumo[]>([]);
  const [total, setTotal] = useState(0);
  const [erro, setErro] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useLocalStorageInt('brobond_lista_page_size', PAGE_SIZE, TAMANHOS_PAGINA);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [status, setStatus] = useState('');
  const [unidade, setUnidade] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [categoria, setCategoria] = useState('');

  // Preferências de apresentação (persistidas no navegador), como no resto
  // do ERP: modo de visualização, densidade e colunas visíveis.
  const [colunasOcultas, setColunasOcultas] = useLocalStorageSet('brobond_colunas_ocultas_insumos');
  const [densidade, setDensidade] = useLocalStorageChoice<Densidade>('brobond_lista_densidade', DENSIDADE_PADRAO, DENSIDADES, densidadeLegada);
  const [modoVisualizacao, setModoVisualizacao] = useLocalStorageChoice<ModoVisualizacao>('brobond_lista_modo', MODO_PADRAO, MODOS_VISUALIZACAO);

  const [alternandoAtivo, setAlternandoAtivo] = useState<number | null>(null);
  const [alvoExclusao, setAlvoExclusao] = useState<Insumo | null>(null);
  const [excluindo, setExcluindo] = useState(false);
  const [dependencias, setDependencias] = useState<DiagnosticoDependencias | null>(null);

  // Opções de FORNECEDOR e CATEGORIA: vêm do endpoint de opções que o ERP já
  // usa para os campos de referência (`/fornecedores/options`,
  // `/categorias_insumos/options`) — nenhum endpoint novo.
  const [opcoesFornecedor, setOpcoesFornecedor] = useState<Option[]>([]);
  const [opcoesCategoria, setOpcoesCategoria] = useState<Option[]>([]);

  // Opções de UNIDADE: o dicionário é do METADADO do recurso (mesmo `UNIDADES`
  // que o servidor valida) — não há busca paralela para o servidor.
  const opcoesUnidade = useMemo(
    () => (resource?.fields.find((f) => f.name === 'unidade')?.options ?? []).map((o) => ({ value: o.value, label: o.label })),
    [resource]
  );

  useEffect(() => {
    let alive = true;
    const buscar = (rota: string, set: (o: Option[]) => void) =>
      api
        .get<Option[]>(rota)
        .then((o) => {
          if (alive) set(Array.isArray(o) ? o : []);
        })
        .catch(() => {
          if (alive) set([]);
        });
    void buscar('/fornecedores/options', setOpcoesFornecedor);
    void buscar('/categorias_insumos/options', setOpcoesCategoria);
    return () => {
      alive = false;
    };
  }, []);

  // Busca com atraso: não dispara uma requisição por tecla.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setBuscaAplicada(busca.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [busca]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    if (buscaAplicada) p.set('q', buscaAplicada);
    if (status) p.set('f.ativo', status);
    if (unidade) p.set('f.unidade', unidade);
    if (fornecedor) p.set('f.fornecedor_id', fornecedor);
    if (categoria) p.set('f.categoria_id', categoria);
    return p.toString();
  }, [page, pageSize, buscaAplicada, status, unidade, fornecedor, categoria]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<Insumo>>(`/insumos?${params}`);
      setLinhas(d.rows);
      setTotal(d.total);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / pageSize)));
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os insumos.');
    } finally {
      setCarregando(false);
    }
  }, [params, page, pageSize]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const recorteAtivo = buscaAplicada !== '' || status !== '' || unidade !== '' || fornecedor !== '' || categoria !== '';

  // ---- Ativar / Desativar na linha ----
  async function alternarAtivo(row: Insumo, forcar?: boolean) {
    const id = Number(row.id);
    if (alternandoAtivo !== null) return;
    const novo = forcar ?? row.ativo === false;
    setAlternandoAtivo(id);
    try {
      await api.put(`/insumos/${id}`, { ativo: novo });
      toast.success(`“${row.nome}”: status alterado para ${novo ? 'Ativo' : 'Inativo'}.`);
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível alterar o status.');
    } finally {
      setAlternandoAtivo(null);
    }
  }

  // ---- Exclusão (com diagnóstico de dependências) ----
  async function excluir() {
    if (!alvoExclusao) return;
    setExcluindo(true);
    try {
      await api.del(`/insumos/${alvoExclusao.id}`);
      toast.success('Insumo excluído.');
      setAlvoExclusao(null);
      await carregar();
    } catch (e) {
      // Exclusão bloqueada por vínculos: o servidor manda o diagnóstico completo
      // (módulos, quantidades, ids e o motivo). Em vez do toast genérico, abrimos
      // o "Ver vínculos" — nada foi apagado.
      const diag = e instanceof ApiError && e.details?.dependencias ? (e.details.dependencias as DiagnosticoDependencias) : null;
      if (diag) {
        setAlvoExclusao(null);
        setDependencias(diag);
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Não foi possível excluir.');
      }
    } finally {
      setExcluindo(false);
    }
  }

  /** Do diagnóstico de vínculos, desativa o insumo em uso (preserva o histórico). */
  async function desativarDoDiagnostico() {
    if (!dependencias) return;
    const id = dependencias.id;
    setDependencias(null);
    try {
      await api.put(`/insumos/${id}`, { ativo: false });
      toast.success('Insumo desativado. Compras, movimentações e fichas continuam apontando para ele.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível desativar o insumo.');
    }
  }

  const statusFiltro: { value: string; label: string }[] = [
    { value: 'true', label: 'Ativos' },
    { value: 'false', label: 'Inativos' },
  ];

  // ---- Colunas visíveis ----
  const colunasVisiveis = useMemo(
    () => camposOrdenados(COLUNAS.filter((f) => !colunasOcultas.has(f.name)), 'insumos'),
    [colunasOcultas]
  );
  const camposCard = useMemo(() => camposDoCard(COLUNAS, 'insumos'), []);

  const renderAcoes = (linha: Record<string, any>): ReactNode => {
    const row = linha as Insumo;
    const itens = [
      canUpdate && {
        id: 'editar',
        label: 'Editar',
        icon: <Pencil className="h-4 w-4" />,
        onSelect: () => navigate(`/insumos/${row.id}/editar`),
      },
      canUpdate && {
        id: 'status',
        label: row.ativo === false ? 'Ativar' : 'Desativar',
        icon: <Power className="h-4 w-4" />,
        disabled: alternandoAtivo === Number(row.id),
        onSelect: () => void alternarAtivo(row),
      },
      canDelete && {
        id: 'excluir',
        label: 'Excluir',
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onSelect: () => setAlvoExclusao(row),
      },
    ].filter(Boolean) as {
      id: string;
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }[];
    if (!itens.length) return <span className="text-slate-300">—</span>;
    return (
      <div className="flex justify-end">
        <Dropdown
          trigger={<span className="sr-only">Ações do insumo {row.nome}</span>}
          label={`Ações do insumo ${row.nome}`}
          items={itens}
        />
      </div>
    );
  };

  const dependenciasAtivaAinda = !!dependencias && linhas.some((l) => Number(l.id) === Number(dependencias.id) && l.ativo !== false);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Package className="h-5 w-5" />
            </span>
            Insumos
          </span>
        }
        description="Gerencie a matéria-prima usada na produção: insumos, unidade de compra, custo e fornecedor."
        actions={
          canCreate ? (
            // Padrão LISTA → PÁGINA: navega para a página própria de cadastro.
            <button className="btn-accent inline-flex" onClick={() => navigate('/insumos/novo')}>
              <Plus className="h-4 w-4" /> {rotuloNovo('insumos', 'Insumo')}
            </button>
          ) : undefined
        }
      />

      {/* ---- Busca e filtros (server-side) ---- */}
      <div className="card mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[220px] flex-1">
            <label className="sr-only" htmlFor="busca-insumos">
              Buscar insumo
            </label>
            <input
              id="busca-insumos"
              type="search"
              className="input"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={placeholderBusca('insumos', 'Insumos')}
            />
          </div>

          <FiltroRapido
            label="Status"
            opcoes={[{ value: '', label: 'Todos' }, ...statusFiltro]}
            valor={status}
            onChange={(valor) => {
              setStatus(valor);
              setPage(1);
            }}
          />

          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-navy-200">
            <span className="sr-only">Filtrar por unidade</span>
            <select
              className="input !w-auto"
              value={unidade}
              onChange={(e) => {
                setUnidade(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar por unidade"
            >
              <option value="">Todas as unidades</option>
              {opcoesUnidade.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-navy-200">
            <span className="sr-only">Filtrar por categoria</span>
            <select
              className="input !w-auto"
              value={categoria}
              onChange={(e) => {
                setCategoria(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar por categoria"
            >
              <option value="">Todas as categorias</option>
              {opcoesCategoria.map((o) => (
                <option key={o.value} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-navy-200">
            <span className="sr-only">Filtrar por fornecedor</span>
            <select
              className="input !w-auto"
              value={fornecedor}
              onChange={(e) => {
                setFornecedor(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar por fornecedor"
            >
              <option value="">Todos os fornecedores</option>
              {opcoesFornecedor.map((o) => (
                <option key={o.value} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          {recorteAtivo && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                setBusca('');
                setStatus('');
                setUnidade('');
                setFornecedor('');
                setCategoria('');
                setPage(1);
              }}
              title="Remover todos os filtros"
            >
              Limpar filtros
            </button>
          )}
        </div>
      </div>

      {erro && (
        <div className="mb-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      <div className="card overflow-hidden">
        {/* Barra da listagem: modo de visualização + colunas + densidade */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2.5">
          <span className="text-xs text-slate-400" aria-live="polite">
            {carregando && linhas.length > 0 ? 'Atualizando...' : ''}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ModoVisualizacaoControl valor={modoVisualizacao} onChange={setModoVisualizacao} />
            {modoVisualizacao === 'tabela' && (
              <>
                <DensidadeMenu valor={densidade} onChange={setDensidade} />
                {COLUNAS.length > 3 && (
                  <ColunasMenu
                    campos={COLUNAS}
                    recurso="insumos"
                    ocultas={colunasOcultas}
                    onToggle={(nome) => setColunasOcultas(nome)}
                    comFoto={false}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {carregando && linhas.length === 0 ? (
          <Spinner label="Carregando insumos..." />
        ) : linhas.length === 0 ? (
          <EmptyState
            icon={<Package className="h-6 w-6" />}
            title={recorteAtivo ? 'Nada encontrado' : textoVazio('insumos', 'Insumo').titulo}
            description={
              recorteAtivo
                ? `Nenhum resultado para o recorte atual${buscaAplicada ? ` (busca: "${buscaAplicada}")` : ''}.`
                : textoVazio('insumos', 'Insumo').descricao
            }
            action={
              recorteAtivo ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {buscaAplicada && (
                    <button className="btn-secondary" onClick={() => setBusca('')}>
                      Limpar busca
                    </button>
                  )}
                  {(status || unidade || fornecedor || categoria) && (
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        setStatus('');
                        setUnidade('');
                        setFornecedor('');
                        setCategoria('');
                      }}
                    >
                      Limpar filtros
                    </button>
                  )}
                </div>
              ) : canCreate ? (
                <button className="btn-accent" onClick={() => navigate('/insumos/novo')}>
                  <Plus className="h-4 w-4" /> {rotuloNovo('insumos', 'Insumo')}
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className={`transition-opacity ${carregando ? 'opacity-60' : ''}`}>
            {modoVisualizacao === 'tabela' ? (
              <ListaTabela
                rows={linhas}
                fields={colunasVisiveis}
                recurso="insumos"
                densidade={densidade}
                sort={null}
                onSort={() => {}}
                comFoto={false}
                rotuloLinha={rotuloDaLinha}
                renderAcoes={renderAcoes}
                caption={`Insumos — página ${page}`}
              />
            ) : (
              <ListaCards
                rows={linhas}
                fields={camposCard}
                recurso="insumos"
                campoTitulo={campoTitulo('insumos')}
                rotuloLinha={rotuloDaLinha}
                renderAcoes={renderAcoes}
              />
            )}
          </div>
        )}

        {total > 0 && (
          <div className="border-t border-slate-200 px-4 py-3">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              pageSizeOptions={TAMANHOS_PAGINA}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
              label="Paginação de Insumos"
              contagem={contagemDe('insumos')}
            />
          </div>
        )}
      </div>

      {/* ---- Confirmação de exclusão (componente padrão do ERP) ---- */}
      <ConfirmDialog
        open={!!alvoExclusao}
        danger
        busy={excluindo}
        title="Excluir insumo?"
        message={
          alvoExclusao ? (
            <>
              O insumo <strong>“{alvoExclusao.nome}”</strong> será removido definitivamente. Esta ação não pode ser desfeita.
              {Number(alvoExclusao.uso_vinculado ?? 0) > 0 && (
                <>
                  {' '}
                  Ele aparece em {Number(alvoExclusao.uso_vinculado)} ficha(s) técnica(s) — a exclusão será recusada e mostraremos onde ele é usado; o caminho é{' '}
                  <strong>desativar</strong>, preservando o histórico.
                </>
              )}
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Excluir"
        onConfirm={() => void excluir()}
        onCancel={() => setAlvoExclusao(null)}
      />

      {/* ---- Diagnóstico de dependências (mesmo mecanismo dos demais módulos) ---- */}
      <DependenciasModal
        diag={dependencias}
        onClose={() => setDependencias(null)}
        mensagem="Não é possível excluir este insumo porque existem registros vinculados."
        // Regra do ERP: cadastro com histórico NÃO é apagado — desativa-se. O
        // diagnóstico continua somente leitura; a ação é o fluxo normal (PUT).
        acaoRecomendada={
          canUpdate && dependenciasAtivaAinda
            ? {
                rotulo: 'Desativar insumo',
                descricao: 'Mantém compras, movimentações e fichas técnicas apontando para o insumo.',
                onClick: () => void desativarDoDiagnostico(),
              }
            : undefined
        }
      />
    </div>
  );
}
