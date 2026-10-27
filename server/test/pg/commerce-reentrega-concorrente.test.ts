// ============================================================================
// COMMERCE — REENTREGA SIMULTÂNEA DO MESMO PEDIDO (regressão do gate de PG)
//
// Origem do defeito: o job `testes-postgres` ficou vermelho no CI com
//
//   not ok — P0-02 PostgreSQL: … matcher não cruza SKU
//   duplicate key value violates unique constraint
//     "sales_empresa_usuario_channel_external_order_id_key"   (23505)
//
// `upsertIngestedSale` arbitra o `ON CONFLICT` por `reference`, mas o
// PostgreSQL verifica os índices únicos na ordem de criação: com duas entregas
// do MESMO pedido ao mesmo tempo (webhook "at-least-once"), o índice composto
// pode ser acusado antes de o árbitro entrar em ação. Em concorrência maior
// ainda aparece `40P01` (deadlock) entre inserções especulativas das mesmas
// chaves. Nada era gravado, mas a ingestão devolvia erro para o conector.
//
// Este arquivo reproduz a condição de forma determinística: N rodadas de
// entregas SIMULTÂNEAS do mesmo pedido. O resultado exigido é
// "nenhum erro" + "uma única venda" + "itens coerentes" — nada de tolerância
// a duplicata nem de retry infinito.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('COMMERCE: reentregas simultâneas do mesmo pedido nunca colidem (PostgreSQL)', { skip }, async () => {
  const { migrate, pool } = await import('../../src/db');
  await migrate();
  const pg = pool;
  assert.ok(pg, 'pool PostgreSQL deve estar configurado');

  const { createSalesService } = await import('../../../modules/connectors/ingestion/sales.service');

  const sufixo = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const query = async (text: string, params: readonly unknown[] = []) => pg!.query(text, [...params]);

  /**
   * O MESMO adapter de produção (`initConnectors` em `server/src/connectors.ts`):
   * `query` no pool e `transaction` com um client dedicado. Sem `transaction`,
   * `runInTransaction` degrada para execução solta e a prova não valeria nada.
   */
  const db = {
    query: async (text: string, params: readonly unknown[] = []) => {
      const r = await query(text, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const client = await pg!.connect();
      try {
        await client.query('BEGIN');
        const tx = {
          query: async (text: string, params: readonly unknown[] = []) => {
            const r = await client.query(text, [...params]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        };
        const saida = await fn(tx);
        await client.query('COMMIT');
        return saida;
      } catch (erro) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw erro;
      } finally {
        client.release();
      }
    },
  };
  const sales = createSalesService(() => db as any);

  const empresa = (await query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Reentrega ${sufixo}`])).rows[0];
  const empresaId = Number(empresa.id);
  const usuario = (
    await query(
      `INSERT INTO usuarios (nome, email, perfil, ativo, empresa_id) VALUES ($1, $2, 'admin', true, $3) RETURNING id`,
      [`Reentrega ${sufixo}`, `reentrega-${sufixo.toLowerCase()}@example.test`, empresaId],
    )
  ).rows[0];
  const usuarioId = Number(usuario.id);

  try {
    // 40 rodadas × 8 entregas simultâneas: a proporção que reproduzia o
    // 23505/40P01 antes da correção (ver o comentário do topo do arquivo).
    const RODADAS = 40;
    const SIMULTANEAS = 8;
    for (let rodada = 0; rodada < RODADAS; rodada += 1) {
      const input = {
        channel: 'NUVEMSHOP' as const,
        externalOrderId: `REENTREGA-${sufixo}-${rodada}`,
        amountCents: 1000 + rodada,
        currency: 'BRL',
        status: 'PAID' as const,
        quantity: 2,
        occurredAt: new Date('2026-10-14T12:00:00.000Z'),
        items: [{ sku: `SKU-${sufixo}`, title: `Item ${sufixo}`, sizeLabel: 'P', quantity: 2, unitPriceCents: 500 }],
      };
      const resultados = await Promise.all(
        Array.from({ length: SIMULTANEAS }, () => sales.upsertIngestedSale(empresaId, usuarioId, input)),
      );
      // Todas as entregas concordam no MESMO id de venda: nada foi duplicado.
      const ids = new Set(resultados.map((r) => String(r.sale.id)));
      assert.equal(ids.size, 1, `rodada ${rodada}: as ${SIMULTANEAS} entregas apontam para a mesma venda`);
    }

    const linhas = await query(
      `SELECT COUNT(*)::int AS total FROM sales WHERE empresa_id = $1 AND usuario_id = $2 AND channel = 'NUVEMSHOP'`,
      [empresaId, usuarioId],
    );
    assert.equal(Number(linhas.rows[0].total), RODADAS, 'uma venda por pedido, nunca uma por reentrega');

    const itens = await query(
      `SELECT COUNT(*)::int AS total FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.empresa_id = $1 AND s.usuario_id = $2`,
      [empresaId, usuarioId],
    );
    assert.equal(Number(itens.rows[0].total), RODADAS, 'os itens são reescritos, não acumulados');
  } finally {
    // Limpeza pelo RESPONSÁVEL (não pelo par empresa+responsável): se a rodada
    // estourar no meio, o `finally` ainda precisa remover tudo que a fixture
    // criou — inclusive o que ficou de uma tentativa interrompida.
    await query(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE usuario_id = $1)`, [usuarioId]).catch(() => undefined);
    await query(`DELETE FROM sales WHERE usuario_id = $1`, [usuarioId]).catch(() => undefined);
    await query(`DELETE FROM usuarios WHERE id = $1`, [usuarioId]).catch(() => undefined);
    await query(`DELETE FROM empresas WHERE id = $1`, [empresaId]).catch(() => undefined);
  }
});
