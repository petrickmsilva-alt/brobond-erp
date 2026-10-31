#!/usr/bin/env node
// Official ERP Core gate. The test runner alone accepts skips/TODOs and a
// reused database; neither is acceptable as evidence of a fresh PG install.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const requireServer = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = requireServer('pg');
const url = process.env.DATABASE_URL;
if (!url || !/^postgres(?:ql)?:\/\//i.test(url)) {
  console.error('test:pg exige DATABASE_URL PostgreSQL de um banco de teste NOVO.');
  process.exit(2);
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows: [server] } = await client.query(`SELECT current_setting('server_version_num') AS version,
    current_database() AS database, (SELECT count(*)::int FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p','v','m','f')) AS relations`);
  console.log(`ERP-03 PostgreSQL ${server.version}; banco ${server.database}; relações públicas ${server.relations}`);
  if (server.version !== '160014') throw new Error(`PostgreSQL 16.14 (160014) obrigatório; encontrado ${server.version}`);
  if (server.relations !== 0) throw new Error('Banco reutilizado: test:pg exige um banco vazio por execução (P2-09).');
} catch (error) {
  console.error('ERP-03 preflight:', error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
if (process.exitCode) process.exit();

// Shorten only *idle* connections held by node:test workers after they finish.
// Query/transaction timeouts remain unchanged; PG_POOL_MAX remains unchanged.
const child = spawn('npm', ['--workspace', 'server', 'run', 'test:pg'], {
  env: { ...process.env, PG_IDLE_TIMEOUT: process.env.PG_IDLE_TIMEOUT || '1000' },
  stdio: ['inherit', 'pipe', 'pipe'],
});
let tail = '';
child.stdout.on('data', (data) => {
  process.stdout.write(data);
  tail = (tail + data.toString()).slice(-8192);
});
child.stderr.on('data', (data) => process.stderr.write(data));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
const code = await new Promise((resolve) => {
  child.once('error', (error) => { console.error(error); resolve(1); });
  child.once('exit', (status) => resolve(status ?? 1));
});
// O Node reporta o resumo em TAP (`# pass 12`) ou no reporter spec
// (`ℹ pass 12`), conforme a versão/flags. Aceitar os dois formatos evita um
// falso BLOCKED quando o resultado real é 0 fail/skip/todo.
const counts = Object.fromEntries([...tail.matchAll(/^(?:#|ℹ) (pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)].map(([, k, n]) => [k, Number(n)]));
if (code !== 0 || !('pass' in counts) || counts.fail || counts.cancelled || counts.skipped || counts.todo) {
  console.error(`ERP-03 GATE BLOCKED: runner exit=${code}, resumo=${JSON.stringify(counts)}. TODO/skip crítico não é aprovação.`);
  process.exitCode = 1;
} else {
  console.log(`ERP-03 GATE PASS: ${counts.pass} testes PostgreSQL reais; 0 fail/skip/todo.`);
}
