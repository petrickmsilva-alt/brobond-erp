// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › PUBLICAÇÃO DE CATÁLOGO POR LOJA.
//
// O catálogo é ÚNICO (produtos do ERP) e cada loja recebe a SUA publicação:
//
//   RETAIL     → preço = produtos.preco_venda
//   WHOLESALE  → preço = produtos.preco_atacado (+ atacado_min_qtd no metadado)
//
// IDEMPOTÊNCIA em três camadas, nesta ordem:
//   1. vínculo persistido (`woocommerce_product_links`) — a memória da loja;
//   2. SKU exato na loja (adota o anúncio já existente, nunca cria o segundo);
//   3. só então POST de criação.
//
// Produto VARIÁVEL nunca vira simples: o pai é publicado como `type=variable`
// com o atributo de tamanho, e cada variação do ERP (filho com
// `produto_pai_id`) ganha o próprio `external_variation_id`, o próprio SKU, o
// próprio preço (da VARIAÇÃO, não do pai) e o próprio estoque.
//
// Preço inválido não é publicado: a publicação falha com motivo acionável em
// vez de deixar anúncio sem preço na loja.
// ============================================================================
import { HttpError } from '../../errors';
import { getStore } from '../../services';
import type { Row, Tx } from '../../store';
import { getResource } from '../../resources';
import { PublicacaoFalha } from '../publicacaoCanais';
import { disponibilidadesPorTamanho } from '../catalogo';
import { escopoDeSistema } from '../../empresa';
import type { ConfigStore } from './registry';
import { wooStoreFetch, ehDryRun } from './cliente';
import { precoDaLoja, minimoAtacado, validarPrecoPublicavel } from './precos';
import { registrarVinculo, vinculoDoProduto, vinculoDeVariacao } from './vinculos';

const R_PRODUTOS = () => getResource('produtos')!;
const R_PRECOS = () => getResource('commerce_precos')!;
const R_TAMANHOS = () => getResource('tamanhos')!;

type WooProduto = { id?: number; sku?: string; type?: string; permalink?: string };
type WooVariacao = { id?: number; sku?: string };

/** Tamanhos (id → código) da empresa — carregados uma vez por operação. */
async function mapaTamanhos(tx?: Tx): Promise<Map<number, string>> {
  const out = await getStore().list(R_TAMANHOS(), { page: 1, pageSize: 5000 }, tx);
  return new Map(out.rows.map((t) => [Number(t.id), String(t.codigo || '').trim().toUpperCase()]));
}

/** Filhos (variações) do produto, escopados à empresa. */
async function variacoesDoProduto(empresaId: number, produtoId: number, tx?: Tx): Promise<Row[]> {
  const out = await getStore().list(
    R_PRODUTOS(),
    { page: 1, pageSize: 2000, filter: { empresa_id: empresaId, produto_pai_id: produtoId }, sort: 'id', dir: 'asc' },
    tx
  );
  return out.rows;
}

async function linhaPreco(empresaId: number, produtoId: number, canal: string, tx?: Tx): Promise<Row | null> {
  return getStore().findOneWhere(R_PRECOS(), { empresa_id: empresaId, produto_id: produtoId, canal }, tx);
}

/** Descobre o produto na loja por SKU (uma única chamada; [] quando não há). */
async function buscarPorSku(cfg: ConfigStore, sku: string): Promise<WooProduto[]> {
  const resposta = await wooStoreFetch<WooProduto[]>(cfg, `/products?sku=${encodeURIComponent(sku)}`);
  return Array.isArray(resposta) ? resposta : [];
}

function textoDescricao(produto: Row): string {
  return String(produto.descricao || produto.descricao_curta || produto.nome || '');
}

/** Nome do atributo de variação usado na loja (o mesmo do fluxo legado). */
const ATRIBUTO_TAMANHO = 'Tamanho';

/**
 * Publica UM produto (simples ou variável) na loja `cfg`.
 *
 * Devolve o `external_product_id`. Grava/atualiza os vínculos do produto e de
 * cada variação. NUNCA publica preço inválido e NUNCA transforma variável em
 * simples.
 */
export async function publicarProdutoNaLoja(
  cfg: ConfigStore,
  empresaId: number,
  produtoId: number,
  tx?: Tx
): Promise<{ external_product_id: string; external_variation_ids: string[]; dry_run: boolean }> {
  const s = getStore();
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: produtoId, empresa_id: empresaId }, tx);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  const sku = String(produto.sku || '').trim();
  if (!sku) throw new PublicacaoFalha('O produto não tem SKU — o WooCommerce identifica o item pelo SKU.');

  const filhos = await variacoesDoProduto(empresaId, produtoId, tx);
  const ehVariavel = filhos.length > 0 || String(produto.formato || '') === 'variacao';
  const ativo = produto.ativo !== false && produto.exibir_site !== false;
  const status = ativo ? 'publish' : 'private';

  const precoPai = precoDaLoja(produto, cfg.store_key, await linhaPreco(empresaId, produtoId, 'WOOCOMMERCE', tx));
  const invalido = validarPrecoPublicavel(precoPai, produto, cfg.store_key);
  // Produto variável pode não ter preço no pai (o preço vive na variação). Só
  // recusamos o pai simples sem preço; no variável, cada variação é validada.
  if (invalido && !ehVariavel) throw new PublicacaoFalha(invalido.mensagem);

  const tamanhos = await mapaTamanhos(tx);

  // --- Produto PAI / SIMPLES -------------------------------------------------
  let externalId: string | null = null;
  let dryRunResposta = false;
  const vinculo = await vinculoDoProduto(empresaId, cfg.store_key, produtoId, tx);
  if (vinculo) externalId = String(vinculo.external_product_id);
  if (!externalId) {
    const existentes = await buscarPorSku(cfg, sku);
    if (existentes.length) externalId = String(existentes[0].id);
  }

  const metadados: Record<string, unknown>[] = [];
  if (cfg.store_key === 'WHOLESALE') {
    metadados.push({ key: '_brobond_atacado_min_qtd', value: String(minimoAtacado(produto)) });
    metadados.push({ key: '_brobond_store_key', value: cfg.store_key });
  }

  if (ehVariavel) {
    const opcoes = filhos
      .map((f) => tamanhos.get(Number(f.variacao_tamanho_id)) ?? '')
      .filter((t): t is string => Boolean(t));
    const corpoPai: Record<string, unknown> = {
      name: String(produto.nome || sku),
      type: 'variable',
      status,
      sku,
      description: textoDescricao(produto),
      attributes: opcoes.length ? [{ name: ATRIBUTO_TAMANHO, variation: true, visible: true, options: [...new Set(opcoes)] }] : [],
      ...(metadados.length ? { meta_data: metadados } : {}),
    };
    if (externalId) {
      await wooStoreFetch(cfg, `/products/${externalId}`, { method: 'PUT', body: corpoPai });
    } else {
      const criado = await wooStoreFetch<WooProduto>(cfg, '/products', { method: 'POST', body: corpoPai });
      dryRunResposta = ehDryRun(criado);
      // Dry-run: nada foi criado na loja — não há ID externo para memorizar.
      // Gravar um vínculo vazio aqui envenenaria a memória da integração.
      if (dryRunResposta) return { external_product_id: '', external_variation_ids: [], dry_run: true };
      externalId = String(criado?.id ?? '');
      if (!externalId || externalId === 'undefined') {
        throw new PublicacaoFalha(`A loja ${cfg.store_key} não devolveu o id do produto criado.`);
      }
    }
    await registrarVinculo(empresaId, cfg.store_key, produtoId, { external_product_id: externalId!, sku, status: 'LINKED' }, tx);

    const externalVariationIds: string[] = [];
    for (const filho of filhos) {
      const id = await publicarVariacao(cfg, empresaId, Number(filho.id), externalId!, filho, tamanhos, tx);
      if (id) externalVariationIds.push(id);
    }
    return { external_product_id: externalId!, external_variation_ids: externalVariationIds, dry_run: dryRunResposta };
  }

  // Produto SIMPLES: preço e estoque vivem nele.
  const disponivel = await disponivelDoProduto(empresaId, produtoId, tx);
  const corpo: Record<string, unknown> = {
    name: String(produto.nome || sku),
    type: 'simple',
    status,
    sku,
    regular_price: precoPai.preco.toFixed(2),
    description: textoDescricao(produto),
    manage_stock: true,
    stock_quantity: Math.max(0, Math.trunc(disponivel)),
    ...(precoPai.promo != null ? { sale_price: precoPai.promo.toFixed(2) } : {}),
    ...(metadados.length ? { meta_data: metadados } : {}),
  };
  if (externalId) {
    await wooStoreFetch(cfg, `/products/${externalId}`, { method: 'PUT', body: corpo });
  } else {
    const criado = await wooStoreFetch<WooProduto>(cfg, '/products', { method: 'POST', body: corpo });
    dryRunResposta = ehDryRun(criado);
    if (dryRunResposta) return { external_product_id: '', external_variation_ids: [], dry_run: true };
    externalId = String(criado?.id ?? '');
    if (!externalId || externalId === 'undefined') {
      throw new PublicacaoFalha(`A loja ${cfg.store_key} não devolveu o id do produto criado.`);
    }
  }
  await registrarVinculo(empresaId, cfg.store_key, produtoId, { external_product_id: externalId!, sku, status: 'LINKED' }, tx);
  return { external_product_id: externalId!, external_variation_ids: [], dry_run: dryRunResposta };
}

/**
 * Publica UMA variação (filho do produto variável).
 *
 * Preço e estoque vêm DA VARIAÇÃO — nunca do pai. O SKU da variação é o do
 * filho; a loja costuma usar `<sku-pai>-<TAMANHO>` e as duas formas são
 * procuradas antes de criar.
 */
async function publicarVariacao(
  cfg: ConfigStore,
  empresaId: number,
  variacaoId: number,
  externalProductId: string,
  variacao: Row,
  tamanhos: Map<number, string>,
  tx?: Tx
): Promise<string | null> {
  const codigo = tamanhos.get(Number(variacao.variacao_tamanho_id)) ?? '';
  if (!codigo) return null; // variação sem tamanho não tem atributo — não inventamos
  const skuVariacao = String(variacao.sku || '').trim();
  const preco = precoDaLoja(variacao, cfg.store_key, await linhaPreco(empresaId, variacaoId, 'WOOCOMMERCE', tx));
  const invalido = validarPrecoPublicavel(preco, variacao, cfg.store_key);
  if (invalido) throw new PublicacaoFalha(`Variação ${skuVariacao || `#${variacaoId}`}: ${invalido.mensagem}`);
  const disponivel = await disponivelDoProduto(empresaId, variacaoId, tx);

  let externalVariationId: string | null = null;
  const vinculo = await vinculoDeVariacao(empresaId, cfg.store_key, variacaoId, tx);
  if (vinculo) externalVariationId = String(vinculo.external_variation_id);
  if (!externalVariationId) {
    const existentes = await wooStoreFetch<WooVariacao[]>(cfg, `/products/${externalProductId}/variations?per_page=100`);
    if (Array.isArray(existentes)) {
      const candidatos = new Set([skuVariacao, `${String(variacao.produto_pai_id ?? '')}-${codigo}`].filter(Boolean));
      const achado = existentes.find((v) => candidatos.has(String(v.sku || '').trim()));
      if (achado?.id) externalVariationId = String(achado.id);
    }
  }

  const corpo = {
    sku: skuVariacao || undefined,
    regular_price: preco.preco.toFixed(2),
    ...(preco.promo != null ? { sale_price: preco.promo.toFixed(2) } : {}),
    attributes: [{ name: ATRIBUTO_TAMANHO, option: codigo }],
    manage_stock: true,
    stock_quantity: Math.max(0, Math.trunc(disponivel)),
  };
  if (externalVariationId) {
    await wooStoreFetch(cfg, `/products/${externalProductId}/variations/${externalVariationId}`, { method: 'PUT', body: corpo });
  } else {
    const criada = await wooStoreFetch<WooVariacao>(cfg, `/products/${externalProductId}/variations`, { method: 'POST', body: corpo });
    // Dry-run: a variação não foi criada — não há ID externo para memorizar.
    if (ehDryRun(criada)) return null;
    externalVariationId = String(criada?.id ?? '');
    if (!externalVariationId || externalVariationId === 'undefined') {
      throw new PublicacaoFalha(`A loja ${cfg.store_key} não devolveu o id da variação ${skuVariacao || `#${variacaoId}`}.`);
    }
  }
  await registrarVinculo(
    empresaId,
    cfg.store_key,
    variacaoId,
    { external_product_id: externalProductId, external_variation_id: externalVariationId!, sku: skuVariacao, status: 'LINKED' },
    tx
  );
  return externalVariationId;
}

/** Disponível vendável do produto (físico − reservas), pelo motor canônico. */
async function disponivelDoProduto(empresaId: number, produtoId: number, tx?: Tx): Promise<number> {
  const linhas = await disponibilidadesPorTamanho(escopoDeSistema(empresaId), produtoId, tx);
  return linhas.reduce((soma, l) => soma + Math.max(0, Number(l.disponivel || 0)), 0);
}
