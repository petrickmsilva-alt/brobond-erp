// ============================================================================
// SELEÇÃO HIERÁRQUICA DE PRODUTO — pai → variação → tamanho.
//
// A regra canônica do estoque deste ERP é (produto PAI + tamanho + local). A
// variação é uma visão COMERCIAL dessa mesma célula: ela fornece SKU e preço,
// mas não tem saldo próprio e não pode ser somada ao saldo do pai. Este módulo
// concentra essa tradução para que ProductSelector, PDV, pedidos e demais
// telas usem exatamente o mesmo contrato — nenhum módulo remonta a combinação
// por conta própria.
// ============================================================================
import type { ProductSearchSize, SearchProduct } from './productSearch';

/**
 * Resultado final de uma escolha no ProductSelector.
 *
 * `produto` é sempre o PAI (destino de `itens_venda.produto_id` e dono do
 * saldo); `variacao`, quando existir, traz SKU/preço; `tamanho_id` é a célula
 * de estoque efetivamente escolhida. Nenhum saldo é somado entre pai e
 * variação: `quantidade_disponivel` é sempre a célula única mostrada na busca.
 */
export type ProductSelection = {
  /** Produto pai (canônico para estoque/venda). */
  produto: SearchProduct;
  /** `produto.id` do pai — o que vai para a linha da venda/estoque. */
  produto_id: number;
  /** Preenchido somente quando a escolha foi uma variação. */
  produto_pai_id: number | null;
  /** Variação escolhida (SKU/preço próprios), quando houver. */
  variacao: SearchProduct | null;
  /** SKU vendável: o da variação quando houver, senão o do pai. */
  sku: string;
  /** Preço do que foi escolhido; o valor final continua sendo o do servidor. */
  preco: number;
  /** Tamanho da célula (produto + tamanho + local). */
  tamanho_id: number | null;
  tamanho: string | null;
  /** Saldo da célula escolhida — nunca a soma pai + variação. */
  quantidade_disponivel: number | null;
};

/** Tamanho que a variação representa (coluna `variacao_tamanho_id`). */
export function variantSizeId(variacao: SearchProduct): number | null {
  const own = variacao.variacao_tamanho_id;
  if (own !== null && own !== undefined) return Number(own);
  // Registros legados podem não ter `variacao_tamanho_id`; nesse caso o
  // tamanho só é inequívoco quando a variação tem exatamente um.
  if (variacao.tamanhos.length === 1) return variacao.tamanhos[0].tamanho_id;
  return null;
}

/** Tamanho (com saldo) pelo qual a variação responde na grade do pai. */
export function variantSize(variacao: SearchProduct): ProductSearchSize | null {
  const id = variantSizeId(variacao);
  const byId = id === null ? undefined : variacao.tamanhos.find((size) => size.tamanho_id === id);
  if (byId) return byId;
  if (variacao.tamanhos.length === 1) return variacao.tamanhos[0];
  if (id !== null) {
    return { tamanho_id: id, tamanho: `#${id}`, quantidade: variacao.estoque_disponivel };
  }
  return null;
}

/**
 * Tamanhos que ainda são vendidos pelo próprio pai.
 *
 * Quando o produto tem variações, as combinações já cobertas por uma variação
 * pertencem a ela (SKU/preço próprios). Sobram aqui apenas as células que não
 * têm variação — sem elas, um tamanho existente na grade ficaria impossível de
 * vender pela busca.
 */
export function parentOnlySizes(product: SearchProduct): ProductSearchSize[] {
  const variants = product.variacoes ?? [];
  if (!variants.length) return product.tamanhos;
  const covered = new Set(
    variants
      .map(variantSizeId)
      .filter((id): id is number => id !== null && id !== undefined),
  );
  return product.tamanhos.filter((size) => size.tamanho_id === null || !covered.has(size.tamanho_id));
}

/**
 * A combinação é ambígua? Só existe seleção direta quando há uma única
 * combinação possível (nenhuma variação e no máximo um tamanho). Com mais de
 * um tamanho — ou com variações — o usuário precisa escolher explicitamente.
 */
export function requiresExplicitChoice(product: SearchProduct): boolean {
  const variants = product.variacoes ?? [];
  if (variants.length) return true;
  return product.tamanhos.length > 1;
}

/**
 * Monta o resultado final da seleção.
 *
 * `size` explícito vence; sem ele, a variação determina o tamanho. Para um pai
 * com um único tamanho a seleção direta continua permitida (regra 6).
 */
export function buildProductSelection(
  row: SearchProduct,
  size: ProductSearchSize | null = null,
  parent: SearchProduct | null = null,
): ProductSelection {
  const ehVariacao = row.produto_pai_id !== null && row.produto_pai_id !== undefined;
  const produto = ehVariacao ? parent ?? row : row;
  const tamanho = size
    ?? (ehVariacao ? variantSize(row) : row.tamanhos.length === 1 ? row.tamanhos[0] : null);
  return {
    produto,
    produto_id: ehVariacao ? Number(row.produto_pai_id) : Number(row.id),
    produto_pai_id: ehVariacao ? Number(row.produto_pai_id) : null,
    variacao: ehVariacao ? row : null,
    sku: row.sku,
    preco: Number(row.preco_venda ?? 0),
    tamanho_id: tamanho ? tamanho.tamanho_id : null,
    tamanho: tamanho ? tamanho.tamanho : null,
    quantidade_disponivel: tamanho ? Number(tamanho.quantidade) : Number(row.estoque_disponivel ?? 0),
  };
}

/** A célula pode ser vendida neste contexto (estoque exigido e saldo > 0)? */
export function sizeIsSellable(size: ProductSearchSize, requiresStock: boolean): boolean {
  return !requiresStock || Number(size.quantidade) > 0;
}
