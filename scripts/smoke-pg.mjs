#!/usr/bin/env node
// ============================================================================
// SMOKE E2E CONTRA POSTGRESQL REAL, EM BANCO NOVO (gate do ERP-03).
//
// O smoke (`scripts/smoke-e2e.mjs`) sempre rodou contra o modo demonstração: a
// memória tem `locais.mock`, o admin padrão e os cadastros de exemplo, então
// tudo passava. Contra um PostgreSQL recém-migrado o mesmo smoke dava 92/117 —
// 25 falhas `409 A empresa ativa não possui um local de estoque ativo` — e o
// CI aceitava o verde da memória como se fosse o sistema (P0-04).
//
// Este runner fecha o vão:
//   1. cria um BANCO NOVO a partir do `DATABASE_URL` (nada é semeado à mão);
//   2. sobe a API de verdade nesse banco (migrate + ensureAdmin automáticos);
//   3. roda o smoke apontado para ela;
//   4. derruba a API e apaga o banco, devolvendo o código de saída do smoke.
//
// Como o banco nasce do zero a cada execução, o smoke pode ser não idempotente
// (sempre foi) sem contaminar a próxima rodada — que era o motivo de ele só ser
// executável à mão, num servidor de demonstração recém-subido.
//
// Uso:
//   DATABASE_URL=postgresql://usuario:senha@host:porta/base npm run smoke:pg
//   DATABASE_URL=... node scripts/smoke-pg.mjs --keep   (mantém o banco criado)
// ============================================================================
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// `pg` vem do workspace da API (é dependência de `server/`), não do pacote
// raiz — resolver por ele evita depender de hoisting do npm no runner do CI.
const requireDoServer = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = requireDoServer('pg');

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const MANTER = process.argv.includes('--keep');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('smoke:pg exige DATABASE_URL (use o PostgreSQL do job testes-postgres).');
  process.exit(2);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '0.0.0.0', () => {
      const porta = s.address().port;
      s.close((e) => (e ? reject(e) : resolve(porta)));
    });
  });
}

function esperarSaida(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

const nomeBanco = `brobond_smoke_${Date.now().toString(36)}`;
const admin = new Client({ connectionString: DATABASE_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${nomeBanco}`);
const url = new URL(DATABASE_URL);
url.pathname = `/${nomeBanco}`;
const databaseUrl = url.toString();

const porta = await reservePort();
const env = {
  ...process.env,
  PORT: String(porta),
  DATABASE_URL: databaseUrl,
  JWT_SECRET: randomUUID(),
  ADMIN_EMAIL: 'admin@brobond.com.br',
  ADMIN_PASSWORD: 'brobond123',
};
// O gate roda o boot REAL (sem NODE_ENV=test): é o caminho que o usuário sobe.
delete env.NODE_ENV;

console.log(`🗄️  smoke:pg — banco novo: ${nomeBanco}`);
console.log(`🚀 smoke:pg — subindo a API na porta ${porta} (migrate + admin automáticos)`);
const servidor = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
  cwd: RAIZ,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logApi = '';
const registrar = (c) => {
  logApi = `${logApi}${String(c)}`.slice(-40_000);
  process.stdout.write(`[api] ${c}`);
};
servidor.stdout.on('data', registrar);
servidor.stderr.on('data', registrar);

let codigoSmoke = 1;
let codigoSaida = 1;
try {
  const base = `http://127.0.0.1:${porta}`;
  const prazo = Date.now() + 180_000;
  let pronto = false;
  while (Date.now() < prazo) {
    if (servidor.exitCode !== null || servidor.signalCode !== null) throw new Error('a API encerrou antes de responder o health check');
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = await r.json();
        if (h.ok === true && h.db === 'postgres') { pronto = true; break; }
      }
    } catch {
      // migrations do banco novo em andamento
    }
    await delay(250);
  }
  if (!pronto) throw new Error('health check não confirmou db=postgres em 180 s');

  // O /health responde `db=postgres` assim que o pool conecta — as MIGRAÇÕES
  // (schema.sql + as 32 migrações) e o `ensureAdmin` terminam DEPOIS. Rodar o
  // smoke nesse intervalo daria falha de tabela ausente de forma intermitente:
  // a espera é pelo último marco do boot (index.ts:933).
  const prazoBoot = Date.now() + 180_000;
  while (!/🔐 Administrador:/.test(logApi)) {
    if (servidor.exitCode !== null || servidor.signalCode !== null) throw new Error('a API encerrou durante o boot');
    if (Date.now() > prazoBoot) throw new Error('o boot não concluiu (migrações/administrador) em 180 s');
    await delay(200);
  }

  console.log(`✅ smoke:pg — API pronta em ${base} (db=postgres, banco novo, ZERO SQL manual)`);
  const smoke = spawn(process.execPath, ['scripts/smoke-e2e.mjs'], {
    cwd: RAIZ,
    env: { ...process.env, SMOKE_BASE: `${base}/api` },
    stdio: 'inherit',
  });
  codigoSmoke = await esperarSaida(smoke);
  codigoSaida = codigoSmoke;
  console.log(codigoSmoke === 0 ? '✅ smoke:pg — smoke E2E aprovado contra PostgreSQL real' : `❌ smoke:pg — smoke E2E reprovou (exit ${codigoSmoke})`);
} catch (e) {
  console.error(`❌ smoke:pg — ${e?.message || e}`);
} finally {
  if (servidor.exitCode === null && servidor.signalCode === null) {
    servidor.kill('SIGTERM');
    const t = setTimeout(() => servidor.kill('SIGKILL'), 5_000);
    await esperarSaida(servidor).catch(() => undefined);
    clearTimeout(t);
  }
  if (MANTER) {
    console.log(`🗄️  smoke:pg — banco mantido para inspeção: ${nomeBanco}`);
  } else {
    await admin.query(`DROP DATABASE IF EXISTS ${nomeBanco} WITH (FORCE)`).catch((e) => {
      console.warn(`⚠️  smoke:pg — não consegui apagar ${nomeBanco}: ${e?.message || e}`);
    });
  }
  await admin.end().catch(() => undefined);
}

process.exit(codigoSaida);
