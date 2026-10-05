import type { Order, OrderItem, OrderTransaction, OrderUnitOfWork } from '../../../domain/src/index.js';

/** Port estreita sobre o PrismaClient; mantém a infraestrutura substituível e o domínio puro. */
export interface PrismaOrderTransactionClient {
  $transaction<T>(fn: (tx: PrismaOrderTransactionClient) => Promise<T>): Promise<T>;
  sale: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }>; };
  saleItem: { createMany(args: { data: Record<string, unknown>[] }): Promise<unknown> };
  estoque: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> };
  lancamentoFinanceiro: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  auditoria: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}
export class PrismaOrderUnitOfWork implements OrderUnitOfWork {
  constructor(private readonly prisma: PrismaOrderTransactionClient) {}
  transaction<T>(work: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async client => work(new PrismaOrderTransaction(client)));
  }
}
class PrismaOrderTransaction implements OrderTransaction {
  constructor(private readonly db: PrismaOrderTransactionClient) {}
  async createSale(order: Order): Promise<{ id: string }> {
    return this.db.sale.create({ data: { tenantId: order.tenantId, channel: order.channel, externalOrderId: order.externalId, quantity: order.items.reduce((n, i) => n + i.quantity, 0), amountCents: order.totalCents, occurredAt: order.occurredAt } });
  }
  createSaleItems(saleId: string, tenantId: string, items: readonly OrderItem[]): Promise<void> { return this.db.saleItem.createMany({ data: items.map(i => ({ saleId, tenantId, productId: i.productId, sizeId: i.sizeId, quantity: i.quantity, unitPriceCents: i.unitPriceCents, subtotalCents: i.subtotalCents })) }).then(() => undefined); }
  async decrementStock(item: OrderItem): Promise<void> { const result = await this.db.estoque.updateMany({ where: { produtoId: item.productId, tamanhoId: item.sizeId, quantidade: { gte: item.quantity } }, data: { quantidade: { decrement: item.quantity } } }); if (result.count !== 1) throw new Error(`Insufficient stock for ${item.sku}`); }
  createReceivable(input: { tenantId: string; saleId: string; amountCents: number }): Promise<void> { return this.db.lancamentoFinanceiro.create({ data: { tenantId: input.tenantId, vendaId: input.saleId, tipo: 'receita', valor: input.amountCents / 100 } }).then(() => undefined); }
  appendAudit(input: { tenantId: string; saleId: string; payload: unknown }): Promise<void> { return this.db.auditoria.create({ data: { tenantId: input.tenantId, acao: 'order.ingested', recurso: 'sales', dados: input.payload, registroId: input.saleId } }).then(() => undefined); }
}
