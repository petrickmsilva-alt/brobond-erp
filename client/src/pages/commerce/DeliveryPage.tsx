// ============================================================================
// COMMERCE — DELIVERY (fila de envios + entrega). Rota /commerce/delivery.
//
// Pedidos convertidos com etapa de expedição, rastreio e SLA REAL (dias desde
// o faturamento; atraso = nada enviado há mais de 3 dias — regra em
// server/src/commerce/regras.ts). A etapa canônica continua em
// `vendas.expedicao_etapa` (Expedição do ERP); esta tela só orquestra a visão
// commerce e o rastreio.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageCheck, RefreshCw, Truck } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, EmptyState, PageHeader, Spinner, Badge } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { ROTULO_RASTREIO, TONE_RASTREIO, grana, rotuloCanal } from './shared';
import { formatMoney } from '../../lib/format';

type Linha = {
  sale_id: string;
  pedido_externo: string;
  canal: string;
  venda_id: number;
  numero: string;
  estado_entrega: string;
  expedicao_etapa: string | null;
  dias_desde_faturamento: number | null;
  atrasado: boolean;
  rastreio: { codigo: string | null; transportadora: string | null; url: string | null; status: string | null; estimativa_em: string | null } | null;
};

export default function CommerceDeliveryPage() {
  const navigate = useNavigate();
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<{ total: number; linhas: Linha[] }>('/commerce/delivery');
      setLinhas(r.linhas);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a fila de envios.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const q = busca.trim().toLowerCase();
  const filtradas = q
    ? linhas.filter(
        (l) =>
          l.pedido_externo.toLowerCase().includes(q) ||
          l.numero.toLowerCase().includes(q) ||
          String(l.rastreio?.codigo ?? '').toLowerCase().includes(q)
      )
    : linhas;

  const atrasados = linhas.filter((l) => l.atrasado).length;
  const aguardandoRastreio = linhas.filter((l) => l.expedicao_etapa === 'expedida' && !l.rastreio?.codigo).length;

  const colunas: DataTableColumn<Linha>[] = [
    {
      key: 'pedido',
      header: 'Pedido',
      render: (l) => (
        <button
          type="button"
          className="text-left font-medium text-ink hover:text-primary hover:underline"
          onClick={() => navigate(`/commerce/pedidos/${encodeURIComponent(l.sale_id)}`)}
        >
          {l.pedido_externo || `#${l.numero}`}
        </button>
      ),
    },
    { key: 'canal', header: 'Canal', render: (l) => rotuloCanal(l.canal) },
    {
      key: 'etapa',
      header: 'Etapa (Expedição)',
      render: (l) => (l.expedicao_etapa ? <Badge tone="blue">{l.expedicao_etapa}</Badge> : <span className="text-muted">—</span>),
    },
    {
      key: 'entrega',
      header: 'Entrega',
      render: (l) => (
        <Badge tone={TONE_RASTREIO[l.estado_entrega] ?? 'slate'}>{ROTULO_RASTREIO[l.estado_entrega] ?? l.estado_entrega}</Badge>
      ),
    },
    {
      key: 'prazo',
      header: 'Dias desde faturamento',
      align: 'right',
      render: (l) => (
        <span className={`tabular-nums ${l.atrasado ? 'font-semibold text-danger' : ''}`}>
          {l.dias_desde_faturamento ?? '—'}
          {l.atrasado && ' ⚠'}
        </span>
      ),
    },
    {
      key: 'rastreio',
      header: 'Rastreio',
      render: (l) =>
        l.rastreio?.codigo ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{l.rastreio.codigo}</span>
            <span className="text-xs text-muted">{l.rastreio.transportadora ?? ''}</span>
            {l.rastreio.url && (
              <a className="text-xs text-primary hover:underline" href={l.rastreio.url} target="_blank" rel="noreferrer">
                rastrear
              </a>
            )}
          </div>
        ) : (
          <span className="text-muted">sem código</span>
        ),
    },
    {
      key: 'venda',
      header: 'Venda',
      align: 'right',
      render: (l) => (
        <a className="text-primary hover:underline" href={`/vendas/${l.venda_id}`}>
          #{l.numero}
        </a>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Delivery"
        description="Pedidos comerciais convertidos em separação, expedição e entrega. Prazo contado do faturamento real — atraso significa nada enviado há mais de 3 dias."
        actions={
          <button type="button" className="btn-ghost" onClick={() => void carregar()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-muted">Na fila</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{linhas.length}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-muted">Atrasados (&gt;3 dias sem enviar)</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${atrasados ? 'text-danger' : ''}`}>{atrasados}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-muted">Expedidos sem rastreio</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${aguardandoRastreio ? 'text-warning' : ''}`}>{aguardandoRastreio}</div>
        </div>
      </div>

      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar por pedido, venda ou rastreio…" label="Buscar envios" />
      </FilterBar>

      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando fila de envios…" />
      ) : filtradas.length === 0 ? (
        <EmptyState
          icon={<PackageCheck className="h-6 w-6" aria-hidden="true" />}
          title={q ? 'Nenhum envio corresponde à busca' : 'Nenhum pedido convertido na fila'}
          description={
            q
              ? 'Ajuste a busca.'
              : 'Quando um pedido é pago e convertido em venda operacional, ele entra aqui para separação e expedição.'
          }
        />
      ) : (
        <>
          <DataTable
            caption="Fila de envios do commerce"
            columns={colunas}
            rows={filtradas}
            getRowKey={(l) => `${l.sale_id}-${l.venda_id}`}
            empty="Nenhum envio."
          />
          <p className="flex items-center gap-2 text-sm text-muted">
            <Truck className="h-4 w-4" aria-hidden="true" />
            A etapa de expedição (pendente → separação → conferência → embalagem → expedida) continua sendo lançada na
            Expedição do ERP — esta tela não duplica esse controle. Rastreio registra transportadora, código e status da
            entrega.
          </p>
        </>
      )}
    </div>
  );
}
