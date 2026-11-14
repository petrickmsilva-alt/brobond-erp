// ============================================================================
// DIAGNÓSTICO DE CONEXÃO — prova em PostgreSQL REAL e banco DESCARTÁVEL.
//
// Prova que `coletarIdentidade` lê a identificação SEM escrever nada:
//   (a) a transação é `READ ONLY` e termina com ROLLBACK — a tentativa de
//       escrita é RECUSADA pelo próprio motor;
//   (b) current_database()/current_user/current_schema()/version()/now() são
//       devolvidos;
//   (c) fora do Neon, as GUCs `neon.*` vêm NULL (nunca erro) e a decisão de
//       destino REPROVA — fail-closed;
//   (d) num schema de ERP (bootstrap aplicado) a tabela-marcador é detectada.
//
// Exige DATABASE_URL e PostgreSQL real; não é permitido pular.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, Pool } from 'pg';
import { BOOTSTRAP_FILE, criarBancoDescartavel, destruirBancoDescartavel } from './_boot-harness';
import { avaliarDestino, coletarIdentidade } from '../../src/ops/diagnostico-conexao';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/diagnostico-conexao-pg.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

const url = process.env.DATABASE_URL;
const poolDo = (alvo: string) => new Pool({ connectionString: alvo, ssl: undefined, max: 2 });

test('a identificação roda em READ ONLY e não altera nada', async () => {
  const banco = await criarBancoDescartavel('diag');
  const pool = poolDo(banco.url);
  try {
    const id = await coletarIdentidade(pool, { url: banco.url });
    assert.equal(id.banco, banco.nome);
    assert.equal(id.usuario, new URL(url).username);
    assert.equal(id.schema, 'public');
    assert.match(id.versao, /^PostgreSQL \d/);
    assert.match(id.agora, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(id.ssl, false);
    assert.equal(id.migracoesPresentes, false);
    assert.equal(id.marcadorPresente, false);
    // Fora do Neon, as GUCs neon.* vêm NULL — nunca erro.
    assert.deepEqual(id.neon, { projetoId: null, branchId: null, branchNome: null, endpointId: null, timelineId: null });

    // A sessão é somente leitura: uma escrita é RECUSADA pelo motor.
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN READ ONLY');
      await assert.rejects(() => cliente.query('CREATE TABLE tentativa_de_escrita (id int)'), /read-only|read only/i);
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
  } finally {
    await pool.end();
    await destruirBancoDescartavel(banco);
  }
});

test('com o bootstrap do ERP aplicado, a tabela-marcador é detectada', async () => {
  const banco = await criarBancoDescartavel('diagmarc');
  const admin = new Client({ connectionString: banco.url });
  await admin.connect();
  await admin.query(readFileSync(BOOTSTRAP_FILE, 'utf8'));
  await admin.end();

  const pool = poolDo(banco.url);
  try {
    const id = await coletarIdentidade(pool, { url: banco.url });
    assert.equal(id.marcadorPresente, true);
    // `schema_migrations` só nasce na cadeia versionada (db.ts), não no bootstrap.
    assert.equal(id.migracoesPresentes, false);
  } finally {
    await pool.end();
    await destruirBancoDescartavel(banco);
  }
});

test('o destino local REPROVA: host não é Neon e as GUCs do Neon estão ausentes', async () => {
  const banco = await criarBancoDescartavel('diagneg');
  const pool = poolDo(banco.url);
  try {
    const id = await coletarIdentidade(pool, { url: banco.url });
    const r = avaliarDestino(id, { projetoId: 'qualquer', branchNome: 'production' });
    assert.equal(r.ok, false);
    assert.equal(r.verificacoes.find((v) => v.nome === 'host-neon')?.ok, false);
    assert.equal(r.verificacoes.find((v) => v.nome === 'projeto-neon')?.ok, false);
    assert.equal(r.verificacoes.find((v) => v.nome === 'branch-confirmada')?.ok, false);
  } finally {
    await pool.end();
    await destruirBancoDescartavel(banco);
  }
});
