// ============================================================================
// FUNDAÇÃO COMERCIAL — LISTA (tela principal) no padrão LISTA → PÁGINA.
//
// Atende os cadastros da evolução Master:
//   territorios · equipes_comerciais · equipe_membros · representante_hierarquia
//   representante_cliente (carteira) · metas · planos_comissao · regras_comissao
//
// É UMA página dirigida pelos METADADOS (`GET /api/meta`) — não um CRUD de
// modal: incluir e editar NAVEGAM para páginas próprias
// (`/territorios/novo`, `/territorios/:id/editar` — CadastroComercialFormPage).
//
// O que a tela entrega:
//   • busca com atraso (300 ms), filtros server-side (`f.<campo>`), ordenação
//     SERVER-SIDE (asc → desc → nenhuma), paginação e tamanho de página;
//   • estados de carregando / vazio / erro / atualizando (a lista anterior
//     permanece visível ao recarregar — sem tela piscando);
//   • exportação CSV/XLSX pela rota de export do MESMO recurso;
//   • exclusão com diagnóstico de vínculos (409 → modal) e a saída correta:
//     DESATIVAR, nunca apagar histórico;
//   • RBAC espelhado do servidor (a autoridade continua sendo a API);
//   • zero número inventado: utilização e contagens vêm do servidor.
// ============================================================================
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Pencil, Plus, Power, ShieldAlert, Trash2 } from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useMeta, type ListResult, type ResourceMeta } from '../lib/meta';
import { Alert, Badge, ConfirmDialog, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../components/ui-kit-negocios';
import { Pagination } from '../components/ui-kit';
import { DependenciasModal, type DiagnosticoDependencias } from '../components/DependenciasModal';
import { ValorCampo } from '../components/ListaValores';
import { useAuth } from '../auth/AuthContext';
import { configDaLista, contagemDe, placeholderBusca, rotuloNovo, textoContagem } from '../lib/lista';

const PAGE_SIZE = 25;
const TAMANHOS_PAGINA = [25, 50, 100];

type Linha = Record<string, any>;
type FiltroStatus = { nome: string; opcoes: { value: string; label: string }[] } | null;

/** Campo de situação do recurso: `ativo` (boolean) ou `status` (select). */
function campoStatus(r: ResourceMeta): FiltroStatus {
  const booleano = r.fields.find((x) => x.name === 'ativo' && x.type === 'boolean');
  if (booleano) {
    return {
      nome: 'ativo',
      opcoes: [{ value: 'true', label: 'Ativos' }, { value: 'false', label: 'Inativos' }],
    };
  }
  const select = r.fields.find((x) => x.name === 'status' && x.type === 'select');
  if (select) return { nome: 'status', opcoes: (select.options ?? []).map((o) => ({ value: o.value, label: o.label })) };
  return null;
}

export default function CadastroComercialPage({
  recurso,
  extraHeader,
  acoesLinha,
}: {
  recurso: string;
  /** Bloco acima da lista (ex.: árvore de territórios). */
  extraHeader?: ReactNode;
  /** Ação adicional por linha (ex.: abrir o acompanhamento da meta). */
  acoesLinha?: (row: Linha) => ReactNode;
}) {
  const toast = useToast();
  const meta = useMeta();
  const navigate = useNavigate();
  const { user } = useAuth();
  const resource = meta.resources[recurso];
  const cfg = configDaLista(recurso);

  const isOperador = user?.perfil === 'operador';
  const perfilOkEscrita = !resource?.minPerfilEscrita
    || user?.perfil === 'admin'
    || (resource.minPerfilEscrita === 'gerente' && user?.perfil === 'gerente');
  const canCreate = !!resource?.ops.create && perfilOkEscrita;
  const canUpdate = !!resource?.ops.update && perfilOkEscrita;
  const canDelete = !!resource?.ops.delete && !isOperador && perfilOkEscrita;

  const [carregando, setCarregando] = useState(true);
  const [atualizando, setAtualizando] = useState(false);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [total, setTotal] = useState(0);
  const [erro, setErro] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [filtros, setFiltros] = useState<Record<string, string>>({});
  const [ordem, setOrdem] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);

  const [alternando, setAlternando] = useState<number | null>(null);
  const [alvoExclusao, setAlvoExclusao] = useState<Linha | null>(null);
  const [excluindo, setExcluindo] = useState(false);
  const [dependencias, setDependencias] = useState<DiagnosticoDependencias | null>(null);

  // Busca com atraso: uma requisição por pausa de digitação, não por tecla.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setBuscaAplicada(busca.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [busca]);

  // Filtros que o recurso declara (os mesmos que o servidor aceita em `f.`).
  const filtrosDeclarados = useMemo(() => {
    if (!resource) return [];
    return (resource.filterFields ?? [])
      .map((nome) => resource.fields.find((f) => f.name === nome))
      .filter((f): f is NonNullable<typeof f> => !!f && f.type === 'select')
      .slice(0, 3);
  }, [resource]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    if (buscaAplicada) p.set('q', buscaAplicada);
    for (const [campo, valor] of Object.entries(filtros)) if (valor) p.set(`f.${campo}`, valor);
    if (ordem) {
      p.set('sort', ordem.field);
      p.set('dir', ordem.dir);
    }
    return p.toString();
  }, [page, pageSize, buscaAplicada, filtros, ordem]);

  const carregar = useCallback(async () => {
    setErro('');
    if (linhas.length === 0) setCarregando(true);
    else setAtualizando(true);
    try {
      const d = await api.get<ListResult<Linha>>(`/${recurso}?${params}`);
      setLinhas(d.rows);
      setTotal(d.total);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / pageSize)));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a lista.');
    } finally {
      setCarregando(false);
      setAtualizando(false);
    }
  }, [recurso, params, page, pageSize, linhas.length]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const status = resource ? campoStatus(resource) : null;

  const camposTabela = useMemo(() => {
    if (!resource) return [];
    const deLista = resource.fields.filter((f) => f.list !== false && (f.form !== false || f.virtual));
    const prioridade = cfg.prioridade ?? [];
    const ordenados = [
      ...prioridade.map((n) => deLista.find((f) => f.name === n)).filter((f): f is NonNullable<typeof f> => !!f),
      ...deLista.filter((f) => !prioridade.includes(f.name)),
    ];
    return ordenados.slice(0, 8);
  }, [resource, cfg.prioridade]);

  async function alternarStatus(row: Linha) {
    if (!resource || !status) return;
    setAlternando(Number(row.id));
    try {
      const valor = status.nome === 'ativo'
        ? !row.ativo
        : row.status === 'ativo' || row.status === 'ativa' ? 'inativo' : 'ativo';
      await api.put(`/${recurso}/${row.id}`, { [status.nome]: valor });
      toast.success('Situação atualizada.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível alterar a situação.');
    } finally {
      setAlternando(null);
    }
  }

  async function excluir() {
    if (!alvoExclusao) return;
    setExcluindo(true);
    try {
      await api.del(`/${recurso}/${alvoExclusao.id}`);
      toast.success('Registro excluído.');
      setAlvoExclusao(null);
      await carregar();
    } catch (e) {
      const err = e as ApiError;
      const detalhe = (err as any)?.details as { dependencias?: DiagnosticoDependencias } | undefined;
      if (err.status === 409 && detalhe?.dependencias) {
        setDependencias(detalhe.dependencias);
        setAlvoExclusao(null);
      } else {
        toast.error(err.message || 'Não foi possível excluir.');
      }
    } finally {
      setExcluindo(false);
    }
  }

  async function exportar(formato: 'csv' | 'xlsx') {
    try {
      await downloadFile(`/${recurso}/export?${params}&format=${formato}`, `${recurso}.${formato}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível exportar.');
    }
  }

  if (!resource) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Cadastro indisponível" description="Este recurso não está disponível para o seu perfil." />
      </div>
    );
  }

  const colunas: DataTableColumn<Linha>[] = [
    ...camposTabela.map((f) => ({
      key: f.name,
      header: cfg.rotulos[f.name] ?? f.label,
      sortKey: f.virtual ? undefined : f.name,
      align: (['money', 'number', 'integer', 'percent'].includes(f.type) ? 'right' : 'left') as 'left' | 'right',
      render: (row: Linha) => <ValorCampo f={f} row={row} recurso={recurso} />,
    })),
    {
      key: '__acoes',
      header: 'Ações',
      align: 'right',
      render: (row: Linha) => (
        <div className="flex items-center justify-end gap-1">
          {acoesLinha?.(row)}
          {canUpdate && (
            <button
              type="button"
              onClick={() => navigate(`/${recurso}/${row.id}/editar`)}
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-navy-900 dark:hover:bg-navy-800"
              title="Editar"
              aria-label={`Editar registro ${row.id}`}
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {canUpdate && status && (
            <button
              type="button"
              onClick={() => void alternarStatus(row)}
              disabled={alternando === Number(row.id)}
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-navy-900 disabled:opacity-40 dark:hover:bg-navy-800"
              title={status.nome === 'ativo' ? (row.ativo ? 'Desativar' : 'Ativar') : (row.status === 'inativo' ? 'Ativar' : 'Desativar')}
              aria-label={`Alternar situação do registro ${row.id}`}
            >
              <Power className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setAlvoExclusao(row)}
              className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
              title="Excluir"
              aria-label={`Excluir registro ${row.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  const vazio = !carregando && !erro && linhas.length === 0;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={resource.label}
        description={cfg.descricaoCadastro}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void exportar('csv')} className="btn-secondary inline-flex" title="Exportar CSV">
              <Download className="h-4 w-4" /> CSV
            </button>
            <button type="button" onClick={() => void exportar('xlsx')} className="btn-secondary inline-flex" title="Exportar Excel">
              <Download className="h-4 w-4" /> XLSX
            </button>
            {canCreate && (
              <button type="button" onClick={() => navigate(`/${recurso}/novo`)} className="btn-accent inline-flex">
                <Plus className="h-4 w-4" /> {rotuloNovo(recurso, resource.singular)}
              </button>
            )}
          </div>
        }
      />

      {resource.notice && (
        <div className="mb-4">
          <Alert tone="blue">{resource.notice}</Alert>
        </div>
      )}

      {extraHeader}

      {erro && (
        <div className="my-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      <FilterBar
        actions={
          <div className="flex items-center gap-2">
            {atualizando && <span className="text-xs text-muted">Atualizando…</span>}
            {total > 0 && (
              <Badge tone="slate">
                {textoContagem(recurso, (page - 1) * pageSize + 1, Math.min(page * pageSize, total), total)}
              </Badge>
            )}
          </div>
        }
      >
        <SearchInput
          value={busca}
          onChange={setBusca}
          placeholder={placeholderBusca(recurso, resource.label)}
          label={`Buscar em ${resource.label}`}
        />
        {status && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            <span>{resource.fields.find((f) => f.name === status.nome)?.label ?? 'Situação'}</span>
            <select
              className="input !w-auto"
              value={filtros[status.nome] ?? ''}
              onChange={(e) => {
                setFiltros((atual) => ({ ...atual, [status.nome]: e.target.value }));
                setPage(1);
              }}
            >
              <option value="">Todos</option>
              {status.opcoes.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        {filtrosDeclarados
          .filter((f) => f.name !== status?.nome)
          .map((f) => (
            <label key={f.name} className="flex flex-col gap-1 text-xs text-muted">
              <span>{f.label}</span>
              <select
                className="input !w-auto"
                value={filtros[f.name] ?? ''}
                onChange={(e) => {
                  setFiltros((atual) => ({ ...atual, [f.name]: e.target.value }));
                  setPage(1);
                }}
              >
                <option value="">Todos</option>
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          ))}
        {Object.values(filtros).some(Boolean) && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setFiltros({});
              setPage(1);
            }}
          >
            Limpar filtros
          </button>
        )}
      </FilterBar>

      <div className="card mt-4 overflow-hidden">
        {carregando ? (
          <Spinner label={`Carregando ${resource.label.toLowerCase()}...`} />
        ) : vazio ? (
          <EmptyState
            icon={<ShieldAlert className="h-6 w-6" />}
            title={cfg.vazioTitulo ?? `Nenhum ${resource.singular.toLowerCase()} cadastrado`}
            description={cfg.vazioDescricao ?? 'Cadastre o primeiro registro para começar.'}
            action={canCreate ? (
              <button type="button" className="btn-accent inline-flex" onClick={() => navigate(`/${recurso}/novo`)}>
                <Plus className="h-4 w-4" /> {rotuloNovo(recurso, resource.singular)}
              </button>
            ) : undefined}
          />
        ) : (
          <div className={`transition-opacity ${atualizando ? 'opacity-60' : ''}`}>
            <DataTable
              columns={colunas}
              rows={linhas}
              caption={`${resource.label} — página ${page}`}
              empty={`Nenhum ${resource.singular.toLowerCase()} cadastrado.`}
              getRowKey={(row) => Number(row.id)}
              sort={ordem}
              onSort={(campo) => {
                setPage(1);
                setOrdem((atual) => {
                  if (!atual || atual.field !== campo) return { field: campo, dir: 'asc' };
                  if (atual.dir === 'asc') return { field: campo, dir: 'desc' };
                  return null;
                });
              }}
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
              label={`Paginação de ${resource.label}`}
              contagem={contagemDe(recurso)}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!alvoExclusao}
        danger
        busy={excluindo}
        title="Excluir registro?"
        message="Se houver histórico vinculado, a exclusão será recusada com o diagnóstico de vínculos — a saída correta é DESATIVAR, preservando o histórico."
        confirmLabel="Excluir"
        onConfirm={() => void excluir()}
        onCancel={() => setAlvoExclusao(null)}
      />

      <DependenciasModal
        diag={dependencias}
        onClose={() => setDependencias(null)}
        mensagem={cfg.mensagemVinculos}
      />
    </div>
  );
}
