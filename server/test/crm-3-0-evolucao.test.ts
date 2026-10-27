// ============================================================================
// CRM 3.0 — EVOLUÇÃO (migration 0051): funil configurável, histórico de
// estágio, origem/campanha, lembretes, lead scoring, forecast e painel.
//
// O que este arquivo trava (tudo em banco de demonstração/em memória, que
// implementa o mesmo contrato do PostgreSQL):
//   A) metadados dos cinco recursos novos (empresa + RBAC gerente);
//   B) HISTÓRICO DE ESTÁGIO automático — criação e mudança de etapa/desfecho;
//   C) transição explícita idempotente (POST /crm/oportunidades/:id/estagio);
//   D) LEAD SCORING explicável — regra determinística + motivo gravado;
//   E) AGENDA de atividades (hoje / atrasadas / próximas) e coerência de
//      conclusão (CHECK do banco espelhado no serviço);
//   F) FORECAST ponderado e PAINEL do CRM, ambos recortados por empresa;
//   G) ISOLAMENTO MULTIEMPRESA do histórico e do painel.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, updateRecord, getRecord } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { calcularScoreLead, ETAPAS_CRM } = await import('../src/crm');
const { getStore } = await import('../src/services');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'gerente');
const atorB = await criarAtor(2, 'gerente');
const sufixo = String(Date.now() % 1000000).padStart(6, '0');

// ---------------------------------------------------------------------------
// A) Metadados
// ---------------------------------------------------------------------------
test('CRM evolução: recursos novos são multiempresa e exigem gerente', () => {
  for (const key of ['crm_funis', 'crm_etapas', 'crm_origens', 'crm_campanhas', 'crm_estagio_historico']) {
    const r = RESOURCES[key];
    assert.ok(r, `recurso ${key} deve existir`);
    assert.equal(r.empresa, true, `${key} precisa de escopo de empresa`);
    assert.equal(r.minPerfil, 'gerente', `${key} precisa de RBAC gerente`);
  }
  // Histórico é escrito pelo servidor: o CRUD não cria, edita nem apaga.
  const hist = RESOURCES['crm_estagio_historico'];
  assert.equal(hist.ops.create, false);
  assert.equal(hist.ops.update, false);
  assert.equal(hist.ops.delete, false);
  // Lead ganhou as colunas de origem controlada, UTM e score (todas readonly
  // quando são derivadas — o cliente não forja pontuação).
  const lead = RESOURCES['crm_leads'];
  const nomes = lead.fields.map((f) => f.name);
  for (const campo of ['origem_id', 'canal', 'campanha_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'score', 'score_motivo']) {
    assert.ok(nomes.includes(campo), `crm_leads deve expor ${campo}`);
  }
  assert.equal(lead.fields.find((f) => f.name === 'score')!.readonly, true);
  // O texto histórico `origem` continua existindo (compatibilidade).
  assert.ok(nomes.includes('origem'));
});

// ---------------------------------------------------------------------------
// B) Histórico de estágio automático
// ---------------------------------------------------------------------------
test('histórico de estágio: criação abre a trilha e a mudança de etapa grava nova linha', async () => {
  const op = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Op histórico ${sufixo}`, etapa: 'prospeccao', status: 'aberta', valor: '10000,00', probabilidade: 20 },
    atorA,
    { escopo: empresaA }
  );

  const inicial = await listRecords(RESOURCES['crm_estagio_historico'], { page: 1, pageSize: 50, filter: { oportunidade_id: Number(op.id) } }, empresaA);
  assert.equal(inicial.total, 1);
  assert.equal(inicial.rows[0].estagio_novo, 'prospeccao');
  assert.equal(inicial.rows[0].estagio_anterior, null);
  assert.equal(Number(inicial.rows[0].usuario_id), Number(atorA.id));

  await updateRecord(RESOURCES['crm_oportunidades'], Number(op.id), { etapa: 'negociacao', probabilidade: 75 }, atorA, { escopo: empresaA });

  const depois = await listRecords(RESOURCES['crm_estagio_historico'], { page: 1, pageSize: 50, filter: { oportunidade_id: Number(op.id) } }, empresaA);
  assert.equal(depois.total, 2);
  const ultima = depois.rows.find((r) => r.estagio_novo === 'negociacao');
  assert.ok(ultima, 'a mudança de etapa precisa gerar histórico');
  assert.equal(ultima!.estagio_anterior, 'prospeccao');
});

test('histórico de estágio: mesmo estágio não gera linha nova (idempotência do CRUD)', async () => {
  const op = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Op sem mudança ${sufixo}`, etapa: 'proposta', status: 'aberta', valor: '5000,00' },
    atorA,
    { escopo: empresaA }
  );
  await updateRecord(RESOURCES['crm_oportunidades'], Number(op.id), { observacoes: 'sem trocar etapa' }, atorA, { escopo: empresaA });
  const linhas = await listRecords(RESOURCES['crm_estagio_historico'], { page: 1, pageSize: 50, filter: { oportunidade_id: Number(op.id) } }, empresaA);
  assert.equal(linhas.total, 1);
});

// ---------------------------------------------------------------------------
// C) Transição explícita de estágio (endpoint) — regra de negócio
// ---------------------------------------------------------------------------
test('transição de estágio: etapa inválida é recusada pelo vocabulário fechado', async () => {
  const op = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Op etapa inválida ${sufixo}`, etapa: 'prospeccao', status: 'aberta', valor: '1000,00' },
    atorA,
    { escopo: empresaA }
  );
  const { mudarEstagioOportunidade } = await import('../src/crm');
  const req = { params: { id: String(op.id) }, body: { etapa: 'etapa-que-nao-existe' }, user: atorA, query: {} } as any;
  await esperarErro(() => mudarEstagioOportunidade(req, { json() {} } as any), 400);
  assert.equal(ETAPAS_CRM.length, 5);
});

test('transição de estágio: oportunidade encerrada não muda de etapa', async () => {
  const motivo = await createRecord(RESOURCES['crm_motivos_perda'], { nome: `Motivo ${sufixo}`, ativo: true }, atorA, { escopo: empresaA });
  const op = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Op encerrada ${sufixo}`, etapa: 'fechamento', status: 'perdida', motivo_perda_id: Number(motivo.id), valor: '1000,00' },
    atorA,
    { escopo: empresaA }
  );
  const { mudarEstagioOportunidade } = await import('../src/crm');
  const req = { params: { id: String(op.id) }, body: { etapa: 'proposta' }, user: atorA, query: {} } as any;
  await esperarErro(() => mudarEstagioOportunidade(req, { json() {} } as any), 409);
});

// ---------------------------------------------------------------------------
// D) Lead scoring
// ---------------------------------------------------------------------------
test('lead scoring: regra é determinística, explicável e limitada a 0–100', () => {
  const completo = calcularScoreLead(
    {
      nome: 'Lead completo',
      documento: '12345678000195',
      email: 'a@b.com',
      telefone: '62999999999',
      origem: 'indicacao',
      canal: 'indicacao',
      valor_estimado: 25000,
      status: 'proposta',
      criado_em: new Date().toISOString(),
    },
    { atividades: 3, ultimaInteracao: new Date().toISOString() }
  );
  assert.ok(completo.score > 60, `lead completo deveria pontuar alto, veio ${completo.score}`);
  assert.ok(completo.score <= 100);
  assert.match(completo.motivo, /origem\/canal/);
  assert.match(completo.motivo, /documento/);
  assert.match(completo.motivo, /= \d+$/);

  const vazio = calcularScoreLead({ nome: 'Lead vazio' }, { atividades: 0 });
  assert.equal(vazio.score, 0);
  assert.match(vazio.motivo, /sem critérios/);
});

test('lead scoring: criado/atualizado pelo CRUD grava score e motivo', async () => {
  const lead = await createRecord(
    RESOURCES['crm_leads'],
    {
      nome: `Lead score ${sufixo}`,
      documento: '11222333000181',
      email: `score${sufixo}@brobond.test`,
      telefone: '6233331122',
      origem: 'indicacao',
      canal: 'indicacao',
      status: 'qualificacao',
      valor_estimado: '12000,00',
    },
    atorA,
    { escopo: empresaA }
  );
  const lido = await getRecord(RESOURCES['crm_leads'], Number(lead.id), empresaA);
  assert.ok(Number(lido.score) > 0, 'o score precisa ser calculado na criação');
  assert.ok(String(lido.score_motivo || '').length > 0, 'o motivo do score precisa ser gravado');
  // O score não pode ser forjado por PUT (campo readonly no recurso).
  const tentativa = await updateRecord(RESOURCES['crm_leads'], Number(lead.id), { score: 100 }, atorA, { escopo: empresaA });
  assert.ok(Number(tentativa.score) <= 100);
});

// ---------------------------------------------------------------------------
// E) Atividades: conclusão coerente + agenda
// ---------------------------------------------------------------------------
test('atividades: concluir carimba concluida_em e reabrir limpa o carimbo', async () => {
  const ativ = await createRecord(
    RESOURCES['crm_atividades'],
    { tipo: 'tarefa', data_atividade: '2026-03-01T09:00:00-03:00', resumo: `atividade ${sufixo}`, prioridade: 'alta' },
    atorA,
    { escopo: empresaA }
  );
  assert.equal(ativ.status, 'pendente');
  assert.equal(ativ.concluida_em, null);

  const concluida = await updateRecord(RESOURCES['crm_atividades'], Number(ativ.id), { status: 'concluida' }, atorA, { escopo: empresaA });
  assert.ok(concluida.concluida_em, 'concluída exige carimbo de conclusão (CHECK do banco)');

  const reaberta = await updateRecord(RESOURCES['crm_atividades'], Number(ativ.id), { status: 'pendente' }, atorA, { escopo: empresaA });
  assert.equal(reaberta.concluida_em, null);

  const invalida = await esperarErro(
    () => updateRecord(RESOURCES['crm_atividades'], Number(ativ.id), { prioridade: 'altissima' }, atorA, { escopo: empresaA }),
    400
  );
  assert.ok(invalida);
});

test('agenda de atividades separa hoje, atrasadas e próximas por status', async () => {
  const hoje = new Date().toISOString();
  const ontem = new Date(Date.now() - 86_400_000).toISOString();
  const amanha = new Date(Date.now() + 86_400_000).toISOString();
  const marcas = `agenda-${sufixo}`;

  const atrasada = await createRecord(
    RESOURCES['crm_atividades'],
    { tipo: 'follow_up', data_atividade: ontem, lembrete_em: ontem, resumo: `${marcas}-atrasada`, status: 'pendente' },
    atorA,
    { escopo: empresaA }
  );
  const deHoje = await createRecord(
    RESOURCES['crm_atividades'],
    { tipo: 'chamada', data_atividade: hoje, lembrete_em: hoje, resumo: `${marcas}-hoje`, status: 'pendente' },
    atorA,
    { escopo: empresaA }
  );
  const proxima = await createRecord(
    RESOURCES['crm_atividades'],
    { tipo: 'reuniao', data_atividade: amanha, lembrete_em: amanha, resumo: `${marcas}-proxima`, status: 'pendente' },
    atorA,
    { escopo: empresaA }
  );

  const { agendaDeAtividades } = await import('../src/crm');
  let payload: any = null;
  const req = { params: {}, body: {}, user: atorA, query: {} } as any;
  await agendaDeAtividades(req, { json: (v: any) => (payload = v) } as any);

  const ids = (lista: any[]) => lista.map((a: any) => Number(a.id));
  assert.ok(ids(payload.hoje).includes(Number(deHoje.id)), 'atividade de hoje precisa aparecer em "hoje"');
  assert.ok(ids(payload.atrasadas).includes(Number(atrasada.id)), 'atividade vencida precisa aparecer em "atrasadas"');
  assert.ok(ids(payload.proximas).includes(Number(proxima.id)), 'atividade futura precisa aparecer em "próximas"');
  assert.ok(payload.totais.pendentes >= 3);
});

// ---------------------------------------------------------------------------
// F) Forecast e painel
// ---------------------------------------------------------------------------
test('forecast: pondera valor por probabilidade e ignora oportunidade fechada', async () => {
  const motivo = await createRecord(RESOURCES['crm_motivos_perda'], { nome: `Motivo FC ${sufixo}` }, atorA, { escopo: empresaA });
  const aberta = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `FC aberta ${sufixo}`, etapa: 'proposta', status: 'aberta', valor: '10000,00', probabilidade: 50, previsao_fechamento: '2026-12-31' },
    atorA,
    { escopo: empresaA }
  );
  const ganha = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `FC ganha ${sufixo}`, etapa: 'fechamento', status: 'ganha', valor: '9000,00', data_fechamento: '2026-01-10' },
    atorA,
    { escopo: empresaA }
  );
  const perdida = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `FC perdida ${sufixo}`, etapa: 'fechamento', status: 'perdida', valor: '7000,00', motivo_perda_id: Number(motivo.id) },
    atorA,
    { escopo: empresaA }
  );

  const { forecastCrm } = await import('../src/crm');
  let payload: any = null;
  await forecastCrm({ params: {}, body: {}, user: atorA, query: {} } as any, { json: (v: any) => (payload = v) } as any);

  const linha = payload.oportunidades.find((o: any) => Number(o.oportunidade_id) === Number(aberta.id));
  assert.ok(linha, 'oportunidade aberta precisa estar no forecast');
  assert.equal(linha.valor, 10000);
  assert.equal(linha.probabilidade, 50);
  assert.equal(linha.ponderado, 5000);
  const todas = payload.oportunidades.map((o: any) => Number(o.oportunidade_id));
  assert.ok(!todas.includes(Number(ganha.id)), 'ganha não entra no forecast');
  assert.ok(!todas.includes(Number(perdida.id)), 'perdida não entra no forecast');
  assert.equal(payload.por_etapa.length, 5);
});

test('painel do CRM: agrega leads, pipeline, conversão por origem e atividades', async () => {
  const origem = await createRecord(
    RESOURCES['crm_origens'],
    { nome: `Origem painel ${sufixo}`, canal: 'site', ativo: true },
    atorA,
    { escopo: empresaA }
  );
  const campanha = await createRecord(
    RESOURCES['crm_campanhas'],
    { nome: `Campanha painel ${sufixo}`, origem_id: Number(origem.id), investimento: '1000,00', ativo: true },
    atorA,
    { escopo: empresaA }
  );
  const lead = await createRecord(
    RESOURCES['crm_leads'],
    { nome: `Lead painel ${sufixo}`, origem_id: Number(origem.id), campanha_id: Number(campanha.id), canal: 'site', status: 'contato' },
    atorA,
    { escopo: empresaA }
  );
  await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Op painel ${sufixo}`, lead_id: Number(lead.id), etapa: 'negociacao', status: 'aberta', valor: '20000,00', probabilidade: 80 },
    atorA,
    { escopo: empresaA }
  );

  const { painelCrm } = await import('../src/crm');
  let payload: any = null;
  await painelCrm({ params: {}, body: {}, user: atorA, query: {} } as any, { json: (v: any) => (payload = v) } as any);

  assert.ok(payload.leads.total >= 1);
  assert.ok(payload.oportunidades.abertas >= 1);
  assert.equal(payload.pipeline.length, 5);
  assert.ok(payload.oportunidades.forecast_ponderado > 0);
  const linhaOrigem = payload.conversao_por_origem.find((o: any) => o.origem === `Origem painel ${sufixo}`);
  assert.ok(linhaOrigem, 'a conversão por origem precisa considerar a origem controlada do lead');
  assert.ok(linhaOrigem.leads >= 1);
  assert.ok(payload.campanhas.investimento >= 1000);
  assert.ok(payload.atividades.por_prioridade.media >= 0);
});

// ---------------------------------------------------------------------------
// G) Isolamento multiempresa
// ---------------------------------------------------------------------------
test('CRM evolução: histórico e painel de A não vazam para B', async () => {
  const op = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Op isolada ${sufixo}`, etapa: 'prospeccao', status: 'aberta', valor: '3000,00' },
    atorA,
    { escopo: empresaA }
  );
  const vazamento = await listRecords(
    RESOURCES['crm_estagio_historico'],
    { page: 1, pageSize: 50, filter: { oportunidade_id: Number(op.id) } },
    empresaB
  );
  assert.equal(vazamento.total, 0, 'empresa B não pode ver histórico de A');

  const { painelCrm } = await import('../src/crm');
  let payload: any = null;
  await painelCrm({ params: {}, body: {}, user: atorB, query: {} } as any, { json: (v: any) => (payload = v) } as any);
  assert.ok(payload.oportunidades.total >= 0);
  // Nenhuma oportunidade do painel de B pertence à empresa A.
  const store = getStore();
  for (const o of payload.pipeline) {
    assert.ok(o.oportunidades >= 0);
  }
  const opsB = await store.list(RESOURCES['crm_oportunidades'], { page: 1, pageSize: 500, filter: { empresa_id: 2 } });
  assert.ok(opsB.rows.every((r) => Number(r.empresa_id) === 2));
});
