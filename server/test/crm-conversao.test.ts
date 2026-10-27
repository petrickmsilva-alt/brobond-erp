// ============================================================================
// CRM 3.0 — CONVERSÃO LEAD → OPORTUNIDADE E COERÊNCIA DO FUNIL
//
// Trava o contrato implementado em server/src/crm.ts e o hardening de
// estágio × status em services.ts:
//
//   • a conversão cria UMA oportunidade vinculada ao lead e carimba o tenant;
//   • valores padrão vêm do lead (valor, probabilidade, previsão, responsável);
//   • é IDEMPOTENTE (repetir devolve a mesma oportunidade);
//   • é TRANSACIONAL e AUDITÁVEL (duas entradas na trilha);
//   • respeita o isolamento A × B (404, sem vazar existência);
//   • respeita o RBAC (operador não converte);
//   • NÃO duplica cliente: vincula o cadastro existente pelo documento;
//   • lead encerrado (ganho/perdido) não converte;
//   • oportunidade fechada não reescreve estágio; fechar preenche a data;
//     reabrir limpa a data e o motivo de perda.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getRecord, listRecords, updateRecord, getStore } = await import('../src/services');
const { converterLead } = await import('../src/crm');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin, reqDe, resFake, chamar, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const s = getStore();

const sufixo = String(Date.now() % 1000000).padStart(6, '0');

function lead(extra: Record<string, unknown> = {}) {
  return {
    nome: `Lead conversão ${sufixo}`,
    email: `conv${sufixo}@brobond.test`,
    origem: 'indicacao',
    status: 'novo',
    valor_estimado: '12000,00',
    probabilidade: 30,
    previsao_contato: '2026-12-20',
    observacoes: 'lead do teste de conversão',
    ...extra,
  };
}

/** Serializa a chamada do handler como o Express faria. */
async function converter(ator: any, id: number, body: Record<string, unknown> = {}, esperado = 201) {
  return chamar(converterLead, reqDe(body, { params: { id }, user: ator }), esperado);
}

// ---------------------------------------------------------------------------
test('conversão: cria oportunidade vinculada, marca o lead e audita', async () => {
  const ator = await criarAtor(1, 'gerente');
  const l = await createRecord(RESOURCES.crm_leads, lead({ responsavel_id: ator.id }), ator);

  const saida = await converter(ator, Number(l.id));
  assert.equal(saida.ok, true);
  assert.equal(saida.idempotente, false);

  const opp = await getRecord(RESOURCES.crm_oportunidades, Number(saida.oportunidade_id), ator);
  assert.equal(Number(opp.lead_id), Number(l.id), 'oportunidade aponta para o lead de origem');
  assert.equal(Number(opp.empresa_id), 1, 'oportunidade nasce na empresa da sessão');
  assert.equal(opp.status, 'aberta');
  assert.equal(opp.etapa, 'qualificacao', 'conversão entra na etapa de qualificação');
  assert.equal(Number(opp.valor), 12000, 'valor herdado do lead');
  assert.equal(Number(opp.probabilidade), 30, 'probabilidade herdada do lead');
  assert.equal(String(opp.previsao_fechamento), '2026-12-20', 'previsão herdada do lead');
  assert.equal(Number(opp.responsavel_id), Number(ator.id), 'responsável herdado do lead');

  const leadDepois = await getRecord(RESOURCES.crm_leads, Number(l.id), ator);
  assert.equal(leadDepois.status, 'qualificacao', 'lead promovido a qualificação');
  assert.ok(leadDepois.lead_convertido_em, 'lead marcado como convertido');

  // Auditoria: uma entrada de criação (oportunidade) e uma de edição (lead).
  const auditoria = await listRecords(
    RESOURCES.auditoria,
    { page: 1, pageSize: 200, filter: { usuario_id: ator.id } },
    { id: ator.id, name: ator.name, perfil: 'admin' }
  );
  const eventos = auditoria.rows.filter((r: any) => Number(r.registro_id) === Number(saida.oportunidade_id) && r.recurso === 'crm_oportunidades');
  assert.ok(eventos.some((r: any) => r.acao === 'criar'), 'criação da oportunidade auditada');
  const doLead = auditoria.rows.filter((r: any) => Number(r.registro_id) === Number(l.id) && r.recurso === 'crm_leads');
  assert.ok(doLead.some((r: any) => r.acao === 'editar'), 'conversão do lead auditada');
  assert.ok(eventos.every((r: any) => Number(r.empresa_id) === 1), 'auditoria carrega a empresa do fato');
});

// ---------------------------------------------------------------------------
test('conversão: idempotente — repetir devolve a MESMA oportunidade', async () => {
  const ator = await criarAtor(1, 'gerente');
  const l = await createRecord(RESOURCES.crm_leads, lead({ nome: `Lead idempotente ${sufixo}` }), ator);

  const primeira = await converter(ator, Number(l.id));
  const segunda = await converter(ator, Number(l.id), {}, 200);

  assert.equal(segunda.idempotente, true);
  assert.equal(Number(segunda.oportunidade_id), Number(primeira.oportunidade_id), 'nenhuma segunda oportunidade foi criada');

  const todas = await listRecords(
    RESOURCES.crm_oportunidades,
    { page: 1, pageSize: 50, filter: { lead_id: Number(l.id) } },
    ator
  );
  assert.equal(todas.rows.length, 1, 'existe exatamente uma oportunidade para o lead convertido');
});

// ---------------------------------------------------------------------------
test('conversão: corpo sobrescreve os padrões do lead', async () => {
  const ator = await criarAtor(1, 'gerente');
  const l = await createRecord(RESOURCES.crm_leads, lead({ nome: `Lead override ${sufixo}` }), ator);

  const saida = await converter(ator, Number(l.id), {
    nome: `Oportunidade manual ${sufixo}`,
    etapa: 'proposta',
    valor: '9999,90',
    probabilidade: 75,
  });
  const opp = await getRecord(RESOURCES.crm_oportunidades, Number(saida.oportunidade_id), ator);
  assert.equal(opp.nome, `Oportunidade manual ${sufixo}`);
  assert.equal(opp.etapa, 'proposta');
  assert.equal(Number(opp.valor), 9999.9);
  assert.equal(Number(opp.probabilidade), 75);
});

// ---------------------------------------------------------------------------
test('conversão: isolamento A × B — lead de outra empresa responde 404', async () => {
  const atorB = await criarAtor(2, 'gerente');
  const leadB = await createRecord(RESOURCES.crm_leads, lead({ nome: `Lead B ${sufixo}` }), atorB);
  const atorA = await criarAtor(1, 'gerente');

  await esperarErro(
    () => converterLead(reqDe({}, { params: { id: Number(leadB.id) }, user: atorA }), resFake().res),
    404
  );

  const aindaNaoConvertido = await getRecord(RESOURCES.crm_leads, Number(leadB.id), atorB);
  assert.ok(!aindaNaoConvertido.lead_convertido_em, 'lead da empresa B não foi tocado');
});

// ---------------------------------------------------------------------------
test('conversão: RBAC — operador recebe 403', async () => {
  const gerente = await criarAtor(1, 'gerente');
  const l = await createRecord(RESOURCES.crm_leads, lead({ nome: `Lead rbac ${sufixo}` }), gerente);
  const operador = await criarAtor(1, 'operador');

  await esperarErro(
    () => converterLead(reqDe({}, { params: { id: Number(l.id) }, user: operador }), resFake().res),
    403
  );
});

// ---------------------------------------------------------------------------
test('conversão: lead ganho/perdido não converte', async () => {
  const ator = await criarAtor(1, 'gerente');
  const l = await createRecord(RESOURCES.crm_leads, lead({ nome: `Lead perdido ${sufixo}`, status: 'perdido' }), ator);

  await esperarErro(
    () => converterLead(reqDe({}, { params: { id: Number(l.id) }, user: ator }), resFake().res),
    409
  );
});

// ---------------------------------------------------------------------------
test('conversão: cliente existente é VINCULADO, não duplicado', async () => {
  const ator = await criarAtor(1, 'gerente');
  const documento = '11222333000181';
  const cliente = await createRecord(
    RESOURCES.clientes,
    { nome: `Cliente vínculo ${sufixo}`, pessoa: 'pj', cnpj_cpf: documento },
    ator
  );
  const antes = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 5, filter: { empresa_id: 1 } }, ator);

  const l = await createRecord(RESOURCES.crm_leads, lead({ nome: `Lead cliente ${sufixo}`, documento }), ator);
  const saida = await converter(ator, Number(l.id));

  const opp = await getRecord(RESOURCES.crm_oportunidades, Number(saida.oportunidade_id), ator);
  assert.equal(Number(opp.cliente_id), Number(cliente.id), 'oportunidade vinculada ao cliente já cadastrado');

  const depois = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 5, filter: { empresa_id: 1 } }, ator);
  assert.equal(depois.total, antes.total, 'nenhum cliente novo foi criado pela conversão');
});

// ---------------------------------------------------------------------------
test('funil: fechar preenche a data, congela o estágio e reabrir limpa a data', async () => {
  const ator = await criarAtor(1, 'gerente');
  const motivo = await createRecord(RESOURCES.crm_motivos_perda, { nome: `Motivo funil ${sufixo}` }, ator);
  const opp = await createRecord(
    RESOURCES.crm_oportunidades,
    { nome: `Opp funil ${sufixo}`, etapa: 'negociacao', status: 'aberta', valor: 5000 },
    ator
  );

  const perdida = await updateRecord(
    RESOURCES.crm_oportunidades,
    Number(opp.id),
    { status: 'perdida', motivo_perda_id: Number(motivo.id) },
    ator
  );
  assert.equal(perdida.status, 'perdida');
  assert.ok(perdida.data_fechamento, 'fechar preenche data_fechamento');

  const erro = await esperarErro(
    () => updateRecord(RESOURCES.crm_oportunidades, Number(opp.id), { etapa: 'proposta' }, ator),
    409
  );
  assert.match(String(erro.message), /estágio/i);

  const reaberta = await updateRecord(
    RESOURCES.crm_oportunidades,
    Number(opp.id),
    { status: 'aberta', etapa: 'proposta' },
    ator
  );
  assert.equal(reaberta.status, 'aberta');
  assert.equal(reaberta.etapa, 'proposta', 'reabrir devolve o movimento no funil');
  assert.ok(!reaberta.data_fechamento, 'reabrir limpa a data de fechamento');
  assert.ok(!reaberta.motivo_perda_id, 'motivo de perda não sobrevive à reabertura');
});

// ---------------------------------------------------------------------------
test('funil: ganhar limpa motivo de perda herdado', async () => {
  const ator = await criarAtor(1, 'gerente');
  const motivo = await createRecord(RESOURCES.crm_motivos_perda, { nome: `Motivo ganho ${sufixo}` }, ator);
  const opp = await createRecord(
    RESOURCES.crm_oportunidades,
    { nome: `Opp ganho ${sufixo}`, etapa: 'fechamento', status: 'perdida', motivo_perda_id: Number(motivo.id) },
    ator
  );
  assert.ok(opp.data_fechamento, 'criar já fechada preenche a data');

  const ganha = await updateRecord(
    RESOURCES.crm_oportunidades,
    Number(opp.id),
    { status: 'ganha' },
    ator
  );
  assert.equal(ganha.status, 'ganha');
  assert.equal(ganha.motivo_perda_id ?? null, null, 'ganhar não carrega motivo de perda');
});

// ---------------------------------------------------------------------------
test('conversão: lead de B não pode ser referenciado por oportunidade de A', async () => {
  const atorB = await criarAtor(2, 'gerente');
  const leadB = await createRecord(RESOURCES.crm_leads, lead({ nome: `Lead cross ${sufixo}` }), atorB);
  const atorA = await criarAtor(1, 'gerente');

  // Camada de serviço: criar oportunidade em A apontando para lead de B é 404.
  await esperarErro(
    () =>
      createRecord(
        RESOURCES.crm_oportunidades,
        { nome: `Opp cross ${sufixo}`, etapa: 'prospeccao', status: 'aberta', lead_id: Number(leadB.id) },
        atorA
      ),
    404
  );

  // E o store não deixa vazar o lead de B para uma leitura de A.
  const scoped = await s.findOneWhere(RESOURCES.crm_leads, { id: Number(leadB.id), empresa_id: empresaA.empresaId });
  assert.equal(scoped, null, 'lead de B não é visível no escopo de A');
  const doB = await s.findOneWhere(RESOURCES.crm_leads, { id: Number(leadB.id), empresa_id: empresaB.empresaId });
  assert.ok(doB, 'o mesmo lead é visível no escopo de B');
});
