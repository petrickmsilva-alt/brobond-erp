// ============================================================================
// COMMERCE — PROJETAR PRODUTO NA VITRINE. Rota /commerce/produtos/novo.
//
// Escolhe um produto JÁ cadastrado no ERP e cria a projeção commerce (slug +
// resumo). Nenhuma cópia de cadastro, nenhum modal: a seleção acontece nesta
// página e a criação é confirmada no servidor (409 se já projetado).
// ============================================================================
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Search } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { SearchInput, FilterBar, DataTable, type DataTableColumn } from '../../components/ui-kit-negocios';
import { grana } from './shared';
import { useAuth } from '../../auth/AuthContext';

type ProdutoErp = { id: number; sku: string; nome: string; preco_venda: number; ativo?: boolean };

export default function CommerceProdutoNovoPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [busca, setBusca] = useState('');
  const [termo, setTermo] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [produtos, setProdutos] = useState<ProdutoErp[]>([]);
  const [projetando, setProjetando] = useState<number | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setTermo(busca.trim()), 250);
    return () => window.clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro('');
    apiFetch<{ produtos?: ProdutoErp[]; rows?: ProdutoErp[]; total?: number }>(
      `/produtos?page=1&pageSize=50${termo ? `&q=${encodeURIComponent(termo)}` : ''}`
    )
      .then((r) => {
        if (!vivo) return;
        const linhas = (r.produtos ?? r.rows ?? []) as ProdutoErp[];
        setProdutos(linhas.filter((p) => p.ativo !== false));
      })
      .catch((e) => {
        if (vivo) setErro(e instanceof ApiError ? e.message : 'Não foi possível listar os produtos.');
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [termo]);

  const projetar = async (produto: ProdutoErp) => {
    setProjetando(produto.id);
    setErro('');
    try {
      const r = await apiFetch<{ ok: boolean; produto_commerce: { id: number; slug: string } }>('/commerce/produtos', {
        method: 'POST',
        body: JSON.stringify({ produto_id: produto.id }),
      });
      toast.success(`"${produto.nome}" entrou na vitrine (slug: ${r.produto_commerce.slug}).`);
      navigate(`/commerce/produtos/${produto.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErro(`${produto.nome}: ${e.message} Abra o produto para editar a vitrine.`);
      } else {
        setErro(e instanceof ApiError ? e.message : 'Falha ao projetar o produto.');
      }
    } finally {
      setProjetando(null);
    }
  };

  const colunas: DataTableColumn<ProdutoErp>[] = useMemo(
    () => [
      { key: 'sku', header: 'SKU', render: (p) => <span className="font-mono text-xs">{p.sku}</span> },
      { key: 'nome', header: 'Produto', render: (p) => <span className="font-medium">{p.nome}</span> },
      { key: 'preco', header: 'Preço de venda', align: 'right', render: (p) => <span className="tabular-nums">{grana(p.preco_venda)}</span> },
      {
        key: 'acao',
        header: 'Ação',
        align: 'right',
        render: (p) =>
          podeGerir ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={projetando === p.id}
              onClick={() => void projetar(p)}
            >
              {projetando === p.id ? 'Projetando…' : 'Projetar na vitrine'}
            </button>
          ) : (
            <Badge tone="slate">leitura</Badge>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [podeGerir, projetando]
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Projetar produto na vitrine"
        description="O produto continua sendo cadastrado em Cadastros → Produtos. Aqui ele ganha slug público e entra no catálogo commerce — sem duplicar cadastro."
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar produto por nome ou SKU…" label="Buscar produto" />
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando produtos…" />
      ) : produtos.length === 0 ? (
        <EmptyState
          icon={<Package className="h-6 w-6" aria-hidden="true" />}
          title="Nenhum produto encontrado"
          description="Cadastre o produto no ERP antes de projetá-lo na vitrine."
        />
      ) : (
        <DataTable
          caption="Produtos cadastrados no ERP"
          columns={colunas}
          rows={produtos}
          getRowKey={(p) => p.id}
          empty="Nenhum produto corresponde à busca."
        />
      )}
    </div>
  );
}
