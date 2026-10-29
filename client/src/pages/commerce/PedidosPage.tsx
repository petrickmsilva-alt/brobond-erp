// ============================================================================
// COMMERCE — INBOX DE PEDIDOS OMNICHANNEL. Rota /commerce/pedidos.
//
// Uma linha por `sale` (verdade analítica) enriquecida com a projeção do
// pedido e a venda operacional. Filtros por canal/estado são resolvidos no
// servidor; o estado exibido deriva de sales + commerce_pedidos + vendas.
// Detalhe, conversão manual e cancelamento em /commerce/pedidos/:saleId.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Inbox, RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { Badge } from '../../components/ui';
import {
  CANAIS_PEDIDO,
  EstadoBadge,
  ROTULO_PEDIDO,
  ROTULO_RASTREIO,
  TONE_PEDIDO,
  TONE_RASTREIO,
  dataHora,
  grana,
  rotuloCanal,
} from './shared';

type Linha = {
  sale_id: string;
  pedido_id: number | null;
  canal: string;
  pedido_externo: string;
  ocorrida_em: string;
  status_venda: string;
  estado: string;
  estado_rotulo: string;
  pagamento: string | null;
  total: number;
  comprador: { nome: string | null; email: string | null };
  venda_id: number | null;
  convertido_em: string | null;
  expedicao: string | null;
  rastreio: { codigo: string | null; status: string | null } | null;
  expira_em: string | null;
};

const ESTADOS_FILTRO = [
  '',
  'AGUARDANDO_PAGAMENTO',
  'PAGO',
  'AGUARDANDO_CORRECAO',
  'CONVERTIDO',
  'CANCELADO',
  'EXPIRADO',
  'ESTORNADO',
];

export default function CommercePedidosPage() {
  const navigate = useNavigate();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [total, setTotal] = useState(0);
  const [canal, setCanal] = useState('');
  const [estado, setEstado] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '200' });
      if (canal) params.set('canal', canal);
      if (buscaAplicada) params.set('q', buscaAplicada);
      const r = await apiFetch<{ total: number; pedidos: Linha[] }>(`/commerce/pedidos?${params.toString()}`);
      const filtradas = estado ? r.pedidos.filter((p) => p.estado === estado) : r.pedidos;
      setLinhas(filtradas);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os pedidos.');
    } finally {
      setCarregando(false);
    }
  }, [canal, estado, buscaAplicada]);

  useEffect(() => {
    const t = window.setTimeout(() => setBuscaAplicada(busca.trim()), 250);
    return () => window.clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const colunas: DataTableColumn<Linha>[] = [
    {
      key: 'pedido',
      header: 'Pedido',
      render: (p) => (
        <button
          type="button"
          className="block text-left font-medium text-ink hover:text-primary hover:underline"
          onClick={() => navigate(`/commerce/pedidos/${encodeURIComponent(p.sale_id)}`)}
        >
          {p.pedido_externo || p.sale_id.slice(0, 12)}
        </button>
      ),
    },
    { key: 'canal', header: 'Canal', render: (p) => rotuloCanal(p.canal) },
    {
      key: 'estado',
      header: 'Estado',
      render: (p) => <EstadoBadge estado={p.estado} mapa={TONE_PEDIDO} rotulos={ROTULO_PEDIDO} />,
    },
    {
      key: 'comprador',
      header: 'Comprador',
      render: (p) => (
        <div className="min-w-0">
          <div className="truncate">{p.comprador.nome ?? '—'}</div>
          <div className="truncate text-xs text-muted">{p.comprador.email ?? ''}</div>
        </div>
      ),
    },
    { key: 'total', header: 'Total', align: 'right', render: (p) => <span className="tabular-nums">{grana(p.total)}</span> },
    { key: 'ocorrida', header: 'Recebido em', render: (p) => <span className="text-sm text-muted">{dataHora(p.ocorrida_em)}</span> },
    {
      key: 'fulfillment',
      header: 'Expedição',
      render: (p) => (
        <div className="flex flex-wrap items-center gap-1">
          {p.expedicao ? <Badge tone="blue">{p.expedicao}</Badge> : p.venda_id ? <Badge tone="slate">sem etapa</Badge> : <span className="text-muted">—</span>}
          {p.rastreio?.status && (
            <Badge tone={TONE_RASTREIO[p.rastreio.status] ?? 'slate'}>{ROTULO_RASTREIO[p.rastreio.status] ?? p.rastreio.status}</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'vencimento',
      header: 'Pagamento expira',
      render: (p) =>
        ['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO'].includes(p.estado) && p.expira_em ? (
          <span className="text-sm text-warning">{dataHora(p.expira_em)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pedidos omnichannel"
        description="Caixa única da loja própria e dos canais conectados. O estado combina a venda analítica (sales), a projeção do pedido e a venda operacional."
        actions={
          <>
            <Link className="btn-ghost" to="/commerce/pagamentos">
              Pagamentos
            </Link>
            <Link className="btn-ghost" to="/commerce/reservas">
              Reservas
            </Link>
            <Link className="btn-ghost" to="/commerce/fulfillment">
              Fulfillment
            </Link>
            <Link className="btn-ghost" to="/commerce/devolucoes">
              Devoluções
            </Link>
            <button type="button" className="btn-ghost" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
          </>
        }
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar por pedido ou comprador…" label="Buscar pedidos" />
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Canal</span>
          <select className="input w-44" value={canal} onChange={(e) => setCanal(e.target.value)}>
            <option value="">Todos</option>
            {CANAIS_PEDIDO.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.rotulo}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Estado</span>
          <select className="input w-48" value={estado} onChange={(e) => setEstado(e.target.value)}>
            <option value="">Todos</option>
            {ESTADOS_FILTRO.filter(Boolean).map((v) => (
              <option key={v} value={v}>
                {ROTULO_PEDIDO[v]}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando pedidos…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
          title={buscaAplicada || estado || canal ? 'Nenhum pedido com estes filtros' : 'Nenhum pedido ainda'}
          description={
            buscaAplicada || estado || canal
              ? 'Ajuste os filtros para ver outros pedidos.'
              : 'Pedidos da loja própria (/loja) e dos canais conectados aparecem aqui assim que chegarem.'
          }
        />
      ) : (
        <>
          <DataTable
            caption="Pedidos omnichannel"
            columns={colunas}
            rows={linhas}
            getRowKey={(p) => p.sale_id}
            empty="Nenhum pedido nesta página."
          />
          <div className="text-sm text-muted">
            {total} pedido(s) no período consultado · {linhas.length} exibido(s)
            {estado ? ' · filtro de estado aplicado na página atual' : ''}
          </div>
        </>
      )}
    </div>
  );
}
