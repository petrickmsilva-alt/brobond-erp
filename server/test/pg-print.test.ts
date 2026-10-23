// ============================================================================
// Impressão P0/P1 contra PostgreSQL REAL: o que só o banco prova —
//   • dois claims simultâneos do mesmo job: exatamente um vence (o UPDATE
//     condicional de tryUpdateIf sob concorrência de verdade);
//   • duas criações simultâneas com a mesma idempotency_key: um job só
//     (o índice único (empresa_id, idempotency_key) é a última linha);
//   • a migration 0037 aplica em um banco existente (cadeia em migrate()).
// Sem DATABASE_URL o arquivo se auto-pula (job testes-postgres do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('pg print: claim concorrente tem exatamente um vencedor e idempotência segura corrida', { skip }, async () => {
  const { migrate } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const jobs = await import('../src/printJobs');
  const s = getStore();
  const sufixo = `${Date.now()}-${process.pid}`;
  const ator = { usuario_id: null, usuario: 'pg-print' };

  // Dois agentes da empresa 1.
  const mkAgente = (n: number) =>
    s.insert(RESOURCES.print_agents, {
      empresa_id: 1,
      machine_id: `pg-${sufixo}-${n}`,
      nome: `Agente PG ${n}`,
      token_hash: `hash-${sufixo}-${n}`,
      token_prefix: 'bpa_pg',
      status: 'ativo',
    });
  const [a1, a2] = [await mkAgente(1), await mkAgente(2)];

  // Idempotência sob corrida: as duas criações partem juntas.
  const novo = {
    docType: 'teste',
    source: 'sistema',
    sourceRef: null,
    terminal: null,
    printerName: null,
    copies: 1,
    priority: 0,
    content: [{ kind: 'text', text: 'pg' }] as never,
    metadata: {},
    idempotencyKey: `pg-print-${sufixo}`,
    maxAttempts: 3,
  };
  const criacoes = await Promise.allSettled([jobs.enfileirarJob(1, ator, novo), jobs.enfileirarJob(1, ator, novo)]);
  const ok = criacoes.filter((c) => c.status === 'fulfilled') as PromiseFulfilledResult<{ job: any; idempotente: boolean }>[];
  assert.ok(ok.length >= 1);
  const total = await s.countWhere(RESOURCES.print_jobs, { empresa_id: 1, idempotency_key: novo.idempotencyKey });
  assert.equal(total, 1, 'uma chave = um job, mesmo sob corrida');

  // Claim sob corrida: exatamente um agente fica com o job.
  const claims = await Promise.all([jobs.claimJob(a1 as never), jobs.claimJob(a2 as never)]);
  const vencedores = claims.filter((c) => c && String(c.job.idempotency_key) === novo.idempotencyKey);
  assert.equal(vencedores.length, 1, 'claim concorrente: um vencedor, nenhum job duplicado');
});
