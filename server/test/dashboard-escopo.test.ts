// ============================================================================
// MULTIEMPRESA — o painel (/api/dashboard) é da EMPRESA ATIVA do ator.
//
// Antes desta correção o painel somava estoque, vendas e ordens de TODAS as
// empresas, sem recorte. Agora:
//   • com a empresa ativa → só os dados dela;
//   • consolidado → só com pode_consolidar + ?consolidado=1 (escopo.consolidado);
//   • sem escopo (chamada de sistema) → comportamento anterior, inalterado.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { escopoDoAtor } = await import('../src/empresa');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

let A = 0;
let B = 0;

before(async () => {
  const s = getStore();
  A = Number((await createRecord(RESOURCES.empresas, { nome: 'Painel A', razao_social: 'PAINEL A LTDA' }, admin)).id);
  B = Number((await createRecord(RESOURCES.empresas, { nome: 'Painel B', razao_social: 'PAINEL B LTDA' }, admin)).id);

  const atorA = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: B, empresas: [B] };
  const prodA = await createRecord(RESOURCES.produtos, { sku: 'PNL-A', nome: 'Produto A', custo: 10, preco_venda: 20 }, atorA as any);
  const prodB = await createRecord(RESOURCES.produtos, { sku: 'PNL-B', nome: 'Produto B', custo: 10, preco_venda: 20 }, atorB as any);

  // A: 7 peças em estoque; B: 11 peças em estoque.
  await s.insert(RESOURCES.estoques, { produto_id: Number(prodA.id), tamanho_id: null, local: 'loja', quantidade: 7, estoque_min: 0, empresa_id: A });
  await s.insert(RESOURCES.estoques, { produto_id: Number(prodB.id), tamanho_id: null, local: 'loja', quantidade: 11, estoque_min: 0, empresa_id: B });
});

test('painel com a empresa ativa A: só o estoque e os produtos da A', async () => {
  const d = await getStore().dashboard(escopoDoAtor({ id: 1, perfil: 'gerente', empresa_id: A, empresas: [A] } as any));
  assert.equal(d.pecasEstoque, 7, 'não soma as 11 peças da B');
  assert.equal(d.totais.produtos, 1, 'só o produto da A');
});

test('painel com a empresa ativa B: só a B', async () => {
  const d = await getStore().dashboard(escopoDoAtor({ id: 1, perfil: 'gerente', empresa_id: A, empresas: [A, B], empresa_sessao: B } as any));
  assert.equal(d.pecasEstoque, 11);
  assert.equal(d.totais.produtos, 1);
});

test('sem pode_consolidar, ?consolidado=1 NÃO vira consolidação no painel', async () => {
  const ator = { id: 1, perfil: 'gerente', empresa_id: A, empresas: [A, B], consolidar: true, pode_consolidar: false };
  const d = await getStore().dashboard(escopoDoAtor(ator as any));
  assert.equal(d.pecasEstoque, 7);
});

test('consolidado autorizado (pode_consolidar + pedido explícito) soma as empresas concedidas', async () => {
  const ator = { id: 1, perfil: 'admin', empresa_id: A, empresas: [A, B], consolidar: true, pode_consolidar: true };
  const d = await getStore().dashboard(escopoDoAtor(ator as any));
  assert.equal(d.pecasEstoque, 18);
  assert.equal(d.totais.produtos, 2);
});

test('chamada de sistema sem escopo mantém a leitura do grupo (inalterada)', async () => {
  const d = await getStore().dashboard();
  assert.equal(d.pecasEstoque, 18);
});

test('o painel nunca contém dados da outra empresa na valorização', async () => {
  const d = await getStore().dashboard(escopoDoAtor({ id: 1, perfil: 'gerente', empresa_id: A, empresas: [A] } as any));
  assert.ok(d.valorizacao.produtos.every((p) => p.produto.includes('Produto A')), 'só produtos da A');
});
