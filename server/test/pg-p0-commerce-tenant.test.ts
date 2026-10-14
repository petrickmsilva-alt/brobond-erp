import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ConnectorDatabase, SqlQueryResult } from '../../modules/connectors/core/database';
import { createConnectorRepository } from '../../modules/connectors/core/connector.repository';
import { matchCatalogItem } from '../../modules/connectors/ingestion/catalog-matcher';
import { createSalesService } from '../../modules/connectors/ingestion/sales.service';
import type { SaleChannelName } from '../../modules/connectors/core/providers';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

/** Prova sobre constraints reais e duas transações PostgreSQL concorrentes. */
test('P0-02 PostgreSQL: conexão/evento/venda têm chave tenant e matcher não cruza SKU', { skip }, async () => {
  const { migrate, pool } = await import('../src/db');
  await migrate();
  assert.ok(pool, 'pool PostgreSQL deve estar configurado');
  const pg: any = pool;
  const sufixo = randomUUID().replace(/-/g, '');
  let empresaA: number | null = null;
  let empresaB: number | null = null;
  let usuarioId: number | null = null;
  let tamanhoId: number | null = null;
  const produtoIds: number[] = [];
  let eventoExterno = '';
  let pedidoExterno = '';

  const query = async <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<SqlQueryResult<T>> => {
    const result = await pg.query(text, [...params]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  };
  const db: ConnectorDatabase = {
    query,
    async transaction<T>(fn: (tx: ConnectorDatabase) => Promise<T>): Promise<T> {
      const client = await pg.connect();
      try {
        await client.query('BEGIN');
        const tx: ConnectorDatabase = {
          async query<R extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            params: readonly unknown[] = []
          ): Promise<SqlQueryResult<R>> {
            const result = await client.query(text, [...params]);
            return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };

  try {
    const a = await query<{ id: number }>(
      `INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`,
      [`P0 Commerce A ${sufixo}`, `P0 Commerce A ${sufixo} LTDA`]
    );
    empresaA = Number(a.rows[0].id);
    const b = await query<{ id: number }>(
      `INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`,
      [`P0 Commerce B ${sufixo}`, `P0 Commerce B ${sufixo} LTDA`]
    );
    empresaB = Number(b.rows[0].id);
    const u = await query<{ id: number }>(
      `INSERT INTO usuarios (nome, email, perfil, ativo, empresa_id)
       VALUES ($1, $2, 'admin', true, $3) RETURNING id`,
      [`P0 Commerce ${sufixo}`, `p0-${sufixo}@example.test`, empresaA]
    );
    usuarioId = Number(u.rows[0].id);
    await query(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, $2)
       ON CONFLICT (usuario_id, empresa_id) DO NOTHING`,
      [usuarioId, empresaB]
    );

    const tam = await query<{ id: number }>(
      `INSERT INTO tamanhos (codigo, descricao) VALUES ($1, 'Tamanho P0') RETURNING id`,
      [`P${sufixo.slice(0, 9)}`]
    );
    tamanhoId = Number(tam.rows[0].id);
    const sku = `P0-SKU-${sufixo}`;
    const nome = `Produto P0 ${sufixo}`;
    const produtoA = await query<{ id: number }>(
      `INSERT INTO produtos (empresa_id, sku, nome, preco_venda, ativo, exibir_site)
       VALUES ($1, $2, $3, 10, true, true) RETURNING id`,
      [empresaA, sku, nome]
    );
    const produtoB = await query<{ id: number }>(
      `INSERT INTO produtos (empresa_id, sku, nome, preco_venda, ativo, exibir_site)
       VALUES ($1, $2, $3, 99, true, true) RETURNING id`,
      [empresaB, sku, nome]
    );
    const produtoBExclusivo = await query<{ id: number }>(
      `INSERT INTO produtos (empresa_id, sku, nome, preco_venda, ativo, exibir_site)
       VALUES ($1, $2, $3, 99, true, true) RETURNING id`,
      [empresaB, `P0-SOMENTE-B-${sufixo}`, `Título exclusivo B ${sufixo}`]
    );
    produtoIds.push(Number(produtoA.rows[0].id), Number(produtoB.rows[0].id), Number(produtoBExclusivo.rows[0].id));

    const repository = createConnectorRepository(db);
    const shopId = `p0-shop-${sufixo}`;
    const [conectorA, conectorB] = await Promise.all([
      repository.upsertConnection(empresaA, usuarioId, 'NUVEMSHOP', {
        status: 'CONNECTED', shopId, accessToken: 'synthetic-ciphertext-A',
      }),
      repository.upsertConnection(empresaB, usuarioId, 'NUVEMSHOP', {
        status: 'CONNECTED', shopId, accessToken: 'synthetic-ciphertext-B',
      }),
    ]);
    assert.notEqual(conectorA.id, conectorB.id, 'mesmo responsável/provedor pode ter conexões independentes por empresa');
    assert.equal((await repository.findByProvider(empresaA, usuarioId, 'NUVEMSHOP'))?.empresaId, empresaA);
    assert.equal((await repository.findByProvider(empresaB, usuarioId, 'NUVEMSHOP'))?.empresaId, empresaB);
    assert.equal(await repository.findByShopId('NUVEMSHOP', shopId), null, 'identidade externa ambígua não escolhe tenant');

    eventoExterno = `P0-EVENT-${sufixo}`;
    await Promise.all([
      repository.recordEvent(empresaA, usuarioId, { provider: 'NUVEMSHOP', externalEventId: eventoExterno, connectorId: conectorA.id }),
      repository.recordEvent(empresaA, usuarioId, { provider: 'NUVEMSHOP', externalEventId: eventoExterno, connectorId: conectorA.id }),
      repository.recordEvent(empresaB, usuarioId, { provider: 'NUVEMSHOP', externalEventId: eventoExterno, connectorId: conectorB.id }),
    ]);
    const eventos = await query<{ empresa_id: number; total: number }>(
      `SELECT empresa_id, COUNT(*)::int AS total FROM connector_events
        WHERE usuario_id = $1 AND provider = 'NUVEMSHOP' AND external_event_id = $2
        GROUP BY empresa_id ORDER BY empresa_id`,
      [usuarioId, eventoExterno]
    );
    assert.deepEqual(eventos.rows.map((row) => [Number(row.empresa_id), Number(row.total)]), [[empresaA, 1], [empresaB, 1]]);
    assert.equal(await repository.hasEvent(empresaA, usuarioId, 'NUVEMSHOP', eventoExterno), true);
    assert.equal(await repository.hasEvent(empresaB, usuarioId, 'NUVEMSHOP', eventoExterno), true);

    const crossTenant = await matchCatalogItem(db, empresaA, {
      sku: `P0-SOMENTE-B-${sufixo}`,
      title: `Título exclusivo B ${sufixo}`,
    });
    assert.equal(crossTenant.productId, null, 'SKU e título exclusivos de B não casam no catálogo de A');

    pedidoExterno = `P0-ORDER-${sufixo}`;
    const sales = createSalesService(() => db);
    const input = {
      channel: 'NUVEMSHOP' as SaleChannelName,
      externalOrderId: pedidoExterno,
      amountCents: 1000,
      currency: 'BRL',
      status: 'PAID' as const,
      quantity: 1,
      occurredAt: new Date('2026-10-14T12:00:00.000Z'),
      items: [{ sku, title: nome, sizeLabel: `P${sufixo.slice(0, 9)}`, quantity: 1, unitPriceCents: 1000 }],
    };
    await Promise.all([
      sales.upsertIngestedSale(empresaA, usuarioId, input),
      sales.upsertIngestedSale(empresaA, usuarioId, input),
      sales.upsertIngestedSale(empresaB, usuarioId, input),
    ]);
    const vendas = await query<{ empresa_id: number; total: number }>(
      `SELECT empresa_id, COUNT(*)::int AS total FROM sales
        WHERE usuario_id = $1 AND channel = 'NUVEMSHOP' AND external_order_id = $2
        GROUP BY empresa_id ORDER BY empresa_id`,
      [usuarioId, pedidoExterno]
    );
    assert.deepEqual(vendas.rows.map((row) => [Number(row.empresa_id), Number(row.total)]), [[empresaA, 1], [empresaB, 1]]);
    const itens = await query<{ empresa_id: number; product_id: number; total: number }>(
      `SELECT s.empresa_id, si.product_id, COUNT(*)::int AS total
         FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.usuario_id = $1 AND s.channel = 'NUVEMSHOP' AND s.external_order_id = $2
        GROUP BY s.empresa_id, si.product_id ORDER BY s.empresa_id`,
      [usuarioId, pedidoExterno]
    );
    assert.deepEqual(
      itens.rows.map((row) => [Number(row.empresa_id), Number(row.product_id), Number(row.total)]),
      [[empresaA, produtoIds[0], 1], [empresaB, produtoIds[1], 1]],
      'matcher e itens persistidos continuam na empresa de origem'
    );
  } finally {
    if (empresaA !== null && empresaB !== null && usuarioId !== null) {
      await query(`DELETE FROM sales WHERE usuario_id = $1 AND external_order_id = $2`, [usuarioId, pedidoExterno || `P0-ORDER-${sufixo}`]);
      await query(`DELETE FROM connector_events WHERE usuario_id = $1 AND external_event_id = $2`, [usuarioId, eventoExterno || `P0-EVENT-${sufixo}`]);
      await query(`DELETE FROM connectors WHERE empresa_id = ANY($1::int[]) AND usuario_id = $2`, [[empresaA, empresaB], usuarioId]);
      if (produtoIds.length) await query(`DELETE FROM produtos WHERE id = ANY($1::int[])`, [produtoIds]);
      if (tamanhoId !== null) await query(`DELETE FROM tamanhos WHERE id = $1`, [tamanhoId]);
      await query(`DELETE FROM usuario_empresas WHERE usuario_id = $1 AND empresa_id = $2`, [usuarioId, empresaB]);
      await query(`DELETE FROM usuarios WHERE id = $1`, [usuarioId]);
    }
    const empresas = [empresaA, empresaB].filter((id): id is number => id !== null);
    if (empresas.length) await query(`DELETE FROM empresas WHERE id = ANY($1::int[])`, [empresas]);
  }
});
