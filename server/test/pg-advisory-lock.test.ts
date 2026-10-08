// ============================================================================
// Advisory lock contra Postgres REAL.
//
// O teste de unidade prova a lógica do helper. Este prova o que só o servidor
// pode garantir:
//
//   • `pg_try_advisory_lock($1::bigint)` funciona de verdade pelo driver `pg`;
//   • duas sessões NÃO entram ao mesmo tempo na chave 727272 — uma espera;
//   • o timeout nomeia o PID de quem está segurando o lock;
//   • ao final, `pg_locks` não tem advisory lock residual (nada vazou);
//   • `withSchemaMigrationLock`, que é o que o boot usa, roda e devolve a conexão.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVISORY_LOCK_KEYS,
  AdvisoryLockTimeoutError,
  pgClientAsQueryable,
  withAdvisoryLock,
  withSchemaMigrationLock,
} from '../src/db/advisory-lock';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const CHAVE = ADVISORY_LOCK_KEYS.SCHEMA_MIGRATION;

/** Quantos advisory locks desta chave estão presos agora, e em qual PID. */
async function locksAtivos(client: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> }) {
  const r = await client.query(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1`,
    [CHAVE]
  );
  return r.rows.map((x: { pid: number }) => Number(x.pid));
}

test('advisory lock em Postgres real: exclusão mútua na chave 727272, sem vazamento', { skip }, async () => {
  const { pool } = await import('../src/db');
  assert.ok(pool, 'esperava um pool do Postgres');

  const sessaoA = await pool.connect();
  const sessaoB = await pool.connect();
  try {
    // --- 0. ponto de partida limpo -----------------------------------------
    assert.deepEqual(await locksAtivos(sessaoB), [], 'não deveria haver advisory lock antes do teste');

    // --- 1. A adquire e segura o lock na mão (simula uma migração lenta) ----
    const aAdquiriu = await sessaoA.query(`SELECT pg_advisory_lock($1::bigint)`, [CHAVE]);
    assert.ok(aAdquiriu, 'a sessão A deveria ter adquirido o lock');
    assert.deepEqual(await locksAtivos(sessaoB), [sessaoA.processID], 'o lock precisa aparecer em pg_locks com o PID da A');

    // --- 2. B tenta e NÃO entra: espera e estoura o prazo -------------------
    const comeco = Date.now();
    await assert.rejects(
      () =>
        withAdvisoryLock(
          pgClientAsQueryable(sessaoB),
          async () => {
            throw new Error('o work de B não pode rodar enquanto A segura o lock');
          },
          { key: CHAVE, timeoutMs: 600, pollIntervalMs: 50 }
        ),
      (e: unknown) => {
        assert.ok(e instanceof AdvisoryLockTimeoutError, `esperava AdvisoryLockTimeoutError, veio ${String(e)}`);
        assert.equal(e.key, CHAVE);
        assert.equal(e.detentor, String(sessaoA.processID), 'o erro precisa nomear o PID que segura o lock');
        assert.ok(
          !/não pode rodar/.test(e.message),
          'o work nunca deveria ter sido executado'
        );
        return true;
      }
    );
    assert.ok(Date.now() - comeco >= 500, 'B deveria ter esperado pelo lock antes de desistir');

    // --- 3. A solta; agora B entra de verdade -------------------------------
    await sessaoA.query(`SELECT pg_advisory_unlock($1::bigint)`, [CHAVE]);

    const resultado = await withAdvisoryLock(
      pgClientAsQueryable(sessaoB),
      async (db) => {
        // Prova que estamos DENTRO do lock: ninguém mais pode tê-lo agora.
        const r = await sessaoA.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND pid <> $2`,
          [CHAVE, sessaoA.processID]
        );
        assert.equal(r.rows[0].n, 1, 'o lock deve estar com B');
        // E o db passado ao work é a mesma conexão que segurou o lock.
        await db.$queryRaw`SELECT 1`;
        return 'B entrou';
      },
      { key: CHAVE, timeoutMs: 5_000, pollIntervalMs: 25 }
    );
    assert.equal(resultado, 'B entrou');

    // --- 4. nada vazou -------------------------------------------------------
    assert.deepEqual(await locksAtivos(sessaoB), [], 'o lock precisa ser liberado ao final');
  } finally {
    // Cinto e suspensórios: se algo acima estourou, não deixa lock preso no banco.
    await sessaoA.query(`SELECT pg_advisory_unlock($1::bigint)`, [CHAVE]).catch(() => undefined);
    await sessaoB.query(`SELECT pg_advisory_unlock($1::bigint)`, [CHAVE]).catch(() => undefined);
    sessaoA.release();
    sessaoB.release();
  }
});

test('advisory lock em Postgres real: duas migrações concorrentes são serializadas, nunca intercaladas', { skip }, async () => {
  const { pool } = await import('../src/db');
  assert.ok(pool);

  // Registro global da seção crítica. Se as duas execuções se intercalarem,
  // aparece um "saiu" antes do "saiu" anterior — que é exatamente o cenário de
  // schema corrompido que o lock existe para impedir.
  const eventos: string[] = [];

  const migracao = (nome: string, demoraMs: number) =>
    withSchemaMigrationLock(
      pool,
      async (client) => {
        eventos.push(`entra:${nome}`);
        await client.query(`SELECT pg_sleep($1)`, [demoraMs / 1000]);
        eventos.push(`sai:${nome}`);
        return nome;
      },
      { timeoutMs: 20_000, pollIntervalMs: 25 }
    );

  const [r1, r2] = await Promise.all([migracao('A', 300), migracao('B', 50)]);
  assert.deepEqual([r1, r2], ['A', 'B']);

  // Serialização: ou A por completo antes de B, ou B por completo antes de A.
  const intercalado =
    (eventos[0] === 'entra:A' && eventos[1] === 'entra:B') ||
    (eventos[0] === 'entra:B' && eventos[1] === 'entra:A');
  assert.equal(
    intercalado,
    false,
    `as migrações se intercalaram — o lock não está funcionando: ${eventos.join(' → ')}`
  );
  assert.equal(eventos.length, 4, `esperava 4 eventos, vieram: ${eventos.join(' → ')}`);
});

test('advisory lock em Postgres real: a conexão volta para o pool mesmo com a migração falhando', { skip }, async () => {
  const { pool } = await import('../src/db');
  assert.ok(pool);

  const antes = pool.totalCount;
  await assert.rejects(
    () =>
      withSchemaMigrationLock(pool, async () => {
        throw new Error('migração falhou de propósito');
      }, { timeoutMs: 5_000, pollIntervalMs: 25 }),
    /de propósito/
  );

  // Sem lock residual e sem conexão vazada do pool.
  const client = await pool.connect();
  try {
    assert.deepEqual(await locksAtivos(client), [], 'lock residual após falha');
  } finally {
    client.release();
  }
  assert.ok(pool.totalCount <= antes + 1, `pool cresceu de ${antes} para ${pool.totalCount} — conexão vazada`);
});
