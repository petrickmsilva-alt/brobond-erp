// ============================================================================
// COMMERCE — /commerce/precos (visão de preços por canal).
//
// Lê o MESMO endpoint do catálogo (/api/commerce/produtos): preço base do
// produto + preço/promo por canal já resolvidos pelo servidor. Não existe
// segunda fonte de preço nem edição aqui: a alteração acontece no detalhe do
// produto (PUT /commerce/produtos/:id/precos, RBAC gerente no servidor).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgeDollarSign } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { grana, rotuloCanal } from './shared';

type Linha = {
  id: number;
  sku: string;
  nome: string;
  ativo: boolean;
  preco_base: number;
  na_vitrine: boolean;
  precos: Record<string, { preco: number; promo: number | null; origem: string }>;
};

export default function CommercePrecosPage() {
  const navigate = useNavigate();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [total, setTotal] = useState(0);
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = buscaAplicada ? `?q=${encodeURIComponent(buscaAplicada)}` : '';
      const r = await apiFetch<{ total: number; produtos: Linha[] }>(`/commerce/produtos${qs}`);
      setLinhas(r.produtos);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os preços.');
    } finally {
      setCarregando(false);
    }
  }, [buscaAplicada]);

  useEffect(() => {
    const t = window.setTimeout(() => setBuscaAplicada(busca.trim()), 250);
    return () => window.clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const colunas: DataTableColumn<Linha>[] = [
    {
      key: 'produto',
      header: 'Produto',
      render: (r) => (
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate(`/commerce/produtos/${r.id}`)}
            className="block max-w-full truncate text-left font-medium text-ink hover:text-primary hover:underline"
          >
            {r.nome}
          </button>
          <div className="truncate text-xs text-muted">{r.sku}</div>
        </div>
      ),
    },
    { key: 'base', header: 'Preço base', align: 'right', render: (r) => <span className="tabular-nums">{grana(r.preco_base)}</span> },
    {
      key: 'canais',
      header: 'Preço por canal',
      render: (r) => {
        const itens = Object.entries(r.precos);
        if (!itens.length) return <span className="text-muted">Todos os canais usam o preço base</span>;
        return (
          <div className="flex flex-wrap gap-1 text-xs">
            {itens.map(([canal, p]) => (
              <span key={canal} className="rounded bg-canvas px-1.5 py-0.5 text-muted">
                {rotuloCanal(canal)}: <span className="tabular-nums text-ink">{grana(p.promo ?? p.preco)}</span>
                {p.promo != null ? <span className="ml-1 line-through">{grana(p.preco)}</span> : null}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      key: 'acao',
      header: 'Ação',
      render: (r) => (
        <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => navigate(`/commerce/produtos/${r.id}`)}>
          Editar preços
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Preços por canal"
        description="Preço base e preço de cada canal, já resolvidos pelo servidor. A edição acontece no detalhe do produto."
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar por nome ou SKU…" label="Buscar preços" />
      </FilterBar>
      {erro && (
        <Alert tone="red">
          {erro}{' '}
          <button type="button" className="font-medium underline" onClick={() => void carregar()}>
            Tentar novamente
          </button>
        </Alert>
      )}
      {carregando ? (
        <Spinner label="Carregando preços…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<BadgeDollarSign className="h-6 w-6" aria-hidden="true" />}
          title={buscaAplicada ? 'Nenhum produto encontrado' : 'Nenhum produto ainda'}
          description={buscaAplicada ? 'Ajuste a busca.' : 'Cadastre produtos no ERP (Cadastros → Produtos) para definir preços por canal.'}
        />
      ) : (
        <>
          <DataTable caption="Preços por canal" columns={colunas} rows={linhas} getRowKey={(r) => r.id} empty="Nenhum produto nesta página." />
          <div className="text-sm text-muted">
            {total} produto(s) · {linhas.length} exibido(s)
          </div>
        </>
      )}
    </div>
  );
}
