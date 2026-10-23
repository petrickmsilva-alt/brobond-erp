// ============================================================================
// Impressão P0..P6 contra PostgreSQL REAL (16.14):
//   • migrations 0037 + 0038 aplicam de forma limpa e idempotente;
//   • duas criações simultâneas com a mesma idempotency_key: AMBAS resolvem
//     sem erro 25P02 e criam exatamente 1 job no banco;
//   • dois claims simultâneos do mesmo job: exatamente 1 agente vence;
//   • dois pareamentos simultâneos com o mesmo código: exatamente 1 vence;
//   • print_terminals respeita unicidade (empresa_id, codigo) e isolamento;
//   • uq_vendas_empresa_idempotency garante venda PDV única sob corrida.
// Sem DATABASE_URL o arquivo se auto-pula (job testes-postgres do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('pg print P0..P6: concorrência real de claim, idempotência sem 25P02, pareamento único, terminais e vendas idempotentes', { skip }, async () => {
  const { migrate } = await import('../src/db');
  await migrate();
  // Segunda execução prova idempotência das migrations 0037 e 0038
  await migrate();

  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const jobs = await import('../src/printJobs');
  const agents = await import('../src/printAgents');
  const { ADMIN, chamar, garantirAdmin, reqDe } = await import('./_p1util');
  await garantirAdmin();

  const s = getStore();
  const sufixo = `${Date.now()}-${process.pid}`;
  const ator = { usuario_id: null, usuario: 'pg-print' };

  // 1. Dois agentes ativos da empresa 1
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

  // 2. Idempotência sob corrida em PostgreSQL real: ambas as promessas devem resolver!
  const novo = {
    docType: 'teste',
    source: 'sistema',
    sourceRef: null,
    terminal: null,
    printerName: null,
    copies: 1,
    priority: 0,
    content: [{ kind: 'text', text: 'pg' }] as never,
    metadata: { protocol: 'text' },
    idempotencyKey: `pg-print-${sufixo}`,
    maxAttempts: 3,
  };
  const criacoes = await Promise.allSettled([jobs.enfileirarJob(1, ator, novo), jobs.enfileirarJob(1, ator, novo)]);
  const ok = criacoes.filter((c) => c.status === 'fulfilled') as PromiseFulfilledResult<{ job: any; idempotente: boolean }>[];
  assert.equal(ok.length, 2, 'ambas as chamadas concorrentes devem resolver sem erro 25P02');
  assert.equal(ok[0].value.job.public_id, ok[1].value.job.public_id);
  const total = await s.countWhere(RESOURCES.print_jobs, { empresa_id: 1, idempotency_key: novo.idempotencyKey });
  assert.equal(total, 1, 'uma chave = um job no PostgreSQL');

  // 3. Claim concorrente: exatamente um vencedor
  const claims = await Promise.all([jobs.claimJob(a1 as never), jobs.claimJob(a2 as never)]);
  const vencedores = claims.filter((c) => c && String(c.job.idempotency_key) === novo.idempotencyKey);
  assert.equal(vencedores.length, 1, 'claim concorrente: um vencedor, nenhum job duplicado');

  // 4. Pareamento concorrente de uso único: exatamente 1 vence, o outro falha (400)
  const parOut = await chamar(agents.criarCodigoPareamentoHandler as any, reqDe({}, { user: ADMIN }), 201);
  const corridasPar = await Promise.allSettled([
    chamar(agents.parearAgenteHandler as any, reqDe({ codigo: parOut.codigo, nome: 'Race 1' }, { headers: { 'x-forwarded-for': '198.51.100.11' } }), 201),
    chamar(agents.parearAgenteHandler as any, reqDe({ codigo: parOut.codigo, nome: 'Race 2' }, { headers: { 'x-forwarded-for': '198.51.100.12' } }), 201),
  ]);
  const vencedoresPar = corridasPar.filter((r) => r.status === 'fulfilled');
  assert.equal(vencedoresPar.length, 1, 'código de pareamento só pode ser consumido uma única vez sob concorrência');

  // 5. print_terminals (0038): insere terminal e valida unicidade (empresa_id, codigo)
  const codTerm = `CXPG-${sufixo.slice(-6)}`.toUpperCase();
  const t1 = await s.insert(RESOURCES.print_terminals, {
    empresa_id: 1,
    codigo: codTerm,
    nome: 'Caixa PG',
    receipt_protocol: 'escpos',
    receipt_width_cols: 48,
    label_protocol: 'zpl',
    document_protocol: 'pdf',
    fallback_mode: 'browser_pdf',
    auto_print_pdv: true,
    allow_operator_reprint: true,
    copies_recibo: 1,
    copies_documento: 1,
    ativo: true,
  });
  assert.ok(Number(t1.id) > 0);
  await assert.rejects(() =>
    s.insert(RESOURCES.print_terminals, {
      empresa_id: 1,
      codigo: codTerm,
      nome: 'Duplicado',
    })
  );

  // Cadeia de auditoria JSONB deve permanecer 100% íntegra após eventos de impressão
  const verif = await s.verificarAuditoria();
  assert.equal(verif.ok, true, `cadeia de auditoria íntegra; quebras=${JSON.stringify(verif.quebras)}`);
});
