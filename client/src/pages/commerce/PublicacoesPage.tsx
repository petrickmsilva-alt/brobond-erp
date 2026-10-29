// ============================================================================
// COMMERCE — FILA DE PUBLICAÇÃO. Rota /commerce/publicacoes.
//
// Histórico por canal/versão com estados, erros reais da API e retry manual.
// A escrita aqui é de gerente (recurso + módulo exigem gerente no servidor).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, Rocket } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { Badge } from '../../components/ui';
import { CANAIS_PUBLICACAO, EstadoBadge, ROTULO_PUBLICACAO, TONE_PUBLICACAO, dataHora, rotuloCanal } from './shared';
import { useAuth } from '../../auth/AuthContext';

type Publicacao = {
  id: number;
  produto_id: number;
  produto: string;
  canal: string;
  versao: number;
  estado: string;
  external_id: string | null;
  tentativas: number;
  ultimo_erro: string | null;
  proxima_tentativa_em: string | null;
  publicado_em: string | null;
  atualizado_em: string | null;
};

const ESTADOS_FILTRO = ['', 'QUEUED', 'PUBLISHED', 'ERROR', 'REJECTED', 'UNPUBLISHED'];

export default function CommercePublicacoesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Publicacao[]>([]);
  const [total, setTotal] = useState(0);
  const [estado, setEstado] = useState('');
  const [canal, setCanal] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [reprocessando, setReprocessando] = useState<number | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '100' });
      if (estado) params.set('estado', estado);
      if (canal) params.set('canal', canal);
      const r = await apiFetch<{ total: number; publicacoes: Publicacao[] }>(`/commerce/publicacoes?${params.toString()}`);
      const q = buscaAplicada.toLowerCase();
      const filtradas = q
        ? r.publicacoes.filter((p) => p.produto.toLowerCase().includes(q) || String(p.external_id ?? '').toLowerCase().includes(q))
        : r.publicacoes;
      setLinhas(filtradas);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a fila de publicação.');
    } finally {
      setCarregando(false);
    }
  }, [estado, canal, buscaAplicada]);

  useEffect(() => {
    const t = window.setTimeout(() => setBuscaAplicada(busca.trim()), 250);
    return () => window.clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const reprocessar = async (pub: Publicacao) => {
    setReprocessando(pub.id);
    setErro('');
    try {
      await apiFetch(`/commerce/publicacoes/${pub.id}/reprocessar`, { method: 'POST' });
      toast.success(`${pub.produto} · ${rotuloCanal(pub.canal)} reenfileirado.`);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao reprocessar.');
    } finally {
      setReprocessando(null);
    }
  };

  const colunas: DataTableColumn<Publicacao>[] = [
    {
      key: 'produto',
      header: 'Produto',
      render: (p) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{p.produto}</div>
          <div className="text-xs text-muted">#{p.produto_id}</div>
        </div>
      ),
    },
    { key: 'canal', header: 'Canal', render: (p) => rotuloCanal(p.canal) },
    {
      key: 'estado',
      header: 'Estado',
      render: (p) => <EstadoBadge estado={p.estado} mapa={TONE_PUBLICACAO} rotulos={ROTULO_PUBLICACAO} />,
    },
    { key: 'versao', header: 'Versão', align: 'right', render: (p) => <span className="tabular-nums">v{p.versao}</span> },
    { key: 'external', header: 'ID externo', render: (p) => <span className="font-mono text-xs">{p.external_id ?? '—'}</span> },
    {
      key: 'tentativas',
      header: 'Tentativas',
      align: 'right',
      render: (p) => (
        <span className="tabular-nums">
          {p.tentativas}
          {p.proxima_tentativa_em && p.estado === 'ERROR' && (
            <span className="ml-1 text-xs text-muted">· próxima {dataHora(p.proxima_tentativa_em)}</span>
          )}
        </span>
      ),
    },
    {
      key: 'atualizado',
      header: 'Atualizado',
      render: (p) => <span className="text-sm text-muted">{dataHora(p.atualizado_em)}</span>,
    },
    {
      key: 'erro',
      header: 'Mensagem',
      render: (p) =>
        p.ultimo_erro ? (
          <span className="line-clamp-2 max-w-md text-xs text-danger" title={p.ultimo_erro}>
            {p.ultimo_erro}
          </span>
        ) : p.estado === 'PUBLISHED' ? (
          <span className="text-xs text-success">Confirmado pelo canal</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'acoes',
      header: '',
      render: (p) => (
        <button type="button" className="btn-ghost" onClick={() => navigate(`/commerce/publicacoes/${p.id}`)}>
          Abrir
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fila de publicação"
        description="Estado por canal e versão com idempotência (empresa + produto + canal + versão). Nada é marcado como publicado sem a confirmação da API externa."
        actions={
          <button type="button" className="btn-primary" onClick={() => navigate('/commerce/publicacoes/novo')}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Nova publicação
          </button>
        }
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar por produto ou ID externo…" label="Buscar publicações" />
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Estado</span>
          <select className="input w-44" value={estado} onChange={(e) => setEstado(e.target.value)}>
            {ESTADOS_FILTRO.map((v) => (
              <option key={v || 'todos'} value={v}>
                {v ? ROTULO_PUBLICACAO[v] : 'Todos'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Canal</span>
          <select className="input w-44" value={canal} onChange={(e) => setCanal(e.target.value)}>
            <option value="">Todos</option>
            {CANAIS_PUBLICACAO.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.rotulo}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando fila…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Rocket className="h-6 w-6" aria-hidden="true" />}
          title="Fila vazia"
          description="Nenhuma publicação com este filtro. Publique um produto pelo catálogo (detalhe → Publicação por canal)."
        />
      ) : (
        <>
          <DataTable
            caption="Fila de publicação multicanal"
            columns={colunas}
            rows={linhas}
            getRowKey={(p) => p.id}
            empty="Nenhuma publicação."
          />
          <div className="flex items-center justify-between text-sm text-muted">
            <span>
              {total} publicação(ões) no histórico
              {buscaAplicada ? ` · ${linhas.length} na busca` : ''}
            </span>
            {podeGerir && (
              <button type="button" className="btn-ghost" onClick={() => void carregar()}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
              </button>
            )}
          </div>
          {linhas.some((p) => p.estado === 'ERROR' && podeGerir) && (
            <div className="flex flex-wrap gap-2">
              {linhas
                .filter((p) => p.estado === 'ERROR')
                .slice(0, 6)
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="btn-secondary"
                    disabled={reprocessando === p.id}
                    onClick={() => void reprocessar(p)}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" /> {p.produto} · {rotuloCanal(p.canal)}
                  </button>
                ))}
            </div>
          )}
        </>
      )}
      {!podeGerir && <Badge tone="slate">Somente leitura para o seu perfil</Badge>}
    </div>
  );
}
