// ============================================================================
// CADASTRO DE FORNECEDORES — LISTA (tela principal) no padrão do BROBOND ERP.
//
// O cadastro/edição NÃO é uma superfície sobreposta: vive em PÁGINA PRÓPRIA
// (`/fornecedores/novo`, `/fornecedores/:id/editar` — ver FornecedorFormPage),
// exatamente como Cores, Coleções, Grades e Insumos. Aqui só existe a LISTA;
// "Novo fornecedor" e "Editar" NAVEGAM, nunca abrem modal/drawer/overlay.
//
// NÃO inventa campos nem endpoints: usa o contrato existente do recurso
// `fornecedores` (GET/POST/PUT/DELETE /api/fornecedores) com os campos REAIS
// da tabela (db/schema.sql + migration 0021): nome, pessoa (pf/pj/estrangeiro),
// cnpj (CPF/CNPJ com dígito verificador), razao_social, nome_fantasia, fiscal
// (ie, indicador_ie, im), endereço completo (cep…codigo_municipio), contato
// (contato, telefone, whatsapp, email), comercial (prazo_entrega_dias,
// condicao_pagamento, observacoes) e ativo. O servidor revalida tudo
// (validatePayload + checkAccess); a UI só reflete.
//
// COLUNAS — todas com dado REAL no backend:
//   • Fornecedor   → `fornecedores.nome`
//   • Tipo         → `fornecedores.pessoa` (pf/pj/estrangeiro — badge)
//   • CNPJ / CPF   → `fornecedores.cnpj` (documento formatado)
//   • Nome fantasia→ `fornecedores.nome_fantasia`
//   • Localização  → `fornecedores.cidade` + `fornecedores.uf` (apresentação
//                    montada com os dados que a API já devolveu — sem consulta
//                    nova, como a coluna AMOSTRA das cores)
//   • Telefone / E-mail → colunas reais de contato
//   • Status       → `fornecedores.ativo`
//   • Utilização   → pedidos de compra do fornecedor (`compras.fornecedor_id`,
//                    contagem agregada NO SERVIDOR em UMA consulta por página —
//                    nunca um N+1, nunca um número inventado).
//
// MULTIEMPRESA: a listagem, a utilização e as ações são recortadas pela empresa
// ativa no servidor (`empresa: true` no recurso) — nenhuma consulta paralela.
//
// Exclusão: se o fornecedor estiver em uso (compras, insumos, produtos), o
// DELETE responde 409 com o diagnóstico de dependências e a tela abre o
// "Ver vínculos" (o mesmo mecanismo dos demais módulos). A saída é DESATIVAR:
// o histórico (compras, recebimentos, cotações) permanece.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Factory, FileUp, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useMeta, type Field, type ListResult } from '../lib/meta';
import { UFS_BRASIL } from '../lib/format';
import { Alert, ConfirmDialog, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { Dropdown, Pagination } from '../components/ui-kit';
import { ListaTabela, type OrdenacaoLista } from '../components/ListaTabela';
import { ListaCards } from '../components/ListaCards';
import { ColunasMenu, DensidadeMenu, ModoVisualizacaoControl } from '../components/ListaControles';
import { FiltroRapido } from '../components/ListaFiltros';
import { DependenciasModal, type DiagnosticoDependencias } from '../components/DependenciasModal';
import { IMPORT_TIPOS, ImportModal } from '../components/ImportModal';
import { findModuleByResource } from '../modules';
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
  textoContagem,
  textoVazio,
  type Densidade,
  type ModoVisualizacao,
} from '../lib/lista';

type Fornecedor = {
  id: number;
  nome: string | null;
  pessoa: string | null;
  cnpj: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  telefone: string | null;
  email: string | null;
  ativo?: boolean;
  /** Apresentação: cidade + UF que a API já devolveu na linha. */
  localizacao?: string | null;
  /** Contagem real de pedidos de compra (agregada no servidor). */
  uso_vinculado?: number;
  uso_vinculado_label?: string;
};

const PAGE_SIZE = 25;
const TAMANHOS_PAGINA = [25, 50, 100];

/**
 * Colunas da listagem.
 *
 * `localizacao` e `uso_vinculado` são campos VIRTUAIS: não existem como coluna
 * em `fornecedores`. A utilização o servidor anota (agregada, uma consulta por
 * página, recortada pela empresa ativa); a localização é só apresentação
 * (cidade · UF), montada com os dados que já vieram na linha. Nenhum outro
 * dado é apresentado.
 */
const COLUNAS: Field[] = [
  { name: 'nome', label: 'Fornecedor', type: 'text', list: true },
  {
    name: 'pessoa',
    label: 'Tipo',
    type: 'select',
    list: true,
    // Espelho de server/src/resources.ts › PESSOA (rótulo curto para o badge).
    options: [
      { value: 'pj', label: 'PJ', tone: 'blue' },
      { value: 'pf', label: 'PF', tone: 'slate' },
      { value: 'estrangeiro', label: 'Estrangeiro', tone: 'amber' },
    ],
  },
  { name: 'cnpj', label: 'CNPJ / CPF', type: 'document', list: true },
  { name: 'nome_fantasia', label: 'Nome fantasia', type: 'text', list: true },
  { name: 'localizacao', label: 'Localização', type: 'text', virtual: true, list: true, hint: 'Cidade e UF do cadastro do fornecedor.' },
  { name: 'telefone', label: 'Telefone', type: 'phone', list: true },
  { name: 'email', label: 'E-mail', type: 'email', list: true },
  { name: 'ativo', label: 'Status', type: 'boolean', list: true },
  { name: 'uso_vinculado', label: 'Utilização', type: 'integer', virtual: true, list: true, hint: 'Pedidos de compra deste fornecedor na empresa ativa.' },
];

/** Opções do filtro de tipo de pessoa (mesmo dicionário do servidor). */
const OPCOES_PESSOA = [
  { value: 'pj', label: 'Pessoa jurídica' },
  { value: 'pf', label: 'Pessoa física' },
  { value: 'estrangeiro', label: 'Estrangeiro' },
];

/** Texto de identificação da linha (o nome do fornecedor). */
function rotuloDaLinha(row: Record<string, any>): string {
  return String(row.nome ?? '').trim() || `#${row.id}`;
}

/** Cidade + UF para a coluna de apresentação (null quando não há nada). */
function localizacaoDaLinha(row: Record<string, any>): string | null {
  const cidade = String(row.cidade ?? '').trim();
  const uf = String(row.uf ?? '').trim().toUpperCase();
  if (cidade && uf) return `${cidade} · ${uf}`;
  return cidade || uf || null;
}

export default function FornecedoresPage() {
  const toast = useToast();
  const meta = useMeta();
  const navigate = useNavigate();
  const { user } = useAuth();
  const resource = meta.resources['fornecedores'];

  // RBAC: espelha o servidor (checkAccess). A autoridade real é a API — aqui só
  // evitamos exibir um botão que receberia 403. Fornecedores é cadastro POR
  // EMPRESA: não há `minPerfilEscrita` (isso é do catálogo GLOBAL). O operador
  // lê/cria/edita, mas NÃO exclui (o servidor recusa o DELETE).
  const isOperador = user?.perfil === 'operador';
  const perfilOkEscrita =
    !resource?.minPerfilEscrita ||
    user?.perfil === 'admin' ||
    (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const canCreate = !!resource?.ops.create && perfilOkEscrita;
  const canUpdate = !!resource?.ops.update && perfilOkEscrita;
  const canDelete = !!resource?.ops.delete && !isOperador && perfilOkEscrita;

  const [carregando, setCarregando] = useState(true);
  const [linhas, setLinhas] = useState<Fornecedor[]>([]);
  const [total, setTotal] = useState(0);
  const [erro, setErro] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useLocalStorageInt('brobond_lista_page_size', PAGE_SIZE, TAMANHOS_PAGINA);
  const [sort, setSort] = useState<OrdenacaoLista>(null);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [status, setStatus] = useState('');
  const [tipoPessoa, setTipoPessoa] = useState('');
  const [uf, setUf] = useState('');

  // Importação (CSV/XLSX) — o MESMO ImportModal do CRUD genérico, com o tipo
  // `fornecedores` já declarado em IMPORT_TIPOS. Nenhum endpoint novo.
  const importTipo = IMPORT_TIPOS.find((t) => t.recurso === 'fornecedores');
  const [importOpen, setImportOpen] = useState(false);

  // Preferências de apresentação (persistidas no navegador), como no resto
  // do ERP: modo de visualização, densidade e colunas visíveis. A chave de
  // colunas é a MESMA do CRUD genérico (`brobond_colunas_ocultas_<recurso>`):
  // a preferência do usuário sobrevive à migração da tela.
  const [colunasOcultas, setColunasOcultas] = useLocalStorageSet('brobond_colunas_ocultas_fornecedores');
  const [densidade, setDensidade] = useLocalStorageChoice<Densidade>('brobond_lista_densidade', DENSIDADE_PADRAO, DENSIDADES, densidadeLegada);
  const [modoVisualizacao, setModoVisualizacao] = useLocalStorageChoice<ModoVisualizacao>('brobond_lista_modo', MODO_PADRAO, MODOS_VISUALIZACAO);

  const [alternandoAtivo, setAlternandoAtivo] = useState<number | null>(null);
  const [alvoExclusao, setAlvoExclusao] = useState<Fornecedor | null>(null);
  const [excluindo, setExcluindo] = useState(false);
  const [dependencias, setDependencias] = useState<DiagnosticoDependencias | null>(null);

  // Busca com atraso: não dispara uma requisição por tecla.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setBuscaAplicada(busca.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [busca]);

  /** Filtros/ordenação compartilhados pela listagem e pela exportação. */
  const paramsFiltros = useMemo(() => {
    const p = new URLSearchParams();
    if (buscaAplicada) p.set('q', buscaAplicada);
    if (status) p.set('f.ativo', status);
    if (tipoPessoa) p.set('f.pessoa', tipoPessoa);
    if (uf) p.set('f.uf', uf);
    if (sort) {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    }
    return p.toString();
  }, [buscaAplicada, status, tipoPessoa, uf, sort]);

  const params = useMemo(() => {
    const p = new URLSearchParams(paramsFiltros);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    return p.toString();
  }, [paramsFiltros, page, pageSize]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<Fornecedor>>(`/fornecedores?${params}`);
      // `localizacao` é apresentação (cidade · UF): monta com o que a API já
      // devolveu — nenhuma consulta por linha.
      setLinhas(d.rows.map((r) => ({ ...r, localizacao: localizacaoDaLinha(r) })));
      setTotal(d.total);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / pageSize)));
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os fornecedores.');
    } finally {
      setCarregando(false);
    }
  }, [params, page, pageSize]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const recorteAtivo = buscaAplicada !== '' || status !== '' || tipoPessoa !== '' || uf !== '';

  /** Exporta a lista atual (honrando busca, ordenação e filtros) — mesmo
      endpoint genérico do CRUD (`/fornecedores/export`). */
  async function exportarLista(formato: 'csv' | 'xlsx') {
    try {
      await downloadFile(`/fornecedores/export?format=${formato}&${paramsFiltros}`, `fornecedores.${formato}`);
      toast.success(`Exportação ${formato.toUpperCase()} gerada.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível exportar.');
    }
  }

  /** Ordenação server-side: asc → desc → padrão do recurso (nome). */
  function alternarOrdenacao(f: Field) {
    if (f.virtual) return;
    setSort((s) => (s?.field === f.name ? (s.dir === 'asc' ? { field: f.name, dir: 'desc' } : null) : { field: f.name, dir: 'asc' }));
    setPage(1);
  }

  // ---- Ativar / Desativar na linha ----
  async function alternarAtivo(row: Fornecedor, forcar?: boolean) {
    const id = Number(row.id);
    if (alternandoAtivo !== null) return;
    const novo = forcar ?? row.ativo === false;
    setAlternandoAtivo(id);
    try {
      await api.put(`/fornecedores/${id}`, { ativo: novo });
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
      await api.del(`/fornecedores/${alvoExclusao.id}`);
      toast.success('Fornecedor excluído.');
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

  /** Do diagnóstico de vínculos, desativa o fornecedor em uso (preserva o histórico). */
  async function desativarDoDiagnostico() {
    if (!dependencias) return;
    const id = dependencias.id;
    setDependencias(null);
    try {
      await api.put(`/fornecedores/${id}`, { ativo: false });
      toast.success('Fornecedor desativado. Compras, cotações e insumos continuam apontando para ele.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível desativar o fornecedor.');
    }
  }

  const statusFiltro: { value: string; label: string }[] = [
    { value: 'true', label: 'Ativos' },
    { value: 'false', label: 'Inativos' },
  ];

  // ---- Colunas visíveis ----
  const colunasVisiveis = useMemo(
    () => camposOrdenados(COLUNAS.filter((f) => !colunasOcultas.has(f.name)), 'fornecedores'),
    [colunasOcultas]
  );
  const camposCard = useMemo(() => camposDoCard(COLUNAS, 'fornecedores'), []);

  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);

  const renderAcoes = (linha: Record<string, any>): ReactNode => {
    const row = linha as Fornecedor;
    const itens = [
      canUpdate && {
        id: 'editar',
        label: 'Editar',
        icon: <Pencil className="h-4 w-4" />,
        onSelect: () => navigate(`/fornecedores/${row.id}/editar`),
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
          trigger={<span className="sr-only">Ações do fornecedor {row.nome}</span>}
          label={`Ações do fornecedor ${row.nome}`}
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
              <Factory className="h-5 w-5" />
            </span>
            Fornecedores
          </span>
        }
        description="Empresas e pessoas de quem você compra: dados fiscais, endereço, contato e utilização nas compras."
        actions={
          <>
            <button className="btn-secondary" onClick={() => void carregar()} disabled={carregando} title="Atualizar lista">
              <RefreshCw className={`h-4 w-4 ${carregando ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
            <button className="btn-secondary" onClick={() => void exportarLista('csv')} disabled={carregando} title="Exportar a lista atual em CSV (Excel)">
              <Download className="h-4 w-4" />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button className="btn-secondary" onClick={() => void exportarLista('xlsx')} disabled={carregando} title="Exportar a lista atual em XLSX">
              <Download className="h-4 w-4 text-emerald-600" />
              <span className="hidden md:inline">XLSX</span>
            </button>
            {importTipo && !isOperador && (
              <button className="btn-secondary" onClick={() => setImportOpen(true)} title="Importar fornecedores de CSV/XLSX">
                <FileUp className="h-4 w-4" />
                <span className="hidden sm:inline">Importar</span>
              </button>
            )}
            {canCreate && (
              // Padrão LISTA → PÁGINA: navega para a página própria de cadastro.
              <button className="btn-accent inline-flex" onClick={() => navigate('/fornecedores/novo')}>
                <Plus className="h-4 w-4" /> {rotuloNovo('fornecedores', 'Fornecedor')}
              </button>
            )}
          </>
        }
      />

      {resource?.notice && (
        <div className="mb-4">
          <Alert tone="blue">{resource.notice}</Alert>
        </div>
      )}

      {/* ---- Busca e filtros (server-side) ---- */}
      <div className="card mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[220px] flex-1">
            <label className="sr-only" htmlFor="busca-fornecedores">
              Buscar fornecedor
            </label>
            <input
              id="busca-fornecedores"
              type="search"
              className="input"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={placeholderBusca('fornecedores', 'Fornecedores')}
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
            <span className="sr-only">Filtrar por tipo de pessoa</span>
            <select
              className="input !w-auto"
              value={tipoPessoa}
              onChange={(e) => {
                setTipoPessoa(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar por tipo"
            >
              <option value="">Todos os tipos</option>
              {OPCOES_PESSOA.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-navy-200">
            <span className="sr-only">Filtrar por UF</span>
            <select
              className="input !w-auto"
              value={uf}
              onChange={(e) => {
                setUf(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar por UF"
            >
              <option value="">Todas as UFs</option>
              {UFS_BRASIL.map((sigla) => (
                <option key={sigla} value={sigla}>
                  {sigla}
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
                setTipoPessoa('');
                setUf('');
                setPage(1);
              }}
              title="Remover todos os filtros"
            >
              Limpar filtros
            </button>
          )}

          <div className="ml-auto text-xs text-slate-500" aria-live="polite">
            {carregando && linhas.length === 0 ? 'Carregando...' : textoContagem('fornecedores', from, to, total)}
          </div>
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
                    recurso="fornecedores"
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
          <Spinner label="Carregando fornecedores..." />
        ) : linhas.length === 0 ? (
          <EmptyState
            icon={<Factory className="h-6 w-6" />}
            title={recorteAtivo ? 'Nada encontrado' : textoVazio('fornecedores', 'Fornecedor').titulo}
            description={
              recorteAtivo
                ? `Nenhum resultado para o recorte atual${buscaAplicada ? ` (busca: "${buscaAplicada}")` : ''}.`
                : textoVazio('fornecedores', 'Fornecedor').descricao
            }
            action={
              recorteAtivo ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {buscaAplicada && (
                    <button className="btn-secondary" onClick={() => setBusca('')}>
                      Limpar busca
                    </button>
                  )}
                  {(status || tipoPessoa || uf) && (
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        setStatus('');
                        setTipoPessoa('');
                        setUf('');
                      }}
                    >
                      Limpar filtros
                    </button>
                  )}
                </div>
              ) : canCreate ? (
                <button className="btn-accent" onClick={() => navigate('/fornecedores/novo')}>
                  <Plus className="h-4 w-4" /> {rotuloNovo('fornecedores', 'Fornecedor')}
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
                recurso="fornecedores"
                densidade={densidade}
                sort={sort}
                onSort={alternarOrdenacao}
                comFoto={false}
                rotuloLinha={rotuloDaLinha}
                renderAcoes={renderAcoes}
                onAbrirLinha={canUpdate ? (row) => navigate(`/fornecedores/${Number(row.id)}/editar`) : undefined}
                caption={`Fornecedores — página ${page}`}
              />
            ) : (
              <ListaCards
                rows={linhas}
                fields={camposCard}
                recurso="fornecedores"
                campoTitulo={campoTitulo('fornecedores')}
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
              label="Paginação de Fornecedores"
              contagem={contagemDe('fornecedores')}
            />
          </div>
        )}
      </div>

      {/* ---- Importação (o MESMO ImportModal do CRUD genérico) ---- */}
      {importTipo && (
        <ImportModal open={importOpen} onClose={() => setImportOpen(false)} tipoConfig={importTipo} onDone={() => void carregar()} />
      )}

      {/* ---- Confirmação de exclusão (componente padrão do ERP) ---- */}
      <ConfirmDialog
        open={!!alvoExclusao}
        danger
        busy={excluindo}
        title="Excluir fornecedor?"
        message={
          alvoExclusao ? (
            <>
              O fornecedor <strong>“{alvoExclusao.nome}”</strong> será removido definitivamente. Esta ação não pode ser desfeita.
              {Number(alvoExclusao.uso_vinculado ?? 0) > 0 && (
                <>
                  {' '}
                  Ele aparece em {Number(alvoExclusao.uso_vinculado)} pedido(s) de compra — a exclusão será recusada e mostraremos onde ele é usado; o
                  caminho é <strong>desativar</strong>, preservando o histórico.
                </>
              )}
              {Number(alvoExclusao.uso_vinculado ?? 0) === 0 && (
                <p className="mt-2 text-slate-500">Dica: se o fornecedor já foi usado em compras, cotações ou insumos, prefira DESATIVAR — o histórico permanece.</p>
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
        mensagem="Não é possível excluir este fornecedor porque existem registros vinculados."
        // Regra do ERP: cadastro com histórico NÃO é apagado — desativa-se. O
        // diagnóstico continua somente leitura; a ação é o fluxo normal (PUT).
        acaoRecomendada={
          canUpdate && dependenciasAtivaAinda
            ? {
                rotulo: 'Desativar fornecedor',
                descricao: 'Mantém compras, recebimentos, cotações e insumos apontando para o fornecedor.',
                onClick: () => void desativarDoDiagnostico(),
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
    </div>
  );
}
