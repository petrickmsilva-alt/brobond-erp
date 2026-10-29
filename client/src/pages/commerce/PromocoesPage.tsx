// ============================================================================
// COMMERCE — PROMOÇÕES (lista). Rota /commerce/promocoes.
// Nova/edição em PÁGINA própria (/commerce/promocoes/nova, /:id/editar).
// Política: promoção e cupom não acumulam — o checkout aplica o maior desconto.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgePercent, Pencil, Percent, Plus } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { DataTable, FilterBar, type DataTableColumn } from '../../components/ui-kit-negocios';
import { formatMoney } from '../../lib/format';
import { useAuth } from '../../auth/AuthContext';

type Promocao = {
  id: number;
  nome: string;
  tipo: string;
  valor: number;
  minimo_pedido: number;
  data_inicio: string;
  data_fim: string | null;
  ativo: boolean;
};

export default function CommercePromocoesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [linhas, setLinhas] = useState<Promocao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [filtro, setFiltro] = useState('');
  const [excluindo, setExcluindo] = useState<Promocao | null>(null);
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<{ total: number; promocoes: Promocao[] }>('/commerce/promocoes?page=1&pageSize=100');
      setLinhas(r.promocoes);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as promoções.');
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
      await apiFetch(`/commerce/promocoes/${excluindo.id}`, { method: 'DELETE' });
      toast.success(`Promoção "${excluindo.nome}" excluída.`);
      setExcluindo(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao excluir.');
    } finally {
      setBusy(false);
    }
  };

  const visiveis = linhas.filter((p) => {
    if (filtro === 'ativas') return p.ativo;
    if (filtro === 'inativas') return !p.ativo;
    return true;
  });

  const colunas: DataTableColumn<Promocao>[] = [
    { key: 'nome', header: 'Promoção', render: (p) => <span className="font-medium">{p.nome}</span> },
    {
      key: 'regra',
      header: 'Regra',
      render: (p) => (
        <span>
          {p.tipo === 'percentual' ? `${p.valor}%` : formatMoney(p.valor)}
          {Number(p.minimo_pedido) > 0 && <span className="text-muted"> · mín. {formatMoney(p.minimo_pedido)}</span>}
        </span>
      ),
    },
    {
      key: 'vigencia',
      header: 'Vigência',
      render: (p) => (
        <span className="text-sm">
          {p.data_inicio || '—'} {p.data_fim ? `→ ${p.data_fim}` : '→ sem fim'}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (p) => (p.ativo ? <Badge tone="green">Ativa</Badge> : <Badge tone="slate">Inativa</Badge>) },
    {
      key: 'acoes',
      header: 'Ações',
      align: 'right',
      render: (p) =>
        podeGerir ? (
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => navigate(`/commerce/promocoes/${p.id}/editar`)}>
              <Pencil className="h-4 w-4" aria-hidden="true" /> Editar
            </button>
            <button type="button" className="btn-ghost" onClick={() => setExcluindo(p)}>
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
        title="Promoções"
        description="Descontos automáticos por período e pedido mínimo no carrinho da loja própria. Promoção e cupom não acumulam — vence o maior desconto."
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/ofertas')}>
              <Percent className="h-4 w-4" aria-hidden="true" /> Ofertas por canal
            </button>
            {podeGerir && (
              <button type="button" className="btn-primary" onClick={() => navigate('/commerce/promocoes/nova')}>
                <Plus className="h-4 w-4" aria-hidden="true" /> Nova promoção
              </button>
            )}
          </>
        }
      />
      <FilterBar>
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Status</span>
          <select className="input w-40" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="">Todas</option>
            <option value="ativas">Ativas</option>
            <option value="inativas">Inativas</option>
          </select>
        </label>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando promoções…" />
      ) : visiveis.length === 0 ? (
        <EmptyState
          icon={<BadgePercent className="h-6 w-6" aria-hidden="true" />}
          title="Nenhuma promoção"
          description="Crie a primeira campanha de desconto automático para a vitrine."
        />
      ) : (
        <DataTable
          caption="Promoções ativas e inativas"
          columns={colunas}
          rows={visiveis}
          getRowKey={(p) => p.id}
          empty="Nenhuma promoção."
        />
      )}
      {excluindo && (
        <ConfirmacaoInline
          open
          title={`Excluir a promoção "${excluindo.nome}"?`}
          message="A regra deixa de valer para novos carrinhos; pedidos já concluídos não mudam."
          confirmLabel="Excluir"
          danger
          busy={busy}
          onCancel={() => setExcluindo(null)}
          onConfirm={() => void excluir()}
        />
      )}
    </div>
  );
}
