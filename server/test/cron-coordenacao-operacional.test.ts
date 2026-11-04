import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const lock = await import('../src/cronLock');
const { executarProcessoCron, processosCron } = await import('../src/scheduled');
const { dispararLembretesCrm } = await import('../src/crm');
const { runPaymentJobs } = await import('../../modules/payments/application/jobs');
const { processarFilaPublicacoes } = await import('../src/commerce/catalogo');
const { processarOutbox } = await import('../src/commerce/outbox');
const cifra = await import('../src/chavesCifra');

test('sem PostgreSQL as drenagens de demonstração executam; produção recusaria via CronCoordinationError', async () => {
  const pubs = await processarFilaPublicacoes(1);
  assert.equal(pubs.processadas, 0);
  const out = await processarOutbox(1);
  assert.equal(out.processados, 0);
  const pag = await runPaymentJobs();
  assert.equal(pag.synchronized, 0);
  const crm = await dispararLembretesCrm();
  assert.equal(crm.canal, 'desabilitado');
});

test('executarProcessoCron em memória continua recusando concorrência local', async () => {
  const original = processosCron.crm;
  let liberar: () => void = () => {};
  processosCron.crm = () => new Promise((resolve) => { liberar = () => resolve({ itens: 0, detalhes: [], falhas: [] }); });
  try {
    const primeira = executarProcessoCron('crm');
    const segunda = await executarProcessoCron('crm');
    assert.equal(segunda.status, 409);
    liberar();
    assert.equal((await primeira).status, 200);
  } finally {
    processosCron.crm = original;
  }
});

test('JWT de teste não usa o literal conhecido de desenvolvimento', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/chavesCifra.ts', import.meta.url)), 'utf8');
  assert.match(src, /segredoEfêmero|randomBytes/);
  assert.notEqual(cifra.segredoJwt(), cifra.SEGREDO_DESENVOLVIMENTO);
});

test('requireJobLease em memória (sem pool) não lança', async () => {
  const r = await lock.requireJobLease('crm', async () => 7, { busy: 'fail' });
  assert.equal(r.skipped, false);
  assert.equal(r.result, 7);
});
