// ============================================================================
// P2-04 — paridade MemStore × PostgreSQL para "valor > 0".
//
// O FULL FORENSIC SYSTEM AUDIT encontrou constraints CHECK NOT VALID nas
// tabelas financeiras. O PostgreSQL recusa valor <= 0 (23514) desde 0011/0025;
// o MemStore, porém, aceitava um lançamento de R$ 0 porque o recurso declarava
// `min: 0` e o gancho automático (aporte/recorrência) inseria direto no store.
// Este arquivo prova o lado memória: nenhum caminho de escrita de valor 0
// passa — o mesmo que o PostgreSQL rejeita. O lado PostgreSQL é provado em
// `test/pg/p2-04-not-valid-constraints.test.ts` (job testes-postgres).
//
// Roda no modo demonstração (sem DATABASE_URL) — parte do `npm --prefix server test`.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');

const sufixo = Date.now().toString(36).toUpperCase();
const admin = { id: 1, name: 'Admin P204', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };

before(async () => {
  getStore();
  try {
    await getStore().insert(RESOURCES.usuarios, { id: 1, nome: 'Admin P204', email: `p204-${sufixo}@brobond.test`, perfil: 'admin', empresa_id: 1, ativo: true });
  } catch {
    // já existe
  }
});

test('P2-04 memória: os recursos financeiros exigem valor > 0 (não apenas >= 0)', () => {
  for (const chave of ['lancamentos_financeiros', 'aportes', 'recorrencias_financeiras', 'transferencias_financeiras'] as const) {
    const f = RESOURCES[chave].fields.find((x) => x.name === 'valor')!;
    assert.equal(f.min, 0.01, `${chave}.valor deve exigir > 0, igual ao CHECK do PostgreSQL`);
  }
});

test('P2-04 memória: lançamento com valor 0 é recusado (400), não gravado', async () => {
  await assert.rejects(
    () => createRecord(RESOURCES.lancamentos_financeiros, { data: '2026-10-17', tipo: 'despesa', descricao: 'zero', valor: 0, status: 'confirmado' }, admin as any),
    (e: any) => e.status === 400,
    'o MemStore não pode aceitar um lançamento de R$ 0 que o PostgreSQL recusa'
  );
});

test('P2-04 memória: transferência com valor 0 é recusada (400)', async () => {
  await assert.rejects(
    () => createRecord(RESOURCES.transferencias_financeiras, { data: '2026-10-17', conta_origem_id: 1, conta_destino_id: 2, valor: 0, descricao: 'zero', status: 'confirmado' }, admin as any),
    (e: any) => e.status === 400
  );
});

test('P2-04 memória: aporte com valor 0 é recusado (400) — o gancho não insere R$ 0', async () => {
  const inv = await createRecord(RESOURCES.investidores, { nome: `Inv ${sufixo}`, empresa_id: 1 }, admin as any);
  await assert.rejects(
    () => createRecord(RESOURCES.aportes, { investidor_id: Number(inv.id), data: '2026-10-17', tipo: 'aporte', valor: 0, status: 'confirmado' }, admin as any),
    (e: any) => e.status === 400
  );
});

test('P2-04 memória: recorrência com valor 0 é recusada (400)', async () => {
  await assert.rejects(
    () => createRecord(RESOURCES.recorrencias_financeiras, { descricao: `Rec ${sufixo}`, tipo: 'despesa', valor: 0, frequencia: 'mensal', dia: 1, proxima_geracao: '2020-01-01', status: 'ativo' }, admin as any),
    (e: any) => e.status === 400
  );
});

test('P2-04 memória: valor positivo continua aceito (regressão do caminho normal)', async () => {
  const ok = await createRecord(RESOURCES.lancamentos_financeiros, { data: '2026-10-17', tipo: 'receita', descricao: `ok ${sufixo}`, valor: 100, status: 'confirmado' }, admin as any);
  assert.ok(Number(ok.id) > 0);
  assert.equal(Number(ok.valor), 100);
});
