// ============================================================================
// COMMERCE — CATÁLOGO OMNICHANNEL (lista). Rota /commerce/produtos.
//
// Lê o canônico (produtos + preço por canal + disponibilidade do motor de
// estoque) e a projeção da vitrine. "Novo" = projeta um produto EXISTENTE em
// /commerce/produtos/novo (nunca duplica cadastro, nunca modal). Detalhe com
// preços/filas em /commerce/produtos/:id.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Plus, Search } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { Badge } from '../../components/ui';
import { EstadoBadge, TONE_PUBLICACAO, ROTULO_PUBLICACAO, grana, rotuloCanal } from './shared';
import { useAuth } from '../../auth/AuthContext';

type Linha = {
  id: number;
  sku: string;
  nome: string;
  ativo: boolean;
  preco_base: number;
  disponivel: number;
  na_vitrine: boolean;
  slug: string | null;
  publicacoes: Record<string, { estado: string; versao: number; external_id: string | null; ultimo_erro: string | null }>;
  precos: Record<string, { preco: number; promo: number | null; origem: string }>;
};

export default function CommerceProdutosPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  // RBAC espelhado (autoridade = API): escrita de vitrine/preço é gerente.
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

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
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o catálogo commerce.');
    } finally {
      setCarregando(false);
    }
  }, [buscaAplicada]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setBuscaAplicada(busca.trim());
    }, 250);
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
          <div className="truncate text-xs text-muted">
            {r.sku}
            {r.na_vitrine && r.slug ? ` · /loja/produto/${r.slug}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'preco',
      header: 'Preço base',
      align: 'right',
      render: (r) => <span className="tabular-nums">{grana(r.preco_base)}</span>,
    },
    {
      key: 'disponivel',
      header: 'Disponível',
      align: 'right',
      render: (r) => (
        <span className={`tabular-nums ${r.disponivel > 0 ? 'text-ink' : 'text-danger'}`}>{r.disponivel}</span>
      ),
    },
    {
      key: 'vitrine',
      header: 'Vitrine',
      render: (r) => (r.na_vitrine ? <Badge tone="green">Na vitrine</Badge> : <Badge tone="slate">Fora</Badge>),
    },
    {
      key: 'publicacoes',
      header: 'Canais publicados',
      render: (r) => {
        const itens = Object.entries(r.publicacoes).filter(([, p]) => p.estado === 'PUBLISHED');
        if (!itens.length) return <span className="text-muted">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {itens.map(([canal, p]) => (
              <EstadoBadge key={canal} estado={p.estado} mapa={TONE_PUBLICACAO} rotulos={ROTULO_PUBLICACAO} />
            ))}
          </div>
        );
      },
    },
    {
      key: 'precos_canal',
      header: 'Preços por canal',
      render: (r) => {
        const entries = Object.entries(r.precos);
        if (!entries.length) return <span className="text-muted">base</span>;
        return (
          <div className="flex flex-wrap gap-1 text-xs">
            {entries.map(([canal, p]) => (
              <span key={canal} className="rounded bg-canvas px-1.5 py-0.5 text-muted">
                {rotuloCanal(canal)}: <span className="tabular-nums text-ink">{grana(p.promo ?? p.preco)}</span>
              </span>
            ))}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Cadastro',
      render: (r) => (r.ativo ? <Badge tone="green">Ativo</Badge> : <Badge tone="slate">Inativo</Badge>),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Catálogo multicanal"
        description="Produtos da empresa, preço por canal e disponibilidade do estoque canônico — somente leitura aqui; alterações vivem no detalhe do produto."
        actions={
          podeGerir ? (
            <button type="button" className="btn-primary" onClick={() => navigate('/commerce/produtos/novo')}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Projetar produto
            </button>
          ) : undefined
        }
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar por nome, SKU ou resumo…" label="Buscar produtos" />
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando catálogo…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Package className="h-6 w-6" aria-hidden="true" />}
          title={buscaAplicada ? 'Nenhum produto encontrado' : 'Nenhum produto ainda'}
          description={
            buscaAplicada
              ? 'Ajuste a busca para encontrar o produto desejado.'
              : 'Cadastre produtos no ERP (Cadastros → Produtos) e projete-os aqui na vitrine commerce.'
          }
        />
      ) : (
        <>
          <DataTable
            caption="Catálogo omnichannel"
            columns={colunas}
            rows={linhas}
            getRowKey={(r) => r.id}
            empty="Nenhum produto nesta página."
          />
          <div className="text-sm text-muted">
            {total} produto(s) no catálogo · {linhas.length} exibido(s)
            {total > linhas.length ? ` · busca limitada aos primeiros 1.000 (refine para ver mais)` : ''}
          </div>
        </>
      )}
    </div>
  );
}
