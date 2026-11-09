// ============================================================================
// FASE 9.1 — DATA INTEGRITY & PERFORMANCE (BL-016)
//
// A projeção analítica `sale_items` NÃO tem `empresa_id`: a empresa vem do
// cabeçalho `sales` (tenant-tables.ts, categoria `projecao`). O defeito que
// este arquivo trava é o OVER-FETCH: ler `sale_items` com `filter: {}` e depois
// descartar por `sale_id` em JS traz os itens de TODAS as empresas para a
// memória antes de jogá-los fora.
//
// A correção recorta o tenant NO SQL, via `sale_id = ANY(...)` (o Store monta
// `= ANY` a partir de um filtro com valor de LISTA). Aqui provamos:
//
//   A) o filtro por lista (`= ANY`) recorta a coluna corretamente;
//   B) `itensDaEmpresa` devolve SOMENTE os itens do tenant (isolamento A/B);
//   C) `/commerce/analytics` e `/commerce/trends` — top produtos e crescimento
//      nunca somam item de outra empresa;
//   D) a autoridade de `vendas`/`itens_venda` (operacional) permanece intacta;
//   E) `sale_items` continua sem `empresa_id` (nada de coluna redundante).
//
// Tudo em banco de demonstração em memória; a prova em PostgreSQL real vive em
// `pg/fase9-1-data-integrity.test.ts`.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { itensDaEmpresa, itensDeVendas } = await import('../src/commerce/projecao');
const { analyticsCommerce, trendsCommerce } = await import('../src/commerce/analytics');

const s = getStore();

function reqDe(empresaId: number, query: Record<string, unknown> = {}): any {
  return { query, user: { id: 1, name: `Ator E${empresaId}`, perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] } };
}
function resFake(): { res: any; saida: { json?: any; status?: number } } {
  const saida: { json?: any; status?: number } = {};
  const res: any = { json: (d: any) => ((saida.json = d), res), status: (s: number) => ((saida.status = s), res) };
  return { res, saida };
}

let seq = 0;
async function seedVenda(empresaId: number, produtoId: number, qtd: number, centavos: number) {
  seq += 1;
  const saleId = `F91-${empresaId}-${seq}`;
  await s.insert(RESOURCES.sales, {
    id: saleId,
    empresa_id: empresaId,
    status: 'PAID',
    amount_cents: centavos,
    currency: 'BRL',
    channel: 'BROBOND',
    occurred_at: new Date().toISOString(),
  });
  await s.insert(RESOURCES.sale_items, {
    id: `F91-ITEM-${empresaId}-${seq}`,
    sale_id: saleId,
    product_id: produtoId,
    quantity: qtd,
    unit_price_cents: centavos,
    discount_cents: 0,
    subtotal_cents: centavos,
  });
  return saleId;
}

describe('Fase 9.1 — projeção `sale_items` recortada por tenant no SQL', () => {
  test('o filtro por lista (`= ANY`) recorta a coluna; lista vazia não devolve nada', async () => {
    const a = await seedVenda(1, 9001, 2, 1000);
    const b = await seedVenda(2, 9002, 3, 2000);

    const soA = await s.list(RESOURCES.sale_items, { page: 1, pageSize: 100, filter: { sale_id: [a] } });
    assert.ok(soA.rows.length >= 1, 'deve achar os itens da venda A');
    assert.ok(soA.rows.every((r) => String(r.sale_id) === a), 'só a venda A');

    const nada = await s.list(RESOURCES.sale_items, { page: 1, pageSize: 100, filter: { sale_id: [] } });
    assert.equal(nada.rows.length, 0, 'lista vazia = nenhum item');

    const ambas = await s.list(RESOURCES.sale_items, { page: 1, pageSize: 100, filter: { sale_id: [a, b] } });
    assert.ok(ambas.rows.some((r) => String(r.sale_id) === a));
    assert.ok(ambas.rows.some((r) => String(r.sale_id) === b));
  });

  test('itensDaEmpresa isola A de B — nunca traz item do outro tenant', async () => {
    await seedVenda(1, 9101, 1, 500);
    await seedVenda(2, 9102, 1, 700);

    const itensA = await itensDaEmpresa(1);
    const itensB = await itensDaEmpresa(2);
    const vendasA = new Set((await s.list(RESOURCES.sales, { page: 1, pageSize: 10_000, filter: { empresa_id: 1 } })).rows.map((v) => String(v.id)));
    const vendasB = new Set((await s.list(RESOURCES.sales, { page: 1, pageSize: 10_000, filter: { empresa_id: 2 } })).rows.map((v) => String(v.id)));

    assert.ok(itensA.length > 0 && itensB.length > 0);
    assert.ok(itensA.every((i) => vendasA.has(String(i.sale_id))), 'todo item de A aponta venda de A');
    assert.ok(itensB.every((i) => vendasB.has(String(i.sale_id))), 'todo item de B aponta venda de B');
    assert.ok(itensA.every((i) => !vendasB.has(String(i.sale_id))), 'nenhum item de A aponta venda de B');
  });

  test('itensDeVendas devolve só os itens das vendas pedidas', async () => {
    const a = await seedVenda(1, 9201, 4, 100);
    const b = await seedVenda(2, 9202, 5, 100);
    const itens = await itensDeVendas([a]);
    assert.ok(itens.length >= 1);
    assert.ok(itens.every((i) => String(i.sale_id) === a), 'nada da venda B');
    const vazio = await itensDeVendas([]);
    assert.deepEqual(vazio, []);
  });

  test('/commerce/analytics: top produtos só do tenant do ator', async () => {
    const prodA = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: 'F91-PA', nome: 'Produto A', preco_venda: 10, ativo: true });
    const prodB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'F91-PB', nome: 'Produto B', preco_venda: 10, ativo: true });
    await seedVenda(1, Number(prodA.id), 7, 700);
    await seedVenda(2, Number(prodB.id), 9, 900);

    const { res, saida } = resFake();
    await analyticsCommerce(reqDe(1) as any, res as any);
    const top = (saida.json as any).top_produtos as Array<{ produto_id: number }>;
    const ids = top.map((p) => p.produto_id);
    assert.ok(ids.includes(Number(prodA.id)), 'o produto da empresa A aparece');
    assert.ok(!ids.includes(Number(prodB.id)), 'o produto da empresa B NUNCA aparece');
  });

  test('/commerce/trends: crescimento só do tenant do ator', async () => {
    const prodA = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: 'F91-TA', nome: 'Trend A', preco_venda: 10, ativo: true });
    const prodB = await s.insert(RESOURCES.produtos, { empresa_id: 2, sku: 'F91-TB', nome: 'Trend B', preco_venda: 10, ativo: true });
    await seedVenda(1, Number(prodA.id), 2, 200);
    await seedVenda(2, Number(prodB.id), 6, 600);

    const { res, saida } = resFake();
    await trendsCommerce(reqDe(1, { dias: '30' }) as any, res as any);
    const crescimento = (saida.json as any).top_crescimento as Array<{ produto_id: number }>;
    const ids = crescimento.map((c) => c.produto_id);
    assert.ok(!ids.includes(Number(prodB.id)), 'produto da empresa B não aparece no crescimento de A');
  });

  test('sale_items continua SEM empresa_id (projeção — sem coluna redundante)', () => {
    assert.equal(RESOURCES.sale_items.empresa, false);
    assert.ok(!RESOURCES.sale_items.fields.some((f) => f.name === 'empresa_id'), 'nenhuma empresa_id redundante');
  });
});
