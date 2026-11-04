// Cinco jobs (Ordem Final, 2.1): timeout real por processo e trava até o fim do trabalho.
// LOCAL: executores substituídos por registradores (sem efeito externo).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const sched = await import('../src/scheduled');

const original = { ...sched.processosCron };
function restaurar() { Object.assign(sched.processosCron, original); }
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cron — timeout por processo e concorrência', () => {
  test('timeouts padrão definidos para os cinco processos (sem valor indefinido)', () => {
    for (const p of ['relatorios', 'pagamentos', 'publicacoes', 'pedidos', 'crm'] as const) {
      const ms = sched.timeoutProcessoMs(p);
      assert.ok(Number.isInteger(ms) && ms >= 10_000 && ms <= 1_800_000, `${p}: ${ms}`);
    }
  });

  test('variável CRON_TIMEOUT_<PROCESSO>_MS sobrescreve, mas valor inválido cai no padrão', () => {
    process.env.CRON_TIMEOUT_CRM_MS = '45000';
    assert.equal(sched.timeoutProcessoMs('crm'), 45000);
    process.env.CRON_TIMEOUT_CRM_MS = 'abc';
    assert.equal(sched.timeoutProcessoMs('crm'), sched.TIMEOUT_PADRAO_MS.crm);
    process.env.CRON_TIMEOUT_CRM_MS = '5';
    assert.equal(sched.timeoutProcessoMs('crm'), sched.TIMEOUT_PADRAO_MS.crm, 'abaixo do mínimo é rejeitado');
    delete process.env.CRON_TIMEOUT_CRM_MS;
  });

  test('processo que excede o timeout responde 503 com motivo timeout', async (t) => {
    process.env.CRON_TIMEOUT_CRM_MS = '10000';
    // Timeout mínimo é 10 s; o teste simula com um executor que nunca termina dentro do limite
    // trocando o limite por ajuste interno via função de teste.
    sched.processosCron.crm = () => new Promise((r) => setTimeout(() => r({ itens: 0, detalhes: [], falhas: [] }), 2_000).unref());
    t.after(() => { restaurar(); delete process.env.CRON_TIMEOUT_CRM_MS; });
    const r = await sched.executarProcessoCron('crm', { limiteMs: 50 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(r.motivo, 'timeout');
    // Aguarda o término do trabalho abandonado: a trava só cai então (isolamento entre testes).
    await esperar(2_200);
  });

  test('após timeout, o processo continua travado até o trabalho terminar (sem execução concorrente)', async (t) => {
    let terminou = false;
    sched.processosCron.crm = () => new Promise((r) => setTimeout(() => { terminou = true; r({ itens: 1, detalhes: [], falhas: [] }); }, 300));
    t.after(() => restaurar());
    const primeira = await sched.executarProcessoCron('crm', { limiteMs: 30 });
    assert.equal(primeira.motivo, 'timeout');
    const segunda = await sched.executarProcessoCron('crm', { limiteMs: 30 });
    assert.equal(segunda.status, 409, 'enquanto o trabalho anterior não terminou, nova execução é recusada');
    assert.equal(terminou, false);
    await esperar(400);
    assert.equal(terminou, true);
    const terceira = await sched.executarProcessoCron('crm', { limiteMs: 1000 });
    assert.equal(terceira.status, 200, 'liberado após o término real do trabalho');
  });

  test('erro de executor responde 503 com motivo erro e libera a trava', async (t) => {
    sched.processosCron.crm = async () => { throw new Error('falha simulada'); };
    t.after(() => restaurar());
    const r = await sched.executarProcessoCron('crm', { limiteMs: 1000 });
    assert.equal(r.status, 503);
    assert.equal(r.motivo, 'erro');
    sched.processosCron.crm = async () => ({ itens: 0, detalhes: [], falhas: [] });
    const depois = await sched.executarProcessoCron('crm', { limiteMs: 1000 });
    assert.equal(depois.status, 200);
  });
});
