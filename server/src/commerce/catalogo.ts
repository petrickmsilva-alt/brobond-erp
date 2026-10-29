// ============================================================================
// COMMERCE OS — CATÁLOGO MULTICANAL + FILA DE PUBLICAÇÃO.
//
// • Lista/detalhe do catálogo omnichannel lendo o CANÔNICO (produtos + preço
//   por canal + disponibilidade do motor de estoque — somente leitura);
// • projeção da vitrine (commerce_produtos) com slug estável;
// • fila de publicação com idempotência (empresa, produto, canal, versão) e
//   máquina de estados DRAFT → QUEUED → PUBLISHING → PUBLISHED/ERROR/REJECTED;
// • processadores REAIS por canal:
//     - BROBOND      → a própria vitrine (publicar = row PUBLISHED + slug);
//     - WOOCOMMERCE  → REST oficial (wooFetch de loja.ts — mesma integração);
//     - MERCADOLIVRE → API oficial com o token do conector;
//     - NUVEMSHOP    → API oficial com o token do conector;
//     - INSTAGRAM    → REJECTED honesto (Graph API não publica item individual).
// PUBLISHED NUNCA é marcado sem confirmação da API externa.
// ============================================================================
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { HttpError } from '../errors';
import { getStore, checkAccess, checkFluxoEscrita } from '../services';
import { currentUser } from '../auth';
import { escopoDoAtor, escopoDeSistema, empresaDoRegistroAudit, type EscopoEmpresa } from '../empresa';
import { getResource } from '../resources';
import { configLoja, wooFetch } from '../loja';
import { celulasDaEmpresa, locaisDeSaida, reservadoDaCelula, reservasAtivasPorCelula } from '../estoqueCanonico';
import { attachImages } from '../uploads';
import { gradeTamanhosDoProduto, nomesProdutos } from './grade';
import type { Row, Tx } from '../store';
import {
  CANAIS_PUBLICACAO,
  MAX_TENTATIVAS,
  backoffMs,
  precoEfetivo,
  slugUnico,
  slugify,
  vigenciaEstaAtiva,
  type CanalPublicacao,
} from './regras';

const R_PROD_COM = () => getResource('commerce_produtos')!;
const R_PRECOS = () => getResource('commerce_precos')!;
const R_PUBLICACOES = () => getResource('commerce_publicacoes')!;
const R_PRODUTOS = () => getResource('produtos')!;

// ----------------------------------------------------------------------------
// Erros de publicação (mensagem SEM token/segredo — só o essencial)
// ----------------------------------------------------------------------------

export class PublicacaoFalha extends Error {
  readonly rejeitada: boolean;
  constructor(mensagem: string, rejeitada = false) {
    super(mensagem);
    this.name = 'PublicacaoFalha';
    this.rejeitada = rejeitada;
  }
}

function sanitizarErro(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/(Bearer\s+|X-Auth-Token['"]?\s*[:=]\s*)[A-Za-z0-9._-]+/gi, '$1***').replace(/\s+/g, ' ').slice(0, 400);
}

const TIMEOUT_PUBLICACAO = 15_000;

async function chamarApi(url: string, init: RequestInit): Promise<any> {
  let resp: globalThis.Response;
  try {
    resp = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_PUBLICACAO) });
  } catch (e) {
    throw new PublicacaoFalha(`Falha de rede ao falar com o canal: ${sanitizarErro(e)}`);
  }
  const texto = await resp.text();
  if (!resp.ok) {
    throw new PublicacaoFalha(`O canal respondeu ${resp.status}: ${texto.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Disponibilidade canônica (somente leitura — a mesma regra de quem vende)
// ----------------------------------------------------------------------------

type DisponivelPorCelula = Awaited<ReturnType<typeof prepararDisponibilidade>>;

/**
 * Uma única leitura de células + reservas + locais de saída para responder
 * disponibilidade de VÁRIOS produtos sem N+1 (locais candidatos = local
 * preferido + padrão, exatamente como o faturamento escolhe).
 */
async function prepararDisponibilidade(escopo: EscopoEmpresa, tx?: Tx) {
  const [celulas, reservas, { candidatos }] = await Promise.all([
    celulasDaEmpresa(escopo, tx),
    reservasAtivasPorCelula(escopo, {}, tx),
    locaisDeSaida(escopo, null, tx),
  ]);
  const localIds = candidatos.map((l) => l.id);
  const chavesLocal = new Set(localIds.map(String));
  return { celulas, reservas, candidatos, localIds, chavesLocal };
}

/**
 * Disponível do produto = Σ_tamanho do MELHOR local candidato
 * (mesma quantidade que UMA venda conseguiria baixar agora).
 */
function disponivelDoProduto(ctx: DisponivelPorCelula, produtoId: number): number {
  const porTamanho = new Map<string, Map<number, number>>();
  for (const c of ctx.celulas) {
    if (Number(c.produto_id) !== produtoId) continue;
    if (c.local_id == null || !ctx.chavesLocal.has(String(c.local_id))) continue;
    const tam = c.tamanho_id == null ? 0 : Number(c.tamanho_id);
    const locais = porTamanho.get(String(tam)) ?? new Map<number, number>();
    const disponivel = Math.max(0, c.quantidade - reservadoDaCelula(ctx.reservas, produtoId, c.tamanho_id, Number(c.local_id)));
    locais.set(Number(c.local_id), Math.max(locais.get(Number(c.local_id)) ?? 0, disponivel));
    porTamanho.set(String(tam), locais);
  }
  let total = 0;
  for (const locais of porTamanho.values()) {
    let melhor = 0;
    for (const qtd of locais.values()) melhor = Math.max(melhor, qtd);
    total += melhor;
  }
  return total;
}

/** Disponibilidade por tamanho do produto, com código do tamanho. */
export async function disponibilidadesPorTamanho(
  escopo: EscopoEmpresa,
  produtoId: number,
  tx?: Tx
): Promise<{ tamanho_id: number | null; codigo: string | null; fisico: number; disponivel: number; local: string | null }[]> {
  const s = getStore();
  const ctx = await prepararDisponibilidade(escopo, tx);
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: produtoId, empresa_id: escopo.empresaId }, tx);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');

  const tamanhos = new Set<number | null>();
  if (produto.grade_id) for (const t of await gradeTamanhosDoProduto(Number(produto.grade_id), tx)) tamanhos.add(t);
  for (const c of ctx.celulas) if (Number(c.produto_id) === produtoId) tamanhos.add(c.tamanho_id == null ? null : Number(c.tamanho_id));
  if (!tamanhos.size) tamanhos.add(null);

  const codigos = new Map<number, string>();
  if ([...tamanhos].some((t) => t != null)) {
    const lista = await s.list(getResource('tamanhos')!, { page: 1, pageSize: 5000 }, tx);
    for (const t of lista.rows) codigos.set(Number(t.id), String(t.codigo || ''));
  }

  const nomeLocal = new Map(ctx.candidatos.map((l) => [l.id, l.nome]));
  return [...tamanhos]
    .sort((a, b) => (a ?? -1) - (b ?? -1))
    .map((tamanhoId) => {
      const doTamanho = ctx.celulas.filter(
        (c) => Number(c.produto_id) === produtoId && (c.tamanho_id == null ? null : Number(c.tamanho_id)) === tamanhoId
      );
      const fisico = doTamanho.reduce((soma, c) => soma + c.quantidade, 0);
      let melhor = { qtd: 0, local: null as number | null };
      for (const c of doTamanho) {
        if (c.local_id == null || !ctx.chavesLocal.has(String(c.local_id))) continue;
        const qtd = Math.max(0, c.quantidade - reservadoDaCelula(ctx.reservas, produtoId, c.tamanho_id, Number(c.local_id)));
        if (qtd > melhor.qtd) melhor = { qtd, local: Number(c.local_id) };
      }
      return {
        tamanho_id: tamanhoId,
        codigo: tamanhoId == null ? null : codigos.get(tamanhoId) ?? null,
        fisico,
        disponivel: melhor.qtd,
        local: melhor.local != null ? nomeLocal.get(melhor.local) ?? null : null,
      };
    });
}

/** Disponível total do produto (soma dos tamanhos, melhor local de cada). */
export async function disponivelTotalProduto(escopo: EscopoEmpresa, produtoId: number, tx?: Tx): Promise<number> {
  const ctx = await prepararDisponibilidade(escopo, tx);
  return disponivelDoProduto(ctx, produtoId);
}

// ----------------------------------------------------------------------------
// Preço efetivo por canal (base produtos.preco_venda + linha vigente)
// ----------------------------------------------------------------------------

export async function precosDoProduto(empresaId: number, produtoId: number, tx?: Tx): Promise<Row[]> {
  const s = getStore();
  const out = await s.list(R_PRECOS(), { page: 1, pageSize: 100, filter: { empresa_id: empresaId, produto_id: produtoId } }, tx);
  return out.rows;
}

function precoEfetivoDeProduto(base: number, linha: Row | undefined | null): { preco: number; promo: number | null; origem: 'canal' | 'base' } {
  if (!linha) return precoEfetivo({ base });
  return precoEfetivo({
    base,
    precoCanal: Number(linha.preco ?? 0),
    precoPromoCanal: linha.preco_promo != null ? Number(linha.preco_promo) : null,
    vigenciaInicio: (linha.vigencia_inicio as string | null) ?? null,
    vigenciaFim: (linha.vigencia_fim as string | null) ?? null,
  });
}

export async function precoNoCanal(
  empresaId: number,
  produtoId: number,
  canal: CanalPublicacao | string,
  tx?: Tx
): Promise<{ preco: number; promo: number | null; origem: 'canal' | 'base' }> {
  const s = getStore();
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: produtoId, empresa_id: empresaId }, tx);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  const linha = await s.findOneWhere(R_PRECOS(), { empresa_id: empresaId, produto_id: produtoId, canal }, tx);
  return precoEfetivoDeProduto(Number(produto.preco_venda ?? 0), linha);
}

// ----------------------------------------------------------------------------
// Payload da publicação (conteúdo efetivo do anúncio)
// ----------------------------------------------------------------------------

export type PayloadPublicacao = {
  sku: string;
  titulo: string;
  resumo: string | null;
  descricao: string;
  slug: string;
  preco: number;
  preco_promo: number | null;
  condicao: string;
  ativo: boolean;
  destaque: boolean;
  disponivel: number;
  metadados: Record<string, unknown>;
};

export function normalizarMetadados(bruto: unknown): Record<string, unknown> {
  if (!bruto) return {};
  if (typeof bruto === 'object' && !Array.isArray(bruto)) return { ...(bruto as Record<string, unknown>) };
  if (typeof bruto === 'string') {
    try {
      const parsed = JSON.parse(bruto);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* metadado corrompido vira objeto vazio — a publicação dirá o que falta */
    }
  }
  return {};
}

export async function montarPayloadPublicacao(
  empresaId: number,
  produtoId: number,
  canal: CanalPublicacao,
  tx?: Tx
): Promise<PayloadPublicacao> {
  const s = getStore();
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: produtoId, empresa_id: empresaId }, tx);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  const projecao = await s.findOneWhere(R_PROD_COM(), { empresa_id: empresaId, produto_id: produtoId }, tx);
  const linhaPreco = await s.findOneWhere(R_PRECOS(), { empresa_id: empresaId, produto_id: produtoId, canal }, tx);
  const preco = precoEfetivoDeProduto(Number(produto.preco_venda ?? 0), linhaPreco);
  const escopo = escopoDeSistema(empresaId);
  const disponivel = await disponivelTotalProduto(escopo, produtoId, tx);
  return {
    sku: String(produto.sku || ''),
    titulo: String(produto.nome || ''),
    resumo: projecao?.resumo ? String(projecao.resumo) : produto.descricao_curta ? String(produto.descricao_curta) : null,
    descricao: String(produto.descricao || produto.descricao_curta || ''),
    slug: projecao ? String(projecao.slug) : slugify(String(produto.nome || `produto-${produtoId}`)),
    preco: preco.preco,
    preco_promo: preco.promo,
    condicao: String(produto.condicao || 'novo'),
    ativo: produto.ativo !== false,
    destaque: produto.destaque === true,
    disponivel,
    metadados: normalizarMetadados(projecao?.canal_metadados),
  };
}

function hashPayload(payload: PayloadPublicacao): string {
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

// ----------------------------------------------------------------------------
// Fila de publicação — idempotência e transições
// ----------------------------------------------------------------------------

const ESTADOS_PIPELINE = new Set(['DRAFT', 'READY', 'QUEUED', 'PUBLISHING', 'UPDATE_QUEUED']);

/**
 * Enfileira (ou atualiza) a publicação de (empresa, produto, canal).
 * Idempotente: versão nova só quando não há nada no pipeline; payload igual não
 * enfileira de novo (hash) — o índice único parcial do banco reforça a trava.
 */
export async function enfileirarPublicacao(
  empresaId: number,
  produtoId: number,
  canal: CanalPublicacao,
  payload: PayloadPublicacao,
  criadoPor: number | null,
  tx?: Tx
): Promise<Row> {
  const s = getStore();
  const hash = hashPayload(payload);
  const existentes = await s.list(
    R_PUBLICACOES(),
    { page: 1, pageSize: 500, filter: { empresa_id: empresaId, produto_id: produtoId, canal } },
    tx
  );
  const ativa = existentes.rows.find((r) => ESTADOS_PIPELINE.has(String(r.estado))) ?? null;
  if (ativa) {
    if (String(ativa.payload_hash || '') === hash) return ativa;
    return (await s.update(
      R_PUBLICACOES(),
      Number(ativa.id),
      {
        payload,
        payload_hash: hash,
        estado: String(ativa.estado) === 'PUBLISHING' ? 'PUBLISHING' : 'QUEUED',
        proxima_tentativa_em: new Date().toISOString(),
      },
      tx
    ))!;
  }
  let versao = 0;
  for (const r of existentes.rows) versao = Math.max(versao, Number(r.versao || 0));
  try {
    return await s.insert(
      R_PUBLICACOES(),
      {
        empresa_id: empresaId,
        produto_id: produtoId,
        canal,
        versao: versao + 1,
        estado: 'QUEUED',
        payload,
        payload_hash: hash,
        tentativas: 0,
        proxima_tentativa_em: new Date().toISOString(),
        criado_por: criadoPor,
      },
      tx
    );
  } catch (e: any) {
    // Corrida determinística: duas enfileiramentos simultâneos calcularam a
    // MESMA versão e o índice único (empresa+produto+canal+versão) arbitrou.
    // Idempotência manda devolver a linha que venceu — nunca 500 nem duplicata.
    if (e?.code !== '23505' && e?.cause?.code !== '23505') throw e;
    const deNovo = await s.list(
      R_PUBLICACOES(),
      { page: 1, pageSize: 500, filter: { empresa_id: empresaId, produto_id: produtoId, canal } },
      tx
    );
    const ativaDepois = deNovo.rows.find((r) => ESTADOS_PIPELINE.has(String(r.estado))) ?? null;
    if (ativaDepois) return ativaDepois;
    const ultima = [...deNovo.rows].sort((a, b) => Number(b.versao || 0) - Number(a.versao || 0))[0];
    if (ultima) return ultima;
    throw e;
  }
}

/**
 * Processa UMA publicação reivindicando o estado (tryUpdateIf → PUBLISHING):
 * duas varreduras simultâneas nunca publicam duas vezes a mesma linha.
 */
export async function processarPublicacao(
  linha: Row
): Promise<'processada' | 'ignorada' | 'falhou' | 'rejeitada'> {
  const s = getStore();
  const id = Number(linha.id);
  const estado = String(linha.estado);
  const devido =
    estado === 'ERROR' &&
    (linha.proxima_tentativa_em == null || Date.parse(String(linha.proxima_tentativa_em)) <= Date.now());
  const elegivel = estado === 'QUEUED' || estado === 'UPDATE_QUEUED' || estado === 'READY' || devido;
  if (!elegivel) return 'ignorada';

  const reivindicada = await s.tryUpdateIf(
    R_PUBLICACOES(),
    id,
    { estado },
    { estado: 'PUBLISHING', atualizado_em: new Date().toISOString() }
  );
  if (!reivindicada) return 'ignorada';

  const canal = String(linha.canal) as CanalPublicacao;
  const empresaId = Number(linha.empresa_id);
  const produtoId = Number(linha.produto_id);
  try {
    const payload = (
      reivindicada.payload && typeof reivindicada.payload === 'object'
        ? reivindicada.payload
        : await montarPayloadPublicacao(empresaId, produtoId, canal)
    ) as PayloadPublicacao;
    const externalId = await publicarNoCanal(empresaId, canal, payload);
    await s.update(R_PUBLICACOES(), id, {
      estado: 'PUBLISHED',
      external_id: externalId,
      ultimo_erro: null,
      publicado_em: new Date().toISOString(),
      tentativas: Number(reivindicada.tentativas || 0) + 1,
      proxima_tentativa_em: null,
    });
    return 'processada';
  } catch (e) {
    const rejeitada = e instanceof PublicacaoFalha && e.rejeitada;
    const tentativas = Number(reivindicada.tentativas || 0) + 1;
    const esgotou = tentativas >= MAX_TENTATIVAS;
    const mensagem = sanitizarErro(e);
    await s.update(R_PUBLICACOES(), id, {
      estado: rejeitada ? 'REJECTED' : 'ERROR',
      ultimo_erro: esgotou && !rejeitada ? `Tentativas esgotadas (${MAX_TENTATIVAS}): ${mensagem}` : mensagem,
      tentativas,
      proxima_tentativa_em: rejeitada || esgotou ? null : new Date(Date.now() + backoffMs(tentativas)).toISOString(),
    });
    return rejeitada ? 'rejeitada' : 'falhou';
  }
}

/** Varredura da fila (cron/rotina): processa o que está pronto, com limite. */
export async function processarFilaPublicacoes(limite = 20): Promise<{ processadas: number; falhas: number }> {
  const s = getStore();
  const candidatas: Row[] = [];
  for (const estado of ['QUEUED', 'UPDATE_QUEUED', 'READY'] as const) {
    const out = await s.list(R_PUBLICACOES(), { page: 1, pageSize: limite, filter: { estado }, sort: 'id', dir: 'asc' });
    candidatas.push(...out.rows);
  }
  const erros = await s.list(R_PUBLICACOES(), { page: 1, pageSize: limite * 2, filter: { estado: 'ERROR' }, sort: 'id', dir: 'asc' });
  const agora = Date.now();
  for (const r of erros.rows) {
    const proxima = r.proxima_tentativa_em ? Date.parse(String(r.proxima_tentativa_em)) : null;
    if (proxima != null && proxima <= agora) candidatas.push(r);
  }
  let processadas = 0;
  let falhas = 0;
  for (const linha of candidatas.slice(0, limite)) {
    const r = await processarPublicacao(linha).catch(() => 'falhou' as const);
    if (r === 'processada') processadas += 1;
    if (r === 'falhou') falhas += 1;
  }
  return { processadas, falhas };
}

// ----------------------------------------------------------------------------
// Processadores por canal
// ----------------------------------------------------------------------------

async function publicarNoCanal(empresaId: number, canal: CanalPublicacao, payload: PayloadPublicacao): Promise<string> {
  switch (canal) {
    case 'BROBOND':
      // A vitrine LÊ destas linhas: PUBLISHED + slug É a publicação real.
      if (!payload.ativo) throw new PublicacaoFalha('Produto inativo no cadastro — ative-o antes de publicar.');
      if (!payload.slug) throw new PublicacaoFalha('Produto sem slug na vitrine — projete-o antes de publicar.');
      return payload.slug;

    case 'INSTAGRAM_SHOPPING':
      throw new PublicacaoFalha(
        'Instagram Shopping não publica itens individuais por esta API: gerencie o item pelo catálogo Meta vinculado ao conector. As vendas do canal continuam ingeridas normalmente em INSTAGRAM_SHOPPING.',
        true
      );

    case 'WOOCOMMERCE':
      return publicarWooCommerce(payload);

    case 'MERCADOLIVRE':
      return publicarMercadoLivre(empresaId, payload);

    case 'NUVEMSHOP':
      return publicarNuvemshop(empresaId, payload);

    default:
      throw new PublicacaoFalha(`Canal de publicação não suportado: ${canal}.`, true);
  }
}

// --- WooCommerce (mesma integração/env do módulo loja) -----------------------

async function publicarWooCommerce(payload: PayloadPublicacao): Promise<string> {
  const cfg = configLoja();
  if (!cfg) {
    throw new PublicacaoFalha('WooCommerce não configurado (WOOCOMMERCE_URL, WOOCOMMERCE_CK e WOOCOMMERCE_CS).');
  }
  if (!payload.sku) throw new PublicacaoFalha('O produto não tem SKU — o WooCommerce identifica itens pelo SKU.');
  const precoTexto = payload.preco.toFixed(2);
  const existentes = await wooFetch(cfg, `/products?sku=${encodeURIComponent(payload.sku)}`);
  if (Array.isArray(existentes) && existentes.length) {
    const item = existentes[0] as { id?: unknown; type?: string };
    const id = Number(item.id);
    if (item.type === 'variable') {
      // Em produto variável o preço vive na variação: aplica o preço vigente
      // em cada variação existente deste pai.
      const variacoes = await wooFetch(cfg, `/products/${id}/variations?per_page=100`);
      if (Array.isArray(variacoes)) {
        for (const v of variacoes as { id?: unknown }[]) {
          await wooFetch(cfg, `/products/${id}/variations/${Number(v.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ regular_price: precoTexto }),
          });
        }
      }
      return String(id);
    }
    await wooFetch(cfg, `/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: payload.titulo,
        regular_price: precoTexto,
        description: payload.descricao || payload.resumo || payload.titulo,
        status: payload.ativo ? 'publish' : 'private',
        manage_stock: true,
        stock_quantity: Math.max(0, Math.trunc(payload.disponivel)),
      }),
    });
    return String(id);
  }
  const criado = await wooFetch(cfg, '/products', {
    method: 'POST',
    body: JSON.stringify({
      name: payload.titulo,
      type: 'simple',
      status: payload.ativo ? 'publish' : 'private',
      regular_price: precoTexto,
      sku: payload.sku,
      description: payload.descricao || payload.resumo || payload.titulo,
      manage_stock: true,
      stock_quantity: Math.max(0, Math.trunc(payload.disponivel)),
    }),
  });
  const id = criado && typeof criado === 'object' ? Number((criado as { id?: unknown }).id) : NaN;
  if (!Number.isFinite(id) || id <= 0) throw new PublicacaoFalha('O WooCommerce não devolveu o id do produto criado.');
  return String(id);
}

// --- Conectores oficiais (token real por tenant) -----------------------------

async function tokenDoConector(
  empresaId: number,
  provider: 'MERCADOLIVRE' | 'NUVEMSHOP'
): Promise<{ accessToken: string; shopId: string | null }> {
  const { getConnectorDatabase } = await import('../../../modules/connectors/core/database');
  let db;
  try {
    db = getConnectorDatabase();
  } catch {
    throw new PublicacaoFalha('Conectores exigem PostgreSQL — o modo demonstração não publica em marketplaces.');
  }
  const { rows } = await db.query<{ access_token: string | null; shop_id: string | null }>(
    `SELECT access_token, shop_id FROM connectors
      WHERE empresa_id = $1 AND provider = $2 AND status = 'CONNECTED'
      ORDER BY id LIMIT 1`,
    [empresaId, provider]
  );
  const row = rows[0];
  if (!row?.access_token) {
    throw new PublicacaoFalha(`Canal ${provider} não conectado: conecte-o em Commerce → Canais antes de publicar.`);
  }
  return { accessToken: String(row.access_token), shopId: row.shop_id ? String(row.shop_id) : null };
}

async function publicarMercadoLivre(empresaId: number, payload: PayloadPublicacao): Promise<string> {
  const { accessToken } = await tokenDoConector(empresaId, 'MERCADOLIVRE');
  const categoria = String(payload.metadados.ml_category_id || '').trim();
  if (!categoria) {
    throw new PublicacaoFalha(
      'Categoria do Mercado Livre ausente: informe ml_category_id nos metadados do produto (ex.: MLB1234567) — o anúncio não é criado sem categoria.'
    );
  }
  const listingType = String(payload.metadados.ml_listing_type_id || '').trim();
  const item = await chamarApi('https://api.mercadolibre.com/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: payload.titulo.slice(0, 60),
      category_id: categoria,
      condition: payload.condicao === 'usado' ? 'used' : 'new',
      currency_id: 'BRL',
      price: payload.preco,
      available_quantity: Math.max(0, Math.trunc(payload.disponivel)),
      buying_mode: 'buy_it_now',
      ...(listingType ? { listing_type_id: listingType } : {}),
      free_shipping: { mode: 'not_allowed' },
      ...(payload.sku ? { seller_custom_field: payload.sku, attributes: [{ id: 'SELLER_SKU', value_name: payload.sku }] } : {}),
      ...(payload.descricao ? { description: payload.descricao } : {}),
    }),
  });
  const id = item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '') : '';
  if (!id) throw new PublicacaoFalha('O Mercado Livre não devolveu o id do anúncio.');
  return id;
}

async function publicarNuvemshop(empresaId: number, payload: PayloadPublicacao): Promise<string> {
  const { accessToken, shopId } = await tokenDoConector(empresaId, 'NUVEMSHOP');
  if (!shopId) throw new PublicacaoFalha('Conexão Nuvemshop sem shop_id — reconecte o canal.');
  const criado = await chamarApi(`https://api.nuvemshop.com.br/v1/${encodeURIComponent(shopId)}/products`, {
    method: 'POST',
    headers: { 'X-Auth-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: payload.titulo,
      description: payload.descricao || payload.resumo || payload.titulo,
      price: payload.preco,
      ...(payload.sku ? { sku: payload.sku } : {}),
      stock: Math.max(0, Math.trunc(payload.disponivel)),
      status: payload.ativo ? 'open' : 'closed',
    }),
  });
  const id = criado && typeof criado === 'object' ? String((criado as { id?: unknown }).id ?? '') : '';
  if (!id) throw new PublicacaoFalha('A Nuvemshop não devolveu o id do produto.');
  return id;
}

// ----------------------------------------------------------------------------
// Handlers HTTP (autenticados)
// ----------------------------------------------------------------------------

/** GET /api/commerce/produtos — catálogo omnichannel (canônico, somente leitura). */
export async function listarProdutosCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROD_COM(), actor, 'read');
  const s = getStore();
  const q = String(req.query.q || '').trim();

  const produtos = await s.list(R_PRODUTOS(), {
    page: 1,
    pageSize: 1000,
    filter: { empresa_id: escopo.empresaId },
    sort: 'nome',
    dir: 'asc',
    ...(q ? { q } : {}),
  });
  const [projecoes, precos, publicacoes, ctx] = await Promise.all([
    s.list(R_PROD_COM(), { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId } }),
    s.list(R_PRECOS(), { page: 1, pageSize: 4000, filter: { empresa_id: escopo.empresaId } }),
    s.list(R_PUBLICACOES(), { page: 1, pageSize: 4000, filter: { empresa_id: escopo.empresaId } }),
    prepararDisponibilidade(escopo),
  ]);

  const projPorProduto = new Map<number, Row>();
  for (const p of projecoes.rows) projPorProduto.set(Number(p.produto_id), p);
  const precosPorChave = new Map<string, Row>();
  for (const p of precos.rows) precosPorChave.set(`${Number(p.produto_id)}:${String(p.canal)}`, p);
  const pubPorChave = new Map<string, Row>();
  for (const p of publicacoes.rows) {
    const chave = `${Number(p.produto_id)}:${String(p.canal)}`;
    const atual = pubPorChave.get(chave);
    if (!atual || Number(p.versao) >= Number(atual.versao)) pubPorChave.set(chave, p);
  }

  const linhas = produtos.rows.map((p) => {
    const pid = Number(p.id);
    const proj = projPorProduto.get(pid);
    const publicacoesLinha: Record<string, { estado: string; versao: number; external_id: string | null; ultimo_erro: string | null }> = {};
    const precosLinha: Record<string, { preco: number; promo: number | null; origem: string }> = {};
    for (const canal of CANAIS_PUBLICACAO) {
      const pub = pubPorChave.get(`${pid}:${canal}`);
      if (pub) {
        publicacoesLinha[canal] = {
          estado: String(pub.estado),
          versao: Number(pub.versao),
          external_id: pub.external_id ? String(pub.external_id) : null,
          ultimo_erro: pub.ultimo_erro ? String(pub.ultimo_erro) : null,
        };
      }
      const preco = precoEfetivoDeProduto(Number(p.preco_venda ?? 0), precosPorChave.get(`${pid}:${canal}`));
      if (preco.origem === 'canal' || preco.promo != null) precosLinha[canal] = preco;
    }
    return {
      id: pid,
      sku: String(p.sku || ''),
      nome: String(p.nome || ''),
      ativo: p.ativo !== false,
      exibir_site: p.exibir_site === true,
      destaque: p.destaque === true,
      preco_base: Number(p.preco_venda ?? 0),
      disponivel: disponivelDoProduto(ctx, pid),
      na_vitrine: !!proj,
      slug: proj ? String(proj.slug) : null,
      publicacoes: publicacoesLinha,
      precos: precosLinha,
    };
  });

  res.json({ total: produtos.total, retornados: linhas.length, produtos: linhas });
}

/** GET /api/commerce/produtos/:id — detalhe com preços, filas e disponibilidade. */
export async function obterProdutoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROD_COM(), actor, 'read');
  const id = Number(req.params.id);
  const s = getStore();
  const produto = await s.findOneWhere(R_PRODUTOS(), { id, empresa_id: escopo.empresaId });
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  await attachImages(getResource('produtos')!, [produto]);
  const projecao = await s.findOneWhere(R_PROD_COM(), { empresa_id: escopo.empresaId, produto_id: id });
  const precos = await precosDoProduto(escopo.empresaId, id);
  const publicacoes = await s.list(R_PUBLICACOES(), {
    page: 1,
    pageSize: 200,
    filter: { empresa_id: escopo.empresaId, produto_id: id },
    sort: 'versao',
    dir: 'desc',
  });
  const disponibilidade = await disponibilidadesPorTamanho(escopo, id);
  res.json({
    produto: {
      id,
      sku: String(produto.sku || ''),
      nome: String(produto.nome || ''),
      descricao: String(produto.descricao || ''),
      descricao_curta: String(produto.descricao_curta || ''),
      ativo: produto.ativo !== false,
      exibir_site: produto.exibir_site === true,
      destaque: produto.destaque === true,
      preco_base: Number(produto.preco_venda ?? 0),
      foto_url: (produto as { foto_url?: string | null }).foto_url ?? null,
      fotos: (produto as { fotos?: unknown }).fotos ?? [],
    },
    projecao: projecao
      ? {
          id: Number(projecao.id),
          slug: String(projecao.slug),
          resumo: projecao.resumo ? String(projecao.resumo) : null,
          ordem: Number(projecao.ordem || 0),
          canal_metadados: normalizarMetadados(projecao.canal_metadados),
        }
      : null,
    precos: precos.map((p) => ({
      canal: String(p.canal),
      preco: Number(p.preco ?? 0),
      preco_promo: p.preco_promo != null ? Number(p.preco_promo) : null,
      vigencia_inicio: p.vigencia_inicio ? String(p.vigencia_inicio).slice(0, 10) : null,
      vigencia_fim: p.vigencia_fim ? String(p.vigencia_fim).slice(0, 10) : null,
    })),
    publicacoes: publicacoes.rows.map((p) => ({
      id: Number(p.id),
      canal: String(p.canal),
      versao: Number(p.versao),
      estado: String(p.estado),
      external_id: p.external_id ? String(p.external_id) : null,
      tentativas: Number(p.tentativas || 0),
      ultimo_erro: p.ultimo_erro ? String(p.ultimo_erro) : null,
      proxima_tentativa_em: p.proxima_tentativa_em ? String(p.proxima_tentativa_em) : null,
      publicado_em: p.publicado_em ? String(p.publicado_em) : null,
      atualizado_em: p.atualizado_em ? String(p.atualizado_em) : null,
    })),
    disponibilidade,
  });
}

/**
 * POST /api/commerce/produtos — projeta um produto existente na vitrine.
 * Uma única projeção por (empresa, produto); slug gerado de forma única.
 */
export async function projetarProdutoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxoEscrita(R_PROD_COM(), actor);
  const body = (req.body || {}) as Record<string, unknown>;
  const produtoId = Number(body.produto_id);
  if (!produtoId) throw new HttpError(400, 'Informe o produto.', { produto_id: 'Obrigatório' });
  const s = getStore();
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: produtoId, empresa_id: escopo.empresaId });
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  const existente = await s.findOneWhere(R_PROD_COM(), { empresa_id: escopo.empresaId, produto_id: produtoId });
  if (existente) throw new HttpError(409, 'Este produto já está projetado na vitrine.', { produto_id: 'Já projetado' });

  const slugs = await s.list(R_PROD_COM(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } });
  const ocupados = new Set(slugs.rows.map((r) => String(r.slug)));
  const base = String(body.slug && String(body.slug).trim() ? body.slug : produto.nome || `produto-${produtoId}`);
  const slug = slugUnico(base, (c) => ocupados.has(c));

  const linha = await s.insert(R_PROD_COM(), {
    empresa_id: escopo.empresaId,
    produto_id: produtoId,
    slug,
    resumo: body.resumo
      ? String(body.resumo).slice(0, 300)
      : produto.descricao_curta
        ? String(produto.descricao_curta).slice(0, 300)
        : null,
    ordem: Number(body.ordem ?? 0),
    canal_metadados: body.canal_metadados && typeof body.canal_metadados === 'object' ? body.canal_metadados : {},
  });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'commerce_produtos',
    registro_id: Number(linha.id),
    descricao: `Produto ${String(produto.sku || produtoId)} projetado na vitrine (slug ${String(linha.slug)})`,
    empresa_id: empresaDoRegistroAudit(R_PROD_COM(), linha, actor),
    dados: { produto_id: produtoId, slug: linha.slug },
  });
  res.status(201).json({ ok: true, produto_commerce: linha });
}

/** PUT /api/commerce/produtos/:id — conteúdo da vitrine (+ bump de fila). */
export async function atualizarProdutoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxoEscrita(R_PROD_COM(), actor);
  const id = Number(req.params.id);
  const s = getStore();
  // O parâmetro da rota é o ID do PRODUTO canônico (mesmo contrato do GET
  // /api/commerce/produtos/:id) — nunca o id da projeção, que tem sequência
  // própria. Editar pela projeção atualizava a linha errada (ou dava 404).
  const projecao = await s.findOneWhere(R_PROD_COM(), { produto_id: id, empresa_id: escopo.empresaId });
  if (!projecao) throw new HttpError(404, 'Produto commerce não encontrado.');
  const body = (req.body || {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body.resumo !== undefined) patch.resumo = body.resumo === null ? null : String(body.resumo).slice(0, 300);
  if (body.ordem !== undefined) patch.ordem = Math.max(0, Math.trunc(Number(body.ordem) || 0));
  if (body.canal_metadados !== undefined) {
    if (body.canal_metadados !== null && typeof body.canal_metadados !== 'object') {
      throw new HttpError(400, 'canal_metadados deve ser um objeto.');
    }
    patch.canal_metadados = body.canal_metadados ?? {};
  }
  if (body.slug !== undefined && String(body.slug).trim()) {
    const candidato = slugify(String(body.slug));
    const dono = await s.findOneWhere(R_PROD_COM(), { empresa_id: escopo.empresaId, slug: candidato });
    if (dono && Number(dono.id) !== Number(projecao.id)) throw new HttpError(409, 'Já existe um produto com este slug na vitrine.', { slug: 'Em uso' });
    patch.slug = candidato;
  }
  if (!Object.keys(patch).length) return res.json({ ok: true, produto_commerce: projecao });

  const atualizado = await s.update(R_PROD_COM(), Number(projecao.id), patch);
  // Mudou conteúdo → os canais com histórico ganham nova versão na fila.
  await reenfileirarPublicacoesAfetadas(escopo.empresaId, Number(projecao.produto_id), actor.id ?? null);
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_produtos',
    registro_id: Number(projecao.id),
    descricao: `Conteúdo da vitrine atualizado (produto ${Number(projecao.produto_id)})`,
    empresa_id: empresaDoRegistroAudit(R_PROD_COM(), projecao, actor),
    dados: patch,
  });
  res.json({ ok: true, produto_commerce: atualizado ?? projecao });
}

/** Enfileira nova versão para os canais que já têm histórico de publicação. */
async function reenfileirarPublicacoesAfetadas(empresaId: number, produtoId: number, criadoPor: number | null): Promise<void> {
  const s = getStore();
  const historico = await s.list(R_PUBLICACOES(), {
    page: 1,
    pageSize: 200,
    filter: { empresa_id: empresaId, produto_id: produtoId },
  });
  const canais = new Set<string>();
  for (const r of historico.rows) {
    if (['PUBLISHED', 'ERROR', 'UPDATE_QUEUED', 'QUEUED'].includes(String(r.estado))) canais.add(String(r.canal));
  }
  for (const canal of canais) {
    const payload = await montarPayloadPublicacao(empresaId, produtoId, canal as CanalPublicacao);
    await enfileirarPublicacao(empresaId, produtoId, canal as CanalPublicacao, payload, criadoPor);
  }
}

/** PUT /api/commerce/produtos/:id/precos — preço por canal (por cima da base). */
export async function salvarPrecoCanal(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxoEscrita(R_PRECOS(), actor);
  const produtoId = Number(req.params.id);
  const s = getStore();
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: produtoId, empresa_id: escopo.empresaId });
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  const body = (req.body || {}) as Record<string, unknown>;
  const canal = String(body.canal || '');
  if (!(CANAIS_PUBLICACAO as readonly string[]).includes(canal)) {
    throw new HttpError(400, 'Canal inválido.', { canal: `Use ${CANAIS_PUBLICACAO.join(', ')}` });
  }
  const preco = Number(body.preco);
  if (!Number.isFinite(preco) || preco < 0) throw new HttpError(400, 'Informe um preço maior ou igual a zero.', { preco: 'Inválido' });
  const precoPromo =
    body.preco_promo === null || body.preco_promo === undefined || body.preco_promo === '' ? null : Number(body.preco_promo);
  if (precoPromo !== null && (!Number.isFinite(precoPromo) || precoPromo < 0)) {
    throw new HttpError(400, 'Preço promocional inválido.', { preco_promo: 'Inválido' });
  }
  const existente = await s.findOneWhere(R_PRECOS(), { empresa_id: escopo.empresaId, produto_id: produtoId, canal });
  const dados = {
    preco: Math.round(preco * 100) / 100,
    preco_promo: precoPromo === null ? null : Math.round(precoPromo * 100) / 100,
    vigencia_inicio: body.vigencia_inicio ? String(body.vigencia_inicio).slice(0, 10) : null,
    vigencia_fim: body.vigencia_fim ? String(body.vigencia_fim).slice(0, 10) : null,
  };
  const linha = existente
    ? (await s.update(R_PRECOS(), Number(existente.id), dados))!
    : await s.insert(R_PRECOS(), { empresa_id: escopo.empresaId, produto_id: produtoId, canal, ...dados });
  await reenfileirarPublicacoesAfetadas(escopo.empresaId, produtoId, actor.id ?? null);
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: existente ? 'editar' : 'criar',
    recurso: 'commerce_precos',
    registro_id: Number(linha.id),
    descricao: `Preço do canal ${canal} do produto ${String(produto.sku || produtoId)} = R$ ${dados.preco.toFixed(2)}`,
    empresa_id: empresaDoRegistroAudit(R_PRECOS(), linha, actor),
    dados: { canal, ...dados },
  });
  res.json({ ok: true, preco: linha });
}

/** POST /api/commerce/publicacoes — enfileira publicação (produto × canais). */
export async function publicarProduto(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxoEscrita(R_PUBLICACOES(), actor);
  const body = (req.body || {}) as Record<string, unknown>;
  const produtoId = Number(body.produto_id);
  if (!produtoId) throw new HttpError(400, 'Informe o produto.', { produto_id: 'Obrigatório' });
  const canais = Array.isArray(body.canais) ? body.canais.map(String) : [];
  for (const c of canais) {
    if (!(CANAIS_PUBLICACAO as readonly string[]).includes(c)) throw new HttpError(400, `Canal inválido: ${c}.`);
  }
  if (!canais.length) throw new HttpError(400, 'Informe ao menos um canal.', { canais: 'Obrigatório' });
  const s = getStore();
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: produtoId, empresa_id: escopo.empresaId });
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  if (canais.includes('BROBOND')) {
    const proj = await s.findOneWhere(R_PROD_COM(), { empresa_id: escopo.empresaId, produto_id: produtoId });
    if (!proj) throw new HttpError(409, 'Projete o produto na vitrine (slug) antes de publicar no canal BROBOND.');
  }
  const linhas: Row[] = [];
  for (const canal of canais) {
    const payload = await montarPayloadPublicacao(escopo.empresaId, produtoId, canal as CanalPublicacao);
    linhas.push(await enfileirarPublicacao(escopo.empresaId, produtoId, canal as CanalPublicacao, payload, actor.id ?? null));
  }
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_publicacoes',
    registro_id: Number(linhas[0]?.id ?? 0),
    descricao: `Publicação enfileirada: produto ${produtoId} × ${canais.join(', ')}`,
    empresa_id: escopo.empresaId,
    dados: { produto_id: produtoId, canais },
  });
  // Processa em segundo plano — a tela acompanha o estado na fila.
  void processarFilaPublicacoes(10).catch(() => undefined);
  res.status(201).json({ ok: true, publicacoes: linhas });
}

/** GET /api/commerce/publicacoes — fila (histórico por canal/versão). */
export async function listarPublicacoes(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PUBLICACOES(), actor, 'read');
  const s = getStore();
  const filtro: Record<string, unknown> = { empresa_id: escopo.empresaId };
  if (req.query.produto_id) filtro.produto_id = Number(req.query.produto_id);
  if (req.query.canal) filtro.canal = String(req.query.canal);
  if (req.query.estado) filtro.estado = String(req.query.estado);
  const out = await s.list(R_PUBLICACOES(), {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(200, Number(req.query.pageSize) || 50),
    filter: filtro,
    sort: 'id',
    dir: 'desc',
  });
  const nomes = await nomesProdutos(escopo.empresaId, out.rows.map((r) => Number(r.produto_id)));
  res.json({
    total: out.total,
    publicacoes: out.rows.map((r) => ({
      id: Number(r.id),
      produto_id: Number(r.produto_id),
      produto: nomes.get(Number(r.produto_id)) ?? '',
      canal: String(r.canal),
      versao: Number(r.versao),
      estado: String(r.estado),
      external_id: r.external_id ? String(r.external_id) : null,
      tentativas: Number(r.tentativas || 0),
      ultimo_erro: r.ultimo_erro ? String(r.ultimo_erro) : null,
      proxima_tentativa_em: r.proxima_tentativa_em ? String(r.proxima_tentativa_em) : null,
      publicado_em: r.publicado_em ? String(r.publicado_em) : null,
      atualizado_em: r.atualizado_em ? String(r.atualizado_em) : null,
    })),
  });
}

/** POST /api/commerce/publicacoes/:id/reprocessar — retry manual (ignora backoff). */
export async function reprocessarPublicacao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxoEscrita(R_PUBLICACOES(), actor);
  const id = Number(req.params.id);
  const s = getStore();
  const linha = await s.findOneWhere(R_PUBLICACOES(), { id, empresa_id: escopo.empresaId });
  if (!linha) throw new HttpError(404, 'Publicação não encontrada.');
  const estado = String(linha.estado);
  if (estado === 'PUBLISHED') throw new HttpError(409, 'Publicação já confirmada pelo canal.');
  if (estado === 'REJECTED') throw new HttpError(409, String(linha.ultimo_erro || 'Canal não suporta publicação automática.'));
  if (estado === 'PUBLISHING') throw new HttpError(409, 'Há uma publicação em andamento.');
  const reativada = await s.update(R_PUBLICACOES(), id, {
    estado: 'QUEUED',
    proxima_tentativa_em: new Date().toISOString(),
  });
  void processarFilaPublicacoes(5).catch(() => undefined);
  res.json({ ok: true, publicacao: reativada });
}

/** GET /api/commerce/publicacoes/:id — detalhe de UMA publicação (produto + preço do canal + metadados). */
export async function obterPublicacaoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PUBLICACOES(), actor, 'read');
  const id = Number(req.params.id);
  const s = getStore();
  const linha = await s.findOneWhere(R_PUBLICACOES(), { id, empresa_id: escopo.empresaId });
  if (!linha) throw new HttpError(404, 'Publicação não encontrada.');
  const produto = await s.findOneWhere(R_PRODUTOS(), { id: Number(linha.produto_id), empresa_id: escopo.empresaId });
  if (!produto) throw new HttpError(404, 'Produto da publicação não encontrado.');
  const canal = String(linha.canal);
  const precoLinha = await s.findOneWhere(R_PRECOS(), {
    empresa_id: escopo.empresaId,
    produto_id: Number(linha.produto_id),
    canal,
  });
  const projecao = await s.findOneWhere(R_PROD_COM(), {
    empresa_id: escopo.empresaId,
    produto_id: Number(linha.produto_id),
  });
  const precoEf = precoEfetivoDeProduto(Number(produto.preco_venda ?? 0), precoLinha);
  res.json({
    publicacao: {
      id: Number(linha.id),
      produto_id: Number(linha.produto_id),
      canal,
      versao: Number(linha.versao),
      estado: String(linha.estado),
      external_id: linha.external_id ? String(linha.external_id) : null,
      tentativas: Number(linha.tentativas || 0),
      ultimo_erro: linha.ultimo_erro ? String(linha.ultimo_erro) : null,
      proxima_tentativa_em: linha.proxima_tentativa_em ? String(linha.proxima_tentativa_em) : null,
      publicado_em: linha.publicado_em ? String(linha.publicado_em) : null,
      criado_em: linha.criado_em ? String(linha.criado_em) : null,
      atualizado_em: linha.atualizado_em ? String(linha.atualizado_em) : null,
    },
    produto: {
      id: Number(produto.id),
      sku: String(produto.sku || ''),
      nome: String(produto.nome || ''),
      preco_base: Number(produto.preco_venda ?? 0),
      na_vitrine: !!projecao,
    },
    preco: {
      preco: precoEf.preco,
      promo: precoEf.promo,
      origem: precoEf.origem,
      linha: precoLinha
        ? {
            preco: Number(precoLinha.preco ?? 0),
            preco_promo: precoLinha.preco_promo != null ? Number(precoLinha.preco_promo) : null,
            vigencia_inicio: precoLinha.vigencia_inicio ? String(precoLinha.vigencia_inicio).slice(0, 10) : null,
            vigencia_fim: precoLinha.vigencia_fim ? String(precoLinha.vigencia_fim).slice(0, 10) : null,
          }
        : null,
    },
    metadados: normalizarMetadados(projecao?.canal_metadados),
    publicado_na_vitrine: String(linha.estado) === 'PUBLISHED' && canal === 'BROBOND',
  });
}

// ---------------------------------------------------------------------------- 
// OFERTAS — preço por canal (preço, preço promocional, vigência, canal,
// precedência e publicação). LINHA é `commerce_precos`; o preço final é sempre
// calculado AQUI no servidor (`precoEfetivo`: vigente canal > tabela; promo só
// quando menor que o preço) — o cliente nunca decide dinheiro.
// ----------------------------------------------------------------------------

async function ofertasDaEmpresa(
  escopo: { empresaId: number },
  filtro: { canal?: string; vigentes?: boolean; q?: string } = {}
): Promise<Record<string, unknown>[]> {
  const s = getStore();
  const [precos, produtos, publicacoes] = await Promise.all([
    s.list(R_PRECOS(), { page: 1, pageSize: 4000, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' }),
    s.list(R_PRODUTOS(), { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId }, sort: 'nome', dir: 'asc' }),
    s.list(R_PUBLICACOES(), { page: 1, pageSize: 4000, filter: { empresa_id: escopo.empresaId } }),
  ]);
  const prodPorId = new Map<number, Row>();
  for (const p of produtos.rows) prodPorId.set(Number(p.id), p);
  const pubPorChave = new Map<string, Row>();
  for (const p of publicacoes.rows) {
    const chave = `${Number(p.produto_id)}:${String(p.canal)}`;
    const atual = pubPorChave.get(chave);
    if (!atual || Number(p.versao) >= Number(atual.versao)) pubPorChave.set(chave, p);
  }
  const hoje = new Date();
  const q = (filtro.q ?? '').trim().toLowerCase();
  const linhas: Record<string, unknown>[] = [];
  for (const preco of precos.rows) {
    const produtoId = Number(preco.produto_id);
    const canal = String(preco.canal);
    if (filtro.canal && canal !== filtro.canal) continue;
    const produto = prodPorId.get(produtoId);
    if (!produto) continue;
    const vigente = vigenciaEstaAtiva(vigenciaDe(preco, 'vigencia_inicio'), vigenciaDe(preco, 'vigencia_fim'), hoje);
    if (filtro.vigentes && !vigente) continue;
    const nome = String(produto.nome || '');
    const sku = String(produto.sku || '');
    if (q && !nome.toLowerCase().includes(q) && !sku.toLowerCase().includes(q)) continue;
    const efetivo = precoEfetivoDeProduto(Number(produto.preco_venda ?? 0), preco);
    const pub = pubPorChave.get(`${produtoId}:${canal}`);
    linhas.push({
      id: Number(preco.id),
      produto_id: produtoId,
      sku,
      nome,
      preco_base: Number(produto.preco_venda ?? 0),
      canal,
      preco: Number(preco.preco ?? 0),
      preco_promo: preco.preco_promo != null ? Number(preco.preco_promo) : null,
      vigencia_inicio: vigenciaDe(preco, 'vigencia_inicio'),
      vigencia_fim: vigenciaDe(preco, 'vigencia_fim'),
      vigente,
      preco_efetivo: { preco: efetivo.preco, promo: efetivo.promo, origem: efetivo.origem },
      publicacao_estado: pub ? String(pub.estado) : null,
      publicacao_id: pub ? Number(pub.id) : null,
      atualizado_em: preco.atualizado_em ? String(preco.atualizado_em) : null,
    });
  }
  return linhas;
}

function vigenciaDe(row: Row, campo: 'vigencia_inicio' | 'vigencia_fim'): string | null {
  const v = row[campo];
  return v ? String(v).slice(0, 10) : null;
}

/** GET /api/commerce/ofertas — ofertas por canal da empresa (vigência + precedência server-side). */
export async function listarOfertasCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PRECOS(), actor, 'read');
  const linhas = await ofertasDaEmpresa(escopo, {
    canal: req.query.canal ? String(req.query.canal) : undefined,
    vigentes: String(req.query.vigentes || '') === '1',
    q: req.query.q ? String(req.query.q) : undefined,
  });
  res.json({ total: linhas.length, ofertas: linhas });
}

/** GET /api/commerce/ofertas/:id — detalhe de uma oferta (linha de `commerce_precos`). */
export async function obterOfertaCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PRECOS(), actor, 'read');
  const id = Number(req.params.id);
  const s = getStore();
  const linha = await s.findOneWhere(R_PRECOS(), { id, empresa_id: escopo.empresaId });
  if (!linha) throw new HttpError(404, 'Oferta não encontrada.');
  const todas = await ofertasDaEmpresa(escopo);
  const oferta = todas.find((o) => Number(o.id) === id);
  if (!oferta) throw new HttpError(404, 'Oferta não encontrada.');
  res.json({ oferta });
}

/** POST /api/commerce/produtos/:id/despublicar — sai da vitrine (BROBOND). */
export async function despublicarProduto(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxoEscrita(R_PUBLICACOES(), actor);
  const produtoId = Number(req.params.id);
  const canal = String((req.body || {}).canal || 'BROBOND');
  if (canal !== 'BROBOND') {
    throw new HttpError(
      409,
      `A despublicação automática só existe na vitrine própria (BROBOND). No canal ${canal}, cancele o anúncio no próprio canal — marcá-lo como despublicado aqui seria mentira.`
    );
  }
  const s = getStore();
  const linha = await s.findOneWhere(R_PUBLICACOES(), {
    empresa_id: escopo.empresaId,
    produto_id: produtoId,
    canal: 'BROBOND',
    estado: 'PUBLISHED',
  });
  if (!linha) throw new HttpError(409, 'O produto não está publicado na vitrine.');
  await s.update(R_PUBLICACOES(), Number(linha.id), { estado: 'UNPUBLISHED', proxima_tentativa_em: null });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_publicacoes',
    registro_id: Number(linha.id),
    descricao: `Produto ${produtoId} despublicado da vitrine própria`,
    empresa_id: escopo.empresaId,
    dados: { produto_id: produtoId, canal },
  });
  res.json({ ok: true });
}
