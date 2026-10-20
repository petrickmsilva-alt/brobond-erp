// ============================================================================
// PROD-DB-02 — ciclo de vida do boot em PostgreSQL REAL (cenários a–e).
//
// Cada cenário usa um BANCO DESCARTÁVEL próprio e executa o boot REAL
// (`migrate()`) num processo filho isolado, para provar:
//
//   (a) banco novo;
//   (b) banco parcialmente inicializado (só bootstrap / cadeia até 0017);
//   (c) bootstrap já existente (idempotência + nenhum UPDATE corretivo no boot);
//   (d) migration intermediária falhando (não é confundida com sucesso);
//   (e) retry após falha (recupera e conclui).
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  MIGRATIONS_DIR,
  aplicarArquivo,
  aplicarCadeia,
  BOOTSTRAP_FILE,
  conectar,
  criarBancoDescartavel,
  destruirBancoDescartavel,
  inventario,
  existeColuna,
  existeTabela,
  migrationsRegistradas,
  nomesDasMigrations,
  rodarBoot,
} from './_boot-harness';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/prod-db-02-boot-lifecycle.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

const BOOTSTRAP = readFileSync(BOOTSTRAP_FILE, 'utf8');
const evidence: string[] = [];

test('PROD-DB-02 (a) banco NOVO: bootstrap estrutural + cadeia versionada ⇒ pronto', async (t) => {
  const banco = await criarBancoDescartavel('novo');
  t.after(() => destruirBancoDescartavel(banco));

  const r = await rodarBoot(banco);
  assert.equal(r.code, 0, `boot deveria sair 0:\n${r.stderr}`);
  assert.ok(r.estado, `o child deve imprimir o estado do boot. stdout=${r.stdout.slice(-500)}`);
  assert.equal(r.estado!.status, 'ready', `banco novo deve ficar pronto; veio ${JSON.stringify(r.estado)}`);
  assert.equal(r.estado!.degraded, false);
  assert.equal(r.estado!.falha, null);
  assert.equal(r.estado!.erro, null);

  const c = await conectar(banco);
  try {
    // Estrutura-base e evolução da cadeia.
    for (const tabela of ['empresas', 'locais', 'inventarios', 'itens_inventario', 'estoques', 'movimentacoes', 'vendas']) {
      assert.equal(await existeTabela(c, tabela), true, `tabela-base ${tabela} deve existir`);
    }
    assert.equal(await existeColuna(c, 'vendas', 'local_saida_id'), true, 'a cadeia (0031+) deve criar vendas.local_saida_id');
    assert.equal(await existeColuna(c, 'locais', 'empresa_id'), true, 'a cadeia (0017) deve criar locais.empresa_id');

    // Registro: TODAS as migrations, em ordem lexical, exatamente uma vez.
    const esperado = await nomesDasMigrations();
    const registrado = await migrationsRegistradas(c);
    assert.deepEqual(registrado, esperado, 'schema_migrations deve conter todas as migrations em ordem lexical');

    // A ordem de execução é a lexical: a coluna de cada migração existe.
    evidence.push(`(a) banco novo: pronto; ${registrado.length} migrations registradas; vendas.local_saida_id presente`);
  } finally {
    await c.end();
  }

  console.log('\n=== PROD-DB-02 evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});

test('PROD-DB-02 (b) banco PARCIALMENTE inicializado: só bootstrap e cadeia até 0017 ⇒ pronto', async (t) => {
  // (b1) Só a estrutura-base, sem nenhuma migration versionada.
  const soBootstrap = await criarBancoDescartavel('parcial_boot');
  t.after(() => destruirBancoDescartavel(soBootstrap));
  {
    const c = await conectar(soBootstrap);
    await aplicarArquivo(c, BOOTSTRAP);
    await c.end();
  }
  const r1 = await rodarBoot(soBootstrap);
  assert.equal(r1.code, 0, `boot deveria sair 0:\n${r1.stderr}`);
  assert.equal(r1.estado!.status, 'ready', `só-bootstrap deve completar pela cadeia; veio ${JSON.stringify(r1.estado)}`);
  {
    const c = await conectar(soBootstrap);
    assert.equal(await existeColuna(c, 'vendas', 'local_saida_id'), true);
    assert.deepEqual(await migrationsRegistradas(c), await nomesDasMigrations());
    await c.end();
  }

  // (b2) Estrutura-base + cadeia versionada até 0017 (estado "parado no meio").
  const meio = await criarBancoDescartavel('parcial_meio');
  t.after(() => destruirBancoDescartavel(meio));
  {
    const c = await conectar(meio);
    await aplicarArquivo(c, BOOTSTRAP);
    const ate = '0017_multiempresa_isolamento.sql';
    const aplicados = await aplicarCadeia(c, ate);
    assert.equal(aplicados.at(-1), ate, 'o setup deve parar em 0017');
    assert.equal(await existeColuna(c, 'vendas', 'local_saida_id'), false, 'setup: a coluna da 0031 ainda não existe');
    await c.end();
  }
  const r2 = await rodarBoot(meio);
  assert.equal(r2.code, 0, `boot deveria sair 0:\n${r2.stderr}`);
  assert.equal(r2.estado!.status, 'ready', `parcial-0017 deve completar; veio ${JSON.stringify(r2.estado)}`);
  {
    const c = await conectar(meio);
    assert.equal(await existeColuna(c, 'vendas', 'local_saida_id'), true, 'a cadeia deve retomar da 0018 até o fim');
    assert.deepEqual(await migrationsRegistradas(c), await nomesDasMigrations(), 'nenhuma migration pode ficar de fora');
    await c.end();
  }
  evidence.push('(b) parcialmente inicializado: só-bootstrap e cadeia-até-0017 completam até prontos');
  console.log('\n=== PROD-DB-02 evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});

test('PROD-DB-02 (c) bootstrap já existente: idempotente e SEM UPDATE corretivo no boot', async (t) => {
  const banco = await criarBancoDescartavel('idem');
  t.after(() => destruirBancoDescartavel(banco));

  // 1º boot: banco novo ⇒ pronto.
  const r1 = await rodarBoot(banco);
  assert.equal(r1.estado!.status, 'ready', `1º boot deve ficar pronto; veio ${JSON.stringify(r1.estado)}`);

  const c = await conectar(banco);
  try {
    // SENTINELA: dado legado "defasado" que um boot corretivo (UPDATE) mudaria.
    // O boot NUNCA corrige dados (requisito 10/15): o valor tem de sobreviver.
    const emp = await c.query(`INSERT INTO empresas (nome, ativo) VALUES ('PRODDB02 idem', true) RETURNING id`);
    const empresaId = Number(emp.rows[0].id);
    const local = await c.query(
      `INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ('Local Canônico', $1, true, false) RETURNING id`,
      [empresaId]
    );
    const localId = Number(local.rows[0].id);
    const prod = await c.query(
      `INSERT INTO produtos (sku, nome, empresa_id) VALUES ('PDB02-IDEM', 'Produto idem', $1) RETURNING id`,
      [empresaId]
    );
    const produtoId = Number(prod.rows[0].id);
    await c.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       VALUES ($1, NULL, 'Texto Legado', $2, 7, $3)`,
      [produtoId, localId, empresaId]
    );

    const invAntes = await inventario(c);
    const migrAntes = await migrationsRegistradas(c);
    const estoqueAntes = await c.query(
      `SELECT local, quantidade, local_id, empresa_id FROM estoques WHERE produto_id = $1`,
      [produtoId]
    );

    // 2º boot sobre banco já pronto ⇒ precisa ser no-op.
    const r2 = await rodarBoot(banco);
    assert.equal(r2.code, 0, `2º boot deveria sair 0:\n${r2.stderr}`);
    assert.equal(r2.estado!.status, 'ready', 'reexecutar num banco pronto continua pronto');

    const invDepois = await inventario(c);
    const migrDepois = await migrationsRegistradas(c);
    const estoqueDepois = await c.query(
      `SELECT local, quantidade, local_id, empresa_id FROM estoques WHERE produto_id = $1`,
      [produtoId]
    );

    // (14) Idempotência: inventário estrutural idêntico e nenhuma migration nova.
    assert.deepEqual(invDepois, invAntes, 'o 2º boot não pode alterar o inventário estrutural (idempotência)');
    assert.deepEqual(migrDepois, migrAntes, 'o 2º boot não pode aplicar/registrar migration nova');

    // (15) Nenhum UPDATE corretivo: o dado sentinela permanece exatamente igual.
    assert.deepEqual(estoqueDepois.rows, estoqueAntes.rows, 'o boot NÃO pode alterar dados existentes');

    // Regressão específica: índice global revogado pela 0033 NÃO pode ressuscitar.
    const ressuscitado = await c.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public' AND indexname='connectors_usuario_id_provider_key'`
    );
    assert.equal(Number(ressuscitado.rows[0].n), 0, 'o bootstrap não pode recriar connectors_usuario_id_provider_key (removido pela 0033)');

    evidence.push(`(c) bootstrap já existente: 2º boot idempotente; inventário idêntico (${invDepois.length} objetos); sentinela intacta; índice da 0033 não ressuscita`);
  } finally {
    await c.end();
  }
  console.log('\n=== PROD-DB-02 evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});

// ----------------------------------------------------------------------------
// (d)+(e) Migration intermediária falhando e retry. Um arquivo de migration
// que falha é inserido em posição LEXICALMENTE INTERMEDIÁRIA (após 0017) e
// removido sempre no fim — o `test:pg` roda com concorrência 1.
// ----------------------------------------------------------------------------
const FALHA = '0017_zz_prod_db_02_falha_intermediaria.sql';
const CAMINHO_FALHA = path.join(MIGRATIONS_DIR, FALHA);

test('PROD-DB-02 (d)+(e) falha intermediária não vira sucesso de boot; retry conclui', async (t) => {
  const banco = await criarBancoDescartavel('falha');
  t.after(() => destruirBancoDescartavel(banco));

  // Estado: estrutura-base + cadeia até 0017 (a falha fica logo depois dela).
  const c = await conectar(banco);
  await aplicarArquivo(c, BOOTSTRAP);
  await aplicarCadeia(c, '0017_multiempresa_isolamento.sql');
  await c.end();

  writeFileSync(CAMINHO_FALHA, 'SELECT 1/0; -- PROD-DB-02: falha intencional intermediária\n', 'utf8');
  try {
    // (d) boot com migration intermediária falhando.
    const d = await rodarBoot(banco);
    assert.equal(d.code, 0, `o boot não lança por falha de migration; ele degrada:\n${d.stderr}`);
    assert.equal(d.estado!.status, 'degraded', `falha de migration deve degradar; veio ${JSON.stringify(d.estado)}`);
    assert.equal(d.estado!.degraded, true);
    assert.equal(d.estado!.falha?.fase, 'migrations', 'a fase registrada deve ser migrations (não bootstrap)');
    assert.match(String(d.estado!.erro), /0017_zz_prod_db_02_falha_intermediaria\.sql/, 'o erro deve nomear a migration que falhou');

    const cc = await conectar(banco);
    try {
      const registrado = await migrationsRegistradas(cc);
      assert.ok(!registrado.includes(FALHA), 'a migration que falhou NÃO pode ser registrada');
      assert.ok(!registrado.includes('0018_produto_cadastro_completo.sql'), 'as migrations seguintes não podem rodar sobre estado inconsistente');
      assert.ok(!(await existeColuna(cc, 'vendas', 'local_saida_id')), 'a cadeia parou antes da 0031');
      // A migration que falhou não deixou efeito parcial (transação revertida).
      assert.equal(await existeTabela(cc, '_prod_db_02_parcial'), false, 'a migration revertida não pode deixar objeto');
    } finally {
      await cc.end();
    }
    evidence.push(`(d) falha intermediária: degradado, fase=migrations, ${FALHA} não registrada, 0018+ não aplicadas`);

    // (e) retry após corrigir a causa (remover a migration defeituosa).
    rmSync(CAMINHO_FALHA, { force: true });
    const e = await rodarBoot(banco);
    assert.equal(e.code, 0, `retry deveria sair 0:\n${e.stderr}`);
    assert.equal(e.estado!.status, 'ready', `retry deve concluir a cadeia; veio ${JSON.stringify(e.estado)}`);
    assert.equal(e.estado!.falha, null);

    const cd = await conectar(banco);
    try {
      assert.deepEqual(await migrationsRegistradas(cd), await nomesDasMigrations(), 'retry conclui todas as migrations');
      assert.equal(await existeColuna(cd, 'vendas', 'local_saida_id'), true, 'retry aplica a 0031+');
    } finally {
      await cd.end();
    }
    evidence.push('(e) retry após falha: causa removida + novo boot ⇒ pronto e cadeia completa');
  } finally {
    rmSync(CAMINHO_FALHA, { force: true });
    assert.equal(existsSync(CAMINHO_FALHA), false, 'a migration de falha deve ser removida');
  }
  console.log('\n=== PROD-DB-02 evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});
