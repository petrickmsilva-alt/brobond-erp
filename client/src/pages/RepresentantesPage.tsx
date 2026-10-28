// ============================================================================
// CADASTRO DE REPRESENTANTES — LISTA (tela principal) no padrão do BROBOND ERP.
//
// `representantes` É a entidade oficial de vendedores/funcionários do ERP —
// não existe outra. O cadastro/edição NÃO é uma superfície sobreposta: vive em
// PÁGINA PRÓPRIA (`/representantes/novo` e `/representantes/:id/editar` — ver
// RepresentanteFormPage), exatamente como Clientes, Fornecedores, Insumos,
// Cores, Coleções, Grades e Tamanhos. Aqui só existe a LISTA; "Novo
// representante" e "Editar" NAVEGAM — nunca abrem modal/drawer/overlay/sheet.
//
// CAMPOS REAIS (db/schema.sql + migrations 0021 e 0048 — nenhum campo
// inventado): codigo, tipo_pessoa, cpf, cnpj, razao_social, nome_fantasia,
// tipo_representante, registro_profissional, orgao_registro, nome, cargo,
// data_nascimento, admissao, desligamento, ativo, comissao_pct, territorio_id,
// regiao (legado), usuario_id, telefone, celular, whatsapp, email, endereço
// estruturado, observacoes, criado_em e atualizado_em. NÃO existem salário,
// meta, limite de crédito, banco/PIX, "comissão acumulada", "vendas totais
// persistidas", foto nem tabela de preço — e a tela não os inventa.
//
// COLUNAS — todas com dado REAL no backend:
//   • Representante → `representantes.nome` (informação principal)
//   • Código        → `representantes.codigo`  (identificador comercial)
//   • CPF/CNPJ      → apresentação conforme `tipo_pessoa` (PF usa cpf, PJ usa
//                     cnpj) — nunca os dois na mesma linha
//   • Tipo          → `representantes.tipo_representante` (papel comercial)
//   • Cargo         → `representantes.cargo`   (informação funcional)
//   • Território    → `representantes.territorio_id` (label do domínio)
//   • Equipe        → projeção de `equipe_membros` (equipe VIGENTE)
//   • Carteira      → projeção de `representante_cliente` (vínculos vigentes)
//   • Comissão      → `representantes.comissao_pct`
//   • Usuário       → `representantes.usuario_id` (label vinda do join do
//                     servidor; `usuarios` é adminOnly, então o rótulo é o que
//                     a API autorizou a ler)
//   • Contato       → apresentação: telefone · e-mail que a API já devolveu na
//                     linha (sem consulta nova, como a AMOSTRA das cores)
//   • Status        → `representantes.ativo`
//   • Utilização    → `vendas.representante_id`: pedidos de venda da EMPRESA
//                     ATIVA do representante, agregados NO SERVIDOR em UMA
//                     consulta por página (`anotarUsoVinculado`) — nunca um
//                     N+1 e nunca um número inventado. Não é faturamento, meta,
//                     ranking nem "vendas totais persistidas".
//
// BUSCA (server-side, `?q=`): nome, CPF, cargo, região, telefone, WhatsApp e
// e-mail — os campos com `search: true` do recurso. O CPF é comparado também
// pelos DÍGITOS (o mesmo mecanismo de documentos/telefones do ERP), então
// "529.982.247-25" e "52998224725" encontram o mesmo registro.
//
// FILTROS (server-side, contrato `f.<campo>`): STATUS (Todos/Ativos/Inativos),
// TIPO DE REPRESENTANTE (`f.tipo_representante`), TERRITÓRIO
// (`f.territorio_id`, com as opções do DOMÍNIO em `/territorios/options`) e
// USUÁRIO VINCULADO (`f.usuario_id`). Cargo, código, documento e região são
// texto livre: entram pela busca, sem inventar endpoint de valores distintos.
// Equipe tem filtro VIRTUAL no servidor (`f.equipe_id`, resolvido a partir de
// `equipe_membros`) — a tela não duplica a composição.
//
// MULTIEMPRESA: listagem, filtros, utilização e ações são recortados pela
// empresa ativa no servidor (`empresa: true` no recurso) — nenhuma consulta
// paralela.
//
// EXCLUSÃO: se o representante estiver em uso (vendas, clientes, propostas,
// comissões), o DELETE responde 409 com o diagnóstico de dependências e a tela
// abre o "Ver vínculos" (o MESMO mecanismo dos demais módulos). A saída é
// DESATIVAR/DESLIGAR: o histórico comercial permanece — nenhum CASCADE novo,
// nenhuma FK removida.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Download, Handshake, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useMeta, type Field, type ListResult, type Option } from '../lib/meta';
import { formatPhone } from '../lib/format';
import { Alert, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { Dropdown, Pagination } from '../components/ui-kit';
import { ListaTabela, type OrdenacaoLista } from '../components/ListaTabela';
import { ListaCards } from '../components/ListaCards';
import { ColunasMenu, DensidadeMenu, ModoVisualizacaoControl } from '../components/ListaControles';
import { FiltroRapido } from '../components/ListaFiltros';
import { DependenciasModal, type DiagnosticoDependencias } from '../components/DependenciasModal';
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

type Representante = {
  id: number;
  codigo: string | null;
  nome: string | null;
  tipo_pessoa: string | null;
  tipo_representante: string | null;
  cpf: string | null;
  cnpj: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  cargo: string | null;
  regiao: string | null;
  comissao_pct: number | string | null;
  territorio_id: number | null;
  territorio_id__label?: string | null;
  usuario_id: number | null;
  usuario_id__label?: string | null;
  telefone: string | null;
  celular: string | null;
  whatsapp: string | null;
  email: string | null;
  ativo?: boolean;
  /** Contagem REAL de pedidos de venda (agregada no servidor). */
  uso_vinculado?: number;
  uso_vinculado_label?: string;
  /** Projeção de equipe vigente (equipe_membros) — anotada em lote. */
  equipe_label?: string | null;
  equipe_count?: number;
  /** Projeção de carteira (representante_cliente) — anotada em lote. */
  carteira_vinculos?: number;
  carteira_historico?: number;
  /** Apresentação: documento e contato montados com o que a API devolveu. */
  documento?: string | null;
  contato?: string | null;
};

const PAGE_SIZE = 25;
const TAMANHOS_PAGINA = [25, 50, 100];

/** Tipos de representante (espelho do CHECK do banco / options do recurso). */
const TIPOS_REPRESENTANTE = [
  { value: 'INTERNO', label: 'Interno' },
  { value: 'EXTERNO', label: 'Externo' },
  { value: 'REPRESENTANTE_COMERCIAL', label: 'Representante comercial' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'COORDENADOR', label: 'Coordenador' },
  { value: 'GERENTE', label: 'Gerente' },
  { value: 'PARCEIRO', label: 'Parceiro' },
  { value: 'TERCEIRIZADO', label: 'Terceirizado' },
];

/**
 * Colunas da listagem.
 *
 * `contato` e `uso_vinculado` são campos VIRTUAIS: não existem como coluna em
 * `representantes`. A utilização o servidor anota (agregada, uma consulta por
 * página, recortada pela empresa ativa); o contato é só apresentação
 * (telefone · e-mail) montada com o que já veio na linha. Nenhum outro dado é
 * apresentado.
 */
const COLUNAS: Field[] = [
  { name: 'codigo', label: 'Código', type: 'text', list: true },
  { name: 'nome', label: 'Representante', type: 'text', list: true },
  { name: 'documento', label: 'CPF/CNPJ', type: 'document', virtual: true, list: true, hint: 'Documento conforme o tipo de pessoa (CPF para PF, CNPJ para PJ).' },
  {
    name: 'tipo_representante',
    label: 'Tipo',
    type: 'select',
    list: true,
    options: [
      { value: 'INTERNO', label: 'Interno', tone: 'slate' },
      { value: 'EXTERNO', label: 'Externo', tone: 'blue' },
      { value: 'REPRESENTANTE_COMERCIAL', label: 'Rep. comercial', tone: 'blue' },
      { value: 'SUPERVISOR', label: 'Supervisor', tone: 'amber' },
      { value: 'COORDENADOR', label: 'Coordenador', tone: 'amber' },
      { value: 'GERENTE', label: 'Gerente', tone: 'green' },
      { value: 'PARCEIRO', label: 'Parceiro', tone: 'green' },
      { value: 'TERCEIRIZADO', label: 'Terceirizado', tone: 'slate' },
    ],
  },
  { name: 'cargo', label: 'Cargo', type: 'text', list: true },
  { name: 'territorio_id', label: 'Território', type: 'ref', ref: 'territorios', list: true },
  { name: 'equipe_label', label: 'Equipe', type: 'text', virtual: true, list: true, hint: 'Equipes vigentes do representante (equipe_membros).' },
  { name: 'comissao_pct', label: 'Comissão', type: 'percent', list: true },
  { name: 'usuario_id', label: 'Usuário', type: 'ref', ref: 'usuarios', list: true },
  { name: 'contato', label: 'Contato', type: 'text', virtual: true, list: true, hint: 'Telefone/celular e e-mail do cadastro do representante.' },
  { name: 'carteira_vinculos', label: 'Carteira', type: 'integer', virtual: true, list: true, hint: 'Clientes com vínculo de carteira vigente (representante_cliente).' },
  { name: 'ativo', label: 'Status', type: 'boolean', list: true },
  {
    name: 'uso_vinculado',
    label: 'Utilização',
    type: 'integer',
    virtual: true,
    list: true,
    hint: 'Pedidos de venda da empresa ativa vinculados a este representante.',
  },
];

/** Texto de identificação da linha (o nome do representante). */
function rotuloDaLinha(row: Record<string, any>): string {
  return String(row.nome ?? '').trim() || `#${row.id}`;
}

/** Contato para a coluna de apresentação (telefone · e-mail, null se vazio). */
function contatoDaLinha(row: Record<string, any>): string | null {
  const telefone = formatPhone(row.telefone);
  const celular = formatPhone(row.celular);
  const whatsapp = formatPhone(row.whatsapp);
  const email = String(row.email ?? '').trim();
  const partes: string[] = [];
  if (telefone) partes.push(telefone);
  if (celular) partes.push(`${celular} (celular)`);
  if (!telefone && !celular && whatsapp) partes.push(`${whatsapp} (WhatsApp)`);
  if (email) partes.push(email);
  return partes.length ? partes.join(' · ') : null;
}

/** Documento de apresentação: CPF para PF, CNPJ para PJ (o que existir). */
function documentoDaLinha(row: Record<string, any>): string | null {
  const valor = String(row.tipo_pessoa ?? '').toUpperCase() === 'PJ' ? row.cnpj ?? row.cpf : row.cpf ?? row.cnpj;
  const digitos = String(valor ?? '').replace(/\D/g, '');
  return digitos || null;
}

export default function RepresentantesPage() {
  const toast = useToast();
  const meta = useMeta();
  const navigate = useNavigate();
  const { user } = useAuth();
  const resource = meta.resources['representantes'];

  // RBAC: espelha o servidor (checkAccess). A autoridade real é a API — aqui só
  // evitamos exibir um botão que receberia 403. Representantes é cadastro POR
  // EMPRESA: não há `minPerfilEscrita`. O operador lê/cria/edita, mas NÃO
  // exclui (o servidor recusa o DELETE).
  const isOperador = user?.perfil === 'operador';
  const perfilOkEscrita =
    !resource?.minPerfilEscrita ||
    user?.perfil === 'admin' ||
    (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const canCreate = !!resource?.ops.create && perfilOkEscrita;
  const canUpdate = !!resource?.ops.update && perfilOkEscrita;
  const canDelete = !!resource?.ops.delete && !isOperador && perfilOkEscrita;

  const [carregando, setCarregando] = useState(true);
  const [linhas, setLinhas] = useState<Representante[]>([]);
  const [total, setTotal] = useState(0);
  const [erro, setErro] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useLocalStorageInt('brobond_lista_page_size', PAGE_SIZE, TAMANHOS_PAGINA);
  const [sort, setSort] = useState<OrdenacaoLista>(null);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [status, setStatus] = useState('');
  const [usuarioId, setUsuarioId] = useState('');
  const [tipo, setTipo] = useState('');
  const [territorioId, setTerritorioId] = useState('');
  // Territórios da empresa ativa (opções do próprio domínio — nenhuma lista
  // paralela): o filtro é server-side (`f.territorio_id`).
  const [territorioOpts, setTerritorioOpts] = useState<Option[]>([]);
  // Opções do filtro "Usuário vinculado" — o MESMO contrato `/usuarios/options`
  // usado pelos selects do ERP. `usuarios` é adminOnly: quando a API nega, o
  // filtro simplesmente não é oferecido (nada de erro na tela).
  const [usuarioOpts, setUsuarioOpts] = useState<Option[]>([]);

  // Preferências de apresentação (persistidas no navegador), como no resto do
  // ERP: modo de visualização, densidade e colunas visíveis. A chave de colunas
  // é a MESMA do CRUD genérico (`brobond_colunas_ocultas_<recurso>`).
  const [colunasOcultas, setColunasOcultas] = useLocalStorageSet('brobond_colunas_ocultas_representantes');
  const [densidade, setDensidade] = useLocalStorageChoice<Densidade>('brobond_lista_densidade', DENSIDADE_PADRAO, DENSIDADES, densidadeLegada);
  const [modoVisualizacao, setModoVisualizacao] = useLocalStorageChoice<ModoVisualizacao>('brobond_lista_modo', MODO_PADRAO, MODOS_VISUALIZACAO);

  const [alternandoAtivo, setAlternandoAtivo] = useState<number | null>(null);
  const [alvoExclusao, setAlvoExclusao] = useState<Representante | null>(null);
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

  // Opções do filtro de território (o MESMO contrato `/territorios/options`).
  useEffect(() => {
    let vivo = true;
    api
      .get<Option[]>('/territorios/options')
      .then((o) => {
        if (vivo && Array.isArray(o)) setTerritorioOpts(o);
      })
      .catch(() => {
        if (vivo) setTerritorioOpts([]);
      });
    return () => {
      vivo = false;
    };
  }, []);

  // Opções do filtro de usuário (silencioso quando o perfil não pode listar).
  useEffect(() => {
    let vivo = true;
    api
      .get<Option[]>('/usuarios/options')
      .then((o) => {
        if (vivo && Array.isArray(o)) setUsuarioOpts(o);
      })
      .catch(() => {
        if (vivo) setUsuarioOpts([]);
      });
    return () => {
      vivo = false;
    };
  }, []);

  /** Filtros/ordenação compartilhados pela listagem e pela exportação. */
  const paramsFiltros = useMemo(() => {
    const p = new URLSearchParams();
    if (buscaAplicada) p.set('q', buscaAplicada);
    if (status) p.set('f.ativo', status);
    if (usuarioId) p.set('f.usuario_id', usuarioId);
    if (tipo) p.set('f.tipo_representante', tipo);
    if (territorioId) p.set('f.territorio_id', territorioId);
    if (sort) {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    }
    return p.toString();
  }, [buscaAplicada, status, usuarioId, tipo, territorioId, sort]);

  const params = useMemo(() => {
    const p = new URLSearchParams(paramsFiltros);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    return p.toString();
  }, [paramsFiltros, page, pageSize]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<Representante>>(`/representantes?${params}`);
      // `contato` é apresentação (telefone · e-mail): monta com o que a API já
      // devolveu — nenhuma consulta por linha.
      setLinhas(d.rows.map((r) => ({ ...r, documento: documentoDaLinha(r), contato: contatoDaLinha(r) })));
      setTotal(d.total);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / pageSize)));
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os representantes.');
    } finally {
      setCarregando(false);
    }
  }, [params, page, pageSize]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const recorteAtivo = buscaAplicada !== '' || status !== '' || usuarioId !== '' || tipo !== '' || territorioId !== '';

  /** Exporta a lista atual (honrando busca, ordenação e filtros) — mesmo
      endpoint genérico do CRUD (`/representantes/export`). */
  async function exportarLista(formato: 'csv' | 'xlsx') {
    try {
      await downloadFile(`/representantes/export?format=${formato}&${paramsFiltros}`, `representantes.${formato}`);
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
  async function alternarAtivo(row: Representante, forcar?: boolean) {
    const id = Number(row.id);
    if (alternandoAtivo !== null) return;
    const novo = forcar ?? row.ativo === false;
    setAlternandoAtivo(id);
    try {
      await api.put(`/representantes/${id}`, { ativo: novo });
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
      await api.del(`/representantes/${alvoExclusao.id}`);
      toast.success('Representante excluído.');
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

  /** Do diagnóstico de vínculos, desativa o representante em uso (preserva o histórico). */
  async function desativarDoDiagnostico() {
    if (!dependencias) return;
    const id = dependencias.id;
    setDependencias(null);
    try {
      await api.put(`/representantes/${id}`, { ativo: false });
      toast.success('Representante desativado. Vendas, clientes, propostas e comissões continuam apontando para ele.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível desativar o representante.');
    }
  }

  const statusFiltro: { value: string; label: string }[] = [
    { value: 'true', label: 'Ativos' },
    { value: 'false', label: 'Inativos' },
  ];

  // ---- Colunas visíveis ----
  const colunasVisiveis = useMemo(
    () => camposOrdenados(COLUNAS.filter((f) => !colunasOcultas.has(f.name)), 'representantes'),
    [colunasOcultas]
  );
  const camposCard = useMemo(() => camposDoCard(COLUNAS, 'representantes'), []);

  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);

  const renderAcoes = (linha: Record<string, any>): ReactNode => {
    const row = linha as Representante;
    const itens = [
      {
        id: 'ficha',
        label: 'Ver ficha e painel',
        icon: <BarChart3 className="h-4 w-4" />,
        onSelect: () => navigate(`/representantes/${row.id}`),
      },
      canUpdate && {
        id: 'editar',
        label: 'Editar',
        icon: <Pencil className="h-4 w-4" />,
        onSelect: () => navigate(`/representantes/${row.id}/editar`),
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
          trigger={<span className="sr-only">Ações do representante {row.nome}</span>}
          label={`Ações do representante ${row.nome}`}
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
              <Handshake className="h-5 w-5" />
            </span>
            Representantes
          </span>
        }
        description="Cadastro mestre do time comercial: código, PF/PJ, tipo, cargo, território, equipe, comissão padrão, contato e utilização nas vendas."
        actions={
          <>
            <button className="btn-secondary" onClick={() => void carregar()} disabled={carregando} title="Atualizar lista">
              <RefreshCw className={`h-4 w-4 ${carregando ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
            <button
              className="btn-secondary"
              onClick={() => void exportarLista('csv')}
              disabled={carregando}
              title="Exportar a lista atual em CSV (Excel)"
            >
              <Download className="h-4 w-4" />
              <span className="hidden md:inline">CSV</span>
            </button>
            <button
              className="btn-secondary"
              onClick={() => void exportarLista('xlsx')}
              disabled={carregando}
              title="Exportar a lista atual em XLSX"
            >
              <Download className="h-4 w-4 text-emerald-600" />
              <span className="hidden md:inline">XLSX</span>
            </button>
            {canCreate && (
              // Padrão LISTA → PÁGINA: navega para a página própria de cadastro.
              <button className="btn-accent inline-flex" onClick={() => navigate('/representantes/novo')}>
                <Plus className="h-4 w-4" /> {rotuloNovo('representantes', 'Representante')}
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
            <label className="sr-only" htmlFor="busca-representantes">
              Buscar representante
            </label>
            <input
              id="busca-representantes"
              type="search"
              className="input"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={placeholderBusca('representantes', 'Representantes')}
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
            <span className="sr-only">Filtrar por tipo de representante</span>
            <select
              className="input !w-auto"
              value={tipo}
              onChange={(e) => {
                setTipo(e.target.value);
                setPage(1);
              }}
              aria-label="Filtrar por tipo de representante"
            >
              <option value="">Todos os tipos</option>
              {TIPOS_REPRESENTANTE.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {territorioOpts.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-navy-200">
              <span className="sr-only">Filtrar por território</span>
              <select
                className="input !w-auto"
                value={territorioId}
                onChange={(e) => {
                  setTerritorioId(e.target.value);
                  setPage(1);
                }}
                aria-label="Filtrar por território"
              >
                <option value="">Todos os territórios</option>
                {territorioOpts.map((o) => (
                  <option key={o.value} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {usuarioOpts.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-navy-200">
              <span className="sr-only">Filtrar por usuário do sistema</span>
              <select
                className="input !w-auto"
                value={usuarioId}
                onChange={(e) => {
                  setUsuarioId(e.target.value);
                  setPage(1);
                }}
                aria-label="Filtrar por usuário do sistema"
              >
                <option value="">Todos os usuários</option>
                {usuarioOpts.map((o) => (
                  <option key={o.value} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {recorteAtivo && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                setBusca('');
                setStatus('');
                setUsuarioId('');
                setTipo('');
                setTerritorioId('');
                setPage(1);
              }}
              title="Remover todos os filtros"
            >
              Limpar filtros
            </button>
          )}

          <div className="ml-auto text-xs text-slate-500" aria-live="polite">
            {carregando && linhas.length === 0 ? 'Carregando...' : textoContagem('representantes', from, to, total)}
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
                    recurso="representantes"
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
          <Spinner label="Carregando representantes..." />
        ) : linhas.length === 0 ? (
          <EmptyState
            icon={<Handshake className="h-6 w-6" />}
            title={recorteAtivo ? 'Nada encontrado' : textoVazio('representantes', 'Representante').titulo}
            description={
              recorteAtivo
                ? `Nenhum resultado para o recorte atual${buscaAplicada ? ` (busca: "${buscaAplicada}")` : ''}.`
                : textoVazio('representantes', 'Representante').descricao
            }
            action={
              recorteAtivo ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {buscaAplicada && (
                    <button className="btn-secondary" onClick={() => setBusca('')}>
                      Limpar busca
                    </button>
                  )}
                  {(status || usuarioId) && (
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        setStatus('');
                        setUsuarioId('');
                      }}
                    >
                      Limpar filtros
                    </button>
                  )}
                </div>
              ) : canCreate ? (
                <button className="btn-accent" onClick={() => navigate('/representantes/novo')}>
                  <Plus className="h-4 w-4" /> {rotuloNovo('representantes', 'Representante')}
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
                recurso="representantes"
                densidade={densidade}
                sort={sort}
                onSort={alternarOrdenacao}
                comFoto={false}
                rotuloLinha={rotuloDaLinha}
                renderAcoes={renderAcoes}
                onAbrirLinha={canUpdate ? (row) => navigate(`/representantes/${Number(row.id)}/editar`) : undefined}
                caption={`Representantes — página ${page}`}
              />
            ) : (
              <ListaCards
                rows={linhas}
                fields={camposCard}
                recurso="representantes"
                campoTitulo={campoTitulo('representantes')}
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
              label="Paginação de Representantes"
              contagem={contagemDe('representantes')}
            />
          </div>
        )}
      </div>

      {/* ---- Confirmação de exclusão (componente padrão do ERP) ---- */}
      <ConfirmacaoInline
        open={!!alvoExclusao}
        danger
        busy={excluindo}
        title="Excluir representante?"
        message={
          alvoExclusao ? (
            <>
              O representante <strong>“{alvoExclusao.nome}”</strong> será removido definitivamente. Esta ação não pode ser desfeita.
              {Number(alvoExclusao.uso_vinculado ?? 0) > 0 && (
                <>
                  {' '}
                  Ele aparece em {Number(alvoExclusao.uso_vinculado)} pedido(s) de venda — a exclusão será recusada e mostraremos onde ele é usado; o
                  caminho é <strong>desativar</strong>, preservando o histórico.
                </>
              )}
              {Number(alvoExclusao.uso_vinculado ?? 0) === 0 && (
                <p className="mt-2 text-slate-500">
                  Dica: se o representante já foi usado em vendas, clientes, propostas ou comissões, prefira DESATIVAR — o histórico permanece.
                </p>
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
        mensagem="Não é possível excluir este representante porque existem registros vinculados."
        // Regra do ERP: cadastro com histórico NÃO é apagado — desativa-se. O
        // diagnóstico continua somente leitura; a ação é o fluxo normal (PUT).
        acaoRecomendada={
          canUpdate && dependenciasAtivaAinda
            ? {
                rotulo: 'Desativar representante',
                descricao: 'Mantém vendas, clientes, propostas e comissões apontando para o representante.',
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
