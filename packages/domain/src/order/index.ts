// Canais de venda do domínio. SHOPEE e TIKTOK_SHOP saíram com a remoção
// dos conectores nativos (2026-10-05); a triangulação desses canais chega
// pela NUVEMSHOP, a plataforma-ponte do Hub Omnichannel.
export type SalesChannel = 'COUNTER' | 'REPRESENTATIVE' | 'WOOCOMMERCE' | 'MERCADOLIVRE' | 'MERCADOPAGO' | 'NUVEMSHOP';

export interface OrderItemProps { productId: number; sizeId?: number; sku: string; quantity: number; unitPriceCents: number; }
export class OrderItem {
  readonly productId: number; readonly sizeId?: number; readonly sku: string; readonly quantity: number; readonly unitPriceCents: number;
  constructor(props: OrderItemProps) {
    if (!Number.isInteger(props.quantity) || props.quantity <= 0) throw new Error('Order item quantity must be positive');
    if (!Number.isInteger(props.unitPriceCents) || props.unitPriceCents < 0) throw new Error('Order item price must be non-negative cents');
    this.productId = props.productId; this.sizeId = props.sizeId; this.sku = props.sku; this.quantity = props.quantity; this.unitPriceCents = props.unitPriceCents;
  }
  get subtotalCents(): number { return this.quantity * this.unitPriceCents; }
}
export interface OrderProps { id?: string; tenantId: string; channel: SalesChannel; externalId: string; customerId?: number; items: readonly OrderItemProps[]; occurredAt?: Date; }
export class Order {
  readonly id?: string; readonly tenantId: string; readonly channel: SalesChannel; readonly externalId: string; readonly customerId?: number; readonly items: readonly OrderItem[]; readonly occurredAt: Date;
  constructor(props: OrderProps) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(props.tenantId)) throw new Error('tenantId must be a UUID');
    if (!props.externalId.trim()) throw new Error('externalId is required');
    if (!props.items.length) throw new Error('Order must contain at least one item');
    this.id = props.id; this.tenantId = props.tenantId; this.channel = props.channel; this.externalId = props.externalId; this.customerId = props.customerId; this.items = props.items.map(i => new OrderItem(i)); this.occurredAt = props.occurredAt ?? new Date();
  }
  get totalCents(): number { return this.items.reduce((sum, item) => sum + item.subtotalCents, 0); }
}

export interface OrderTransaction {
  createSale(order: Order): Promise<{ id: string }>;
  createSaleItems(saleId: string, tenantId: string, items: readonly OrderItem[]): Promise<void>;
  decrementStock(item: OrderItem): Promise<void>;
  createReceivable(input: { tenantId: string; saleId: string; amountCents: number }): Promise<void>;
  appendAudit(input: { tenantId: string; saleId: string; payload: unknown }): Promise<void>;
}
export interface OrderUnitOfWork { transaction<T>(work: (tx: OrderTransaction) => Promise<T>): Promise<T>; }
export class IngestOrderUseCase {
  constructor(private readonly uow: OrderUnitOfWork) {}
  execute(order: Order): Promise<{ saleId: string }> {
    return this.uow.transaction(async tx => {
      const sale = await tx.createSale(order);
      await tx.createSaleItems(sale.id, order.tenantId, order.items);
      for (const item of order.items) await tx.decrementStock(item);
      await tx.createReceivable({ tenantId: order.tenantId, saleId: sale.id, amountCents: order.totalCents });
      await tx.appendAudit({ tenantId: order.tenantId, saleId: sale.id, payload: { channel: order.channel, externalId: order.externalId, totalCents: order.totalCents } });
      return { saleId: sale.id };
    });
  }
}
