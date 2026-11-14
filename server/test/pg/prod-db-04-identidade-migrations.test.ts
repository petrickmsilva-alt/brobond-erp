// ============================================================================
// ETAPA 01 — MIGRATION FORENSICS em PostgreSQL REAL (bancos descartáveis).
//
// Prova o modelo de identidade do runner com a colisão de prefixo 0121:
//   (a) banco NOVO: os dois 0121 aplicam UMA vez, em ordem lexical;
//   (b) reboot: NADA reaplica (aplicado_em intacto);
//   (c) banco LEGADO (cadeia até 0121_operational): boot atual aplica SOMENTE
//       o 0121_perf faltante;
//   (d) rename 0121_perf → 0122 SEM reconciliação: o runner REAPLICA sob o nome
//       novo — evidência de por que o rename é proibido sem consulta ao
//       schema_migrations de produção;
//   (e) rename COM reconciliação prévia do histórico (INSERT do id novo quando
//       o antigo existe): NÃO reaplica — caminho seguro documentado no plano.
//
// Roda no job `testes-postgres` (npm run test:pg). Sem DATABASE_URL FALHA
// (skip não é aprovação).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIGRATIONS_DIR,
  aplicarArquivo,
  aplicarCadeia,
  BOOTSTRAP_FILE,
  conectar,
  criarBancoDescartavel,
  destruirBancoDescartavel,
  migrationsRegistradas,
  nomesDasMigrations,
  rodarBoot,
} from './_boot-harness';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/prod-db-04-identidade-migrations.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

const PERF = '0121_perf_busca_trigram_e_listagens.sql';
const OPERATIONAL = '0121_operational_control_plane.sql';
const quiet = { log() {}, warn() {}, error() {} };

test('PROD-DB-04 (a+b) banco novo aplica os dois 0121 uma única vez; reboot não reaplica', async (t) => {
  const banco = await criarBancoDescartavel('ident_novo');
  t.after(() => destruirBancoDescartavel(banco));

  const r = await rodarBoot(banco);
  assert.equal(r.code, 0, `boot deveria sair 0:\n${r.stderr}`);
  assert.equal(r.estado!.status, 'ready');

  const c = await conectar(banco);
  try {
    const registrado = await migrationsRegistradas(c);
    assert.deepEqual(registrado, await nomesDasMigrations());
    assert.ok(registrado.includes(OPERATIONAL) && registrado.includes(PERF), 'os dois 0121 precisam estar registrados pelo nome completo');
    assert.ok(registrado.indexOf(OPERATIONAL) < registrado.indexOf(PERF), 'ordem lexical: operational antes de perf');

    const antes = (await c.query('SELECT id, aplicado_em FROM schema_migrations ORDER BY id')).rows;
    await c.end();

    const r2 = await rodarBoot(banco);
    assert.equal(r2.code, 0);
    assert.equal(r2.estado!.status, 'ready');

    const c2 = await conectar(banco);
    const depois = (await c2.query('SELECT id, aplicado_em FROM schema_migrations ORDER BY id')).rows;
    await c2.end();
    assert.equal(depois.length, antes.length);
    for (let i = 0; i < antes.length; i++) {
      assert.equal(String(depois[i].aplicado_em), String(antes[i].aplicado_em), `reboot não pode reaplicar ${antes[i].id}`);
    }
  } finally {
    await c.end().catch(() => undefined);
  }
});

test('PROD-DB-04 (c) banco legado pré-perf recebe SOMENTE o 0121_perf no boot atual', async (t) => {
  const banco = await criarBancoDescartavel('ident_legado');
  t.after(() => destruirBancoDescartavel(banco));

  const c = await conectar(banco);
  await aplicarArquivo(c, readFileSync(BOOTSTRAP_FILE, 'utf8'));
  const aplicadas = await aplicarCadeia(c, OPERATIONAL);
  assert.ok(aplicadas.includes(OPERATIONAL));
  assert.ok(!aplicadas.includes(PERF));
  const timestampsLegados = (await c.query('SELECT id, aplicado_em FROM schema_migrations ORDER BY id')).rows;
  await c.end();

  const r = await rodarBoot(banco);
  assert.equal(r.code, 0, `boot deveria sair 0:\n${r.stderr}`);
  assert.equal(r.estado!.status, 'ready');

  const c2 = await conectar(banco);
  const registrado = await migrationsRegistradas(c2);
  assert.deepEqual(registrado, await nomesDasMigrations());
  const depois = (await c2.query('SELECT id, aplicado_em FROM schema_migrations ORDER BY id')).rows;
  for (const antigo of timestampsLegados) {
    const atual = depois.find((d) => d.id === antigo.id);
    assert.ok(atual, `${antigo.id} continua registrado`);
    assert.equal(String(atual.aplicado_em), String(antigo.aplicado_em), `${antigo.id} não pode ter sido reaplicado`);
  }
  await c2.end();
});

test('PROD-DB-04 (d) rename SEM reconciliação REAPLICA; (e) COM reconciliação não reaplica', async (t) => {
  const banco = await criarBancoDescartavel('ident_rename');
  t.after(() => destruirBancoDescartavel(banco));

  // Banco já migrado com a cadeia atual (inclui 0121_perf registrado).
  const c = await conectar(banco);
  await aplicarArquivo(c, readFileSync(BOOTSTRAP_FILE, 'utf8'));
  await aplicarCadeia(c);
  await c.end();

  // Diretório temporário com o rename hipotético 0121_perf → 0122.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mig-rename-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const NOVO = '0122_perf_busca_trigram_e_listagens.sql';
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    cpSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f === PERF ? NOVO : f));
  }

  const { aplicarMigrationsVersionadas } = await import('../../src/db');

  // (d) Sem reconciliação: o nome novo não está no histórico → reaplica.
  const cD = await conectar(banco);
  await aplicarMigrationsVersionadas(cD, { migrationsDir: dir, logger: quiet });
  const aposD = await migrationsRegistradas(cD);
  assert.ok(aposD.includes(NOVO), 'rename sem reconciliação registra o nome novo (REAPLICAÇÃO — comportamento de risco comprovado)');
  assert.ok(aposD.includes(PERF), 'o registro antigo permanece (histórico duplicado)');
  await cD.end();

  // (e) Caminho seguro: reconciliar o histórico ANTES do rename. Reset do
  //     experimento (d) e aplicação do INSERT de reconciliação.
  const cE = await conectar(banco);
  await cE.query('DELETE FROM schema_migrations WHERE id = $1', [NOVO]);
  await cE.query(
    `INSERT INTO schema_migrations (id, aplicado_em)
     SELECT $1, aplicado_em FROM schema_migrations WHERE id = $2
     ON CONFLICT (id) DO NOTHING`,
    [NOVO, PERF]
  );
  await cE.end();

  const cE2 = await conectar(banco);
  const antesE = (await cE2.query('SELECT id, aplicado_em FROM schema_migrations ORDER BY id')).rows;
  await aplicarMigrationsVersionadas(cE2, { migrationsDir: dir, logger: quiet });
  const depoisE = (await cE2.query('SELECT id, aplicado_em FROM schema_migrations ORDER BY id')).rows;
  assert.equal(depoisE.length, antesE.length, 'com histórico reconciliado nada novo é registrado');
  for (let i = 0; i < antesE.length; i++) {
    assert.equal(String(depoisE[i].aplicado_em), String(antesE[i].aplicado_em), `${antesE[i].id} não reaplica`);
  }
  await cE2.end();
});
