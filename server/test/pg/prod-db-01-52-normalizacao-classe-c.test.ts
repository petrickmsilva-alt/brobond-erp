// ============================================================================
// PROD-DB-01.5.2 — NORMALIZAÇÃO CONTROLADA DE CLASSE C (wrapper real via psql).
//
// Prova, executando o ARQUIVO INTEIRO de db/admin/005-propagar-nomes-locais-e42.sql
// pelo psql real (não uma reimplementação em TypeScript), que a operação de
// normalização classe C ("loja" -> "LOJA") é:
//
//   TESTE 1  DRY-RUN detecta e reporta os casos classe C sem alterar nada;
//   TESTE 2  APPLY sem confirmação aborta (nada alterado);
//   TESTE 3  APPLY sem a flag explícita de classe C aborta (nada alterado);
//   TESTE 4  APPLY com tríplice autorização normaliza SOMENTE o texto, por
//            local_id + empresa_id, preservando id/empresa_id/local_id/quantidade;
//   TESTE 5  pós-validação repete TODOS os preflight counters e exige 0;
//   TESTE 6  idempotência: segunda execução = 0 UPDATEs;
//   TESTE 7  classe A (texto NULL) aborta (nada alterado);
//   TESTE 8  divergência semântica ("LOJA 2") NÃO é classe C e não é alterada;
//   TESTE 9  rollback: falha no AFTER-CHECK reverte tudo;
//   TESTE 10 cross-tenant (local_id de outra empresa) aborta (nada alterado).
//
// O wrapper abre uma transação explícita; por isso o teste usa um BANCO
// DESCARTÁVEL próprio (bootstrap isolado), nunca o banco da suíte.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Exige DATABASE_URL e o
// binário `psql` (PSQL_BIN tem precedência; localmente aceita um shim).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-01-52-normalizacao-classe-c.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
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

function runPsql(url: string, args: string[]): { code: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync(PSQL!, [url, '-v', 'ON_ERROR_STOP=1', ...args], {
    input: readFileSync(SCRIPT, 'utf8'),
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'brobond' },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? -1, stdout, stderr, out: `${stdout}\n${stderr}` };
}

const CONTADOR_SQL = `SELECT
  (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
    WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
    WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
    WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM inventarios inv JOIN locais l ON inv.local_id = l.id
    WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome) AS n`;

// Classificação A/B/C — a MESMA regra do script e do PROD-DB-01.4.
const CLASSES_SQL = `WITH inc AS (
    SELECT e.empresa_id AS reg_emp, l.empresa_id AS loc_emp, e.local AS txt, l.nome AS nome
      FROM estoques e JOIN locais l ON l.id = e.local_id
     WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
    UNION ALL
    SELECT m.empresa_id, l.empresa_id, m.local, l.nome FROM movimentacoes m JOIN locais l ON l.id = m.local_id
     WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
    UNION ALL
    SELECT m.empresa_id, l.empresa_id, m.local_destino, l.nome FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
     WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
    UNION ALL
    SELECT inv.empresa_id, l.empresa_id, inv.local, l.nome FROM inventarios inv JOIN locais l ON l.id = inv.local_id
     WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
  )
  SELECT
    count(*) FILTER (WHERE reg_emp IS DISTINCT FROM loc_emp OR txt IS NULL) AS a,
    count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                       AND lower(btrim(txt)) <> lower(btrim(nome))) AS b,
    count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                       AND lower(btrim(txt)) = lower(btrim(nome)) AND txt IS DISTINCT FROM nome) AS c
  FROM inc`;

const ALL_PREFLIGHT_ZERO_SQL = `SELECT (
  (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
    WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
    WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
    WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
    WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM (SELECT empresa_id, produto_id, tamanho_id, local FROM estoques
     GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1) d) +
  (SELECT count(*) FROM (SELECT empresa_id, nome FROM locais GROUP BY empresa_id, nome HAVING count(*) > 1) d) +
  (SELECT count(*) FROM estoques e LEFT JOIN locais l ON l.id = e.local_id
    WHERE e.local_id IS NOT NULL AND (l.id IS NULL OR e.empresa_id IS DISTINCT FROM l.empresa_id))
) AS pendentes`;

test('PROD-DB-01.5.2 — normalização classe C: dry-run, tríplice autorização, guardas, idempotência e rollback', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const base = new URL(process.env.DATABASE_URL!);
  const scratch = `e42_c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const url = new URL(base.toString());
  url.pathname = `/${scratch}`;
  const scratchUrl = url.toString();
  const db = new Client({ connectionString: scratchUrl });

  const contador = async () => Number((await db.query(CONTADOR_SQL)).rows[0].n);
  const classes = async () => {
    const r = (await db.query(CLASSES_SQL)).rows[0];
    return { a: Number(r.a), b: Number(r.b), c: Number(r.c) };
  };

  try {
    await admin.query(`CREATE DATABASE ${scratch}`);
    const boot = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/db.ts').then((m) => m.migrate());"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' }
    );
    assert.equal(boot.status, 0, `bootstrap do banco descartável falhou:\n${boot.stdout}\n${boot.stderr}`);
    await db.connect();

    // ------------------------------------------------------------------------
    // FIXTURE REAL — réplica do cenário confirmado em produção:
    //   locais(id, empresa_id=1, nome="LOJA")
    //   estoques.local = "loja" (29), movimentacoes.local = "loja" (40)
    // Aqui usamos uma empresa dedicada (não a 1) para não interferir em dados
    // de seed; os invariantes (local canônico + 29/40 textos minúsculos) são os
    // mesmos. Somamos ainda 1 caso classe C numa segunda empresa para provar o
    // isolamento por empresa.
    // ------------------------------------------------------------------------
    const sfx = Date.now().toString(36);
    const cnpj = (prefixo: string) => `${prefixo}${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`;

    const empA = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`CLASSE C A ${sfx}`, cnpj('9')])).rows[0].id);
    const localA = Number((await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', $1, true, true) RETURNING id`, [empA])).rows[0].id);
    const produtosA: number[] = (await db.query(
      `INSERT INTO produtos (sku, nome, empresa_id) SELECT $1 || g, $2 || g, $3 FROM generate_series(1, 29) g RETURNING id`,
      [`SKUC-${sfx}-`, `Prod C ${sfx} `, empA]
    )).rows.map((r) => Number(r.id));
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       SELECT p, NULL, 'loja', $1, 1, $2 FROM unnest($3::int[]) p`,
      [localA, empA, produtosA]
    );
    await db.query(
      `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, quantidade, empresa_id)
       SELECT 'ajuste', $1, 'loja', $2, 1, $3 FROM generate_series(1, 40)`,
      [produtosA[0], localA, empA]
    );

    const empB = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`CLASSE C B ${sfx}`, cnpj('8')])).rows[0].id);
    const localB = Number((await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', $1, true, true) RETURNING id`, [empB])).rows[0].id);
    const produtoB = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKUCB-${sfx}`, `Prod CB ${sfx}`, empB])).rows[0].id);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'loja', $2, 1, $3)`,
      [produtoB, localB, empB]
    );

    const antes = await contador();
    assert.equal(antes, 70, 'a fixture deve reproduzir 69 (empresa A) + 1 (empresa B)');
    assert.deepEqual(await classes(), { a: 0, b: 0, c: 70 }, 'todos devem ser classe C');

    // Snapshot para provar preservação de id/empresa_id/local_id/quantidade.
    const snapAntes = (await db.query(
      `SELECT id, local_id, empresa_id, quantidade, local FROM estoques WHERE empresa_id = $1 ORDER BY id`,
      [empA]
    )).rows;

    // ------------------------------------------------------------------------
    // TESTE 1 — DRY-RUN (sem parâmetros): detecta, reporta e NÃO altera nada.
    // ------------------------------------------------------------------------
    const dry = runPsql(scratchUrl, []);
    assert.equal(dry.code, 0, `DRY-RUN deve sair 0:\n${dry.stderr}`);
    assert.match(dry.out, /BEFORE nomes_locais_inconsistentes=70/, 'DRY-RUN deve registrar BEFORE=70');
    assert.match(dry.out, /origem=estoques\.local A\(vínculo\/null\)=0 C\(caixa\/espaço\)=30 B\(a corrigir\)=0/);
    assert.match(dry.out, /origem=movimentacoes\.local A\(vínculo\/null\)=0 C\(caixa\/espaço\)=40 B\(a corrigir\)=0/);
    assert.match(dry.out, /DRY-RUN contadores: classe_A=0, classe_B=0, classe_C=70, seria_corrigido_classe_B=0, seria_normalizado_classe_C=70, alterados=0/);
    assert.match(dry.out, /DRY-RUN: transação revertida \(ROLLBACK\)/);
    assert.equal(await contador(), 70, 'DRY-RUN não pode alterar o dado');

    // TESTE 1b — DRY-RUN no MODO classe C: reporta quantos seriam normalizados,
    //            ainda sem escrever nada.
    const dryC = runPsql(scratchUrl, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dryC.code, 0, `DRY-RUN modo C deve sair 0:\n${dryC.stderr}`);
    assert.match(dryC.out, /DRY-RUN contadores: classe_A=0, classe_B=0, classe_C=70, seria_corrigido_classe_B=0, seria_normalizado_classe_C=70, alterados=0/);
    assert.match(dryC.out, /DRY-RUN: modo classe C habilitado/);
    assert.match(dryC.out, /DRY-RUN: transação revertida \(ROLLBACK\)/);
    assert.equal(await contador(), 70, 'DRY-RUN modo C não pode alterar o dado');

    // ------------------------------------------------------------------------
    // TESTE 2 — APPLY classe C SEM confirmação textual → aborta, nada alterado.
    // ------------------------------------------------------------------------
    const semConf = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'normalizar_classe_c=on']);
    assert.notEqual(semConf.code, 0, 'APPLY sem confirmação deve falhar');
    assert.match(semConf.out, /APPLY recusado: falta -v confirmacao=PROD-DB-01\.5\.2/);
    assert.equal(await contador(), 70, 'APPLY sem confirmação não pode alterar o dado');

    // ------------------------------------------------------------------------
    // TESTE 3 — APPLY com confirmação 01.5.2 mas SEM a flag de classe C → aborta
    //           (a diferença cosmética continua protegida sem a flag explícita).
    // ------------------------------------------------------------------------
    const semFlag = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2']);
    assert.notEqual(semFlag.code, 0, 'APPLY sem a flag de classe C deve falhar');
    assert.match(semFlag.out, /classe C \(diferença apenas de caixa\/espaço\)/);
    assert.equal(await contador(), 70, 'APPLY sem a flag de classe C não pode alterar o dado');

    // ------------------------------------------------------------------------
    // TESTE 3b — flag de classe C com a confirmação ERRADA (01.5) → aborta.
    // ------------------------------------------------------------------------
    const confErrada = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5', '-v', 'normalizar_classe_c=on']);
    assert.notEqual(confErrada.code, 0, 'confirmação de classe B não autoriza classe C');
    assert.match(confErrada.out, /APPLY recusado: falta -v confirmacao=PROD-DB-01\.5\.2/);
    assert.equal(await contador(), 70, 'confirmação errada não pode alterar o dado');

    // ------------------------------------------------------------------------
    // TESTE 4 — APPLY autorizado (tríplice): normaliza SOMENTE o texto.
    // ------------------------------------------------------------------------
    const apply = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on']);
    assert.equal(apply.code, 0, `APPLY autorizado deve sair 0:\n${apply.stderr}`);
    assert.match(apply.out, /atualizados: estoques\.local=30, movimentacoes\.local=40, movimentacoes\.local_destino=0, inventarios\.local=0 \(total=70\)/);
    assert.match(apply.out, /transação COMITADA/);
    assert.equal(await contador(), 0, 'após o APPLY o contador deve ser 0');

    // Preservação: id, local_id, empresa_id e quantidade NÃO mudam; só o texto.
    const snapDepois = (await db.query(
      `SELECT id, local_id, empresa_id, quantidade, local FROM estoques WHERE empresa_id = $1 ORDER BY id`,
      [empA]
    )).rows;
    assert.equal(snapDepois.length, snapAntes.length);
    for (let i = 0; i < snapAntes.length; i += 1) {
      assert.equal(snapDepois[i].id, snapAntes[i].id, 'id não pode mudar');
      assert.equal(snapDepois[i].local_id, snapAntes[i].local_id, 'local_id não pode mudar');
      assert.equal(snapDepois[i].empresa_id, snapAntes[i].empresa_id, 'empresa_id não pode mudar');
      assert.equal(snapDepois[i].quantidade, snapAntes[i].quantidade, 'quantidade não pode mudar');
      assert.equal(snapDepois[i].local, 'LOJA', 'o texto deve virar o nome canônico');
    }

    // ------------------------------------------------------------------------
    // TESTE 5 — pós-validação: todos os preflight counters relevantes = 0.
    // ------------------------------------------------------------------------
    assert.equal(Number((await db.query(ALL_PREFLIGHT_ZERO_SQL)).rows[0].pendentes), 0, 'todos os preflight counters devem ser 0');

    // ------------------------------------------------------------------------
    // TESTE 6 — idempotência: segunda execução = 0 UPDATEs.
    // ------------------------------------------------------------------------
    const idem = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on']);
    assert.equal(idem.code, 0, `2ª passada deve sair 0:\n${idem.stderr}`);
    assert.match(idem.out, /atualizados: estoques\.local=0, movimentacoes\.local=0, movimentacoes\.local_destino=0, inventarios\.local=0 \(total=0\)/);
    assert.equal(await contador(), 0, '2ª passada deve continuar 0');

    // ------------------------------------------------------------------------
    // TESTE 8 — divergência semântica ("LOJA 2"): NÃO é classe C e não é tocada.
    // ------------------------------------------------------------------------
    const empSem = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`SEMANTICO ${sfx}`, cnpj('7')])).rows[0].id);
    const localSem = Number((await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', $1, true, true) RETURNING id`, [empSem])).rows[0].id);
    const produtoSem = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKUSEM-${sfx}`, `Prod Sem ${sfx}`, empSem])).rows[0].id);
    const estSem = Number((await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'LOJA 2', $2, 1, $3) RETURNING id`,
      [produtoSem, localSem, empSem]
    )).rows[0].id);
    assert.deepEqual(await classes(), { a: 0, b: 1, c: 0 }, '"LOJA 2" deve ser classe B, não C');

    const semDiv = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on']);
    assert.notEqual(semDiv.code, 0, 'classe B não pode ser tratada como cosmética');
    assert.match(semDiv.out, /classe B \(divergência textual real, não cosmética\)/);
    const semDepois = await db.query(`SELECT local FROM estoques WHERE id = $1`, [estSem]);
    assert.equal(semDepois.rows[0].local, 'LOJA 2', 'a divergência semântica não pode ser alterada');
    // limpeza da fixture semântica
    await db.query(`DELETE FROM estoques WHERE id = $1`, [estSem]);
    await db.query(`DELETE FROM produtos WHERE id = $1`, [produtoSem]);
    await db.query(`DELETE FROM locais WHERE id = $1`, [localSem]);
    await db.query(`DELETE FROM empresas WHERE id = $1`, [empSem]);

    // ------------------------------------------------------------------------
    // TESTE 7 — classe A (texto de local NULL com local_id canônico) aborta.
    // ------------------------------------------------------------------------
    const movA = Number((await db.query(
      `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, quantidade, empresa_id)
       VALUES ('ajuste', $1, NULL, $2, 1, $3) RETURNING id`,
      [produtosA[0], localA, empA]
    )).rows[0].id);
    const dryA = runPsql(scratchUrl, []);
    assert.notEqual(dryA.code, 0, 'classe A deve abortar mesmo em DRY-RUN');
    assert.match(dryA.out, /classe A/);
    const movApos = await db.query(`SELECT local FROM movimentacoes WHERE id = $1`, [movA]);
    assert.equal(movApos.rows[0].local, null, 'o caso classe A não pode ser alterado');
    await db.query(`DELETE FROM movimentacoes WHERE id = $1`, [movA]);

    // ------------------------------------------------------------------------
    // TESTE 10 — cross-tenant: local_id pertence à empresa X, registro à Y.
    //            A FK composta impede o estado; removemo-la para reproduzir o
    //            cenário e provar que a guarda classe A aborta.
    // ------------------------------------------------------------------------
    await db.query(`ALTER TABLE estoques DROP CONSTRAINT IF EXISTS fk_e42_estoques_empresa_local`);
    const empX = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`XTENANT X ${sfx}`, cnpj('6')])).rows[0].id);
    const empY = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`XTENANT Y ${sfx}`, cnpj('5')])).rows[0].id);
    const localX = Number((await db.query(`INSERT INTO locais (nome, empresa_id, ativo) VALUES ('LOJA', $1, true) RETURNING id`, [empX])).rows[0].id);
    const produtoY = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKUY-${sfx}`, `Prod Y ${sfx}`, empY])).rows[0].id);
    const estY = Number((await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'loja', $2, 1, $3) RETURNING id`,
      [produtoY, localX, empY]
    )).rows[0].id);
    const dryX = runPsql(scratchUrl, []);
    assert.notEqual(dryX.code, 0, 'cross-tenant deve abortar');
    assert.match(dryX.out, /classe A/);
    const estYdepois = await db.query(`SELECT local, empresa_id, local_id FROM estoques WHERE id = $1`, [estY]);
    assert.equal(estYdepois.rows[0].local, 'loja', 'o vínculo cross-tenant não pode ser alterado');
    assert.equal(Number(estYdepois.rows[0].empresa_id), empY, 'empresa_id não pode mudar');
    assert.equal(Number(estYdepois.rows[0].local_id), localX, 'local_id não pode mudar');
    // limpeza
    await db.query(`DELETE FROM estoques WHERE id = $1`, [estY]);
    await db.query(`DELETE FROM produtos WHERE id = $1`, [produtoY]);
    await db.query(`DELETE FROM locais WHERE id = $1`, [localX]);
    await db.query(`DELETE FROM empresas WHERE id IN ($1, $2)`, [empX, empY]);

    // ------------------------------------------------------------------------
    // TESTE 9 — rollback: a normalização criaria uma duplicata de saldo
    //            (tamanho_id NULL) que o AFTER-CHECK fail-closed detecta.
    //            Removemos o índice canônico (como o wrapper 01.5.1 faz) para
    //            permitir o estado pré-0030 e provar que NADA persiste.
    // ------------------------------------------------------------------------
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id`);
    const empR = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`ROLLBACK ${sfx}`, cnpj('4')])).rows[0].id);
    const localR = Number((await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('PILHA', $1, true, true) RETURNING id`, [empR])).rows[0].id);
    const produtoR = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKUR-${sfx}`, `Prod R ${sfx}`, empR])).rows[0].id);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'pilha', $2, 1, $3)`,
      [produtoR, localR, empR]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'PILHA', $2, 1, $3)`,
      [produtoR, localR, empR]
    );
    const rollback = runPsql(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on']);
    assert.notEqual(rollback.code, 0, 'a guarda fail-closed deve abortar');
    assert.match(rollback.out, /FALHOU \(fail-closed\)/);
    assert.match(rollback.out, /duplicatas_saldos=1/);
    const linhasR = (await db.query(`SELECT local FROM estoques WHERE produto_id = $1 ORDER BY id`, [produtoR])).rows.map((r) => r.local);
    assert.deepEqual(linhasR, ['pilha', 'PILHA'], 'o rollback deve devolver os textos originais');

    console.log('\n=== PROD-DB-01.5.2 — normalização classe C validada (banco descartável) ===');
    console.log('  DRY-RUN=no-op | sem-confirmação=abort | sem-flag=abort | APPLY=70→0+COMMIT | 2ª=0');
    console.log('  classe A=abort | semântico(B)=abort | cross-tenant=abort | dup_saldos=ROLLBACK');
  } finally {
    await db.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
