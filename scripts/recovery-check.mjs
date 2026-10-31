#!/usr/bin/env node
// ============================================================================
// RECOVERY — prova que o backup RESTAURA (não é só "existe um endpoint").
//
// Roteiro (tudo em bancos de TESTE; nada de produção):
//   1. num banco-fonte, migra e semeia um registro marcador por tabela de negócio;
//   2. gera o SQL de backup com `gerarBackupSql` (o MESMO gerador do endpoint);
//   3. cria um banco-alvo VAZIO, migra e aplica o SQL com o cliente `pg`;
//   4. confere que os marcadores voltaram idênticos — inclusive entre empresas.
//
// O banco-alvo é descartado no fim. Exige um PostgreSQL de teste acessível pela
// mesma URL, com permissão de CREATE DATABASE (o mesmo requisito do test:pg).
// ============================================================================
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const requireServer = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = requireServer('pg');

const url = process.env.DATABASE_URL;
if (!url || !/^postgres(?:ql)?:\/\//i.test(url)) {
  console.error('recovery exige DATABASE_URL PostgreSQL de teste.');
  process.exit(2);
}
const u = new URL(url);
const alvoNome = `${u.pathname.replace(/^\//, '')}_recovery`;
const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`;
const alvoUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/${alvoNome}`;

const admin = new Client({ connectionString: adminUrl });
const fonte = new Client({ connectionString: url });
const alvo = new Client({ connectionString: alvoUrl });

const TABELAS_MARCADOR = ['empresas', 'clientes', 'produtos', 'usuarios'];
const marcador = `recovery-${Date.now().toString(36)}`;

function passo(msg) { console.log(`▶ ${msg}`); }

try {
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${alvoNome}"`);
  await admin.query(`CREATE DATABASE "${alvoNome}"`);

  passo('migrando banco-fonte');
  await fonte.connect();
  const migrar = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/recoveryMigrate.ts'], {
    cwd: new URL('..', import.meta.url).pathname, env: { ...process.env }, encoding: 'utf8',
  });
  if (migrar.status !== 0) throw new Error(`migração do fonte falhou: ${migrar.stderr || migrar.stdout}`);

  // Semeia o marcador: uma empresa nova com cliente/produto/usuário apontando p/ ela.
  const empresa = (await fonte.query(`INSERT INTO empresas (nome) VALUES ($1) RETURNING id`, [`Recovery ${marcador}`])).rows[0];
  const empresaId = Number(empresa.id);
  await fonte.query(`INSERT INTO clientes (empresa_id, nome) VALUES ($1, $2)`, [empresaId, `Cliente ${marcador}`]);
  await fonte.query(`INSERT INTO produtos (empresa_id, sku, nome) VALUES ($1, $2, $3)`, [empresaId, `SKU-${marcador}`, `Produto ${marcador}`]);
  await fonte.query(`INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, 'admin', $3, true)`,
    [`Rec ${marcador}`, `rec-${marcador}@brobond.test`, empresaId]);

  passo('gerando o SQL de backup (mesmo gerador do endpoint)');
  const { gerarBackupSql } = await import('../server/src/backup.ts');
  const sql = await gerarBackupSql('recovery-check');
  if (!sql.includes(`Cliente ${marcador}`)) throw new Error('o backup não contém o marcador do cliente');
  if (/\bsenha_hash\b|\bmfa_secret\b/.test(sql)) throw new Error('o backup vazou coluna secreta');

  passo('migrando banco-alvo vazio');
  const migrarAlvo = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/recoveryMigrate.ts'], {
    cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, DATABASE_URL: alvoUrl }, encoding: 'utf8',
  });
  if (migrarAlvo.status !== 0) throw new Error(`migração do alvo falhou: ${migrarAlvo.stderr || migrarAlvo.stdout}`);

  passo('aplicando o backup no alvo');
  await alvo.connect();
  await alvo.query(sql);

  passo('conferindo a restauração');
  for (const tabela of TABELAS_MARCADOR) {
    const esperado = await fonte.query(`SELECT count(*)::int n FROM "${tabela}" WHERE empresa_id = $1`, [empresaId]).catch(async () =>
      ({ rows: [{ n: Number((await fonte.query(`SELECT count(*)::int n FROM "${tabela}"`)).rows[0].n) }] }));
    const veio = await alvo.query(`SELECT count(*)::int n FROM "${tabela}"`);
    if (Number(veio.rows[0].n) < Number(esperado.rows[0].n)) {
      throw new Error(`restauração incompleta em ${tabela}: fonte ${esperado.rows[0].n}, alvo ${veio.rows[0].n}`);
    }
  }
  const clienteNoAlvo = await alvo.query(`SELECT count(*)::int n FROM clientes WHERE nome = $1`, [`Cliente ${marcador}`]);
  if (Number(clienteNoAlvo.rows[0].n) !== 1) throw new Error('o cliente marcador não voltou no alvo');
  const empresaNoAlvo = await alvo.query(`SELECT count(*)::int n FROM empresas WHERE id = $1`, [empresaId]);
  if (Number(empresaNoAlvo.rows[0].n) !== 1) throw new Error('a empresa marcadora não voltou no alvo');

  // Idempotência: reaplicar o backup não pode duplicar nem falhar.
  passo('reaplicando (idempotência do restore)');
  await alvo.query(sql);
  const dup = await alvo.query(`SELECT count(*)::int n FROM clientes WHERE nome = $1`, [`Cliente ${marcador}`]);
  if (Number(dup.rows[0].n) !== 1) throw new Error(`reaplicar duplicou: ${dup.rows[0].n} cópias`);

  console.log('✅ RECOVERY: backup gerado, restaurado em banco vazio e reaplicado sem duplicar.');
} finally {
  await fonte.end().catch(() => {});
  await alvo.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${alvoNome}"`).catch(() => {});
  await admin.end().catch(() => {});
}
