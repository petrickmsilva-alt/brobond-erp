import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ConnectorDatabase, SqlQueryResult } from '../../modules/connectors/core/database';
import { createConnectorRepository } from '../../modules/connectors/core/connector.repository';
import { matchCatalogItem } from '../../modules/connectors/ingestion/catalog-matcher';
import { createSalesService, type IngestedSaleInput } from '../../modules/connectors/ingestion/sales.service';
import type { SaleChannelName } from '../../modules/connectors/core/providers';

const PEDIDO: IngestedSaleInput = {
  channel: 'NUVEMSHOP' as SaleChannelName,
  externalOrderId: 'PEDIDO-REPETIDO-01',
  amountCents: 12_500,
  currency: 'BRL',
  status: 'PAID',
  quantity: 1,
  occurredAt: new Date('2026-10-14T12:00:00.000Z'),
  items: [{ sku: 'SKU-IGUAL-A-B', title: 'Produto de mesmo nome', sizeLabel: 'M', quantity: 1, unitPriceCents: 12_500 }],
};

type LoggedQuery = { sql: string; params: readonly unknown[] };

/**
 * Banco de teste com chave única por empresa/usuário/canal/pedido e transações
 * serializadas como o lock da linha em `INSERT .. ON CONFLICT DO UPDATE`.
 * Não simula rede nem usa credencial real.
 */
class ConcurrentSalesDb implements ConnectorDatabase {
  readonly log: LoggedQuery[] = [];
  readonly sales = new Map<string, Record<string, unknown>>();
  readonly items: Array<Record<string, unknown>> = [];
  private tail: Promise<void> = Promise.resolve();

  async transaction<T>(fn: (db: ConnectorDatabase) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn(this);
    } finally {
      release();
    }
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<SqlQueryResult<T>> {
    this.log.push({ sql, params });
    let rows: Record<string, unknown>[] = [];

    if (sql.includes('FROM produtos')) {
      const empresaId = Number(params[0]);
      const sku = String(params[1] ?? '').toUpperCase();
      const catalogoPorEmpresa: Record<number, Record<string, unknown>> = {
        1: { id: 101, sku: 'SKU-IGUAL-A-B', nome: 'Produto de mesmo nome', empresa_id: 1 },
        2: { id: 202, sku: 'SKU-IGUAL-A-B', nome: 'Produto de mesmo nome', empresa_id: 2 },
      };
      const product = catalogoPorEmpresa[empresaId];
      const field = /upper\(btrim\(nome\)\)/i.test(sql) ? 'nome' : 'sku';
      rows = product && String(product[field]).toUpperCase() === sku ? [product] : [];
    } else if (sql.includes('FROM tamanhos')) {
      // `tamanhos` é dicionário global; empresa não é inferida do rótulo.
      rows = [{ id: 4, codigo: 'M' }];
    } else if (sql.startsWith('SELECT') && sql.includes('FROM sales')) {
      const [empresaId, usuarioId, channel, externalOrderId] = params;
      const key = `${empresaId}:${usuarioId}:${channel}:${externalOrderId}`;
      const sale = this.sales.get(key);
      rows = sale ? [{ ...sale }] : [];
    } else if (sql.startsWith('INSERT INTO sales')) {
      const [id, reference, quantity, amountCents, currency, status, occurredAt, channel, externalOrderId, usuarioId, empresaId] = params;
      const key = `${empresaId}:${usuarioId}:${channel}:${externalOrderId}`;
      const existing = this.sales.get(key);
      const row = {
        ...(existing ?? {}),
        id: existing?.id ?? id,
        reference: existing?.reference ?? reference,
        quantity,
        amount_cents: amountCents,
        currency,
        status,
        occurred_at: occurredAt,
        channel,
        external_order_id: externalOrderId,
        usuario_id: usuarioId,
        empresa_id: empresaId,
        created_at: existing?.created_at ?? new Date(),
        updated_at: new Date(),
        was_inserted: !existing,
      };
      this.sales.set(key, row);
      rows = [{ ...row }];
    } else if (sql.startsWith('DELETE FROM sale_items')) {
      const saleId = String(params[0]);
      for (let i = this.items.length - 1; i >= 0; i -= 1) if (this.items[i].sale_id === saleId) this.items.splice(i, 1);
    } else if (sql.startsWith('INSERT INTO sale_items')) {
      const [id, saleId, productId, sizeId, variacaoExterna, quantity, unitPriceCents, discountCents, subtotalCents] = params;
      this.items.push({ id, sale_id: saleId, product_id: productId, size_id: sizeId, variacao_externa: variacaoExterna, quantity, unit_price_cents: unitPriceCents, discount_cents: discountCents, subtotal_cents: subtotalCents });
    }

    return { rows: rows as T[], rowCount: rows.length };
  }
}

describe('P0-02 — isolamento tenant no matcher e ingestão Commerce', () => {
  test('SKU e nome iguais em duas empresas não fazem o matcher buscar produto globalmente', async () => {
    const log: LoggedQuery[] = [];
    const produtos = new Map<number, Record<string, unknown>>([
      [1, { id: 101, sku: 'SKU-IGUAL-A-B', nome: 'Produto de mesmo nome', empresa_id: 1 }],
      [2, { id: 202, sku: 'SKU-IGUAL-A-B', nome: 'Produto de mesmo nome', empresa_id: 2 }],
    ]);
    const db: ConnectorDatabase = {
      async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<SqlQueryResult<T>> {
        log.push({ sql, params });
        if (sql.includes('FROM produtos')) {
          const empresaId = Number(params[0]);
          const value = String(params[1] ?? '').toUpperCase();
          const product = produtos.get(empresaId);
          const field = /upper\(btrim\(nome\)\)/i.test(sql) ? 'nome' : 'sku';
          const rows = product && String(product[field]).toUpperCase() === value ? [product] : [];
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.includes('FROM tamanhos')) return { rows: [{ id: 4, codigo: 'M' }] as T[], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };

    const [empresaA, empresaB, tentativaCrossTenant] = await Promise.all([
      matchCatalogItem(db, 1, { sku: 'SKU-IGUAL-A-B', title: 'Produto de mesmo nome', sizeLabel: 'M' }),
      matchCatalogItem(db, 2, { sku: 'SKU-IGUAL-A-B', title: 'Produto de mesmo nome', sizeLabel: 'M' }),
      matchCatalogItem(db, 1, { sku: 'SKU-SOMENTE-DA-EMPRESA-B', title: 'Título exclusivo da Empresa B', sizeLabel: 'M' }),
    ]);

    assert.deepEqual(empresaA, { productId: 101, sizeId: 4 });
    assert.deepEqual(empresaB, { productId: 202, sizeId: 4 });
    assert.deepEqual(tentativaCrossTenant, { productId: null, sizeId: 4 }, 'SKU exclusivo da B não vira vínculo na venda da A');
    const consultasProduto = log.filter((q) => q.sql.includes('FROM produtos'));
    assert.ok(consultasProduto.length >= 4);
    for (const consulta of consultasProduto) {
      assert.match(consulta.sql, /empresa_id\s*=\s*\$1/i, 'cada caminho de SKU, prefixo e título inclui o tenant no SQL');
      assert.ok([1, 2].includes(Number(consulta.params[0])), 'tenant vem da chamada confiável, não do SKU');
    }
    await assert.rejects(() => matchCatalogItem(db, 0, { sku: 'SKU-IGUAL-A-B' }), /empresaId explícito/);
  });

  test('duplicatas e entregas simultâneas não duplicam venda/itens; mesmo pedido em tenants distintos fica separado', async () => {
    const db = new ConcurrentSalesDb();
    const sales = createSalesService(() => db);

    const [a1, a2, b1] = await Promise.all([
      sales.upsertIngestedSale(1, 7, PEDIDO),
      sales.upsertIngestedSale(1, 7, PEDIDO),
      sales.upsertIngestedSale(2, 7, PEDIDO),
    ]);

    assert.equal(db.sales.size, 2, 'uma venda por tenant, apesar do mesmo usuário/canal/pedido externo');
    assert.deepEqual(new Set([a1.sale.empresaId, a2.sale.empresaId, b1.sale.empresaId]), new Set([1, 2]));
    assert.deepEqual(
      [...db.sales.values()].map((sale) => [sale.empresa_id, sale.usuario_id, sale.external_order_id]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [[1, 7, 'PEDIDO-REPETIDO-01'], [2, 7, 'PEDIDO-REPETIDO-01']]
    );
    assert.equal(db.items.length, 2, 'a entrega repetida não deixa item duplicado');
    assert.deepEqual(
      db.items.map((item) => [db.sales.get(`${item.product_id === 101 ? 1 : 2}:7:NUVEMSHOP:PEDIDO-REPETIDO-01`)?.empresa_id, item.product_id]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [[1, 101], [2, 202]],
      'o vínculo de produto também permanece dentro da empresa da venda'
    );
    assert.deepEqual([a1.outcome, a2.outcome].sort(), ['created', 'unchanged']);
    assert.equal(b1.outcome, 'created');
    assert.ok(db.log.some((q) => q.sql.includes('ON CONFLICT (empresa_id, usuario_id, channel, external_order_id)')));
    for (const query of db.log.filter((q) => q.sql.includes('FROM produtos'))) {
      assert.match(query.sql, /empresa_id\s*=\s*\$1/i);
    }
  });
});

describe('P0-02 — escopo persistido de conexão/evento', () => {
  test('consulta de conexão e deduplicação de evento incluem empresa e usuário', async () => {
    const log: LoggedQuery[] = [];
    const db: ConnectorDatabase = {
      async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<SqlQueryResult<T>> {
        log.push({ sql, params });
        if (sql.includes('FROM connectors') && sql.includes('WHERE empresa_id = $1 AND usuario_id = $2')) {
          const [empresaId, usuarioId, provider] = params;
          const rows = empresaId === 1 || empresaId === 2 ? [{
            id: `connector-${empresaId}`, empresa_id: empresaId, usuario_id: usuarioId, provider,
            status: 'CONNECTED', shop_id: `loja-${empresaId}`, shop_name: null, access_token: 'synthetic-ciphertext',
            refresh_token: null, client_secret: null, public_key: null, expires_at: null,
            imported_count: 0, duplicated_count: 0, failed_count: 0, sync_count: 0,
            last_sync_at: null, last_error: null, metadata: null, created_at: new Date(), updated_at: new Date(),
          }] : [];
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.includes('SELECT 1 AS ok FROM connector_events')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('INSERT INTO connector_events')) {
          return { rows: [{ id: 'event-1', empresa_id: params[1], usuario_id: params[2], connector_id: params[3], provider: params[4], external_event_id: params[5], topic: params[6], payload: null, processed_at: null, created_at: new Date() } as T], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const repository = createConnectorRepository(db);

    const [a, b] = await Promise.all([
      repository.findByProvider(1, 7, 'MERCADOLIVRE'),
      repository.findByProvider(2, 7, 'MERCADOLIVRE'),
    ]);
    assert.equal(a?.empresaId, 1);
    assert.equal(b?.empresaId, 2);
    await repository.hasEvent(1, 7, 'MERCADOLIVRE', 'same-external-id');
    await repository.hasEvent(2, 7, 'MERCADOLIVRE', 'same-external-id');
    await repository.recordEvent(1, 7, { provider: 'MERCADOLIVRE', externalEventId: 'same-external-id' });
    await repository.recordEvent(2, 7, { provider: 'MERCADOLIVRE', externalEventId: 'same-external-id' });

    const selecoes = log.filter((q) => q.sql.includes('FROM connectors'));
    assert.equal(selecoes.length, 2);
    for (const q of selecoes) {
      assert.match(q.sql, /empresa_id\s*=\s*\$1\s+AND\s+usuario_id\s*=\s*\$2/i);
      assert.equal(q.params[1], 7);
    }
    const eventos = log.filter((q) => q.sql.includes('connector_events'));
    assert.equal(eventos.length, 4);
    const consultasEvento = eventos.filter((q) => q.sql.includes('SELECT 1'));
    assert.ok(consultasEvento.every((q) => /empresa_id = \$1 AND usuario_id = \$2/.test(q.sql)));
    assert.deepEqual(consultasEvento.map((q) => q.params.slice(0, 2)), [[1, 7], [2, 7]]);
    const gravacoesEvento = eventos.filter((q) => q.sql.startsWith('INSERT'));
    assert.ok(gravacoesEvento.every((q) => /id, empresa_id, usuario_id, connector_id/.test(q.sql)));
    assert.deepEqual(gravacoesEvento.map((q) => q.params.slice(1, 3)), [[1, 7], [2, 7]]);
    assert.ok(gravacoesEvento.every((q) => q.sql.includes('ON CONFLICT (empresa_id, usuario_id, provider, external_event_id)')));
    await assert.rejects(() => repository.list(0, 7), /empresaId/);
  });

  test('webhook sem sessão é recusado quando a mesma identidade externa aparece em dois tenants', async () => {
    const db: ConnectorDatabase = {
      async query<T extends Record<string, unknown>>(sql: string): Promise<SqlQueryResult<T>> {
        assert.match(sql, /LIMIT 2/);
        const rows = [
          { id: 'c-a', empresa_id: 1, usuario_id: 7, provider: 'NUVEMSHOP' },
          { id: 'c-b', empresa_id: 2, usuario_id: 7, provider: 'NUVEMSHOP' },
        ];
        return { rows: rows as T[], rowCount: rows.length };
      },
    };
    const repository = createConnectorRepository(db);
    assert.equal(await repository.findByShopId('NUVEMSHOP', 'loja-reutilizada'), null, 'não desempata por ordem e não escolhe empresa por acidente');
  });
});
