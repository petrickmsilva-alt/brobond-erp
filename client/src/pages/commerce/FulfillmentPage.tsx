// ============================================================================
// COMMERCE — FULFILLMENT (separação → expedição → rastreio dos convertidos).
// Rota /commerce/fulfillment.
//
// Usa o pedido/venda/estoque EXISTENTES do ERP: a conversão sales → vendas já
// aconteceu; aqui só se acompanha a etapa de expedição e o rastreio — sem
// duplicar a Expedição canônica.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, type DataTableColumn } from '../../components/ui-kit-negocios';
import { ROTULO_RASTREIO, TONE_RASTREIO, dataHora, rotuloCanal } from './shared';

type Linha = {
  sale_id: string;
  pedido_externo: string;
  canal: string;
  venda_id: number;
  numero: string;
  comprador: string | null;
  status_venda: string | null;
  faturada_em: string | null;
  expedicao_etapa: string | null;
  rastreio: { codigo: string | null; status: string | null; transportadora: string | null } | null;
  convertido_em: string | null;
};

const ETAPAS: Record<string, string> = {
  separacao: 'Separação',
  conferencia: 'Conferência',
  separada: 'Separada',
  expedida: 'Expedida',
};

export default function CommerceFulfillmentPage() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [total, setTotal] = useState(0);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<{ total: number; linhas: Linha[] }>('/commerce/fulfillment');
      setLinhas(r.linhas);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o fulfillment.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const colunas: DataTableColumn<Linha>[] = [
    {
      key: 'pedido',
      header: 'Pedido',
      render: (l) => (
        <div className="min-w-0">
          <Link className="font-medium hover:underline" to={`/commerce/pedidos/${encodeURIComponent(l.sale_id)}`}>
            {l.pedido_externo}
          </Link>
          <div className="text-xs text-muted">{rotuloCanal(l.canal)}</div>
        </div>
      ),
    },
    {
      key: 'venda',
      header: 'Venda ERP',
      render: (l) => (
        <Link className="hover:underline" to={`/vendas/${l.venda_id}`}>
          {l.numero}
        </Link>
      ),
    },
    { key: 'comprador', header: 'Comprador', render: (l) => <span className="text-sm">{l.comprador ?? '—'}</span> },
    { key: 'status_venda', header: 'Status venda', render: (l) => <Badge tone="blue">{l.status_venda ?? '—'}</Badge> },
    {
      key: 'etapa',
      header: 'Etapa',
      render: (l) => <Badge tone={l.expedicao_etapa === 'expedida' ? 'green' : 'amber'}>{ETAPAS[l.expedicao_etapa ?? ''] ?? l.expedicao_etapa ?? '—'}</Badge>,
    },
    {
      key: 'rastreio',
      header: 'Rastreio',
      render: (l) =>
        l.rastreio ? (
          <div className="text-xs">
            <span className="font-mono">{l.rastreio.codigo ?? '—'}</span>
            {l.rastreio.status && (
              <span
                className={`ml-2 ${
                  TONE_RASTREIO[l.rastreio.status] === 'green'
                    ? 'text-success'
                    : TONE_RASTREIO[l.rastreio.status] === 'red'
                      ? 'text-danger'
                      : 'text-muted'
                }`}
              >
                {ROTULO_RASTREIO[l.rastreio.status] ?? l.rastreio.status}
              </span>
            )}
            <div className="text-muted">{l.rastreio.transportadora ?? ''}</div>
          </div>
        ) : (
          <span className="text-muted">Sem rastreio</span>
        ),
    },
    { key: 'faturada', header: 'Faturada', render: (l) => <span className="text-sm text-muted">{dataHora(l.faturada_em)}</span> },
    { key: 'convertido', header: 'Convertido', render: (l) => <span className="text-sm text-muted">{dataHora(l.convertido_em)}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fulfillment"
        description="Pedidos convertidos em venda ERP: separação, expedição e rastreio — a mesma verdade da Expedição canônica, vista pelo canal commerce."
      />
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando fulfillment…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Truck className="h-6 w-6" aria-hidden="true" />}
          title="Nenhum pedido convertido"
          description="O fulfillment aparece depois que o pedido pago vira venda no ERP."
        />
      ) : (
        <>
          <DataTable
            caption="Pedidos convertidos em fulfillment"
            columns={colunas}
            rows={linhas}
            getRowKey={(l) => `${l.sale_id}-${l.venda_id}`}
            empty="Nenhum pedido convertido."
          />
          <p className="text-sm text-muted">{total} pedido(s) convertido(s).</p>
        </>
      )}
    </div>
  );
}
