// ============================================================================
// ERP-03 — PARIDADE MEMÓRIA × POSTGRESQL no multiempresa (modo memória).
//
// O contrato de tipos (`server/test/pg/contrato-tipo-coluna.test.ts`) exige que
// `unique` tenha índice GLOBAL no banco e `uniqueEmpresa` tenha índice POR
// EMPRESA. Isso não é preciosismo: `memdb.ts` implementa `unique` comparando o
// valor contra TODAS as linhas e `uniqueEmpresa` só dentro da empresa — então
// uma declaração errada faz o modo demonstração recusar o que o PostgreSQL
// aceita (era o caso de `produtos.sku` e `empresas.nome`).
//
// Aqui a paridade é exercitada pelo lado da memória: mesmo SKU e mesmo nome de
// local em duas empresas passam; repetir dentro da MESMA empresa continua 409.
// O lado PostgreSQL tem prova equivalente no A/B do job `testes-postgres`.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore, escopoDe } = await import('../src/services');
const { getDefaultLocalInfo } = await import('../src/services');

const sufixo = Date.now().toString(36).toUpperCase();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

let aId = 0;
let bId = 0;

before(async () => {
  getStore();
  const a = await createRecord(RESOURCES.empresas, { nome: `PAR A ${sufixo}` }, admin);
  const b = await createRecord(RESOURCES.empresas, { nome: `PAR B ${sufixo}` }, admin);
  aId = Number(a.id);
  bId = Number(b.id);
});

const atorA = () => ({ id: 0, name: 'Ana', perfil: 'gerente' as const, empresa_id: aId, empresas: [aId] });
const atorB = () => ({ id: 0, name: 'Bruno', perfil: 'gerente' as const, empresa_id: bId, empresas: [bId] });

test('paridade: o mesmo SKU vale nas duas empresas (uniqueEmpresa), não dentro de uma', async () => {
  const sku = `PAR-SKU-${sufixo}`;
  const pa = await createRecord(RESOURCES.produtos, { sku, nome: 'Camiseta A', preco_venda: 10 }, atorA() as any);
  const pb = await createRecord(RESOURCES.produtos, { sku, nome: 'Camiseta B', preco_venda: 20 }, atorB() as any);
  assert.equal(Number(pa.empresa_id), aId);
  assert.equal(Number(pb.empresa_id), bId);

  await assert.rejects(
    () => createRecord(RESOURCES.produtos, { sku, nome: 'Duplicata A', preco_venda: 10 }, atorA() as any),
    (e: any) => e.status === 409,
    'dentro da mesma empresa o SKU continua único',
  );
});

test('paridade: o mesmo nome de local vale nas duas empresas e cada uma tem o seu padrão', async () => {
  const nome = `loja-par-${sufixo}`;
  const la = await createRecord(RESOURCES.locais, { nome, tipo: 'loja', ativo: true, padrao: true }, atorA() as any);
  const lb = await createRecord(RESOURCES.locais, { nome, tipo: 'loja', ativo: true, padrao: true }, atorB() as any);
  assert.notEqual(Number(la.id), Number(lb.id));

  assert.equal((await getDefaultLocalInfo(undefined, escopoDe(atorA() as any)))?.id, Number(la.id));
  assert.equal((await getDefaultLocalInfo(undefined, escopoDe(atorB() as any)))?.id, Number(lb.id));

  const listaA = await listRecords(RESOURCES.locais, { page: 1, pageSize: 50, filter: { nome } }, atorA() as any);
  assert.equal(listaA.total, 1, 'a listagem da empresa A não soma o local homônimo de B');
});

test('paridade: o nome de empresa pode repetir (o banco nunca teve índice único aqui)', async () => {
  const nome = `Filial ${sufixo}`;
  const x = await createRecord(RESOURCES.empresas, { nome }, admin);
  const y = await createRecord(RESOURCES.empresas, { nome }, admin);
  assert.notEqual(Number(x.id), Number(y.id), 'declarar `unique` aqui recusava o que o PostgreSQL aceita');
});
