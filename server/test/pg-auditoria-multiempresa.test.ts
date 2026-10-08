// ============================================================================
// AUDITORIA MULTIEMPRESA contra Postgres REAL — Etapa 2.1, Parte 3.
//
// Prova que a coluna `auditoria.empresa_id` (migration 0017) é gravada pelo
// INSERT do pgstore e que o recorte do feed chega ao SQL:
//   A — evento da empresa A carimbado e visível para A (com nome da empresa);
//   B — evento da empresa B invisível para A;
//   C — leitura direta cruzada responde 404;
//   D — consolidação autorizada vê as duas empresas.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

test('auditoria multiempresa em Postgres real: carimbo no INSERT e recorte no SQL', { skip }, async () => {
  const { migrate, query } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getRecord, listRecords } = await import('../src/services');

  const admin = { id: 1, name: 'Admin PG', perfil: 'admin' as const };
  const empB = await createRecord(RESOURCES.empresas, { nome: `PG AUDIT B ${sufixo}` }, admin);
  const EMPRESA_B = Number(empB.id);

  const anaA = { id: 301, name: 'Ana PG', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };
  const brunoB = { id: 302, name: 'Bruno PG', perfil: 'admin' as const, empresa_id: EMPRESA_B, empresas: [EMPRESA_B] };
  const auditor = { id: 303, name: 'Auditor PG', perfil: 'admin' as const, empresa_id: 1, empresas: [1, EMPRESA_B], pode_consolidar: true, consolidar: true };

  const nomeA = `PG Audit A ${sufixo}`;
  const nomeB = `PG Audit B ${sufixo}`;
  await createRecord(RESOURCES.clientes, { nome: nomeA }, anaA as any);
  await createRecord(RESOURCES.clientes, { nome: nomeB }, brunoB as any);

  // A — o evento nasce com a empresa no SQL e o feed mostra o nome dela.
  const feedA = await listRecords(RESOURCES.auditoria, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' }, anaA as any);
  const eventoA = feedA.rows.find((e) => String(e.descricao).includes(nomeA));
  assert.ok(eventoA, 'o feed de A mostra o evento da A');
  assert.equal(Number(eventoA.empresa_id), 1);
  assert.ok(String(eventoA.empresa_id__label || '').length > 0, 'o JOIN resolve o nome da empresa no PG');

  // Coluna real no banco (não só projeção da API).
  const cru = await query(`SELECT empresa_id FROM auditoria WHERE id = $1`, [Number(eventoA.id)]);
  assert.equal(Number(cru.rows[0].empresa_id), 1);

  // B — o evento de B não aparece para A.
  assert.ok(!feedA.rows.some((e) => String(e.descricao).includes(nomeB)), 'A enxergou um evento da B no PG');
  const feedB = await listRecords(RESOURCES.auditoria, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' }, brunoB as any);
  const eventoB = feedB.rows.find((e) => String(e.descricao).includes(nomeB));
  assert.ok(eventoB, 'o feed de B mostra o evento da B');
  assert.equal(Number(eventoB.empresa_id), EMPRESA_B);

  // C — leitura direta cruzada responde 404.
  await assert.rejects(() => getRecord(RESOURCES.auditoria, Number(eventoB.id), anaA as any), (e: any) => {
    assert.equal(e.status, 404);
    return true;
  });

  // D — consolidação autorizada vê as duas empresas.
  const consolidado = await listRecords(RESOURCES.auditoria, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' }, auditor as any);
  const descs = consolidado.rows.map((e) => String(e.descricao));
  assert.ok(
    descs.some((d) => d.includes(nomeA)) && descs.some((d) => d.includes(nomeB)),
    'consolidação autorizada mostra A e B no PG'
  );
});
