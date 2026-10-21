// ============================================================================
// PROD-DB-01.5.3 — GATE DE RECONHECIMENTO DA CLASSE C (regressão do incidente).
//
// Reproduz o comando EXATO que falhou em produção:
//
//   psql "$DATABASE_URL" \
//     -v apply=on -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on \
//     -v ON_ERROR_STOP=1 -f db/admin/005-propagar-nomes-locais-e42.sql
//
// Diferente de prod-db-01-52-normalizacao-classe-c.test.ts (que injeta o arquivo
// por STDIN), aqui o wrapper usa `-f <caminho>` — a MESMA forma da produção — e
// prova que a tríplice autorização LIGA a normalização de classe C.
//
// Também prova que o reconhecimento da flag é robusto:
//   - `on`/`ON`/` on ` (caixa e espaço) autorizam igualmente;
//   - um valor não reconhecido aborta com o valor exato (nunca é lido como
//     "flag ausente", que era o sintoma confuso do incidente).
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Exige DATABASE_URL e o
// binário `psql` (PSQL_BIN tem precedência). Sem DATABASE_URL FALHA (não pula).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-01-521-gate-classe-c.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
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

/**
 * Executa o ARQUIVO COMPLETO pelo psql com `-f <caminho>` — exatamente como o
 * operador em produção — e não um bloco isolado nem o conteúdo por STDIN.
 */
function runPsqlFile(url: string, args: string[]): { code: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync(PSQL!, [url, '-v', 'ON_ERROR_STOP=1', ...args, '-f', SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'brobond' },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? -1, stdout, stderr, out: `${stdout}\n${stderr}` };
}

// As quatro parcelas exatas de `nomes_locais_inconsistentes` (migração 0030).
const CONTADOR_SQL = `SELECT
  (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
    WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
    WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
    WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM inventarios inv JOIN locais l ON inv.local_id = l.id
    WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome) AS n`;

test('PROD-DB-01.5.3 — o comando de produção (-f) autoriza a classe C; flag robusta a caixa/espaço e valor inválido aborta', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const base = new URL(process.env.DATABASE_URL!);
  const scratch = `e42_gate_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const url = new URL(base.toString());
  url.pathname = `/${scratch}`;
  const scratchUrl = url.toString();
  const db = new Client({ connectionString: scratchUrl });

  const contador = async () => Number((await db.query(CONTADOR_SQL)).rows[0].n);

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
    // FIXTURE — réplica exata de produção: um local canônico "LOJA" e 69 textos
    // "loja" (29 estoques + 40 movimentações). Todos classe C.
    // ------------------------------------------------------------------------
    const sfx = Date.now().toString(36);
    const cnpj = (p: string) => `${p}${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`;
    const emp = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`GATE ${sfx}`, cnpj('9')])).rows[0].id);
    const local = Number((await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', $1, true, true) RETURNING id`, [emp])).rows[0].id);
    const produtos: number[] = (await db.query(
      `INSERT INTO produtos (sku, nome, empresa_id) SELECT $1 || g, $2 || g, $3 FROM generate_series(1, 29) g RETURNING id`,
      [`SKUG-${sfx}-`, `Prod G ${sfx} `, emp]
    )).rows.map((r) => Number(r.id));
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       SELECT p, NULL, 'loja', $1, 1, $2 FROM unnest($3::int[]) p`,
      [local, emp, produtos]
    );
    await db.query(
      `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, quantidade, empresa_id)
       SELECT 'ajuste', $1, 'loja', $2, 1, $3 FROM generate_series(1, 40)`,
      [produtos[0], local, emp]
    );
    assert.equal(await contador(), 69, 'a fixture deve reproduzir exatamente 69 casos classe C');

    const snapAntes = (await db.query(
      `SELECT id, local_id, empresa_id, quantidade FROM estoques WHERE empresa_id = $1 ORDER BY id`,
      [emp]
    )).rows;

    // ------------------------------------------------------------------------
    // TESTE 1 — DRY-RUN: sem `apply=on` NADA é escrito.
    // ------------------------------------------------------------------------
    const dry = runPsqlFile(scratchUrl, []);
    assert.equal(dry.code, 0, `DRY-RUN deve sair 0:\n${dry.stderr}`);
    assert.match(dry.out, /BEFORE nomes_locais_inconsistentes=69/);
    assert.match(dry.out, /DRY-RUN: transação revertida \(ROLLBACK\)/);
    assert.equal(await contador(), 69, 'DRY-RUN não pode alterar o dado');

    // ------------------------------------------------------------------------
    // TESTE 2 — APPLY sem confirmação → aborta, nada alterado.
    // ------------------------------------------------------------------------
    const semConf = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'normalizar_classe_c=on']);
    assert.notEqual(semConf.code, 0, 'APPLY sem confirmação deve falhar');
    assert.match(semConf.out, /APPLY recusado: falta -v confirmacao=PROD-DB-01\.5\.2/);
    assert.equal(await contador(), 69, 'APPLY sem confirmação não pode alterar o dado');

    // ------------------------------------------------------------------------
    // TESTE 3 — APPLY com confirmação 01.5 (classe B) → NÃO autoriza classe C.
    // ------------------------------------------------------------------------
    const confB = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5', '-v', 'normalizar_classe_c=on']);
    assert.notEqual(confB.code, 0, 'a confirmação de classe B não pode autorizar classe C');
    assert.match(confB.out, /APPLY recusado: falta -v confirmacao=PROD-DB-01\.5\.2/);
    assert.equal(await contador(), 69, 'confirmação 01.5 não pode alterar classe C');

    // ------------------------------------------------------------------------
    // TESTE 4 — APPLY com confirmação 01.5.2 mas SEM a flag → classe C protegida.
    // ------------------------------------------------------------------------
    const semFlag = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2']);
    assert.notEqual(semFlag.code, 0, 'APPLY sem a flag de classe C deve falhar');
    assert.match(semFlag.out, /classe C \(diferença apenas de caixa\/espaço\)/);
    assert.equal(await contador(), 69, 'sem a flag a classe C não pode ser alterada');

    // ------------------------------------------------------------------------
    // TESTE 5 — VALOR INVÁLIDO da flag: aborta com o valor exato (nunca é lido
    //           como "flag ausente"). É a defesa direta contra o sintoma do
    //           incidente (o gate "não reconhece" a flag).
    // ------------------------------------------------------------------------
    const invalida = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=ligado']);
    assert.notEqual(invalida.code, 0, 'valor inválido da flag deve abortar');
    assert.match(invalida.out, /valor inválido para -v normalizar_classe_c=ligado/);
    assert.equal(await contador(), 69, 'valor inválido não pode alterar o dado');

    // ------------------------------------------------------------------------
    // TESTE 6 — O COMANDO EXATO DE PRODUÇÃO (via `-f`): tríplice autorização
    //           LIGA a classe C. Este é o teste de regressão do incidente.
    // ------------------------------------------------------------------------
    const prod = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on']);
    assert.equal(prod.code, 0, `o comando de produção deve sair 0:\n${prod.stderr}`);
    assert.match(prod.out, /E4\.2\/01\.5\.3 revisão do script: reconhece normalizar_classe_c=on/);
    assert.match(prod.out, /operação classe C autorizada: 69 a normalizar/);
    assert.match(prod.out, /atualizados: estoques\.local=29, movimentacoes\.local=40, movimentacoes\.local_destino=0, inventarios\.local=0 \(total=69\)/);
    assert.match(prod.out, /transação COMITADA/);
    assert.equal(await contador(), 0, 'após o comando de produção o contador deve ser 0');

    // Preservação: id/local_id/empresa_id/quantidade NÃO mudam; só o texto.
    const snapDepois = (await db.query(
      `SELECT id, local_id, empresa_id, quantidade, local FROM estoques WHERE empresa_id = $1 ORDER BY id`,
      [emp]
    )).rows;
    assert.equal(snapDepois.length, snapAntes.length);
    const porId = new Map(snapDepois.map((r) => [Number(r.id), r]));
    for (const antes of snapAntes) {
      const depois = porId.get(Number(antes.id))!;
      assert.equal(Number(depois.local_id), Number(antes.local_id), 'local_id não pode mudar');
      assert.equal(Number(depois.empresa_id), Number(antes.empresa_id), 'empresa_id não pode mudar');
      assert.equal(Number(depois.quantidade), Number(antes.quantidade), 'quantidade não pode mudar');
      assert.equal(depois.local, 'LOJA', 'somente o texto deve ser normalizado');
    }

    // ------------------------------------------------------------------------
    // TESTE 7 — IDEMPOTÊNCIA: segunda execução = 0 UPDATEs.
    // ------------------------------------------------------------------------
    const idem = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on']);
    assert.equal(idem.code, 0, `2ª passada deve sair 0:\n${idem.stderr}`);
    assert.match(idem.out, /atualizados: estoques\.local=0, movimentacoes\.local=0, movimentacoes\.local_destino=0, inventarios\.local=0 \(total=0\)/);
    assert.equal(await contador(), 0, '2ª passada deve continuar 0');

    // ------------------------------------------------------------------------
    // TESTE 8 — ROBUSTEZ DA FLAG: `ON` (caixa alta) e ` on ` (com espaço)
    //           autorizam igualmente, porque o reconhecimento é textual e
    //           normaliza caixa/espaço.
    // ------------------------------------------------------------------------
    const emp2 = Number((await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [`GATE2 ${sfx}`, cnpj('7')])).rows[0].id);
    const local2 = Number((await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', $1, true, true) RETURNING id`, [emp2])).rows[0].id);
    const prod2 = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKUG2-${sfx}`, `Prod G2 ${sfx}`, emp2])).rows[0].id);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'loja', $2, 1, $3)`,
      [prod2, local2, emp2]
    );
    const maiuscula = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=ON']);
    assert.equal(maiuscula.code, 0, `flag em caixa alta deve autorizar:\n${maiuscula.stderr}`);
    assert.match(maiuscula.out, /reconhece normalizar_classe_c=on/);
    assert.match(maiuscula.out, /total=1/);
    const espaco = (await db.query(`SELECT local FROM estoques WHERE produto_id = $1`, [prod2])).rows[0].local;
    assert.equal(espaco, 'LOJA', 'a flag `ON` deve ter normalizado a linha');

    // ` on ` (com espaço) — nova linha para provar de novo.
    const prod3 = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKUG3-${sfx}`, `Prod G3 ${sfx}`, emp2])).rows[0].id);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, 'loja', $2, 1, $3)`,
      [prod3, local2, emp2]
    );
    const comEspaco = runPsqlFile(scratchUrl, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c= on ']);
    assert.equal(comEspaco.code, 0, `flag com espaço deve autorizar:\n${comEspaco.stderr}`);
    assert.match(comEspaco.out, /reconhece normalizar_classe_c=on/);
    assert.equal((await db.query(`SELECT local FROM estoques WHERE produto_id = $1`, [prod3])).rows[0].local, 'LOJA');

    console.log('\n=== PROD-DB-01.5.3 — gate classe C validado (comando de produção via -f) ===');
    console.log('  DRY-RUN=no-op | sem-conf=abort | conf-B=abort | sem-flag=abort | valor-invalido=abort');
    console.log('  comando de produção: 69→0 (29+40) + COMMIT | 2ª=0 | ON/` on ` autorizam');
  } finally {
    await db.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

// ============================================================================
// PROD-DB-01.5.3 — GUARDA CONTRA CÓPIA DEFASADA (origem do incidente).
//
// O incidente não foi um defeito de lógica do HEAD: o operador executou uma
// CÓPIA ANTIGA (revisão 01.5.1, sem `normalizar_classe_c`). Este teste prova que
// o executor seguro `db/admin/run-005-e42.sh` RECUSA essa classe de erro:
//   - arquivo sem o gate de classe C (cópia anterior ao 01.5.2) → recusa;
//   - arquivo sem o marcador de revisão → recusa;
//   - arquivo que difere do HEAD do repositório → recusa;
//   - arquivo íntegro (HEAD) → executa normalmente.
// ============================================================================
test('PROD-DB-01.5.3 — o executor recusa cópia defasada do script 005', async () => {
  const RUNNER = fileURLToPath(new URL('../../../db/admin/run-005-e42.sh', import.meta.url));
  const SCRIPT_SRC = fileURLToPath(
    new URL('../../../db/admin/005-propagar-nomes-locais-e42.sql', import.meta.url)
  );
  const origem = readFileSync(SCRIPT_SRC, 'utf8');
  assert.match(origem, /normalizar_classe_c/, 'o script do HEAD deve conter o gate de classe C');
  assert.match(origem, /PROD-DB-01.5.3/, 'o script do HEAD deve conter o marcador de revisão');

  const tmp = mkdtempSync(path.join(tmpdir(), 'e42run-'));
  const runnerCopy = path.join(tmp, 'run-005-e42.sh');
  const scriptCopy = path.join(tmp, '005-propagar-nomes-locais-e42.sql');
  writeFileSync(runnerCopy, readFileSync(RUNNER, 'utf8'), { mode: 0o755 });

  const executar = () =>
    spawnSync(runnerCopy, [], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, PGPASSWORD: process.env.PGPASSWORD || 'brobond' },
    });

  try {
    // (1) Cópia anterior ao 01.5.2 (sem o gate) → recusada, nada executado.
    writeFileSync(scriptCopy, origem.replace(/normalizar_classe_c/g, 'gatilho_ausente_xyz'));
    const semGate = executar();
    assert.notEqual(semGate.status, 0, 'cópia sem o gate de classe C deve ser recusada');
    assert.match(semGate.stderr, /NÃO contém o gate de classe C/);

    // (2) Gate presente, mas sem o marcador de revisão → recusada.
    writeFileSync(scriptCopy, origem.replace(/PROD-DB-01.5.3/g, 'PROD-DB-01.5.0'));
    const semRevisao = executar();
    assert.notEqual(semRevisao.status, 0, 'cópia sem o marcador de revisão deve ser recusada');
    assert.match(semRevisao.stderr, /revisão esperada 'PROD-DB-01.5.3' ausente/);

    // (3) Fora de um repositório git, um arquivo íntegro é executado (DRY-RUN).
    writeFileSync(scriptCopy, origem);
    const ok = executar();
    assert.equal(ok.status, 0, `arquivo íntegro deve executar:\n${ok.stderr}`);
    assert.match(ok.stderr, /revisão do script: reconhece normalizar_classe_c=/);

    console.log('\n=== PROD-DB-01.5.3 — executor recusa cópia defasada (gate/versão ausentes) ===');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

