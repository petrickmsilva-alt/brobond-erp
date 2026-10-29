// ============================================================================
// COMMERCE OS — PEDIDOS OMNICHANNEL (inbox, conversão, pagamento, fulfillment).
//
// Verdade dos dados:
//   • ANALÍTICA   → `sales` (já ingerida; nunca duplicada);
//   • OPERACIONAL → `vendas` (a ponte marketplaceOperacional é a ÚNICA ponte);
//   • PROJEÇÃO    → `commerce_pedidos` (token, cobrança, máquina de estados).
// Aqui apenas LÊ, projeta e orquestra — nenhum motor paralelo de venda.
// ============================================================================
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../errors';
import { getStore, checkAccess, checkFluxo } from '../services';
import { currentUser } from '../auth';
import { escopoDoAtor, escopoDeSistema, empresaDoRegistroAudit, type EscopoEmpresa } from '../empresa';
import { getResource } from '../resources';
import { converterOrdemMarketplaceEmVenda } from '../marketplaceOperacional';
import { setOnVendaConvertendo, type ConversaoContexto } from '../conversion-hooks';
import { R_GATEWAY_COBRANCAS, R_GATEWAY_WEBHOOK_EVENTS, setOnCobrancaAlterada, type CobrancaAlteradaEvento } from '../gateway';
import { liberarReservaInterna } from '../estoqueTransferencia';
import { connectorCuid } from '../../../modules/connectors/core/id';
import { addOnSaleIngested } from '../../../modules/connectors/core/sale-events';
import { enfileirarOutbox } from './outbox';
import { liberarUsoCupom } from './promocoes';
import { nomesProdutos } from './grade';
import type { Row, Tx } from '../store';
import {
  ESTADOS_PEDIDO,
  deCentavos,
  ehEstadoPedido,
  estadoSeguraReserva,
  mapearEstadoPagamento,
  transicaoPedido,
  type EstadoPedido,
} from './regras';

const R_PEDIDOS = () => getResource('commerce_pedidos')!;
const R_SALES = () => getResource('sales')!;
const R_SALE_ITEMS = () => getResource('sale_items')!;
const R_VENDAS = () => getResource('vendas')!;
const R_RESERVAS = () => getResource('estoque_reservas')!;
const R_RASTREIO = () => getResource('commerce_rastreio')!;

export const ORIGEM_CHECKOUT = 'commerce_checkout';

// ----------------------------------------------------------------------------
// Projeção do pedido (upsert por empresa + canal + pedido_externo)
// ----------------------------------------------------------------------------

function tokenCheckout(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Garante a linha de projeção de uma `sale` (usada pelo fluxo de checkout e
 * pelo listener de marketplaces). Idempotente pela identidade canônica.
 */
export async function garantirPedidoDaSale(
  empresaId: number,
  sale: Row,
  tx?: Tx
): Promise<Row> {
  const s = getStore();
  const canal = String(sale.channel || 'BROBOND');
  const externo = String(sale.external_order_id || '');
  const existente = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, canal, pedido_externo: externo }, tx);
  if (existente) {
    if (existente.sale_id !== sale.id) {
      return (await s.update(R_PEDIDOS(), Number(existente.id), { sale_id: sale.id }, tx))!;
    }
    return existente;
  }
  const estado: EstadoPedido =
    String(sale.status) === 'PAID' ? 'PAGO' : String(sale.status) === 'CANCELLED' ? 'CANCELADO' : 'AGUARDANDO_PAGAMENTO';
  try {
    return await s.insert(
      R_PEDIDOS(),
      {
        empresa_id: empresaId,
        canal,
        pedido_externo: externo,
        sale_id: String(sale.id),
        venda_id: sale.operational_venda_id ? Number(sale.operational_venda_id) : null,
        cobranca_id: null,
        checkout_token: tokenCheckout(),
        chave_checkout: `mkt:${canal}:${externo}`,
        estado,
        pagamento_estado: String(sale.status) === 'PAID' ? 'APPROVED' : 'PENDING',
        frete_valor: 0,
        desconto: 0,
        cupom_codigo: null,
        total: deCentavos(Number(sale.amount_cents || 0)),
        comprador: { nome: sale.buyer_name ? String(sale.buyer_name) : null, email: sale.buyer_email ? String(sale.buyer_email) : null },
        endereco: null,
        expira_em: null,
        pago_em: String(sale.status) === 'PAID' ? new Date().toISOString() : null,
        convertido_em: sale.operational_venda_id ? new Date().toISOString() : null,
        erro: null,
        criado_por: sale.usuario_id != null ? Number(sale.usuario_id) : null,
        criado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      },
      tx
    );
  } catch (e: any) {
    // Corrida de ingestão simultânea: o índice único (empresa+canal+pedido
    // externo) arbitra — devolvemos a linha vencedora, nunca 500 nem duplicata.
    if (e?.code !== '23505' && e?.cause?.code !== '23505') throw e;
    const deNovo = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, canal, pedido_externo: externo }, tx);
    if (deNovo) return deNovo;
    throw e;
  }
}

// ----------------------------------------------------------------------------
// Conversão (ponte única) + gancho de reserva/frete
// ----------------------------------------------------------------------------

/**
 * Gancho registrado em `conversion-hooks`: NA MESMA transação da ponte,
 * antes do faturamento, consome a reserva de checkout (senão o disponível
 * recusaria a própria venda) e carimba frete/desconto do checkout na venda.
 */
export async function ganchoConversaoCommerce(ctx: ConversaoContexto, tx: Tx): Promise<void> {
  const s = getStore();
  const pedido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: ctx.empresaId, sale_id: ctx.saleId }, tx);
  if (!pedido) return; // pedido de marketplace sem reserva de checkout

  const reservas = await s.list(
    R_RESERVAS(),
    { page: 1, pageSize: 500, filter: { empresa_id: ctx.empresaId, origem_recurso: ORIGEM_CHECKOUT, origem_id: Number(pedido.id), status: 'ativa' } },
    tx
  );
  for (const r of reservas.rows) {
    // CAS: a reserva pode ter sido liberada pela expiração em paralelo.
    await s.tryUpdateIf(
      R_RESERVAS(),
      Number(r.id),
      { status: 'ativa' },
      { status: 'consumida', atualizado_em: new Date().toISOString() },
      tx
    );
  }
  // Frete/desconto do checkout valem para o total operacional (recalcularTotal
  // roda logo em seguida e os enxerga).
  await s.update(
    R_VENDAS(),
    ctx.vendaId,
    { frete: Number(pedido.frete_valor || 0), desconto: Number(pedido.desconto || 0) },
    tx
  );
}

export type ResultadoConversao = {
  estado: EstadoPedido;
  venda_id: number | null;
  pendencia?: string;
};

/**
 * Converte uma `sale` em venda operacional pela ponte existente, com a
 * projeção do pedido atualizada. 409 de item sem casamento →
 * AGUARDANDO_CORRECAO + mensagem honesta (nunca adivinha o produto).
 */
export async function converterPedidoSale(empresaId: number, saleId: string): Promise<ResultadoConversao> {
  const s = getStore();
  const sale = await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: empresaId });
  if (!sale) throw new HttpError(404, 'Venda não encontrada.');
  const pedido = await garantirPedidoDaSale(empresaId, sale);
  const pedidoId = Number(pedido.id);

  if (sale.operational_venda_id) {
    if (String(pedido.estado) !== 'CONVERTIDO' && String(pedido.estado) !== 'ESTORNADO') {
      await s.update(R_PEDIDOS(), pedidoId, {
        estado: 'CONVERTIDO',
        convertido_em: (pedido.convertido_em as string | null) ?? new Date().toISOString(),
        venda_id: Number(sale.operational_venda_id),
        erro: null,
      });
    }
    return { estado: 'CONVERTIDO', venda_id: Number(sale.operational_venda_id) };
  }
  if (String(pedido.estado) === 'CONVERTIDO' || String(pedido.estado) === 'ESTORNADO') {
    return { estado: String(pedido.estado) as EstadoPedido, venda_id: pedido.venda_id ? Number(pedido.venda_id) : null };
  }
  // Checkout próprio: só com pagamento confirmado (o fluxo pagamento chama
  // isto DEPOIS do evento do gateway). Marketplaces convertem pelo canal.
  if (String(pedido.canal) === 'BROBOND' && pedido.cobranca_id && String(pedido.estado) !== 'PAGO' && String(pedido.estado) !== 'AGUARDANDO_CORRECAO') {
    throw new HttpError(409, 'Pedido aguardando confirmação de pagamento — a conversão segue o pagamento, nunca o contrário.');
  }

  const escopo = {
    ...escopoDeSistema(empresaId),
    origemCanal: String(sale.channel || 'BROBOND'),
    source: { kind: 'canal', usuarioId: Number(sale.usuario_id ?? 0) },
  } as unknown as Parameters<typeof converterOrdemMarketplaceEmVenda>[1];

  try {
    // A ponte é DONA da sua transação SERIALIZABLE (o gancho de reservas roda
    // lá dentro, antes do faturamento) — aqui só orquecionamos a projeção.
    const resultado = await converterOrdemMarketplaceEmVenda(String(sale.id), escopo);
    const vendaId = resultado.vendaId;
    await s.update(R_PEDIDOS(), pedidoId, {
      estado: 'CONVERTIDO',
      convertido_em: new Date().toISOString(),
      venda_id: vendaId,
      erro: null,
    });
    await agendarMargemSale(String(sale.id), empresaId);
    return { estado: 'CONVERTIDO', venda_id: vendaId };
  } catch (e) {
    const pendencia = e instanceof HttpError ? e.message : null;
    if (e instanceof HttpError && e.status === 409) {
      await s.update(R_PEDIDOS(), pedidoId, { estado: 'AGUARDANDO_CORRECAO', erro: pendencia?.slice(0, 500) ?? null });
      return { estado: 'AGUARDANDO_CORRECAO', venda_id: null, pendencia: pendencia ?? undefined };
    }
    throw e;
  }
}

/**
 * Pede ao MOTOR de margem (1. MEU NEGÓCIOS) o recálculo desta venda — mesma
 * fonte do BI, nunca cálculo de margem dentro do commerce.
 */
async function agendarMargemSale(saleId: string, empresaId: number): Promise<void> {
  try {
    const { repoNegocios } = await import('../negocios');
    await repoNegocios().recalcularMargens([saleId], empresaId);
  } catch {
    // motor indisponível no ambiente → o ciclo automático recalcula depois
  }
}

// ----------------------------------------------------------------------------
// Confirmação de pagamento (ouvinte do gateway — nunca do frontend)
// ----------------------------------------------------------------------------

/**
 * O gateway chama isto DEPOIS de processar o evento da cobrança (hook
 * setOnCobrancaAlterada). Projeta o pedido, libera reserva quando o dinheiro
 * morre e aciona a conversão quando ele chega. Tudo idempotente por estado.
 */
/**
 * Repete uma operação que falhou com 40001 (SSI). Corridas legítimas de
 * fila/agendamento (varredura × varredura, expiração × webhook) abortam UMA
 * das partes; a parte que já reivindicou um estado DEVE concluir o resto —
 * retry curto e determinístico, nunca perder release/cancelamento.
 */
async function repetirSerial<T>(fn: () => Promise<T>, tentativas = 5): Promise<T> {
  let ultimo: unknown = null;
  for (let i = 0; i < tentativas; i += 1) {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code !== '40001') throw e;
      ultimo = e;
      await new Promise((resolve) => setTimeout(resolve, 15 * (i + 1)));
    }
  }
  throw ultimo;
}

export async function confirmarPagamentoCobranca(evt: CobrancaAlteradaEvento): Promise<void> {
  const s = getStore();
  const cobranca = await s.get(R_GATEWAY_COBRANCAS, evt.cobrancaId);
  if (!cobranca || Number(cobranca.empresa_id) !== evt.empresaId) return;
  const pedidos = await s.list(R_PEDIDOS(), {
    page: 1,
    pageSize: 5,
    filter: { empresa_id: evt.empresaId, cobranca_id: evt.cobrancaId },
  });
  const pedido = pedidos.rows[0];
  if (!pedido) return; // cobrança avulsa do financeiro — sem projeção commerce
  const pedidoId = Number(pedido.id);
  const atual = String(pedido.estado) as EstadoPedido;
  const pagamento = mapearEstadoPagamento(cobranca.status);

  const evento =
    evt.intencao === 'paga'
      ? 'pago'
      : evt.intencao === 'cancelada'
        ? 'cancelado'
        : evt.intencao === 'expirada'
          ? 'expirado'
          : 'estornado';
  const novo = transicaoPedido(atual, evento);

  // Atualiza projeção quando a transição faz sentido (idempotente: repetir o
  // mesmo webhook não altera nada).
  if (novo && novo !== atual) {
    const agora = new Date().toISOString();
    const mudancas: Record<string, unknown> = { estado: novo, atualizado_em: agora };
    if (pagamento) mudancas.pagamento_estado = pagamento;
    if (evento === 'pago') mudancas.pago_em = agora;
    if (['cancelado', 'expirado'].includes(evento)) mudancas.erro = null;

    await repetirSerial(() =>
      s.transaction(
      async (tx) => {
        await s.update(R_PEDIDOS(), pedidoId, mudancas, tx);
        // `sales` acompanha o dinheiro (estado analítico segue a verdade do canal).
        const saleStatus =
          evento === 'pago'
            ? 'PAID'
            : evt.intencao === 'estornada'
              ? 'REFUNDED'
              : evento === 'cancelado' || evento === 'expirado'
                ? 'CANCELLED'
                : null;
        if (saleStatus && pedido.sale_id) {
          const sale = await s.findOneWhere(R_SALES(), { id: String(pedido.sale_id), empresa_id: evt.empresaId }, tx);
          if (sale && String(sale.status) !== saleStatus && !(String(sale.status) === 'PAID' && saleStatus === 'CANCELLED' && sale.operational_venda_id)) {
            await s.update(R_SALES(), sale.id as unknown as number, { status: saleStatus } as never, tx);
          }
        }
        // Dinheiro morto (cancelado/expirado/estornado sem conversão) devolve a
        // peça: libera as reservas do checkout e o cupom (se houver).
        if (['cancelado', 'expirado', 'estornado'].includes(evento) && estadoSeguraReserva(atual)) {
          const reservas = await s.list(
            R_RESERVAS(),
            { page: 1, pageSize: 500, filter: { empresa_id: evt.empresaId, origem_recurso: ORIGEM_CHECKOUT, origem_id: pedidoId, status: 'ativa' } },
            tx
          );
          for (const r of reservas.rows) {
            await liberarReservaInterna(escopoDeSistema(evt.empresaId), Number(r.id), tx).catch(() => undefined);
          }
          await liberarUsoCupom(evt.empresaId, pedido.cupom_codigo ? String(pedido.cupom_codigo) : null, tx);
        }
      },
      { isolation: 'serializable' }
      )
    );
  } else if (pagamento) {
    await s.update(R_PEDIDOS(), pedidoId, { pagamento_estado: pagamento }).catch(() => undefined);
  }

  // PAGOU → converte (ponte canônica). Falha honesta vira outbox com retry.
  if (evt.intencao === 'paga') {
    if (pedido.sale_id) await agendarMargemSale(String(pedido.sale_id), evt.empresaId);
    const estadoAtual = String(pedido.estado);
    if (estadoAtual === 'PAGO' || estadoAtual === 'AGUARDANDO_CORRECAO' || novo === 'PAGO') {
      try {
        const r = await converterPedidoSale(evt.empresaId, String(pedido.sale_id));
        if (r.estado === 'AGUARDANDO_CORRECAO') {
          await enfileirarOutbox(evt.empresaId, 'conversao', `sale:${pedido.sale_id}`, { sale_id: pedido.sale_id, pedido_id: pedidoId });
        }
      } catch (e) {
        await enfileirarOutbox(evt.empresaId, 'conversao', `sale:${pedido.sale_id}`, { sale_id: pedido.sale_id, pedido_id: pedidoId, erro: String(e instanceof Error ? e.message : e).slice(0, 300) }).catch(() => undefined);
      }
    }
  }
}

/**
 * Varredura de expiração: pedidos que estouraram o prazo de pagamento perdem
 * a reserva e o cupom, e a `sale` analítica é cancelada (nunca some).
 */
export async function expirarCheckoutsPendentes(agora = new Date()): Promise<number> {
  const s = getStore();
  const candidatos = await s.list(R_PEDIDOS(), { page: 1, pageSize: 500, filter: {}, sort: 'id', dir: 'asc' });
  let expirados = 0;
  for (const pedido of candidatos.rows) {
    const estado = String(pedido.estado);
    if (estado !== 'AGUARDANDO_PAGAMENTO' && estado !== 'PAGAMENTO_AUTORIZADO') continue;
    if (!pedido.expira_em || Date.parse(String(pedido.expira_em)) > agora.getTime()) continue;
    const pedidoId = Number(pedido.id);
    const mudou = await repetirSerial(() =>
      s.tryUpdateIf(
        R_PEDIDOS(),
        pedidoId,
        { estado },
        { estado: 'EXPIRADO', atualizado_em: new Date().toISOString() }
      )
    );
    if (!mudou) continue;
    // Reivindicou → o release PRECISA concluir: retry de 40001 aqui é o que
    // impede reserva órfã quando duas varreduras se sobrepõem.
    await repetirSerial(() =>
      s.transaction(
      async (tx) => {
        const reservas = await s.list(
          R_RESERVAS(),
          { page: 1, pageSize: 500, filter: { empresa_id: Number(pedido.empresa_id), origem_recurso: ORIGEM_CHECKOUT, origem_id: pedidoId, status: 'ativa' } },
          tx
        );
        for (const r of reservas.rows) {
          await liberarReservaInterna(escopoDeSistema(Number(pedido.empresa_id)), Number(r.id), tx).catch(() => undefined);
        }
        await liberarUsoCupom(Number(pedido.empresa_id), pedido.cupom_codigo ? String(pedido.cupom_codigo) : null, tx);
        if (pedido.sale_id) {
          const sale = await s.findOneWhere(R_SALES(), { id: String(pedido.sale_id), empresa_id: Number(pedido.empresa_id) }, tx);
          if (sale && String(sale.status) === 'PENDING') {
            await s.update(R_SALES(), sale.id as unknown as number, { status: 'CANCELLED' } as never, tx);
          }
        }
      },
      { isolation: 'serializable' }
      )
    );
    expirados += 1;
  }
  return expirados;
}

/** Libera TODAS as reservas de um pedido (cancelamento manual). */
async function liberarReservasDoPedido(empresaId: number, pedidoId: number, tx: Tx): Promise<number> {
  const s = getStore();
  const reservas = await s.list(
    R_RESERVAS(),
    { page: 1, pageSize: 500, filter: { empresa_id: empresaId, origem_recurso: ORIGEM_CHECKOUT, origem_id: pedidoId, status: 'ativa' } },
    tx
  );
  for (const r of reservas.rows) {
    await liberarReservaInterna(escopoDeSistema(empresaId), Number(r.id), tx).catch(() => undefined);
  }
  return reservas.rows.length;
}

// ----------------------------------------------------------------------------
// Estado derivado para a caixa de entrada
// ----------------------------------------------------------------------------

export function estadoDaSale(sale: Row): EstadoPedido {
  const temVenda = !!sale.operational_venda_id;
  switch (String(sale.status)) {
    case 'PAID':
      return temVenda ? 'CONVERTIDO' : 'PAGO';
    case 'CANCELLED':
      return 'CANCELADO';
    case 'REFUNDED':
      return 'ESTORNADO';
    default:
      return 'AGUARDANDO_PAGAMENTO';
  }
}

type LinhaInbox = {
  sale_id: string;
  pedido_id: number | null;
  canal: string;
  pedido_externo: string;
  ocorrida_em: string;
  status_venda: string;
  estado: EstadoPedido;
  estado_rotulo: string;
  pagamento: string | null;
  total: number;
  comprador: { nome: string | null; email: string | null };
  venda_id: number | null;
  convertido_em: string | null;
  expedicao: string | null;
  rastreio: { codigo: string | null; status: string | null } | null;
  expira_em: string | null;
};

function rotuloEstado(estado: EstadoPedido): string {
  const rotulos: Record<string, string> = {
    AGUARDANDO_PAGAMENTO: 'Aguardando pagamento',
    PAGAMENTO_AUTORIZADO: 'Pagamento autorizado',
    PAGO: 'Pago',
    AGUARDANDO_CORRECAO: 'Aguardando correção',
    CONVERTIDO: 'Convertido em venda',
    CANCELADO: 'Cancelado',
    EXPIRADO: 'Expirado',
    ESTORNADO: 'Estornado',
    ERRO: 'Erro',
  };
  return rotulos[estado] ?? estado;
}

// ----------------------------------------------------------------------------
// Handlers HTTP
// ----------------------------------------------------------------------------

/** GET /api/commerce/pedidos — inbox omnichannel (canais + loja própria). */
export async function listarPedidosCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PEDIDOS(), actor, 'read');
  const s = getStore();
  const filtro: Record<string, unknown> = { empresa_id: escopo.empresaId };
  if (req.query.canal) filtro.channel = String(req.query.canal);
  if (req.query.status_venda) filtro.status = String(req.query.status_venda);
  const q = String(req.query.q || '').trim();
  const pagina = Math.max(1, Number(req.query.page) || 1);
  const tamanho = Math.min(200, Number(req.query.pageSize) || 50);

  const sales = await s.list(R_SALES(), {
    page: 1,
    pageSize: 1000,
    filter: filtro,
    sort: 'occurred_at',
    dir: 'desc',
    ...(q ? { q } : {}),
  });

  // Enriquecimento em lote: pedidos + vendas + rastreio (sem N+1 por linha).
  const saleIds = sales.rows.map((r) => String(r.id));
  const pedidosPorSale = new Map<string, Row>();
  const rastreioPorVenda = new Map<number, Row>();
  const todasVendas = new Map<number, Row>();
  if (saleIds.length) {
    const pedidos = await s.list(R_PEDIDOS(), { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId } });
    for (const p of pedidos.rows) if (p.sale_id) pedidosPorSale.set(String(p.sale_id), p);
    const vendaIds = [...new Set(pedidos.rows.map((p) => Number(p.venda_id)).filter((n) => n > 0))];
    for (const sale of sales.rows) if (sale.operational_venda_id) vendaIds.push(Number(sale.operational_venda_id));
    for (const vid of [...new Set(vendaIds)]) {
      const venda = await s.findOneWhere(R_VENDAS(), { id: vid, empresa_id: escopo.empresaId });
      if (venda) todasVendas.set(vid, venda);
    }
    if (todasVendas.size) {
      const rastreios = await s.list(R_RASTREIO(), { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId } });
      for (const r of rastreios.rows) rastreioPorVenda.set(Number(r.venda_id), r);
    }
  }

  let linhas: LinhaInbox[] = sales.rows.map((sale) => {
    const pedido = pedidosPorSale.get(String(sale.id)) ?? null;
    const estado: EstadoPedido = pedido && ehEstadoPedido(pedido.estado) ? (pedido.estado as EstadoPedido) : estadoDaSale(sale);
    const vendaId = pedido?.venda_id ? Number(pedido.venda_id) : sale.operational_venda_id ? Number(sale.operational_venda_id) : null;
    const venda = vendaId ? todasVendas.get(vendaId) ?? null : null;
    const rastreio = vendaId ? rastreioPorVenda.get(vendaId) ?? null : null;
    return {
      sale_id: String(sale.id),
      pedido_id: pedido ? Number(pedido.id) : null,
      canal: String(sale.channel || pedido?.canal || 'BROBOND'),
      pedido_externo: String(sale.external_order_id || pedido?.pedido_externo || ''),
      ocorrida_em: String(sale.occurred_at || sale.criado_em || ''),
      status_venda: String(sale.status || ''),
      estado,
      estado_rotulo: rotuloEstado(estado),
      pagamento: pedido?.pagamento_estado ? String(pedido.pagamento_estado) : null,
      total: pedido ? Number(pedido.total || 0) : deCentavos(Number(sale.amount_cents || 0)),
      comprador: {
        nome: sale.buyer_name ? String(sale.buyer_name) : null,
        email: sale.buyer_email ? String(sale.buyer_email) : null,
      },
      venda_id: vendaId,
      convertido_em: pedido?.convertido_em ? String(pedido.convertido_em) : null,
      expedicao: venda?.expedicao_etapa ? String(venda.expedicao_etapa) : null,
      rastreio: rastreio ? { codigo: rastreio.codigo ? String(rastreio.codigo) : null, status: rastreio.status ? String(rastreio.status) : null } : null,
      expira_em: pedido?.expira_em ? String(pedido.expira_em) : null,
    };
  });

  const estadoFiltro = String(req.query.estado || '');
  if (estadoFiltro) linhas = linhas.filter((l) => l.estado === estadoFiltro);
  const inicio = (pagina - 1) * tamanho;
  const fatia = linhas.slice(inicio, inicio + tamanho);
  res.json({ total: linhas.length, page: pagina, pageSize: tamanho, pedidos: fatia });
}

/** Visão completa de uma venda (compartilhada entre admin e token público). */
export async function montarVisaoDaSale(
  empresaId: number,
  sale: Row,
  opcoes: { publico?: boolean } = {}
): Promise<Record<string, unknown>> {
  const s = getStore();
  const pedido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, sale_id: String(sale.id) });
  const itensBrutos = await s.list(R_SALE_ITEMS(), { page: 1, pageSize: 200, filter: { sale_id: String(sale.id) } });
  const nomes = await nomesProdutos(empresaId, itensBrutos.rows.map((i) => Number(i.product_id || 0)).filter(Boolean));
  const tamanhoIds = [...new Set(itensBrutos.rows.map((i) => Number(i.size_id || 0)).filter(Boolean))];
  const nomesTamanho = new Map<number, string>();
  if (tamanhoIds.length) {
    const tamanhos = await s.list(getResource('tamanhos')!, { page: 1, pageSize: 5000 });
    for (const t of tamanhos.rows) nomesTamanho.set(Number(t.id), String(t.codigo || ''));
  }

  const vendaId = pedido?.venda_id ? Number(pedido.venda_id) : sale.operational_venda_id ? Number(sale.operational_venda_id) : null;
  const venda = vendaId ? await s.findOneWhere(R_VENDAS(), { id: vendaId, empresa_id: empresaId }) : null;
  const rastreios = vendaId
    ? await s.list(R_RASTREIO(), { page: 1, pageSize: 50, filter: { empresa_id: empresaId, venda_id: vendaId } })
    : { rows: [] as Row[], total: 0 };
  const cobranca = pedido?.cobranca_id ? await s.get(R_GATEWAY_COBRANCAS, Number(pedido.cobranca_id)) : null;

  const itens = itensBrutos.rows.map((i) => ({
    produto_id: Number(i.product_id || 0),
    produto: nomes.get(Number(i.product_id || 0)) ?? `#${i.product_id}`,
    tamanho: i.size_id ? nomesTamanho.get(Number(i.size_id)) ?? null : i.variacao_externa ? String(i.variacao_externa) : null,
    quantidade: Number(i.quantity || 0),
    preco_unitario: deCentavos(Number(i.unit_price_cents || 0)),
    subtotal: deCentavos(Number(i.subtotal_cents ?? (Number(i.quantity || 0) * Number(i.unit_price_cents || 0) - Number(i.discount_cents || 0)))),
  }));

  const estado: EstadoPedido = pedido && ehEstadoPedido(pedido.estado) ? (pedido.estado as EstadoPedido) : estadoDaSale(sale);
  const timeline: { em: string; rotulo: string }[] = [];
  if (sale.occurred_at) timeline.push({ em: String(sale.occurred_at), rotulo: 'Pedido recebido' });
  if (pedido?.criado_em && !sale.occurred_at) timeline.push({ em: String(pedido.criado_em), rotulo: 'Pedido criado' });
  if (pedido?.pago_em) timeline.push({ em: String(pedido.pago_em), rotulo: 'Pagamento confirmado' });
  if (pedido?.convertido_em) timeline.push({ em: String(pedido.convertido_em), rotulo: 'Convertido em venda' });
  if (venda?.faturada_em) timeline.push({ em: String(venda.faturada_em), rotulo: 'Venda faturada' });
  timeline.sort((a, b) => String(a.em).localeCompare(String(b.em)));

  const itensPublicos = itens; // comprador vê os próprios itens (token é credencial)
  return {
    sale_id: String(sale.id),
    pedido: pedido
      ? {
          id: Number(pedido.id),
          canal: String(pedido.canal),
          pedido_externo: String(pedido.pedido_externo),
          estado,
          estado_rotulo: rotuloEstado(estado),
          pagamento_estado: pedido.pagamento_estado ? String(pedido.pagamento_estado) : null,
          total: Number(pedido.total || 0),
          frete: Number(pedido.frete_valor || 0),
          desconto: Number(pedido.desconto || 0),
          cupom: pedido.cupom_codigo ? String(pedido.cupom_codigo) : null,
          comprador: (pedido.comprador && typeof pedido.comprador === 'object' ? pedido.comprador : null) as Record<string, unknown> | null,
          endereco: (pedido.endereco && typeof pedido.endereco === 'object' ? pedido.endereco : null) as Record<string, unknown> | null,
          expira_em: pedido.expira_em ? String(pedido.expira_em) : null,
          pago_em: pedido.pago_em ? String(pedido.pago_em) : null,
          convertido_em: pedido.convertido_em ? String(pedido.convertido_em) : null,
          erro: pedido.erro ? String(pedido.erro) : null,
          criado_em: pedido.criado_em ? String(pedido.criado_em) : null,
          // Token = credencial do acompanhamento público; só sai quando a
          // própria visão é pública (pedido recém-criado / página do comprador).
          checkout_token: opcoes.publico && pedido.checkout_token ? String(pedido.checkout_token) : null,
        }
      : null,
    pagamento: {
      status: cobranca
        ? mapearEstadoPagamento(cobranca.status) ?? String(cobranca.status)
        : pedido?.pagamento_estado
          ? String(pedido.pagamento_estado)
          : 'PENDING',
      provider: cobranca ? String(cobranca.provider) : null,
      metodo: cobranca ? String(cobranca.metodo) : null,
      valor: cobranca ? Number(cobranca.valor) : null,
      qr_code: cobranca?.qr_code ? String(cobranca.qr_code) : null,
      copia_cola: cobranca?.copia_cola ? String(cobranca.copia_cola) : null,
      expira_em: cobranca?.expires_em ? String(cobranca.expires_em) : pedido?.expira_em ? String(pedido.expira_em) : null,
      provider_ref: cobranca && !opcoes.publico ? String(cobranca.provider_ref || '') : null,
    },
    venda: venda
      ? {
          id: Number(venda.id),
          numero: venda.numero ? String(venda.numero) : String(venda.id),
          status: venda.status ? String(venda.status) : null,
          faturada_em: venda.faturada_em ? String(venda.faturada_em) : null,
          expedicao_etapa: venda.expedicao_etapa ? String(venda.expedicao_etapa) : null,
          cliente_id: venda.cliente_id ? Number(venda.cliente_id) : null,
        }
      : null,
    itens: itensPublicos,
    rastreio: rastreios.rows.map((r) => ({
      transportadora: r.transportadora ? String(r.transportadora) : null,
      codigo: r.codigo ? String(r.codigo) : null,
      url: r.url ? String(r.url) : null,
      status: r.status ? String(r.status) : null,
      estimativa_em: r.estimativa_em ? String(r.estimativa_em).slice(0, 10) : null,
      atualizado_em: r.atualizado_em ? String(r.atualizado_em) : null,
    })),
    timeline,
  };
}

/** GET /api/commerce/pedidos/:saleId — detalhe completo. */
export async function detalharPedidoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PEDIDOS(), actor, 'read');
  const saleId = String(req.params.saleId);
  const s = getStore();
  const sale = await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: escopo.empresaId });
  if (!sale) throw new HttpError(404, 'Pedido não encontrado.');
  res.json({ ok: true, ...(await montarVisaoDaSale(escopo.empresaId, sale)) });
}

/** POST /api/commerce/pedidos/:saleId/converter — conversão manual assistida. */
export async function converterPedidoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxo(getResource('vendas')!, actor); // alçada de endpoint de fluxo
  const saleId = String(req.params.saleId);
  const s = getStore();
  const sale = await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: escopo.empresaId });
  if (!sale) throw new HttpError(404, 'Pedido não encontrado.');
  const resultado = await converterPedidoSale(escopo.empresaId, saleId);
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_pedidos',
    registro_id: Number((await s.findOneWhere(R_PEDIDOS(), { empresa_id: escopo.empresaId, sale_id: saleId }))?.id ?? 0),
    descricao: resultado.estado === 'CONVERTIDO'
      ? `Pedido ${String(sale.external_order_id || saleId)} convertido em venda #${resultado.venda_id}`
      : `Conversão do pedido ${String(sale.external_order_id || saleId)} → ${rotuloEstado(resultado.estado)}`,
    empresa_id: escopo.empresaId,
    dados: resultado as unknown as Record<string, unknown>,
  });
  res.json({ ok: resultado.estado === 'CONVERTIDO', ...resultado });
}

/** POST /api/commerce/pedidos/:saleId/cancelar — cancela ANTES da conversão. */
export async function cancelarPedidoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkFluxo(getResource('vendas')!, actor);
  const saleId = String(req.params.saleId);
  const s = getStore();
  const sale = await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: escopo.empresaId });
  if (!sale) throw new HttpError(404, 'Pedido não encontrado.');
  const pedido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: escopo.empresaId, sale_id: saleId });
  if (!pedido) throw new HttpError(409, 'Pedido sem projeção commerce para cancelar aqui.');
  const estado = String(pedido.estado);
  if (estado === 'CONVERTIDO') {
    throw new HttpError(
      409,
      'Pedido já convertido em venda operacional: o cancelamento canônico é pela Venda (estorno), não aqui — estoque e financeiro seguem a regra única de cancelamento.'
    );
  }
  if (['CANCELADO', 'EXPIRADO', 'ESTORNADO'].includes(estado)) {
    return res.json({ ok: true, idempotente: true, estado });
  }
  if (estado === 'PAGO' || estado === 'PAGAMENTO_AUTORIZADO') {
    throw new HttpError(
      409,
      'Pedido com pagamento reconhecido: estorne a cobrança em Financeiro → Gateway (o estorno propaga para o pedido) — cancelar aqui faria o cliente pagar e o pedido sumir.'
    );
  }
  const motivo = String((req.body || {}).motivo || '').slice(0, 300);
  await s.transaction(
    async (tx) => {
      const mudou = await s.tryUpdateIf(
        R_PEDIDOS(),
        Number(pedido.id),
        { estado },
        { estado: 'CANCELADO', erro: motivo || null, atualizado_em: new Date().toISOString() },
        tx
      );
      if (!mudou) throw new HttpError(409, 'O pedido mudou durante o cancelamento — recarregue.');
      await liberarReservasDoPedido(escopo.empresaId, Number(pedido.id), tx);
      await liberarUsoCupom(escopo.empresaId, pedido.cupom_codigo ? String(pedido.cupom_codigo) : null, tx);
      if (String(sale.status) === 'PENDING') {
        await s.update(R_SALES(), sale.id as unknown as number, { status: 'CANCELLED' } as never, tx);
      }
    },
    { isolation: 'serializable' }
  );
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_pedidos',
    registro_id: Number(pedido.id),
    descricao: `Pedido ${String(pedido.pedido_externo)} cancelado${motivo ? ` (${motivo})` : ''} — reservas e cupom liberados`,
    empresa_id: escopo.empresaId,
    dados: { motivo },
  });
  res.json({ ok: true, estado: 'CANCELADO' });
}

/** GET /api/commerce/reservas — reservas ativas (visíveis na operação). */
export async function listarReservasCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_RESERVAS(), actor, 'read');
  const s = getStore();
  const filtro: Record<string, unknown> = { empresa_id: escopo.empresaId };
  if (req.query.status) filtro.status = String(req.query.status);
  else filtro.status = 'ativa';
  if (req.query.produto_id) filtro.produto_id = Number(req.query.produto_id);
  const out = await s.list(R_RESERVAS(), {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(200, Number(req.query.pageSize) || 50),
    filter: filtro,
    sort: 'id',
    dir: 'desc',
  });
  const nomes = await nomesProdutos(escopo.empresaId, out.rows.map((r) => Number(r.produto_id)));
  res.json({
    total: out.total,
    reservas: out.rows.map((r) => ({
      id: Number(r.id),
      produto_id: Number(r.produto_id),
      produto: nomes.get(Number(r.produto_id)) ?? `#${r.produto_id}`,
      tamanho_id: r.tamanho_id != null ? Number(r.tamanho_id) : null,
      local_id: r.local_id != null ? Number(r.local_id) : null,
      tipo: String(r.tipo || 'reserva'),
      quantidade: Number(r.quantidade || 0),
      status: String(r.status || ''),
      origem_recurso: r.origem_recurso ? String(r.origem_recurso) : null,
      origem_id: r.origem_id != null ? Number(r.origem_id) : null,
      motivo: r.motivo ? String(r.motivo) : null,
      criado_em: r.criado_em ? String(r.criado_em) : null,
      liberada_em: r.liberada_em ? String(r.liberada_em) : null,
    })),
  });
}

/**
 * GET /api/commerce/fulfillment — pedidos comerciais convertidos
 * (separação → expedição → rastreio), sem duplicar a Expedição do ERP.
 */
export async function listarFulfillmentCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PEDIDOS(), actor, 'read');
  const s = getStore();
  const pedidos = await s.list(R_PEDIDOS(), { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' });
  const convertidos = pedidos.rows.filter((p) => ['CONVERTIDO', 'ESTORNADO'].includes(String(p.estado)) && p.venda_id);
  const linhas: Record<string, unknown>[] = [];
  for (const p of convertidos) {
    const venda = await s.findOneWhere(R_VENDAS(), { id: Number(p.venda_id), empresa_id: escopo.empresaId });
    if (!venda) continue;
    const rastreio = await s.findOneWhere(R_RASTREIO(), { empresa_id: escopo.empresaId, venda_id: Number(venda.id) });
    const sale = await s.findOneWhere(R_SALES(), { id: String(p.sale_id), empresa_id: escopo.empresaId });
    linhas.push({
      sale_id: String(p.sale_id),
      pedido_externo: String(p.pedido_externo),
      canal: String(p.canal),
      venda_id: Number(venda.id),
      numero: venda.numero ? String(venda.numero) : String(venda.id),
      comprador: (p.comprador && typeof p.comprador === 'object' ? (p.comprador as { nome?: string }).nome : null) ?? sale?.buyer_name ?? null,
      status_venda: venda.status ? String(venda.status) : null,
      faturada_em: venda.faturada_em ? String(venda.faturada_em) : null,
      expedicao_etapa: venda.expedicao_etapa ? String(venda.expedicao_etapa) : null,
      rastreio: rastreio
        ? { codigo: rastreio.codigo ? String(rastreio.codigo) : null, status: rastreio.status ? String(rastreio.status) : null, transportadora: rastreio.transportadora ? String(rastreio.transportadora) : null }
        : null,
      convertido_em: p.convertido_em ? String(p.convertido_em) : null,
    });
  }
  res.json({ total: linhas.length, linhas });
}

/**
 * GET /api/commerce/delivery — painel de expedição/entrega do commerce:
 * prazo real desde o faturamento (SLA em `regras.ts`), atraso = nada enviado
 * há mais de 3 dias — sem estimativa inventada.
 */
export async function listarDeliveryCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PEDIDOS(), actor, 'read');
  const s = getStore();
  const pedidos = await s.list(R_PEDIDOS(), { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' });
  const agora = new Date();
  const linhas: Record<string, unknown>[] = [];
  for (const p of pedidos.rows) {
    if (!p.venda_id) continue;
    if (!['CONVERTIDO', 'ESTORNADO'].includes(String(p.estado))) continue;
    const venda = await s.findOneWhere(R_VENDAS(), { id: Number(p.venda_id), empresa_id: escopo.empresaId });
    if (!venda) continue;
    const rastreio = await s.findOneWhere(R_RASTREIO(), { empresa_id: escopo.empresaId, venda_id: Number(venda.id) });
    const enviado = venda.expedicao_etapa === 'expedida';
    const base = venda.faturada_em ? String(venda.faturada_em) : venda.criado_em ? String(venda.criado_em) : null;
    const dias = base ? Math.max(0, Math.floor((agora.getTime() - Date.parse(base)) / 86_400_000)) : null;
    linhas.push({
      sale_id: String(p.sale_id),
      pedido_externo: String(p.pedido_externo),
      canal: String(p.canal),
      venda_id: Number(venda.id),
      numero: venda.numero ? String(venda.numero) : String(venda.id),
      estado_entrega: rastreio
        ? String(rastreio.status)
        : enviado
          ? 'enviado_sem_rastreio'
          : 'aguardando_envio',
      expedicao_etapa: venda.expedicao_etapa ? String(venda.expedicao_etapa) : null,
      dias_desde_faturamento: dias,
      atrasado: !enviado && dias != null && dias > 3,
      rastreio: rastreio
        ? {
            codigo: rastreio.codigo ? String(rastreio.codigo) : null,
            transportadora: rastreio.transportadora ? String(rastreio.transportadora) : null,
            url: rastreio.url ? String(rastreio.url) : null,
            status: rastreio.status ? String(rastreio.status) : null,
            estimativa_em: rastreio.estimativa_em ? String(rastreio.estimativa_em).slice(0, 10) : null,
          }
        : null,
    });
  }
  res.json({ total: linhas.length, linhas });
}

/** POST /api/commerce/pedidos/:saleId/rastreio — grava/atualiza o rastreio. */
export async function salvarRastreioCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_RASTREIO(), actor, 'create');
  const saleId = String(req.params.saleId);
  const body = (req.body || {}) as Record<string, unknown>;
  const s = getStore();
  const pedido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: escopo.empresaId, sale_id: saleId });
  const sale = await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: escopo.empresaId });
  if (!sale) throw new HttpError(404, 'Pedido não encontrado.');
  const vendaId = pedido?.venda_id ? Number(pedido.venda_id) : sale.operational_venda_id ? Number(sale.operational_venda_id) : null;
  if (!vendaId) throw new HttpError(409, 'Pedido ainda não convertido em venda — não há o que rastrear.');
  const venda = await s.findOneWhere(R_VENDAS(), { id: vendaId, empresa_id: escopo.empresaId });
  if (!venda) throw new HttpError(404, 'Venda não encontrada.');

  const status = String(body.status || 'postado');
  const statusValidos = ['postado', 'em_transito', 'saiu_entrega', 'entregue', 'devolvido', 'extraviado'];
  if (!statusValidos.includes(status)) throw new HttpError(400, 'Status de rastreio inválido.', { status: statusValidos.join(', ') });

  const dados = {
    transportadora: body.transportadora ? String(body.transportadora).slice(0, 80) : null,
    codigo: body.codigo ? String(body.codigo).slice(0, 80) : null,
    url: body.url ? String(body.url).slice(0, 300) : null,
    status,
    estimativa_em: body.estimativa_em ? String(body.estimativa_em).slice(0, 10) : null,
  };
  const existente = await s.findOneWhere(R_RASTREIO(), { empresa_id: escopo.empresaId, venda_id: vendaId });
  const linha = existente
    ? (await s.update(R_RASTREIO(), Number(existente.id), dados))!
    : await s.insert(R_RASTREIO(), { empresa_id: escopo.empresaId, venda_id: vendaId, ...dados });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: existente ? 'editar' : 'criar',
    recurso: 'commerce_rastreio',
    registro_id: Number(linha.id),
    descricao: `Rastreio da venda #${vendaId} atualizado (${status}${dados.codigo ? `, ${dados.codigo}` : ''})`,
    empresa_id: empresaDoRegistroAudit(R_RASTREIO(), linha, actor),
    dados,
  });
  res.json({ ok: true, rastreio: linha });
}

/** GET /api/commerce/pagamentos — cobranças do gateway com projeção commerce. */
export async function listarPagamentosCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(getResource('gateway_cobrancas')!, actor, 'read');
  const s = getStore();
  const out = await s.list(R_GATEWAY_COBRANCAS, {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(200, Number(req.query.pageSize) || 50),
    filter: { empresa_id: escopo.empresaId },
    sort: 'id',
    dir: 'desc',
  });
  const pedidos = await s.list(R_PEDIDOS(), { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId } });
  const porCobranca = new Map<number, Row>();
  for (const p of pedidos.rows) if (p.cobranca_id) porCobranca.set(Number(p.cobranca_id), p);
  res.json({
    total: out.total,
    pagamentos: out.rows.map((c) => {
      const p = porCobranca.get(Number(c.id)) ?? null;
      return {
        cobranca_id: Number(c.id),
        provider: String(c.provider),
        metodo: String(c.metodo),
        valor: Number(c.valor || 0),
        status_gateway: String(c.status),
        status: mapearEstadoPagamento(c.status) ?? String(c.status),
        criado_em: c.criado_em ? String(c.criado_em) : null,
        atualizado_em: c.atualizado_em ? String(c.atualizado_em) : null,
        pedido: p
          ? { pedido_externo: String(p.pedido_externo), estado: String(p.estado), sale_id: String(p.sale_id) }
          : null,
        lancamento_id: c.lancamento_id ? Number(c.lancamento_id) : null,
        venda_id: c.venda_id ? Number(c.venda_id) : null,
      };
    }),
  });
}

/** GET /api/commerce/eventos — observabilidade (fila + webhooks + fila de sync). */
export async function listarEventosCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(getResource('commerce_outbox')!, actor, 'read');
  const s = getStore();
  const [outbox, publicacoes, webhooks] = await Promise.all([
    s.list(getResource('commerce_outbox')!, { page: 1, pageSize: 30, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' }),
    s.list(getResource('commerce_publicacoes')!, { page: 1, pageSize: 20, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' }),
    s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 20, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' }),
  ]);
  res.json({
    outbox: outbox.rows.map((o) => ({
      id: Number(o.id),
      tipo: String(o.tipo),
      chave: String(o.chave),
      estado: String(o.estado),
      tentativas: Number(o.tentativas || 0),
      ultimo_erro: o.ultimo_erro ? String(o.ultimo_erro) : null,
      proxima_tentativa_em: o.proxima_tentativa_em ? String(o.proxima_tentativa_em) : null,
      atualizado_em: o.atualizado_em ? String(o.atualizado_em) : null,
    })),
    publicacoes: publicacoes.rows.map((p) => ({
      id: Number(p.id),
      produto_id: Number(p.produto_id),
      canal: String(p.canal),
      estado: String(p.estado),
      tentativas: Number(p.tentativas || 0),
      ultimo_erro: p.ultimo_erro ? String(p.ultimo_erro) : null,
      atualizado_em: p.atualizado_em ? String(p.atualizado_em) : null,
    })),
    webhooks: webhooks.rows.map((w) => ({
      id: Number(w.id),
      provider: String(w.provider || ''),
      status: String(w.status || ''),
      erro: w.erro ? String(w.erro) : null,
      criado_em: w.recebido_em ? String(w.recebido_em) : w.criado_em ? String(w.criado_em) : null,
      processado_em: w.processado_em ? String(w.processado_em) : null,
    })),
  });
}


/** Estados do vocabulário (front monta os filtros a partir daqui). */
export function estadosPedidoDisponiveis(): { valor: string; rotulo: string }[] {
  return ESTADOS_PEDIDO.map((e) => ({ valor: e, rotulo: rotuloEstado(e) }));
}

/**
 * Ouvinte de ingestão de canais (Set — NÃO sobrescreve o listener do motor
 * 1. MEU NEGÓCIOS): projeta o pedido no inbox e converte automaticamente
 * vendas PAID dos marketplaces pela ponte canônica. Checkout próprio fica de
 * fora — a conversão dele depende do pagamento confirmado pelo gateway.
 */
function ouvinteVendaIngerida(evento: { empresaId: number; saleId: string }): void {
  void (async () => {
    try {
      const s = getStore();
      const sale = await s.findOneWhere(R_SALES(), { id: evento.saleId, empresa_id: evento.empresaId });
      if (!sale) return;
      const pedido = await garantirPedidoDaSale(evento.empresaId, sale);
      if (String(pedido.cobranca_id)) return; // fluxo do checkout: pagamento decide
      if (String(sale.status) !== 'PAID' || sale.operational_venda_id) return;
      const r = await converterPedidoSale(evento.empresaId, evento.saleId);
      if (r.estado === 'AGUARDANDO_CORRECAO') {
        await enfileirarOutbox(evento.empresaId, 'conversao', `sale:${evento.saleId}`, {
          sale_id: evento.saleId,
          pedido_id: Number(pedido.id),
          pendencia: r.pendencia ?? null,
        });
      }
    } catch (e) {
      // fora do caminho feliz: outbox com retry honesto (nunca perde o pedido)
      try {
        await enfileirarOutbox(evento.empresaId, 'conversao', `sale:${evento.saleId}`, {
          sale_id: evento.saleId,
          erro: String(e instanceof Error ? e.message : e).slice(0, 300),
        });
      } catch {
        /* sem store pronto (boot frio) — o próximo ciclo do outbox não existe; loga */
        console.warn('⚠️  commerce: falha ao enfileirar conversão', e instanceof Error ? e.message : e);
      }
    }
  })();
}

/**
 * Registra TODOS os hooks do Commerce (boot do servidor):
 *   1. ponte sales → vendas: consome reserva + carimba frete/desconto na tx;
 *   2. gateway: pagamento confirmado (evento processado) → projeta e converte;
 *   3. ingestão de canais: projeção no inbox + conversão automática (Set).
 */
export function registrarHooksCommerce(): void {
  setOnVendaConvertendo(ganchoConversaoCommerce);
  setOnCobrancaAlterada(confirmarPagamentoCobranca);
  addOnSaleIngested(ouvinteVendaIngerida);
}

/** Idempotência de venda para o checkout (mesma fórmula da ponte). */
export function gerarIdPedidoLoja(): { externalOrderId: string; token: string } {
  return {
    externalOrderId: `LOJA-${connectorCuid().slice(-12).toUpperCase()}`,
    token: tokenCheckout(),
  };
}
