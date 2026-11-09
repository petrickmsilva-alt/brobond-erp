// ============================================================================
// FASE 9.2 — CRM LIFECYCLE AUTOMATION (BL-012/GAP-P2-06)
// LOCAL: store em memória; nenhum e-mail/rede real. O canal externo é injetado.
//
// Cobre: criação/atribuição, lembrete interno, vencida, notificação sem
// duplicidade, reprocessamento, retry, cancelamento, reagendamento, conclusão,
// histórico (trilha), isolamento multiempresa e por usuário, RBAC e leitura.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.NOTIFICAR_CRM_LEMBRETE;

const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const crm = await import('../src/crm');
const crmN = await import('../src/crmNotificacoes');
const s = getStore();

const R_NOTIF = () => getResource('crm_notificacoes')!;
const R_ATIV = () => getResource('crm_atividades')!;

let seq = 0;
function sufixo() {
  seq += 1;
  return `${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

async function cenario() {
  const sfx = sufixo();
  const empA = Number((await s.insert(getResource('empresas')!, { nome: `EmpA ${sfx}` } as any)).id);
  const empB = Number((await s.insert(getResource('empresas')!, { nome: `EmpB ${sfx}` } as any)).id);
  const uA = Number((await s.insert(getResource('usuarios')!, { nome: `RespA ${sfx}`, email: `a.${sfx}@t.local`, perfil: 'gerente' } as any)).id);
  const uA2 = Number((await s.insert(getResource('usuarios')!, { nome: `RespA2 ${sfx}`, email: `a2.${sfx}@t.local`, perfil: 'gerente' } as any)).id);
  const uB = Number((await s.insert(getResource('usuarios')!, { nome: `RespB ${sfx}`, email: `b.${sfx}@t.local`, perfil: 'gerente' } as any)).id);
  // Vínculo de tenant explícito: o aviso só é entregue a destinatário do MESMO
  // tenant (integridade multiempresa — hardening 0114). Sem o vínculo, o
  // destinatário não pertence à empresa e a entrega é recusada.
  const R_UE = getResource('usuario_empresas')!;
  await s.insert(R_UE, { usuario_id: uA, empresa_id: empA } as any);
  await s.insert(R_UE, { usuario_id: uA2, empresa_id: empA } as any);
  await s.insert(R_UE, { usuario_id: uB, empresa_id: empB } as any);
  return { sfx, empA, empB, uA, uA2, uB };
}

function atividade(empresaId: number, extra: Record<string, unknown> = {}) {
  return {
    empresa_id: empresaId,
    status: 'pendente',
    tipo: 'chamada',
    resumo: `R-${sufixo()}`,
    data_atividade: new Date().toISOString(),
    prioridade: 'alta',
    ...extra,
  };
}

async function notificacoes(empresaId: number, usuarioId: number) {
  return (await s.list(R_NOTIF(), { page: 1, pageSize: 500, filter: { empresa_id: empresaId, usuario_id: usuarioId } })).rows;
}

// ---------------------------------------------------------------------------
// 1. CRIAÇÃO E ATRIBUIÇÃO
// ---------------------------------------------------------------------------
test('criação de atividade gera notificação de atribuição ao responsável', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(at);
  const ns = await notificacoes(c.empA, c.uA);
  assert.equal(ns.length, 1);
  assert.equal(ns[0].tipo, 'atribuicao');
  assert.equal(Number(ns[0].atividade_id), Number(at.id));
});

test('atividade sem responsável não gera notificação (não se avisa ninguém)', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA) as any);
  const criou = await crmN.notificarAtividadeCriada(at);
  assert.equal(criou, false);
  assert.equal((await notificacoes(c.empA, c.uA)).length, 0);
});

// ---------------------------------------------------------------------------
// 2. LEMBRETE INTERNO (dentro do prazo) — idempotente
// ---------------------------------------------------------------------------
test('lembrete interno é criado uma vez e não duplica em reprocessamento', async () => {
  const c = await cenario();
  const futuro = new Date(Date.now() + 3600_000).toISOString();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA, lembrete_em: futuro }) as any);
  const quando = new Date(futuro);
  const primeira = await crmN.notificarLembreteInterno(at, quando);
  const segunda = await crmN.notificarLembreteInterno(at, quando);
  assert.equal(primeira, true, 'primeiro lembrete cria');
  assert.equal(segunda, false, 'segundo lembrete (mesmo instante) não duplica');
  const ns = await notificacoes(c.empA, c.uA);
  assert.equal(ns.filter((n) => n.tipo === 'lembrete').length, 1);
});

test('reagendar (novo instante de lembrete) gera novo aviso, sem apagar o anterior', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  const t1 = new Date(Date.now() + 3600_000);
  const t2 = new Date(Date.now() + 7200_000);
  await crmN.notificarLembreteInterno(at, t1);
  await crmN.notificarLembreteInterno(at, t2);
  const ns = (await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'lembrete');
  assert.equal(ns.length, 2, 'dois instantes distintos → dois avisos');
});

// ---------------------------------------------------------------------------
// 3. VENCIDA — idempotente por dia
// ---------------------------------------------------------------------------
test('atividade vencida gera UM aviso por dia (não um por varredura)', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  const agora = new Date();
  await crmN.notificarAtividadeVencida(at, agora);
  await crmN.notificarAtividadeVencida(at, agora);
  assert.equal((await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'vencida').length, 1);
  // Dia seguinte → novo aviso (a pendência persiste).
  const amanha = new Date(agora.getTime() + 86_400_000);
  await crmN.notificarAtividadeVencida(at, amanha);
  assert.equal((await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'vencida').length, 2);
});

// ---------------------------------------------------------------------------
// 4. CICLO DE VIDA NA EDIÇÃO — conclusão, cancelamento, troca de responsável
// ---------------------------------------------------------------------------
test('concluir atividade notifica o responsável (sem duplicar a conclusão)', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  const before = { ...at, status: 'pendente' };
  const row = { ...at, status: 'concluida', concluida_em: new Date().toISOString(), atualizado_em: new Date().toISOString() };
  await crmN.notificarAtividadeAtualizada(before, row);
  await crmN.notificarAtividadeAtualizada(before, row);
  const ns = (await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'conclusao');
  assert.equal(ns.length, 1, 'conclusão não duplica');
});

test('cancelar atividade notifica; reagendar notifica', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA, lembrete_em: new Date().toISOString() }) as any);
  const before = { ...at };
  await crmN.notificarAtividadeAtualizada(before, {
    ...at, status: 'cancelada', cancelada_em: new Date().toISOString(), motivo_cancelamento: 'cliente desmarcou', atualizado_em: new Date().toISOString(),
  });
  const reagendado = { ...at, lembrete_em: new Date(Date.now() + 86_400_000).toISOString(), atualizado_em: new Date().toISOString() };
  await crmN.notificarAtividadeAtualizada(before, reagendado);
  const ns = await notificacoes(c.empA, c.uA);
  assert.ok(ns.some((n) => n.tipo === 'cancelamento'));
  assert.ok(ns.some((n) => n.tipo === 'reagendamento'));
});

test('troca de responsável avisa o NOVO responsável', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  const before = { ...at, responsavel_id: c.uA };
  const row = { ...at, responsavel_id: c.uA2, atualizado_em: new Date().toISOString() };
  await crmN.notificarAtividadeAtualizada(before, row);
  const paraNovo = (await notificacoes(c.empA, c.uA2)).filter((n) => n.tipo === 'alteracao_responsavel');
  const paraAntigo = (await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'alteracao_responsavel');
  assert.equal(paraNovo.length, 1, 'novo responsável avisado');
  assert.equal(paraAntigo.length, 0, 'antigo responsável não recebe aviso interno');
});

// ---------------------------------------------------------------------------
// 5. ISOLAMENTO MULTIEMPRESA E POR USUÁRIO
// ---------------------------------------------------------------------------
test('isolamento: notificação de A não aparece na consulta de B', async () => {
  const c = await cenario();
  const atA = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(atA);
  const emB = await s.list(R_NOTIF(), { page: 1, pageSize: 100, filter: { empresa_id: c.empB } });
  assert.equal(emB.rows.length, 0, 'empresa B não enxerga a caixa de A');
});

test('isolamento: notificação de um usuário não aparece para outro da mesma empresa', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(at);
  assert.equal((await notificacoes(c.empA, c.uA)).length, 1);
  assert.equal((await notificacoes(c.empA, c.uA2)).length, 0, 'outro usuário da mesma empresa não vê');
});

// ---------------------------------------------------------------------------
// 6. AGENDADOR — lembrete interno roda SEM canal externo; e-mail carimba
// ---------------------------------------------------------------------------
test('agendador cria lembrete interno mesmo com canal externo desligado', async () => {
  const c = await cenario();
  const futuro = new Date(Date.now() + 3600_000).toISOString();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA, lembrete_em: futuro }) as any);
  const r = await crm.dispararLembretesCrm();
  assert.equal(r.canal, 'desabilitado');
  const ns = (await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'lembrete');
  assert.equal(ns.length, 1, 'lembrete interno criado sem SMTP');
  // Reprocessar não duplica.
  await crm.dispararLembretesCrm();
  assert.equal((await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'lembrete').length, 1);
  const atual = await s.findOneWhere(R_ATIV(), { id: Number(at.id) });
  assert.equal(atual?.lembrete_enviado_em ?? null, null, 'sem canal externo não carimba envio');
});

test('agendador marca atividade vencida uma vez por dia', async () => {
  const c = await cenario();
  const ontem = new Date(Date.now() - 86_400_000).toISOString();
  await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA, lembrete_em: ontem }) as any);
  await crm.dispararLembretesCrm();
  await crm.dispararLembretesCrm();
  assert.equal((await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'vencida').length, 1);
});

// ---------------------------------------------------------------------------
// 7. RETRY: falha na entrega externa não perde o lembrete interno
// ---------------------------------------------------------------------------
test('retry: falha do canal externo não impede o lembrete interno nem duplica', async () => {
  process.env.NOTIFICAR_CRM_LEMBRETE = 'true';
  try {
    const c = await cenario();
    const ontem = new Date(Date.now() - 86_400_000).toISOString();
    const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA, lembrete_em: ontem }) as any);
    let tentativas = 0;
    crm.definirEntregaLembreteCrmParaTeste(async (p) => {
      if (p.atividadeId !== Number(at.id)) return true;
      tentativas += 1;
      if (tentativas === 1) throw new Error('timeout');
      return true;
    });
    await crm.dispararLembretesCrm();
    // O lembrete interno (vencida) já existe, independente do canal externo.
    assert.ok((await notificacoes(c.empA, c.uA)).some((n) => n.tipo === 'vencida'));
    await crm.dispararLembretesCrm();
    assert.equal(tentativas, 2, 'retry após falha recuperável');
    const atual = await s.findOneWhere(R_ATIV(), { id: Number(at.id) });
    assert.ok(atual?.lembrete_enviado_em, 'carimbo após confirmação');
    // Nenhuma notificação duplicada de vencida.
    assert.equal((await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'vencida').length, 1);
  } finally {
    crm.definirEntregaLembreteCrmParaTeste(undefined);
    delete process.env.NOTIFICAR_CRM_LEMBRETE;
  }
});

// ---------------------------------------------------------------------------
// 8. ENDPOINTS — leitura, marcação de lida, isolamento por ator
// ---------------------------------------------------------------------------
function reqDe(user: any, params: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  return { user, params, query, headers: {} } as any;
}
function resDe() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

test('GET /api/crm/notificacoes devolve só a caixa do próprio ator', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(at);
  const res = resDe();
  await crmN.listarNotificacoesCrm(reqDe({ id: c.uA, perfil: 'gerente', empresa_id: c.empA }), res);
  assert.equal(res.body.itens.length, 1);
  assert.equal(res.body.nao_lidas, 1);
  // Outro usuário da mesma empresa: caixa vazia.
  const res2 = resDe();
  await crmN.listarNotificacoesCrm(reqDe({ id: c.uA2, perfil: 'gerente', empresa_id: c.empA }), res2);
  assert.equal(res2.body.itens.length, 0);
});

test('POST /:id/lida marca a notificação e é idempotente', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(at);
  const n = (await notificacoes(c.empA, c.uA))[0];
  const actor = { id: c.uA, perfil: 'gerente', empresa_id: c.empA };
  await crmN.marcarNotificacaoLida(reqDe(actor, { id: String(n.id) }), resDe());
  const depois = await s.findOneWhere(R_NOTIF(), { id: Number(n.id) });
  assert.ok(depois?.lida_em, 'marcada como lida');
  const primeiroCarimbo = depois!.lida_em;
  await crmN.marcarNotificacaoLida(reqDe(actor, { id: String(n.id) }), resDe());
  const denovo = await s.findOneWhere(R_NOTIF(), { id: Number(n.id) });
  assert.equal(denovo!.lida_em, primeiroCarimbo, 'marcar de novo não altera o carimbo');
});

test('marcar notificação de outro usuário é 403 (não vaza caixa alheia)', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(at);
  const n = (await notificacoes(c.empA, c.uA))[0];
  await assert.rejects(
    () => crmN.marcarNotificacaoLida(reqDe({ id: c.uA2, perfil: 'gerente', empresa_id: c.empA }, { id: String(n.id) }), resDe()),
    (e: any) => e.status === 403,
  );
});

test('marcar todas como lidas só afeta a própria caixa', async () => {
  const c = await cenario();
  const at1 = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  const at2 = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  const at3 = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA2 }) as any);
  await crmN.notificarAtividadeCriada(at1);
  await crmN.notificarAtividadeCriada(at2);
  await crmN.notificarAtividadeCriada(at3);
  await crmN.marcarTodasLidas(reqDe({ id: c.uA, perfil: 'gerente', empresa_id: c.empA }), resDe());
  assert.equal((await notificacoes(c.empA, c.uA)).filter((n) => !n.lida_em).length, 0);
  assert.equal((await notificacoes(c.empA, c.uA2)).filter((n) => !n.lida_em).length, 1, 'caixa do outro intacta');
});

// ---------------------------------------------------------------------------
// 9. RBAC — operador não acessa a caixa do CRM (recurso de gerente)
// ---------------------------------------------------------------------------
test('RBAC: operador não lê a caixa de notificações do CRM', async () => {
  const { checkAccess } = await import('../src/services');
  const operador = { id: 1, perfil: 'operador', empresa_id: 1 } as any;
  assert.throws(() => checkAccess(R_NOTIF(), operador, 'read'), (e: any) => e.status === 403);
});

// ---------------------------------------------------------------------------
// 10. FALHA DE PROCESSAMENTO (aviso administrativo)
// ---------------------------------------------------------------------------
test('falha de processamento gera aviso crítico idempotente por dia', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  const agora = new Date();
  await crmN.notificarFalhaProcessamento(at, 'entrega nao confirmada', agora);
  await crmN.notificarFalhaProcessamento(at, 'entrega nao confirmada', agora);
  const ns = (await notificacoes(c.empA, c.uA)).filter((n) => n.tipo === 'falha');
  assert.equal(ns.length, 1);
  assert.equal(ns[0].severidade, 'critica');
});

// ---------------------------------------------------------------------------
// 11. INTEGRIDADE MULTIEMPRESA DO DESTINATÁRIO (hardening 0114)
// ---------------------------------------------------------------------------
test('destinatário de OUTRA empresa é recusado (não se grava aviso cross-tenant)', async () => {
  const c = await cenario();
  // Atividade da empresa A, mas destinatário é o usuário da empresa B.
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uB }) as any);
  const criou = await crmN.notificarAtividadeCriada(at);
  assert.equal(criou, false, 'entrega recusada: usuário não pertence ao tenant do aviso');
  assert.equal((await notificacoes(c.empA, c.uB)).length, 0, 'nenhum aviso gravado');
  assert.equal((await s.list(R_NOTIF(), { page: 1, pageSize: 100, filter: { empresa_id: c.empA } })).rows.length, 0);
});

test('destinatário SEM vínculo com o tenant também é recusado', async () => {
  const c = await cenario();
  // Usuário avulso (sem vínculo em usuario_empresas): não pertence a empresa alguma.
  const orfao = Number((await s.insert(getResource('usuarios')!, { nome: `Orfao ${c.sfx}`, email: `o.${c.sfx}@t.local`, perfil: 'gerente' } as any)).id);
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: orfao }) as any);
  assert.equal(await crmN.notificarAtividadeCriada(at), false);
  assert.equal((await s.list(R_NOTIF(), { page: 1, pageSize: 100, filter: { empresa_id: c.empA } })).rows.length, 0);
});

test('destinatário com acesso a MAIS de uma empresa recebe na empresa ativa', async () => {
  const c = await cenario();
  // Usuário A ganha acesso à empresa B; a empresa padrão dele continua A.
  await s.insert(getResource('usuario_empresas')!, { usuario_id: c.uA, empresa_id: c.empB } as any);
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  assert.equal(await crmN.notificarAtividadeCriada(at), true, 'destinatário multiempresa é aceito');
  assert.equal((await notificacoes(c.empA, c.uA)).length, 1);
});

// ---------------------------------------------------------------------------
// 12. RETENÇÃO — a trilha sobrevive à remoção do destinatário (SET NULL).
// A semântica é do BANCO (FK ON DELETE SET NULL); o guard de dependências da
// aplicação impede excluir usuário com vínculos. Por isso a prova é no PG real
// (ver server/test/pg/fase9-2-crm-lifecycle.test.ts). Aqui garantimos apenas
// que o recurso aceita `usuario_id` nulo (coluna nullable) — pré-requisito do
// SET NULL.
// ---------------------------------------------------------------------------
test('a caixa aceita aviso sem destinatário (usuario_id nullable)', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(at);
  const n = (await notificacoes(c.empA, c.uA))[0];
  // Simula o efeito do SET NULL: zerar o destinatário preserva a linha.
  await s.update(R_NOTIF(), Number(n.id), { usuario_id: null } as any);
  const depois = await s.findOneWhere(R_NOTIF(), { id: Number(n.id) });
  assert.ok(depois, 'o aviso continua existindo');
  assert.equal(depois!.usuario_id ?? null, null, 'usuario_id zerado, linha preservada');
});

// ---------------------------------------------------------------------------
// 13. MARCAÇÃO EM LOTE SEM TETO SILENCIOSO (hardening 0114)
// ---------------------------------------------------------------------------
test('marcar todas cobre MAIS de uma página de não lidas (sem parar em 500)', async () => {
  const c = await cenario();
  const total = 512; // > página de 500 do lote
  for (let i = 0; i < total; i += 1) {
    const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
    await crmN.notificarAtividadeCriada(at);
  }
  const pendentes = () => s.countWhere(R_NOTIF(), { empresa_id: c.empA, usuario_id: c.uA, lida_em: null });
  assert.equal(await pendentes(), total);
  const res = resDe();
  await crmN.marcarTodasLidas(reqDe({ id: c.uA, perfil: 'gerente', empresa_id: c.empA }), res);
  assert.equal(res.body.marcadas, total, 'todas as 512 foram marcadas, não só as primeiras 500');
  assert.equal(await pendentes(), 0);
  // Idempotente: reexecutar não encontra nada pendente.
  const res2 = resDe();
  await crmN.marcarTodasLidas(reqDe({ id: c.uA, perfil: 'gerente', empresa_id: c.empA }), res2);
  assert.equal(res2.body.marcadas, 0);
});

test('contagem de não lidas (nao_lidas) não é truncada pela página', async () => {
  const c = await cenario();
  const total = 60; // > pageSize 30 da listagem
  for (let i = 0; i < total; i += 1) {
    const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
    await crmN.notificarAtividadeCriada(at);
  }
  const res = resDe();
  await crmN.listarNotificacoesCrm(reqDe({ id: c.uA, perfil: 'gerente', empresa_id: c.empA }, {}, { pageSize: '30' }), res);
  assert.equal(res.body.itens.length, 30, 'página devolve 30 itens');
  assert.equal(res.body.nao_lidas, total, 'nao_lidas conta a caixa inteira, não a página');
});

test('ator sem id não marca a caixa de ninguém (403, nunca "sem checagem")', async () => {
  const c = await cenario();
  const at = await s.insert(R_ATIV(), atividade(c.empA, { responsavel_id: c.uA }) as any);
  await crmN.notificarAtividadeCriada(at);
  const n = (await notificacoes(c.empA, c.uA))[0];
  await assert.rejects(
    () => crmN.marcarNotificacaoLida(reqDe({ perfil: 'gerente', empresa_id: c.empA }, { id: String(n.id) }), resDe()),
    (e: any) => e.status === 403,
  );
});
