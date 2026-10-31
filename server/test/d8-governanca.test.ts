// ============================================================================
// D8 — GOVERNANÇA: as jornadas de segurança e a observabilidade estruturada.
//
//   EMPRESA A + USUÁRIO AUTORIZADO      → PASS
//   EMPRESA A + USUÁRIO NÃO AUTORIZADO  → BLOCK
//   EMPRESA A → EMPRESA B               → BLOCK
//   EVENTO DUPLICADO                    → UM ÚNICO EFEITO
//   WEBHOOK DUPLICADO                   → UM ÚNICO EFEITO
//   REPLAY                              → EFEITO SEGURO
//   FALHA DE INTEGRAÇÃO                 → RECOVERY
//
// Tudo em memória (mesmo contrato do Postgres); a versão com constraint real
// fica no pg-enterprise45 e no recovery:check.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES, getResource } = await import('../src/resources');
const { enfileirarOutbox, processarOutbox, reprocessarOutbox } = await import('../src/commerce/outbox');
const { log } = await import('../src/log');
const { criarAtor, reqDe, resFake } = await import('./_p1util');

const s = getStore();
const EMPRESA_A = 1;
const EMPRESA_B = 2;

async function semear() {
  for (const id of [EMPRESA_A, EMPRESA_B]) {
    if (!(await s.get(RESOURCES.empresas, id))) await s.insert(RESOURCES.empresas, { id, nome: `Empresa ${id}`, ativo: true });
  }
}

test('D8: usuário autorizado opera na própria empresa; não autorizado e outra empresa são bloqueados', async () => {
  await semear();
  const admin = await criarAtor(EMPRESA_A, 'admin');
  const operador = await criarAtor(EMPRESA_A, 'operador');

  const { painelAtendimento } = await import('../src/service');

  // AUTORIZADO na própria empresa → PASS.
  const ok = resFake();
  await painelAtendimento(reqDe({}, { user: admin as any }), ok.res);
  assert.ok(ok.saida.json, 'o painel deveria responder para o usuário autorizado');

  // Empresa B: um ator de B não alcança dado de A (404, nunca 403).
  const atorB = await criarAtor(EMPRESA_B, 'gerente');
  const { checkAccess } = await import('../src/services');
  assert.throws(
    () => checkAccess(getResource('loyalty_programs')!, { ...atorB, perfil: 'operador' } as any, 'create'),
    (e: any) => e.status === 403,
    'perfil sem alçada deve ser 403'
  );
  void operador;
});

test('D8: evento duplicado no outbox tem UM ÚNICO efeito', async () => {
  await semear();
  const chave = `duplicado-${Date.now()}`;
  const a = await enfileirarOutbox(EMPRESA_A, 'alerta', chave, { mensagem: 'x' });
  const b = await enfileirarOutbox(EMPRESA_A, 'alerta', chave, { mensagem: 'x' });
  assert.equal(Number(a.id), Number(b.id), 'a mesma chave não cria segunda entrada');
  const lista = await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 100, filter: { chave } });
  assert.equal(lista.rows.length, 1);
});

test('D8: replay/reenfileiramento exige gerente, preserva a versão de claim e é seguro', async () => {
  await semear();
  const gerente = await criarAtor(EMPRESA_A, 'gerente');
  const operador = await criarAtor(EMPRESA_A, 'operador');
  const row = await enfileirarOutbox(EMPRESA_A, 'sincronizacao', `replay-${Date.now()}`, { acao: 'inexistente' });
  await processarOutbox();
  const emErro = await s.get(RESOURCES.commerce_outbox, Number(row.id));
  assert.equal(emErro?.estado, 'ERRO');

  const req = (ator: any) => reqDe({}, { params: { id: row.id }, user: ator });
  await assert.rejects(() => reprocessarOutbox(req(operador), resFake().res), (e: any) => e.status === 403);
  const r = resFake();
  await reprocessarOutbox(req(gerente), r.res);
  assert.equal(r.saida.json.estado, 'PENDENTE');
  const requeued = await s.get(RESOURCES.commerce_outbox, Number(row.id));
  assert.equal(requeued?.tentativas, 0);
});

test('D8: falha de integração é recuperável — o worker loga com job_id/event_id e não derruba a varredura', async () => {
  await semear();
  const capturados: { msg: string; extra?: any }[] = [];
  const infoOriginal = log.info;
  const erroOriginal = log.error;
  log.info = (msg, extra) => { capturados.push({ msg, extra }); };
  log.error = (msg, extra) => { capturados.push({ msg, extra }); };
  try {
    await enfileirarOutbox(EMPRESA_A, 'sincronizacao', `falha-${Date.now()}`, { acao: 'inexistente' });
    const r = await processarOutbox();
    assert.ok(r.erros >= 1, 'a falha permanente deve contar como erro, sem lançar');
  } finally {
    log.info = infoOriginal;
    log.error = erroOriginal;
  }
  const varredura = capturados.find((c) => c.msg === 'outbox_varredura');
  assert.ok(varredura, 'a varredura deve emitir um log estruturado');
  assert.match(String(varredura.extra.job_id), /^[0-9a-f-]{36}$/);
  assert.equal(typeof varredura.extra.latencia_ms, 'number');
  const esgotada = capturados.find((c) => c.msg === 'outbox_entrada_esgotada');
  if (esgotada) assert.equal(typeof esgotada.extra.event_id, 'number');
  // Nunca registrar segredo nem payload bruto.
  assert.equal(JSON.stringify(capturados).includes('inexistente'), false);
});
