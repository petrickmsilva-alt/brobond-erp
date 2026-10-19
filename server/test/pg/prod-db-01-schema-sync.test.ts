// ============================================================================
// PROD-DB-01 — sincronização do schema do banco de produção (PostgreSQL REAL).
//
// Sintoma em produção: /vendas responde
//   'Coluna "t.local_saida_id" não encontrada no banco. Execute db/schema.sql…'
// mesmo o código já tendo a coluna (schema.sql + migração 0031).
//
// Causa-raiz: o `pg` roda o db/schema.sql inteiro como UMA transação implícita.
// Um preflight de dado legado (E4.2 recusa dois locais homônimos na mesma
// empresa) lança, o lote TODO volta atrás e a cadeia versionada — que vinha
// logo depois — NUNCA era alcançada. A coluna nova nunca chegava ao banco.
//
// Correção (PROD-DB-01): a cadeia versionada roda SEMPRE, mesmo com o bootstrap
// do schema.sql falhando. Correção (PROD-DB-01.1): nesse estado o banco fica
// DEGRADADO — `isDbDegraded()` verdadeiro, `getStore()` recusa cair para
// memória — e as rotas de negócio são bloqueadas (ver prod-db-01-readiness).
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

test('PROD-DB-01 — cadeia versionada aplica mesmo com o bootstrap do schema.sql bloqueado por dado legado', async (t) => {
  const suffix = randomUUID().slice(0, 8);

  // 0) Estado inicial: banco migrado, coluna presente, NÃO degradado.
  await migrate();
  assert.equal(await colunaExiste('vendas', 'local_saida_id'), true, 'pré-condição: vendas.local_saida_id deve existir após migrate()');
  assert.equal(isDbDegraded(), false, 'estado inicial: banco pronto, não degradado');
  evidence.push('estado inicial: vendas.local_saida_id EXISTE; migrações >= 0031 = ' + (await migracoesAplicadasDesde('0031')));

  // Cenário "produção atrás": coluna ausente + migrações >= 0031 não registradas.
  await query(`ALTER TABLE vendas DROP COLUMN IF EXISTS local_saida_id CASCADE`);
  await query(`DELETE FROM schema_migrations WHERE id >= '0031'`);
  assert.equal(await colunaExiste('vendas', 'local_saida_id'), false, 'cenário: a coluna deve estar ausente');

  // Dado legado que faz o preflight da E4.2 recusar o DDL (dois locais
  // homônimos na MESMA empresa). O índice de unicidade é removido só para
  // montar o cenário legado; é restaurado na limpeza.
  const empresaId = await novaEmpresa(`PRODDB01 ${suffix}`);
  const nomeLocal = `Loja ${suffix}`;
  await query(`DROP INDEX IF EXISTS uq_e42_locais_empresa_nome`);
  await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, nomeLocal]);
  await query(`INSERT INTO locais (empresa_id, nome, padrao) VALUES ($1, $2, false)`, [empresaId, nomeLocal]);
  t.after(async () => {
    await query(`DELETE FROM locais WHERE empresa_id = $1 AND nome = $2`, [empresaId, nomeLocal]).catch(() => undefined);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_nome ON locais (empresa_id, nome)`).catch(() => undefined);
    await query(`DELETE FROM empresas WHERE id = $1`, [empresaId]).catch(() => undefined);
    await migrate().catch(() => undefined); // devolve o banco ao estado pronto
  });
  evidence.push('cenário montado: local_saida_id AUSENTE; migrações >= 0031 = 0; locais homônimos = 2');

  // 1) migrate() aplica a cadeia versionada MESMO com o schema.sql bloqueado.
  await migrate();
  assert.equal(
    await colunaExiste('vendas', 'local_saida_id'),
    true,
    'migrate() deve criar vendas.local_saida_id via cadeia versionada mesmo com o schema.sql bloqueado por dado legado'
  );
  assert.ok((await migracoesAplicadasDesde('0031')) > 0, 'a cadeia versionada deve estar registrada em schema_migrations');

  const fk = await query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.vendas'::regclass AND conname = 'fk_e421_vendas_empresa_local_saida'`
  );
  assert.equal(Number(fk.rows[0].n), 1, 'a FK composta fk_e421_vendas_empresa_local_saida deve existir após a 0031');

  // 2) Mas o banco fica DEGRADADO: bootstrap incompleto ⇒ não é operacional.
  assert.equal(isDbDegraded(), true, 'bootstrap incompleto deve deixar o banco degradado');
  assert.match(String(migrationError()), /schema\.sql incompleto/i);
  assert.throws(
    () => getStore(),
    (e: any) => e?.status === 503,
    'getStore() NÃO pode cair para memória quando DATABASE_URL existe mas o banco não está pronto'
  );
  evidence.push('após migrate(): local_saida_id EXISTE, migrações >= 0031 = ' + (await migracoesAplicadasDesde('0031')) + '; isDbDegraded()=true; getStore() recusou memória (503)');

  // 3) Recuperação: corrigido o dado legado, migrate() volta ao estado pronto.
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
