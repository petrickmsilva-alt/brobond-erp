// ============================================================================
// COMMERCE OS — ADAPTER DE PUBLICAÇÃO NA NUVEMSHOP (contrato 2025-03).
//
// Decisão (b) aprovada pelo Diretor: a publicação deixa o contrato legado v1
// e passa a usar a base documentada 2025-03. Regras (mesmas do Mercado Livre,
// P0-01):
//   1. vínculo existente ("produto:variante") → PATCH /products/stock-price;
//   2. sem vínculo → GET /products/sku/{sku}:
//        • encontrou       → adota (PATCH);
//        • não encontrou   → POST /products (criação);
//   3. POST sem resposta verificável NUNCA é repetido às cegas: a próxima
//      tentativa localiza o SKU antes de criar.
// Sem SKU ou sem título a publicação é recusada antes de qualquer chamada.
//
// Escopo desta entrega: publicação e atualização de preço/estoque. Descrição
// não é enviada (formato multilíngue ainda não verificado). Leitura de pedidos
// e produtos continua no módulo de conector (`nuvemshop.service.ts`, v1).
//
// `fetch` e o token são parâmetros: os testes usam dublês, sem credencial real.
// Mensagens de erro nunca carregam corpo de resposta remota.
// ============================================================================
import { PublicacaoFalha, type FetchLike, type ItemMercadoLivre } from './publicacaoCanais';

export const BASE_NUVEMSHOP_2025 = 'https://api.tiendanube.com/2025-03';
const TIMEOUT_PADRAO = 15_000;

/**
 * Ordem Final 2.5 — GATE DE ESCRITA. A publicação na Nuvemshop 2025-03 (POST /products,
 * PATCH /products/stock-price, GET /products/sku/{sku} e o esquema de variantes/estoque) NÃO tem
 * evidência na documentação oficial consultada. Enquanto esta constante for `false`, nenhuma chamada
 * é feita e a publicação falha antes de qualquer rede. Liberar exige evidência oficial registrada
 * em docs/auditoria/gate-leitura-nuvemshop-2025-03.md e alteração revisada deste arquivo.
 */
export const ESCRITA_NUVEMSHOP_2025_LIBERADA = false;

export type ContextoNuvemshop = {
  accessToken: string;
  /**
   * SOMENTE testes de contrato: liga a lógica do adapter sem liberar a escrita em produção.
   * A produção (catalogo.ts) não define este campo; um teste de guarda verifica isso.
   */
  evidenciaOficialEscrita?: boolean;
  /** Id da loja (`user_id` do OAuth). Compõe a URL de toda chamada. */
  storeId: string;
  /** Identificação da aplicação exigida pela plataforma (sem ela a API responde 400). */
  userAgent: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export type ItemNuvemshop = Pick<ItemMercadoLivre, 'sku' | 'titulo' | 'preco' | 'disponivel'>;

export type ResultadoNuvemshop = {
  externalId: string;
  operacao: 'criado' | 'atualizado' | 'vinculado_por_sku';
};

type FalhaComStatus = PublicacaoFalha & { status?: number };

async function chamar(ctx: ContextoNuvemshop, url: string, init: RequestInit): Promise<unknown> {
  const doFetch: FetchLike = ctx.fetch ?? ((u, i) => fetch(u, i));
  const comCorpo = init.body !== undefined;
  let resp: Response;
  try {
    resp = await doFetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'User-Agent': ctx.userAgent,
        ...(comCorpo ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(ctx.timeoutMs ?? TIMEOUT_PADRAO),
    });
  } catch {
    // Exceções de rede podem conter URL e credenciais: mensagem genérica, não rejeitada.
    throw new PublicacaoFalha('Falha de rede ao falar com a Nuvemshop. Nenhum produto foi confirmado.');
  }
  if (!resp.ok) {
    const falha = new PublicacaoFalha(
      `A Nuvemshop respondeu HTTP ${resp.status}.`,
      // Validação do payload não melhora com nova tentativa idêntica.
      resp.status === 400 || resp.status === 422
    ) as FalhaComStatus;
    falha.status = resp.status;
    throw falha;
  }
  const texto = await resp.text();
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

function precoTexto(preco: number): string {
  if (!Number.isFinite(preco) || preco < 0) throw new PublicacaoFalha('Preço inválido para a Nuvemshop.', true);
  return preco.toFixed(2);
}

function estoque(disponivel: number): number {
  return Math.max(0, Math.trunc(Number(disponivel) || 0));
}

/** Corpo de POST /products na versão 2025-03: preço, estoque e SKU ficam na variante. */
export function corpoCriacaoNuvemshop(item: ItemNuvemshop) {
  return {
    name: item.titulo,
    variants: [
      {
        price: precoTexto(item.preco),
        stock_management: true,
        stock: estoque(item.disponivel),
        sku: item.sku,
      },
    ],
  };
}

/** Corpo de PATCH /products/stock-price: lista de produtos com variantes. */
export function corpoAtualizacaoNuvemshop(produtoId: string, varianteId: string, item: ItemNuvemshop) {
  return [
    {
      id: Number(produtoId),
      variants: [
        {
          id: Number(varianteId),
          price: precoTexto(item.preco),
          inventory_levels: [{ stock: estoque(item.disponivel) }],
        },
      ],
    },
  ];
}

function separarVinculo(externalId: string): { produtoId: string; varianteId: string } {
  const [produtoId, varianteId, extra] = String(externalId).split(':');
  if (!produtoId || !varianteId || extra !== undefined || !/^\d+$/.test(produtoId) || !/^\d+$/.test(varianteId)) {
    throw new PublicacaoFalha('Vínculo da Nuvemshop inválido. Nenhum produto foi alterado: revise o vínculo.', true);
  }
  return { produtoId, varianteId };
}

function base(ctx: ContextoNuvemshop): string {
  const loja = String(ctx.storeId || '').trim();
  if (!/^\d+$/.test(loja)) throw new PublicacaoFalha('Loja Nuvemshop não identificada: reconecte a loja.', true);
  return `${BASE_NUVEMSHOP_2025}/${loja}`;
}

async function buscarPorSku(ctx: ContextoNuvemshop, sku: string): Promise<{ produtoId: string; varianteId: string } | null> {
  let corpo: { id?: unknown; variants?: Array<{ id?: unknown; sku?: unknown }> } | null;
  try {
    corpo = (await chamar(ctx, `${base(ctx)}/products/sku/${encodeURIComponent(sku)}`, { method: 'GET' })) as typeof corpo;
  } catch (e) {
    if (e instanceof PublicacaoFalha && (e as FalhaComStatus).status === 404) return null;
    throw e;
  }
  if (!corpo || corpo.id == null) return null;
  const variantes = Array.isArray(corpo.variants) ? corpo.variants : [];
  const variante = variantes.find((v) => String(v.sku ?? '') === sku) ?? variantes[0];
  if (!variante || variante.id == null) {
    throw new PublicacaoFalha('Produto com este SKU sem variante na Nuvemshop. Revise manualmente antes de publicar.', true);
  }
  return { produtoId: String(corpo.id), varianteId: String(variante.id) };
}

/**
 * Publica ou atualiza um produto na Nuvemshop 2025-03 sem duplicar.
 * `externalIdAtual` é o vínculo já conhecido ("produto:variante") ou null.
 */
export async function publicarItemNuvemshop(
  ctx: ContextoNuvemshop,
  item: ItemNuvemshop,
  externalIdAtual: string | null
): Promise<ResultadoNuvemshop> {
  if (!ESCRITA_NUVEMSHOP_2025_LIBERADA && ctx.evidenciaOficialEscrita !== true) {
    throw new PublicacaoFalha(
      'Publicação na Nuvemshop bloqueada: os endpoints de escrita da versão 2025-03 ainda não têm evidência oficial. Nenhuma alteração foi enviada à loja.',
      true
    );
  }
  if (!item.sku.trim()) {
    throw new PublicacaoFalha(
      'Produto sem SKU: a Nuvemshop exige SKU para localizar o produto e impedir duplicidade. Informe o SKU antes de publicar.',
      true
    );
  }
  if (!item.titulo.trim()) throw new PublicacaoFalha('Produto sem título: a Nuvemshop exige nome.', true);

  if (externalIdAtual) {
    const { produtoId, varianteId } = separarVinculo(externalIdAtual);
    await atualizarPrecoEstoque(ctx, produtoId, varianteId, item, externalIdAtual);
    return { externalId: `${produtoId}:${varianteId}`, operacao: 'atualizado' };
  }

  const existente = await buscarPorSku(ctx, item.sku.trim());
  if (existente) {
    await atualizarPrecoEstoque(ctx, existente.produtoId, existente.varianteId, item, null);
    return { externalId: `${existente.produtoId}:${existente.varianteId}`, operacao: 'vinculado_por_sku' };
  }

  const criado = (await chamar(ctx, `${base(ctx)}/products`, {
    method: 'POST',
    body: JSON.stringify(corpoCriacaoNuvemshop(item)),
  })) as { id?: unknown; variants?: Array<{ id?: unknown; sku?: unknown }> } | null;
  const variantes = Array.isArray(criado?.variants) ? criado!.variants! : [];
  const variante = variantes.find((v) => String(v.sku ?? '') === item.sku.trim()) ?? variantes[0];
  if (!criado || criado.id == null || !variante || variante.id == null) {
    // O produto pode ter sido criado sem resposta verificável. Não há novo POST:
    // a próxima tentativa localiza pelo SKU antes de criar.
    throw new PublicacaoFalha(
      'A Nuvemshop não confirmou o identificador do produto criado. Nenhum novo cadastro será feito: a próxima tentativa localiza pelo SKU.'
    );
  }
  return { externalId: `${criado.id}:${variante.id}`, operacao: 'criado' };
}

async function atualizarPrecoEstoque(
  ctx: ContextoNuvemshop,
  produtoId: string,
  varianteId: string,
  item: ItemNuvemshop,
  vinculoOrigem: string | null
): Promise<void> {
  try {
    const resposta = (await chamar(ctx, `${base(ctx)}/products/stock-price`, {
      method: 'PATCH',
      body: JSON.stringify(corpoAtualizacaoNuvemshop(produtoId, varianteId, item)),
    })) as Array<{ variants?: Array<{ success?: unknown }> }> | null;
    const recusada = Array.isArray(resposta) && resposta.some((p) => (p.variants || []).some((v) => v.success === false));
    if (recusada) throw new PublicacaoFalha('A Nuvemshop recusou a atualização de preço ou estoque deste produto.', true);
  } catch (e) {
    if (e instanceof PublicacaoFalha && (e as FalhaComStatus).status === 404) {
      throw new PublicacaoFalha(
        vinculoOrigem
          ? 'Produto da Nuvemshop vinculado não foi encontrado. Nenhum produto novo foi criado: revise o vínculo.'
          : 'Produto localizado pelo SKU não está mais disponível na Nuvemshop. Nenhum produto novo foi criado.',
        true
      );
    }
    throw e;
  }
}
