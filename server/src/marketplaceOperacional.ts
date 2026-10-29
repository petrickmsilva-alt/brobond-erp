// ============================================================================
// GOLIVE-03 — PONTE MARKETPLACE → VENDA OPERACIONAL.
//
// PROBLEMA: a ingestão de canais externos grava SOMENTE `sales`/`sale_items`
// (o modelo de leitura ANALÍTICO). A venda de marketplace ficava como registro
// analítico e nunca entrava no fluxo OPERACIONAL canônico do ERP
// (`vendas`/`itens_venda` → estoque → financeiro → fiscal → expedição → BI).
//
// SOLUÇÃO: esta ponte CONVERTE uma ordem externa já ingerida em uma venda
// operacional REAL, reutilizando os motores canônicos — NÃO existe segundo
// motor de vendas, nem cálculo paralelo de total/estoque/financeiro:
//
//   `recalcularTotal`      (itens.ts)   — total canônico a partir dos itens;
//   `aplicarRegrasPedido`  (itens.ts)   — faturamento: baixa de estoque +
//                                          movimentações + comissão;
//   `syncLancamentoVenda`  (financeiro.ts) — contas a receber idempotente.
//
// GARANTIAS:
//   • MULTIEMPRESA: a empresa vem SEMPRE da linha de `sales` (tenant do
//     conector), nunca de um contexto global. Cliente/produto são resolvidos
//     DENTRO da empresa; ambiguidade → FAIL CLOSED (nunca escolhe sozinho).
//   • IDEMPOTÊNCIA/CONCORRÊNCIA: identidade operacional determinística
//     (empresa_id, canal, pedido_externo_id) com índice único parcial + upsert.
//     N processamentos (inclusive concorrentes) → UMA venda, UMA baixa, UM
//     lançamento.
//   • BI: a linha analítica original PERMANECE como a representação única da
//     venda no BI (recebe o vínculo `operational_venda_id`), e a projeção
//     `vendas → sales` pula essa venda — sem venda duplicada no BI.
//
// Todo o trabalho roda numa ÚNICA transação SERIALIZABLE: uma falha no meio
// (financeiro/estoque) desfaz venda, itens, movimentações e lançamentos.
// ============================================================================
import { HttpError } from './errors';
import { getStore, toHttpError } from './services';
import { getResource } from './resources';
import { empresaDoRegistroAudit, escopoDoAtor, type EscopoEmpresa } from './empresa';
import { aplicarRegrasPedido, recalcularTotal } from './itens';
import { syncLancamentoVenda } from './financeiro';
import { executarGanchoConversao } from './conversion-hooks';
import type { Row, Tx } from './store';

/** Prefixo do canal externo na referência idempotente (rastreabilidade). */
const REF_PREFIX = 'MKT';

/** Rótulo legível do canal gravado em `vendas.observacoes`. */
const CANAL_LABEL: Record<string, string> = {
  MERCADOLIVRE: 'Mercado Livre',
  MERCADOPAGO: 'Mercado Pago',
  NUVEMSHOP: 'Nuvemshop',
  INSTAGRAM_SHOPPING: 'Instagram Shopping',
  BROBOND: 'Canal próprio',
};

export interface MarketplaceConversionResult {
  /** Venda operacional (`vendas.id`). */
  vendaId: number;
  /** Linha analítica de origem (`sales.id`). */
  saleId: string;
  empresaId: number;
  canal: string;
  pedidoExternoId: string;
  /** `created` = venda criada agora; `existing` = já existia (idempotência). */
  outcome: 'created' | 'existing';
  total: number;
  itemCount: number;
}

export interface MarketplaceConversionDeps {
  /** Injetável nos testes; o padrão é o store real do servidor. */
  store?: ReturnType<typeof getStore>;
}

/**
 * `empresa + canal + pedido_externo` — a identidade OPERACIONAL da ordem.
 * É o mesmo par que o índice único `uq_vendas_pedido_externo` guarda.
 */
export function marketplaceVendaReference(empresaId: number, canal: string, pedidoExternoId: string): string {
  return `${REF_PREFIX}-${empresaId}-${canal.toUpperCase()}-${pedidoExternoId}`;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Resolve o CLIENTE da empresa de forma determinística:
 *   1. por e-mail (identidade confiável quando o provedor expõe);
 *   2. por nome exato;
 *   3. cria um cliente novo.
 * Roda dentro da transação: um retry encontra o cliente já criado e não
 * duplica (o mesmo e-mail/nome resolve para a mesma linha).
 */
async function resolverCliente(
  s: ReturnType<typeof getStore>,
  empresaId: number,
  buyer: { name: string | null; email: string | null },
  tx: Tx
): Promise<number | null> {
  const r = getResource('clientes')!;
  const email = buyer.email ? buyer.email.toLowerCase() : null;
  if (email) {
    const porEmail = await s.findOneWhere(r, { empresa_id: empresaId, email }, tx);
    if (porEmail) return Number(porEmail.id);
  }
  if (buyer.name) {
    const porNome = await s.findOneWhere(r, { empresa_id: empresaId, nome: buyer.name }, tx);
    if (porNome) return Number(porNome.id);
  }
  // Sem identidade alguma do comprador: não inventa cliente (consumidor final
  // é representado por `cliente_id = NULL`, como no PDV).
  if (!email && !buyer.name) return null;
  const criado = await s.insert(
    r,
    {
      empresa_id: empresaId,
      nome: buyer.name || buyer.email || 'Cliente marketplace',
      email: email,
      tipo: 'varejo',
      ativo: true,
    },
    tx
  );
  return Number(criado.id);
}

interface ItemResolvido {
  produtoId: number;
  tamanhoId: number | null;
  quantidade: number;
  precoUnitario: number;
  subtotal: number;
}

/**
 * Converte UM item analítico no item operacional, de forma DETERMINÍSTICA e
 * fail-closed.
 *
 * O casamento com o catálogo é feito na INGESTÃO (`matchCatalogItem` grava
 * `product_id`/`size_id` em `sale_items`). A ponte NÃO refaz esse casamento:
 * reconsumir o SKU cru aqui seria uma segunda fonte de verdade. O que a ponte
 * exige é que o vínculo JÁ exista — item sem produto casado NÃO vira venda
 * (nunca se cria a venda com o produto errado).
 */
async function resolverItem(
  s: ReturnType<typeof getStore>,
  empresaId: number,
  item: Row,
  tx: Tx
): Promise<ItemResolvido> {
  const quantidade = positiveInt(item.quantity) ?? 1;
  const precoUnitario = Number(item.unit_price_cents ?? 0) / 100;
  const subtotal = Number(item.subtotal_cents ?? Math.round(quantidade * precoUnitario * 100)) / 100;
  const rotulo = clean(item.variacao_externa) || '—';

  const produtoId = positiveInt(item.product_id);
  if (!produtoId) {
    throw new HttpError(
      409,
      `O item "${rotulo}" não foi casado com um produto do catálogo da empresa. Corrija o SKU do produto e reprocesse a ingestão antes de converter a venda.`
    );
  }
  // O produto precisa ser DA EMPRESA da venda — bloqueia vínculo cruzado entre
  // tenants mesmo que a FK do banco aceite.
  const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId, empresa_id: empresaId }, tx);
  if (!produto) {
    throw new HttpError(409, `O produto do item "${rotulo}" não pertence à empresa da venda.`);
  }

  // Tamanho: o da ingestão; se ausente/ inválido, tenta pelo texto da variação.
  let tamanhoId = positiveInt(item.size_id);
  if (tamanhoId) {
    const tam = await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx);
    if (!tam) tamanhoId = null;
  }
  if (!tamanhoId) {
    const variacao = clean(item.variacao_externa);
    if (variacao) {
      const tam = await s.findOneWhere(getResource('tamanhos')!, { codigo: variacao.split(' / ')[0] }, tx);
      if (tam) tamanhoId = Number(tam.id);
    }
  }

  return { produtoId, tamanhoId, quantidade, precoUnitario, subtotal };
}

/**
 * Converte uma ordem externa analítica (`sales`) numa venda OPERACIONAL real,
 * reusando os motores canônicos. Idempotente e seguro para chamar N vezes.
 *
 * `escopo` é o escopo do ATOR que dispara a conversão. A empresa da venda é a
 * da LINHA `sales`; o escopo do ator apenas AUTORIZA o acesso — uma ordem de
 * outra empresa responde 404 (não vaza a existência).
 */
export async function converterOrdemMarketplaceEmVenda(
  saleId: string,
  escopo: EscopoEmpresa,
  deps: MarketplaceConversionDeps = {}
): Promise<MarketplaceConversionResult> {
  const s = deps.store ?? getStore();
  const id = clean(saleId);
  if (!id) throw new HttpError(400, 'Informe o identificador da venda de marketplace.');

  return s
    .transaction(async (tx) => {
      // 1) A ordem analítica. A empresa vem DELA (tenant do conector); o
      //    escopo do ator só autoriza. Fail-closed se a linha não existir ou
      //    for de outra empresa.
      const sale = await s.findOneWhere(getResource('sales')!, { id }, tx);
      if (!sale) throw new HttpError(404, 'Venda de marketplace não encontrada.');
      const empresaId = positiveInt(sale.empresa_id);
      if (!empresaId) throw new HttpError(409, 'A venda de marketplace não tem empresa definida.');
      if (!escopo.consolidado && escopo.empresaId !== empresaId) {
        throw new HttpError(404, 'Venda de marketplace não encontrada.');
      }

      const canal = clean(sale.channel) || 'BROBOND';
      const pedidoExternoId = clean(sale.external_order_id);
      if (!pedidoExternoId) {
        throw new HttpError(409, 'A venda de marketplace não tem pedido externo — não é possível convertê-la em venda operacional.');
      }

      const rVendas = getResource('vendas')!;

      // 2) Idempotência: já convertida? Devolve a venda existente.
      const jaConvertida = await s.findOneWhere(
        rVendas,
        { empresa_id: empresaId, pedido_externo_canal: canal, pedido_externo_id: pedidoExternoId },
        tx
      );
      if (jaConvertida) {
        return {
          vendaId: Number(jaConvertida.id),
          saleId: id,
          empresaId,
          canal,
          pedidoExternoId,
          outcome: 'existing' as const,
          total: Number(jaConvertida.total || 0),
          itemCount: 0,
        };
      }

      // Recheck termination INSIDE the serializable conversion transaction.
      // This covers direct marketplace callers and expiry/cancellation races;
      // a previously converted sale may still be returned idempotently above.
      const pedido = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, sale_id: id }, tx);
      if (['CANCELLED', 'REFUNDED'].includes(String(sale.status)) ||
          (pedido && ['CANCELADO', 'EXPIRADO', 'ESTORNADO'].includes(String(pedido.estado))))
        throw new HttpError(409, 'Pedido encerrado não pode gerar uma nova venda operacional.');

      // 3) Itens da ordem analítica, resolvidos no catálogo da empresa.
      const itensAnaliticos = await s.list(getResource('sale_items')!, { page: 1, pageSize: 500, filter: { sale_id: id } }, tx);
      if (!itensAnaliticos.rows.length) {
        throw new HttpError(409, 'A venda de marketplace não tem itens — nada a converter.');
      }
      const itens: ItemResolvido[] = [];
      for (const linha of itensAnaliticos.rows) {
        itens.push(await resolverItem(s, empresaId, linha, tx));
      }

      // 4) Cliente da empresa, determinístico.
      const clienteId = await resolverCliente(
        s,
        empresaId,
        { name: clean(sale.buyer_name) || null, email: clean(sale.buyer_email) || null },
        tx
      );

      // 5) Venda operacional REAL em `vendas`. A venda é operacionalmente
      //    indistinguível das demais, exceto pelo canal e pelo pedido externo.
      const venda = await s.insert(
        rVendas,
        {
          empresa_id: empresaId,
          cliente_id: clienteId,
          data: new Date().toISOString().slice(0, 10),
          status: 'aberta',
          canal_venda: 'marketplace',
          fin_status: 'a_receber',
          pedido_externo_canal: canal,
          pedido_externo_id: pedidoExternoId,
          observacoes: [
            `Venda operacional gerada do pedido ${marketplaceVendaReference(empresaId, canal, pedidoExternoId)}`,
            `Canal: ${CANAL_LABEL[canal] ?? canal}`,
            `Pedido externo: ${pedidoExternoId}`,
          ].join('\n'),
        },
        tx
      );
      const vendaId = Number(venda.id);

      // 6) Itens canônicos em `itens_venda`.
      for (const item of itens) {
        await s.insert(
          getResource('itens_venda')!,
          {
            empresa_id: empresaId,
            venda_id: vendaId,
            produto_id: item.produtoId,
            tamanho_id: item.tamanhoId,
            quantidade: item.quantidade,
            preco_unitario: item.precoUnitario,
            desconto_pct: 0,
            subtotal: item.subtotal,
          },
          tx
        );
      }

      // 6.5) GANCHO commerce (mesma transação SERIALIZABLE): consome a RESERVA
      //     de checkout vinculada a esta ordem (senão o próprio disponível
      //     recusaria o faturamento abaixo) e carimba frete/desconto do
      //     checkout na venda. Hook nulo = comportamento legado intacto.
      await executarGanchoConversao(
        { saleId: id, empresaId, vendaId, canal, pedidoExternoId },
        tx
      );

      // 7) TOTAL canônico: recalculado pelo ERP a partir dos itens (os preços
      //    REAIS praticados no pedido), nunca copiado do total do marketplace —
      //    que carrega frete/impostos e arredondamentos próprios. Assim o
      //    valor da venda, o estoque e o financeiro falam a MESMA língua.
      await recalcularTotal('venda', vendaId, tx);

      // 8) Faturamento canônico: estoque (baixa + movimentações) + comissão.
      //    `escopoDaVenda` é o escopo da EMPRESA DA VENDA — os motores validam
      //    o registro contra ele.
      const escopoDaVenda: EscopoEmpresa = { empresaId, consolidado: false, permitidas: [empresaId] };
      const aberta = (await s.get(rVendas, vendaId, tx))!;
      const faturada = (await s.tryUpdateIf(rVendas, vendaId, { status: 'aberta' }, { status: 'faturada' }, tx)) ?? aberta;
      await aplicarRegrasPedido('venda', aberta, faturada, { status: 'faturada' }, { id: null, name: 'Marketplace' }, tx, escopoDaVenda);

      // 9) Financeiro canônico (contas a receber), idempotente por referência.
      const depois = (await s.get(rVendas, vendaId, tx)) ?? faturada;
      await syncLancamentoVenda(aberta, depois, { status: 'faturada' }, { id: null, name: 'Marketplace' }, tx);

      // 10) BI sem duplicidade: a linha analítica ORIGINAL permanece como a
      //     representação única da venda. Ela recebe o vínculo operacional e os
      //     totais/estado canônicos — a projeção `vendas → sales` (ADR-001)
      //     pula as vendas com `pedido_externo_id` (ver negocios.ts), então o
      //     BI conta UMA.
      const totalCanonico = Number(depois.total || 0);
      const quantidade = itens.reduce((n, i) => n + i.quantidade, 0);
      // `sales.id` é TEXT (cuid) — o id precisa ser repassado como veio, não
      // convertido para número (Number('cuid') = NaN e o UPDATE não acharia a
      // linha).
      await s.update(
        getResource('sales')!,
        sale.id as unknown as number,
        {
          operational_venda_id: vendaId,
          amount_cents: Math.round(totalCanonico * 100),
          quantity: quantidade,
          status: 'PAID',
        },
        tx
      );

      await s.audit(
        {
          usuario_id: null,
          usuario: 'Marketplace',
          acao: 'criar',
          recurso: 'vendas',
          registro_id: vendaId,
          descricao: `Venda marketplace ${marketplaceVendaReference(empresaId, canal, pedidoExternoId)} convertida em venda operacional #${vendaId} (${itens.length} item(ns), total ${totalCanonico.toFixed(2)})`,
          empresa_id: empresaDoRegistroAudit(rVendas, depois, null),
          dados: { sale_id: id, canal, pedido_externo_id: pedidoExternoId, total: totalCanonico, itens: itens.length },
        },
        tx
      );

      return {
        vendaId,
        saleId: id,
        empresaId,
        canal,
        pedidoExternoId,
        outcome: 'created' as const,
        total: totalCanonico,
        itemCount: itens.length,
      };
    }, { isolation: 'serializable' })
    .catch((e) => {
      throw toHttpError(e, getResource('vendas')!);
    });
}

/** Atalho HTTP: converte usando o escopo do ator autenticado. */
export async function converterOrdemDoAtor(saleId: string, actor: Parameters<typeof escopoDoAtor>[0]): Promise<MarketplaceConversionResult> {
  return converterOrdemMarketplaceEmVenda(saleId, escopoDoAtor(actor));
}
