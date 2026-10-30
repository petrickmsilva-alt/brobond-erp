import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('Closure procurement exige PostgreSQL real');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate(); const q = pool!;
const cc = await import('../../src/cotacoesCompra'); const compras = await import('../../src/compras'); const financeiro = await import('../../src/financeiro');
const { reqDe, resFake } = await import('../_p1util');
async function fixture() {
  const ref = `closure-quote-${randomUUID().slice(0, 12)}`;
  const company = Number((await q.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [ref])).rows[0].id);
  const user = Number((await q.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES($1,$2,'admin',true,$3) RETURNING id", [ref, `${ref}@example.invalid`, company])).rows[0].id);
  const account = Number((await q.query("INSERT INTO contas_financeiras(empresa_id,nome,tipo) VALUES($1,$2,'banco') RETURNING id", [company, ref])).rows[0].id);
  await q.query("INSERT INTO locais(empresa_id,nome,tipo,padrao,ativo) VALUES($1,'loja','loja',true,true)", [company]);
  const supplier = Number((await q.query("INSERT INTO fornecedores(empresa_id,nome,ativo) VALUES($1,'Fornecedor',true) RETURNING id", [company])).rows[0].id);
  const supply = Number((await q.query("INSERT INTO insumos(empresa_id,nome,unidade,custo_medio,ativo) VALUES($1,'Insumo','un',0,true) RETURNING id", [company])).rows[0].id);
  const quote = Number((await q.query("INSERT INTO cotacoes_compra(empresa_id,titulo,status,criterio) VALUES($1,$2,'rascunho','menor_preco_total') RETURNING id", [company, ref])).rows[0].id);
  return { company, account, supplier, supply, quote, actor: { id: user, name: ref, perfil: 'admin' as const, empresa_id: company, empresas: [company] } };
}
async function call(fn: (req: any, res: any) => Promise<any>, f: Awaited<ReturnType<typeof fixture>>, body: object, id: number = f.quote, actor = f.actor) {
  const { res, saida } = resFake(); await fn(reqDe(body, { params: { id }, user: actor }), res); return { status: saida.status, body: saida.json as any };
}

test('PG compras: cotação → pedido → aprovação → estoque/custo → AP → baixa, com frete e replay', async () => {
  const f = await fixture();
  const item = await call(cc.criarItemCotacao, f, { insumo_id: f.supply, quantidade: 2 });
  assert.equal(item.status, 201);
  await call(cc.convidarFornecedores, f, { fornecedor_ids: [f.supplier] });
  const invite = (await q.query('SELECT id FROM cotacao_compra_fornecedores WHERE empresa_id=$1 AND cotacao_id=$2', [f.company, f.quote])).rows[0];
  await call(cc.cotarFornecedor, f, { convite_id: invite.id, frete: 7, precos: [{ item_id: item.body.id, preco_unitario: 4 }] });
  const decision = await call(cc.decidirCotacaoCompra, f, { criterio: 'menor_preco_total' });
  assert.equal(decision.status, 201); assert.equal(decision.body.total, 15);
  const replay = await call(cc.decidirCotacaoCompra, f, { criterio: 'menor_preco_total' });
  assert.equal(replay.status, 200); assert.equal(replay.body.compra_id, decision.body.compra_id);
  const purchase = Number(decision.body.compra_id);
  const dbPurchase = (await q.query('SELECT fornecedor_id,total,frete,status FROM compras WHERE id=$1', [purchase])).rows[0];
  assert.equal(Number(dbPurchase.total), 15); assert.equal(Number(dbPurchase.frete), 7); assert.equal(Number(dbPurchase.fornecedor_id), f.supplier);
  await call(compras.aprovarCompra, f, {}, purchase);
  const purchaseItem = (await q.query('SELECT id FROM itens_compra WHERE empresa_id=$1 AND compra_id=$2', [f.company, purchase])).rows[0];
  const receive = await call(compras.receberParcial, f, { itens: [{ item_compra_id: purchaseItem.id, quantidade: 2 }], idempotency_key: 'closure-quotation-receipt' }, purchase);
  assert.equal(receive.status, 201); assert.equal(receive.body.status, 'recebido');
  const receivedAgain = await call(compras.receberParcial, f, { itens: [{ item_compra_id: purchaseItem.id, quantidade: 2 }], idempotency_key: 'closure-quotation-receipt' }, purchase);
  assert.equal(receivedAgain.body.idempotente, true);
  const stock = (await q.query('SELECT COALESCE(SUM(quantidade),0) AS n FROM estoque_insumos WHERE empresa_id=$1 AND insumo_id=$2', [f.company, f.supply])).rows[0];
  assert.equal(Number(stock.n), 2);
  const supply = (await q.query('SELECT custo_medio FROM insumos WHERE id=$1', [f.supply])).rows[0]; assert.equal(Number(supply.custo_medio), 7.5);
  const payables = await q.query("SELECT id,valor,status FROM lancamentos_financeiros WHERE empresa_id=$1 AND referencia_tipo='compra' AND referencia_id=$2", [f.company, purchase]);
  assert.equal(payables.rows.length, 1); assert.equal(Number(payables.rows[0].valor), 15); assert.equal(payables.rows[0].status, 'pendente');
  await call(financeiro.baixarLancamento, f, { conta_id: f.account }, Number(payables.rows[0].id));
  assert.equal((await q.query('SELECT status FROM lancamentos_financeiros WHERE id=$1', [payables.rows[0].id])).rows[0].status, 'confirmado');
  assert.equal((await q.query('SELECT fin_status FROM compras WHERE id=$1', [purchase])).rows[0].fin_status, 'pago');
  const outsider = await fixture();
  await assert.rejects(() => call(cc.comparativoCotacao, f, {}, f.quote, outsider.actor), (e: any) => e.status === 404);
});

test('PG cotação: item da página posterior sem preço bloqueia decisão e pedido parcial', async () => {
  const f = await fixture();
  await q.query("UPDATE cotacoes_compra SET status='cotando' WHERE id=$1", [f.quote]);
  await q.query("INSERT INTO cotacao_compra_itens(empresa_id,cotacao_id,insumo_id,quantidade,unidade) SELECT $1,$2,$3,1,'un' FROM generate_series(1,501)", [f.company, f.quote, f.supply]);
  const invite = (await q.query("INSERT INTO cotacao_compra_fornecedores(empresa_id,cotacao_id,fornecedor_id,status,frete) VALUES($1,$2,$3,'cotado',0) RETURNING id", [f.company, f.quote, f.supplier])).rows[0];
  await q.query('INSERT INTO cotacao_compra_precos(empresa_id,convite_id,item_id,preco_unitario) SELECT $1,$2,id,5 FROM cotacao_compra_itens WHERE empresa_id=$1 AND cotacao_id=$3 ORDER BY id LIMIT 500', [f.company, invite.id, f.quote]);
  const comp = await call(cc.comparativoCotacao, f, {}); assert.equal(comp.body.resumo.itens, 501); assert.equal(comp.body.resumo.itens_sem_cotacao, 1);
  await assert.rejects(() => call(cc.decidirCotacaoCompra, f, { criterio: 'menor_preco_total' }), (e: any) => e.status === 409);
  const row = (await q.query('SELECT status,compra_id FROM cotacoes_compra WHERE id=$1', [f.quote])).rows[0];
  assert.equal(row.status, 'cotando'); assert.equal(row.compra_id, null);
  assert.equal(Number((await q.query('SELECT count(*) FROM compras WHERE empresa_id=$1', [f.company])).rows[0].count), 0);
});

test('PG cotação: decisões simultâneas geram uma compra; replay alterado e legado sem assinatura são recusados', async () => {
  const f = await fixture(); const item = await call(cc.criarItemCotacao, f, { insumo_id: f.supply, quantidade: 1 });
  await call(cc.convidarFornecedores, f, { fornecedor_ids: [f.supplier] });
  const invite = (await q.query('SELECT id FROM cotacao_compra_fornecedores WHERE empresa_id=$1 AND cotacao_id=$2', [f.company, f.quote])).rows[0];
  await call(cc.cotarFornecedor, f, { convite_id: invite.id, frete: 1, precos: [{ item_id: item.body.id, preco_unitario: 9 }] });
  const body = { criterio: 'menor_preco_total', observacoes: 'Decisão conferida' };
  const results = await Promise.allSettled([call(cc.decidirCotacaoCompra, f, body), call(cc.decidirCotacaoCompra, f, body)]);
  const successes = results.filter((r) => r.status === 'fulfilled'); assert.ok(successes.length >= 1);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.status, 409);
  const decisions = await q.query('SELECT compra_id,decisao_hash FROM cotacoes_compra WHERE id=$1', [f.quote]);
  const pid = Number(decisions.rows[0].compra_id); assert.match(decisions.rows[0].decisao_hash, /^[a-f0-9]{64}$/);
  assert.equal(Number((await q.query('SELECT count(*) FROM compras WHERE empresa_id=$1', [f.company])).rows[0].count), 1);
  const replay = await call(cc.decidirCotacaoCompra, f, body); assert.equal(replay.body.idempotente, true); assert.equal(replay.body.compra_id, pid);
  await assert.rejects(() => call(cc.decidirCotacaoCompra, f, { ...body, observacoes: 'Outro conteúdo' }), (e: any) => e.status === 409);
  await q.query('UPDATE cotacoes_compra SET decisao_hash=NULL WHERE id=$1', [f.quote]);
  await assert.rejects(() => call(cc.decidirCotacaoCompra, f, body), (e: any) => e.status === 409 && /histórica/.test(e.message));
  await assert.rejects(() => q.query("UPDATE cotacoes_compra SET decisao_hash='errado' WHERE id=$1", [f.quote]), (e: any) => e.code === '23514');
});
