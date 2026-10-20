// ============================================================================
// PROD-DB-01 — sincronização do schema do banco de produção (PostgreSQL REAL).
//
// Sintoma em produção: /vendas responde
//   'Coluna "t.local_saida_id" não encontrada no banco. Execute db/schema.sql…'
// mesmo o código já tendo a coluna (schema.sql + migração 0031).
//
// Causa-raiz: o `pg` roda o db/schema.sql inteiro como UMA transação implícita.
// Um preflight de dado legado (E4.2 recusa dois locais homônimos na mesma
// empresa) lançava, o lote TODO voltava atrás e a cadeia versionada — que vinha
// logo depois — NUNCA era alcançada. A coluna nova nunca chegava ao banco.
//
// Correção (PROD-DB-01): a cadeia versionada roda SEMPRE, mesmo com o bootstrap
// falhando. Correção (PROD-DB-01.1): nesse estado o banco fica DEGRADADO.
//
// PROD-DB-02 (este ciclo) REORGANIZOU as fases com honestidade:
//   • o bootstrap estrutural (db/bootstrap.sql) é SÓ DDL e NÃO tem preflight —
//     dado legado nunca o bloqueia (por isso a cobertura migrou para a 0030);
//   • a regra de dado E4.2 vive na cadeia versionada (0030). É ELA que, ao
//     reexecutar e encontrar inconsistência, degrada o banco e impede negócio;
//   • uma falha de migration versionada nunca é lida como sucesso de bootstrap.
// Estes testes passaram a exercitar exatamente isso.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/prod-db-01-schema-sync.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
const { migrate, query, isDbDegraded, migrationError } = await import('../../src/db');
const { getStore } = await import('../../src/services');
const { PgStore } = await import('../../src/pgstore');

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

const evidence: string[] = [];

async function colunaExiste(tabela: string, coluna: string): Promise<boolean> {
  const r = await query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tabela, coluna]
  );
  return Number(r.rows[0].n) === 1;
}

async function migracoesAplicadasDesde(id: string): Promise<number> {
  const r = await query(`SELECT count(*)::int AS n FROM schema_migrations WHERE id >= $1`, [id]);
  return Number(r.rows[0].n);
}

async function novaEmpresa(prefixo: string): Promise<number> {
  const emp = await query(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`, [prefixo, prefixo]);
  return Number(emp.rows[0].id);
}

test('PROD-DB-01 — a cadeia versionada reconstrói a coluna perdida mesmo com o banco defasado', async (t) => {
  const suffix = randomUUID().slice(0, 8);

  // 0) Estado inicial: banco migrado, coluna presente, NÃO degradado.
  await migrate();
  assert.equal(await colunaExiste('vendas', 'local_saida_id'), true, 'pré-condição: vendas.local_saida_id deve existir após migrate()');
  assert.equal(isDbDegraded(), false, 'estado inicial: banco pronto, não degradado');
  evidence.push('estado inicial: vendas.local_saida_id EXISTE; migrações >= 0031 = ' + (await migracoesAplicadasDesde('0031')));

  // Cenário "produção atrás": coluna ausente + migrações >= 0031 não registradas.
  // (O PROD-DB-02 separou as fases: o bootstrap é só DDL e não é bloqueado por
  // dado legado; a cadeia é quem reconstrói o schema drift.)
  await query(`ALTER TABLE vendas DROP COLUMN IF EXISTS local_saida_id CASCADE`);
  await query(`DELETE FROM schema_migrations WHERE id >= '0031'`);
  assert.equal(await colunaExiste('vendas', 'local_saida_id'), false, 'cenário: a coluna deve estar ausente');
  t.after(async () => {
    await migrate().catch(() => undefined); // devolve o banco ao estado pronto
  });
  evidence.push('cenário montado: local_saida_id AUSENTE; migrações >= 0031 = 0');

  // 1) migrate() reaplica a cadeia versionada e reconstrói a coluna/FK.
  await migrate();
  assert.equal(
    await colunaExiste('vendas', 'local_saida_id'),
    true,
    'migrate() deve criar vendas.local_saida_id via cadeia versionada'
  );
  assert.ok((await migracoesAplicadasDesde('0031')) > 0, 'a cadeia versionada deve estar registrada em schema_migrations');

  const fk = await query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.vendas'::regclass AND conname = 'fk_e421_vendas_empresa_local_saida'`
  );
  assert.equal(Number(fk.rows[0].n), 1, 'a FK composta fk_e421_vendas_empresa_local_saida deve existir após a 0031');

  // 2) Sem dado legado inconsistente, o banco volta PRONTO (não degradado).
  assert.equal(isDbDegraded(), false, 'com a cadeia aplicada e sem inconsistência, o banco fica pronto');
  assert.equal(migrationError(), null);
  assert.ok((await getStore()) instanceof PgStore, 'no estado pronto, o store é o PgStore real');
  evidence.push('após migrate(): local_saida_id EXISTE, migrações >= 0031 = ' + (await migracoesAplicadasDesde('0031')) + '; isDbDegraded()=false; getStore()=PgStore');

  console.log('\n=== PROD-DB-01 (schema sync) evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});

test('PROD-DB-01 — a regra E4.2 (0030), reaplicada, degrada o banco sem corrigir dado', async (t) => {
  const suffix = randomUUID().slice(0, 8);
  await migrate();
  assert.equal(isDbDegraded(), false, 'pré-condição: banco pronto');

  // Dado legado que faz o preflight da E4.2 recusar o DDL (dois locais
  // homônimos na MESMA empresa). O índice de unicidade é removido só para
  // montar o cenário legado; é restaurado na limpeza. O dado NÃO é corrigido:
  // a exigência é que o boot apenas recuse e degrade.
  const empresaId = await novaEmpresa(`PRODDB01B ${suffix}`);
  const nomeLocal = `Loja ${suffix}`;
  await query(`DROP INDEX IF EXISTS uq_e42_locais_empresa_nome`);
  await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, nomeLocal]);
  await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, nomeLocal]);
  // Força a 0030 a reexecutar (é a migração que carrega a regra E4.2).
  await query(`DELETE FROM schema_migrations WHERE id = $1`, ['0030_e42_locais_estoque_multempresa.sql']);
  t.after(async () => {
    await query(`DELETE FROM locais WHERE empresa_id = $1 AND nome = $2`, [empresaId, nomeLocal]).catch(() => undefined);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_nome ON locais (empresa_id, nome)`).catch(() => undefined);
    await query(`DELETE FROM empresas WHERE id = $1`, [empresaId]).catch(() => undefined);
    await query(`DELETE FROM schema_migrations WHERE id = $1`, ['0030_e42_locais_estoque_multempresa.sql']).catch(() => undefined);
    await migrate().catch(() => undefined); // devolve o banco ao estado pronto
  });

  // migrate(): o preflight da 0030 recusa o DDL e a cadeia para. Nenhum dado é
  // corrigido automaticamente (os dois locais continuam lá).
  await migrate();
  assert.equal(isDbDegraded(), true, 'inconsistência E4.2 deve deixar o banco degradado');
  assert.match(String(migrationError()), /nomes_locais_inconsistentes|E4\.2 preflight/i);
  assert.match(String(migrationError()), /0030_e42_locais_estoque_multempresa\.sql/);
  assert.equal(
    Number((await query(`SELECT count(*)::int AS n FROM locais WHERE empresa_id = $1 AND nome = $2`, [empresaId, nomeLocal])).rows[0].n),
    2,
    'o boot NÃO pode corrigir/remover o dado legado'
  );
  assert.equal(
    Number((await query(`SELECT count(*)::int AS n FROM schema_migrations WHERE id = $1`, ['0030_e42_locais_estoque_multempresa.sql'])).rows[0].n),
    0,
    'a 0030 que falhou NÃO pode ser registrada'
  );
  // O gate de rotas (bloqueioDeProntidao) responde 503 nesse estado — provado de
  // ponta a ponta em prod-db-01-readiness.test.ts. Aqui basta provar que o boot
  // sinaliza degradação e NÃO corrige o dado legado.
  evidence.push('0030/E4.2 bloqueada: isDbDegraded()=true; 2 locais intactos; 0030 não registrada');

  // Recuperação: corrigido o dado legado, migrate() volta ao estado pronto.
  await query(`DELETE FROM locais WHERE empresa_id = $1 AND nome = $2`, [empresaId, nomeLocal]);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_nome ON locais (empresa_id, nome)`);
  await migrate();
  assert.equal(isDbDegraded(), false, 'após corrigir a pré-condição, o banco volta a ficar pronto');
  assert.equal(migrationError(), null);
  assert.ok(getStore() instanceof PgStore, 'no estado pronto, o store é o PgStore real');
  evidence.push('recuperação: dado legado corrigido + migrate() ⇒ isDbDegraded()=false; getStore()=PgStore');

  console.log('\n=== PROD-DB-01 (schema sync) evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});

test('PROD-DB-01.1 — falha da cadeia versionada deixa o banco degradado (nenhuma rota operacional)', async (t) => {
  await migrate();
  assert.equal(isDbDegraded(), false, 'pré-condição: banco pronto');

  // Migração que falha de verdade, ordenada depois de todas as reais.
  const nomeFalha = '9999_prod_db_01_falha_intencional.sql';
  const caminhoFalha = path.join(MIGRATIONS_DIR, nomeFalha);
  writeFileSync(caminhoFalha, 'SELECT 1/0; -- PROD-DB-01.1: falha intencional de teste\n', 'utf8');
  t.after(async () => {
    rmSync(caminhoFalha, { force: true });
    await query(`DELETE FROM schema_migrations WHERE id = $1`, [nomeFalha]).catch(() => undefined);
    await migrate().catch(() => undefined); // devolve o banco ao estado pronto
  });

  await migrate();
  assert.equal(isDbDegraded(), true, 'falha de migração versionada deve deixar o banco degradado');
  assert.match(String(migrationError()), /Migração versionada falhou/i);
  // O gate de rotas (bloqueioDeProntidao) responde 503 nesse estado — provado
  // de ponta a ponta em prod-db-01-readiness.test.ts. O guard do getStore() é a
  // última linha de defesa e só atua quando o singleton ainda não foi criado
  // (no boot real, migrate() roda antes de qualquer getStore()).
  evidence.push('migração 9999 falhou ⇒ isDbDegraded()=true; migrationError() preenchido');

  // Recuperação: removida a migração quebrada, migrate() volta ao pronto.
  rmSync(caminhoFalha, { force: true });
  await migrate();
  assert.equal(isDbDegraded(), false, 'após remover a causa, o banco volta a ficar pronto');
  evidence.push('recuperação: migração quebrada removida + migrate() ⇒ isDbDegraded()=false');

  console.log('\n=== PROD-DB-01.1 (migração) evidência ===\n' + evidence.map((l) => `- ${l}`).join('\n'));
});
