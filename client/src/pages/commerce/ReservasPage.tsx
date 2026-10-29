// ============================================================================
// COMMERCE — RESERVAS (estoque canônico). Rota /commerce/reservas.
//
// NÃO existe um segundo motor de estoque: estes são os registros de
// `estoque_reservas` (origem de checkout/venda) com disponibilidade = física −
// reservado − empenhado − bloqueado. A tela só observa o motor canônico.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, FilterBar, type DataTableColumn } from '../../components/ui-kit-negocios';
import { dataHora } from './shared';

type Reserva = {
  id: number;
  produto_id: number;
  produto: string;
  tamanho_id: number | null;
  local_id: number | null;
  tipo: string;
  quantidade: number;
  status: string;
  origem_recurso: string | null;
  origem_id: number | null;
  motivo: string | null;
  criado_em: string | null;
  liberada_em: string | null;
};

const STATUS_FILTRO = ['', 'ativa', 'liberada', 'consumida'];
const TONE_STATUS: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  ativa: 'amber',
  liberada: 'slate',
  consumida: 'green',
};
const ROTULO_STATUS: Record<string, string> = {
  ativa: 'Ativa',
  liberada: 'Liberada',
  consumida: 'Consumida',
};

export default function CommerceReservasPage() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Reserva[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('ativa');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '100' });
      if (status) params.set('status', status);
      const r = await apiFetch<{ total: number; reservas: Reserva[] }>(`/commerce/reservas?${params.toString()}`);
      setLinhas(r.reservas);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as reservas.');
    } finally {
      setCarregando(false);
    }
  }, [status]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const colunas: DataTableColumn<Reserva>[] = [
    {
      key: 'produto',
      header: 'Produto',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.produto}</div>
          <div className="text-xs text-muted">
            #{r.produto_id}
            {r.tamanho_id != null ? ` · tamanho ${r.tamanho_id}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'quantidade', header: 'Qtd', align: 'right', render: (r) => <span className="tabular-nums">{r.quantidade}</span> },
    { key: 'tipo', header: 'Tipo', render: (r) => r.tipo },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Badge tone={TONE_STATUS[r.status] ?? 'slate'}>{ROTULO_STATUS[r.status] ?? r.status}</Badge>,
    },
    {
      key: 'origem',
      header: 'Origem',
      render: (r) => (
        <span className="text-xs text-muted">
          {r.origem_recurso ? `${r.origem_recurso}${r.origem_id != null ? ` #${r.origem_id}` : ''}` : '—'}
        </span>
      ),
    },
    { key: 'motivo', header: 'Motivo', render: (r) => <span className="text-sm">{r.motivo ?? '—'}</span> },
    { key: 'criado', header: 'Criada', render: (r) => <span className="text-sm text-muted">{dataHora(r.criado_em)}</span> },
    { key: 'liberada', header: 'Liberada', render: (r) => <span className="text-sm text-muted">{dataHora(r.liberada_em)}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reservas de estoque"
        description="Reservas do motor canônico (checkout e vendas). Disponibilidade = físico − reservado − empenhado − bloqueado; nada aqui cria um segundo estoque."
      />
      <FilterBar>
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Status</span>
          <select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTRO.map((v) => (
              <option key={v || 'todas'} value={v}>
                {v ? ROTULO_STATUS[v] ?? v : 'Todas'}
              </option>
            ))}
          </select>
        </label>
        <Badge tone="slate">{total} reserva(s)</Badge>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando reservas…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Package className="h-6 w-6" aria-hidden="true" />}
          title="Nenhuma reserva"
          description="Reservas nascem no checkout da loja e na separação de vendas."
        />
      ) : (
        <DataTable
          caption="Reservas de estoque"
          columns={colunas}
          rows={linhas}
          getRowKey={(r) => r.id}
          empty="Nenhuma reserva com este filtro."
        />
      )}
    </div>
  );
}
