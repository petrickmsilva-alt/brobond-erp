import { R_INTENTS, R_ATTEMPTS, R_LATE_REVIEWS } from '../../../modules/payments/infrastructure/resources';
import { recordLatePayment, resolveLateRefund } from '../../../modules/payments/application/late-reviews';
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
import { query } from '../db';
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
import { registrarEventoSeguro, statusCanaisNotificacao, type ContatoPedido, type EventoNotificacao } from './notificacoes';
import { mascararWhatsApp, mascararCPF } from './cliente';
import { copiaColaPixValido, qrCodeBase64Valido, situacaoInstrumentosPix, ticketUrlPixValida } from '../../../modules/payments/domain/pix-instrument';
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
// NOTIFICATION ORCHESTRATOR — eventos de domínio do pedido.
// O comprador é lido SEMPRE do pedido já persistido (nunca do navegador) e o
// envio é assíncrono via outbox: nenhuma transição de estado espera provedor.
// ----------------------------------------------------------------------------
function contatoDoPedido(pedido: Row): ContatoPedido {
  const c = (pedido.comprador && typeof pedido.comprador === 'object' ? pedido.comprador : {}) as Record<string, unknown>;
  return {
    nome: c.nome ? String(c.nome) : null,
    email: c.email ? String(c.email) : null,
    whatsapp: c.whatsapp ? String(c.whatsapp) : null,
    telefone: c.telefone ? String(c.telefone) : null,
  };
}

function emitirEventoPedido(pedido: Row, evento: EventoNotificacao): void {
  void registrarEventoSeguro(contatoDoPedido(pedido), {
    empresaId: Number(pedido.empresa_id),
    pedidoId: Number(pedido.id),
    evento,
    pedidoExterno: pedido.pedido_externo ? String(pedido.pedido_externo) : null,
    checkoutToken: pedido.checkout_token ? String(pedido.checkout_token) : null,
  });
}

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
/** A later cancellation/refund must not be overwritten by a stale converter. */
async function concluirProjecaoConversao(empresaId: number, pedido: Row, vendaId: number): Promise<ResultadoConversao> {
  const s = getStore();
  const saved = await s.tryUpdateIf(R_PEDIDOS(), Number(pedido.id), { empresa_id: empresaId, estado: pedido.estado }, {
    estado: 'CONVERTIDO', convertido_em: pedido.convertido_em ?? new Date().toISOString(), venda_id: vendaId, erro: null,
  });
  if (saved) return { estado: 'CONVERTIDO', venda_id: vendaId };
  const atual = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, id: Number(pedido.id) });
  if (atual?.estado === 'CONVERTIDO') return { estado: 'CONVERTIDO', venda_id: Number(atual.venda_id || vendaId) };
  throw new HttpError(409, 'Pedido mudou durante a conversão; revise seu estado antes de tentar novamente.');
}

export async function converterPedidoSale(empresaId: number, saleId: string): Promise<ResultadoConversao> {
  const s = getStore();
  const sale = await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: empresaId });
  if (!sale) throw new HttpError(404, 'Venda não encontrada.');
  const pedido = await garantirPedidoDaSale(empresaId, sale);
  const pedidoId = Number(pedido.id);

  if (['CANCELADO', 'EXPIRADO'].includes(String(pedido.estado)))
    throw new HttpError(409, 'Pedido encerrado não pode ser convertido; revise qualquer pagamento tardio.');
  if (sale.operational_venda_id) {
    if (String(pedido.estado) === 'ESTORNADO') return { estado: 'ESTORNADO', venda_id: Number(sale.operational_venda_id) };
    if (String(pedido.estado) === 'CONVERTIDO') return { estado: 'CONVERTIDO', venda_id: Number(sale.operational_venda_id) };
    return concluirProjecaoConversao(empresaId, pedido, Number(sale.operational_venda_id));
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
    // Corrida de aprovações: a transação SERIALIZABLE da ponte pode perder para
    // outra (40001). Repete ANTES de decidir que o pedido precisa de correção;
    // um 409 de negócio real não é repetido e segue o caminho abaixo.
    const resultado = await repetirSerial(() => converterOrdemMarketplaceEmVenda(String(sale.id), escopo));
    const vendaId = resultado.vendaId;
    const projecao = await concluirProjecaoConversao(empresaId, pedido, vendaId);
    await agendarMargemSale(String(sale.id), empresaId);
    return projecao;
  } catch (e) {
    const pendencia = e instanceof HttpError ? e.message : null;
    if (e instanceof HttpError && e.status === 409) {
      const saved = await s.tryUpdateIf(R_PEDIDOS(), pedidoId, { empresa_id: empresaId, estado: pedido.estado },
        { estado: 'AGUARDANDO_CORRECAO', erro: pendencia?.slice(0, 500) ?? null });
      if (!saved) {
        const atual = await s.findOneWhere(R_PEDIDOS(), { empresa_id: empresaId, id: pedidoId });
        if (atual?.estado === 'CONVERTIDO') return { estado: 'CONVERTIDO', venda_id: atual.venda_id ? Number(atual.venda_id) : null };
        throw new HttpError(409, 'Pedido mudou durante a conversão; revise seu estado antes de tentar novamente.');
      }
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
  // Re-read and recalculate inside EACH serializable retry. Reusing a snapshot
  // from before a serialization failure could resurrect an expired checkout.
  const resultado = await repetirSerial(() => s.transaction(async (tx) => {
    const atual = await s.findOneWhere(R_PEDIDOS(), { id: pedidoId, empresa_id: evt.empresaId, cobranca_id: evt.cobrancaId }, tx);
    const cobrancaAtual = await s.findOneWhere(R_GATEWAY_COBRANCAS, { id: evt.cobrancaId, empresa_id: evt.empresaId }, tx);
    if (!atual || !cobrancaAtual) return null;
    const pagamento = mapearEstadoPagamento(cobrancaAtual.status);
    // `falhou` (provider recusou/rejeitou a cobrança) precisa encerrar o pedido
    // e liberar reserva/cupom — antes ficava preso em AGUARDANDO_PAGAMENTO.
    const eventos: Record<string, 'pago' | 'cancelado' | 'expirado' | 'estornado'> = { paga: 'pago', cancelada: 'cancelado', expirada: 'expirado', estornada: 'estornado', falhou: 'cancelado' };
    const evento = eventos[String(cobrancaAtual.status)];
    if (!evento) return null;
    const novo = transicaoPedido(atual.estado, evento);
    if (!novo || novo === atual.estado) {
      const encerrado = ['EXPIRADO', 'CANCELADO'].includes(String(atual.estado));
      if (encerrado && evento === 'pago' && pagamento === 'APPROVED') {
        await recordLatePayment(evt.empresaId, atual, evt.cobrancaId, tx);
      } else if (encerrado && evento === 'estornado' && pagamento === 'REFUNDED') {
        // A historical legacy label alone is not sufficient. A review already
        // resolved by a verified full legacy refund is safe to leave resolved.
        const intent = await s.findOneWhere(R_INTENTS, { empresa_id: evt.empresaId, order_id: pedidoId }, tx);
        const review = await s.findOneWhere(R_LATE_REVIEWS, { empresa_id: evt.empresaId, order_id: pedidoId }, tx);
        if (intent?.status === 'REFUNDED' || review?.status === 'REFUNDED') {
          await resolveLateRefund(evt.empresaId, atual, tx);
          if (atual.pagamento_estado !== pagamento) await s.update(R_PEDIDOS(), pedidoId, { pagamento_estado: pagamento }, tx);
        } else {
          await s.update(R_PEDIDOS(), pedidoId, { erro: 'Estorno legado requer conciliação manual do valor; revisão permanece aberta.' }, tx);
        }
      } else if (pagamento && atual.pagamento_estado !== pagamento) {
        await s.update(R_PEDIDOS(), pedidoId, { pagamento_estado: pagamento }, tx);
      }
      return { pedido: atual, estado: String(atual.estado), evento, transicao: false, pagamento };
    }
    const agora = new Date().toISOString();
    const mudancas: Record<string, unknown> = { estado: novo, atualizado_em: agora };
    if (pagamento) mudancas.pagamento_estado = pagamento;
    if (evento === 'pago') mudancas.pago_em = agora;
    if (['cancelado', 'expirado'].includes(evento)) mudancas.erro = null;
    await s.update(R_PEDIDOS(), pedidoId, mudancas, tx);
    const saleStatus = evento === 'pago' ? 'PAID' : evento === 'estornado' ? 'REFUNDED' : evento === 'cancelado' || evento === 'expirado' ? 'CANCELLED' : null;
    if (saleStatus && atual.sale_id) {
      const sale = await s.findOneWhere(R_SALES(), { id: String(atual.sale_id), empresa_id: evt.empresaId }, tx);
      if (sale && String(sale.status) !== saleStatus && !(String(sale.status) === 'PAID' && saleStatus === 'CANCELLED' && sale.operational_venda_id))
        await s.update(R_SALES(), sale.id as unknown as number, { status: saleStatus } as never, tx);
    }
    if (['cancelado', 'expirado', 'estornado'].includes(evento) && estadoSeguraReserva(atual.estado)) {
      const reservas = await s.list(R_RESERVAS(), { page: 1, pageSize: 500, filter: { empresa_id: evt.empresaId, origem_recurso: ORIGEM_CHECKOUT, origem_id: pedidoId, status: 'ativa' } }, tx);
      if (reservas.total > reservas.rows.length) throw new HttpError(409, 'Reservas excedem o limite seguro para liberação.');
      for (const r of reservas.rows) await liberarReservaInterna(escopoDeSistema(evt.empresaId), Number(r.id), tx);
      await liberarUsoCupom(evt.empresaId, atual.cupom_codigo ? String(atual.cupom_codigo) : null, tx);
    }
    await s.audit({ empresa_id: evt.empresaId, usuario_id: null, usuario: 'Gateway', acao: 'ajuste', recurso: 'commerce_pedidos', registro_id: pedidoId,
      descricao: 'Transição por evento de pagamento', dados: { antes: { estado: atual.estado, pagamento_estado: atual.pagamento_estado }, depois: { estado: novo, pagamento_estado: pagamento } } }, tx);
    return { pedido: atual, estado: novo, evento, transicao: true, pagamento };
  }, { isolation: 'serializable' }));

  // Webhook é a fonte principal de confirmação. Só emite evento em transição
  // REAL — webhook repetido não gera nova linha (chave de idempotência).
  if (resultado?.transicao) {
    if (resultado.evento === 'pago') {
      emitirEventoPedido(resultado.pedido, 'PAYMENT_APPROVED');
      emitirEventoPedido(resultado.pedido, 'ORDER_PROCESSING');
    } else if (resultado.evento === 'expirado') {
      // PIX vencido no provedor: o cliente recebe "pedido expirado" (não um
      // cancelamento genérico) e a reserva já foi devolvida acima.
      emitirEventoPedido(resultado.pedido, 'ORDER_EXPIRED');
    } else if (resultado.evento === 'cancelado') {
      // Recusa real do provedor (`gateway_cobrancas.status='falhou'` →
      // pagamento REJECTED) é PAGAMENTO_RECUSADO, não só cancelamento genérico.
      if (resultado.pagamento === 'REJECTED') emitirEventoPedido(resultado.pedido, 'PAYMENT_REJECTED');
      emitirEventoPedido(resultado.pedido, 'ORDER_CANCELLED');
    }
  }

  if (resultado?.evento === 'pago' && ['PAGO', 'AGUARDANDO_CORRECAO'].includes(resultado.estado) && resultado.pedido.sale_id) {
    await agendarMargemSale(String(resultado.pedido.sale_id), evt.empresaId);
    try {
      const r = await converterPedidoSale(evt.empresaId, String(resultado.pedido.sale_id));
      if (r.estado === 'AGUARDANDO_CORRECAO') await enfileirarOutbox(evt.empresaId, 'conversao', `sale:${resultado.pedido.sale_id}`, { sale_id: resultado.pedido.sale_id, pedido_id: pedidoId });
    } catch {
      await enfileirarOutbox(evt.empresaId, 'conversao', `sale:${resultado.pedido.sale_id}`, { sale_id: resultado.pedido.sale_id, pedido_id: pedidoId, erro: 'Conversão pendente; consulte o estado do pedido.' }).catch(() => undefined);
    }
  }
}

/**
 * Varredura de expiração: pedidos que estouraram o prazo de pagamento perdem
 * a reserva e o cupom, e a `sale` analítica é cancelada (nunca some).
 */
export async function expirarCheckoutsPendentes(agora = new Date()): Promise<number> {
  const s = getStore();
  // SQL filters before LIMIT, so terminal/non-expired orders cannot starve
  // due checkouts. Memory mode scans pages until it collects a bounded batch.
  let candidatos: Row[] = [];
  if (s.kind === 'postgres') {
    const result = await query(`SELECT * FROM commerce_pedidos WHERE estado IN ('AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO') AND expira_em <= $1 ORDER BY expira_em, id LIMIT 500`, [agora.toISOString()]);
    candidatos = result.rows;
  } else {
    for (let page = 1; ; page += 1) {
      const batch = await s.list(R_PEDIDOS(), { page, pageSize: 500, filter: {}, sort: 'id', dir: 'asc' });
      candidatos.push(...batch.rows.filter((r) => ['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO'].includes(String(r.estado)) && r.expira_em && Date.parse(String(r.expira_em)) <= agora.getTime()));
      if (candidatos.length >= 500 || page * 500 >= batch.total) break;
    }
    candidatos = candidatos.slice(0, 500);
  }
  let expirados = 0;
  for (const pedido of candidatos) {
    const pedidoId = Number(pedido.id); const empresaId = Number(pedido.empresa_id);
    const mudou = await repetirSerial(() => s.transaction(async (tx) => {
      const atual = await s.findOneWhere(R_PEDIDOS(), { id: pedidoId, empresa_id: empresaId }, tx);
      if (!atual || !['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO'].includes(String(atual.estado)) || !atual.expira_em || Date.parse(String(atual.expira_em)) > agora.getTime()) return false;
      const sale = atual.sale_id ? await s.findOneWhere(R_SALES(), { id: String(atual.sale_id), empresa_id: empresaId }, tx) : null;
      if (sale && String(sale.status) !== 'PENDING') return false;
      const claim = await s.tryUpdateIf(R_PEDIDOS(), pedidoId, { estado: atual.estado }, { estado: 'EXPIRADO', atualizado_em: new Date().toISOString() }, tx);
      if (!claim) return false;
      const reservas = await s.list(R_RESERVAS(), { page: 1, pageSize: 500, filter: { empresa_id: empresaId, origem_recurso: ORIGEM_CHECKOUT, origem_id: pedidoId, status: 'ativa' } }, tx);
      if (reservas.total > reservas.rows.length) throw new HttpError(409, 'Reservas excedem o limite seguro para liberação.');
      for (const r of reservas.rows) await liberarReservaInterna(escopoDeSistema(empresaId), Number(r.id), tx);
      await liberarUsoCupom(empresaId, atual.cupom_codigo ? String(atual.cupom_codigo) : null, tx);
      if (sale) await s.update(R_SALES(), sale.id as unknown as number, { status: 'CANCELLED' } as never, tx);
      await s.audit({ empresa_id: empresaId, usuario_id: null, usuario: 'Sistema', acao: 'ajuste', recurso: 'commerce_pedidos', registro_id: pedidoId,
        descricao: 'Checkout expirado e reservas liberadas', dados: { antes: { estado: atual.estado }, depois: { estado: 'EXPIRADO' } } }, tx);
      return true;
    }, { isolation: 'serializable' }));
    if (mudou) {
      expirados += 1;
      emitirEventoPedido(pedido, 'ORDER_EXPIRED');
    }
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

  const engineIntent = pedido ? await s.findOneWhere(R_INTENTS,{empresa_id:empresaId,order_id:Number(pedido.id)}) : null;
  const engineAttempt = engineIntent ? (await s.list(R_ATTEMPTS,{page:1,pageSize:1,sort:'id',dir:'desc',filter:{empresa_id:empresaId,payment_intent_id:Number(engineIntent.id)}})).rows[0] : null;
  const lateReview = pedido && !opcoes.publico ? await s.findOneWhere(R_LATE_REVIEWS, { empresa_id: empresaId, order_id: Number(pedido.id) }) : null;

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
  const compradorBruto = (pedido?.comprador && typeof pedido.comprador === 'object' ? pedido.comprador : null) as Record<string, unknown> | null;
  // Visão PÚBLICA nunca expõe CPF completo nem o telefone cru: só o contato
  // necessário para o cliente confirmar onde receberá as atualizações.
  const compradorVisao = opcoes.publico && compradorBruto
    ? {
        nome: compradorBruto.nome ? String(compradorBruto.nome) : null,
        email: compradorBruto.email ? String(compradorBruto.email) : null,
        whatsapp: mascararWhatsApp(compradorBruto.whatsapp as string | null) ?? mascararWhatsApp(compradorBruto.telefone as string | null),
        documento_mascarado: mascararCPF(compradorBruto.documento as string | null),
        marketing_opt_in: compradorBruto.marketing_opt_in === true,
      }
    : compradorBruto;
  // Instrumentos PIX: SOMENTE das colunas próprias, validados no papel certo
  // (EMV → copia_cola; imagem base64 real → qr_code_base64; https → ticket).
  // Nada vem de `safe_reference`/payload e nada é gerado aqui.
  const copiaCola = copiaColaPixValido(cobranca?.copia_cola) ? String(cobranca!.copia_cola).trim()
    : copiaColaPixValido(cobranca?.qr_code) ? String(cobranca!.qr_code).trim() : null;
  const qrBase64 = qrCodeBase64Valido(cobranca?.qr_code_base64) ? String(cobranca!.qr_code_base64).replace(/\s/g, '') : null;
  const ticketUrl = ticketUrlPixValida(cobranca?.ticket_url) ? String(cobranca!.ticket_url).trim() : null;
  const statusPagamento = cobranca
    ? mapearEstadoPagamento(cobranca.status) ?? String(cobranca.status)
    : pedido?.estado === 'ERRO'
      ? 'ERROR'
      : pedido?.estado === 'EXPIRADO'
        ? 'EXPIRED'
        : pedido?.estado === 'CANCELADO'
          ? 'CANCELLED'
          : pedido?.pagamento_estado
            ? String(pedido.pagamento_estado)
            : 'PENDING';
  const acaoEngine = (engineAttempt?.safe_reference?.action || null) as Record<string, unknown> | null;
  const redirectUrl = engineIntent?.status === 'REQUIRES_ACTION' && acaoEngine?.type === 'REDIRECT' &&
    typeof acaoEngine.url === 'string' && /^https:\/\//i.test(acaoEngine.url) ? String(acaoEngine.url) : null;
  const pagamentoBase = {
    status: statusPagamento,
    // Etapas do pagador que NÃO são PIX, sem expor status interno do engine:
    // redirect seguro (cartão/checkout hospedado) e confirmação manual.
    redirect_url: redirectUrl,
    confirmacao_manual: engineIntent?.status === 'PENDING_MANUAL_CONFIRMATION',
    provider: cobranca ? String(cobranca.provider) : null,
    metodo: cobranca ? String(cobranca.metodo) : null,
    valor: cobranca ? Number(cobranca.valor) : null,
    copia_cola: copiaCola,
    qr_code_base64: qrBase64,
    ticket_url: ticketUrl,
    expira_em: cobranca?.expires_em ? String(cobranca.expires_em) : pedido?.expira_em ? String(pedido.expira_em) : null,
  };
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
          comprador: compradorVisao,
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
    // Visão PÚBLICA: só o que o comprador precisa para pagar/acompanhar.
    // Nunca expõe status interno do engine, ids de intenção/Order do provider,
    // revisão tardia, correlation_id ou a ação bruta do adapter (§24).
    pagamento: opcoes.publico
      ? pagamentoBase
      : {
          ...pagamentoBase,
          engine_status: engineIntent?.status || null,
          engine_intent_id: engineIntent ? Number(engineIntent.id) : null,
          late_review_status: lateReview?.status || null,
          provider_order_id: cobranca?.provider_ref ? String(cobranca.provider_ref) : null,
          provider_ref: cobranca ? String(cobranca.provider_ref || '') : null,
        },
    ...(opcoes.publico
      ? {}
      : {
          diagnostico: await diagnosticoPagamentoPedido(empresaId, {
            pedido,
            estado,
            cobranca,
            engineIntent,
            engineAttempt,
            lateReview,
          }),
        }),
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

type SituacaoNotificacao = {
  estado: 'ENVIADO' | 'PENDENTE' | 'PROCESSANDO' | 'ERRO' | 'NAO_CONFIGURADO' | 'SEM_REGISTRO';
  evento: string | null;
  em: string | null;
  motivo: string | null;
};

/** Última notificação real (não consolidada/ignorada) de um canal. */
function situacaoDoCanal(linhas: Row[], canal: 'EMAIL' | 'WHATSAPP'): SituacaoNotificacao {
  const ultima = linhas.filter((n) => String(n.canal) === canal && String(n.estado) !== 'IGNORADO').sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!ultima) return { estado: 'SEM_REGISTRO', evento: null, em: null, motivo: null };
  const naoConfigurado = String(ultima.estado) === 'PENDENTE' && String(ultima.provider_status || '') === 'NAO_CONFIGURADO';
  return {
    estado: naoConfigurado ? 'NAO_CONFIGURADO' : (String(ultima.estado) as SituacaoNotificacao['estado']),
    evento: String(ultima.evento),
    em: ultima.enviado_em ? String(ultima.enviado_em) : ultima.atualizado_em ? String(ultima.atualizado_em) : ultima.criado_em ? String(ultima.criado_em) : null,
    // `ultimo_erro` só contém nomes de variáveis/mensagens normalizadas —
    // nunca token, segredo ou payload do provedor.
    motivo: ultima.ultimo_erro ? String(ultima.ultimo_erro).slice(0, 300) : null,
  };
}

/**
 * Diagnóstico operacional do pagamento (backoffice, sem modal): mostra o que
 * EXISTE — nunca os valores sensíveis. PIX como DISPONÍVEL/AUSENTE, webhook
 * RECEBIDO/NÃO RECEBIDO, e o estado real de cada canal de notificação.
 */
async function diagnosticoPagamentoPedido(
  empresaId: number,
  d: { pedido: Row | null; estado: string; cobranca: Row | null; engineIntent: Row | null; engineAttempt: Row | null | undefined; lateReview: Row | null }
): Promise<Record<string, unknown>> {
  const s = getStore();
  const { pedido, cobranca, engineIntent, engineAttempt } = d;
  let eventos: Row[] = [];
  if (cobranca) {
    if (s.kind === 'postgres') {
      // Eventos vinculados à cobrança + históricos cujo id do evento carrega a
      // referência (webhook `type=order` sem cobranca_id gravado).
      const ref = String(cobranca.provider_ref || '');
      const r = await query(
        `SELECT id, evento, status, erro, recebido_em, processado_em FROM gateway_webhook_events
          WHERE empresa_id = $1 AND (cobranca_id = $2 OR ($3 <> '' AND LOWER(provider) = LOWER($4) AND evento_id LIKE '%' || $3 || '%'))
          ORDER BY id DESC LIMIT 20`,
        [empresaId, Number(cobranca.id), ref, String(cobranca.provider || '')]
      );
      eventos = r.rows as Row[];
    } else {
      // Mesmo critério do PostgreSQL: vínculo explícito OU id do evento que
      // carrega a referência do provedor (evento recebido ainda sem vínculo).
      const ref = String(cobranca.provider_ref || '');
      const provider = String(cobranca.provider || '').toLowerCase();
      eventos = (await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 500, sort: 'id', dir: 'desc', filter: { empresa_id: empresaId } })).rows
        .filter((e) => Number(e.cobranca_id) === Number(cobranca.id) ||
          (!!ref && String(e.provider || '').toLowerCase() === provider && String(e.evento_id || '').includes(ref)))
        .slice(0, 20);
    }
  }
  const ultimoEvento = eventos[0] ?? null;
  const notificacoes = pedido
    ? (await s.list(getResource('commerce_notificacoes')!, { page: 1, pageSize: 200, filter: { empresa_id: empresaId, pedido_id: Number(pedido.id) } })).rows
    : [];
  const pix = situacaoInstrumentosPix({
    copia_cola: copiaColaPixValido(cobranca?.copia_cola) ? cobranca?.copia_cola : cobranca?.qr_code,
    qr_code_base64: cobranca?.qr_code_base64,
    ticket_url: cobranca?.ticket_url,
  });
  return {
    pedido: pedido ? { id: Number(pedido.id), numero: String(pedido.pedido_externo || ''), estado: d.estado } : null,
    pagamento: {
      intent_id: engineIntent ? Number(engineIntent.id) : null,
      provider: engineIntent?.provider ? String(engineIntent.provider) : cobranca ? String(cobranca.provider) : null,
      metodo: engineIntent?.method ? String(engineIntent.method) : cobranca ? String(cobranca.metodo) : null,
      status: engineIntent?.status ? String(engineIntent.status) : null,
      cobranca_status: cobranca ? String(cobranca.status) : null,
      provider_order_id: cobranca?.provider_ref ? String(cobranca.provider_ref) : engineAttempt?.provider_transaction_id ? String(engineAttempt.provider_transaction_id) : null,
      falha: engineAttempt?.failure_code ? String(engineAttempt.failure_code) : null,
      revisao_tardia: d.lateReview?.status ? String(d.lateReview.status) : null,
    },
    pix: { ...pix, expira_em: cobranca?.expires_em ? String(cobranca.expires_em) : null },
    webhook: {
      estado: eventos.length ? 'RECEBIDO' : 'NAO_RECEBIDO',
      total: eventos.length,
      ultimo: ultimoEvento
        ? {
            evento: ultimoEvento.evento ? String(ultimoEvento.evento) : null,
            status: String(ultimoEvento.status || ''),
            recebido_em: ultimoEvento.recebido_em ? String(ultimoEvento.recebido_em) : null,
            processado_em: ultimoEvento.processado_em ? String(ultimoEvento.processado_em) : null,
            erro: ultimoEvento.erro ? String(ultimoEvento.erro).slice(0, 300) : null,
          }
        : null,
    },
    notificacoes: { email: situacaoDoCanal(notificacoes, 'EMAIL'), whatsapp: situacaoDoCanal(notificacoes, 'WHATSAPP') },
    canais: statusCanaisNotificacao(),
    pode_atualizar: !!(engineIntent && engineIntent.provider && engineIntent.provider !== 'MANUAL' && engineAttempt?.provider_transaction_id),
  };
}

// Consulta manual ao provider: no máximo 1 a cada 5 s por pedido (evita
// rajadas de cliques/abas virando chamadas repetidas ao Mercado Pago).
const ULTIMA_CONSULTA_MANUAL = new Map<string, number>();
const INTERVALO_CONSULTA_MANUAL_MS = 5_000;

/**
 * POST /api/commerce/pedidos/:saleId/atualizar-pagamento — "Atualizar status
 * do pagamento". Consulta o provider pela referência JÁ gravada (GET
 * /v1/orders/{id}), completa QR/Copia e Cola/link e aplica o estado pela
 * máquina canônica do Payment Engine. Idempotente: nunca cria cobrança, nunca
 * cria segunda venda, nunca baixa estoque duas vezes.
 */
export async function atualizarPagamentoPedidoCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  // commerce_pedidos é somente leitura no CRUD: a ação usa a mesma alçada de
  // endpoint de fluxo de converter/cancelar.
  checkAccess(R_PEDIDOS(), actor, 'read');
  checkFluxo(getResource('vendas')!, actor);
  const saleId = String(req.params.saleId);
  const s = getStore();
  const sale = await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: escopo.empresaId });
  if (!sale) throw new HttpError(404, 'Pedido não encontrado.');
  const pedido = await s.findOneWhere(R_PEDIDOS(), { empresa_id: escopo.empresaId, sale_id: saleId });
  if (!pedido) throw new HttpError(409, 'Pedido sem projeção commerce.');
  const intent = await s.findOneWhere(R_INTENTS, { empresa_id: escopo.empresaId, order_id: Number(pedido.id) });
  if (!intent) throw new HttpError(409, 'Pedido sem pagamento no Payment Engine para consultar.');
  const ultimaTentativa = (await s.list(R_ATTEMPTS, { page: 1, pageSize: 1, sort: 'id', dir: 'desc', filter: { empresa_id: escopo.empresaId, payment_intent_id: Number(intent.id) } })).rows[0];
  if (!ultimaTentativa?.provider_transaction_id)
    throw new HttpError(409, 'Pagamento sem referência do provider: a criação não foi confirmada. Nenhuma nova cobrança será criada.');

  const chave = `${escopo.empresaId}:${Number(intent.id)}`;
  const agora = Date.now();
  const anterior = ULTIMA_CONSULTA_MANUAL.get(chave) ?? 0;
  if (agora - anterior < INTERVALO_CONSULTA_MANUAL_MS) {
    return res.json({ ok: true, atualizado: false, motivo: 'Consulta recente ao provedor; aguarde alguns segundos.', ...(await montarVisaoDaSale(escopo.empresaId, sale)) });
  }
  ULTIMA_CONSULTA_MANUAL.set(chave, agora);
  if (ULTIMA_CONSULTA_MANUAL.size > 1000)
    for (const [k, t] of ULTIMA_CONSULTA_MANUAL) if (agora - t > 60_000) ULTIMA_CONSULTA_MANUAL.delete(k);

  const cobrancaAntes = pedido.cobranca_id ? await s.findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: escopo.empresaId, id: Number(pedido.cobranca_id) }) : null;
  const antes = {
    pedido_estado: String(pedido.estado),
    engine_status: String(intent.status),
    cobranca_status: cobrancaAntes ? String(cobrancaAntes.status) : null,
    pix: cobrancaAntes ? situacaoInstrumentosPix({ copia_cola: cobrancaAntes.copia_cola ?? cobrancaAntes.qr_code, qr_code_base64: cobrancaAntes.qr_code_base64, ticket_url: cobrancaAntes.ticket_url }) : null,
  };
  const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
  try {
    const sincronizado = await paymentEngine.synchronize(escopo.empresaId, Number(intent.id), { allowCreateReplay: false });
    if (sincronizado === 'not-configured')
      throw new HttpError(503, 'Gateway de pagamento não configurado (credencial ou segredo de webhook ausente). Nada foi consultado.');
    if (sincronizado === 'manual') throw new HttpError(409, 'Pagamento manual: não há provedor para consultar.');
    await paymentEngine.deliverToCommerce(escopo.empresaId, Number(intent.id));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'O provedor de pagamento não respondeu de forma verificável. Nada foi alterado; tente novamente em instantes.');
  }
  const pedidoDepois = await s.findOneWhere(R_PEDIDOS(), { empresa_id: escopo.empresaId, id: Number(pedido.id) });
  const intentDepois = await s.findOneWhere(R_INTENTS, { empresa_id: escopo.empresaId, id: Number(intent.id) });
  const cobrancaDepois = pedidoDepois?.cobranca_id ? await s.findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: escopo.empresaId, id: Number(pedidoDepois.cobranca_id) }) : null;
  const depois = {
    pedido_estado: String(pedidoDepois?.estado ?? pedido.estado),
    engine_status: String(intentDepois?.status ?? intent.status),
    cobranca_status: cobrancaDepois ? String(cobrancaDepois.status) : null,
    pix: cobrancaDepois ? situacaoInstrumentosPix({ copia_cola: cobrancaDepois.copia_cola ?? cobrancaDepois.qr_code, qr_code_base64: cobrancaDepois.qr_code_base64, ticket_url: cobrancaDepois.ticket_url }) : null,
  };
  await s.audit({
    empresa_id: escopo.empresaId,
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'ajuste',
    recurso: 'commerce_pedidos',
    registro_id: Number(pedido.id),
    descricao: 'Status do pagamento consultado no provedor (atualização manual)',
    dados: { antes, depois },
  });
  const saleAtual = (await s.findOneWhere(R_SALES(), { id: saleId, empresa_id: escopo.empresaId })) ?? sale;
  res.json({ ok: true, atualizado: true, ...(await montarVisaoDaSale(escopo.empresaId, saleAtual)) });
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
  emitirEventoPedido(pedido, 'ORDER_CANCELLED');
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
  // Fulfillment real (código de rastreio gravado por um responsável autorizado)
  // dispara a comunicação transacional — nunca um status inventado.
  if (pedido && status === 'entregue') emitirEventoPedido(pedido, 'ORDER_DELIVERED');
  else if (pedido && ['postado', 'em_transito', 'saiu_entrega'].includes(status)) emitirEventoPedido(pedido, 'ORDER_SHIPPED');
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


/** GET /api/commerce/erros — só as FALHAS reais (publicações, outbox, pedidos, webhooks) da empresa. */
export async function listarErrosCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(getResource('commerce_outbox')!, actor, 'read');
  const s = getStore();
  const [publicacoes, outbox, pedidos, webhooks] = await Promise.all([
    s.list(getResource('commerce_publicacoes')!, { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' }),
    s.list(getResource('commerce_outbox')!, { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId, estado: 'ERRO' }, sort: 'id', dir: 'desc' }),
    s.list(R_PEDIDOS(), { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId, estado: 'ERRO' }, sort: 'id', dir: 'desc' }),
    s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' }),
  ]);
  const erros: Record<string, unknown>[] = [];
  for (const p of publicacoes.rows) {
    const estado = String(p.estado);
    if (!['ERROR', 'REJECTED'].includes(estado)) continue;
    erros.push({
      origem: 'publicacao',
      id: Number(p.id),
      referencia: `Produto #${p.produto_id} · ${String(p.canal)}`,
      estado,
      mensagem: p.ultimo_erro ? String(p.ultimo_erro) : 'Falha sem mensagem registrada.',
      quando: p.atualizado_em ? String(p.atualizado_em) : p.criado_em ? String(p.criado_em) : null,
      acao: 'reprocessar',
      link: `/commerce/publicacoes/${Number(p.id)}`,
    });
  }
  for (const o of outbox.rows) {
    erros.push({
      origem: 'outbox',
      id: Number(o.id),
      referencia: `${String(o.tipo)} · ${String(o.chave)}`,
      estado: String(o.estado),
      mensagem: o.ultimo_erro ? String(o.ultimo_erro) : 'Falha sem mensagem registrada.',
      quando: o.atualizado_em ? String(o.atualizado_em) : null,
      acao: 'fila',
      link: '/commerce/fila',
    });
  }
  for (const p of pedidos.rows) {
    erros.push({
      origem: 'pedido',
      id: Number(p.id),
      referencia: `${String(p.canal)} · ${String(p.pedido_externo)}`,
      estado: 'ERRO',
      mensagem: p.erro ? String(p.erro) : 'Falha sem mensagem registrada.',
      quando: p.atualizado_em ? String(p.atualizado_em) : null,
      acao: 'detalhe',
      link: p.sale_id ? `/commerce/pedidos/${encodeURIComponent(String(p.sale_id))}` : '/commerce/pedidos',
    });
  }
  for (const w of webhooks.rows) {
    const status = String(w.status || '');
    const assinaturaInvalida = w.assinatura_ok === false;
    if (status !== 'erro' && !assinaturaInvalida) continue;
    erros.push({
      origem: 'webhook',
      id: Number(w.id),
      referencia: `${String(w.provider || 'gateway')} · ${String(w.evento_id || w.evento || '')}`.trim(),
      estado: assinaturaInvalida ? 'ASSINATURA_INVALIDA' : status,
      mensagem: w.erro ? String(w.erro) : assinaturaInvalida ? 'Assinatura inválida — evento rejeitado.' : 'Falha sem mensagem registrada.',
      quando: w.processado_em ? String(w.processado_em) : w.recebido_em ? String(w.recebido_em) : w.criado_em ? String(w.criado_em) : null,
      acao: 'eventos',
      link: '/commerce/eventos',
    });
  }
  erros.sort((a, b) => String(b.quando ?? '').localeCompare(String(a.quando ?? '')));
  res.json({ total: erros.length, erros: erros.slice(0, 300) });
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
