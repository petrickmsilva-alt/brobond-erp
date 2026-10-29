// ============================================================================
// COMMERCE — DEVOLUÇÕES (vínculo operacional com a venda ERP).
// Rota /commerce/devolucoes.
//
// As devoluções NÃO são reimplementadas aqui: a fonte canônica é o recurso
// `devolucoes` do ERP (mesma venda, mesmo estoque, mesmo financeiro). Esta tela
// só lista o que existe no ERP e navega para a venda/original — nenhum segundo
// financeiro é criado pelo commerce.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Repeat } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { dataHora } from './shared';

type Devolucao = {
  id: number;
  numero?: string | null;
  venda_id: number | null;
  cliente_id: number | null;
  status: string;
  tipo?: string;
  motivo?: string | null;
  criado_em?: string | null;
  atualizado_em?: string | null;
};

const TONE_STATUS: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  solicitada: 'blue',
  autorizada: 'amber',
  em_transito: 'amber',
  recebida: 'green',
  recusada: 'red',
};
const ROTULO_STATUS: Record<string, string> = {
  solicitada: 'Solicitada',
  autorizada: 'Autorizada',
  em_transito: 'Em trânsito',
  recebida: 'Recebida',
  recusada: 'Recusada',
};
const STATUS_FILTRO = ['', 'solicitada', 'autorizada', 'em_transito', 'recebida', 'recusada'];

export default function CommerceDevolucoesPage() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Devolucao[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '100', sort: 'id', dir: 'desc' });
      // Rota genérica GET /api/:resource filtra por `?f.<coluna>=valor`
      // (server/src/index.ts) — `filter.status` seria ignorado no servidor.
      if (status) params.set('f.status', status);
      const r = await apiFetch<{ total: number; rows: Devolucao[] }>(`/devolucoes?${params.toString()}`);
      const q = buscaAplicada.toLowerCase();
      const filtradas = q
        ? r.rows.filter(
            (d) =>
              String(d.numero ?? '').toLowerCase().includes(q) ||
              String(d.venda_id ?? '').includes(q) ||
              String(d.motivo ?? '').toLowerCase().includes(q)
          )
        : r.rows;
      setLinhas(filtradas);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as devoluções.');
    } finally {
      setCarregando(false);
    }
  }, [status, buscaAplicada]);

  useEffect(() => {
    const t = window.setTimeout(() => setBuscaAplicada(busca.trim()), 250);
    return () => window.clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const colunas: DataTableColumn<Devolucao>[] = [
    { key: 'numero', header: 'Devolução', render: (d) => <span className="font-medium">{d.numero || `#${d.id}`}</span> },
    {
      key: 'venda',
      header: 'Venda ERP',
      render: (d) =>
        d.venda_id ? (
          <Link className="hover:underline" to={`/vendas/${d.venda_id}`}>
            Venda #{d.venda_id}
          </Link>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    { key: 'cliente', header: 'Cliente', render: (d) => <span className="text-sm">{d.cliente_id ? `#${d.cliente_id}` : '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (d) => <Badge tone={TONE_STATUS[d.status] ?? 'slate'}>{ROTULO_STATUS[d.status] ?? d.status}</Badge>,
    },
    { key: 'tipo', header: 'Tipo', render: (d) => <span className="text-sm">{d.tipo ?? '—'}</span> },
    { key: 'motivo', header: 'Motivo', render: (d) => <span className="text-sm">{d.motivo ?? '—'}</span> },
    { key: 'atualizado', header: 'Atualizada', render: (d) => <span className="text-sm text-muted">{dataHora(d.atualizado_em ?? d.criado_em ?? null)}</span> },
    {
      key: 'acoes',
      header: '',
      render: () => (
        <Link className="btn-ghost" to="/devolucoes">
          Abrir no ERP
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Devoluções"
        description="A devolução é do ERP canônico — mesma venda, mesmo estoque e mesmo financeiro. Aqui o commerce acompanha o vínculo com a venda; nada é duplicado."
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar por número, venda ou motivo…" label="Buscar devoluções" />
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Status</span>
          <select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTRO.map((v) => (
              <option key={v || 'todos'} value={v}>
                {v ? ROTULO_STATUS[v] ?? v : 'Todos'}
              </option>
            ))}
          </select>
        </label>
        <Badge tone="slate">{total} devolução(ões)</Badge>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando devoluções…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Repeat className="h-6 w-6" aria-hidden="true" />}
          title="Nenhuma devolução"
          description="Devoluções nascem no pós-venda do ERP (solicitação → autorização → recebimento)."
        />
      ) : (
        <DataTable
          caption="Devoluções vinculadas às vendas"
          columns={colunas}
          rows={linhas}
          getRowKey={(d) => d.id}
          empty="Nenhuma devolução com este filtro."
        />
      )}
    </div>
  );
}
