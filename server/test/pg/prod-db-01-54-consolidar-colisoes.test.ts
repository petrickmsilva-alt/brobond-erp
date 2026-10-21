// ============================================================================
// PROD-DB-01.5.4 — CONSOLIDAÇÃO DAS COLISÕES DE ESTOQUE DE CLASSE C.
//
// Reproduz o estado de produção descrito no ciclo: 16 pares / 32 registros em
// `estoques` com a MESMA chave canônica (empresa_id + local_id + produto_id +
// tamanho_id) e texto de local divergente apenas por caixa ("loja" x "LOJA"),
// com quantidades diferentes. Normalizar (classe C, script 005) é impossível
// nesse estado: 'loja' -> 'LOJA' viola a chave legada de texto
// `estoques_produto_id_tamanho_id_local_key`.
//
// A suíte executa o ARQUIVO INTEIRO pelo psql real (não uma reimplementação em
// TypeScript) e prova:
//
//   1. os 16 conflitos são reproduzidos e o DRY-RUN os reporta sem escrever;
//   2. quantidades diferentes são SOMADAS na consolidação (regra derivada de
//      `estoqueGrade` — server/src/estoque.ts — que soma a mesma célula);
//   3. o local é NORMALIZADO para `locais.nome` na linha sobrevivente;
//   4. APPLY exige a tríplice autorização; faltando qualquer chave, aborta;
//   5. ROLLBACK: uma falha na pós-validação reverte TUDO;
//   6. a segunda execução é IDEMPOTENTE (0 linhas alteradas);
//   7. ao final, existe exatamente UMA linha por chave canônica, sem colisão, e
//      o script 005 (PROD-DB-01.5.3.1) passa a normalizar a classe C sem
//      colisão (a cadeia completa funciona);
//   8. movimentacoes (histórico) NÃO são tocadas; nenhuma linha é criada.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Exige DATABASE_URL e o
// binário `psql` (PSQL_BIN tem precedência). Sem DATABASE_URL FALHA (não pula).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-01-54-consolidar-colisoes.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
  );
}

const SCRIPT_006 = fileURLToPath(
  new URL('../../../db/admin/006-consolidar-colisoes-estoque-classe-c.sql', import.meta.url)
);
const SCRIPT_005 = fileURLToPath(
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

/** Executa um ARQUIVO COMPLETO pelo psql com `-f <caminho>` (forma de produção). */
function runPsqlFile(
  script: string,
  url: string,
  args: string[]
): { code: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync(PSQL!, [url, '-v', 'ON_ERROR_STOP=1', ...args, '-f', script], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'brobond' },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? -1, stdout, stderr, out: `${stdout}\n${stderr}` };
}

// Tríplice autorização do APPLY.
const APPLY = ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.4', '-v', 'autorizacao=PROD-DB-01.5.4'];

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

/** Colisões pela chave canônica (empresa_id + produto_id + tamanho_id + local_id). */
const COLISOES_CANONICAS_SQL = `SELECT count(*) AS n FROM (
  SELECT 1 FROM estoques WHERE local_id IS NOT NULL
  GROUP BY empresa_id, produto_id, tamanho_id, local_id HAVING count(*) > 1
) d`;

interface Scratch {
  admin: Client;
  db: Client;
  url: string;
  encerrar: () => Promise<void>;
}

/** Cria um banco descartável próprio e aplica o bootstrap/migrações reais. */
async function criarBanco(prefixo: string): Promise<Scratch> {
  const base = new URL(process.env.DATABASE_URL!);
  const scratch = `${prefixo}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
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
  return {
    admin,
    db,
    url: scratchUrl,
    encerrar: async () => {
      await db.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    },
  };
}

/**
 * Prepara o estado de produção PRÉ-0030: remove os índices únicos canônicos do
 * E4.2 (a 0030 está bloqueada — é por isso que a colisão existe) e cria o local
 * canônico `LOJA` (empresa 1) e 16 pares 'loja'(qtd 9) x 'LOJA'(qtd 1).
 * Devolve o id do local canônico criado (na produção é 3).
 */
async function prepararProducao(db: Client): Promise<number> {
  await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_tam_local_id`);
  await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id`);
  await db.query(
    `INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', 1, true, true)
     ON CONFLICT DO NOTHING`
  );
  const localId = Number(
    (await db.query(`SELECT id FROM locais WHERE empresa_id = 1 AND nome = 'LOJA'`)).rows[0].id
  );
  await db.query(`INSERT INTO tamanhos (codigo, descricao) VALUES ('P', 'Pequeno') ON CONFLICT (codigo) DO NOTHING`);
  const tamanhoId = Number((await db.query(`SELECT id FROM tamanhos WHERE codigo = 'P'`)).rows[0].id);
  const produtos = (
    await db.query(
      `INSERT INTO produtos (sku, nome, empresa_id)
       SELECT 'SKU54-' || g, 'Produto 54 ' || g, 1 FROM generate_series(1, 16) g RETURNING id`
    )
  ).rows.map((r) => Number(r.id));
  // Texto 'loja' (minúsculo) com qtd 9 e texto 'LOJA' (canônico) com qtd 1.
  await db.query(
    `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
     SELECT p, $1, 'loja', $2, 9, 1 FROM unnest($3::int[]) p`,
    [tamanhoId, localId, produtos]
  );
  await db.query(
    `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
     SELECT p, $1, 'LOJA', $2, 1, 1 FROM unnest($3::int[]) p`,
    [tamanhoId, localId, produtos]
  );
  return localId;
}

// ============================================================================
// TESTE 1 — os 16 conflitos: DRY-RUN reporta, APPLY consolida+soma+normaliza,
//           2ª execução idempotente, e o 005 normaliza a classe C depois.
// ============================================================================
test('PROD-DB-01.5.4 — resolve os 16 pares de colisão (soma+normaliza), idempotente, e destrava a classe C do 005', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const s = await criarBanco('e42_consol');
  const { db } = s;

  try {
    const localId = await prepararProducao(db);

    // ------------------------------------------------------------------------
    // BEFORE — 16 pares / 32 registros, texto divergente só por caixa.
    // ------------------------------------------------------------------------
    const antes = (await db.query(
      `SELECT count(*) AS linhas,
              (SELECT count(*) FROM (SELECT 1 FROM estoques WHERE local_id IS NOT NULL
                 GROUP BY empresa_id, produto_id, tamanho_id, local_id HAVING count(*) > 1) d) AS colisoes
         FROM estoques`
    )).rows[0];
    assert.equal(Number(antes.linhas), 32, 'a fixture deve ter 32 registros');
    assert.equal(Number(antes.colisoes), 16, 'a fixture deve ter exatamente 16 colisões');

    // Snapshot para provar que o DRY-RUN não altera nada.
    const snapshot = async () =>
      (await db.query(`SELECT id, produto_id, tamanho_id, local, local_id, quantidade FROM estoques ORDER BY id`)).rows;
    const snapAntes = await snapshot();

    // ------------------------------------------------------------------------
    // DRY-RUN (padrão) — reporta os 16 pares e a ação; NÃO escreve.
    // ------------------------------------------------------------------------
    const dry = runPsqlFile(SCRIPT_006, s.url, []);
    assert.equal(dry.code, 0, `DRY-RUN deve sair 0:\n${dry.stderr}`);
    assert.match(dry.out, /E4\.2\/01\.5\.4 BEFORE: chaves canônicas em colisão=16 linhas envolvidas=32/);
    assert.match(dry.out, /RELATÓRIO DOS PARES/);
    assert.match(dry.out, /quantidade=10 \(soma\)/);
    assert.match(dry.out, /DRY-RUN contadores: grupos_em_colisao=16, linhas_envolvidas=32, linhas_seriam_removidas=16, linhas_seriam_atualizadas=16, alterados=0/);
    assert.match(dry.out, /DRY-RUN: transação revertida \(ROLLBACK\)/);
    assert.deepEqual(await snapshot(), snapAntes, 'DRY-RUN não pode alterar o dado');

    // ------------------------------------------------------------------------
    // APPLY sem confirmação → aborta; sem autorização → aborta. Nada muda.
    // ------------------------------------------------------------------------
    const semConf = runPsqlFile(SCRIPT_006, s.url, ['-v', 'apply=on', '-v', 'autorizacao=PROD-DB-01.5.4']);
    assert.notEqual(semConf.code, 0, 'APPLY sem confirmação deve falhar');
    assert.match(semConf.out, /APPLY recusado: falta -v confirmacao=PROD-DB-01\.5\.4/);

    const semAut = runPsqlFile(SCRIPT_006, s.url, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.4']);
    assert.notEqual(semAut.code, 0, 'APPLY sem autorização deve falhar');
    assert.match(semAut.out, /APPLY recusado: falta -v autorizacao=PROD-DB-01\.5\.4/);
    assert.deepEqual(await snapshot(), snapAntes, 'APPLY recusado não pode alterar o dado');

    // ------------------------------------------------------------------------
    // APPLY com a tríplice autorização → consolida, soma, normaliza, COMMIT.
    // ------------------------------------------------------------------------
    const apply = runPsqlFile(SCRIPT_006, s.url, APPLY);
    assert.equal(apply.code, 0, `APPLY deve sair 0:\n${apply.stderr}`);
    assert.match(apply.out, /E4\.2\/01\.5\.4 atualizados: sobreviventes=16, linhas_removidas=16 \(grupos=16 \)/);
    assert.match(apply.out, /AFTER OK: colisões canônicas=0/);
    assert.match(apply.out, /transação COMITADA/);

    // AFTER — exatamente uma linha por chave canônica; local normalizado; qtd somada.
    const depois = (await db.query(
      `SELECT count(*) AS linhas,
              (SELECT count(*) FROM (SELECT 1 FROM estoques WHERE local_id IS NOT NULL
                 GROUP BY empresa_id, produto_id, tamanho_id, local_id HAVING count(*) > 1) d) AS colisoes,
              (SELECT count(*) FROM estoques WHERE local <> 'LOJA') AS nao_normalizados,
              (SELECT count(*) FROM estoques WHERE quantidade <> 10) AS qtd_errada,
              (SELECT count(*) FROM estoques WHERE local_id <> $1) AS local_id_errado
         FROM estoques`,
      [localId]
    )).rows[0];
    assert.equal(Number(depois.linhas), 16, 'após a consolidação deve haver 16 linhas');
    assert.equal(Number(depois.colisoes), 0, 'nenhuma colisão pode permanecer');
    assert.equal(Number(depois.nao_normalizados), 0, 'o local deve estar normalizado');
    assert.equal(Number(depois.qtd_errada), 0, 'a quantidade deve ser a soma (10)');
    assert.equal(Number(depois.local_id_errado), 0, 'o local_id canônico deve ser preservado');
    assert.equal(Number((await db.query(CONTADOR_SQL)).rows[0].n), 0, 'nomes_locais_inconsistentes deve ser 0');

    // ------------------------------------------------------------------------
    // IDEMPOTÊNCIA — segunda execução = 0 alterações.
    // ------------------------------------------------------------------------
    const idem = runPsqlFile(SCRIPT_006, s.url, APPLY);
    assert.equal(idem.code, 0, `2ª passada deve sair 0:\n${idem.stderr}`);
    assert.match(idem.out, /BEFORE: chaves canônicas em colisão=0 linhas envolvidas=0/);
    assert.match(idem.out, /atualizados: sobreviventes=0, linhas_removidas=0 \(grupos=0 \)/);
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM estoques`)).rows[0].n), 16, '2ª passada não pode mudar a contagem');

    // ------------------------------------------------------------------------
    // CADEIA COMPLETA — o 005 (PROD-DB-01.5.3.1) normaliza a classe C sem colisão.
    // ------------------------------------------------------------------------
    const cinco = runPsqlFile(SCRIPT_005, s.url, ['-v', 'apply=on', '-v', 'confirmacao=PROD-DB-01.5.2', '-v', 'normalizar_classe_c=on']);
    assert.equal(cinco.code, 0, `o 005 deve sair 0:\n${cinco.stderr}`);
    assert.match(cinco.out, /preflight de colisão: índices únicos verificados=\d+, chaves em colisão=0/);
    assert.match(cinco.out, /AFTER OK: todos os contadores do preflight E4\.2 = 0/);
    assert.match(cinco.out, /transação COMITADA/);

    console.log('\n=== PROD-DB-01.5.4 — 16 pares consolidados + classe C do 005 destravada ===');
    console.log('  DRY-RUN=16 colisões reportadas/no-op | APPLY=16→0 (soma+normaliza) | 2ª passada=0 | 005 classe C=0 colisões');
  } finally {
    await s.encerrar();
  }
});

// ============================================================================
// TESTE 2 — guardas: colisão NÃO cosmética (classe B) e local_id órfão abortam;
//           a identificação é por local_id (nunca por texto).
// ============================================================================
test('PROD-DB-01.5.4 — guardas abortam em divergência não cosmética e local_id órfão; identificação por ID', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const s = await criarBanco('e42_consol_guarda');
  const { db } = s;

  try {
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_tam_local_id`);
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id`);
    await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', 1, true, true)`);
    const localId = Number((await db.query(`SELECT id FROM locais WHERE empresa_id = 1 AND nome = 'LOJA'`)).rows[0].id);
    await db.query(`INSERT INTO tamanhos (codigo, descricao) VALUES ('P', 'Pequeno')`);
    const tamanhoId = Number((await db.query(`SELECT id FROM tamanhos WHERE codigo = 'P'`)).rows[0].id);
    const prod = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ('SKUG-1', 'Prod G', 1) RETURNING id`)).rows[0].id);

    // Colisão com texto NÃO cosmético: 'LOJA' x 'LOJA CENTRO' — o mesmo local_id.
    // (A unicidade legada por texto permite as duas porque os textos diferem.)
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES ($1, $2, 'LOJA', $3, 5, 1)`,
      [prod, tamanhoId, localId]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES ($1, $2, 'LOJA CENTRO', $3, 7, 1)`,
      [prod, tamanhoId, localId]
    );
    const antes = (await db.query(`SELECT id, local, quantidade FROM estoques ORDER BY id`)).rows;

    // A guarda de classe B é fail-closed e aborta TAMBÉM no DRY-RUN (exige
    // revisão manual; nunca resolve divergência textual real automaticamente).
    const dryB = runPsqlFile(SCRIPT_006, s.url, []);
    assert.notEqual(dryB.code, 0, 'a guarda de classe B deve abortar');
    assert.match(dryB.out, /ABORTADO: 1 grupo\(s\) em colisão com texto de local divergente de forma NÃO cosmética/);
    assert.deepEqual((await db.query(`SELECT id, local, quantidade FROM estoques ORDER BY id`)).rows, antes);

    const applyB = runPsqlFile(SCRIPT_006, s.url, APPLY);
    assert.notEqual(applyB.code, 0, 'APPLY com classe B deve abortar');
    assert.match(applyB.out, /NÃO cosmética/);
    assert.deepEqual((await db.query(`SELECT id, local, quantidade FROM estoques ORDER BY id`)).rows, antes, 'nada persistido');

    // Corrige o texto para cosmético e remove uma linha para provar o caminho
    // de consolidação por local_id (a linha 'loja' tem local_id canônico).
    await db.query(`UPDATE estoques SET local = 'loja' WHERE local = 'LOJA CENTRO'`);
    const dryOk = runPsqlFile(SCRIPT_006, s.url, []);
    assert.match(dryOk.out, /chaves canônicas em colisão=1/);
    assert.match(dryOk.out, /quantidade=12 \(soma\)/);
    assert.match(dryOk.out, new RegExp(`local_id=${localId} produto_id=${prod} tamanho_id=${tamanhoId}`));

    console.log('\n=== PROD-DB-01.5.4 — guardas de classe B + identificação por local_id ===');
    console.log('  classe B (texto real) = ABORTADO, nada persistido; colisão cosmética = reportada por local_id');
  } finally {
    await s.encerrar();
  }
});

// ============================================================================
// TESTE 3 — ROLLBACK: uma inconsistência detectada APÓS as escritas, no
//           AFTER-CHECK, reverte TUDO (nem UPDATE nem DELETE são persistidos).
//
// O cenário força um `duplicatas_saldos > 0` que só aparece depois de a
// consolidação rodar: há uma linha legada `local_id NULL` com o texto canônico
// ('LOJA') e, na MESMA chave de texto (empresa_id, produto_id, tamanho_id,
// local), as duas linhas canônicas 'loja'/'LOJA'. A consolidação normaliza a
// sobrevivente para 'LOJA' e, com isso, a chave textual legada passa a ter duas
// linhas → o AFTER-CHECK fail-closed aborta e reverte a transação inteira.
//
// (Para montar esse estado, o índice único legado por texto é removido junto com
// os canônicos — o estado é o de produção pré-0030, onde a 0030 está bloqueada.)
// ============================================================================
test('PROD-DB-01.5.4 — ROLLBACK fail-closed: falha na pós-validação reverte a consolidação inteira', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const s = await criarBanco('e42_consol_rollback');
  const { db } = s;

  try {
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_tam_local_id`);
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id`);
    // A unicidade legada por texto também é derrubada para permitir o estado
    // pré-0030 (onde as colisões de classe C coexistem).
    await db.query(`ALTER TABLE estoques DROP CONSTRAINT IF EXISTS estoques_produto_id_tamanho_id_local_key`);
    await db.query(`DROP INDEX IF EXISTS estoques_unico_produto_tamanho_local`);

    await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', 1, true, true)`);
    const localId = Number((await db.query(`SELECT id FROM locais WHERE empresa_id = 1 AND nome = 'LOJA'`)).rows[0].id);
    await db.query(`INSERT INTO tamanhos (codigo, descricao) VALUES ('P', 'Pequeno')`);
    const tamanhoId = Number((await db.query(`SELECT id FROM tamanhos WHERE codigo = 'P'`)).rows[0].id);
    const prod = Number((await db.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ('SKUR-1', 'Prod R', 1) RETURNING id`)).rows[0].id);

    // Duas linhas canônicas cosméticas do mesmo par (o que a consolidação trata)
    // + uma linha legada (local_id NULL) com o texto canônico.
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES ($1, $2, 'loja', $3, 9, 1), ($1, $2, 'LOJA', $3, 1, 1)`,
      [prod, tamanhoId, localId]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES ($1, $2, 'LOJA', NULL, 4, 1)`,
      [prod, tamanhoId]
    );
    // Movimentação histórica que NÃO pode ser tocada.
    await db.query(
      `INSERT INTO movimentacoes (tipo, produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES ('ajuste', $1, $2, 'loja', $3, 5, 1)`,
      [prod, tamanhoId, localId]
    );

    const snapEstoques = async () =>
      (await db.query(`SELECT id, produto_id, local, local_id, quantidade, empresa_id FROM estoques ORDER BY id`)).rows;
    const snapMov = async () => (await db.query(`SELECT id, produto_id, local, quantidade FROM movimentacoes ORDER BY id`)).rows;
    const estAntes = await snapEstoques();
    const movAntes = await snapMov();

    const apply = runPsqlFile(SCRIPT_006, s.url, APPLY);
    assert.notEqual(apply.code, 0, 'o AFTER-CHECK fail-closed deve abortar o APPLY');
    assert.match(apply.out, /atualizados: sobreviventes=1, linhas_removidas=1/);
    assert.match(apply.out, /FALHOU \(fail-closed\)/);
    assert.match(apply.out, /duplicatas_saldos=1/);
    assert.doesNotMatch(apply.out, /transação COMITADA/, 'não pode haver COMMIT');
    assert.deepEqual(await snapEstoques(), estAntes, 'nada pode ser persistido (estoques)');
    assert.deepEqual(await snapMov(), movAntes, 'movimentacoes (histórico) não podem ser tocadas');

    console.log('\n=== PROD-DB-01.5.4 — ROLLBACK fail-closed ===');
    console.log('  pós-validação detectou duplicatas_saldos=1 = ABORTADO; estoques e movimentacoes idênticos');
  } finally {
    await s.encerrar();
  }
});

// ============================================================================
// TESTE 4 — Wrapper (run-006-e42.sh): DRY-RUN por padrão, APPLY com a tríplice
//           autorização; recusa arquivo defasado/alterado.
// ============================================================================
test('PROD-DB-01.5.4 — o wrapper run-006-e42.sh é fail-closed e recusa cópia defasada', async (t) => {
  const wrapper = fileURLToPath(new URL('../../../db/admin/run-006-e42.sh', import.meta.url));
  const bash = spawnSync('bash', ['-n', wrapper], { encoding: 'utf8' });
  assert.equal(bash.status, 0, `o wrapper deve ter sintaxe válida:\n${bash.stderr}`);

  // Sem DATABASE_URL o wrapper recusa.
  const semUrl = spawnSync('bash', [wrapper], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
  assert.notEqual(semUrl.status, 0, 'sem DATABASE_URL deve recusar');
  assert.match(semUrl.stderr, /DATABASE_URL não definida/);

  // Com uma cópia defasada (sem o parâmetro `autorizacao`) o wrapper recusa.
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e42-54-'));
  try {
    const conteudo = readFileSync(SCRIPT_006, 'utf8').replace(/autorizacao/g, 'authz_removida');
    writeFileSync(path.join(dir, '006-consolidar-colisoes-estoque-classe-c.sql'), conteudo);
    writeFileSync(path.join(dir, 'run-006-e42.sh'), readFileSync(wrapper, 'utf8'));
    const defasado = spawnSync('bash', [path.join(dir, 'run-006-e42.sh')], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgresql://x:x@localhost:5432/x' },
    });
    assert.notEqual(defasado.status, 0, 'cópia defasada deve ser recusada');
    assert.match(defasado.stderr, /NÃO contém o parâmetro de autorização|revisão esperada/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=== PROD-DB-01.5.4 — wrapper fail-closed validado ===');
  console.log('  sem DATABASE_URL=recusa | cópia defasada=recusa');
});
