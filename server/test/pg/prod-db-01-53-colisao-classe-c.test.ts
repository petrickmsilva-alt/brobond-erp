// ============================================================================
// PROD-DB-01.5.3 — PREFLIGHT DE COLISÃO DE CHAVE ÚNICA NA NORMALIZAÇÃO CLASSE C.
//
// Regressão da execução real do PROD-DB-01.5.2.1: a diferença apenas de
// caixa/espaço NÃO torna a linha automaticamente normalizável. Normalizar
// 'loja' -> 'LOJA' violou a constraint real
// `estoques_produto_id_tamanho_id_local_key` (chave (produto_id, tamanho_id,
// local)) porque JÁ existia uma linha com 'LOJA'. O PostgreSQL descobriu a
// colisão durante o UPDATE e abortou a transação (sem COMMIT).
//
// Esta suíte prova, executando o ARQUIVO INTEIRO pelo psql real (não uma
// reimplementação em TypeScript), que agora a colisão é detectada ANTES de
// qualquer escrita:
//
//   1. Classe C sem colisão → normaliza, COMMIT, 2ª execução = 0;
//   2. Classe C com colisão → preflight detecta, UPDATE não executa, dados
//      permanecem EXATAMENTE iguais, transação abortada;
//   3. Caso EXATO de produção: produto_id=7, tamanho_id=5, 'loja' -> 'LOJA',
//      constraint estoques_produto_id_tamanho_id_local_key;
//   4. Mais de uma colisão → todas reportadas, APPLY aborta integralmente;
//   5. Classe A continua abortando;
//   6. Classe B continua NÃO sendo tratada como Classe C;
//   7. Isolamento por empresa_id: nenhuma colisão cruzada entre tenants;
//   8. DRY-RUN nunca altera dados;
//   9. APPLY autorizado sem colisão → executa, valida pós-condição, COMMIT;
//  10. Rollback: falha pós-update reverte tudo.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Exige DATABASE_URL e o
// binário `psql` (PSQL_BIN tem precedência). Sem DATABASE_URL FALHA (não pula).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-01-53-colisao-classe-c.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
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

/** Executa o ARQUIVO COMPLETO pelo psql com `-f <caminho>` (forma de produção). */
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

interface Scratch {
  admin: Client;
  db: Client;
  url: string;
  encerrar: () => Promise<void>;
}

/** Cria um banco descartável próprio e aplica o bootstrap/migrações reais.
 *
 * Com `icu: true`, o banco nasce com collation ICU (`en-US`), reproduzindo a
 * ordem de `array_agg(DISTINCT ...)` do serviço `postgres:16.14` do CI
 * (`en_US.utf8`) — que difere da ordem `C.UTF-8` de um host comum. */
async function criarBanco(prefixo: string, opcoes: { icu?: boolean } = {}): Promise<Scratch> {
  const base = new URL(process.env.DATABASE_URL!);
  const scratch = `${prefixo}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const criarSql = opcoes.icu
    ? `CREATE DATABASE ${scratch} TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'`
    : `CREATE DATABASE ${scratch}`;
  await admin.query(criarSql);
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

/** Cria empresa + local canônico 'LOJA' e devolve os ids. */
async function empresaComLocal(db: Client, nome: string, cnpj: string): Promise<{ emp: number; local: number }> {
  const emp = Number(
    (await db.query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [nome, cnpj])).rows[0].id
  );
  const local = Number(
    (await db.query(`INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('LOJA', $1, true, true) RETURNING id`, [emp])).rows[0].id
  );
  return { emp, local };
}

/** Insere produto com id explícito (a FK exige empresa do produto). */
async function produto(db: Client, id: number, emp: number, sku: string): Promise<void> {
  await db.query(`INSERT INTO produtos (id, sku, nome, empresa_id) VALUES ($1, $2, $3, $4)`, [id, sku, sku, emp]);
}

/** Insere tamanho com id explícito. */
async function tamanho(db: Client, id: number, codigo: string): Promise<void> {
  await db.query(`INSERT INTO tamanhos (id, codigo, descricao) VALUES ($1, $2, $3)`, [id, codigo, codigo]);
}

// ============================================================================
// TESTE PRINCIPAL — detecção prévia de colisão (cenários 2, 3, 4, 8).
// ============================================================================
test('PROD-DB-01.5.3 — o preflight detecta colisões de chave única ANTES do UPDATE e aborta sem alterar nada', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const s = await criarBanco('e42_colisao');
  const { db } = s;

  try {
    const sfx = Date.now().toString(36);
    const cnpj = (p: string) => `${p}${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`;
    const { emp, local } = await empresaComLocal(db, `COLISAO ${sfx}`, cnpj('9'));

    // ----------------------------------------------------------------------
    // FIXTURE — o CASO EXATO de produção: produto_id=7, tamanho_id=5.
    //   linha legada 'LOJA' (local_id NULL) + linha 'loja' (local_id canônico).
    // A normalização de 'loja' -> 'LOJA' criaria colisão na constraint real
    // `estoques_produto_id_tamanho_id_local_key` (produto_id, tamanho_id, local).
    // ----------------------------------------------------------------------
    await tamanho(db, 5, `T5-${sfx}`);
    await produto(db, 7, emp, `SKU7-${sfx}`);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (7, 5, 'LOJA', NULL, 10, $1)`,
      [emp]
    );
    const estLoja = Number(
      (await db.query(
        `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
         VALUES (7, 5, 'loja', $1, 20, $2) RETURNING id`,
        [local, emp]
      )).rows[0].id
    );

    // SEGUNDA colisão (cenário 4 — mais de uma): produto_id=8, tamanho_id=6.
    await tamanho(db, 6, `T6-${sfx}`);
    await produto(db, 8, emp, `SKU8-${sfx}`);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (8, 6, 'LOJA', NULL, 30, $1)`,
      [emp]
    );
    const estLoja2 = Number(
      (await db.query(
        `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
         VALUES (8, 6, 'loja', $1, 40, $2) RETURNING id`,
        [local, emp]
      )).rows[0].id
    );

    // Nenhuma alteração pode ocorrer: snapshot EXATO de todas as linhas.
    const snapshot = async () =>
      (await db.query(
        `SELECT id, produto_id, tamanho_id, local, local_id, empresa_id, quantidade
           FROM estoques WHERE empresa_id = $1 ORDER BY id`,
        [emp]
      )).rows;
    const antes = await snapshot();
    assert.equal(antes.length, 4, 'a fixture deve ter 4 linhas de estoque');

    // ----------------------------------------------------------------------
    // (8) DRY-RUN — identifica a colisão, informa os registros e NÃO altera nada.
    // ----------------------------------------------------------------------
    const dry = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dry.code, 0, `DRY-RUN deve sair 0:\n${dry.stderr}`);
    assert.match(dry.out, /E4\.2\/01\.5\.3 COLISÃO: tabela=estoques índice=estoques_produto_id_tamanho_id_local_key coluna=local chaves_conflitantes=2 linhas_envolvidas=4/);
    assert.match(dry.out, /chave_conflitante=\{"local": "LOJA", "produto_id": 7, "tamanho_id": 5\}/);
    assert.match(dry.out, /chave_conflitante=\{"local": "LOJA", "produto_id": 8, "tamanho_id": 6\}/);
    assert.match(dry.out, new RegExp(`empresa_id=\\{${emp}\\}`));
    assert.match(dry.out, /local_atual=\{LOJA,loja\}/);
    assert.match(dry.out, /registros=\{\d+,\d+\}/);
    assert.match(dry.out, new RegExp(`registros=\\{[^}]*\\b${estLoja}\\b[^}]*\\}`));
    assert.match(dry.out, new RegExp(`registros=\\{[^}]*\\b${estLoja2}\\b[^}]*\\}`));
    assert.match(dry.out, /E4\.2\/01\.5\.3 DRY-RUN: 2 colisão\(ões\) de chave única detectada\(s\) \(4 linha\(s\)\)/);
    assert.match(dry.out, /DRY-RUN: transação revertida \(ROLLBACK\)/);
    assert.deepEqual(await snapshot(), antes, 'DRY-RUN não pode alterar o dado');

    // ----------------------------------------------------------------------
    // (2)(3)(4) APPLY — detecta a colisão ANTES do UPDATE, aborta, não altera
    //           nenhuma linha e não executa COMMIT.
    // ----------------------------------------------------------------------
    const apply = runPsqlFile(s.url, APPLY_C);
    assert.notEqual(apply.code, 0, 'APPLY com colisão deve abortar');
    assert.match(apply.out, /E4\.2\/01\.5\.3 ABORTADO: a normalização classe C faria 2 chave\(s\) única\(s\) colidir \(4 linha\(s\) envolvida\(s\)\)\. Nenhum UPDATE foi executado/);
    assert.match(apply.out, /estoques_produto_id_tamanho_id_local_key/);
    assert.doesNotMatch(apply.out, /transação COMITADA/, 'não pode haver COMMIT');
    assert.doesNotMatch(apply.out, /E4\.2\/01\.5 atualizados:/, 'nenhum UPDATE pode ter sido executado');
    assert.deepEqual(await snapshot(), antes, 'APPLY abortado não pode alterar NENHUMA linha');
    assert.equal(
      Number((await db.query(CONTADOR_SQL)).rows[0].n),
      2,
      'o contador de inconsistências deve permanecer 2'
    );

    // Prova de que o PostgreSQL NUNCA chegou a descobrir a violação: a mensagem
    // nativa de constraint do driver não aparece (o preflight aborta antes).
    assert.doesNotMatch(apply.out, /duplicate key value violates unique constraint/);

    console.log('\n=== PROD-DB-01.5.3 — colisão de classe C detectada no preflight ===');
    console.log(`  DRY-RUN: 2 chaves em colisão (produto 7/tam 5 e produto 8/tam 6) — nenhuma escrita`);
    console.log('  APPLY: abortado ANTES do UPDATE; dados idênticos; sem COMMIT');
  } finally {
    await s.encerrar();
  }
});

// ============================================================================
// TESTE — caso exato + no-collision + isolamento + guardas A/B + rollback.
// ============================================================================
test('PROD-DB-01.5.3 — caso exato reproduzido; sem colisão normaliza/commita; guardas A/B e rollback preservados', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const s = await criarBanco('e42_colisao2');
  const { db } = s;

  try {
    const sfx = Date.now().toString(36);
    const cnpj = (p: string) => `${p}${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`;

    // ----------------------------------------------------------------------
    // (3) CASO EXATO de produção isolado: produto_id=7, tamanho_id=5,
    //     'loja' -> 'LOJA', constraint estoques_produto_id_tamanho_id_local_key.
    // ----------------------------------------------------------------------
    const A = await empresaComLocal(db, `EXATO ${sfx}`, cnpj('9'));
    await tamanho(db, 5, `T5-${sfx}`);
    await produto(db, 7, A.emp, `SKU7-${sfx}`);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (7, 5, 'LOJA', NULL, 10, $1)`,
      [A.emp]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (7, 5, 'loja', $1, 20, $2)`,
      [A.local, A.emp]
    );

    const antesExato = (await db.query(
      `SELECT id, local, local_id FROM estoques WHERE produto_id = 7 ORDER BY id`
    )).rows;
    assert.equal(antesExato.length, 2, 'devem existir duas linhas distintas');

    const dryExato = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dryExato.code, 0, `DRY-RUN deve sair 0:\n${dryExato.stderr}`);
    assert.match(dryExato.out, /índice=estoques_produto_id_tamanho_id_local_key/);
    assert.match(dryExato.out, /chave_conflitante=\{"local": "LOJA", "produto_id": 7, "tamanho_id": 5\}/);
    assert.match(dryExato.out, /local_atual=\{LOJA,loja\}/);
    assert.deepEqual(
      (await db.query(`SELECT id, local, local_id FROM estoques WHERE produto_id = 7 ORDER BY id`)).rows,
      antesExato,
      'o caso exato não pode ser alterado no DRY-RUN'
    );

    const applyExato = runPsqlFile(s.url, APPLY_C);
    assert.notEqual(applyExato.code, 0, 'APPLY do caso exato deve abortar');
    assert.match(applyExato.out, /E4\.2\/01\.5\.3 ABORTADO/);
    assert.deepEqual(
      (await db.query(`SELECT id, local, local_id FROM estoques WHERE produto_id = 7 ORDER BY id`)).rows,
      antesExato,
      'o caso exato não pode ser alterado no APPLY abortado'
    );

    // Limpa as linhas que colidiriam para provar o caminho SEM colisão.
    await db.query(`DELETE FROM estoques WHERE produto_id = 7 AND local = 'LOJA' AND local_id IS NULL`);

    // ----------------------------------------------------------------------
    // (1)(9) Classe C SEM colisão: APPLY normaliza, valida pós-condição, COMMIT.
    // ----------------------------------------------------------------------
    const dryOk = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dryOk.code, 0);
    assert.match(dryOk.out, /E4\.2\/01\.5\.3 DRY-RUN: nenhuma colisão de chave única prevista/);
    assert.equal(
      (await db.query(`SELECT local FROM estoques WHERE produto_id = 7`)).rows[0].local,
      'loja',
      'o DRY-RUN sem colisão ainda não escreve'
    );

    const applyOk = runPsqlFile(s.url, APPLY_C);
    assert.equal(applyOk.code, 0, `APPLY sem colisão deve sair 0:\n${applyOk.stderr}`);
    assert.match(applyOk.out, /E4\.2\/01\.5\.3 preflight de colisão: índices únicos verificados=\d+, chaves em colisão=0, linhas envolvidas=0/);
    assert.match(applyOk.out, /atualizados: estoques\.local=1, movimentacoes\.local=0, movimentacoes\.local_destino=0, inventarios\.local=0 \(total=1\)/);
    assert.match(applyOk.out, /AFTER OK: todos os contadores do preflight E4\.2 = 0/);
    assert.match(applyOk.out, /transação COMITADA/);
    const linha7 = (await db.query(`SELECT local, local_id, empresa_id, quantidade FROM estoques WHERE produto_id = 7`)).rows[0];
    assert.equal(linha7.local, 'LOJA', 'o texto deve virar o nome canônico');
    assert.equal(Number(linha7.local_id), A.local, 'local_id não pode mudar');
    assert.equal(Number(linha7.empresa_id), A.emp, 'empresa_id não pode mudar');
    assert.equal(Number(linha7.quantidade), 20, 'quantidade não pode mudar');
    assert.equal(Number((await db.query(CONTADOR_SQL)).rows[0].n), 0, 'pós-condição: contador = 0');

    // (1) IDEMPOTÊNCIA: segunda execução = 0 alterações e nenhuma colisão nova.
    const idem = runPsqlFile(s.url, APPLY_C);
    assert.equal(idem.code, 0, `2ª passada deve sair 0:\n${idem.stderr}`);
    assert.match(idem.out, /atualizados: estoques\.local=0, movimentacoes\.local=0, movimentacoes\.local_destino=0, inventarios\.local=0 \(total=0\)/);
    assert.match(idem.out, /chaves em colisão=0/);
    assert.equal(Number((await db.query(CONTADOR_SQL)).rows[0].n), 0);

    // ----------------------------------------------------------------------
    // (7) ISOLAMENTO POR empresa_id — dois tenants com o MESMO nome canônico
    //     ('LOJA') em produtos distintos. Nenhuma colisão cruzada é gerada e
    //     cada tenant recebe o nome do PRÓPRIO local.
    // ----------------------------------------------------------------------
    const B = await empresaComLocal(db, `TENANT B ${sfx}`, cnpj('8'));
    const C = await empresaComLocal(db, `TENANT C ${sfx}`, cnpj('7'));
    await produto(db, 20, B.emp, `SKU20-${sfx}`);
    await produto(db, 21, C.emp, `SKU21-${sfx}`);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (20, NULL, 'loja', $1, 1, $2)`,
      [B.local, B.emp]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (21, NULL, 'loja', $1, 1, $2)`,
      [C.local, C.emp]
    );

    const dryTenant = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dryTenant.code, 0);
    assert.match(
      dryTenant.out,
      /E4\.2\/01\.5\.3 DRY-RUN: nenhuma colisão de chave única prevista/,
      'nomes homônimos em tenants distintos não podem gerar colisão cruzada'
    );

    const applyTenant = runPsqlFile(s.url, APPLY_C);
    assert.equal(applyTenant.code, 0, `APPLY dos tenants deve sair 0:\n${applyTenant.stderr}`);
    assert.match(applyTenant.out, /atualizados: estoques\.local=2,/);
    const bRow = (await db.query(`SELECT local, local_id, empresa_id FROM estoques WHERE produto_id = 20`)).rows[0];
    const cRow = (await db.query(`SELECT local, local_id, empresa_id FROM estoques WHERE produto_id = 21`)).rows[0];
    assert.equal(bRow.local, 'LOJA');
    assert.equal(cRow.local, 'LOJA');
    assert.equal(Number(bRow.local_id), B.local, 'tenant B recebe o local do PRÓPRIO tenant');
    assert.equal(Number(cRow.local_id), C.local, 'tenant C recebe o local do PRÓPRIO tenant');
    assert.equal(Number(bRow.empresa_id), B.emp);
    assert.equal(Number(cRow.empresa_id), C.emp);

    // ----------------------------------------------------------------------
    // (5) CLASSE A continua abortando (texto NULL com local_id canônico).
    // ----------------------------------------------------------------------
    const movA = Number(
      (await db.query(
        `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, quantidade, empresa_id)
         VALUES ('ajuste', 7, NULL, $1, 1, $2) RETURNING id`,
        [A.local, A.emp]
      )).rows[0].id
    );
    const dryA = runPsqlFile(s.url, []);
    assert.notEqual(dryA.code, 0, 'classe A deve abortar');
    assert.match(dryA.out, /classe A/);
    assert.equal(
      (await db.query(`SELECT local FROM movimentacoes WHERE id = $1`, [movA])).rows[0].local,
      null,
      'o caso classe A não pode ser alterado'
    );
    await db.query(`DELETE FROM movimentacoes WHERE id = $1`, [movA]);

    // ----------------------------------------------------------------------
    // (6) CLASSE B continua NÃO sendo tratada como Classe C.
    // ----------------------------------------------------------------------
    await produto(db, 30, A.emp, `SKU30-${sfx}`);
    const estB = Number(
      (await db.query(
        `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
         VALUES (30, NULL, 'LOJA 2', $1, 1, $2) RETURNING id`,
        [A.local, A.emp]
      )).rows[0].id
    );
    const applyB = runPsqlFile(s.url, APPLY_C);
    assert.notEqual(applyB.code, 0, 'classe B não pode ser tratada como cosmética');
    assert.match(applyB.out, /classe B \(divergência textual real, não cosmética\)/);
    assert.equal(
      (await db.query(`SELECT local FROM estoques WHERE id = $1`, [estB])).rows[0].local,
      'LOJA 2',
      'a divergência semântica não pode ser alterada'
    );
    await db.query(`DELETE FROM estoques WHERE id = $1`, [estB]);

    // ----------------------------------------------------------------------
    // (10) ROLLBACK — falha PÓS-update reverte TUDO.
    //      Sem a unicidade canônica (índice removido, como o wrapper antigo
    //      fazia), a normalização criaria uma duplicata de saldo que o
    //      AFTER-CHECK fail-closed detecta e faz reverter.
    // ----------------------------------------------------------------------
    await db.query(`DROP INDEX IF EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id`);
    await produto(db, 31, A.emp, `SKU31-${sfx}`);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (31, NULL, 'loja', $1, 1, $2)`,
      [A.local, A.emp]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (31, NULL, 'LOJA', $1, 1, $2)`,
      [A.local, A.emp]
    );
    const applyRollback = runPsqlFile(s.url, APPLY_C);
    assert.notEqual(applyRollback.code, 0, 'a guarda fail-closed deve abortar');
    assert.match(applyRollback.out, /FALHOU \(fail-closed\)/);
    assert.match(applyRollback.out, /duplicatas_saldos=1/);
    const linhas31 = (await db.query(`SELECT local FROM estoques WHERE produto_id = 31 ORDER BY id`)).rows.map((r) => r.local);
    assert.deepEqual(linhas31, ['loja', 'LOJA'], 'o rollback deve devolver os textos originais');

    console.log('\n=== PROD-DB-01.5.3 — caso exato, sem-colisão, isolamento e guardas ===');
    console.log('  caso exato (7/5 loja→LOJA)=abort | sem colisão=COMMIT | 2ª=0');
    console.log('  isolamento por tenant=OK | classe A=abort | classe B=abort | dup_saldos=ROLLBACK');
  } finally {
    await s.encerrar();
  }
});

// ============================================================================
// TESTE — a detecção é GENÉRICA (não hardcode de `estoques`) e o predicado de
// índice que referencia a coluna normalizada é fail-closed.
//
// Prova que o preflight introspecta o catálogo real: cria índices únicos
// ADICIONAIS em `inventarios`/`movimentacoes` (tabelas sem índice único textual
// no schema atual) e confirma que a colisão é detectada neles também.
// ============================================================================
test('PROD-DB-01.5.3 — a detecção cobre QUALQUER índice único (não só estoques) e predicado sobre a coluna normalizada é fail-closed', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  const s = await criarBanco('e42_colisao3');
  const { db } = s;

  try {
    const sfx = Date.now().toString(36);
    const cnpj = (p: string) => `${p}${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`;
    const { emp, local } = await empresaComLocal(db, `GENERICO ${sfx}`, cnpj('9'));
    await produto(db, 7, emp, `SKU7-${sfx}`);

    // ----------------------------------------------------------------------
    // (A) Índice único ADICIONAL em inventarios (local, status) — sem colisão.
    //     O preflight deve reconhecê-lo como índice verificado.
    // ----------------------------------------------------------------------
    await db.query(`CREATE UNIQUE INDEX uq_teste_inv_local_status ON inventarios (empresa_id, local, status)`);
    await db.query(
      `INSERT INTO inventarios (local, local_id, status, empresa_id) VALUES ('LOJA', NULL, 'aberto', $1)`,
      [emp]
    );
    await db.query(
      `INSERT INTO inventarios (local, local_id, status, empresa_id) VALUES ('loja', $1, 'fechado', $2)`,
      [local, emp]
    );

    // Sem colisão: 'loja'->'LOJA' não encontra nenhum 'LOJA'+'fechado'.
    const dryOk = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dryOk.code, 0, `DRY-RUN deve sair 0:\n${dryOk.stderr}`);
    assert.match(dryOk.out, /chaves em colisão=0/);

    // Agora cria a linha que tornaria o UPDATE colidente no índice ADICIONAL.
    await db.query(
      `INSERT INTO inventarios (local, local_id, status, empresa_id) VALUES ('LOJA', NULL, 'fechado', $1)`,
      [emp]
    );
    const antesInv = (await db.query(`SELECT id, local, local_id, status FROM inventarios WHERE empresa_id = $1 ORDER BY id`, [emp])).rows;

    const dryCol = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dryCol.code, 0, `DRY-RUN deve sair 0:\n${dryCol.stderr}`);
    assert.match(
      dryCol.out,
      /E4\.2\/01\.5\.3 COLISÃO: tabela=inventarios índice=uq_teste_inv_local_status coluna=local chaves_conflitantes=1 linhas_envolvidas=2/,
      'a colisão deve ser detectada no índice ADICIONAL de inventarios (não só em estoques)'
    );

    const applyCol = runPsqlFile(s.url, APPLY_C);
    assert.notEqual(applyCol.code, 0, 'APPLY deve abortar pela colisão no índice adicional');
    assert.match(applyCol.out, /uq_teste_inv_local_status/);
    assert.deepEqual(
      (await db.query(`SELECT id, local, local_id, status FROM inventarios WHERE empresa_id = $1 ORDER BY id`, [emp])).rows,
      antesInv,
      'nada pode ser alterado'
    );

    // ----------------------------------------------------------------------
    // (B) Fail-closed: índice parcial cujo PREDICADO referencia a coluna
    //     normalizada. Não é possível afirmar que o índice deixa de valer —
    //     o preflight aborta em vez de assumir.
    // ----------------------------------------------------------------------
    await db.query(`DROP INDEX uq_teste_inv_local_status`);
    await db.query(`DELETE FROM inventarios WHERE empresa_id = $1`, [emp]);
    await db.query(
      `CREATE UNIQUE INDEX uq_teste_inv_pred ON inventarios (empresa_id, id) WHERE local <> 'ZZZ'`
    );
    await db.query(
      `INSERT INTO inventarios (local, local_id, status, empresa_id) VALUES ('loja', $1, 'aberto', $2)`,
      [local, emp]
    );

    const dryPred = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.notEqual(dryPred.code, 0, 'predicado sobre a coluna normalizada deve ser fail-closed');
    assert.match(dryPred.out, /predicado que referencia a coluna normalizada/);
    assert.match(dryPred.out, /uq_teste_inv_pred/);

    console.log('\n=== PROD-DB-01.5.3 — detecção genérica por catálogo ===');
    console.log('  índice único adicional em inventarios=detectado | predicado sobre a coluna=abort (fail-closed)');
  } finally {
    await s.encerrar();
  }
});

// ============================================================================
// TESTE — o relatório de colisão é DETERMINÍSTICO e independente de collation.
//
// Regressão do HOTFIX de CI: `array_agg(DISTINCT ...)` SEM `ORDER BY` ordena
// conforme a collation do banco. O `postgres:16.14` do CI nasce com
// `en_US.utf8` (ICU) e devolve `{loja,LOJA}`; um host `C.UTF-8` devolve
// `{LOJA,loja}` para o MESMO dado. A suíte passava local e falhava no CI.
//
// Este teste força a collation do CI (banco com LOCALE_PROVIDER icu) e exige
// a ordem determinística (`COLLATE "C"`) — se alguém remover o `ORDER BY`/
// `COLLATE "C"` do relatório, a suíte volta a falhar aqui, não só no CI.
// ============================================================================
test('PROD-DB-01.5.3 — o relatório de colisão é determinístico sob collation ICU (ordem do CI)', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  // O `postgres:16.14` do CI traz ICU; um host comum pode não trazer. Sem ICU
  // não há como reproduzir a ordem do CI — mas a asserção de ordem determinística
  // continua valendo, então NÃO pulamos (skip reprova o gate).
  const probe = new Client({ connectionString: process.env.DATABASE_URL! });
  await probe.connect();
  const icuOk = (await probe.query(`SELECT 1 FROM pg_collation WHERE collname = 'en-US-x-icu'`)).rowCount! > 0;
  await probe.end();

  const s = await criarBanco('e42_collation', { icu: icuOk });
  const { db } = s;

  try {
    // Confirma que o banco descartável tem a ordem do CI quando ICU está presente.
    const ordemNativa = (await db.query(
      `SELECT array_agg(DISTINCT x) AS a FROM (VALUES ('loja'),('LOJA')) t(x)`
    )).rows[0].a as string[];
    if (icuOk) {
      assert.deepEqual(
        ordemNativa,
        ['loja', 'LOJA'],
        'o banco descartável precisa reproduzir a collation ICU do CI para este teste ter valor'
      );
    } else {
      t.diagnostic('ICU indisponível neste servidor; a ordem nativa não reproduz o CI.');
    }

    const sfx = Date.now().toString(36);
    const cnpj = (p: string) => `${p}${sfx.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`;
    const { emp, local } = await empresaComLocal(db, `COLLATION ${sfx}`, cnpj('9'));

    await tamanho(db, 5, `T5-${sfx}`);
    await produto(db, 7, emp, `SKU7-${sfx}`);
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (7, 5, 'LOJA', NULL, 10, $1)`,
      [emp]
    );
    await db.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES (7, 5, 'loja', $1, 20, $2)`,
      [local, emp]
    );

    const dry = runPsqlFile(s.url, ['-v', 'normalizar_classe_c=on']);
    assert.equal(dry.code, 0, `DRY-RUN deve sair 0:\n${dry.stderr}`);
    // Ordem determinística byte a byte: 'LOJA' antes de 'loja' (maiúscula < minúscula).
    assert.match(
      dry.out,
      /local_atual=\{LOJA,loja\}/,
      'a ordem do relatório não pode depender da collation do banco'
    );

    console.log('\n=== PROD-DB-01.5.3 — relatório determinístico sob collation ICU ===');
    console.log(`  ICU=${icuOk} ordem nativa do banco={${ordemNativa.join(',')}} → relatório={LOJA,loja}`);
  } finally {
    await s.encerrar();
  }
});
