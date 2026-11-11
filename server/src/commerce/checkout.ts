// ============================================================================
// CHECKOUT INTERNO — MOTOR COMPARTILHADO (ADR-0007).
//
// A loja pública nativa `/loja` foi RETIRADA. Este módulo é o MOTOR DE CHECKOUT
// que PERMANECE como serviço compartilhado do ERP (ADR-0007 — "os serviços
// internos compartilhados (`checkoutMethods`, motor de pedidos) permanecem").
//
// Ele NÃO é uma superfície pública: as rotas são AUTENTICADAS
// (`/api/commerce/checkout/*`) e o tenant vem da SESSÃO (`contextoCheckout`),
// nunca de env/unicidade nem do corpo.
//
// Regras inegociáveis (inalteradas da origem):
//   • preço, estoque, cupom e total são calculados NO SERVIDOR;
//   • reserva de estoque ANTES da cobrança, no motor canônico;
//   • pagamento criado pelo backend via Payment Engine (o front nunca confirma);
//   • idempotência por `chave_checkout`;
//   • frete vem do FreightProvider — "Frete não configurado" é resposta honesta;
//   • falhou a cobrança → pedido ERRO + reservas/cupom liberados.
// ============================================================================
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../errors';
import { getStore } from '../services';
import { query } from '../db';
import { listarTodos } from '../paginacaoCompleta';
import { escopoDeSistema } from '../empresa';
import { getResource } from '../resources';
import { paymentEngine } from '../../../modules/payments/orchestration/payment-orchestrator';
import { availableMethods, candidates } from '../../../modules/payments/application/configuration';
import { METHODS, type PaymentMethod } from '../../../modules/payments/domain/payment';
import { criarReservaInterna, liberarReservaInterna } from '../estoqueTransferencia';
import { saldoVendavel } from '../estoqueCanonico';
import { chaveLinha, quantidadeValida, validarCorpoQuantidade } from './checkout-base';
import { attachImages } from '../uploads';
import { marketplaceSaleReference } from '../../../modules/connectors/ingestion/sales.service';
import { connectorCuid } from '../../../modules/connectors/core/id';
import { configuracaoFreteValida, cotarFrete } from './frete';
import { configDaLoja, contextoCheckout, freteDaConfig, responsavelCheckout } from './checkout-base';
import { disponibilidadesPorTamanho } from './catalogo';
import { montarVisaoDaSale, ORIGEM_CHECKOUT } from './pedidos';
import { normalizarComprador } from './cliente';
import { registrarEventoSeguro, type ContatoPedido, type EventoNotificacao } from './notificacoes';
import {
  avaliarCupomCodigo,
  consumirUsoCupom,
  descontoFinalDoCheckout,
  liberarUsoCupom,
  melhorPromocaoDoCarrinho,
  normalizarCodigo,
} from './promocoes';
import type { ItemElegivel } from './regras';
import type { Row } from '../store';
import { calcularTotaisCheckout, paraCentavos, precoEfetivo, round2 } from './regras';

const R_PRODUTOS = () => getResource('produtos')!;
const R_PROD_COM = () => getResource('commerce_produtos')!;
const R_PRECOS = () => getResource('commerce_precos')!;
const R_PUBLICACOES = () => getResource('commerce_publicacoes')!;
const R_PEDIDOS = () => getResource('commerce_pedidos')!;
const R_SALES = () => getResource('sales')!;
const R_SALE_ITEMS = () => getResource('sale_items')!;

// ----------------------------------------------------------------------------
// Estado do catálogo interno (PUBLISHED no canal interno + produto ativo)
// ----------------------------------------------------------------------------

type CatalogoInterno = {
  empresaId: number;
  visiveis: Map<number, Row>; // produto_id → produto
  projecoes: Map<number, Row>;
  precos: Map<string, Row>;
};

export async function carregarCatalogoInterno(empresaId: number): Promise<CatalogoInterno> {
  const s = getStore();
  // A snapshot prevents price/publication pages from shifting between reads.
  // Silently truncating the price table would fall back to the base price and
  // can charge the customer an incorrect amount at checkout.
  const [produtos, projecoes, precos, publicacoes] = await s.transaction(async (tx) => {
    // A pg client executes one query at a time; keep the shared snapshot and
    // avoid concurrent client.query calls (deprecated in pg 8, removed in 9).
    const produtos = await listarTodos(R_PRODUTOS(), { empresa_id: empresaId }, tx, { sort: 'id', dir: 'asc' });
    const projecoes = await listarTodos(R_PROD_COM(), { empresa_id: empresaId }, tx, { sort: 'id', dir: 'asc' });
    const precos = await listarTodos(R_PRECOS(), { empresa_id: empresaId, canal: 'BROBOND' }, tx, { sort: 'id', dir: 'asc' });
    const publicacoes = await listarTodos(R_PUBLICACOES(), { empresa_id: empresaId, canal: 'BROBOND' }, tx, { sort: 'id', dir: 'asc' });
    return [produtos, projecoes, precos, publicacoes];
  }, { isolation: 'repeatable read' });
  const pubPpublished = new Set<number>();
  for (const p of publicacoes) if (String(p.estado) === 'PUBLISHED') pubPpublished.add(Number(p.produto_id));
  const visiveis = new Map<number, Row>();
  const projMap = new Map<number, Row>();
  for (const pj of projecoes) projMap.set(Number(pj.produto_id), pj);
  for (const prod of produtos) {
    const pid = Number(prod.id);
    if (prod.ativo === false) continue;
    if (!projMap.has(pid)) continue;
    if (!pubPpublished.has(pid)) continue;
    visiveis.set(pid, prod);
  }
  const precoMap = new Map<string, Row>();
  for (const pr of precos) precoMap.set(`${Number(pr.produto_id)}:${String(pr.canal)}`, pr);
  return { empresaId, visiveis, projecoes: projMap, precos: precoMap };
}

export function precoPublico(produto: Row, precos: Map<string, Row>): { preco: number; preco_original: number | null; promocional: boolean } {
  const linha = precos.get(`${Number(produto.id)}:BROBOND`);
  const eff = precoEfetivo({
    base: Number(produto.preco_venda ?? 0),
    precoCanal: linha ? Number(linha.preco ?? 0) : null,
    precoPromoCanal: linha && linha.preco_promo != null ? Number(linha.preco_promo) : null,
    vigenciaInicio: (linha?.vigencia_inicio as string | null) ?? null,
    vigenciaFim: (linha?.vigencia_fim as string | null) ?? null,
  });
  const unidade = eff.promo ?? eff.preco;
  return { preco: round2(unidade), preco_original: eff.promo != null ? eff.preco : null, promocional: eff.promo != null };
}

/**
 * Converte as linhas RESOLVIDAS do carrinho na visão da avaliação de promoção
 * (subtotal da linha + produto + categoria). Linhas com problema ficam de fora:
 * não geram desconto porque não geram receita.
 */
function itensElegiveis(itens: ItemResolvido[]): ItemElegivel[] {
  return itens
    .filter((i) => !i.problema)
    .map((i) => ({
      subtotal: round2(i.preco_unitario * i.quantidade),
      produtoId: i.produto_id,
      categoriaId: i.categoriaId,
    }));
}

// ----------------------------------------------------------------------------
// Itens do carrinho — resolução canônica (preço/estoque/visibilidade)
// ----------------------------------------------------------------------------

type ItemResolvido = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
  nome: string;
  sku: string;
  preco_unitario: number;
  preco_original: number | null;
  disponivel: number;
  /** Imagem principal vigente do produto (nunca enviada pelo browser). */
  foto_url: string | null;
  /** Rótulo da variante (tamanho) quando o item tem grade. */
  variante: string | null;
  /** Categoria do produto (elegibilidade de promoção por categoria — 0108). */
  categoriaId: number | null;
  /** Só no modo tolerante (preview): item que saiu da vitrine / precisa de ajuste. */
  problema?: string;
};

type OpcoesResolucao = {
  /**
   * `true` (preview): problema DE ESTADO de uma linha (produto despublicado,
   * tamanho ausente/inválido, sem preço) vira linha `ok:false` com aviso, para
   * que o cliente consiga ver e REMOVER o item. O checkout usa `false` e
   * continua recusando o carrinho inteiro. Estrutura malformada (quantidade
   * 0/negativa/NaN/Infinity/string, produto inválido) é 400 nos dois modos.
   */
  tolerante?: boolean;
};

async function resolverItensCarrinho(
  empresaId: number,
  corpo: Record<string, unknown>,
  opcoes: OpcoesResolucao = {}
): Promise<ItemResolvido[]> {
  const bruto = Array.isArray(corpo.itens) ? corpo.itens : null;
  if (!bruto || !bruto.length) throw new HttpError(400, 'O carrinho está vazio.', { itens: 'Obrigatório' });
  if (bruto.length > 30) throw new HttpError(400, 'O carrinho aceita no máximo 30 linhas.');
  const { visiveis, projecoes, precos } = await carregarCatalogoInterno(empresaId);
  void projecoes;
  const out: ItemResolvido[] = [];
  const chaves = new Set<string>();
  for (const bruto2 of bruto) {
    const item = (bruto2 && typeof bruto2 === 'object' && !Array.isArray(bruto2) ? bruto2 : {}) as Record<string, unknown>;
    // STRICT: sem coerção. `Number([2]) === 2`, `Number(true) === 1` e
    // `Number("2") === 2` permitiriam quantidade forjada por tipo; só NUMBER
    // inteiro 1..99 é aceito (0, negativo, decimal, NaN, ±Infinity, string,
    // null, undefined, objeto, array e boolean ⇒ 400).
    const quantidade = quantidadeValida(item.quantidade);
    if (quantidade === null) throw new HttpError(400, 'Quantidade inválida (1 a 99) no carrinho.', { itens: 'Quantidade inválida' });
    const produtoId = typeof item.produto_id === 'number' && Number.isSafeInteger(item.produto_id) && item.produto_id > 0 ? item.produto_id : NaN;
    if (!Number.isSafeInteger(produtoId) || produtoId <= 0) throw new HttpError(400, 'Item do carrinho sem produto.', { itens: 'Inválido' });
    const tamanhoId = item.tamanho_id == null || item.tamanho_id === ''
      ? null
      : typeof item.tamanho_id === 'number' && Number.isSafeInteger(item.tamanho_id) && item.tamanho_id > 0
        ? item.tamanho_id
        : NaN;
    if (tamanhoId !== null && (!Number.isSafeInteger(tamanhoId) || tamanhoId <= 0)) throw new HttpError(400, 'Tamanho inválido no carrinho.');
    const chave = `${produtoId}:${tamanhoId ?? ''}`;
    if (chaves.has(chave)) throw new HttpError(400, 'Item duplicado no carrinho. Atualize a quantidade na mesma linha.');
    chaves.add(chave);
    // Linha que não pode ser vendida: no preview ela continua VISÍVEL (sem
    // vazar nome/SKU de produto fora da vitrine) para o cliente poder removê-la.
    const linhaComProblema = (problema: string, parcial: Partial<ItemResolvido> = {}): ItemResolvido => ({
      produto_id: produtoId,
      tamanho_id: tamanhoId,
      quantidade,
      nome: 'Item indisponível',
      sku: '',
      preco_unitario: 0,
      preco_original: null,
      disponivel: 0,
      foto_url: null,
      variante: null,
      categoriaId: null,
      problema,
      ...parcial,
    });
    const produto = visiveis.get(produtoId);
    if (!produto) {
      // mesma resposta do inexistente: nunca revelar produto de outro tenant
      if (opcoes.tolerante) {
        out.push(linhaComProblema('Este item não está mais disponível na loja. Remova-o para continuar.'));
        continue;
      }
      throw new HttpError(409, 'Um dos itens não está mais disponível na vitrine.');
    }
    const preco = precoPublico(produto, precos);
    if (!Number.isFinite(preco.preco) || preco.preco <= 0) {
      if (opcoes.tolerante) {
        out.push(linhaComProblema('Item sem preço válido na loja. Remova-o para continuar.', { nome: String(produto.nome || ''), sku: String(produto.sku || '') }));
        continue;
      }
      throw new HttpError(409, 'Um dos itens está sem preço válido na vitrine.');
    }
    const escopo = escopoDeSistema(empresaId);
    const grade = await disponibilidadesPorTamanho(escopo, produtoId);
    const comTamanho = grade.filter((g) => g.tamanho_id != null);
    const base = { nome: String(produto.nome || ''), sku: String(produto.sku || '') };
    if (comTamanho.length) {
      // produto com tamanhos: SEM exceção — item sem tamanho reservaria o
      // produto inteiro e o faturamento não saberia de onde sacar.
      if (tamanhoId == null) {
        if (opcoes.tolerante) {
          out.push(linhaComProblema(`Selecione o tamanho de ${produto.nome}.`, base));
          continue;
        }
        throw new HttpError(400, `Selecione o tamanho de ${produto.nome}.`, { itens: 'Tamanho obrigatório' });
      }
      if (!comTamanho.some((g) => g.tamanho_id === tamanhoId)) {
        if (opcoes.tolerante) {
          out.push(linhaComProblema('Tamanho indisponível para este produto.', base));
          continue;
        }
        throw new HttpError(400, 'Tamanho indisponível para este produto.', { itens: 'Tamanho inválido' });
      }
    }
    let disponivel = 0;
    if (tamanhoId != null) {
      const saldo = await saldoVendavel(escopo, produtoId, tamanhoId, null);
      disponivel = Math.max(0, saldo.quantidade);
    } else {
      disponivel = grade.reduce((soma, c) => soma + Math.max(0, c.disponivel), 0);
    }
    out.push({
      produto_id: produtoId,
      tamanho_id: tamanhoId,
      quantidade,
      ...base,
      preco_unitario: preco.preco,
      preco_original: preco.preco_original,
      disponivel,
      foto_url: null,
      variante: tamanhoId != null ? grade.find((g) => g.tamanho_id === tamanhoId)?.codigo ?? null : null,
      categoriaId: produto.categoria_id != null ? Number(produto.categoria_id) : null,
    });
  }
  // Imagem vigente vem do cadastro (uma consulta para o carrinho inteiro).
  const comImagem = out.filter((i) => !i.problema).map((i) => visiveis.get(i.produto_id)!);
  if (comImagem.length) {
    const unicos = [...new Map(comImagem.map((p) => [Number(p.id), { ...p }])).values()];
    await attachImages(getResource('produtos')!, unicos);
    const fotos = new Map(unicos.map((p) => [Number(p.id), (p as { foto_url?: string | null }).foto_url ?? null]));
    for (const i of out) if (!i.problema) i.foto_url = fotos.get(i.produto_id) ?? null;
  }
  return out;
}

/**
 * COTAÇÃO DO CARRINHO (domínio Comercial/Experiência) — preço, estoque, cupom,
 * promoção, frete e totais, SEMPRE recalculados no servidor. Não depende do
 * Payment Engine: uma falha de provider nunca pode esconder o carrinho.
 * O browser só informa produto/tamanho/quantidade/cupom/cep; qualquer
 * `preco`, `total`, `desconto`, `frete` enviado é ignorado.
 */
export async function cotarCarrinho(empresaId: number, corpo: Record<string, unknown>) {
  const config = await configDaLoja(empresaId);
  const itens = await resolverItensCarrinho(empresaId, corpo, { tolerante: true });
  const vendaveis = itens.filter((i) => !i.problema);
  const subtotal = round2(vendaveis.reduce((soma, i) => soma + i.preco_unitario * i.quantidade, 0));

  const codigoCupom = corpo.cupom ? normalizarCodigo(corpo.cupom) : '';
  let cupom: Awaited<ReturnType<typeof avaliarCupomCodigo>> | null = null;
  if (codigoCupom) cupom = await avaliarCupomCodigo(empresaId, codigoCupom, subtotal);
  const { promocao } = await melhorPromocaoDoCarrinho(empresaId, itensElegiveis(vendaveis), subtotal, 'varejo');
  const desconto = descontoFinalDoCheckout(subtotal, promocao, cupom);
  const frete = await cotarFrete(freteDaConfig(config), {
    subtotal,
    cep: corpo.cep ? String(corpo.cep) : null,
  });
  const totais = calcularTotaisCheckout({
    itens: vendaveis.map((i) => ({ quantidade: i.quantidade, precoUnitario: i.preco_unitario })),
    frete: frete.disponivel ? frete.valor : 0,
    desconto: desconto.desconto,
  });
  const itensOk = itens.length > 0 && itens.every((i) => !i.problema && i.disponivel >= i.quantidade);
  return {
    itens: itens.map((i) => ({
      produto_id: i.produto_id,
      tamanho_id: i.tamanho_id,
      quantidade: i.quantidade,
      nome: i.nome,
      sku: i.sku,
      variante: i.variante,
      foto_url: i.foto_url,
      preco_unitario: i.preco_unitario,
      preco_original: i.preco_original,
      disponivel: i.disponivel,
      subtotal: round2(i.preco_unitario * i.quantidade),
      ok: !i.problema && i.disponivel >= i.quantidade,
      ...(i.problema
        ? { aviso: i.problema, indisponivel: true }
        : i.disponivel < i.quantidade
          ? { aviso: i.disponivel > 0 ? `Só ${i.disponivel} em estoque.` : 'Sem estoque no momento.' }
          : {}),
    })),
    subtotal,
    cupom: codigoCupom
      ? {
          codigo: codigoCupom,
          valido: cupom?.ok === true,
          aplicado: desconto.origem === 'cupom',
          desconto: desconto.origem === 'cupom' ? desconto.desconto : 0,
          erro: cupom && !cupom.ok ? cupom.erro : desconto.cupomErro,
        }
      : null,
    promocao: promocao && desconto.origem === 'promocao' ? { nome: promocao.nome, desconto: desconto.desconto } : null,
    frete,
    desconto: desconto.desconto,
    desconto_origem: desconto.origem,
    totais,
    frete_indisponivel: !frete.disponivel,
    ...(frete.disponivel ? {} : { frete_motivo: frete.motivo }),
    /** Pode seguir para o checkout? (decisão do servidor; o cliente só reflete) */
    pronto_para_checkout: itensOk && frete.disponivel && totais.total > 0 && !(cupom && !cupom.ok),
    calculado_em: new Date().toISOString(),
  };
}

/**
 * Cotação do carrinho + métodos de pagamento oferecidos PELO PAYMENT ENGINE.
 * Falha do Payment Engine degrada apenas `payment_methods` (lista vazia +
 * `payment_methods_erro`) — o carrinho continua calculado e visível.
 */
export async function quotePaymentMethods(empresaId: number, req: Request) {
  const cotacao = await cotarCarrinho(empresaId, (req.body || {}) as Record<string, unknown>);
  let methods: Awaited<ReturnType<typeof availableMethods>> = [];
  let metodosErro = false;
  if (cotacao.pronto_para_checkout) {
    try {
      methods = await availableMethods({
        empresaId,
        amount: paraCentavos(cotacao.totais.total),
        currency: 'BRL',
        country: 'BR',
        channel: 'OWN_STORE',
        installments: 1,
      });
    } catch (e) {
      metodosErro = true;
      console.error('[checkout] Payment Engine indisponível ao cotar métodos:', e instanceof Error ? e.message : String(e));
    }
  }
  return { payment_methods: methods, ...(metodosErro ? { payment_methods_erro: true } : {}), ...cotacao };
}

// ----------------------------------------------------------------------------
// ROTAS INTERNAS AUTENTICADAS (ADR-0007) — substituem a superfície pública
// `/api/loja/*`. O tenant vem SEMPRE da sessão (`contextoCheckout`).
// ----------------------------------------------------------------------------

/** POST /api/commerce/checkout/preview — revalidação do carrinho (server-side). */
export async function previewInterno(req: Request, res: Response) {
  const { empresaId } = await contextoCheckout(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await quotePaymentMethods(empresaId, req));
}

/**
 * POST /api/commerce/checkout/carrinho/quantidade — mutação de quantidade
 * confirmada pelo servidor (tipo, faixa, tenant, estoque real). O corpo propõe;
 * o servidor devolve apenas a quantidade autorizada e o recálculo autoritativo.
 */
export async function quantidadeInterna(req: Request, res: Response) {
  const { empresaId } = await contextoCheckout(req);
  const corpo = validarCorpoQuantidade(req.body);
  const cotacao = await cotarCarrinho(empresaId, { itens: corpo.itens, cupom: corpo.cupom });
  const linha = cotacao.itens.find((i) => chaveLinha(i) === chaveLinha(corpo.alvo));
  const aviso = linha && 'aviso' in linha && typeof linha.aviso === 'string' ? linha.aviso : undefined;
  if (!linha || ('indisponivel' in linha && linha.indisponivel === true)) {
    throw new HttpError(409, aviso ?? 'Este item não está mais disponível no catálogo.', { itens: 'Indisponível' });
  }
  if (!linha.ok || linha.quantidade !== corpo.alvo.quantidade) {
    const disponivel = Math.max(0, Number(linha.disponivel) || 0);
    throw new HttpError(
      409,
      disponivel > 0 ? `Só há ${disponivel} unidades disponíveis.` : 'Sem estoque no momento.',
      { itens: 'Estoque insuficiente' },
      'estoque_insuficiente',
      { disponivel }
    );
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    produto_id: linha.produto_id,
    tamanho_id: linha.tamanho_id,
    quantidade: linha.quantidade,
    disponivel: linha.disponivel,
    cotacao,
  });
}

/**
 * GET /api/commerce/checkout/:chave — recuperação somente-leitura após timeout,
 * reload ou perda de conexão. A chave aleatória funciona como credencial de
 * recuperação e NUNCA cria outro pedido/cobrança. Escopada ao tenant da sessão.
 */
export async function recuperarCheckoutInterno(req: Request, res: Response) {
  const { empresaId } = await contextoCheckout(req);
  const chave = String(req.params.chave || '').trim();
  if (chave.length < 8 || chave.length > 64) throw new HttpError(404, 'Checkout não encontrado.');
  const s = getStore();
  const pedido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, chave_checkout: chave });
  if (!pedido) throw new HttpError(404, 'Checkout não encontrado.');
  const sale = await s.findOneWhere(R_SALES(), { id: String(pedido.sale_id), empresa_id: empresaId });
  if (!sale) throw new HttpError(404, 'Checkout não encontrado.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, recuperado: true, ...(await respostaPedido(empresaId, sale)) });
}

/**
 * GET /api/commerce/checkout/pedido/:token — acompanhamento interno do pedido
 * (token = credencial). Escopado ao tenant da sessão: token de outra empresa
 * (ou inexistente) recebe a MESMA resposta 404.
 */
export async function pedidoInterno(req: Request, res: Response) {
  const { empresaId } = await contextoCheckout(req);
  const token = String(req.params.token || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, 'Pedido não encontrado.');
  const s = getStore();
  const pedido = await s.findOneWhere(R_PEDIDOS(), { checkout_token: token });
  if (!pedido || Number(pedido.empresa_id) !== empresaId) throw new HttpError(404, 'Pedido não encontrado.');
  const sale = await s.findOneWhere(R_SALES(), { id: String(pedido.sale_id), empresa_id: empresaId });
  if (!sale) throw new HttpError(404, 'Pedido não encontrado.');
  res.json({ ok: true, ...(await respostaPedido(empresaId, sale)) });
}

// ----------------------------------------------------------------------------
// POST /api/commerce/checkout — cria pedido + reserva + cobrança (idempotente)
// ----------------------------------------------------------------------------

async function respostaPedido(empresaId: number, sale: Row): Promise<Record<string, unknown>> {
  return montarVisaoDaSale(empresaId, sale, { publico: true });
}

/**
 * Cria o pedido interno (pedido + reserva + cobrança) de forma idempotente por
 * `chave_checkout`. O tenant vem da SESSÃO (`contextoCheckout`), nunca do corpo.
 */
export async function criarCheckoutCommerce(req: Request, res: Response) {
  const { empresaId, config } = await contextoCheckout(req);
  const corpo = (req.body || {}) as Record<string, unknown>;
  const s = getStore();

  const chave = String(corpo.chave || '').trim();
  if (chave.length < 8 || chave.length > 64) {
    throw new HttpError(400, 'Chave de idempotência do carrinho inválida.', { chave: 'Obrigatória (8–64 caracteres)' });
  }

  // Idempotência: reenvio do mesmo carrinho devolve o MESMO pedido.
  const existente = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, chave_checkout: chave });
  if (existente) {
    const sale = await s.findOneWhere(R_SALES(), { id: String(existente.sale_id), empresa_id: empresaId });
    if (sale) return res.status(200).json({ ok: true, idempotente: true, ...(await respostaPedido(empresaId, sale)) });
  }

  // IDENTIFICAÇÃO COMPLETA DO CLIENTE: nome, e-mail, WhatsApp, CPF (quando o
  // meio de pagamento/fiscal exige) e consentimento de marketing separado.
  // Decisão 100% server-side: o browser NÃO escolhe se o CPF é necessário.
  const method = String(corpo.payment_method || 'PIX') as PaymentMethod;
  const compradorValido = normalizarComprador(corpo.comprador, { exigirDocumento: method === 'PIX' });
  if (!compradorValido.ok) {
    throw new HttpError(400, compradorValido.mensagem, { comprador: `${compradorValido.campo}: ${compradorValido.mensagem}` });
  }
  const comprador = compradorValido.comprador;
  const nome = comprador.nome;
  const email = comprador.email;

  const itens = await resolverItensCarrinho(empresaId, corpo);
  if (itens.some((i) => i.disponivel < i.quantidade)) throw new HttpError(409, 'Estoque insuficiente para um dos itens. Atualize o carrinho.');
  const subtotal = round2(itens.reduce((soma, i) => soma + i.preco_unitario * i.quantidade, 0));

  // FRETE: sem provedor configurado o checkout recusa com a mensagem exata.
  const frete = await cotarFrete(freteDaConfig(config), {
    subtotal,
    cep: corpo.endereco && typeof corpo.endereco === 'object' ? ((corpo.endereco as Record<string, unknown>).cep as string) ?? null : null,
  });
  if (!frete.disponivel) throw new HttpError(409, frete.motivo);

  const codigoCupom = corpo.cupom ? normalizarCodigo(corpo.cupom) : '';
  const cupom = codigoCupom ? await avaliarCupomCodigo(empresaId, codigoCupom, subtotal) : null;
  if (cupom && !cupom.ok) throw new HttpError(400, cupom.erro, { cupom: cupom.erro });
  const promocao = (await melhorPromocaoDoCarrinho(empresaId, itensElegiveis(itens), subtotal, 'varejo')).promocao;
  const desconto = descontoFinalDoCheckout(subtotal, promocao, cupom);
  const usarCupom = desconto.origem === 'cupom' && cupom && cupom.ok;

  const endereco = (corpo.endereco && typeof corpo.endereco === 'object' ? corpo.endereco : null) as Record<string, unknown> | null;
  // Forma canônica do endereço: CEP com EXATAMENTE 8 dígitos (a máscara
  // 74000-000 é só visual) e UF com 2 letras maiúsculas. O backend revalida.
  if (endereco) {
    const cepBruto = String(endereco.cep ?? '').trim();
    if (cepBruto && cepBruto.replace(/\D/g, '').length !== 8)
      throw new HttpError(400, 'CEP inválido: informe os 8 dígitos (ex.: 74000-000).', { cep: 'CEP deve ter 8 dígitos.' });
    const ufBruta = String(endereco.uf ?? '').trim();
    if (ufBruta && !/^[A-Za-z]{2}$/.test(ufBruta))
      throw new HttpError(400, 'UF inválida: use a sigla do estado com 2 letras (ex.: GO).', { uf: 'UF deve ter 2 letras.' });
  }
  const provedorFrete = String(config?.frete_provedor || 'nenhum');
  if (provedorFrete === 'manual') {
    const obrigatorio = ['rua', 'numero', 'bairro', 'cidade', 'uf', 'cep'].filter(
      (k) => !endereco || !String(endereco[k] || '').trim()
    );
    if (obrigatorio.length) {
      throw new HttpError(400, 'Informe o endereço de entrega completo para o frete por tabela.', {
        endereco: `Campos obrigatórios: ${obrigatorio.join(', ')}`,
      });
    }
  }

  const totais = calcularTotaisCheckout({
    itens: itens.map((i) => ({ quantidade: i.quantidade, precoUnitario: i.preco_unitario })),
    frete: frete.valor,
    desconto: desconto.desconto,
  });

  if (!Number.isFinite(totais.total) || totais.total <= 0) throw new HttpError(409, 'Total inválido para pagamento. Revise o carrinho.');

  const dono = await responsavelCheckout(empresaId, config);
  const escopo = escopoDeSistema(empresaId);
  if (!METHODS.includes(method) || !(await candidates({empresaId, method, amount:paraCentavos(totais.total), currency:'BRL',country:'BR',channel:'OWN_STORE',installments:1})).length) throw new HttpError(409,'Método indisponível no Payment Engine.');
  const { externalOrderId, token } = gerarIdentificadores();

  const criado = await s.transaction(
    async (tx) => {
      // corrida do mesmo carrinho: outro request pode ter acabado de criar
      const repetido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, chave_checkout: chave }, tx);
      if (repetido) return { pedido: repetido, sale: await s.findOneWhere(R_SALES(), { id: String(repetido.sale_id), empresa_id: empresaId }, tx) };

      const agora = new Date().toISOString();
      const expiraEm = new Date(Date.now() + (Number(config?.checkout_expira_minutos) || 60) * 60_000).toISOString();
      const saleId = connectorCuid();
      const sale = await s.insert(
        R_SALES(),
        {
          id: saleId,
          reference: marketplaceSaleReference(empresaId, dono, 'BROBOND', externalOrderId),
          quantity: itens.reduce((soma, i) => soma + i.quantidade, 0),
          amount_cents: paraCentavos(totais.total),
          currency: 'BRL',
          status: 'PENDING',
          occurred_at: agora,
          channel: 'BROBOND',
          external_order_id: externalOrderId,
          usuario_id: dono,
          empresa_id: empresaId,
          buyer_name: nome,
          buyer_email: email,
        },
        tx
      );
      for (const item of itens) {
        await s.insert(
          R_SALE_ITEMS(),
          {
            id: connectorCuid(),
            sale_id: saleId,
            product_id: item.produto_id,
            size_id: item.tamanho_id,
            variacao_externa: null,
            quantity: item.quantidade,
            unit_price_cents: paraCentavos(item.preco_unitario),
            discount_cents: 0,
            subtotal_cents: paraCentavos(item.preco_unitario) * item.quantidade,
          },
          tx
        );
      }

      const pedido = await s.insert(
        R_PEDIDOS(),
        {
          empresa_id: empresaId,
          canal: 'BROBOND',
          pedido_externo: externalOrderId,
          sale_id: saleId,
          venda_id: null,
          cobranca_id: null,
          checkout_token: token,
          chave_checkout: chave,
          estado: 'AGUARDANDO_PAGAMENTO',
          pagamento_estado: 'PENDING',
          frete_valor: frete.valor,
          desconto: desconto.desconto,
          cupom_codigo: usarCupom && cupom && cupom.ok ? String(cupom.cupom.codigo || codigoCupom) : null,
          total: totais.total,
          // Contato completo do pedido (JSONB). CPF fica SOMENTE aqui, no
          // backend — a visão pública devolve apenas a máscara.
          comprador,
          endereco: endereco
            ? {
                rua: String(endereco.rua || '').slice(0, 160),
                numero: String(endereco.numero || '').slice(0, 20),
                complemento: endereco.complemento ? String(endereco.complemento).slice(0, 80) : null,
                bairro: String(endereco.bairro || '').slice(0, 80),
                cidade: String(endereco.cidade || '').slice(0, 80),
                uf: String(endereco.uf || '').slice(0, 2).toUpperCase(),
                cep: String(endereco.cep || '').replace(/\D/g, '').slice(0, 8),
              }
            : null,
          expira_em: expiraEm,
          pago_em: null,
          convertido_em: null,
          erro: null,
          criado_por: dono,
          criado_em: agora,
          atualizado_em: agora,
        },
        tx
      );

      // RESERVA ANTES da cobrança (motor canônico, mesma regra da venda).
      for (const item of itens) {
        try {
          await criarReservaInterna(
            escopo,
            {
              produto_id: item.produto_id,
              tamanho_id: item.tamanho_id,
              local_id: null,
              quantidade: item.quantidade,
              tipo: 'reserva',
              origem_recurso: ORIGEM_CHECKOUT,
              origem_id: Number(pedido.id),
              motivo: `Checkout ${externalOrderId}`,
              criado_por: dono,
            },
            tx
          );
        } catch (e) {
          if (e instanceof HttpError && e.status === 409) {
            throw new HttpError(409, `${item.nome}: ${e.message} Atualize o carrinho e tente novamente.`);
          }
          throw e;
        }
      }

      if (usarCupom && cupom && cupom.ok) {
        const consumido = await consumirUsoCupom(empresaId, codigoCupom, subtotal, tx);
        // Atribuição é um vínculo imutável ao mesmo checkout; sem duplicar a venda
        // ou inferir receita/comissão. Só existe se a parceria já estiver ativa.
        const { atribuirCheckoutCreator } = await import('../creators');
        await atribuirCheckoutCreator(empresaId, Number(consumido.id), Number(pedido.id), tx);
      }

      return { pedido, sale };
    },
    { isolation: 'serializable' }
  );

  if (!criado.sale) throw new HttpError(500, 'Pedido criado sem venda associada — contate o suporte.');

  // COBRANÇA via gateway (backend; falhou → desfaz reserva/cupom com estado ERRO).
  try {
    await paymentEngine.createForOrder(empresaId, Number(criado.pedido.id), method, `checkout:${criado.pedido.id}`, { taxId: comprador.documento ?? undefined });
  } catch (e) {
    // Timeout/queda de rede não provam que o provider deixou de criar a
    // cobrança. Cancelar pedido/reserva aqui permitia vender a mesma peça e
    // depois receber um PIX já aprovado. Resultado incerto permanece PENDENTE,
    // vinculado à mesma intent/chave; webhook ou reconciliação concluem o fluxo.
    if (e instanceof HttpError && e.code === 'PAYMENT_CREATION_UNCERTAIN') {
      await s.update(R_PEDIDOS(), Number(criado.pedido.id), {
        estado: 'AGUARDANDO_PAGAMENTO', pagamento_estado: 'PENDING',
        erro: 'Criação do pagamento aguardando confirmação do provedor; não repita a cobrança.',
        atualizado_em: new Date().toISOString(),
      });
    } else {
      await falharCheckout(empresaId, criado.pedido, criado.sale, e instanceof Error ? e.message : String(e));
    }
    throw e instanceof HttpError
      ? e
      : new HttpError(
          502,
          method === 'PIX'
            ? 'Não foi possível gerar o PIX neste momento. Seu pedido não foi confirmado. Tente novamente.'
            : 'Não foi possível iniciar o pagamento do pedido. Seu pedido não foi confirmado. Tente novamente.'
        );
  }

  // NOTIFICATION ORCHESTRATOR — só registra eventos no outbox. Nenhum adapter
  // de e-mail/WhatsApp é chamado aqui: pedido criado NUNCA depende do provedor.
  const contato: ContatoPedido = { nome, email, whatsapp: comprador.whatsapp, telefone: comprador.telefone };
  const ctxEvento = {
    empresaId,
    pedidoId: Number(criado.pedido.id),
    pedidoExterno: externalOrderId,
    checkoutToken: token,
  };
  // ORDER_CREATED gera A mensagem "Pedido recebido" (status aguardando
  // pagamento + instruções do PIX real). PAYMENT_PENDING/PIX_GENERATED ficam
  // registrados como consolidados — sem 3 e-mails/WhatsApps no mesmo segundo.
  const eventos: EventoNotificacao[] = ['ORDER_CREATED', 'PAYMENT_PENDING'];
  const saleFinal = (await s.findOneWhere(R_SALES(), { id: String(criado.sale.id), empresa_id: empresaId })) ?? criado.sale;
  // Uma ÚNICA montagem da visão pública por checkout (antes eram duas: a
  // resposta e uma leitura extra). Itens/rastreio/timeline lidos uma vez só.
  const visao = await respostaPedido(empresaId, saleFinal);
  const pagamento = visao.pagamento as Record<string, unknown> | undefined;
  if (method === 'PIX' && (pagamento?.copia_cola || pagamento?.qr_code_base64 || pagamento?.ticket_url)) eventos.push('PIX_GENERATED');
  // Em sequência (ordem determinística), fora do caminho crítico da resposta.
  void (async () => {
    for (const evento of eventos) await registrarEventoSeguro(contato, { ...ctxEvento, evento });
  })();
  res.status(201).json({ ok: true, ...visao });
}

function gerarIdentificadores(): { externalOrderId: string; token: string } {
  return {
    externalOrderId: `LOJA-${connectorCuid().slice(-12).toUpperCase()}`,
    token: randomBytes(32).toString('hex'),
  };
}

/** Estado honesto quando a cobrança não nasceu: ERRO + tudo devolvido. */
async function falharCheckout(empresaId: number, pedido: Row, sale: Row, motivo: string): Promise<void> {
  const s = getStore();
  const escopo = escopoDeSistema(empresaId);
  await s.transaction(
    async (tx) => {
      const mudou = await s.tryUpdateIf(
        R_PEDIDOS(),
        Number(pedido.id),
        { estado: 'AGUARDANDO_PAGAMENTO' },
        { estado: 'ERRO', pagamento_estado: 'ERROR', erro: motivo.slice(0, 400), atualizado_em: new Date().toISOString() },
        tx
      );
      if (!mudou) return;
      const reservas = await s.list(
        getResource('estoque_reservas')!,
        { page: 1, pageSize: 200, filter: { empresa_id: empresaId, origem_recurso: ORIGEM_CHECKOUT, origem_id: Number(pedido.id), status: 'ativa' } },
        tx
      );
      for (const r of reservas.rows) await liberarReservaInterna(escopo, Number(r.id), tx).catch(() => undefined);
      await liberarUsoCupom(empresaId, pedido.cupom_codigo ? String(pedido.cupom_codigo) : null, tx);
      if (String(sale.status) === 'PENDING') {
        await s.update(R_SALES(), sale.id as unknown as number, { status: 'CANCELLED' } as never, tx);
      }
    },
    { isolation: 'serializable' }
  );
}
