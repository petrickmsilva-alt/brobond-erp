import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { createConnectorPanelService } = await import('../../modules/connectors/core/panel.service');

function db(handler: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const log: { sql: string; params: unknown[] }[] = [];
  return {
    log,
    async query<T>(text: string, params: unknown[] = []) {
      log.push({ sql: text, params });
      return { rows: handler(text, params) as T[] };
    },
  } as any;
}

const repository = { listRecentEvents: async () => [] } as any;
const vazio = (sql: string) => {
  if (sql.includes('revenue_cents')) return [{ revenue_cents: 0, sales_count: 0, paid_count: 0, event_count: 0 }];
  return [];
};

test('painel Mercado Pago separa conta importada, BroBond Store e conciliação no tenant', async () => {
  const database = db((sql) => {
    if (sql.includes('liquido_conciliado')) {
      return [{ settlements: 5, reconciliadas: 3, pendentes: 1, divergentes: 1, disputas_abertas: 2, repasses_pendentes: 4, liquido_conciliado: 7550 }];
    }
    if (sql.includes('FROM payment_intents pi')) return [{ total: 3, pagos: 1, receita: 8000, pendentes: 1 }];
    return vazio(sql);
  });
  const service = createConnectorPanelService({ resolveDb: () => database, repository });
  const panel = await service.getPanel(11, 7, 'MERCADOPAGO');

  assert.deepEqual(panel.storeSales, { count: 3, paidCount: 1, paidRevenueCents: 8000, pendingCount: 1 });
  assert.deepEqual(panel.reconciliation, {
    settlementCount: 5,
    reconciledCount: 3,
    pendingSettlementCount: 1,
    divergentSettlementCount: 1,
    openDisputeCount: 2,
    pendingPayoutCount: 4,
    reconciledNetCents: 7550,
  });
  assert.equal(panel.revenueCents, 0, 'receita da loja não é somada à receita da conta importada');
  for (const q of database.log.filter((q) => q.sql.includes('payment_'))) {
    assert.deepEqual(q.params, [11], 'consultas financeiras são exclusivamente tenant-scoped');
    assert.ok(!q.sql.includes('usuario_id'), 'Payment Engine não possui filtro artificial por operador');
  }
});

test('demais conectores não consultam nem recebem conciliação do Mercado Pago', async () => {
  const database = db((sql) => vazio(sql));
  const service = createConnectorPanelService({ resolveDb: () => database, repository });
  const panel = await service.getPanel(11, 7, 'NUVEMSHOP');
  assert.equal(panel.storeSales, null);
  assert.equal(panel.reconciliation, null);
  assert.equal(database.log.some((q) => q.sql.includes('payment_settlements')), false);
});

test('falha da consulta da BroBond Store propaga erro, nunca vira zero ou vendas ausentes', async () => {
  const database = db((sql) => {
    if (sql.includes('FROM payment_intents pi')) throw new Error('database unavailable — fixture');
    return vazio(sql);
  });
  const service = createConnectorPanelService({ resolveDb: () => database, repository });
  await assert.rejects(() => service.getPanel(11, 7, 'MERCADOPAGO'), /database unavailable/);
});
