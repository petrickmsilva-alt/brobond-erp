// R-4 (Ordem integral, Fase 4.3) — processos do cron independentes.
// LOCAL: store em memória; efeitos externos substituídos por registradores (nenhuma cobrança,
// reembolso, publicação, e-mail real ou chamada de rede). CRON_SECRET é definido só no teste.
// Processos: relatorios (inclui falhas), pagamentos, publicacoes, pedidos, crm.
// Recorrências financeiras ficam FORA do cron (só rota admin com confirmação).
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const S: any = await import('../src/scheduled');
const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const s: any = getStore();

const SEGREDO_TESTE = 'segredo-de-teste-local-r4';
const ENV_KEYS = ['CRON_SECRET', 'NOTIFICAR_CRM_LEMBRETE', 'SCHEDULE_EMAILS', 'NOTIFICAR_EMAILS', 'SCHEDULE_ALERTAS'];
const envAnterior: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.CRON_SECRET = SEGREDO_TESTE;
delete process.env.NOTIFICAR_CRM_LEMBRETE;
delete process.env.SCHEDULE_EMAILS;
delete process.env.NOTIFICAR_EMAILS;
process.env.SCHEDULE_ALERTAS = 'off';

const PROCESSOS = ['pagamentos', 'publicacoes', 'pedidos', 'crm'] as const;
const executores: Record<string, unknown> = {};
const chamadas: string[] = [];
function substituir(): void {
  for (const p of [...PROCESSOS, 'relatorios']) {
    executores[p] = S.processosCron?.[p];
  }
  for (const p of PROCESSOS) {
    S.processosCron[p] = async () => { chamadas.push(p); return { itens: 0, detalhes: [], falhas: [] }; };
  }
}
function restaurar(): void {
  if (!S.processosCron) return;
  for (const [p, f] of Object.entries(executores)) if (f) S.processosCron[p] = f;
  chamadas.length = 0;
}
test.after(() => {
  restaurar();
  for (const k of ENV_KEYS) {
    if (envAnterior[k] === undefined) delete process.env[k]; else process.env[k] = envAnterior[k];
  }
});

function resDe() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
const reqCron = (processo?: string, token: string | null = SEGREDO_TESTE) => ({
  params: processo ? { processo } : {},
  headers: token ? { authorization: `Bearer ${token}` } : {},
  user: undefined,
});

test('registro: exatamente os processos do cron, e recorrências não é processo de cron', () => {
  assert.ok(S.processosCron, 'registro de processos do cron existe');
  assert.deepEqual(Object.keys(S.processosCron).sort(), ['crm', 'pagamentos', 'pedidos', 'publicacoes', 'relatorios']);
  assert.equal('recorrencias' in S.processosCron, false);
});

test('relatórios (incluindo falhas) não disparam pagamentos, publicações, pedidos nem CRM', async () => {
  substituir();
  try {
    const r = await S.executarProcessoCron('relatorios');
    assert.equal(r.ok, true, 'relatórios executam');
    assert.deepEqual(chamadas, [], 'nenhum outro processo foi chamado pelo relatório');
  } finally { restaurar(); }
});

test('independência: falha em pagamentos não impede relatórios', async () => {
  substituir();
  try {
    S.processosCron.pagamentos = async () => { throw new Error('falha simulada de pagamentos'); };
    const falha = await S.executarProcessoCron('pagamentos');
    assert.equal(falha.ok, false, 'pagamentos registra a falha');
    assert.equal(JSON.stringify(falha).includes('falha simulada'), false, 'erro bruto não vai para a resposta');
    const rel = await S.executarProcessoCron('relatorios');
    assert.equal(rel.ok, true, 'relatórios continuam funcionando');
  } finally { restaurar(); }
});

test('concorrência: segunda execução do mesmo processo é recusada com 409', async () => {
  substituir();
  let liberar: () => void = () => {};
  try {
    S.processosCron.publicacoes = () => new Promise((resolve) => { liberar = () => resolve({ itens: 0, detalhes: [], falhas: [] }); });
    const primeira = S.executarProcessoCron('publicacoes');
    const segunda = await S.executarProcessoCron('publicacoes');
    assert.equal(segunda.status, 409, 'segunda execução concorrente recusada');
    liberar();
    const r1 = await primeira;
    assert.equal(r1.ok, true);
  } finally { restaurar(); }
});

test('autenticação: sem CRON_SECRET 503; token errado 401; sessão de usuário não entra', async () => {
  substituir();
  try {
    const semToken = resDe();
    await S.cronProcesso(reqCron('crm', null), semToken);
    assert.equal(semToken.statusCode, 401, 'sem Bearer: 401');
    const errado = resDe();
    await S.cronProcesso(reqCron('crm', 'errado'), errado);
    assert.equal(errado.statusCode, 401, 'token errado: 401');
    const sessao = resDe();
    await S.cronProcesso({ ...reqCron('crm', null), user: { perfil: 'admin', id: 1 } }, sessao);
    assert.equal(sessao.statusCode, 401, 'sessão de administrador NÃO autentica o cron');
    assert.deepEqual(chamadas, [], 'nenhum processo executou sem autenticação');
    const semSegredo = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const sem = resDe();
    await S.cronProcesso(reqCron('crm', SEGREDO_TESTE), sem);
    process.env.CRON_SECRET = semSegredo;
    assert.equal(sem.statusCode, 503, 'sem CRON_SECRET configurado: 503 (falha fechada)');
  } finally { restaurar(); }
});

test('roteamento: processo desconhecido (inclui recorrências) é 404 e nada executa', async () => {
  substituir();
  try {
    for (const nome of ['recorrencias', 'financeiro', 'PAGAMENTOS-X']) {
      const res = resDe();
      await S.cronProcesso(reqCron(nome), res);
      assert.equal(res.statusCode, 404, `${nome}: 404`);
    }
    assert.deepEqual(chamadas, []);
  } finally { restaurar(); }
});

test('roteamento: com token correto, o cron executa somente o processo pedido', async () => {
  substituir();
  try {
    const res = resDe();
    await S.cronProcesso(reqCron('crm'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(chamadas, ['crm'], 'apenas o processo pedido');
    assert.equal(res.body.processo, 'crm');
  } finally { restaurar(); }
});

test('admin (GET run): executa relatórios e não executa pagamentos, publicações, pedidos ou CRM', async () => {
  substituir();
  try {
    const req: any = { user: { id: 1, perfil: 'admin', empresa_id: 1, name: 'Admin' }, params: {}, query: {}, headers: {} };
    const res = resDe();
    await S.runScheduled(req, res);
    assert.deepEqual(chamadas, [], 'sessão admin não dispara processos financeiros/publicação/pedidos/CRM');
  } finally { restaurar(); }
});

test('CRM: com canal desligado não grava lembrete nem envia', async () => {
  const sufixo = `${Date.now()}-crm`;
  const emp = await s.insert(getResource('empresas')!, { nome: `CRM ${sufixo}` } as any);
  const ontem = new Date(Date.now() - 86400000).toISOString();
  const at = await s.insert(getResource('crm_atividades')!, { empresa_id: Number(emp.id), status: 'pendente', tipo: 'ligacao', resumo: `R-${sufixo}`, data_atividade: ontem } as any);
  const r = await S.processosCron.crm().catch((e: unknown) => ({ erro: String(e) }));
  const atual = await s.findOneWhere(getResource('crm_atividades')!, { id: Number(at.id) });
  assert.equal(atual.lembrete_enviado_em ?? null, null, 'nenhum carimbo de envio sem canal');
  assert.equal((r as any).itens ?? 0, 0, 'nenhum lembrete processado sem canal habilitado');
});

test('fila de comércio: o processo pagamentos não processa publicação nem evento de pedido', async () => {
  const O: any = await import('../src/commerce/outbox');
  assert.ok(O.TIPOS_OUTBOX_POR_PROCESSO, 'mapa de tipos por processo existe');
  assert.deepEqual([...O.TIPOS_OUTBOX_POR_PROCESSO.pagamentos], ['refund_devolucao']);
  assert.equal(O.TIPOS_OUTBOX_POR_PROCESSO.pagamentos.includes('publicacao'), false);
  assert.equal(O.TIPOS_OUTBOX_POR_PROCESSO.publicacoes.includes('refund_devolucao'), false);
  assert.equal(O.TIPOS_OUTBOX_POR_PROCESSO.pedidos.includes('refund_devolucao'), false);
  assert.equal(O.TIPOS_OUTBOX_POR_PROCESSO.pedidos.includes('publicacao'), false);
});
