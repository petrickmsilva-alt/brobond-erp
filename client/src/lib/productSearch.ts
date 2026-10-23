import { api } from './api';

export type ProductSearchSize = {
  tamanho_id: number | null;
  tamanho: string;
  quantidade: number;
};

export type SearchProduct = {
  id: number;
  produto_pai_id: number | null;
  sku: string;
  nome: string;
  codigo_barras: string | null;
  descricao: string | null;
  cor: string | null;
  categoria: string | null;
  marca: string | null;
  /** Miniatura já presente no resultado; o seletor nunca busca fotos à parte. */
  foto_url?: string | null;
  preco_venda: number;
  ativo: boolean;
  variacao_tamanho_id: number | null;
  estoque_disponivel: number;
  tamanhos: ProductSearchSize[];
  variacoes?: SearchProduct[];
};

export type ProductSearchResponse = {
  rows: SearchProduct[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type ProductSearchFilters = {
  onlyInStock?: boolean;
  inStockFirst?: boolean;
  includeInactive?: boolean;
  localId?: number | null;
};

/** Cliente único da capacidade central; nenhum módulo monta sua própria busca. */
export async function searchProducts(
  q: string,
  options: ProductSearchFilters & { id?: number; page?: number; pageSize?: number } = {},
): Promise<ProductSearchResponse> {
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('page', String(options.page ?? 1));
  params.set('pageSize', String(options.pageSize ?? 20));
  if (options.id) params.set('id', String(options.id));
  if (options.onlyInStock) params.set('onlyInStock', 'true');
  if (options.inStockFirst) params.set('inStockFirst', 'true');
  if (options.includeInactive) params.set('includeInactive', 'true');
  if (options.localId) params.set('local_id', String(options.localId));
  return api.get<ProductSearchResponse>(`/produtos/busca?${params.toString()}`);
}

export function productLabel(product: Pick<SearchProduct, 'sku' | 'nome'>): string {
  return `${product.sku} — ${product.nome}`;
}
