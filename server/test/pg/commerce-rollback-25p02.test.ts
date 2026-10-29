// ============================================================================
// BROBOND COMMERCE OS — REGRESSÃO 25P02 (POSTGRESQL REAL)
// ----------------------------------------------------------------------------
// Especificação: docs/RELATORIO-HOMOLOGACAO-FINAL-ERP-3.0.md §28 —
// "venda com erro de SQL no meio da transação → ROLLBACK → reserva, pedido e
// venda permanecem CONSISTENTES" (nenhum registro parcial, nenhum estoque
// corrompido, estado da venda inalterado).
//
// O que só se prova aqui (o MemStore não executa SQL de verdade):
//   (a) 23505 REAL do PostgreSQL estourando no MEIO da conversão
//       (reserva + pedido + update da venda) → rollback total e o erro
//       original 23505 se propaga SEM ser mascarado;
//   (b) erro de negócio REAL (HttpError 409 do motor canônico de reserva por
//       saldo insuficiente) no MEIO da conversão → rollback total e o 409 se
//       propaga ao chamador;
//   (c) controle positivo: o CAMINHO FELIZ da mesma transação persiste tudo
//       (garante que (a)/(b) não são provas vazias).
//
// Sem DATABASE_URL o arquivo FALHA honestamente (o gate test:pg — que exige
// 0 skips — sempre fornece DATABASE_URL; ver scripts/test-pg-gate.mjs).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL) {
  throw new Error('commerce-rollback-25p02.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova (POSTGRES_INFRASTRUCTURE_BLOCKED no gate).');
}

process.env.NODE_ENV = 'test';

const { migrate, query, withTransaction } = await import('../../src/db');
await migrate();

const RODADA = `25p02${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 24);
let contador = 0;
const unico = (p: string) => `${p}-${RODADA}-${++contador}`;

type Tenant = { empresaId: number; ator: { id: number }; sufixo: string };

async function novoTenant(): Promise<Tenant> {
  const sufixo = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const emp = await query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`25P02 ${sufixo}`]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, 'admin', $3, true) RETURNING id`,
    [`25P02 ${sufixo}`, `p25-${sufixo.toLowerCase()}@example.test`, empresaId]
  );
  return { empresaId, ator: { id: Number(usr.rows[0].id) }, sufixo };
}

async function limpar(t: Tenant): Promise<void> {
  const apagar = async (sql: string, params: unknown[] = [t.empresaId]) => query(sql, params).catch(() => undefined);
  await apagar(`DELETE FROM estoque_reservas WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_pedidos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM sale_items WHERE sale_id IN (SELECT s.id FROM sales s WHERE s.empresa_id = $1)`);
  await apagar(`DELETE FROM sales WHERE empresa_id = $1`);
  await apagar(`DELETE FROM estoques WHERE empresa_id = $1`);
  await apagar(`DELETE FROM movimentacoes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM produtos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM usuarios WHERE empresa_id = $1`);
  await apagar(`DELETE FROM empresas WHERE id = $1`);
}

const eh23505 = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';
const eh409 = (e: any) => Number(e?.status) === 409;

interface Fixture {
  t: Tenant;
  produtoId: number;
  saleId: string;
  externo: string;
  snapshot: () => Promise<{ pedidos: number; reservas: number; estoque: any; sale: any }>;
}

async function fixture(nome: string): Promise<Fixture> {
  const { novoProduto, saldoInicial } = await import('../_p1util');
  const t = await novoTenant();
  const produto = await novoProduto({ sku: unico(nome), empresa_id: t.empresaId, ativo: true });
  await saldoInicial(produto, 5);
  const saleId = `sale-p25-${t.sufixo}-${nome}`;
  const externo = `P25-${t.sufixo}-${nome}`;
  await query(
    `INSERT INTO sales (id, reference, quantity, amount_cents, currency, status, channel, external_order_id, usuario_id, empresa_id)
     VALUES ($1, $1, 1, 12990, 'BRL', 'PENDING', 'BROBOND', $2, $3, $4)`,
    [saleId, externo, t.ator.id, t.empresaId]
  );
  const snapshot = async () => ({
    pedidos: Number((await query(`SELECT COUNT(*)::int AS n FROM commerce_pedidos WHERE empresa_id = $1`, [t.empresaId])).rows[0].n),
    reservas: Number((await query(`SELECT COUNT(*)::int AS n FROM estoque_reservas WHERE empresa_id = $1`, [t.empresaId])).rows[0].n),
    estoque: (await query(`SELECT * FROM estoques WHERE empresa_id = $1 AND produto_id = $2`, [t.empresaId, produto.id])).rows[0],
    sale: (await query(`SELECT status, amount_cents FROM sales WHERE id = $1`, [saleId])).rows[0],
  });
  return { t, produtoId: Number(produto.id), saleId, externo, snapshot };
}

/** Conversão completa no formato do fluxo real (pedido + reserva + venda), dentro de UMA transação. */
async function converterEmTx(f: Fixture, opcoes: { quantidade?: number; inserirPedidoDuplicado?: boolean } = {}) {
  const { withTransaction: wt, query: q } = await import('../../src/db');
  const { garantirPedidoDaSale } = await import('../../src/commerce/pedidos');
  const { ORIGEM_CHECKOUT } = await import('../../src/commerce/pedidos');
  const { criarReservaInterna } = await import('../../src/estoqueTransferencia');
  const { escopoDeSistema } = await import('../../src/empresa');
  const escopo = escopoDeSistema(f.t.empresaId);
  return wt(async (client) => {
    const sale = (await client.query(`SELECT * FROM sales WHERE id = $1`, [f.saleId])).rows[0];
    const pedido = await garantirPedidoDaSale(f.t.empresaId, sale as any, client as any);
    await criarReservaInterna(
      escopo,
      {
        produto_id: f.produtoId,
        quantidade: opcoes.quantidade ?? 1,
        tipo: 'reserva',
        origem_recurso: ORIGEM_CHECKOUT,
        origem_id: Number((pedido as any).id),
        motivo: '25P02 rollback',
        criado_por: f.t.ator.id,
      },
      client as any
    );
    await client.query(`UPDATE sales SET status = 'PAID' WHERE id = $1`, [f.saleId]);
    if (opcoes.inserirPedidoDuplicado) {
      // Viola o índice único (empresa, canal, pedido_externo) — 23505 REAL
      // (mesmo pedido_externo que garantirPedidoDaSale acabou de gravar).
      await client.query(
        `INSERT INTO commerce_pedidos (empresa_id, canal, pedido_externo, estado) VALUES ($1, 'BROBOND', $2, 'AGUARDANDO_PAGAMENTO')`,
        [f.t.empresaId, f.externo]
      );
    }
    return pedido;
  }, 'serializable');
}

// ---------------------------------------------------------------------------
// (a) erro SQL real (23505) no meio da conversão
// ---------------------------------------------------------------------------
test('25P02(a): erro SQL 23505 no meio da conversão → ROLLBACK total (pedido/reserva/venda consistentes)', async () => {
  const f = await fixture('A');
  try {
    const antes = await f.snapshot();
    assert.equal(antes.pedidos, 0, 'partida limpa');
    assert.equal(antes.reservas, 0, 'partida limpa');

    const erro = await converterEmTx(f, { inserirPedidoDuplicado: true }).then(
      () => null,
      (e) => e
    );
    assert.ok(erro, 'a transação FALHOU');
    assert.ok(eh23505(erro), `esperava 23505 do PostgreSQL, veio: ${erro?.code ?? erro}`);

    const depois = await f.snapshot();
    assert.equal(depois.pedidos, 0, 'pedido do rollback não persiste');
    assert.equal(depois.reservas, 0, 'reserva do rollback não persiste');
    assert.deepEqual(depois.estoque, antes.estoque, 'estoque byte a byte idêntico');
    assert.deepEqual(depois.sale, antes.sale, 'venda permanece PENDING (o UPDATE da tx foi desfeito)');
  } finally {
    await limpar(f.t);
  }
});

// ---------------------------------------------------------------------------
// (b) erro de negócio real (409 do motor de reserva) no meio da conversão
// ---------------------------------------------------------------------------
test('25P02(b): HttpError 409 REAL (saldo insuficiente) no meio → ROLLBACK total e o erro se propaga', async () => {
  const f = await fixture('B');
  try {
    const antes = await f.snapshot();
    assert.equal(antes.pedidos, 0);

    // O pedido é criado ANTES da reserva — se não houvesse rollback, ficaria
    // órfão. A reserva com saldo insuficiente (5) estoura 409 no meio da tx.
    const erro = await converterEmTx(f, { quantidade: 999 }).then(
      () => null,
      (e) => e
    );
    assert.ok(erro, 'a transação FALHOU');
    assert.ok(eh409(erro), `esperava HttpError 409 do motor de reserva, veio: ${erro?.status ?? erro?.code ?? erro}`);

    const depois = await f.snapshot();
    assert.equal(depois.pedidos, 0, 'pedido órfão NÃO persiste (rollback)');
    assert.equal(depois.reservas, 0, 'nenhuma reserva parcial');
    assert.deepEqual(depois.estoque, antes.estoque, 'estoque inalterado');
    assert.deepEqual(depois.sale, antes.sale, 'venda permanece PENDING');
  } finally {
    await limpar(f.t);
  }
});

// ---------------------------------------------------------------------------
// (c) controle positivo — o caminho feliz da MESMA transação persiste
// ---------------------------------------------------------------------------
test('25P02(c): controle — caminho feliz da mesma transação persiste pedido + reserva + venda', async () => {
  const f = await fixture('C');
  try {
    const antes = await f.snapshot();
    assert.equal(antes.pedidos, 0);
    assert.equal(antes.reservas, 0);

    const pedido = await converterEmTx(f);
    assert.ok((pedido as any).id, 'pedido criado');

    const depois = await f.snapshot();
    assert.equal(depois.pedidos, 1, 'pedido persistido');
    assert.equal(depois.reservas, 1, 'reserva persistida (ativa)');
    assert.equal(String(depois.sale.status), 'PAID', 'venda persistida como paga');
    // O hold canônico NÃO altera a linha física de estoques (mesma semântica de
    // liberarReservaInterna); o efeito é a reserva ativa — e o disponível
    // calculado cai de 5 para 4.
    const { getStore } = await import('../../src/services');
    const { calcularDisponibilidade } = await import('../../src/estoqueTransferencia');
    const { escopoDeSistema } = await import('../../src/empresa');
    const linha = await calcularDisponibilidade(getStore(), escopoDeSistema(f.t.empresaId), { produto_id: f.produtoId }, undefined as any);
    const disponivel = linha.reduce((t: number, l: any) => t + Number(l.disponivel), 0);
    assert.equal(disponivel, 4, 'reserva ativa reduz o disponível de 5 → 4 (a tx realmente persistiu efeito)');
  } finally {
    await limpar(f.t);
  }
});
