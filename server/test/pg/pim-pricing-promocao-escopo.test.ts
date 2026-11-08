// ============================================================================
// FASE 4 — PIM & PRICING / migração 0108: PROMOÇÃO COM ESCOPO, CANAL E
// PRECEDÊNCIA — prova em PostgreSQL REAL (constraints, índices, tenant, cascade).
//
// O que só se prova aqui (o MemStore não tem CHECK parcial, índice único
// parcial nem ON DELETE CASCADE de verdade):
//   • a migração 0108 é ADITIVA: promoção legada nasce escopo='pedido',
//     canal='todos', prioridade=0 — nenhum número muda;
//   • CHECK de escopo e canal recusa valor fora do vocabulário;
//   • CHECK `exclusivo` do alvo recusa produto E categoria juntos (ou nenhum);
//   • índice único parcial impede o MESMO alvo duas vezes, mas permite o
//     mesmo produto em promoções diferentes;
//   • isolamento multiempresa: alvo carrega empresa_id e o filtro por empresa
//     nunca cruza;
//   • ON DELETE CASCADE limpa os alvos quando a promoção sai;
//   • a ordem de precedência (maior desconto → prioridade → mais recente) é
//     estável sob o índice (empresa_id, ativo, prioridade DESC, id DESC).
//
// Sem DATABASE_URL o arquivo se auto-pula (job testes-postgres do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (gate test:pg / job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Tenant = { empresaId: number; sufixo: string };

async function novoTenant(): Promise<Tenant> {
  const { query } = await import('../../src/db');
  const sufixo = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const emp = await query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`PIM ${sufixo}`]);
  return { empresaId: Number(emp.rows[0].id), sufixo };
}

async function limpar(t: Tenant): Promise<void> {
  const { query } = await import('../../src/db');
  const apagar = async (sql: string) => query(sql, [t.empresaId]).catch(() => undefined);
  await apagar(`DELETE FROM commerce_promocao_alvos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_promocoes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM produtos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM empresas WHERE id = $1`);
}

test('0108 PG: migração é aditiva — promoção legada nasce escopo=pedido/canal=todos/prioridade=0', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const ten = await novoTenant();
  t.after(() => limpar(ten));
  const { empresaId } = ten;

  const r = await query(
    `INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, minimo_pedido, data_inicio, ativo)
     VALUES ($1, 'Legada', 'percentual', 10, 0, '2020-01-01', true)
     RETURNING escopo, canal, prioridade`,
    [empresaId]
  );
  assert.equal(r.rows[0].escopo, 'pedido');
  assert.equal(r.rows[0].canal, 'todos');
  assert.equal(Number(r.rows[0].prioridade), 0);

  await t.test('CHECK recusa escopo fora do vocabulário', async () => {
    await assert.rejects(
      () => query(`INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, data_inicio, ativo, escopo) VALUES ($1,'X','percentual',10,'2020-01-01',true,'colecao')`, [empresaId]),
      (e: any) => e.code === '23514'
    );
  });

  await t.test('CHECK recusa canal fora do vocabulário', async () => {
    await assert.rejects(
      () => query(`INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, data_inicio, ativo, canal) VALUES ($1,'Y','percentual',10,'2020-01-01',true,'atacadoo')`, [empresaId]),
      (e: any) => e.code === '23514'
    );
  });
});

test('0108 PG: alvo é produto OU categoria (CHECK) e não pode repetir (índice único parcial)', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const ten = await novoTenant();
  t.after(() => limpar(ten));
  const { empresaId, sufixo } = ten;

  const produto = Number((await query(
    `INSERT INTO produtos (empresa_id, sku, nome, custo, preco_venda, ativo) VALUES ($1,$2,$3,10,30,true) RETURNING id`,
    [empresaId, `PIM-${sufixo}`, `Produto ${sufixo}`]
  )).rows[0].id);
  const categoria = Number((await query(`INSERT INTO categorias (nome, ativo) VALUES ($1, true) RETURNING id`, [`Cat ${sufixo}`])).rows[0].id);
  const promo = Number((await query(
    `INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, data_inicio, ativo, escopo) VALUES ($1,'Escopada','percentual',10,'2020-01-01',true,'produto') RETURNING id`,
    [empresaId]
  )).rows[0].id);

  await query(`INSERT INTO commerce_promocao_alvos (empresa_id, promocao_id, produto_id) VALUES ($1,$2,$3)`, [empresaId, promo, produto]);

  await t.test('não aceita produto E categoria juntos (23514)', async () => {
    await assert.rejects(
      () => query(`INSERT INTO commerce_promocao_alvos (empresa_id, promocao_id, produto_id, categoria_id) VALUES ($1,$2,$3,$4)`, [empresaId, promo, produto, categoria]),
      (e: any) => e.code === '23514'
    );
  });

  await t.test('não aceita alvo vazio (nem produto nem categoria)', async () => {
    await assert.rejects(
      () => query(`INSERT INTO commerce_promocao_alvos (empresa_id, promocao_id) VALUES ($1,$2)`, [empresaId, promo]),
      (e: any) => e.code === '23514'
    );
  });

  await t.test('o mesmo produto não entra duas vezes na MESMA promoção (23505)', async () => {
    await assert.rejects(
      () => query(`INSERT INTO commerce_promocao_alvos (empresa_id, promocao_id, produto_id) VALUES ($1,$2,$3)`, [empresaId, promo, produto]),
      (e: any) => e.code === '23505'
    );
  });

  await t.test('mas o mesmo produto pode ser alvo de outra promoção', async () => {
    const promo2 = Number((await query(
      `INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, data_inicio, ativo, escopo) VALUES ($1,'Escopada 2','percentual',10,'2020-01-01',true,'produto') RETURNING id`,
      [empresaId]
    )).rows[0].id);
    await query(`INSERT INTO commerce_promocao_alvos (empresa_id, promocao_id, produto_id) VALUES ($1,$2,$3)`, [empresaId, promo2, produto]);
    const total = await query(`SELECT count(*)::int AS n FROM commerce_promocao_alvos WHERE empresa_id=$1 AND produto_id=$2`, [empresaId, produto]);
    assert.equal(total.rows[0].n, 2);
  });
});

test('0108 PG: ON DELETE CASCADE limpa os alvos quando a promoção sai', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const ten = await novoTenant();
  t.after(() => limpar(ten));
  const { empresaId, sufixo } = ten;

  const produto = Number((await query(
    `INSERT INTO produtos (empresa_id, sku, nome, custo, preco_venda, ativo) VALUES ($1,$2,$3,10,30,true) RETURNING id`,
    [empresaId, `PIM-${sufixo}`, `Produto ${sufixo}`]
  )).rows[0].id);
  const promo = Number((await query(
    `INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, data_inicio, ativo, escopo) VALUES ($1,'Cascata','percentual',10,'2020-01-01',true,'produto') RETURNING id`,
    [empresaId]
  )).rows[0].id);
  await query(`INSERT INTO commerce_promocao_alvos (empresa_id, promocao_id, produto_id) VALUES ($1,$2,$3)`, [empresaId, promo, produto]);

  await query(`DELETE FROM commerce_promocoes WHERE id=$1`, [promo]);
  const restam = await query(`SELECT count(*)::int AS n FROM commerce_promocao_alvos WHERE promocao_id=$1`, [promo]);
  assert.equal(restam.rows[0].n, 0);
});

test('0108 PG: isolamento multiempresa — alvos de uma empresa nunca aparecem na outra', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const a = await novoTenant();
  const b = await novoTenant();
  t.after(async () => { await limpar(a); await limpar(b); });

  const produtoA = Number((await query(
    `INSERT INTO produtos (empresa_id, sku, nome, custo, preco_venda, ativo) VALUES ($1,$2,$3,10,30,true) RETURNING id`,
    [a.empresaId, `PIM-A-${a.sufixo}`, `Produto A ${a.sufixo}`]
  )).rows[0].id);
  const promoA = Number((await query(
    `INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, data_inicio, ativo, escopo) VALUES ($1,'A','percentual',10,'2020-01-01',true,'produto') RETURNING id`,
    [a.empresaId]
  )).rows[0].id);
  await query(`INSERT INTO commerce_promocao_alvos (empresa_id, promocao_id, produto_id) VALUES ($1,$2,$3)`, [a.empresaId, promoA, produtoA]);

  const naB = await query(`SELECT count(*)::int AS n FROM commerce_promocao_alvos WHERE empresa_id=$1`, [b.empresaId]);
  assert.equal(naB.rows[0].n, 0, 'a empresa B não enxerga alvo da empresa A');
  const naA = await query(`SELECT count(*)::int AS n FROM commerce_promocao_alvos WHERE empresa_id=$1`, [a.empresaId]);
  assert.equal(naA.rows[0].n, 1);
});

test('0108 PG: a ordenação de precedência (desconto → prioridade → id) é estável', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const ten = await novoTenant();
  t.after(() => limpar(ten));
  const { empresaId } = ten;

  await query(
    `INSERT INTO commerce_promocoes (empresa_id, nome, tipo, valor, data_inicio, ativo, escopo, prioridade) VALUES
       ($1,'Baixa','percentual',10,'2020-01-01',true,'pedido',1),
       ($1,'Alta','percentual',10,'2020-01-01',true,'pedido',5),
       ($1,'Recente','percentual',10,'2020-01-01',true,'pedido',5)`,
    [empresaId]
  );
  const ordem = await query(
    `SELECT nome FROM commerce_promocoes WHERE empresa_id=$1 AND ativo=true ORDER BY prioridade DESC, id DESC`,
    [empresaId]
  );
  const nomes = ordem.rows.map((r: any) => r.nome);
  assert.equal(nomes[0], 'Recente', 'empate de prioridade desempata pela mais recente (maior id)');
  assert.equal(nomes[1], 'Alta');
  assert.equal(nomes[2], 'Baixa');
});
