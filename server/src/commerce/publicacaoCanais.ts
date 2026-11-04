// ============================================================================
// COMMERCE OS — ADAPTERS DE PUBLICAÇÃO EM CANAIS EXTERNOS (Mercado Livre).
//
// Regra central (P0-01): nunca criar um anúncio novo quando já existe um
// vínculo (external_id) ou quando o SKU já aparece no canal. Ordem:
//   1. vínculo existente  → PUT /items/{id} (preço e estoque);
//   2. sem vínculo        → busca por SKU (seller_sku) na conta do vendedor:
//        • 1 resultado    → adota o anúncio existente (PUT);
//        • mais de 1      → recusa (duplicidade a resolver por humano);
//        • nenhum         → POST /items (criação).
// Sem SKU a publicação é recusada antes de qualquer chamada externa.
//
// `fetch` e o token são parâmetros: os testes usam dublês, sem credencial real.
// Mensagens de erro nunca carregam corpo de resposta remota (pode conter PII).
// ============================================================================

export class PublicacaoFalha extends Error {
  readonly rejeitada: boolean;
  constructor(mensagem: string, rejeitada = false) {
    super(mensagem);
    this.name = 'PublicacaoFalha';
    this.rejeitada = rejeitada;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ContextoCanal = {
  accessToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export type ItemMercadoLivre = {
  sku: string;
  titulo: string;
  descricao: string;
  preco: number;
  disponivel: number;
  condicao: string;
  categoria: string;
  listingType: string;
};

export type ResultadoMercadoLivre = {
  externalId: string;
  operacao: 'criado' | 'atualizado' | 'vinculado_por_sku';
};

const BASE_ML = 'https://api.mercadolibre.com';
const TIMEOUT_PADRAO = 15_000;

async function chamar(ctx: ContextoCanal, url: string, init: RequestInit): Promise<unknown> {
  const doFetch: FetchLike = ctx.fetch ?? ((u, i) => fetch(u, i));
  let resp: Response;
  try {
    resp = await doFetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${ctx.accessToken}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(ctx.timeoutMs ?? TIMEOUT_PADRAO),
    });
  } catch {
    // Exceções de rede podem conter URL e credenciais: mensagem genérica.
    throw new PublicacaoFalha('Falha de rede ao falar com o Mercado Livre.');
  }
  if (!resp.ok) {
    const falha = new PublicacaoFalha(`O Mercado Livre respondeu HTTP ${resp.status}.`);
    (falha as PublicacaoFalha & { status?: number }).status = resp.status;
    throw falha;
  }
  const texto = await resp.text();
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/** Título: o ML limita 60 caracteres. Título não entra no PUT: após venda o ML o bloqueia. */
export function corpoCriacaoMercadoLivre(item: ItemMercadoLivre) {
  return {
    title: item.titulo.slice(0, 60),
    category_id: item.categoria,
    condition: item.condicao === 'usado' ? 'used' : 'new',
    currency_id: 'BRL',
    price: item.preco,
    available_quantity: Math.max(0, Math.trunc(item.disponivel)),
    buying_mode: 'buy_it_now',
    ...(item.listingType ? { listing_type_id: item.listingType } : {}),
    free_shipping: { mode: 'not_allowed' },
    seller_custom_field: item.sku,
    attributes: [{ id: 'SELLER_SKU', value_name: item.sku }],
    ...(item.descricao ? { description: item.descricao } : {}),
  };
}

export function corpoAtualizacaoMercadoLivre(item: Pick<ItemMercadoLivre, 'preco' | 'disponivel'>) {
  return { price: item.preco, available_quantity: Math.max(0, Math.trunc(item.disponivel)) };
}

async function atualizarItem(ctx: ContextoCanal, itemId: string, item: ItemMercadoLivre): Promise<void> {
  try {
    await chamar(ctx, `${BASE_ML}/items/${encodeURIComponent(itemId)}`, {
      method: 'PUT',
      body: JSON.stringify(corpoAtualizacaoMercadoLivre(item)),
    });
  } catch (e) {
    if (e instanceof PublicacaoFalha && (e as PublicacaoFalha & { status?: number }).status === 404) {
      throw new PublicacaoFalha(
        'Anúncio do Mercado Livre vinculado não foi encontrado (pode ter sido encerrado). Nenhum anúncio novo foi criado: revise o vínculo.',
        true
      );
    }
    throw e;
  }
}

async function localizarPorSku(ctx: ContextoCanal, sku: string): Promise<string[]> {
  const eu = (await chamar(ctx, `${BASE_ML}/users/me`, { method: 'GET' })) as { id?: unknown } | null;
  const userId = eu && eu.id != null ? String(eu.id) : '';
  if (!userId) throw new PublicacaoFalha('Não foi possível identificar a conta do Mercado Livre.');
  const busca = (await chamar(
    ctx,
    `${BASE_ML}/users/${encodeURIComponent(userId)}/items/search?seller_sku=${encodeURIComponent(sku)}`,
    { method: 'GET' }
  )) as { results?: unknown } | null;
  return Array.isArray(busca?.results) ? busca!.results.map((id) => String(id)) : [];
}

/**
 * Publica ou atualiza um anúncio do Mercado Livre sem duplicar.
 * `externalIdAtual` é o vínculo já conhecido (última versão publicada, ou null).
 */
export async function publicarItemMercadoLivre(
  ctx: ContextoCanal,
  item: ItemMercadoLivre,
  externalIdAtual: string | null
): Promise<ResultadoMercadoLivre> {
  if (!item.sku.trim()) {
    throw new PublicacaoFalha(
      'Produto sem SKU: o Mercado Livre exige SKU para localizar o anúncio e impedir duplicidade. Informe o SKU antes de publicar.',
      true
    );
  }

  if (externalIdAtual) {
    await atualizarItem(ctx, externalIdAtual, item);
    return { externalId: externalIdAtual, operacao: 'atualizado' };
  }

  const encontrados = await localizarPorSku(ctx, item.sku);
  if (encontrados.length > 1) {
    throw new PublicacaoFalha(
      'Mais de um anúncio do Mercado Livre usa este SKU. Resolva a duplicidade no canal antes de publicar.',
      true
    );
  }
  if (encontrados.length === 1) {
    await atualizarItem(ctx, encontrados[0], item);
    return { externalId: encontrados[0], operacao: 'vinculado_por_sku' };
  }

  if (!item.categoria.trim()) {
    throw new PublicacaoFalha(
      'Categoria do Mercado Livre ausente: informe ml_category_id nos metadados do produto (ex.: MLB1234567) — o anúncio não é criado sem categoria.'
    );
  }
  const criado = (await chamar(ctx, `${BASE_ML}/items`, {
    method: 'POST',
    body: JSON.stringify(corpoCriacaoMercadoLivre(item)),
  })) as { id?: unknown } | null;
  const id = criado && criado.id != null ? String(criado.id) : '';
  if (!id) throw new PublicacaoFalha('O Mercado Livre não devolveu o id do anúncio.');
  return { externalId: id, operacao: 'criado' };
}
