// ============================================================================
// COMMERCE — CUPONS (lista). Rota /commerce/cupons.
// Nova/edição em página própria; cupom COM uso vira desativação (histórico
// preservado) — o servidor impõe isso no DELETE.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ticket, Pencil, Plus } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { formatMoney } from '../../lib/format';
import { useAuth } from '../../auth/AuthContext';

type Cupom = {
  id: number;
  codigo: string;
  tipo: string;
  valor: number;
  minimo_pedido: number;
  uso_maximo: number | null;
  uso_atual: number;
  validade: string | null;
  ativo: boolean;
};

export default function CommerceCuponsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [linhas, setLinhas] = useState<Cupom[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [excluindo, setExcluindo] = useState<Cupom | null>(null);
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<{ total: number; cupons: Cupom[] }>('/commerce/cupons?page=1&pageSize=200');
      setLinhas(r.cupons);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os cupons.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const excluir = async () => {
    if (!excluindo) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ ok: boolean; desativado?: boolean }>(`/commerce/cupons/${excluindo.id}`, { method: 'DELETE' });
      toast.success(r.desativado ? 'Cupom com usos: desativado (histórico preservado).' : 'Cupom excluído.');
      setExcluindo(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao excluir.');
    } finally {
      setBusy(false);
    }
  };

  const q = busca.trim().toLowerCase();
  const visiveis = q ? linhas.filter((c) => c.codigo.toLowerCase().includes(q)) : linhas;

  const colunas: DataTableColumn<Cupom>[] = [
    { key: 'codigo', header: 'Código', render: (c) => <span className="font-mono font-semibold">{c.codigo}</span> },
    {
      key: 'regra',
      header: 'Desconto',
      render: (c) => (
        <span>
          {c.tipo === 'percentual' ? `${c.valor}%` : formatMoney(c.valor)}
          {Number(c.minimo_pedido) > 0 && <span className="text-muted"> · mín. {formatMoney(c.minimo_pedido)}</span>}
        </span>
      ),
    },
    {
      key: 'usos',
      header: 'Usos',
      align: 'right',
      render: (c) => (
        <span className="tabular-nums">
          {c.uso_atual}
          {c.uso_maximo != null ? ` / ${c.uso_maximo}` : ''}
        </span>
      ),
    },
    { key: 'validade', header: 'Válido até', render: (c) => <span className="text-sm">{c.validade ?? 'sem prazo'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (c) =>
        !c.ativo ? <Badge tone="slate">Inativo</Badge> : c.uso_maximo != null && c.uso_atual >= c.uso_maximo ? <Badge tone="amber">Esgotado</Badge> : <Badge tone="green">Ativo</Badge>,
    },
    {
      key: 'acoes',
      header: 'Ações',
      align: 'right',
      render: (c) =>
        podeGerir ? (
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => navigate(`/commerce/cupons/${c.id}/editar`)}>
              <Pencil className="h-4 w-4" aria-hidden="true" /> Editar
            </button>
            <button type="button" className="btn-ghost" onClick={() => setExcluindo(c)}>
              Excluir
            </button>
          </div>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cupons"
        description="Códigos de desconto da loja própria com validade e limite de uso — validados no servidor, no momento do checkout."
        actions={
          podeGerir ? (
            <button type="button" className="btn-primary" onClick={() => navigate('/commerce/cupons/novo')}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Novo cupom
            </button>
          ) : undefined
        }
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar por código…" label="Buscar cupons" />
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando cupons…" />
      ) : visiveis.length === 0 ? (
        <EmptyState
          icon={<Ticket className="h-6 w-6" aria-hidden="true" />}
          title="Nenhum cupom"
          description="Crie códigos de desconto para campanhas pontuais da vitrine."
        />
      ) : (
        <DataTable
          caption="Cupons de desconto"
          columns={colunas}
          rows={visiveis}
          getRowKey={(c) => c.id}
          empty="Nenhum cupom."
        />
      )}
      {excluindo && (
        <ConfirmacaoInline
          open
          title={`Excluir o cupom ${excluindo.codigo}?`}
          message={
            excluindo.uso_atual > 0
              ? 'Este cupom já foi usado — o servidor vai DESATIVAR (sem apagar o histórico) para não perder os pedidos.'
              : 'Sem usos: o código será removido definitivamente.'
          }
          confirmLabel="Confirmar"
          danger
          busy={busy}
          onCancel={() => setExcluindo(null)}
          onConfirm={() => void excluir()}
        />
      )}
    </div>
  );
}
