// ============================================================================
// CADASTRO DE COLEÇÕES — LISTA + DRAWER LATERAL (padrão dos cadastros simples).
//
// Substitui a caixa modal central por uma experiência profissional: a LISTA
// permanece à vista e o formulário abre num DRAWER lateral — o usuário nunca
// perde o contexto da listagem. É o padrão que os demais cadastros simples
// (cores, tamanhos, grades) passam a seguir.
//
// NÃO inventa campos nem endpoints: usa o contrato existente do recurso
// `colecoes` (nome, temporada, ano, ativo) em GET/POST/PUT/DELETE /api/colecoes.
// O servidor revalida tudo (validatePayload + checkAccess); o front só evita a
// ida e volta com validação local e mensagens por campo.
//
// Utilização em produtos: o servidor anota `produtos_vinculados` na listagem
// com UMA consulta agregada (nunca N+1) — a tela apenas exibe o número real.
//
// Exclusão: se a coleção estiver em uso, o DELETE responde 409 com o
// diagnóstico de dependências e a tela abre o "Ver vínculos" (o mesmo mecanismo
// dos demais módulos). A saída é DESATIVAR: o histórico (produtos) permanece.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Layers, Loader2, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Field, type ListResult } from '../lib/meta';
import { Alert, Badge, ConfirmDialog, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { DataTable, Drawer, FilterBar, SearchInput, type DataTableColumn } from '../components/ui-kit-negocios';
import { Dropdown, Pagination, Switch } from '../components/ui-kit';
import { DependenciasModal, type DiagnosticoDependencias } from '../components/DependenciasModal';
import { useAuth } from '../auth/AuthContext';

type Colecao = {
  id: number;
  nome: string | null;
  temporada: string | null;
  ano: number | null;
  ativo?: boolean;
  produtos_vinculados?: number;
  atualizado_em?: string | null;
  criado_em?: string | null;
};

type Valores = { nome: string; temporada: string; ano: string; ativo: boolean };

const VALORES_INICIAIS: Valores = { nome: '', temporada: '', ano: '', ativo: true };

const PAGE_SIZE = 25;
const TAMANHOS_PAGINA = [25, 50, 100];

type FiltroStatus = '' | 'true' | 'false';

/** Linha da API → valores do formulário. */
function valoresDaLinha(row: Colecao): Valores {
  return {
    nome: String(row.nome ?? ''),
    temporada: row.temporada == null ? '' : String(row.temporada),
    ano: row.ano == null || row.ano === undefined ? '' : String(row.ano),
    ativo: row.ativo !== false,
  };
}

/** "1 produto" / "N produtos" — só com a contagem REAL do servidor. */
function textoUtilizacao(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  return n === 1 ? '1 produto' : `${n} produtos`;
}

export default function ColecoesPage() {
  const toast = useToast();
  const meta = useMeta();
  const { user } = useAuth();
  const resource = meta.resources['colecoes'];

  // RBAC: espelha o servidor (checkAccess). A autoridade real é a API — aqui só
  // evitamos exibir um botão que receberia 403. Coleções são cadastro POR
  // EMPRESA: não há `minPerfilEscrita` (isso é do catálogo GLOBAL).
  const isOperador = user?.perfil === 'operador';
  const perfilOkEscrita = !resource?.minPerfilEscrita
    || user?.perfil === 'admin'
    || (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const canCreate = !!resource?.ops.create && perfilOkEscrita;
  const canUpdate = !!resource?.ops.update && perfilOkEscrita;
  const canDelete = !!resource?.ops.delete && !isOperador && perfilOkEscrita;

  const [carregando, setCarregando] = useState(true);
  const [linhas, setLinhas] = useState<Colecao[]>([]);
  const [total, setTotal] = useState(0);
  const [erro, setErro] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [status, setStatus] = useState<FiltroStatus>('');

  const [drawerAberto, setDrawerAberto] = useState(false);
  const [editando, setEditando] = useState<Colecao | null>(null);
  const [valores, setValores] = useState<Valores>(VALORES_INICIAIS);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erroForm, setErroForm] = useState('');
  const [salvando, setSalvando] = useState(false);
  const erroResumoRef = useRef<HTMLDivElement>(null);

  const [alternandoAtivo, setAlternandoAtivo] = useState<number | null>(null);
  const [alvoExclusao, setAlvoExclusao] = useState<Colecao | null>(null);
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

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    if (buscaAplicada) p.set('q', buscaAplicada);
    if (status) p.set('f.ativo', status);
    return p.toString();
  }, [page, pageSize, buscaAplicada, status]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<Colecao>>(`/colecoes?${params}`);
      setLinhas(d.rows);
      setTotal(d.total);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / pageSize)));
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as coleções.');
    } finally {
      setCarregando(false);
    }
  }, [params, page, pageSize]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const recorteAtivo = buscaAplicada !== '' || status !== '';

  // ---- Drawer: novo / editar ----
  function abrirNova() {
    setEditando(null);
    setValores(VALORES_INICIAIS);
    setErros({});
    setErroForm('');
    setDrawerAberto(true);
  }

  function abrirEdicao(row: Colecao) {
    setEditando(row);
    setValores(valoresDaLinha(row));
    setErros({});
    setErroForm('');
    setDrawerAberto(true);
  }

  function fecharDrawer() {
    if (salvando) return;
    setDrawerAberto(false);
  }

  const setCampo = useCallback((nome: keyof Valores, valor: string | boolean) => {
    setValores((v) => ({ ...v, [nome]: valor }));
    setErros((e) => (e[nome] ? { ...e, [nome]: '' } : e));
    setErroForm('');
  }, []);

  /** Validação local espelhando o servidor — erro junto do campo, na hora. */
  function validar(): Record<string, string> {
    const errs: Record<string, string> = {};
    const nome = valores.nome.trim();
    const maxNome = resource?.fields.find((f) => f.name === 'nome')?.maxLength ?? 80;
    if (!nome) errs.nome = 'Informe o nome da coleção.';
    else if (nome.length > maxNome) errs.nome = `Máximo de ${maxNome} caracteres.`;
    if (valores.ano.trim() !== '') {
      const ano = Number(valores.ano);
      if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) errs.ano = 'Informe um ano entre 2000 e 2100.';
    }
    return errs;
  }

  /** Payload no contrato do recurso: texto/select texto, ano inteiro, ativo booleano. */
  function montarPayload(): Record<string, unknown> {
    return {
      nome: valores.nome.trim(),
      temporada: valores.temporada.trim() === '' ? null : valores.temporada.trim(),
      ano: valores.ano.trim() === '' ? null : Number(valores.ano),
      ativo: valores.ativo,
    };
  }

  async function salvar() {
    if (salvando) return;
    setErroForm('');
    const errs = validar();
    setErros(errs);
    if (Object.keys(errs).length) {
      setErroForm('Verifique os campos destacados — nada foi salvo e o que você digitou foi mantido.');
      requestAnimationFrame(() => {
        erroResumoRef.current?.focus();
        document.getElementById(`col-${Object.keys(errs)[0]}`)?.focus();
      });
      return;
    }
    setSalvando(true);
    try {
      const payload = montarPayload();
      if (editando) {
        await api.put(`/colecoes/${editando.id}`, payload);
        toast.success('Coleção salva com sucesso.');
      } else {
        await api.post('/colecoes', payload);
        toast.success('Coleção cadastrada com sucesso.');
      }
      setDrawerAberto(false);
      await carregar();
    } catch (e) {
      const fe = e instanceof ApiError && e.fields ? e.fields : {};
      setErros(fe);
      setErroForm(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
      requestAnimationFrame(() => erroResumoRef.current?.focus());
    } finally {
      setSalvando(false);
    }
  }

  // ---- Ativar / Desativar na linha ----
  async function alternarAtivo(row: Colecao, forcar?: boolean) {
    const id = Number(row.id);
    if (alternandoAtivo !== null) return;
    const novo = forcar ?? row.ativo === false;
    setAlternandoAtivo(id);
    try {
      await api.put(`/colecoes/${id}`, { ativo: novo });
      toast.success(`“${row.nome}”: status alterado para ${novo ? 'Ativa' : 'Inativa'}.`);
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
      await api.del(`/colecoes/${alvoExclusao.id}`);
      toast.success('Coleção excluída.');
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

  /** Do diagnóstico de vínculos, desativa a coleção em uso (preserva o histórico). */
  async function desativarDoDiagnostico() {
    if (!dependencias) return;
    const id = dependencias.id;
    setDependencias(null);
    try {
      await api.put(`/colecoes/${id}`, { ativo: false });
      toast.success('Coleção desativada. Os produtos vinculados continuam apontando para ela.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível desativar a coleção.');
    }
  }

  const statusFiltro: { value: string; label: string }[] = [
    { value: 'true', label: 'Ativas' },
    { value: 'false', label: 'Inativas' },
  ];

  const colunas: DataTableColumn<Colecao>[] = [
    {
      key: 'nome',
      header: 'Coleção',
      render: (row) => (
        <span className="inline-flex items-center gap-2 font-semibold text-navy-900 dark:text-white">
          <Layers className="h-4 w-4 shrink-0 text-navy-300" aria-hidden="true" />
          {row.nome || '—'}
        </span>
      ),
    },
    {
      key: 'temporada',
      header: 'Temporada',
      render: (row) => <span className="text-slate-600 dark:text-navy-200">{row.temporada || '—'}</span>,
    },
    {
      key: 'ano',
      header: 'Ano',
      render: (row) => <span className="tabular-nums text-slate-600 dark:text-navy-200">{row.ano ?? '—'}</span>,
    },
    {
      key: 'ativo',
      header: 'Status',
      render: (row) =>
        row.ativo === false ? (
          <Badge tone="slate">● Inativa</Badge>
        ) : (
          <Badge tone="green">● Ativa</Badge>
        ),
    },
    {
      key: 'utilizacao',
      header: 'Utilização',
      render: (row) => {
        const n = row.produtos_vinculados;
        if (!n) return <span className="text-slate-300" title="Nenhum produto vinculado a esta coleção">—</span>;
        return <span className="text-slate-600 dark:text-navy-200">{textoUtilizacao(n)}</span>;
      },
    },
    {
      key: 'acoes',
      header: 'Ações',
      align: 'right',
      render: (row) => {
        const itens = [
          canUpdate && { id: 'editar', label: 'Editar', icon: <Pencil className="h-4 w-4" />, onSelect: () => abrirEdicao(row) },
          canUpdate && {
            id: 'status',
            label: row.ativo === false ? 'Ativar' : 'Desativar',
            icon: <Power className="h-4 w-4" />,
            disabled: alternandoAtivo === Number(row.id),
            onSelect: () => void alternarAtivo(row),
          },
          canDelete && { id: 'excluir', label: 'Excluir', icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: () => setAlvoExclusao(row) },
        ].filter(Boolean) as { id: string; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void }[];
        if (!itens.length) return <span className="text-slate-300">—</span>;
        return (
          <div className="flex justify-end">
            <Dropdown
              trigger={<span className="sr-only">Ações da coleção {row.nome}</span>}
              label={`Ações da coleção ${row.nome}`}
              items={itens}
            />
          </div>
        );
      },
    },
  ];

  const tituloDrawer = editando ? 'Editar coleção' : 'Nova coleção';
  const descricaoDrawer = editando
    ? `Alterando a coleção “${String(editando.nome ?? '')}”.`
    : 'Cadastre uma coleção para organizar os produtos do catálogo.';
  const maxNome = resource?.fields.find((f) => f.name === 'nome')?.maxLength ?? 80;
  const campoNome = resource?.fields.find((f) => f.name === 'nome') as Field | undefined;
  const campoTemporada = resource?.fields.find((f) => f.name === 'temporada') as Field | undefined;
  const campoAno = resource?.fields.find((f) => f.name === 'ano') as Field | undefined;
  const alvoEmUso = !!alvoExclusao && Number(alvoExclusao.produtos_vinculados ?? 0) > 0;
  const dependenciasAtivaAinda = !!dependencias && linhas.some((l) => Number(l.id) === Number(dependencias.id) && l.ativo !== false);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Coleções"
        description="Gerencie as coleções e temporadas utilizadas no catálogo."
        actions={
          canCreate ? (
            <button className="btn-accent inline-flex" onClick={abrirNova}>
              <Plus className="h-4 w-4" /> Nova coleção
            </button>
          ) : undefined
        }
      />

      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar coleção..." label="Buscar coleção" />
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-navy-200">
          <span className="sr-only">Filtrar por status</span>
          <select
            className="input !w-auto"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as FiltroStatus);
              setPage(1);
            }}
            aria-label="Filtrar por status"
          >
            <option value="">Todas</option>
            {statusFiltro.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {erro && (
        <div className="mt-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      <div className="card mt-4 overflow-hidden">
        {carregando && linhas.length === 0 ? (
          <Spinner label="Carregando coleções..." />
        ) : linhas.length === 0 ? (
          <EmptyState
            icon={<Layers className="h-6 w-6" />}
            title={recorteAtivo ? 'Nada encontrado' : 'Nenhuma coleção cadastrada'}
            description={
              recorteAtivo
                ? `Nenhum resultado para o recorte atual${buscaAplicada ? ` (busca: "${buscaAplicada}")` : ''}.`
                : 'Cadastre sua primeira coleção para organizar os produtos do catálogo.'
            }
            action={
              recorteAtivo ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {buscaAplicada && (
                    <button className="btn-secondary" onClick={() => setBusca('')}>
                      Limpar busca
                    </button>
                  )}
                  {status && (
                    <button className="btn-secondary" onClick={() => setStatus('')}>
                      Limpar filtros
                    </button>
                  )}
                </div>
              ) : canCreate ? (
                <button className="btn-accent" onClick={abrirNova}>
                  <Plus className="h-4 w-4" /> Nova coleção
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className={`transition-opacity ${carregando ? 'opacity-60' : ''}`}>
            <DataTable
              columns={colunas}
              rows={linhas}
              caption={`Coleções — página ${page}`}
              empty="Nenhuma coleção cadastrada."
              getRowKey={(row) => row.id}
            />
          </div>
        )}

        {total > 0 && (
          <div className="border-t border-line px-4 py-3">
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
              label="Paginação de Coleções"
              contagem={{ singular: 'coleção', plural: 'coleções' }}
            />
          </div>
        )}
      </div>

      {/* ---- Drawer: Nova coleção / Editar coleção ---- */}
      <Drawer
        open={drawerAberto}
        onClose={fecharDrawer}
        title={tituloDrawer}
        description={descricaoDrawer}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={fecharDrawer} disabled={salvando}>
              Cancelar
            </button>
            <button type="submit" form="form-colecao" className="btn-accent" disabled={salvando || !(editando ? canUpdate : canCreate)}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Salvar coleção
            </button>
          </>
        }
      >
        {erroForm && (
          <div ref={erroResumoRef} tabIndex={-1} className="mb-4 outline-none" role="alert" aria-live="assertive">
            <Alert tone="red">{erroForm}</Alert>
          </div>
        )}
        <form
          id="form-colecao"
          aria-label={tituloDrawer}
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void salvar();
          }}
        >
          {/* Nome (obrigatório) */}
          <div>
            <label htmlFor="col-nome" className="label">
              Nome <span className="text-red-500" aria-hidden="true">*</span>
              <span className="sr-only"> (obrigatório)</span>
            </label>
            <input
              id="col-nome"
              type="text"
              className={`input ${erros.nome ? 'input-error' : ''}`}
              value={valores.nome}
              onChange={(e) => setCampo('nome', e.target.value)}
              maxLength={maxNome}
              placeholder={campoNome?.placeholder ?? 'Verão 2027, Coleção Premium...'}
              autoComplete="off"
              autoFocus
              disabled={salvando}
              aria-invalid={erros.nome ? true : undefined}
              aria-describedby={erros.nome ? 'col-nome-erro' : undefined}
              required
            />
            {erros.nome ? (
              <p id="col-nome-erro" className="mt-1 text-xs font-medium text-red-600" role="alert">
                {erros.nome}
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-400">Como a coleção aparece no catálogo. Ex.: Verão 2027.</p>
            )}
          </div>

          {/* Temporada (select com opções reais do recurso) */}
          <div>
            <label htmlFor="col-temporada" className="label">
              Temporada
            </label>
            <select
              id="col-temporada"
              className="input"
              value={valores.temporada}
              onChange={(e) => setCampo('temporada', e.target.value)}
              disabled={salvando}
            >
              <option value="">— Nenhuma —</option>
              {(campoTemporada?.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">Opcional. Agrupa a coleção por estação do ano.</p>
          </div>

          {/* Ano (integer, faixa do recurso) */}
          <div>
            <label htmlFor="col-ano" className="label">
              Ano
            </label>
            <input
              id="col-ano"
              type="number"
              inputMode="numeric"
              className={`input ${erros.ano ? 'input-error' : ''}`}
              value={valores.ano}
              onChange={(e) => setCampo('ano', e.target.value)}
              min={campoAno?.min ?? 2000}
              max={campoAno?.max ?? 2100}
              placeholder="2027"
              disabled={salvando}
              aria-invalid={erros.ano ? true : undefined}
              aria-describedby={erros.ano ? 'col-ano-erro' : undefined}
            />
            {erros.ano ? (
              <p id="col-ano-erro" className="mt-1 text-xs font-medium text-red-600" role="alert">
                {erros.ano}
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-400">Opcional. Usado para ordenar as coleções por recência.</p>
            )}
          </div>

          {/* Ativo (Switch do design system) */}
          <div className="border-t border-slate-100 pt-4 dark:border-navy-800">
            <Switch
              id="col-ativo"
              checked={valores.ativo}
              onChange={(v) => setCampo('ativo', v)}
              disabled={salvando}
              label="Ativa"
              description="Coleções inativas não aparecem nos seletores de novos produtos; os produtos que já a usam continuam vinculados."
            />
          </div>
        </form>
      </Drawer>

      {/* ---- Confirmação de exclusão (componente padrão do ERP) ---- */}
      <ConfirmDialog
        open={!!alvoExclusao}
        danger
        busy={excluindo}
        title="Excluir coleção?"
        message={
          alvoExclusao ? (
            alvoEmUso ? (
              <>
                <strong>“{alvoExclusao.nome}”</strong> está vinculada a {textoUtilizacao(alvoExclusao.produtos_vinculados)}. A exclusão será recusada e
                mostraremos onde ela é usada — o caminho é <strong>desativar</strong>, preservando o histórico.
              </>
            ) : (
              <>
                A coleção <strong>“{alvoExclusao.nome}”</strong> será removida definitivamente. Esta ação não pode ser desfeita.
              </>
            )
          ) : (
            ''
          )
        }
        confirmLabel={alvoEmUso ? 'Tentar excluir' : 'Excluir'}
        onConfirm={() => void excluir()}
        onCancel={() => setAlvoExclusao(null)}
      />

      {/* ---- Diagnóstico de dependências (mesmo mecanismo dos demais módulos) ---- */}
      <DependenciasModal
        diag={dependencias}
        onClose={() => setDependencias(null)}
        mensagem="Não é possível excluir esta coleção porque existem produtos vinculados."
        // Regra do ERP: cadastro com histórico NÃO é apagado — desativa-se. O
        // diagnóstico continua somente leitura; a ação é o fluxo normal (PUT).
        acaoRecomendada={
          canUpdate && dependenciasAtivaAinda
            ? {
                rotulo: 'Desativar coleção',
                descricao: 'Mantém os produtos vinculados e tira a coleção das listas de seleção.',
                onClick: () => void desativarDoDiagnostico(),
              }
            : undefined
        }
      />
    </div>
  );
}
