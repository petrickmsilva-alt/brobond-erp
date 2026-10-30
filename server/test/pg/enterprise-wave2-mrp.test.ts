import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('Wave 2 requires PostgreSQL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate();
const { getStore, createRecord, lancarMovimentacaoInsumoDaOrdem } = await import('../../src/services');
const { RESOURCES } = await import('../../src/resources');
const { mrpProducao } = await import('../../src/producaoCapacidade');

test('PG MRP: horizonte, consumo por OP, compra sem previsão e isolamento', async () => {
  assert.ok(pool); const suffix = randomUUID().slice(0, 8);
  const company = Number((await pool.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`MRP PG ${suffix}`])).rows[0].id);
  const user = Number((await pool.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('MRP PG',$1,'admin',true,$2) RETURNING id", [`mrp-${suffix}@example.invalid`, company])).rows[0].id);
  const actor = { id: user, name: 'MRP PG', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  const scope = { kind: 'empresa' as const, empresaId: company };
  const create = (resource: any, body: any) => createRecord(resource, body, actor, { escopo: scope });
  const productA = await create(RESOURCES.produtos, { sku: `PGA-${suffix}`, nome: 'Produto A PG', custo: 1, preco_venda: 2 });
  const productB = await create(RESOURCES.produtos, { sku: `PGB-${suffix}`, nome: 'Produto B PG', custo: 1, preco_venda: 2 });
  const size = await create(RESOURCES.tamanhos, { nome: `PG ${suffix}`, codigo: suffix });
  const client = await create(RESOURCES.clientes, { nome: 'Cliente PG MRP', pessoa: 'pf', documento: '52998224725' });
  const raw = await create(RESOURCES.insumos, { nome: `Insumo PG ${suffix}`, unidade: 'm' });
  for (const p of [productA, productB]) {
    const recipe = await create(RESOURCES.fichas, { produto_id: Number(p.id), mao_obra: 0, custos_indiretos: 0, margem_pct: 0 });
    await create(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(recipe.id), insumo_id: Number(raw.id), consumo: 1, perda_pct: 0 });
  }
  const sale = await create(RESOURCES.vendas, { cliente_id: Number(client.id), status: 'aberta', data: '2030-01-01', total: 20 });
  await create(RESOURCES.itens_venda, { venda_id: Number(sale.id), produto_id: Number(productB.id), tamanho_id: Number(size.id), quantidade: 10, preco_unitario: 2 });
  const opA = await create(RESOURCES.ordens, { produto_id: Number(productA.id), tipo: 'tamanho', quantidade: 1, status: 'em_producao', tamanho_id: Number(size.id) });
  await create(RESOURCES.ordens, { produto_id: Number(productB.id), tipo: 'tamanho', quantidade: 10, status: 'planejada', tamanho_id: Number(size.id), previsao: '2030-03-01' });
  await create(RESOURCES.movimentacoes_insumos, { tipo: 'entrada', insumo_id: Number(raw.id), quantidade: 10, custo_unitario: 1, motivo: 'Cenário PG MRP' });
  await getStore().transaction((tx) => lancarMovimentacaoInsumoDaOrdem({ tipo: 'saida', insumo_id: Number(raw.id), quantidade: 10, custo_unitario: 1, ordem_id: Number(opA.id), motivo: 'Consumo PG MRP' }, actor, tx, { empresaId: company, consolidado: false, permitidas: [company] }));
  const supplier = await create(RESOURCES.fornecedores, { nome: `Fornecedor PG ${suffix}`, pessoa: 'pj', indicador_ie: '1' });
  const purchase = await create(RESOURCES.compras, { fornecedor_id: Number(supplier.id), status: 'pendente', data: '2030-01-01' });
  await create(RESOURCES.itens_compra, { compra_id: Number(purchase.id), insumo_id: Number(raw.id), quantidade: 8, preco_unitario: 1 });
  const { aprovarCompra } = await import('../../src/compras');
  const { reqDe, resFake } = await import('../_p1util');
  await aprovarCompra(reqDe({}, { params: { id: purchase.id }, user: actor }), resFake().res);
  const companyB = Number((await pool.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`MRP outra ${suffix}`])).rows[0].id);
  const other = Number((await pool.query("INSERT INTO produtos(empresa_id,sku,nome,ativo) VALUES($1,$2,'Produto de outra empresa',true) RETURNING id", [companyB, `MRP-OTHER-${suffix}`])).rows[0].id);
  const sizeB = Number(size.id); // grade de tamanhos é catálogo global existente
  const orderB = Number((await pool.query("INSERT INTO ordens_fabricacao(empresa_id,produto_id,tamanho_id,quantidade,status,tipo,previsao) VALUES($1,$2,$3,9,'planejada','tamanho','2030-01-10') RETURNING id", [companyB, other, sizeB])).rows[0].id);
  let payload: any;
  await mrpProducao({ user: actor, query: { de: '2030-01-01', ate: '2030-01-31' } } as any, { json(v: any) { payload = v; } } as any);
  assert.equal(payload.produtos.find((p: any) => p.produto_id === Number(productB.id)).falta, 10);
  const line = payload.insumos.find((i: any) => i.insumo_id === Number(raw.id));
  assert.equal(line.necessaria, 11); assert.equal(line.consumo_aplicado, 1); assert.equal(line.consumo_nao_alocado, 9);
  assert.equal(line.em_compra, 0); assert.equal(line.em_compra_sem_previsao, 8); assert.equal(line.faltando, 10);
  assert.ok(!payload.produtos.some((p: any) => p.produto_id === other));
  assert.ok(payload.ordens.every((o: any) => o.ordem_id !== orderB && o.produto_id !== other));
});

test('PG produção: demanda visível no MRP, OP revisada, consumo idempotente, custo e entrada canônica', async () => {
  assert.ok(pool); const suffix = randomUUID().slice(0, 8);
  const company = Number((await pool.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`Produção jornada ${suffix}`])).rows[0].id);
  const user = Number((await pool.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('Produção PG',$1,'admin',true,$2) RETURNING id", [`production-${suffix}@example.invalid`, company])).rows[0].id);
  const actor = { id: user, name: 'Produção PG', perfil: 'admin' as const, empresa_id: company, empresas: [company] };
  const scope = { kind: 'empresa' as const, empresaId: company };
  const create = (resource: any, body: any) => createRecord(resource, body, actor, { escopo: scope });
  const { reqDe, resFake } = await import('../_p1util'); const production = await import('../../src/producao');
  const product = await create(RESOURCES.produtos, { sku: `PGPR-${suffix}`, nome: 'Produto final', custo: 1, preco_venda: 20 });
  const size = await create(RESOURCES.tamanhos, { nome: `Tamanho ${suffix}`, codigo: suffix });
  const customer = await create(RESOURCES.clientes, { nome: 'Cliente demanda', pessoa: 'pf', documento: '52998224725' });
  const raw = await create(RESOURCES.insumos, { nome: 'Insumo jornada', unidade: 'm', custo_medio: 5 });
  const recipe = await create(RESOURCES.fichas, { produto_id: Number(product.id), mao_obra: 0, custos_indiretos: 0, margem_pct: 0 });
  // Repeated BOM components must sum, never overwrite one another.
  for (let i = 0; i < 2; i++) await create(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(recipe.id), insumo_id: Number(raw.id), consumo: 1, perda_pct: 0 });
  await production.recalcularFichaValores(Number(recipe.id), undefined, { empresaId: company, consolidado: false, permitidas: [company] });
  await create(RESOURCES.movimentacoes_insumos, { tipo: 'entrada', insumo_id: Number(raw.id), quantidade: 10, custo_unitario: 5, motivo: 'Saldo comprovado da jornada' });
  const sale = await create(RESOURCES.vendas, { cliente_id: Number(customer.id), status: 'aberta', data: '2030-01-01' });
  await create(RESOURCES.itens_venda, { venda_id: Number(sale.id), produto_id: Number(product.id), tamanho_id: Number(size.id), quantidade: 3, preco_unitario: 20 });
  let mrp: any; await mrpProducao({ user: actor, query: { de: '2030-01-01', ate: '2030-01-31' } } as any, { json(v: any) { mrp = v; } } as any);
  assert.equal(mrp.produtos.find((p: any) => p.produto_id === Number(product.id)).falta, 3);
  const { planejarDemanda } = await import('../../src/producaoPlanejamento');
  const plan = async () => { const r = resFake(); await planejarDemanda(reqDe({ venda_id: sale.id }, { user: actor }), r.res); return r.saida.json; };
  const plans = await Promise.all([plan(), plan()]);
  assert.equal(plans[0].ordens.length, 1); assert.equal(plans[0].ordens[0].id, plans[1].ordens[0].id);
  const op = plans[0].ordens[0];
  assert.equal(Number(op.demanda_item_id), Number((await pool.query('SELECT id FROM itens_venda WHERE venda_id=$1', [sale.id])).rows[0].id));
  const invoke = async (handler: any, body: any = {}) => { const r = resFake(); await handler(reqDe(body, { params: { id: op.id }, user: actor }), r.res); return r.saida.json; };
  await invoke(production.liberarOrdem);
  const reserved = (await pool.query('SELECT reservas_componentes FROM ordens_fabricacao WHERE id=$1', [op.id])).rows[0].reservas_componentes;
  assert.equal(Number(reserved[String(raw.id)]), 6);
  await assert.rejects(() => create(RESOURCES.movimentacoes_insumos, { tipo: 'saida', insumo_id: Number(raw.id), quantidade: 5, motivo: 'Não pode consumir reserva alheia' }), (e: any) => e.status === 409);
  const first = await invoke(production.criarApontamento, { quantidade_produzida: 3, idempotency_key: 'production-pg-one' });
  const replay = await invoke(production.criarApontamento, { quantidade_produzida: 3, idempotency_key: 'production-pg-one' });
  assert.equal(first.idempotente, false); assert.equal(replay.idempotente, true);
  const completed = await Promise.allSettled([invoke(production.concluirOrdemHandler), invoke(production.concluirOrdemHandler)]);
  assert.ok(completed.some((r) => r.status === 'fulfilled'));
  const stored = (await pool.query('SELECT status,quantidade_produzida,custo_real FROM ordens_fabricacao WHERE empresa_id=$1 AND id=$2', [company, op.id])).rows[0];
  assert.equal(stored.status, 'concluida'); assert.equal(Number(stored.quantidade_produzida), 3); assert.equal(Number(stored.custo_real), 30);
  const consumed = (await pool.query("SELECT count(*)::int n,sum(quantidade) q FROM movimentacoes_insumos WHERE empresa_id=$1 AND ordem_id=$2 AND tipo='saida'", [company, op.id])).rows[0];
  assert.equal(consumed.n, 1); assert.equal(Number(consumed.q), 6);
  const stock = (await pool.query('SELECT sum(quantidade) q FROM estoques WHERE empresa_id=$1 AND produto_id=$2 AND tamanho_id=$3', [company, product.id, size.id])).rows[0];
  assert.equal(Number(stock.q), 3);
  const movement = (await pool.query("SELECT count(*)::int n FROM movimentacoes WHERE empresa_id=$1 AND ordem_id=$2 AND tipo='entrada'", [company, op.id])).rows[0];
  assert.equal(movement.n, 1);
  // Finished stock belongs to the older demand even when its OP is completed.
  // Replanning another sale must not allocate the same three units twice.
  const nextSale = await create(RESOURCES.vendas, { cliente_id: Number(customer.id), status: 'aberta', data: '2030-01-02' });
  await create(RESOURCES.itens_venda, { venda_id: Number(nextSale.id), produto_id: Number(product.id), tamanho_id: Number(size.id), quantidade: 5, preco_unitario: 20 });
  const next = resFake(); await planejarDemanda(reqDe({ venda_id: nextSale.id }, { user: actor }), next.res);
  assert.equal(Number(next.saida.json.ordens[0].quantidade), 5);
  const retry = resFake(); await planejarDemanda(reqDe({ venda_id: nextSale.id }, { user: actor }), retry.res);
  assert.equal(retry.saida.json.ordens[0].id, next.saida.json.ordens[0].id);
});
