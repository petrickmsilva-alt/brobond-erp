// ============================================================================
// PROD-DB-01.5.1 — WRAPPER REAL (psql) do script administrativo E4.2.
//
// Complementa (não substitui) prod-db-015-correcao-nomes-locais.test.ts, que
// exercita apenas o bloco `DO` extraído. Aqui o arquivo INTEIRO é executado pelo
// psql real, com os mesmos parâmetros (`-v apply`, `-v confirmacao`) e o mesmo
// wrapper `\if :apply / BEGIN / COMMIT / ROLLBACK` que o operador usa:
//
//   1. DRY-RUN sem parâmetros        → exit 0, ROLLBACK, nada escrito;
//   2. APPLY sem confirmação         → exit 3, aborta, nada escrito;
//   3. APPLY com dupla confirmação   → exit 0, COMMIT, 69→0;
//   4. segunda execução (idempotente)→ exit 0, 0 UPDATEs;
//   5. guarda acionada (F1: dup_saldos via tamanho_id NULL) → exit 3, ROLLBACK,
//      NADA persistido (fail-closed do AFTER-CHECK).
//
// O wrapper abre uma transação explícita; por isso o teste usa um BANCO
// DESCARTÁVEL próprio (bootstrap isolado), nunca o banco da suíte.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Exige DATABASE_URL e o
// binário `psql` (instalado no CI; localmente aceite PSQL_BIN, ex.: um shim).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-01-51-wrapper-psql.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
  );
}

const SCRIPT = fileURLToPath(
  new URL('../../../db/admin/005-propagar-nomes-locais-e42.sql', import.meta.url)
);

/** Localiza o binário psql (PSQL_BIN tem precedência; aceita wrapper/shim). */
function resolverPsql(): string | null {
  const candidatos = [process.env.PSQL_BIN, 'psql'].filter(Boolean) as string[];
  for (const bin of candidatos) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

const PSQL = resolverPsql();

/** Executa o arquivo do script no psql real, com a URL como 1º argumento. */
function runPsql(url: string, args: string[]): { code: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync(PSQL!, [url, '-v', 'ON_ERROR_STOP=1', ...args], {
    input: readFileSync(SCRIPT, 'utf8'),
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'brobond' },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  // O psql manda NOTICE/ERROR para stderr e comandos (\echo) para stdout.
  return { code: r.status ?? -1, stdout, stderr, out: `${stdout}\n${stderr}` };
}

test('PROD-DB-01.5.1 — o wrapper psql é fail-closed: DRY-RUN/no-confirm não escrevem; APPLY comita; guarda reverte', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const base = new URL(process.env.DATABASE_URL!);
  const scratch = `e42_wrapper_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const url = new URL(base.toString());
  url.pathname = `/${scratch}`;
  const scratchUrl = url.toString();
  const db = new Client({ connectionString: scratchUrl });

  try {
    await admin.query(`CREATE DATABASE ${scratch}`);

    // Bootstrap do banco descartável via o MESMO runner da aplicação (processo
    // filho isolado, para não tocar o pool global do banco da suíte).
    const boot = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/db.ts').then((m) => m.migrate());"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' }
    );
    assert.equal(boot.status, 0, `bootstrap do banco descartável falhou:\n${boot.stdout}\n${boot.stderr}`);

    await db.connect();

    const contador = async () => {
      const { rows } = await db.query(`SELECT
        (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
          WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
        (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
          WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
        (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
          WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
        (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
          WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome) AS n`);
      return Number(rows[0].n);
    };
    const dupSaldos = async () => {
      const { rows } = await db.query(
        `SELECT count(*) AS n FROM (
           SELECT empresa_id, produto_id, tamanho_id, local FROM estoques
           GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1) d`
      );
      return Number(rows[0].n);
    };

    // ------------------------------------------------------------------------
    // FIXTURE — empresa A: um local renomeado sem propagação (69 classe B).
    // ------------------------------------------------------------------------
    const sfx = Date.now().toString(36);
    const empA = Number(
      (await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [
        `WRAP A ${sfx}`,
        `6${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`,
      ])).rows[0].id
    );
    const antigoA = `Antigo W ${sfx}`;
    const novoA = `Novo W ${sfx}`;
    const expA = `Expedicao W ${sfx}`;
    const localA = Number(
      (await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ($1, $2, true, true) RETURNING id`, [antigoA, empA])).rows[0].id
    );
    const localExpA = Number(
      (await db.query(`INSERT INTO locais (nome, empresa_id, ativo) VALUES ($1, $2, true) RETURNING id`, [expA, empA])).rows[0].id
    );
    const produtos = (
      await db.query(
        `INSERT INTO produtos (sku, nome, empresa_id)
         SELECT $1 || g, $2 || g, $3 FROM generate_series(1, 30) g RETURNING id`,
        [`SKUW-${sfx}-`, `Prod W ${sfx} `, empA]
      )
    ).rows.map((r) => Number(r.id));
    const produtoA = produtos[0];
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       SELECT p, NULL, $1, $2, 1, $3 FROM unnest($4::int[]) p`,
      [antigoA, localA, empA, produtos]
    );
    await db.query(
      `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, quantidade, empresa_id)
       SELECT 'ajuste', $1, $2, $3, 1, $4 FROM generate_series(1, 20)`,
      [produtoA, antigoA, localA, empA]
    );
    await db.query(
      `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, local_destino, local_destino_id, quantidade, empresa_id)
       SELECT 'transferencia', $1, $2, $3, $4, $5, 1, $6 FROM generate_series(1, 10)`,
      [produtoA, expA, localExpA, antigoA, localA, empA]
    );
    await db.query(
      `INSERT INTO inventarios (local, local_id, status, empresa_id)
       SELECT $1, $2, 'aberto', $3 FROM generate_series(1, 9)`,
      [antigoA, localA, empA]
    );
    await db.query(`UPDATE locais SET nome = $1 WHERE id = $2`, [novoA, localA]);

    assert.equal(await contador(), 69, 'a fixture deve reproduzir exatamente 69');

    // ------------------------------------------------------------------------
    // (1) DRY-RUN (sem parâmetros) → exit 0, ROLLBACK, nada escrito.
    // ------------------------------------------------------------------------
    const dry = runPsql(scratchUrl, []);
    assert.equal(dry.code, 0, `DRY-RUN deve sair 0:\n${dry.stderr}`);
    assert.match(dry.out, /BEFORE nomes_locais_inconsistentes=69/, 'DRY-RUN deve registrar BEFORE=69');
    assert.match(dry.out, /DRY-RUN: nenhuma escrita/, 'DRY-RUN não pode escrever');
    assert.match(dry.out, /DRY-RUN: transação revertida \(ROLLBACK\)/, 'DRY-RUN deve reverter');
    assert.equal(await contador(), 69, 'DRY-RUN não pode alterar o dado');

    // ------------------------------------------------------------------------
    // (2) APPLY sem confirmação → exit 3, aborta, nada escrito.
    // ------------------------------------------------------------------------
    const semConf = runPsql(scratchUrl, ['-v', 'apply=on']);
    assert.notEqual(semConf.code, 0, 'APPLY sem confirmação deve falhar');
    assert.match(semConf.out, /APPLY recusado/, 'deve recusar APPLY sem confirmação');
    assert.equal(await contador(), 69, 'APPLY sem confirmação não pode alterar o dado');

    // ------------------------------------------------------------------------
    // (3) APPLY com dupla confirmação → exit 0, COMMIT, 69→0.
    // ------------------------------------------------------------------------
    const apply = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5']);
    assert.equal(apply.code, 0, `APPLY deve sair 0:\n${apply.stderr}`);
    assert.match(apply.out, /atualizados: estoques\.local=30, movimentacoes\.local=20, movimentacoes\.local_destino=10, inventarios\.local=9 \(total=69\)/);
    assert.match(apply.out, /AFTER nomes_locais_inconsistentes=0 \(fail-closed\)/);
    assert.match(apply.out, /transação COMITADA/);
    assert.equal(await contador(), 0, 'após o APPLY o contador deve ser 0');

    // ------------------------------------------------------------------------
    // (4) Idempotência — segunda execução = 0 UPDATEs, exit 0.
    // ------------------------------------------------------------------------
    const idem = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5']);
    assert.equal(idem.code, 0, `2ª passada deve sair 0:\n${idem.stderr}`);
    assert.match(idem.out, /atualizados: estoques\.local=0, movimentacoes\.local=0, movimentacoes\.local_destino=0, inventarios\.local=0 \(total=0\)/);
    assert.equal(await contador(), 0, '2ª passada deve continuar 0');

    // ------------------------------------------------------------------------
    // (5) GUARDA ACIONADA (F1) → AFTER detecta duplicata de saldo (tamanho_id
    //     NULL) → exit 3 → ROLLBACK → NADA persistido (fail-closed).
    //
    //     Esse estado SÓ existe ANTES da 0030: os índices parciais
    //     uq_e42_estoques_empresa_prod_*_local_id ainda NÃO existem (é
    //     justamente por isso que a 0030 está bloqueada). Removê-los aqui
    //     reproduz a produção pré-0030; a única trava restante é a unicidade
    //     legada por texto, que NÃO distingue NULL em tamanho_id.
    // ------------------------------------------------------------------------
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id`);
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_tam_local_id`);
    const empB = Number(
      (await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [
        `WRAP B ${sfx}`,
        `5${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`,
      ])).rows[0].id
    );
    const localB = Number(
      (await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ($1, $2, true, true) RETURNING id`, [`Antigo B ${sfx}`, empB])).rows[0].id
    );
    const produtoB = Number(
      (await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKUWB-${sfx}`, `Prod B ${sfx}`, empB])).rows[0].id
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'X1', $2, 1, $3)`,
      [produtoB, localB, empB]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'X2', $2, 1, $3)`,
      [produtoB, localB, empB]
    );
    await db.query(`UPDATE locais SET nome = $1 WHERE id = $2`, [`Novo B ${sfx}`, localB]);
    assert.equal(await dupSaldos(), 0, 'antes da propagação as duas linhas não são duplicata (textos X1/X2)');

    const f1 = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5']);
    assert.notEqual(f1.code, 0, 'a guarda do AFTER-CHECK deve abortar o APPLY');
    assert.match(f1.out, /FALHOU \(fail-closed\)/, 'deve abortar no AFTER-CHECK fail-closed');
    assert.match(f1.out, /duplicatas_saldos=1/, 'deve apontar duplicatas_saldos=1');
    // Nada persistido: os dois textos continuam distintos e o contador de nomes
    // segue com os 2 casos da empresa B (a propagação foi revertida).
    const linhasB = await db.query(`SELECT local FROM estoques WHERE produto_id = $1 ORDER BY id`, [produtoB]);
    assert.deepEqual(linhasB.rows.map((r) => r.local), ['X1', 'X2'], 'a guarda não pode persistir a propagação');
    assert.equal(await dupSaldos(), 0, 'nada persistido: continua sem duplicata');
    assert.equal(await contador(), 2, 'nada persistido: os 2 nomes da empresa B seguem pendentes');

    console.log('\n=== PROD-DB-01.5.1 — wrapper psql validado (banco descartável) ===');
    console.log('  DRY-RUN=no-op | no-confirm=abort | APPLY=69→0+COMMIT | 2ª passada=0 | F1 dup_saldos=ROLLBACK');
  } finally {
    await db.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});