// ============================================================================
// Advisory lock — testes de unidade (sem banco).
//
// O que está em jogo aqui é a ORDEM e a GARANTIA, não o SQL em si:
//   • a chave enviada é a 727272 contratual (não uma chave inventada);
//   • o unlock acontece SEMPRE, inclusive com `work` lançando;
//   • o erro original de `work` não é engolido pelo unlock;
//   • esperar tem prazo — o boot aborta em vez de pendurar para sempre;
//   • o retorno do Postgres é interpretado certo em qualquer formato de driver.
//
// O SQL de verdade é provado em pg-advisory-lock.test.ts, contra o Postgres.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';

import {
  ADVISORY_LOCK_KEYS,
  AdvisoryLockTimeoutError,
  pgClientAsQueryable,
  withAdvisoryLock,
  type PrismaQueryable,
} from '../src/db/advisory-lock';

/** Uma chamada registrada: o SQL já montado e os valores parametrizados. */
type Chamada = { sql: string; values: unknown[] };

/**
 * Executor falso que fala o dialeto do advisory lock.
 *
 * `disponivel` controla se o `pg_try_advisory_lock` devolve true — é assim que
 * o teste simula "outra migração está segurando o lock".
 */
function criarFake(opcoes: { disponivel?: boolean | (() => boolean); formato?: 'boolean' | 'int' | 'texto' } = {}) {
  const chamadas: Chamada[] = [];
  let tentativas = 0;
  const db: PrismaQueryable = {
    async $queryRaw(query: TemplateStringsArray, ...values: unknown[]) {
      // Reconstrói o SQL exatamente como o adaptador do pg faria.
      const sql = query.reduce((acc, parte, i) => acc + (i === 0 ? parte : `$${i}` + parte), '');
      chamadas.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });

      if (sql.includes('pg_try_advisory_lock')) {
        tentativas++;
        const livre = typeof opcoes.disponivel === 'function' ? opcoes.disponivel() : (opcoes.disponivel ?? true);
        const formato = opcoes.formato ?? 'boolean';
        const valor = formato === 'int' ? (livre ? 1 : 0) : formato === 'texto' ? (livre ? 't' : 'f') : livre;
        return [{ adquirido: valor }];
      }
      if (sql.includes('pg_advisory_unlock')) return [{ pg_advisory_unlock: true }];
      // pg_locks — usado só pelo diagnóstico de timeout.
      return [{ pid: '4242' }];
    },
  };
  return { db, chamadas, tentativas: () => tentativas };
}

/** Relógio e sleep controlados: o teste de timeout não espera de verdade. */
function relogio() {
  let agora = 0;
  return {
    now: () => agora,
    sleep: async (ms: number) => {
      agora += ms;
    },
  };
}

test('a chave do lock de migração é a contratual 727272', () => {
  assert.equal(ADVISORY_LOCK_KEYS.SCHEMA_MIGRATION, 727272);
});

test('a chave 727272 é o que chega parametrizado no SQL', async () => {
  const { db, chamadas } = criarFake();
  await withAdvisoryLock(db, async () => 'ok');

  const adquirir = chamadas.find((c) => c.sql.includes('pg_try_advisory_lock'));
  const liberar = chamadas.find((c) => c.sql.includes('pg_advisory_unlock'));

  assert.ok(adquirir, 'esperava uma chamada de pg_try_advisory_lock');
  assert.ok(liberar, 'esperava uma chamada de pg_advisory_unlock');
  // Parametrizado ($1), nunca interpolado no texto — senão a chave vira SQL.
  assert.match(adquirir.sql, /pg_try_advisory_lock\(\$1::bigint\)/);
  assert.deepEqual(adquirir.values, [727272]);
  assert.deepEqual(liberar.values, [727272]);
  assert.ok(!adquirir.sql.includes('727272'), 'a chave não pode aparecer literal no SQL');
});

test('ordem: adquire → roda o work → libera, e o work recebe a mesma conexão', async () => {
  const { db, chamadas } = criarFake();
  const ordem: string[] = [];

  const resultado = await withAdvisoryLock(db, async (conectado) => {
    ordem.push('work');
    assert.equal(conectado, db, 'work precisa receber a MESMA conexão que segurou o lock');
    return 123;
  });

  assert.equal(resultado, 123);
  assert.deepEqual(
    chamadas.map((c) => (c.sql.includes('try_advisory') ? 'adquire' : c.sql.includes('unlock') ? 'libera' : 'outro')),
    ['adquire', 'libera']
  );
  assert.deepEqual(ordem, ['work']);
});

test('o lock é liberado mesmo quando o work lança, e o erro original sobrevive', async () => {
  const { db, chamadas } = criarFake();
  const original = new Error('a migração quebrou');

  await assert.rejects(
    () =>
      withAdvisoryLock(db, async () => {
        throw original;
      }),
    (e: unknown) => e === original
  );

  assert.ok(
    chamadas.some((c) => c.sql.includes('pg_advisory_unlock')),
    'o unlock precisa acontecer no finally'
  );
});

test('chaves customizadas são honradas (o helper não está preso na 727272)', async () => {
  const { db, chamadas } = criarFake();
  await withAdvisoryLock(db, async () => undefined, { key: 999 });
  assert.deepEqual(chamadas.find((c) => c.sql.includes('try_advisory'))?.values, [999]);
});

test('espera pelo lock e prossegue quando ele é liberado', async () => {
  let liberado = false;
  const { db, tentativas } = criarFake({ disponivel: () => liberado });
  const { now, sleep } = relogio();

  // Libera na terceira tentativa.
  setTimeout(() => {
    liberado = true;
  }, 0);
  const espera = withAdvisoryLock(db, async () => 'entrou', {
    timeoutMs: 10_000,
    pollIntervalMs: 50,
    now,
    // O relógio é falso, então a liberação precisa vir por contagem de tentativas.
    sleep: async (ms) => {
      if (tentativas() >= 3) liberado = true;
      await sleep(ms);
    },
  });

  assert.equal(await espera, 'entrou');
  assert.ok(tentativas() >= 3, `esperava ter tentado ao menos 3x, tentou ${tentativas()}`);
});

test('timeout: estourou o prazo, lança AdvisoryLockTimeoutError com o PID do detentor', async () => {
  const { db } = criarFake({ disponivel: false });
  const { now, sleep } = relogio();

  await assert.rejects(
    () => withAdvisoryLock(db, async () => 'nunca roda', { timeoutMs: 1_000, pollIntervalMs: 100, now, sleep }),
    (e: unknown) => {
      assert.ok(e instanceof AdvisoryLockTimeoutError, `esperava AdvisoryLockTimeoutError, veio ${String(e)}`);
      assert.equal(e.key, 727272);
      assert.equal(e.timeoutMs, 1_000);
      assert.equal(e.detentor, '4242');
      assert.match(e.message, /727272/);
      assert.match(e.message, /4242/);
      return true;
    }
  );
});

test('timeout: o diagnóstico de quem segura o lock não pode derrubar o erro', async () => {
  const db: PrismaQueryable = {
    async $queryRaw(query: TemplateStringsArray) {
      const sql = query.join('');
      if (sql.includes('pg_try_advisory_lock')) return [{ adquirido: false }];
      throw new Error('pg_stat_activity indisponível'); // o diagnóstico falha
    },
  };
  const { now, sleep } = relogio();

  await assert.rejects(
    () => withAdvisoryLock(db, async () => 'x', { timeoutMs: 200, pollIntervalMs: 100, now, sleep }),
    (e: unknown) => {
      assert.ok(e instanceof AdvisoryLockTimeoutError);
      assert.equal(e.detentor, null, 'sem diagnóstico, detentor é null — mas o erro sai do mesmo jeito');
      return true;
    }
  );
});

test('aninhamento na mesma sessão adquire e libera em pares (advisory lock é reentrante)', async () => {
  const { db, chamadas } = criarFake();

  await withAdvisoryLock(db, async () => {
    await withAdvisoryLock(db, async () => 'interno');
  });

  const sequencia = chamadas.map((c) =>
    c.sql.includes('try_advisory') ? 'A' : c.sql.includes('unlock') ? 'L' : '?'
  );
  assert.deepEqual(sequencia, ['A', 'A', 'L', 'L'], `sequência errada: ${sequencia.join('')}`);
});

test('interpreta o retorno do driver em qualquer formato (boolean, int, texto)', async () => {
  for (const formato of ['boolean', 'int', 'texto'] as const) {
    // Livre → entra.
    const livre = criarFake({ disponivel: true, formato });
    assert.equal(await withAdvisoryLock(livre.db, async () => 'ok'), 'ok', `formato ${formato} (livre) falhou`);

    // Ocupado → não entra e estoura o timeout (prova que '0'/'f' não virou truthy).
    const ocupado = criarFake({ disponivel: false, formato });
    const { now, sleep } = relogio();
    await assert.rejects(
      () => withAdvisoryLock(ocupado.db, async () => 'ok', { timeoutMs: 100, pollIntervalMs: 50, now, sleep }),
      AdvisoryLockTimeoutError,
      `formato ${formato} (ocupado) deveria ter dado timeout`
    );
  }
});

test('entrada inválida é recusada antes de tocar no banco', async () => {
  const { db } = criarFake();
  await assert.rejects(() => withAdvisoryLock(db, async () => 1, { key: 1.5 }), TypeError);
  await assert.rejects(() => withAdvisoryLock(db, async () => 1, { timeoutMs: -1 }), TypeError);
  await assert.rejects(() => withAdvisoryLock(db, async () => 1, { pollIntervalMs: 0 }), TypeError);
});

test('pgClientAsQueryable traduz o tagged template em SQL parametrizado do pg', async () => {
  const vistos: Array<{ text: string; values: unknown[] }> = [];
  const clienteFalso = {
    async query(text: string, values?: unknown[]) {
      vistos.push({ text, values: values ?? [] });
      return { rows: [{ adquirido: true }] };
    },
  } as unknown as PoolClient;

  const db = pgClientAsQueryable(clienteFalso);
  await db.$queryRaw`SELECT pg_try_advisory_lock(${727272}::bigint) AS adquirido`;

  assert.equal(vistos.length, 1);
  assert.equal(vistos[0].text, 'SELECT pg_try_advisory_lock($1::bigint) AS adquirido');
  assert.deepEqual(vistos[0].values, [727272]);
});

// ---------------------------------------------------------------------------
// REGRESSÃO: o `pg` resolve `client.query` com um QueryResult ({ rows, … }),
// não com o array de linhas que o Prisma devolve. Um adaptador que repassasse o
// QueryResult cru fazia `lockAdquirido` ler um objeto, concluir "não adquirido"
// e deixar o boot girando até o timeout — sem nenhum erro no log.
// ---------------------------------------------------------------------------
test('REGRESSÃO: pgClientAsQueryable devolve as LINHAS, não o QueryResult do pg', async () => {
  const clienteFalso = {
    async query() {
      return { rows: [{ adquirido: true }], rowCount: 1, command: 'SELECT', oid: null, fields: [] };
    },
  } as unknown as PoolClient;

  const resultado = await pgClientAsQueryable(clienteFalso).$queryRaw`SELECT 1`;
  assert.ok(Array.isArray(resultado), `esperava array de linhas, veio ${typeof resultado}`);
  assert.deepEqual(resultado, [{ adquirido: true }]);
});

test('REGRESSÃO: um lock adquirido é reconhecido mesmo vindo em formato QueryResult', async () => {
  // Adaptador "esquecido": repassa o QueryResult cru em vez de .rows.
  const db: PrismaQueryable = {
    async $queryRaw(query: TemplateStringsArray) {
      const sql = query.join('');
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ adquirido: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  assert.equal(await withAdvisoryLock(db, async () => 'entrou'), 'entrou');
});

test('REGRESSÃO: o timeout ainda nomeia o detentor quando o resultado vem como QueryResult', async () => {
  const db: PrismaQueryable = {
    async $queryRaw(query: TemplateStringsArray) {
      const sql = query.join('');
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ adquirido: false }] };
      return { rows: [{ pid: '9001' }] };
    },
  };
  const { now, sleep } = relogio();
  await assert.rejects(
    () => withAdvisoryLock(db, async () => 'x', { timeoutMs: 100, pollIntervalMs: 50, now, sleep }),
    (e: unknown) => {
      assert.ok(e instanceof AdvisoryLockTimeoutError);
      assert.equal(e.detentor, '9001');
      return true;
    }
  );
});

test('pgClientAsQueryable numera vários parâmetros na ordem certa', async () => {
  const vistos: Array<{ text: string; values: unknown[] }> = [];
  const clienteFalso = {
    async query(text: string, values?: unknown[]) {
      vistos.push({ text, values: values ?? [] });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await pgClientAsQueryable(clienteFalso)
    .$queryRaw`UPDATE t SET a = ${1}, b = ${'dois'} WHERE id = ${3}`;

  assert.equal(vistos[0].text, 'UPDATE t SET a = $1, b = $2 WHERE id = $3');
  assert.deepEqual(vistos[0].values, [1, 'dois', 3]);
});
