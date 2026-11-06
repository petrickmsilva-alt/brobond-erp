// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › RECONCILIAÇÃO ERP × LOJA.
//
// Compara o que o ERP tem com o que a LOJA realmente tem, por loja, e registra
// DIVERGÊNCIAS classificadas. Não é um sincronizador: NADA é excluído, nenhum
// preço canônico é sobrescrito por valor externo e nenhum pagamento é tocado.
//
// Dimensões:
//   • CATALOGO  — produto/vínculo/SKU/variação/publicação;
//   • PRECO     — preço externo divergente, ausente, inválido, de variação;
//   • ESTOQUE   — estoque informado na loja ≠ disponível vendável do ERP;
//   • PEDIDOS   — pedido na loja ausente no ERP, excluído, status/valor
//                 divergente, importação incompleta, sem correspondência.
//
// CLASSIFICAÇÃO (decide o destino, nunca o contrário):
//   LEGITIMA   — diferença esperada; informativa, não corrige;
//   AUTOMATICA — divergência corrigível com segurança pelo ERP;
//   HUMANA     — exige decisão de gente (excluir, desvincular, mudar SKU).
//
// A `fingerprint` é a IDENTIDADE LÓGICA da divergência: a mesma ocorrência
// reabre (se voltar) em vez de empilhar linhas; o que deixou de ser detectado é
// fechado como CORRIGIDA. Toda correção automática é auditada.
//
// Leitura externa usa o `fetch` injetável (`deps.fetch`) — os testes provam o
// comportamento sem tocar a rede; o código de produção usa o `fetch` global.
// ============================================================================
import { createHash } from 'node:crypto';
import { getStore } from '../../services';
import { getResource } from '../../resources';
import { HttpError } from '../../errors';
import type { Row } from '../../store';
import { escopoDeSistema } from '../../empresa';
import { disponibilidadesPorTamanho } from '../catalogo';
import { round2 } from '../regras';
import type { ConfigStore, StoreKey } from './registry';
import { dryRun } from './registry';
import { wooStoreFetch, ehDryRun } from './cliente';
import { listarVinculos } from './vinculos';
import { registrarSincronizacao } from './estado';
import { precoDaLoja } from './precos';
import { enfileirarPublicacaoDaLoja, enfileirarEstoqueDaLoja, enfileirarPedidosDaLoja } from './outboxStore';

const R_PRODUTOS = () => getResource('produtos')!;
const R_VENDAS = () => getResource('vendas')!;
const R_PRECOS = () => getResource('commerce_precos')!;
const R_DIVERGENCIAS = () => getResource('woocommerce_reconciliacao_divergencias')!;

export type CategoriaDivergencia = 'CATALOGO' | 'PRECO' | 'ESTOQUE' | 'PEDIDOS';
export type ClassificacaoDivergencia = 'LEGITIMA' | 'AUTOMATICA' | 'HUMANA';

export type DivergenciaDetectada = {
  categoria: CategoriaDivergencia;
  tipo: string;
  classificacao: ClassificacaoDivergencia;
  produto_id?: number | null;
  sku?: string | null;
  external_product_id?: string | null;
  external_variation_id?: string | null;
  pedido_ref?: string | null;
  detalhe: string;
  dados?: Record<string, unknown> | null;
};

export type ResultadoReconciliacao = {
  store_key: StoreKey;
  ok: boolean;
  detectadas: number;
  abertas: number;
  resolvidas: number;
  por_categoria: Record<string, number>;
  erro?: string;
};

type Deps = { fetch?: typeof fetch };

// ----------------------------------------------------------------------------
// PERSISTÊNCIA (idempotente por fingerprint)
// ----------------------------------------------------------------------------

function fingerprintDe(store: StoreKey, d: DivergenciaDetectada): string {
  const chave = [
    store,
    d.categoria,
    d.tipo,
    d.produto_id ?? '',
    d.external_product_id ?? '',
    d.external_variation_id ?? '',
    d.pedido_ref ?? '',
  ].join('|');
  return createHash('sha256').update(chave).digest('hex').slice(0, 48);
}

/**
 * Registra (ou reabre) uma divergência. Reabrir uma CORRIGIDA/IGNORADA que
 * voltou a existir é intencional: a correção não pode esconder uma recaída.
 */
export async function registrarDivergencia(
  empresaId: number,
  store: StoreKey,
  d: DivergenciaDetectada
): Promise<Row> {
  const s = getStore();
  const fingerprint = fingerprintDe(store, d);
  const base = {
    empresa_id: empresaId,
    store_key: store,
    categoria: d.categoria,
    tipo: d.tipo,
    classificacao: d.classificacao,
    produto_id: d.produto_id ?? null,
    sku: d.sku ?? null,
    external_product_id: d.external_product_id ?? null,
    external_variation_id: d.external_variation_id ?? null,
    pedido_ref: d.pedido_ref ?? null,
    detalhe: d.detalhe.slice(0, 1000),
    dados: d.dados ?? null,
    fingerprint,
  };
  const existente = await s.findOneWhere(R_DIVERGENCIAS(), { empresa_id: empresaId, store_key: store, fingerprint });
  if (existente) {
    const patch: Record<string, unknown> = { ...base, detectada_em: new Date().toISOString(), atualizado_em: new Date().toISOString() };
    if (String(existente.status) !== 'ABERTA') {
      patch.status = 'ABERTA';
      patch.resolucao = null;
      patch.resolvida_em = null;
    }
    return (await s.update(R_DIVERGENCIAS(), Number(existente.id), patch))!;
  }
  try {
    return await s.insert(R_DIVERGENCIAS(), { ...base, status: 'ABERTA', detectada_em: new Date().toISOString() });
  } catch (e) {
    const pg = e as { code?: string; cause?: { code?: string } };
    if (pg?.code === '23505' || pg?.cause?.code === '23505') {
      const linha = await s.findOneWhere(R_DIVERGENCIAS(), { empresa_id: empresaId, store_key: store, fingerprint });
      if (linha) return linha;
    }
    throw e;
  }
}

/**
 * Fecha como CORRIGIDA as divergências ABERTAS da loja (na categoria) que NÃO
 * foram detectadas nesta passagem — a inconsistência deixou de existir.
 */
export async function fecharDivergenciasAusentes(
  empresaId: number,
  store: StoreKey,
  categoria: CategoriaDivergencia,
  fingerprintsVistos: Set<string>
): Promise<number> {
  const s = getStore();
  const abertas = await s.list(R_DIVERGENCIAS(), {
    page: 1,
    pageSize: 5000,
    filter: { empresa_id: empresaId, store_key: store, categoria, status: 'ABERTA' },
  });
  let fechadas = 0;
  for (const linha of abertas.rows) {
    if (fingerprintsVistos.has(String(linha.fingerprint))) continue;
    await s.update(R_DIVERGENCIAS(), Number(linha.id), {
      status: 'CORRIGIDA',
      resolucao: 'Deixou de ser detectada na reconciliação.',
      resolvida_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    });
    fechadas += 1;
  }
  return fechadas;
}

/** Divergências de uma loja (para o painel). */
export async function listarDivergencias(
  empresaId: number,
  store: StoreKey,
  opcoes: { status?: string; categoria?: CategoriaDivergencia; pageSize?: number } = {}
): Promise<Row[]> {
  const filtro: Record<string, unknown> = { empresa_id: empresaId, store_key: store };
  if (opcoes.status) filtro.status = opcoes.status;
  if (opcoes.categoria) filtro.categoria = opcoes.categoria;
  const out = await getStore().list(R_DIVERGENCIAS(), {
    page: 1,
    pageSize: Math.min(5000, opcoes.pageSize ?? 1000),
    filter: filtro,
    sort: 'detectada_em',
    dir: 'desc',
  });
  return out.rows;
}

/** Contagem de divergências ABERTAS por categoria (métrica do painel). */
export async function contarDivergencias(empresaId: number, store: StoreKey): Promise<Record<string, number>> {
  const abertas = await listarDivergencias(empresaId, store, { status: 'ABERTA', pageSize: 5000 });
  const out: Record<string, number> = { CATALOGO: 0, PRECO: 0, ESTOQUE: 0, PEDIDOS: 0 };
  for (const d of abertas) {
    const c = String(d.categoria);
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

// ----------------------------------------------------------------------------
// LEITURA DA LOJA
// ----------------------------------------------------------------------------

type WooProduto = {
  id?: number;
  sku?: string;
  type?: string;
  status?: string;
  regular_price?: string;
  sale_price?: string;
  price?: string;
  stock_quantity?: number | null;
  manage_stock?: boolean;
  variations?: number[];
};
type WooVariacao = { id?: number; sku?: string; regular_price?: string; sale_price?: string; stock_quantity?: number | null };

function maxPaginas(): number {
  const n = Number(process.env.WOOCOMMERCE_RECONCILIACAO_MAX_PAGINAS);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 10;
}

/** Lê os produtos da loja em páginas (limitado; o excesso é reportado). */
async function lerProdutosLoja(cfg: ConfigStore, deps: Deps = {}): Promise<{ produtos: WooProduto[]; truncado: boolean }> {
  const produtos: WooProduto[] = [];
  const limite = maxPaginas();
  for (let pagina = 1; pagina <= limite; pagina++) {
    const lote = await wooStoreFetch<WooProduto[]>(
      cfg,
      `/products?per_page=100&page=${pagina}&status=any`,
      { fetch: deps.fetch }
    );
    if (ehDryRun(lote)) return { produtos: [], truncado: false };
    if (!Array.isArray(lote) || !lote.length) return { produtos, truncado: false };
    produtos.push(...lote);
    if (lote.length < 100) return { produtos, truncado: false };
  }
  return { produtos, truncado: true };
}

async function lerVariacoesLoja(cfg: ConfigStore, externalProductId: string, deps: Deps = {}): Promise<WooVariacao[]> {
  const resposta = await wooStoreFetch<WooVariacao[]>(cfg, `/products/${externalProductId}/variations?per_page=100`, { fetch: deps.fetch });
  return Array.isArray(resposta) ? resposta : [];
}

/** Preço do ERP para o produto na loja (base + promoção de canal vigente). */
async function precoErp(empresaId: number, produto: Row, store: StoreKey): Promise<number> {
  const linha = await getStore().findOneWhere(R_PRECOS(), { empresa_id: empresaId, produto_id: Number(produto.id), canal: 'WOOCOMMERCE' });
  return precoDaLoja(produto, store, linha).preco;
}

async function disponivelErp(empresaId: number, produtoId: number): Promise<number> {
  const linhas = await disponibilidadesPorTamanho(escopoDeSistema(empresaId), produtoId);
  return linhas.reduce((soma, l) => soma + Math.max(0, Number(l.disponivel || 0)), 0);
}

function precoLoja(p: { regular_price?: string; sale_price?: string }): number | null {
  const sale = Number(String(p.sale_price ?? '').replace(',', '.'));
  const regular = Number(String(p.regular_price ?? '').replace(',', '.'));
  const escolhido = Number.isFinite(sale) && sale > 0 ? sale : regular;
  return Number.isFinite(escolhido) && escolhido > 0 ? escolhido : null;
}

// ----------------------------------------------------------------------------
// RECONCILIAÇÃO DE CATÁLOGO + PREÇO + ESTOQUE
// ----------------------------------------------------------------------------

async function reconciliarCatalogoPrecoEstoque(
  cfg: ConfigStore,
  empresaId: number,
  deps: Deps,
  vistos: Record<CategoriaDivergencia, Set<string>>,
  detectadas: DivergenciaDetectada[]
): Promise<void> {
  const s = getStore();
  const store = cfg.store_key;
  const produtosErp = await s.list(R_PRODUTOS(), { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  const porId = new Map(produtosErp.rows.map((p) => [Number(p.id), p]));
  const vinculos = await listarVinculos(empresaId, store, { pageSize: 20000 });
  const { produtos: produtosLoja, truncado } = await lerProdutosLoja(cfg, deps);
  const externosPorId = new Map(produtosLoja.map((p) => [String(p.id), p]));

  const registrar = async (d: DivergenciaDetectada) => {
    detectadas.push(d);
    const fp = fingerprintDe(store, d);
    vistos[d.categoria].add(fp);
    await registrarDivergencia(empresaId, store, d);
  };

  // --- CATALOGO: vínculos que apontam para produto inexistente no ERP -------
  const idsComVinculo = new Set<number>();
  for (const v of vinculos) {
    const produtoId = Number(v.produto_id);
    idsComVinculo.add(produtoId);
    if (!porId.has(produtoId)) {
      await registrar({
        categoria: 'CATALOGO',
        tipo: 'VINCULO_ORFAO',
        classificacao: 'HUMANA',
        produto_id: produtoId,
        sku: v.sku ? String(v.sku) : null,
        external_product_id: v.external_product_id ? String(v.external_product_id) : null,
        external_variation_id: v.external_variation_id != null ? String(v.external_variation_id) : null,
        detalhe: 'Vínculo aponta para produto que não existe mais no ERP.',
      });
    }
  }

  // --- CATALOGO/PREÇO/ESTOQUE por produto vinculado -------------------------
  const variacaoIdsPorPai = new Map<string, Row[]>();
  for (const v of vinculos) {
    const produtoId = Number(v.produto_id);
    const produto = porId.get(produtoId);
    if (!produto) continue;
    const externalProductId = String(v.external_product_id);
    const ehVariacao = v.external_variation_id != null && String(v.external_variation_id) !== '';
    const sku = String(v.sku || produto.sku || '').trim();
    const externo = externosPorId.get(externalProductId) ?? null;

    if (!ehVariacao) {
      if (!externo) {
        await registrar({
          categoria: 'CATALOGO',
          tipo: 'PRODUTO_EXCLUIDO_EXTERNAMENTE',
          classificacao: 'HUMANA',
          produto_id: produtoId,
          sku,
          external_product_id: externalProductId,
          detalhe: `O produto vinculado (externo ${externalProductId}) não existe mais na loja ${store}. Republicar exige decisão humana.`,
        });
        continue;
      }
      const skuExterno = String(externo.sku || '').trim();
      if (skuExterno && sku && skuExterno.toUpperCase() !== sku.toUpperCase()) {
        await registrar({
          categoria: 'CATALOGO',
          tipo: 'SKU_DIVERGENTE',
          classificacao: 'HUMANA',
          produto_id: produtoId,
          sku,
          external_product_id: externalProductId,
          detalhe: `SKU divergente: ERP "${sku}" × loja "${skuExterno}".`,
          dados: { sku_erp: sku, sku_loja: skuExterno },
        });
      }
      const esperado = await precoErp(empresaId, produto, store);
      const atual = precoLoja(externo);
      if (atual == null) {
        await registrar({
          categoria: 'PRECO',
          tipo: 'PRECO_AUSENTE',
          classificacao: 'HUMANA',
          produto_id: produtoId,
          sku,
          external_product_id: externalProductId,
          detalhe: 'O anúncio está sem preço na loja — republicar exige decisão humana.',
        });
      } else if (round2(esperado) !== round2(atual)) {
        await registrar({
          categoria: 'PRECO',
          tipo: 'PRECO_DIVERGENTE',
          classificacao: 'AUTOMATICA',
          produto_id: produtoId,
          sku,
          external_product_id: externalProductId,
          detalhe: `Preço divergente na ${store}: ERP ${round2(esperado).toFixed(2)} × loja ${round2(atual).toFixed(2)}.`,
          dados: { preco_erp: round2(esperado), preco_loja: round2(atual) },
        });
      }
      if (externo.manage_stock) {
        const esperadoQtd = Math.max(0, Math.trunc(await disponivelErp(empresaId, produtoId)));
        const atualQtd = Math.max(0, Math.trunc(Number(externo.stock_quantity ?? 0)));
        if (esperadoQtd !== atualQtd) {
          await registrar({
            categoria: 'ESTOQUE',
            tipo: 'ESTOQUE_DIVERGENTE',
            classificacao: 'AUTOMATICA',
            produto_id: produtoId,
            sku,
            external_product_id: externalProductId,
            detalhe: `Estoque divergente na ${store}: ERP ${esperadoQtd} × loja ${atualQtd}.`,
            dados: { estoque_erp: esperadoQtd, estoque_loja: atualQtd },
          });
        }
      }
    } else {
      // Variação: agrupa por produto externo para ler as variações uma vez.
      const lista = variacaoIdsPorPai.get(externalProductId) ?? [];
      lista.push(v);
      variacaoIdsPorPai.set(externalProductId, lista);
    }
  }

  for (const [externalProductId, lista] of variacaoIdsPorPai) {
    const variacoes = await lerVariacoesLoja(cfg, externalProductId, deps);
    const porVariacaoId = new Map(variacoes.map((v) => [String(v.id), v]));
    const skus = variacoes.map((v) => String(v.sku || '').trim().toUpperCase()).filter(Boolean);
    const duplicados = skus.filter((sku, i) => skus.indexOf(sku) !== i);
    if (duplicados.length) {
      const primeira = lista[0];
      await registrar({
        categoria: 'CATALOGO',
        tipo: 'VARIACAO_DUPLICADA',
        classificacao: 'HUMANA',
        produto_id: Number(primeira.produto_id),
        sku: duplicados[0],
        external_product_id: externalProductId,
        detalhe: `SKU de variação duplicado na loja ${cfg.store_key}: ${[...new Set(duplicados)].join(', ')}.`,
      });
    }
    for (const v of lista) {
      const produtoId = Number(v.produto_id);
      const produto = porId.get(produtoId);
      const externalVariationId = String(v.external_variation_id);
      const sku = String(v.sku || produto?.sku || '').trim();
      const externa = porVariacaoId.get(externalVariationId);
      if (!externa) {
        await registrar({
          categoria: 'CATALOGO',
          tipo: 'VARIACAO_AUSENTE',
          classificacao: 'HUMANA',
          produto_id: produtoId,
          sku,
          external_product_id: externalProductId,
          external_variation_id: externalVariationId,
          detalhe: `A variação vinculada (externa ${externalVariationId}) não existe mais na loja.`,
        });
        continue;
      }
      if (produto) {
        const esperado = await precoErp(empresaId, produto, cfg.store_key);
        const atual = precoLoja(externa);
        if (atual != null && round2(esperado) !== round2(atual)) {
          await registrar({
            categoria: 'PRECO',
            tipo: 'PRECO_VARIACAO_DIVERGENTE',
            classificacao: 'AUTOMATICA',
            produto_id: produtoId,
            sku,
            external_product_id: externalProductId,
            external_variation_id: externalVariationId,
            detalhe: `Preço da variação divergente na ${cfg.store_key}: ERP ${round2(esperado).toFixed(2)} × loja ${round2(atual).toFixed(2)}.`,
            dados: { preco_erp: round2(esperado), preco_loja: round2(atual) },
          });
        }
        const esperadoQtd = Math.max(0, Math.trunc(await disponivelErp(empresaId, produtoId)));
        const atualQtd = Math.max(0, Math.trunc(Number(externa.stock_quantity ?? 0)));
        if (atualQtd !== esperadoQtd) {
          await registrar({
            categoria: 'ESTOQUE',
            tipo: 'ESTOQUE_DIVERGENTE',
            classificacao: 'AUTOMATICA',
            produto_id: produtoId,
            sku,
            external_product_id: externalProductId,
            external_variation_id: externalVariationId,
            detalhe: `Estoque da variação divergente na ${cfg.store_key}: ERP ${esperadoQtd} × loja ${atualQtd}.`,
            dados: { estoque_erp: esperadoQtd, estoque_loja: atualQtd },
          });
        }
      }
    }
  }

  // --- CATALOGO: produto visível no ERP sem vínculo nesta loja --------------
  for (const p of produtosErp.rows) {
    if (p.ativo === false || p.exibir_site === false) continue;
    const id = Number(p.id);
    if (idsComVinculo.has(id)) continue;
    await registrar({
      categoria: 'CATALOGO',
      tipo: 'PRODUTO_SEM_VINCULO',
      classificacao: 'AUTOMATICA',
      produto_id: id,
      sku: String(p.sku || '').trim() || null,
      detalhe: `Produto visível no site sem vínculo na loja ${store} — publicar é seguro (o ERP é a fonte).`,
    });
  }

  // --- CATALOGO: anúncio na loja sem correspondência no ERP -----------------
  const externosVinculados = new Set(vinculos.map((v) => String(v.external_product_id)));
  for (const externo of produtosLoja) {
    const idExterno = String(externo.id);
    if (externosVinculados.has(idExterno)) continue;
    await registrar({
      categoria: 'CATALOGO',
      tipo: 'PRODUTO_EXTERNO_SEM_VINCULO',
      classificacao: 'HUMANA',
      sku: String(externo.sku || '').trim() || null,
      external_product_id: idExterno,
      detalhe: `Anúncio (externo ${idExterno}) existe na loja ${store} sem correspondência no ERP. Nunca é excluído automaticamente.`,
    });
  }

  if (truncado) {
    await registrar({
      categoria: 'CATALOGO',
      tipo: 'RECONCILIACAO_TRUNCADA',
      classificacao: 'LEGITIMA',
      detalhe: `A loja ${store} tem mais produtos do que o limite lido (${maxPaginas()} páginas); a reconciliação cobriu apenas a parte lida.`,
    });
  }
}

// ----------------------------------------------------------------------------
// RECONCILIAÇÃO DE PEDIDOS
// ----------------------------------------------------------------------------

async function reconciliarPedidos(
  cfg: ConfigStore,
  empresaId: number,
  deps: Deps,
  vistos: Record<CategoriaDivergencia, Set<string>>,
  detectadas: DivergenciaDetectada[]
): Promise<void> {
  const s = getStore();
  const store = cfg.store_key;
  const registrar = async (d: DivergenciaDetectada) => {
    detectadas.push(d);
    vistos.PEDIDOS.add(fingerprintDe(store, d));
    await registrarDivergencia(empresaId, store, d);
  };

  // Pedidos recentes da loja (janela curta — a reconciliação de pedidos é
  // dirigida por divergência, não uma segunda importação).
  const janelaDias = 30;
  const depois = new Date(Date.now() - janelaDias * 86400_000).toISOString();
  const resposta = await wooStoreFetch<Row[]>(
    cfg,
    `/orders?per_page=100&page=1&orderby=date&order=desc&after=${encodeURIComponent(depois)}`,
    { fetch: deps.fetch }
  );
  if (ehDryRun(resposta) || !Array.isArray(resposta)) return;

  const prefixo = `WOO-${store}-`;
  for (const pedido of resposta) {
    const pedidoId = String((pedido as { id?: unknown }).id ?? '').trim();
    if (!pedidoId) continue;
    const referencia = `${prefixo}${pedidoId}`;
    const venda = await s.findOneWhere(R_VENDAS(), { empresa_id: empresaId, pedido_cliente: referencia });
    const statusExterno = String((pedido as { status?: unknown }).status ?? '').trim();
    if (!venda) {
      await registrar({
        categoria: 'PEDIDOS',
        tipo: 'PEDIDO_AUSENTE_NO_ERP',
        classificacao: 'AUTOMATICA',
        pedido_ref: referencia,
        detalhe: `Pedido ${referencia} existe na loja ${store} e ainda não foi importado.`,
        dados: { status_externo: statusExterno },
      });
      continue;
    }
    // Venda já importada: status/valor divergentes são REPORTADOS, nunca
    // aplicados (o ERP não altera pagamento nem cancela automaticamente).
    const totalErp = Number(venda.total ?? 0);
    const totalExterno = Number(String((pedido as { total?: unknown }).total ?? '').replace(',', '.'));
    if (Number.isFinite(totalExterno) && totalExterno > 0 && round2(totalExterno) !== round2(totalErp)) {
      await registrar({
        categoria: 'PEDIDOS',
        tipo: 'PEDIDO_VALOR_DIVERGENTE',
        classificacao: 'HUMANA',
        pedido_ref: referencia,
        detalhe: `Valor divergente em ${referencia}: ERP ${round2(totalErp).toFixed(2)} × loja ${round2(totalExterno).toFixed(2)}.`,
        dados: { total_erp: round2(totalErp), total_loja: round2(totalExterno) },
      });
    }
    if (statusExterno && ['cancelled', 'refunded', 'failed', 'trash'].includes(statusExterno)) {
      await registrar({
        categoria: 'PEDIDOS',
        tipo: 'PEDIDO_STATUS_DIVERGENTE',
        classificacao: 'HUMANA',
        pedido_ref: referencia,
        detalhe: `Pedido ${referencia} está "${statusExterno}" na loja. O ERP não cancela nem estorna automaticamente — decisão humana.`,
        dados: { status_externo: statusExterno },
      });
    }
  }
}

// ----------------------------------------------------------------------------
// ORQUESTRAÇÃO
// ----------------------------------------------------------------------------

/**
 * Reconciliação completa de UMA loja. Cada categoria é fechada
 * independentemente; a falha de uma loja nunca toca a outra (o chamador itera).
 */
export async function reconciliarLojaCompleta(
  cfg: ConfigStore,
  empresaId: number,
  deps: Deps = {}
): Promise<ResultadoReconciliacao> {
  const store = cfg.store_key;
  const vistos = { CATALOGO: new Set<string>(), PRECO: new Set<string>(), ESTOQUE: new Set<string>(), PEDIDOS: new Set<string>() };
  const detectadas: DivergenciaDetectada[] = [];
  let resolvidas = 0;

  await reconciliarCatalogoPrecoEstoque(cfg, empresaId, deps, vistos, detectadas);
  await reconciliarPedidos(cfg, empresaId, deps, vistos, detectadas);

  for (const categoria of ['CATALOGO', 'PRECO', 'ESTOQUE', 'PEDIDOS'] as CategoriaDivergencia[]) {
    resolvidas += await fecharDivergenciasAusentes(empresaId, store, categoria, vistos[categoria]);
  }

  const porCategoria: Record<string, number> = { CATALOGO: 0, PRECO: 0, ESTOQUE: 0, PEDIDOS: 0 };
  for (const d of detectadas) porCategoria[d.categoria] += 1;

  await registrarSincronizacao(empresaId, store, { ultima_reconciliacao_em: new Date().toISOString(), erro: null });
  await getStore()
    .audit({
      usuario_id: null,
      usuario: 'WooCommerce multi-store',
      acao: 'editar',
      recurso: 'woocommerce_reconciliacao_divergencias',
      registro_id: null,
      descricao: `Reconciliação da loja ${store}: ${detectadas.length} divergência(s), ${resolvidas} resolvida(s)`,
      dados: { store_key: store, por_categoria: porCategoria, resolvidas },
      empresa_id: empresaId,
    })
    .catch(() => undefined);

  const abertas = await contarDivergencias(empresaId, store);
  return {
    store_key: store,
    ok: true,
    detectadas: detectadas.length,
    abertas: Object.values(abertas).reduce((s, n) => s + n, 0),
    resolvidas,
    por_categoria: porCategoria,
  };
}

/** Reconciliação de todas as lojas — a falha de uma não interrompe a outra. */
export async function reconciliarTodasLojas(
  lojas: { cfg: ConfigStore; empresaId: number }[],
  deps: Deps = {}
): Promise<ResultadoReconciliacao[]> {
  const out: ResultadoReconciliacao[] = [];
  for (const { cfg, empresaId } of lojas) {
    try {
      out.push(await reconciliarLojaCompleta(cfg, empresaId, deps));
    } catch (e) {
      const mensagem = e instanceof HttpError ? e.message : 'Falha na reconciliação da loja.';
      await registrarSincronizacao(empresaId, cfg.store_key, { erro: mensagem }).catch(() => undefined);
      out.push({ store_key: cfg.store_key, ok: false, detectadas: 0, abertas: 0, resolvidas: 0, por_categoria: {}, erro: mensagem });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// CORREÇÃO CONTROLADA
// ----------------------------------------------------------------------------

export type ResultadoCorrecao = { ok: boolean; acao: string; mensagem: string; evento_id?: number };

/**
 * Corrige UMA divergência AUTOMATICA. Nunca corrige divergência HUMANA nem
 * LEGITIMA — essas exigem decisão de gente. A correção NÃO escreve na loja
 * aqui: ela ENFILEIRA o trabalho (outbox), que respeita dry-run, retry e
 * backoff. Toda correção é auditada.
 */
export async function corrigirDivergencia(
  empresaId: number,
  store: StoreKey,
  divergenciaId: number,
  actor: { id: number | null; name: string }
): Promise<ResultadoCorrecao> {
  const s = getStore();
  const div = await s.findOneWhere(R_DIVERGENCIAS(), { id: divergenciaId, empresa_id: empresaId, store_key: store });
  if (!div) throw new HttpError(404, 'Divergência não encontrada nesta loja.');
  if (String(div.status) !== 'ABERTA') throw new HttpError(409, 'Divergência já resolvida.');
  const classificacao = String(div.classificacao);
  if (classificacao !== 'AUTOMATICA') {
    throw new HttpError(409, `Divergência ${div.tipo} exige decisão humana — o ERP não corrige automaticamente.`);
  }

  const categoria = String(div.categoria);
  let acao = '';
  let eventoId: number | undefined;
  if (categoria === 'PRECO' || categoria === 'CATALOGO') {
    const produtoId = Number(div.produto_id);
    if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(409, 'Divergência sem produto para republicar.');
    const evento = await enfileirarPublicacaoDaLoja(empresaId, store, produtoId);
    eventoId = Number(evento.id);
    acao = 'publicacao';
  } else if (categoria === 'ESTOQUE') {
    const evento = await enfileirarEstoqueDaLoja(empresaId, store);
    eventoId = Number(evento.id);
    acao = 'estoque';
  } else if (categoria === 'PEDIDOS') {
    const evento = await enfileirarPedidosDaLoja(empresaId, store);
    eventoId = Number(evento.id);
    acao = 'pedidos';
  } else {
    throw new HttpError(409, 'Categoria de divergência sem correção automática.');
  }

  await s.update(R_DIVERGENCIAS(), Number(div.id), {
    status: 'CORRIGIDA',
    resolucao: `Correção automática enfileirada (${acao}).`,
    resolvida_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  });
  await s
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'woocommerce_reconciliacao_divergencias',
      registro_id: Number(div.id),
      descricao: `Divergência ${div.tipo} corrigida automaticamente na loja ${store} (${acao})`,
      dados: { store_key: store, tipo: div.tipo, categoria, evento_id: eventoId, dry_run: dryRun() },
      empresa_id: empresaId,
    })
    .catch(() => undefined);

  return {
    ok: true,
    acao,
    mensagem: dryRun()
      ? 'Correção enfileirada em modo de homologação (nenhuma escrita na loja).'
      : 'Correção enfileirada; a loja será atualizada pelo worker.',
    evento_id: eventoId,
  };
}
