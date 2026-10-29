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
  const purchase = await create(RESOURCES.compras, { fornecedor_id: Number(supplier.id), status: 'aprovado', data: '2030-01-01' });
  await create(RESOURCES.itens_compra, { compra_id: Number(purchase.id), insumo_id: Number(raw.id), quantidade: 8, preco_unitario: 1 });
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
