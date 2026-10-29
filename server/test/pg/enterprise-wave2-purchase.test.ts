import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.env.DATABASE_URL) throw new Error('Wave 2 procurement requires PostgreSQL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate();
const { receberParcial } = await import('../../src/compras');
const { reqDe, resFake } = await import('../_p1util');
async function fixture(prefix: string, quantity = 10) {
  const suffix = randomUUID().slice(0, 8); const q = pool!;
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`${prefix}-${suffix}`])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Comprador',$1,'admin',true,$2) RETURNING id", [`p-${suffix}@example.invalid`, company])).rows[0].id);
  await q.query("INSERT INTO locais(empresa_id,nome,tipo,ativo,padrao) VALUES($1,'loja','loja',true,true)", [company]);
  const supplier = Number((await q.query("INSERT INTO fornecedores(empresa_id,nome,ativo) VALUES($1,'Fornecedor',true) RETURNING id", [company])).rows[0].id);
  const supply = Number((await q.query("INSERT INTO insumos(empresa_id,nome,unidade,custo_medio,ativo) VALUES($1,'Tecido','m',0,true) RETURNING id", [company])).rows[0].id);
  const purchase = Number((await q.query("INSERT INTO compras(empresa_id,fornecedor_id,data,status,total,frete) VALUES($1,$2,CURRENT_DATE,'aprovado',$3,0) RETURNING id", [company, supplier, quantity * 10])).rows[0].id);
  const item = Number((await q.query('INSERT INTO itens_compra(empresa_id,compra_id,insumo_id,quantidade,quantidade_recebida,preco_unitario) VALUES($1,$2,$3,$4,0,10) RETURNING id', [company, purchase, supply, quantity])).rows[0].id);
  return { company, user, supplier, supply, purchase, item, actor: { id: user, name: 'Comprador', perfil: 'admin' as const, empresa_id: company, empresas: [company] } };
}
async function receive(f: Awaited<ReturnType<typeof fixture>>, quantity: number, key: string, actor = f.actor) {
  const { res, saida } = resFake();
  await receberParcial(reqDe({ itens: [{ item_compra_id: f.item, quantidade: quantity }], idempotency_key: key }, { params: { id: f.purchase }, user: actor }) as any, res);
  return { status: saida.status, body: saida.json as any };
}

test('PG procurement: replay após total, chave longa sem colisão, CAS e estoque/contas a pagar únicos', async () => {
  const f = await fixture('wave2-receipt');
  const a = `${'x'.repeat(70)}-primeiro`; const b = `${'x'.repeat(70)}-segundo`;
  const parallel = await Promise.all(Array.from({ length: 4 }, () => receive(f, 5, a)));
  assert.equal(parallel.filter((r) => r.status === 201).length, 1);
  assert.equal(new Set(parallel.map((r) => r.body.recebimento_id)).size, 1);
  const second = await receive(f, 5, b); assert.equal(second.status, 201); assert.equal(second.body.status, 'recebido');
  const replay = await receive(f, 5, b); assert.equal(replay.status, 200); assert.equal(replay.body.idempotente, true);
  assert.equal(replay.body.recebimento_id, second.body.recebimento_id);
  await assert.rejects(() => receive(f, 4, b), (e: any) => e.status === 409 && /outros dados/.test(e.message));
  const receipts = await pool!.query('SELECT idempotency_key,documento FROM compra_recebimentos WHERE empresa_id=$1 AND compra_id=$2 ORDER BY id', [f.company, f.purchase]);
  assert.equal(receipts.rows.length, 2); assert.notEqual(receipts.rows[0].idempotency_key, receipts.rows[1].idempotency_key);
  assert.equal(receipts.rows[0].documento, receipts.rows[1].documento, 'prefixo truncado não é mais a chave de unicidade');
  const stock = await pool!.query('SELECT COALESCE(SUM(quantidade),0) AS n FROM estoque_insumos WHERE empresa_id=$1 AND insumo_id=$2', [f.company, f.supply]);
  assert.equal(Number(stock.rows[0].n), 10);
  const movements = await pool!.query("SELECT COUNT(*)::int AS n FROM movimentacoes_insumos WHERE empresa_id=$1 AND compra_id=$2 AND tipo='entrada'", [f.company, f.purchase]);
  assert.equal(Number(movements.rows[0].n), 2);
  const payables = await pool!.query("SELECT COUNT(*)::int AS n FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='compra' AND referencia_id=$2", [f.company, f.purchase]);
  assert.equal(Number(payables.rows[0].n), 1);
  const other = await fixture('wave2-other');
  await assert.rejects(() => receive(f, 5, b, other.actor), (e: any) => e.status === 404);
});

test('PG procurement: página posterior impede fechamento prematuro e rateio integral de frete', async () => {
  const f = await fixture('wave2-pages', 1);
  await pool!.query('UPDATE compras SET total=1101.1,frete=100.1 WHERE id=$1', [f.purchase]);
  // Test fixture: 999 previously received, two pending; only the first pending
  // is received here. No claim is made about the historical stock of the fixture.
  await pool!.query('UPDATE itens_compra SET quantidade_recebida=1 WHERE id=$1', [f.item]);
  await pool!.query(`INSERT INTO itens_compra(empresa_id,compra_id,insumo_id,quantidade,quantidade_recebida,preco_unitario)
     SELECT $1,$2,$3,1,CASE WHEN i <= 998 THEN 1 ELSE 0 END,1 FROM generate_series(1,1000) i`, [f.company, f.purchase, f.supply]);
  const pending = await pool!.query('SELECT id FROM itens_compra WHERE empresa_id=$1 AND compra_id=$2 AND quantidade_recebida=0 ORDER BY id', [f.company, f.purchase]);
  assert.equal(pending.rows.length, 2); f.item = Number(pending.rows[0].id);
  const result = await receive(f, 1, 'wave2-page-receipt');
  assert.equal(result.body.status, 'parcial');
  assert.ok(Number(result.body.custos[0].custo_frete_rateado) < 1, 'não rateia o frete integral no lote parcial');
  const purchase = await pool!.query('SELECT status FROM compras WHERE id=$1', [f.purchase]); assert.equal(purchase.rows[0].status, 'parcial');
  const payable = await pool!.query("SELECT COUNT(*)::int AS n FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='compra' AND referencia_id=$2", [f.company, f.purchase]);
  assert.equal(Number(payable.rows[0].n), 0);
});

test('PG procurement: chave legada truncada sem hash é bloqueada para reconciliação', async () => {
  const f = await fixture('wave2-legacy');
  await pool!.query("INSERT INTO compra_recebimentos (empresa_id,compra_id,documento,total) VALUES($1,$2,'legacy-receipt',0)", [f.company, f.purchase]);
  await assert.rejects(() => receive(f, 1, 'legacy-receipt'), (e: any) => e.status === 409 && /histórica/.test(e.message));
  const stock = await pool!.query('SELECT COUNT(*)::int AS n FROM movimentacoes_insumos WHERE empresa_id=$1 AND compra_id=$2', [f.company, f.purchase]);
  assert.equal(Number(stock.rows[0].n), 0);
});


test('PG procurement: três processos repetem o mesmo recebimento com advisory lock e uma única entrada', async () => {
  const f = await fixture('wave2-process');
  const worker = fileURLToPath(new URL('./_purchase-worker.ts', import.meta.url));
  const children = Array.from({ length: 3 }, () => fork(worker, [], {
    execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, WAVE2_PURCHASE_FIXTURE: JSON.stringify(f), PG_IDLE_TIMEOUT: '1000' },
  }));
  try {
    const ready = children.map((child) => new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.on('message', (m: any) => { if (m?.type === 'ready') resolve(); });
      child.once('exit', (code) => { if (code) reject(new Error(`Worker encerrou antes de ficar pronto: ${code}`)); });
    }));
    await Promise.all(ready);
    const results = children.map((child) => new Promise<any>((resolve, reject) => {
      child.on('message', (m: any) => { if (m?.type === 'result') resolve(m); if (m?.type === 'error') reject(new Error(`Worker: ${m.status}`)); });
      child.once('error', reject);
      child.once('exit', (code) => { if (code) reject(new Error(`Worker encerrou: ${code}`)); });
    }));
    children.forEach((child) => child.send('go'));
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter((x) => x.status === 201).length, 1);
    assert.equal(outcomes.filter((x) => x.status === 200 && x.replay).length, 2);
    assert.equal(new Set(outcomes.map((x) => x.id)).size, 1);
    const counts = await pool!.query("SELECT COUNT(*)::int AS n FROM movimentacoes_insumos WHERE empresa_id=$1 AND compra_id=$2 AND tipo='entrada'", [f.company, f.purchase]);
    assert.equal(Number(counts.rows[0].n), 1);
  } finally { children.forEach((child) => { if (child.connected) child.disconnect(); if (!child.killed) child.kill(); }); }
});

test('PG procurement: chave padrão histórica longa é reconhecida pelo prefixo antigo antes de qualquer entrada', async () => {
  const f = await fixture('wave2-legacy-generated');
  const itens = Array.from({ length: 40 }, (_, n) => ({ item_compra_id: 100000 + n, quantidade: 1 }));
  const key = `recebimento:compra:${f.purchase}:${itens.map((l) => `${l.item_compra_id}x${l.quantidade}`).join(',')}`;
  assert.ok(key.length > 160);
  await pool!.query('INSERT INTO compra_recebimentos(empresa_id,compra_id,documento,total) VALUES($1,$2,$3,0)', [f.company, f.purchase, key.slice(0, 60)]);
  const { res } = resFake();
  await assert.rejects(() => receberParcial(reqDe({ itens }, { params: { id: f.purchase }, user: f.actor }) as any, res), (e: any) => e.status === 409 && /histórica/.test(e.message));
  const count = await pool!.query('SELECT COUNT(*)::int AS n FROM movimentacoes_insumos WHERE empresa_id=$1 AND compra_id=$2', [f.company, f.purchase]);
  assert.equal(Number(count.rows[0].n), 0);
});
