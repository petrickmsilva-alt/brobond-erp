// ============================================================================
// IMPRESSÃO P0/P1 — PrintIR, fila, idempotência, claim/lease, machine
// identity, tenant isolation e auditoria (memstore; o par real de
// concorrência no Postgres está em pg-print.test.ts).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { ADMIN, chamar, criarAtor, esperarErro, garantirAdmin, reqDe, resFake } = await import('./_p1util');
const jobs = await import('../src/printJobs');
const agents = await import('../src/printAgents');
const { validatePrintIR, PRINT_IR_VERSION } = await import('../../packages/domain/src/print/print-ir');
const { randomUUID } = await import('node:crypto');

await garantirAdmin();
const s = getStore();

let seq = 0;
const chave = () => `teste-print-${Date.now()}-${++seq}`;
const conteudo = [{ kind: 'text', text: 'Olá impressão' }, { kind: 'barcode', value: '7891234567895' }];

function novoJobBody(extra: Record<string, unknown> = {}) {
  return {
    doc_type: 'recibo_pdv',
    source: 'pdv',
    source_ref: 'venda:42',
    copies: 1,
    content: conteudo,
    idempotency_key: chave(),
    ...extra,
  };
}

async function parearAgente(empresaActor: any = ADMIN, terminal?: string) {
  const codigoOut = await chamar(agents.criarCodigoPareamentoHandler as any, reqDe({ terminal }, { user: empresaActor }), 201);
  const par = await chamar(agents.parearAgenteHandler as any, reqDe({ codigo: codigoOut.codigo, nome: 'Agente Teste', agent_version: '0.1.0' }), 201);
  const row: any = await s.findOneWhere(RESOURCES.print_agents, { machine_id: par.machine_id });
  return { ...par, row };
}

/** Os testes compartilham um store: esvazia a fila ativa da empresa 1. */
async function limparFila() {
  for (const status of ['QUEUED', 'CLAIMED', 'PRINTING']) {
    const { rows } = await s.list(RESOURCES.print_jobs, { page: 1, pageSize: 200, filter: { empresa_id: 1, status } });
    for (const j of rows) {
      await s.update(RESOURCES.print_jobs, Number(j.id), { status: 'CANCELLED', cancelled_at: new Date().toISOString(), lease_token_hash: null, lease_expires_at: null, claimed_by_agent_id: null });
    }
  }
}

function reqAgente(agenteRow: any, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const req = reqDe(body, { headers });
  (req as any).printAgent = agenteRow;
  return req;
}

// ---------------------------------------------------------------- PrintIR

test('print: validatePrintIR aceita o contrato mínimo e rejeita desvios', () => {
  const ir = {
    version: PRINT_IR_VERSION,
    jobId: randomUUID(),
    tenantId: '1',
    companyId: '1',
    requestedBy: { userId: 1, userName: 'Admin' },
    source: 'pdv',
    docType: 'recibo_pdv',
    copies: 1,
    priority: 0,
    content: conteudo,
    metadata: {},
    idempotencyKey: 'k1',
    createdAt: new Date().toISOString(),
  };
  assert.deepEqual(validatePrintIR(ir), []);
  assert.ok(validatePrintIR({ ...ir, version: 99 }).length > 0);
  assert.ok(validatePrintIR({ ...ir, content: [{ kind: 'escpos_raw', bytes: 'x' }] }).length > 0, 'bloco acoplado a impressora não entra no contrato');
  assert.ok(validatePrintIR({ ...ir, copies: 0 }).length > 0);
  assert.ok(validatePrintIR({ ...ir, content: [{ kind: 'table', columns: [{ header: 'A' }], rows: [['1', '2']] }] }).length > 0);
});

// ---------------------------------------------------------------- Fila + idempotência

test('print: enfileirar cria QUEUED; mesma chave devolve o mesmo job; conteúdo diferente é 409', async () => {
  const body = novoJobBody();
  const um = await chamar(jobs.criarJobHandler as any, reqDe(body), 201);
  assert.equal(um.job.status, 'QUEUED');
  assert.equal(um.idempotente, false);
  assert.ok(!('lease_token_hash' in um.job), 'hash interno não vaza');

  const dois = await chamar(jobs.criarJobHandler as any, reqDe({ ...body }), 200);
  assert.equal(dois.idempotente, true);
  assert.equal(dois.job.public_id, um.job.public_id, 'refresh/retry não cria segundo job');

  await esperarErro(
    () => jobs.criarJobHandler(reqDe({ ...body, content: [{ kind: 'text', text: 'outra coisa' }] }), resFake().res),
    409,
    /já foi usada/
  );

  const total = await s.countWhere(RESOURCES.print_jobs, { empresa_id: 1, idempotency_key: body.idempotency_key });
  assert.equal(total, 1);
});

test('print: PrintIR inválido é 400 (doc_type, bloco, cópias)', async () => {
  await esperarErro(() => jobs.criarJobHandler(reqDe(novoJobBody({ doc_type: 'danfe' })), resFake().res), 400);
  await esperarErro(() => jobs.criarJobHandler(reqDe(novoJobBody({ copies: 500 })), resFake().res), 400);
  await esperarErro(() => jobs.criarJobHandler(reqDe(novoJobBody({ content: [{ kind: 'raw_escpos' }] })), resFake().res), 400);
});

// ---------------------------------------------------------------- Pareamento + machine auth

test('print: pareamento é de uso único e gera machine identity própria', async () => {
  const out = await chamar(agents.criarCodigoPareamentoHandler as any, reqDe({}), 201);
  const par = await chamar(agents.parearAgenteHandler as any, reqDe({ codigo: out.codigo, nome: 'Caixa 1' }), 201);
  assert.match(par.token, /^bpa_[0-9a-f]{64}$/);
  assert.ok(par.machine_id);
  // Reusar o mesmo código não cria segunda identidade.
  await esperarErro(() => agents.parearAgenteHandler(reqDe({ codigo: out.codigo }), resFake().res), 400, /já foi usado/);
  const row: any = await s.findOneWhere(RESOURCES.print_agents, { machine_id: par.machine_id });
  assert.notEqual(row.token_hash, par.token, 'no banco fica só o hash');
});

test('print: autenticarAgente exige token de máquina válido e ativo', async () => {
  const { row, token } = await parearAgente();
  const ok = await new Promise<boolean>((resolve) => {
    const req = reqDe({}, { headers: { 'x-print-machine-id': row.machine_id, authorization: `Bearer ${token}` } });
    void agents.autenticarAgente(req as any, resFake().res, (e?: any) => resolve(!e));
  });
  assert.equal(ok, true);
  const ruim = await new Promise<any>((resolve) => {
    const req = reqDe({}, { headers: { 'x-print-machine-id': row.machine_id, authorization: 'Bearer bpa_errado' } });
    void agents.autenticarAgente(req as any, resFake().res, (e?: any) => resolve(e));
  });
  assert.equal(ruim.status, 401);
});

test('print: nonce repetido é replay (409) e timestamp velho é 400', async () => {
  const { row } = await parearAgente();
  const nonce = `nonce-${Date.now()}`;
  const mk = (ts: number) => reqAgente(row, {}, { 'x-print-nonce': nonce, 'x-print-timestamp': String(ts) });
  const primeiro = await new Promise<any>((resolve) => void agents.exigirNonceAgente(mk(Date.now()) as any, resFake().res, (e?: any) => resolve(e)));
  assert.equal(primeiro, undefined);
  const replay = await new Promise<any>((resolve) => void agents.exigirNonceAgente(mk(Date.now()) as any, resFake().res, (e?: any) => resolve(e)));
  assert.equal(replay.status, 409);
  const velho = await new Promise<any>((resolve) => {
    const req = reqAgente(row, {}, { 'x-print-nonce': `n-${Date.now()}-x`, 'x-print-timestamp': String(Date.now() - 10 * 60_000) });
    void agents.exigirNonceAgente(req as any, resFake().res, (e?: any) => resolve(e));
  });
  assert.equal(velho.status, 400);
});

// ---------------------------------------------------------------- Claim / lease / retry

test('print: claim é exclusivo, lease protege o desfecho e printed encerra', async () => {
  await limparFila();
  const a1 = await parearAgente();
  const a2 = await parearAgente();
  const body = novoJobBody();
  await chamar(jobs.criarJobHandler as any, reqDe(body), 201);

  const c1 = await jobs.claimJob(a1.row);
  assert.ok(c1, 'primeiro agente reivindica');
  assert.equal(c1.job.status, 'CLAIMED');
  const c2 = await jobs.claimJob(a2.row);
  assert.equal(c2, null, 'segundo agente não pega o mesmo job');

  // Lease errado não conclui; outro agente idem.
  await esperarErro(() => jobs.marcarPrinted(a1.row, c1.job.public_id, 'lease-errado'), 409);
  await esperarErro(() => jobs.marcarPrinted(a2.row, c1.job.public_id, c1.leaseToken), 409);

  await jobs.marcarPrinting(a1.row, c1.job.public_id, c1.leaseToken);
  const fim = await jobs.marcarPrinted(a1.row, c1.job.public_id, c1.leaseToken);
  assert.equal(fim.status, 'PRINTED');
  assert.ok(fim.printed_at);
});

test('print: lease expirado devolve o job à fila (agente morreu no meio)', async () => {
  await limparFila();
  const a1 = await parearAgente();
  const a2 = await parearAgente();
  await chamar(jobs.criarJobHandler as any, reqDe(novoJobBody()), 201);
  const c1 = await jobs.claimJob(a1.row);
  assert.ok(c1);
  // Simula a morte do agente: lease no passado.
  await s.update(RESOURCES.print_jobs, Number(c1.job.id), { lease_expires_at: new Date(Date.now() - 1000).toISOString() });
  const c2 = await jobs.claimJob(a2.row);
  assert.ok(c2, 'outro agente assume após a expiração');
  assert.equal(c2.job.public_id, c1.job.public_id);
  assert.equal(Number(c2.job.attempts), Number(c1.job.attempts) + 1);
  // O lease antigo está morto: acks tardios do agente original falham.
  const rowA1: any = await s.get(RESOURCES.print_agents, Number(a1.row.id));
  await esperarErro(() => jobs.marcarPrinted(rowA1, c1.job.public_id, c1.leaseToken), 409);
});

test('print: falha transitória agenda retry com backoff; permanente encerra em FAILED; retry manual reenfileira', async () => {
  await limparFila();
  const ag = await parearAgente();
  await chamar(jobs.criarJobHandler as any, reqDe(novoJobBody({ max_attempts: 2 })), 201);
  const c = await jobs.claimJob(ag.row);
  assert.ok(c);
  const volta = await jobs.marcarFailed(ag.row, c.job.public_id, c.leaseToken, { code: 'PRINTER_OFFLINE', message: 'desligada', retryable: true });
  assert.equal(volta.status, 'QUEUED');
  assert.ok(new Date(String(volta.next_retry_at)).getTime() > Date.now(), 'backoff no futuro');
  assert.equal(await jobs.claimJob(ag.row), null, 'não é reivindicável durante o backoff');

  // Vence o backoff à força e falha permanente: FAILED direto.
  await s.update(RESOURCES.print_jobs, Number(c.job.id), { next_retry_at: new Date(Date.now() - 1000).toISOString() });
  const c2 = await jobs.claimJob(ag.row);
  assert.ok(c2);
  const fim = await jobs.marcarFailed(ag.row, c2.job.public_id, c2.leaseToken, { code: 'IR_VERSION', message: 'versão', retryable: true });
  assert.equal(fim.status, 'FAILED', 'código permanente não retenta mesmo com retryable=true');
  assert.equal(fim.permanent_error, true);

  const retry = await chamar(jobs.retryJobHandler as any, reqDe({}, { params: { id: fim.public_id } }), 200);
  assert.equal(retry.job.status, 'QUEUED');
  assert.equal(Number(retry.job.attempts), 0);
});

test('print: roteamento por terminal — job endereçado só o agente do terminal reivindica', async () => {
  await limparFila();
  const caixa1 = await parearAgente(ADMIN, 'caixa-1');
  const caixa2 = await parearAgente(ADMIN, 'caixa-2');
  await chamar(jobs.criarJobHandler as any, reqDe(novoJobBody({ terminal: 'caixa-2' })), 201);
  assert.equal(await jobs.claimJob(caixa1.row), null);
  const c = await jobs.claimJob(caixa2.row);
  assert.ok(c);
  await jobs.marcarPrinted(caixa2.row, c.job.public_id, c.leaseToken);
});

// ---------------------------------------------------------------- Tenant isolation + RBAC/ownership

test('print: isolamento multiempresa — agente e usuário de outra empresa não alcançam o job', async () => {
  await limparFila();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL PRINT', razao_social: 'FILIAL PRINT LTDA', ativo: true }).catch(() => undefined);
  const atorB = await criarAtor(2, 'gerente');
  const agenteA = await parearAgente(ADMIN);
  const agenteB = await parearAgente(atorB as any);

  const criado = await chamar(jobs.criarJobHandler as any, reqDe(novoJobBody()), 201); // empresa 1
  assert.equal(await jobs.claimJob(agenteB.row), null, 'agente da empresa B não reivindica job da A');
  await esperarErro(() => jobs.detalheJobHandler(reqDe({}, { params: { id: criado.job.public_id }, user: atorB as any }), resFake().res), 404);
  const listaB = await chamar(jobs.listarJobsHandler as any, reqDe({}, { user: atorB as any }), 200);
  assert.ok(!listaB.rows.some((j: any) => j.public_id === criado.job.public_id));
  const c = await jobs.claimJob(agenteA.row);
  assert.ok(c);
  await jobs.marcarPrinted(agenteA.row, c!.job.public_id, c!.leaseToken);
});

test('print: operador só vê os próprios jobs; cancelar em voo anula o lease', async () => {
  await limparFila();
  const operador = await criarAtor(1, 'operador');
  const meu = await chamar(jobs.criarJobHandler as any, reqDe(novoJobBody(), { user: operador as any }), 201);
  const outroOperador = await criarAtor(1, 'operador');
  await esperarErro(() => jobs.detalheJobHandler(reqDe({}, { params: { id: meu.job.public_id }, user: outroOperador as any }), resFake().res), 404);

  const ag = await parearAgente();
  const c = await jobs.claimJob(ag.row);
  // Pode reivindicar outro job mais antigo da fila; garante sobre o MEU:
  let alvo: any = null;
  let lease = '';
  if (c && c.job.public_id === meu.job.public_id) { alvo = c.job; lease = c.leaseToken; }
  else {
    if (c) await jobs.marcarPrinted(ag.row, c.job.public_id, c.leaseToken);
    const c2 = await jobs.claimJob(ag.row);
    const c3 = c2 && c2.job.public_id !== meu.job.public_id ? (await jobs.marcarPrinted(ag.row, c2.job.public_id, c2.leaseToken), await jobs.claimJob(ag.row)) : c2;
    alvo = c3?.job; lease = c3?.leaseToken || '';
  }
  assert.equal(alvo.public_id, meu.job.public_id);
  const cancel = await chamar(jobs.cancelarJobHandler as any, reqDe({}, { params: { id: meu.job.public_id }, user: operador as any }), 200);
  assert.equal(cancel.job.status, 'CANCELLED');
  await esperarErro(() => jobs.marcarPrinted(ag.row, meu.job.public_id, lease), 409, undefined as any);
});

test('print: reimprimir cria job NOVO ligado à origem (o original não ressuscita)', async () => {
  await limparFila();
  const ag = await parearAgente();
  const criado = await chamar(jobs.criarJobHandler as any, reqDe(novoJobBody()), 201);
  let c = await jobs.claimJob(ag.row);
  while (c && c.job.public_id !== criado.job.public_id) {
    await jobs.marcarPrinted(ag.row, c.job.public_id, c.leaseToken);
    c = await jobs.claimJob(ag.row);
  }
  assert.ok(c);
  await jobs.marcarPrinted(ag.row, c!.job.public_id, c!.leaseToken);
  const re = await chamar(jobs.reimprimirJobHandler as any, reqDe({}, { params: { id: criado.job.public_id } }), 201);
  assert.notEqual(re.job.public_id, criado.job.public_id);
  assert.equal(re.job.reprint_of, criado.job.public_id);
  assert.equal(re.job.status, 'QUEUED');
  const original: any = await s.findOneWhere(RESOURCES.print_jobs, { public_id: criado.job.public_id });
  assert.equal(original.status, 'PRINTED');
  // Limpa a reimpressão para não poluir os demais testes.
  await chamar(jobs.cancelarJobHandler as any, reqDe({}, { params: { id: re.job.public_id } }), 200);
});

test('print: revogar agente invalida o token e libera os jobs dele', async () => {
  await limparFila();
  const ag = await parearAgente();
  await chamar(jobs.criarJobHandler as any, reqDe(novoJobBody()), 201);
  let c = await jobs.claimJob(ag.row);
  assert.ok(c);
  await chamar(agents.revogarAgenteHandler as any, reqDe({}, { params: { id: ag.row.machine_id } }), 200);
  const rowDepois: any = await s.get(RESOURCES.print_agents, Number(ag.row.id));
  assert.equal(rowDepois.status, 'revogado');
  const auth = await new Promise<any>((resolve) => {
    const req = reqDe({}, { headers: { 'x-print-machine-id': ag.row.machine_id, authorization: `Bearer ${ag.token}` } });
    void agents.autenticarAgente(req as any, resFake().res, (e?: any) => resolve(e));
  });
  assert.equal(auth.status, 401, 'token revogado não autentica');
  // O job que estava com ele voltou a ser reivindicável (lease expirado já).
  const outro = await parearAgente();
  let assumiu: any = null;
  let tent = await jobs.claimJob(outro.row);
  while (tent && !assumiu) {
    if (tent.job.public_id === c!.job.public_id) assumiu = tent;
    else { await jobs.marcarPrinted(outro.row, tent.job.public_id, tent.leaseToken); tent = await jobs.claimJob(outro.row); }
  }
  assert.ok(assumiu, 'job do agente revogado foi assumido por outro');
  await jobs.marcarPrinted(outro.row, assumiu.job.public_id, assumiu.leaseToken);
});

// ---------------------------------------------------------------- Auditoria

test('print: eventos entram na cadeia de auditoria existente e ela continua íntegra', async () => {
  const eventos = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 400, filter: { acao: 'imprimir' } });
  // `dados.evento` (print.job.created etc.) é assinado na cadeia mas não é
  // projetado na listagem (comportamento existente do feed de auditoria);
  // aqui conferimos as descrições correspondentes a cada evento do ciclo.
  const descricoes = eventos.rows.map((r: any) => String(r.descricao));
  for (const esperado of [/enfileirada/, /reivindicado/, /Impresso/, /pareado/, /revogado/]) {
    assert.ok(descricoes.some((d) => esperado.test(d)), `auditoria tem evento ${esperado}`);
  }
  assert.ok(eventos.rows.every((r: any) => r.recurso === 'print_jobs' || r.recurso === 'print_agents'));
  const verificacao = await s.verificarAuditoria();
  assert.equal(verificacao.ok, true, `cadeia íntegra (${verificacao.total} eventos)`);
});
