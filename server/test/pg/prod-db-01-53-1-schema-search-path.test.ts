// ============================================================================
// PROD-DB-01.5.3 (hotfix) — A PREFLIGHT DE COLISÃO DEVE ENXERGAR OS ÍNDICES DA
// TABELA REAL, NÃO OS DO `current_schema()`.
//
// Defeito encontrado em produção: a execução real abortou com
//
//   duplicate key value violates unique constraint
//     "estoques_produto_id_tamanho_id_local_key"
//   Key (produto_id, tamanho_id, local)=(7, 5, LOJA) already exists.
//
// mesmo com a classificação A=0 B=0 C=69 — ou seja, a preflight NÃO detectou a
// colisão antes do UPDATE.
//
// Causa raiz: a varredura do catálogo escopava por `current_schema()`. Esse
// valor é o PRIMEIRO schema EXISTENTE do `search_path` — não necessariamente
// aquele onde as tabelas vivem. Num Postgres gerenciado é comum existir um
// schema com o nome da role conectante; então `current_schema()` devolvia esse
// schema, onde NÃO há índices das tabelas do ERP. A varredura enxergava ZERO
// índices e anunciava "nenhuma colisão", enquanto o UPDATE (sem qualificação de
// schema) resolvia `estoques` corretamente pelo `search_path` e o PostgreSQL
// era quem descobria a violação.
//
// Este teste reproduz EXATAMENTE o caso: produto_id=7, tamanho_id=5, uma linha
// local='LOJA' e outra local='loja' (normalizável para 'LOJA'). O banco
// descartável nasce com um schema extra à frente do `public` no `search_path`,
// de modo que `current_schema()` != schema das tabelas. A prova exige:
//
//   • DRY-RUN detecta a colisão;
//   • APPLY aborta ANTES do UPDATE;
//   • nenhuma linha é alterada;
//   • nenhuma exclusão/merge ocorre;
//   • não há COMMIT.
//
// Sem a correção (escopo por `current_schema()`), o DRY-RUN não detecta e o
// APPLY falha com a mensagem NATIVA de constraint do PostgreSQL — exatamente o
// incidente de produção. Roda no job `testes-postgres` (npm run test:pg).
// Exige DATABASE_URL e o binário `psql` (PSQL_BIN tem precedência).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-01-53-1-schema-search-path.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
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

function runPsqlFile(url: string, args: string[]): { code: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync(PSQL!, [url, '-v', 'ON_ERROR_STOP=1', ...args, '-f', SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'brobond' },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? -1, stdout, stderr, out: `${stdout}\n${stderr}` };
}

const APPLY_C = ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on'];

test('PROD-DB-01.5.3/hotfix — com current_schema() != schema das tabelas, a colisão (7,5,LOJA) ainda é detectada ANTES do UPDATE', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const base = new URL(process.env.DATABASE_URL!);
  const scratch = `e42_sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${scratch}`);
  const url = new URL(base.toString());
  url.pathname = `/${scratch}`;
  const scratchUrl = url.toString();

  const boot = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/db.ts').then((m) => m.migrate());"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' }
  );
  assert.equal(boot.status, 0, `bootstrap do banco descartável falhou:\n${boot.stdout}\n${boot.stderr}`);

  const db = new Client({ connectionString: scratchUrl });
  await db.connect();
  let db2: Client | null = null;

  try {
    // ----------------------------------------------------------------------
    // Reproduz o ambiente do incidente: um schema com o nome da role conectante
    // EXISTE e entra À FRENTE do `public` no search_path. Assim
    // `current_schema()` devolve esse schema, e não onde estão as tabelas.
    // Definido no nível do DATABASE descartável (não vaza para outros testes).
    // ----------------------------------------------------------------------
    const role = (await db.query(`SELECT current_user AS u`)).rows[0].u as string;
    const quotedRole = `"${role.replaceAll('"', '""')}"`;
    await db.query(`CREATE SCHEMA ${quotedRole}`);
    await db.query(`ALTER DATABASE ${scratch} SET search_path = ${quotedRole}, public`);

    // Nova conexão para herdar o search_path definido no banco.
    db2 = new Client({ connectionString: scratchUrl });
    await db2.connect();
    const sess = await db2.query(`SELECT current_schema() AS cs, current_setting('search_path') AS sp`);
    assert.equal(sess.rows[0].cs, role, 'current_schema() deve ser o schema da role (não public)');
    assert.equal(sess.rows[0].sp, `${quotedRole}, public`);

    // ----------------------------------------------------------------------
    // FIXTURE — o CASO EXATO de produção: produto_id=7, tamanho_id=5.
    //   linha 'LOJA' (não normalizável) + linha 'loja' (normalizável p/ 'LOJA').
    // Normalizar 'loja' -> 'LOJA' colidiria na constraint real
    // `estoques_produto_id_tamanho_id_local_key` (produto_id, tamanho_id, local).
    // ----------------------------------------------------------------------
    const sfx = Date.now().toString(36);
    const emp = Number(
      (await db2.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`SP ${sfx}`, `9${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`])).rows[0].id
    );
    const local = Number(
      (await db2.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', $1, true, true) RETURNING id`, [emp])).rows[0].id
    );
    await db2.query(`INSERT INTO tamanhos (id, codigo, descricao) VALUES (5, $1, $1)`, [`T5-${sfx}`]);
    await db2.query(`INSERT INTO produtos (id, sku, nome, empresa_id) VALUES (7, $1, $1, $2)`, [`SKU7-${sfx}`, emp]);
    const estLojaNao = Number(
      (await db2.query(
        `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
         VALUES (7, 5, 'LOJA', NULL, 10, $1) RETURNING id`,
        [emp]
      )).rows[0].id
    );
    const estLoja = Number(
      (await db2.query(
        `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
         VALUES (7, 5, 'loja', $1, 20, $2) RETURNING id`,
        [local, emp]
      )).rows[0].id
    );

    const snapshot = async () =>
      (await db2.query(
        `SELECT id, produto_id, tamanho_id, local, local_id, empresa_id, quantidade
           FROM estoques WHERE produto_id = 7 ORDER BY id`
      )).rows;
    const antes = await snapshot();
    assert.equal(antes.length, 2, 'a fixture deve ter exatamente as duas linhas do incidente');

    // ----------------------------------------------------------------------
    // (7) DRY-RUN deve REPORTAR a colisão (com current_schema() != tabela).
    // ----------------------------------------------------------------------
    const dry = runPsqlFile(scratchUrl, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dry.code, 0, `DRY-RUN deve sair 0:\n${dry.stderr}`);
    assert.match(
      dry.out,
      /E4\.2\/01\.5\.3 COLISÃO: tabela=estoques índice=estoques_produto_id_tamanho_id_local_key coluna=local chaves_conflitantes=1 linhas_envolvidas=2/,
      'o DRY-RUN deve detectar a colisão mesmo com current_schema() != schema das tabelas'
    );
    assert.match(dry.out, /chave_conflitante=\{"local": "LOJA", "produto_id": 7, "tamanho_id": 5\}/);
    assert.match(dry.out, /local_atual=\{LOJA,loja\}/);
    assert.match(dry.out, new RegExp(`registros=\\{[^}]*\\b${estLojaNao}\\b[^}]*\\}`));
    assert.match(dry.out, new RegExp(`registros=\\{[^}]*\\b${estLoja}\\b[^}]*\\}`));
    assert.match(dry.out, /E4\.2\/01\.5\.3 DRY-RUN: 1 colisão\(ões\) de chave única detectada\(s\) \(2 linha\(s\)\)/);
    assert.match(dry.out, /DRY-RUN: transação revertida \(ROLLBACK\)/);
    assert.deepEqual(await snapshot(), antes, 'o DRY-RUN não pode alterar o dado');

    // ----------------------------------------------------------------------
    // (6)(11)(12) APPLY: aborta ANTES do UPDATE, sem alterar nada, sem
    //             exclusão/merge e sem COMMIT. O PostgreSQL NUNCA chega a
    //             descobrir a violação.
    // ----------------------------------------------------------------------
    const apply = runPsqlFile(scratchUrl, APPLY_C);
    assert.notEqual(apply.code, 0, 'APPLY com colisão deve abortar');
    assert.match(
      apply.out,
      /E4\.2\/01\.5\.3 ABORTADO: a normalização classe C faria 1 chave\(s\) única\(s\) colidir \(2 linha\(s\) envolvida\(s\)\)\. Nenhum UPDATE foi executado/
    );
    assert.doesNotMatch(apply.out, /transação COMITADA/, 'não pode haver COMMIT');
    assert.doesNotMatch(apply.out, /E4\.2\/01\.5 atualizados:/, 'nenhum UPDATE pode ter sido executado');
    assert.doesNotMatch(
      apply.out,
      /duplicate key value violates unique constraint/,
      'o PostgreSQL não pode ser quem descobre a violação (a preflight aborta antes)'
    );
    // Nenhuma linha alterada, nenhuma removida: snapshot byte a byte idêntico.
    assert.deepEqual(await snapshot(), antes, 'o APPLY abortado não pode alterar NENHUMA linha');
    assert.equal((await snapshot()).length, 2, 'nenhuma linha pode ter sido excluída ou mesclada');

    console.log('\n=== PROD-DB-01.5.3/hotfix — preflight escopa pela tabela REAL ===');
    console.log(`  current_schema()=${role} (schema da role, não public) → colisão 7/5 LOJA detectada`);
    console.log('  DRY-RUN=colisão reportada | APPLY=abortado antes do UPDATE | sem COMMIT | sem merge/exclusão');
  } finally {
    await db2?.end().catch(() => undefined);
    await db.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
