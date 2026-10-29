import { PaymentNavigation } from './PaymentNavigation';
import { PaymentOverview } from './PaymentOverview';
// ============================================================================
// COMMERCE — PAGAMENTOS (cobranças do gateway × pedido). Rota /commerce/pagamentos.
//
// Lê o MESMO modelo vivo do pagamento (`gateway_cobrancas` via API do commerce)
// — nada de segundo caixa. Estado projetado do pedido acompanha a cobrança; o
// webhook assinado é quem muda o mundo (a tela só observa).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, FilterBar, type DataTableColumn } from '../../components/ui-kit-negocios';
import { EstadoBadge, ROTULO_PAGAMENTO, TONE_PAGAMENTO, dataHora, grana, rotuloCanal } from './shared';

type Pagamento = {
  cobranca_id: number;
  provider: string;
  metodo: string;
  valor: number;
  status_gateway: string;
  status: string;
  criado_em: string | null;
  atualizado_em: string | null;
  pedido: { pedido_externo: string; estado: string; sale_id: string } | null;
  lancamento_id: number | null;
  venda_id: number | null;
};

const STATUS_FILTRO = ['', 'PENDING', 'AUTHORIZED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'EXPIRED'];

export default function CommercePagamentosPage() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Pagamento[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '100' });
      if (status) params.set('status', status);
      const r = await apiFetch<{ total: number; pagamentos: Pagamento[] }>(`/commerce/pagamentos?${params.toString()}`);
      setLinhas(r.pagamentos);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os pagamentos.');
    } finally {
      setCarregando(false);
    }
  }, [status]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const colunas: DataTableColumn<Pagamento>[] = [
    {
      key: 'pedido',
      header: 'Pedido',
      render: (p) =>
        p.pedido ? (
          <div className="min-w-0">
            <Link className="font-medium hover:underline" to={`/commerce/pedidos/${encodeURIComponent(p.pedido.sale_id)}`}>
              {p.pedido.pedido_externo}
            </Link>
            <div className="text-xs text-muted">
              {rotuloCanal(p.pedido.estado.replace(/_/g, ' '))} · {p.pedido.sale_id}
            </div>
          </div>
        ) : (
          <span className="text-muted">Sem pedido vinculado</span>
        ),
    },
    { key: 'provider', header: 'Provedor', render: (p) => <span className="capitalize">{p.provider}</span> },
    { key: 'metodo', header: 'Método', render: (p) => p.metodo.toUpperCase() },
    { key: 'valor', header: 'Valor', align: 'right', render: (p) => <span className="tabular-nums">{grana(p.valor)}</span> },
    {
      key: 'status',
      header: 'Estado',
      render: (p) => <EstadoBadge estado={p.status} mapa={TONE_PAGAMENTO} rotulos={ROTULO_PAGAMENTO} />,
    },
    { key: 'criado', header: 'Criado', render: (p) => <span className="text-sm text-muted">{dataHora(p.criado_em)}</span> },
    { key: 'atualizado', header: 'Atualizado', render: (p) => <span className="text-sm text-muted">{dataHora(p.atualizado_em)}</span> },
    {
      key: 'venda',
      header: 'Venda / lançamento',
      render: (p) =>
        p.venda_id ? (
          <Link className="text-sm hover:underline" to={`/vendas/${p.venda_id}`}>
            Venda #{p.venda_id}
          </Link>
        ) : (
          <span className="text-muted">{p.lancamento_id ? `Lançamento #${p.lancamento_id}` : '—'}</span>
        ),
    },
  ];

  const visiveis = status ? linhas.filter((p) => p.status === status || p.status_gateway === status.toLowerCase()) : linhas;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pagamentos"
        description="Cobranças do gateway com a projeção do pedido. O estado só muda com o webhook assinado — a tela nunca confirma pagamento."
        actions={
          <button type="button" className="btn-ghost" onClick={() => void carregar()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
          </button>
        }
      />
      <PaymentNavigation />
      <PaymentOverview />
      <FilterBar>
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Estado</span>
          <select className="input w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTRO.map((v) => (
              <option key={v || 'todos'} value={v}>
                {v ? ROTULO_PAGAMENTO[v] ?? v : 'Todos'}
              </option>
            ))}
          </select>
        </label>
        <Badge tone="slate">{total} cobrança(s)</Badge>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando pagamentos…" />
      ) : visiveis.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="h-6 w-6" aria-hidden="true" />}
          title="Nenhuma cobrança"
          description="As cobranças nascem no checkout da loja própria e nos webhooks dos canais."
        />
      ) : (
        <DataTable
          caption="Cobranças do gateway"
          columns={colunas}
          rows={visiveis}
          getRowKey={(p) => p.cobranca_id}
          empty="Nenhuma cobrança com este filtro."
        />
      )}
    </div>
  );
}
