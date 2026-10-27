// ============================================================================
// CRM 3.0 — LEADS, OPORTUNIDADES, ATIVIDADES E MOTIVOS DE PERDA (memória).
//
// Trava o contrato que o CRUD genérico expõe para os quatro recursos novos:
//   • metadado (empresa:true, minPerfil gerente, ops completos);
//   • criar/ler/atualizar/excluir com escopo de empresa;
//   • isolamento multiempresa (A não enxerga B);
//   • campos obrigatórios e valores fora do vocabulário recusados;
//   • oportunidade perdida exige motivo de perda.
//
// O banco de verdade (PostgreSQL) impõe CHECK e FK; aqui travamos a camada de
// serviço, que já aplica o escopo e a validação de referência.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  updateRecord,
} = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'gerente');
const atorB = await criarAtor(2, 'gerente');

const sufixo = String(Date.now() % 1000000).padStart(6, '0');

function leadBase(extra: Record<string, unknown> = {}) {
  return {
    nome: `Lead CRM ${sufixo}`,
    documento: '12345678000195',
    email: `lead${sufixo}@brobond.test`,
    telefone: '6233334444',
    origem: 'indicacao',
    status: 'novo',
    valor_estimado: '15000,00',
    probabilidade: 25,
    previsao_contato: '2026-12-01',
    observacoes: 'lead de teste',
    ...extra,
  };
}

function oportunidadeBase(extra: Record<string, unknown> = {}) {
  return {
    nome: `Oportunidade CRM ${sufixo}`,
    etapa: 'proposta',
    status: 'aberta',
    valor: '25000,00',
    probabilidade: 60,
    previsao_fechamento: '2026-12-15',
    observacoes: 'oportunidade de teste',
    ...extra,
  };
}

function atividadeBase(extra: Record<string, unknown> = {}) {
  return {
    tipo: 'chamada',
    data_atividade: '2026-11-01T10:00:00-03:00',
    resultado: 'realizado',
    resumo: 'atividade de teste',
    proxima_acao: '2026-11-08',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A) Metadado dos quatro recursos (fonte única de verdade)
// ---------------------------------------------------------------------------
test('recursos CRM declaram empresa:true, minPerfil gerente e ops completos', () => {
  for (const key of ['crm_motivos_perda', 'crm_leads', 'crm_oportunidades', 'crm_atividades']) {
    const r = RESOURCES[key];
    assert.ok(r, `recurso ${key} existe em resources.ts`);
    assert.equal(r.empresa, true, `${key}: empresa:true`);
    assert.equal(r.minPerfil, 'gerente', `${key}: minPerfil gerente`);
    assert.deepEqual(r.ops, { create: true, update: true, delete: true }, `${key}: ops`);
    assert.ok(r.table, `${key}: tabela declarada`);
    assert.ok(Array.isArray(r.fields) && r.fields.length > 0, `${key}: campos declarados`);
  }
});

// ---------------------------------------------------------------------------
// B) CRUD de motivos de perda (catálogo de referência)
// ---------------------------------------------------------------------------
test('motivo de perda: criar, ler, atualizar e excluir', async () => {
  const criado = await createRecord(
    RESOURCES.crm_motivos_perda,
    { nome: `Preço ${sufixo}`, ativo: true },
    atorA
  );
  assert.ok(criado != null && Number.isInteger(criado.id), 'createRecord devolve registro com id');
  const idCriado = Number(criado.id);
  assert.equal(criado.nome, `Preço ${sufixo}`);
  assert.equal(criado.ativo, true);

  const lido = await getRecord(RESOURCES.crm_motivos_perda, idCriado, atorA);
  assert.equal(lido.nome, `Preço ${sufixo}`);

  const atualizado = await updateRecord(
    RESOURCES.crm_motivos_perda,
    idCriado,
    { nome: `Preço atualizado ${sufixo}`, ativo: false },
    atorA
  );
  assert.equal(atualizado.nome, `Preço atualizado ${sufixo}`);
  assert.equal(atualizado.ativo, false);

  await deleteRecord(RESOURCES.crm_motivos_perda, idCriado, atorA);

  const erro = await esperarErro(() => getRecord(RESOURCES.crm_motivos_perda, idCriado, atorA), 404);
  assert.ok(erro, 'excluído não é mais lido (404)');
});

// ---------------------------------------------------------------------------
// C) CRUD de leads
// ---------------------------------------------------------------------------
test('lead: criar, ler, atualizar e excluir', async () => {
  const criado = await createRecord(RESOURCES.crm_leads, leadBase(), atorA);
  assert.ok(criado && typeof criado.id === 'number');
  const idCriado = Number(criado.id);
  assert.equal(criado.nome, `Lead CRM ${sufixo}`);
  assert.equal(criado.status, 'novo');
  assert.equal(criado.probabilidade, 25);

  const lido = await getRecord(RESOURCES.crm_leads, idCriado, atorA);
  assert.equal(lido.nome, `Lead CRM ${sufixo}`);

  const atualizado = await updateRecord(
    RESOURCES.crm_leads,
    idCriado,
    { status: 'qualificacao', probabilidade: 50 },
    atorA
  );
  assert.equal(atualizado.status, 'qualificacao');
  assert.equal(atualizado.probabilidade, 50);

  await deleteRecord(RESOURCES.crm_leads, idCriado, atorA);
  const erro = await esperarErro(() => getRecord(RESOURCES.crm_leads, idCriado, atorA), 404);
  assert.ok(erro, 'excluído não é mais lido (404)');
});

// ---------------------------------------------------------------------------
// D) CRUD de oportunidades
// ---------------------------------------------------------------------------
test('oportunidade: criar, ler, atualizar e excluir', async () => {
  const lead = await createRecord(
    RESOURCES.crm_leads,
    leadBase({ nome: `Lead origem ${sufixo}` }),
    atorA
  );
  const criado = await createRecord(
    RESOURCES.crm_oportunidades,
    { ...oportunidadeBase(), lead_id: Number(lead.id) },
    atorA
  );
  assert.ok(criado && typeof criado.id === 'number');
  const idCriado = Number(criado.id);
  assert.equal(criado.nome, `Oportunidade CRM ${sufixo}`);
  assert.equal(criado.etapa, 'proposta');
  assert.equal(criado.status, 'aberta');
  assert.equal(criado.lead_id, Number(lead.id));

  const lido = await getRecord(RESOURCES.crm_oportunidades, idCriado, atorA);
  assert.equal(lido.nome, `Oportunidade CRM ${sufixo}`);

  const atualizado = await updateRecord(
    RESOURCES.crm_oportunidades,
    idCriado,
    { etapa: 'negociacao', probabilidade: 80 },
    atorA
  );
  assert.equal(atualizado.etapa, 'negociacao');
  assert.equal(atualizado.probabilidade, 80);

  await deleteRecord(RESOURCES.crm_oportunidades, idCriado, atorA);
  const erro = await esperarErro(() => getRecord(RESOURCES.crm_oportunidades, idCriado, atorA), 404);
  assert.ok(erro, 'excluído não é mais lido (404)');
});

// ---------------------------------------------------------------------------
// E) CRUD de atividades
// ---------------------------------------------------------------------------
test('atividade: criar, ler, atualizar e excluir', async () => {
  const oportunidade = await createRecord(
    RESOURCES.crm_oportunidades,
    { ...oportunidadeBase(), nome: `Opp para atividade ${sufixo}` },
    atorA
  );
  const criado = await createRecord(
    RESOURCES.crm_atividades,
    { ...atividadeBase(), oportunidade_id: Number(oportunidade.id) },
    atorA
  );
  assert.ok(criado && typeof criado.id === 'number');
  const idCriado = Number(criado.id);
  assert.equal(criado.tipo, 'chamada');
  assert.equal(criado.resultado, 'realizado');
  assert.equal(criado.oportunidade_id, Number(oportunidade.id));

  const lido = await getRecord(RESOURCES.crm_atividades, idCriado, atorA);
  assert.equal(lido.tipo, 'chamada');

  const atualizado = await updateRecord(
    RESOURCES.crm_atividades,
    idCriado,
    { tipo: 'visita', resultado: 'agendado' },
    atorA
  );
  assert.equal(atualizado.tipo, 'visita');
  assert.equal(atualizado.resultado, 'agendado');

  await deleteRecord(RESOURCES.crm_atividades, idCriado, atorA);
  const erro = await esperarErro(() => getRecord(RESOURCES.crm_atividades, idCriado, atorA), 404);
  assert.ok(erro, 'excluído não é mais lido (404)');
});

// ---------------------------------------------------------------------------
// F) Isolamento multiempresa (A não enxerga nem toca B)
// ---------------------------------------------------------------------------
test('isolamento A × B: lead de B não aparece na listagem de A', async () => {
  const b = await createRecord(
    RESOURCES.crm_leads,
    leadBase({ nome: `Lead empresa B ${sufixo}` }),
    atorB
  );
  const listaA = await listRecords(RESOURCES.crm_leads, { page: 1, pageSize: 50 }, empresaA);
  const idsA = (listaA.rows as any[]).map((r) => Number(r.id));
  assert.ok(!idsA.includes(Number(b.id)), `lead da empresa B (${b.id}) não aparece na empresa A`);

  const lerCruzada = await esperarErro(
    () => getRecord(RESOURCES.crm_leads, Number(b.id), atorA),
    404
  );
  assert.ok(lerCruzada, 'leitura cruzada recusa com 404');
});

test('isolamento A × B: escrita cruzada é recusada', async () => {
  const b = await createRecord(
    RESOURCES.crm_leads,
    leadBase({ nome: `Lead empresa B ${sufixo}` }),
    atorB
  );
  const escreverCruzada = await esperarErro(
    () => updateRecord(RESOURCES.crm_leads, Number(b.id), { status: 'contato' }, atorA),
    404
  );
  assert.ok(escreverCruzada, 'escrita cruzada recusa com 404');
});

// ---------------------------------------------------------------------------
// G) Campos obrigatórios e vocabulário
// ---------------------------------------------------------------------------
test('oportunidade: nome obrigatório recusado', async () => {
  const erro = await esperarErro(
    () => createRecord(RESOURCES.crm_oportunidades, { ...oportunidadeBase(), nome: '' }, atorA),
    400
  );
  assert.ok(erro, 'nome vazio é recusado');
  assert.ok(erro.fields?.nome, 'erro reportado no campo nome');
});

test('oportunidade: probabilidade fora de 0-100 recusada', async () => {
  const erro = await esperarErro(
    () =>
      createRecord(RESOURCES.crm_oportunidades, { ...oportunidadeBase(), probabilidade: 110 }, atorA),
    400
  );
  assert.ok(erro, 'probabilidade > 100 é recusada');
});

test('oportunidade perdida exige motivo de perda', async () => {
  const motivo = await createRecord(
    RESOURCES.crm_motivos_perda,
    { nome: `Concorrente ${sufixo}` },
    atorA
  );
  const comMotivo = await createRecord(
    RESOURCES.crm_oportunidades,
    { ...oportunidadeBase(), status: 'perdida', motivo_perda_id: Number(motivo.id) },
    atorA
  );
  assert.equal(comMotivo.status, 'perdida');

  const erro = await esperarErro(
    () =>
      createRecord(RESOURCES.crm_oportunidades, { ...oportunidadeBase(), status: 'perdida' }, atorA),
    400
  );
  assert.ok(erro, 'perdida sem motivo é recusada');
  assert.ok(erro.fields?.motivo_perda_id, 'erro no campo motivo_perda_id');
});

// ---------------------------------------------------------------------------
// H) Listagem paginada e busca por nome
// ---------------------------------------------------------------------------
test('listagem: paginação e busca por nome', async () => {
  await createRecord(RESOURCES.crm_leads, leadBase({ nome: `Busca única ${sufixo}` }), atorA);
  await createRecord(RESOURCES.crm_leads, leadBase({ nome: `Outro lead ${sufixo}` }), atorA);

  const pagina1 = await listRecords(RESOURCES.crm_leads, { page: 1, pageSize: 1 }, empresaA);
  assert.equal(pagina1.rows.length, 1, 'página de 1 traz 1 linha');

  const busca = await listRecords(
    RESOURCES.crm_leads,
    { page: 1, pageSize: 50, q: `Busca única ${sufixo}` },
    empresaA
  );
  assert.ok(
    (busca.rows as any[]).some((r) => String(r.nome).includes(`Busca única ${sufixo}`)),
    'busca encontra o lead pelo nome'
  );
});
