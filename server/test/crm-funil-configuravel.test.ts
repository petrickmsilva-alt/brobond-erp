// ============================================================================
// CRM — FUNIL REALMENTE CONFIGURÁVEL (migration 0057)
//
// O PR #92 declarou "funil/etapas configuráveis", mas a oportunidade continuava
// presa ao vocabulário fixo da 0049 (CHECK do banco + `ETAPAS_CRM` no código):
// cadastrar "Demonstração" não permitia usar "Demonstração". Este arquivo prova,
// ponta a ponta, que agora permite — e prova também o que NÃO pode acontecer.
//
// CASOS COBERTOS (os 12 exigidos na correção):
//   1  Empresa A cria etapa customizada ("Demonstração") e a usa
//   2  Empresa A cria "Aprovação Jurídica" e avança a oportunidade para ela
//   3  Empresa B tem etapas próprias e NÃO usa as de A
//   4  Etapa inativa não recebe movimentação nova
//   5  Etapa de OUTRO funil da mesma empresa é rejeitada
//   6  Etapa de OUTRO tenant é rejeitada (404, sem vazar existência)
//   7  Mudança de etapa grava histórico
//   8  Falha ao gravar o histórico → rollback (oportunidade não muda)
//   9  Lead convertido nasce na etapa válida do funil (primeira ativa)
//  10  Conversão repetida devolve a MESMA oportunidade
//  11  Etapa com probabilidade 65% → oportunidade recebe 65%
//  12  Etapa customizada com probabilidade própria → forecast usa essa
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, updateRecord, getRecord, getStore } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'gerente');
const atorB = await criarAtor(2, 'gerente');
const sufixo = String(Date.now() % 1000000).padStart(6, '0');

/** Cria funil + etapa pelo CRUD real (nada de INSERT direto no teste). */
async function criarEtapa(
  ator: any,
  escopo: any,
  funilId: number,
  nome: string,
  chave: string,
  ordem: number,
  probabilidade: number,
  ativo = true
) {
  return createRecord(
    RESOURCES['crm_etapas'],
    { funil_id: funilId, nome, chave, ordem, probabilidade, ativo },
    ator,
    { escopo }
  );
}

async function criarFunil(ator: any, escopo: any, nome: string, padrao = false) {
  return createRecord(RESOURCES['crm_funis'], { nome, padrao, ativo: true }, ator, { escopo });
}

// ---------------------------------------------------------------------------
// 1) Etapa customizada pode ser usada
// ---------------------------------------------------------------------------
test('1) empresa A cadastra "Demonstração" e a oportunidade usa essa etapa', async () => {
  const funil = await criarFunil(atorA, empresaA, `Funil demonstração ${sufixo}`);
  const etapa = await criarEtapa(atorA, empresaA, Number(funil.id), 'Demonstração', 'demonstracao', 3, 40);

  const opp = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp demonstração ${sufixo}`, funil_id: Number(funil.id), etapa_id: Number(etapa.id), status: 'aberta', valor: 5000 },
    atorA,
    { escopo: empresaA }
  );

  assert.equal(Number(opp.etapa_id), Number(etapa.id), 'a referência operacional é a etapa do cadastro');
  assert.equal(String(opp.etapa), 'demonstracao', 'a chave textual acompanha o cadastro');
  assert.equal(Number(opp.funil_id), Number(funil.id));
  assert.equal(Number(opp.probabilidade), 40, 'probabilidade da etapa aplicada na criação');
});

// ---------------------------------------------------------------------------
// 2) Avançar para etapa criada depois do funil existir
// ---------------------------------------------------------------------------
test('2) oportunidade avança para "Aprovação Jurídica" criada pela empresa', async () => {
  const funil = await criarFunil(atorA, empresaA, `Funil jurídico ${sufixo}`);
  await criarEtapa(atorA, empresaA, Number(funil.id), 'Diagnóstico', 'diagnostico', 1, 20);
  const juridico = await criarEtapa(atorA, empresaA, Number(funil.id), 'Aprovação Jurídica', 'aprovacao_juridica', 2, 65);

  const opp = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp jurídico ${sufixo}`, funil_id: Number(funil.id), etapa: 'diagnostico', status: 'aberta', valor: 8000 },
    atorA,
    { escopo: empresaA }
  );

  const { mudarEstagioOportunidade } = await import('../src/crm');
  const req = {
    params: { id: String(opp.id) },
    body: { etapa_id: Number(juridico.id), observacao: 'Parecer do jurídico' },
    user: atorA,
    query: {},
  } as any;
  let resposta: any = null;
  await mudarEstagioOportunidade(req, { json: (v: any) => (resposta = v) } as any);

  assert.equal(resposta.idempotente, false);
  assert.equal(resposta.etapa, 'aprovacao_juridica');
  assert.equal(Number(resposta.etapa_id), Number(juridico.id));
  // 11) probabilidade POR ETAPA: 65% da etapa, sem o gestor digitar
  assert.equal(Number(resposta.probabilidade), 65, 'a probabilidade da etapa é aplicada na transição');

  const depois = await getRecord(RESOURCES['crm_oportunidades'], Number(opp.id), atorA, { escopo: empresaA });
  assert.equal(String(depois.etapa), 'aprovacao_juridica');
  assert.equal(Number(depois.etapa_id), Number(juridico.id));
});

// ---------------------------------------------------------------------------
// 3) Empresa B não usa etapas de A
// ---------------------------------------------------------------------------
test('3) empresa B só enxerga e usa as PRÓPRIAS etapas', async () => {
  const funilB = await criarFunil(atorB, empresaB, `Funil B ${sufixo}`, true);
  const etapaB = await criarEtapa(atorB, empresaB, Number(funilB.id), 'Contato', 'contato_b', 1, 15);

  const oppB = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp B ${sufixo}`, funil_id: Number(funilB.id), etapa: 'contato_b', status: 'aberta', valor: 1000 },
    atorB,
    { escopo: empresaB }
  );
  assert.equal(Number(oppB.etapa_id), Number(etapaB.id));

  // A chave do funil de B não existe no cadastro de A.
  await esperarErro(
    () =>
      createRecord(
        RESOURCES['crm_oportunidades'],
        { nome: `Opp B na empresa A ${sufixo}`, etapa: 'contato_b', status: 'aberta', valor: 1000 },
        atorA,
        { escopo: empresaA }
      ),
    422
  );

  // E a leitura de A nunca devolve a etapa de B.
  const etapasDeA = await listRecords(RESOURCES['crm_etapas'], { page: 1, pageSize: 500, filter: {} }, empresaA);
  assert.ok(!etapasDeA.rows.some((e: any) => Number(e.id) === Number(etapaB.id)), 'etapa de B não aparece em A');
});

// ---------------------------------------------------------------------------
// 4) Etapa inativa
// ---------------------------------------------------------------------------
test('4) etapa inativa não recebe oportunidade nova nem movimentação', async () => {
  const funil = await criarFunil(atorA, empresaA, `Funil inativo ${sufixo}`);
  const ativa = await criarEtapa(atorA, empresaA, Number(funil.id), 'Ativa', 'ativa_x', 1, 10);
  const inativa = await criarEtapa(atorA, empresaA, Number(funil.id), 'Descontinuada', 'descontinuada', 2, 30, false);

  await esperarErro(
    () =>
      createRecord(
        RESOURCES['crm_oportunidades'],
        { nome: `Opp inativa ${sufixo}`, funil_id: Number(funil.id), etapa_id: Number(inativa.id), status: 'aberta', valor: 100 },
        atorA,
        { escopo: empresaA }
      ),
    422
  );

  const opp = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp ativa ${sufixo}`, funil_id: Number(funil.id), etapa_id: Number(ativa.id), status: 'aberta', valor: 100 },
    atorA,
    { escopo: empresaA }
  );
  const { mudarEstagioOportunidade } = await import('../src/crm');
  const req = { params: { id: String(opp.id) }, body: { etapa_id: Number(inativa.id) }, user: atorA, query: {} } as any;
  await esperarErro(() => mudarEstagioOportunidade(req, { json() {} } as any), 422);
});

// ---------------------------------------------------------------------------
// 5) Etapa de outro funil da mesma empresa
// ---------------------------------------------------------------------------
test('5) etapa de outro funil da mesma empresa é rejeitada (422)', async () => {
  const funil1 = await criarFunil(atorA, empresaA, `Funil 1 ${sufixo}`);
  const funil2 = await criarFunil(atorA, empresaA, `Funil 2 ${sufixo}`);
  const etapa1 = await criarEtapa(atorA, empresaA, Number(funil1.id), 'Etapa um', 'etapa_um', 1, 10);
  const etapa2 = await criarEtapa(atorA, empresaA, Number(funil2.id), 'Etapa dois', 'etapa_dois', 1, 10);

  const opp = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp funil 1 ${sufixo}`, funil_id: Number(funil1.id), etapa_id: Number(etapa1.id), status: 'aberta', valor: 100 },
    atorA,
    { escopo: empresaA }
  );

  const erro: any = await esperarErro(
    () =>
      updateRecord(
        RESOURCES['crm_oportunidades'],
        Number(opp.id),
        { etapa_id: Number(etapa2.id) },
        atorA,
        { escopo: empresaA }
      ),
    422
  );
  assert.match(String(erro.message), /outro funil/);

  const intacta = await getRecord(RESOURCES['crm_oportunidades'], Number(opp.id), atorA, { escopo: empresaA });
  assert.equal(Number(intacta.etapa_id), Number(etapa1.id), 'a oportunidade não foi movida');
});

// ---------------------------------------------------------------------------
// 6) Cross-tenant
// ---------------------------------------------------------------------------
test('6) etapa de outro tenant é recusada com 404 (sem vazar existência)', async () => {
  const funilB = await criarFunil(atorB, empresaB, `Funil cross ${sufixo}`, true);
  const etapaB = await criarEtapa(atorB, empresaB, Number(funilB.id), 'Secreta B', 'secreta_b', 1, 10);

  const funilA = await criarFunil(atorA, empresaA, `Funil A cross ${sufixo}`);
  const etapaA = await criarEtapa(atorA, empresaA, Number(funilA.id), 'Pública A', 'publica_a', 1, 10);

  // A tenta usar a etapa de B na criação.
  await esperarErro(
    () =>
      createRecord(
        RESOURCES['crm_oportunidades'],
        { nome: `Opp cross ${sufixo}`, funil_id: Number(funilA.id), etapa_id: Number(etapaB.id), status: 'aberta', valor: 100 },
        atorA,
        { escopo: empresaA }
      ),
    404
  );

  // A tenta mover uma oportunidade própria para a etapa de B.
  const opp = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp A cross ${sufixo}`, funil_id: Number(funilA.id), etapa_id: Number(etapaA.id), status: 'aberta', valor: 100 },
    atorA,
    { escopo: empresaA }
  );
  const { mudarEstagioOportunidade } = await import('../src/crm');
  const req = { params: { id: String(opp.id) }, body: { etapa_id: Number(etapaB.id) }, user: atorA, query: {} } as any;
  await esperarErro(() => mudarEstagioOportunidade(req, { json() {} } as any), 404);

  // E a oportunidade de B continua na etapa de B (nada vazou para A).
  const oppB = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp B cross ${sufixo}`, funil_id: Number(funilB.id), etapa_id: Number(etapaB.id), status: 'aberta', valor: 100 },
    atorB,
    { escopo: empresaB }
  );
  await esperarErro(() => getRecord(RESOURCES['crm_oportunidades'], Number(oppB.id), atorA, { escopo: empresaA }), 404);
});

// ---------------------------------------------------------------------------
// 7) Histórico na mudança de etapa
// ---------------------------------------------------------------------------
test('7) mudança de etapa grava histórico com antes/depois, autor e empresa', async () => {
  const funil = await criarFunil(atorA, empresaA, `Funil histórico ${sufixo}`);
  const e1 = await criarEtapa(atorA, empresaA, Number(funil.id), 'Entrada', 'entrada_h', 1, 10);
  const e2 = await criarEtapa(atorA, empresaA, Number(funil.id), 'Reunião', 'reuniao_h', 2, 35);

  const opp = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp histórico ${sufixo}`, funil_id: Number(funil.id), etapa_id: Number(e1.id), status: 'aberta', valor: 700 },
    atorA,
    { escopo: empresaA }
  );

  const { mudarEstagioOportunidade } = await import('../src/crm');
  const req = { params: { id: String(opp.id) }, body: { etapa_id: Number(e2.id), observacao: 'Reunião marcada' }, user: atorA, query: {} } as any;
  await mudarEstagioOportunidade(req, { json() {} } as any);

  const hist = await listRecords(
    RESOURCES['crm_estagio_historico'],
    { page: 1, pageSize: 50, filter: { oportunidade_id: Number(opp.id) } },
    empresaA
  );
  const mudanca = hist.rows.find((h: any) => h.estagio_novo === 'reuniao_h');
  assert.ok(mudanca, 'a transição precisa gerar linha de histórico');
  assert.equal(mudanca!.estagio_anterior, 'entrada_h');
  assert.equal(String(mudanca!.status_anterior), 'aberta');
  assert.equal(String(mudanca!.status_novo), 'aberta');
  assert.equal(Number(mudanca!.usuario_id), Number(atorA.id));
  assert.equal(Number(mudanca!.empresa_id), 1);
  assert.equal(String(mudanca!.observacao), 'Reunião marcada');
});

// ---------------------------------------------------------------------------
// 8) Falha no histórico → rollback
// ---------------------------------------------------------------------------
test('8) falha ao gravar o histórico desfaz a mudança de etapa (rollback)', async () => {
  const funil = await criarFunil(atorA, empresaA, `Funil rollback ${sufixo}`);
  const e1 = await criarEtapa(atorA, empresaA, Number(funil.id), 'Antes', 'antes_rb', 1, 10);
  const e2 = await criarEtapa(atorA, empresaA, Number(funil.id), 'Depois', 'depois_rb', 2, 60);

  const opp = await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp rollback ${sufixo}`, funil_id: Number(funil.id), etapa_id: Number(e1.id), status: 'aberta', valor: 900 },
    atorA,
    { escopo: empresaA }
  );

  const s = getStore();
  const original = (s as any).insert.bind(s);
  // Quebra SÓ a gravação do histórico; a atualização da oportunidade acontece
  // antes dela dentro da transação e precisa ser desfeita.
  (s as any).insert = async (r: any, data: any, tx: any) => {
    if (r?.key === 'crm_estagio_historico') throw new Error('falha simulada no histórico');
    return original(r, data, tx);
  };
  try {
    const { mudarEstagioOportunidade } = await import('../src/crm');
    const req = { params: { id: String(opp.id) }, body: { etapa_id: Number(e2.id) }, user: atorA, query: {} } as any;
    await assert.rejects(() => mudarEstagioOportunidade(req, { json() {} } as any));
  } finally {
    (s as any).insert = original;
  }

  const intacta = await getRecord(RESOURCES['crm_oportunidades'], Number(opp.id), atorA, { escopo: empresaA });
  assert.equal(String(intacta.etapa), 'antes_rb', 'a oportunidade NÃO mudou de etapa sem histórico');
  assert.equal(Number(intacta.etapa_id), Number(e1.id));
  assert.equal(Number(intacta.probabilidade), 10, 'nem a probabilidade da etapa foi aplicada');
});

// ---------------------------------------------------------------------------
// 9 e 10) Conversão de lead
// ---------------------------------------------------------------------------
test('9/10) lead convertido nasce na primeira etapa ATIVA do funil e a repetição é idempotente', async () => {
  // Empresa C isolada: garante que o funil padrão é o dela.
  const empresaC = escopoDeSistema(3);
  const atorC = await criarAtor(3, 'gerente');
  const funilC = await criarFunil(atorC, empresaC, `Funil C ${sufixo}`, true);
  await criarEtapa(atorC, empresaC, Number(funilC.id), 'Descartada', 'descartada_c', 0, 5, false);
  const primeiraAtiva = await criarEtapa(atorC, empresaC, Number(funilC.id), 'Lead', 'lead_c', 1, 20);
  await criarEtapa(atorC, empresaC, Number(funilC.id), 'Reunião', 'reuniao_c', 2, 55);

  const lead = await createRecord(
    RESOURCES['crm_leads'],
    { nome: `Lead C ${sufixo}`, status: 'novo', valor_estimado: 4000 },
    atorC,
    { escopo: empresaC }
  );

  const { converterLead } = await import('../src/crm');
  let corpo: any = null;
  const req = { params: { id: String(lead.id) }, body: {}, user: atorC, query: {} } as any;
  const res = { status() { return this; }, json(v: any) { corpo = v; return v; } } as any;
  await converterLead(req, res);

  assert.equal(corpo.oportunidade.etapa, 'lead_c', 'começa na primeira etapa ATIVA (ordem 0 inativa é ignorada)');
  assert.equal(Number(corpo.oportunidade.etapa_id), Number(primeiraAtiva.id));
  assert.equal(Number(corpo.oportunidade.funil_id), Number(funilC.id));
  assert.equal(corpo.etapa.origem, 'cadastro');
  assert.equal(Number(corpo.oportunidade.probabilidade), 20, 'probabilidade da etapa quando o lead não informa');

  // 10) repetir devolve a MESMA oportunidade
  let corpo2: any = null;
  const res2 = { status() { return this; }, json(v: any) { corpo2 = v; return v; } } as any;
  await converterLead(req, res2);
  assert.equal(corpo2.idempotente, true);
  assert.equal(Number(corpo2.oportunidade_id), Number(corpo.oportunidade_id));

  const todas = await listRecords(
    RESOURCES['crm_oportunidades'],
    { page: 1, pageSize: 50, filter: { lead_id: Number(lead.id) } },
    empresaC
  );
  assert.equal(todas.total, 1, 'conversão repetida não duplica oportunidade');
});

// ---------------------------------------------------------------------------
// 12) Forecast usa a probabilidade da etapa customizada
// ---------------------------------------------------------------------------
test('12) forecast e painel usam a probabilidade da etapa CADASTRADA', async () => {
  const empresaD = escopoDeSistema(4);
  const atorD = await criarAtor(4, 'gerente');
  const funilD = await criarFunil(atorD, empresaD, `Funil D ${sufixo}`, true);
  const etapaD = await criarEtapa(atorD, empresaD, Number(funilD.id), 'Contrato', 'contrato_d', 1, 80);

  await createRecord(
    RESOURCES['crm_oportunidades'],
    { nome: `Opp forecast ${sufixo}`, funil_id: Number(funilD.id), etapa_id: Number(etapaD.id), status: 'aberta', valor: 10000 },
    atorD,
    { escopo: empresaD }
  );

  const { forecastCrm, painelCrm } = await import('../src/crm');
  let forecast: any = null;
  await forecastCrm({ query: {}, user: atorD } as any, { json: (v: any) => (forecast = v) } as any);
  const linha = forecast.por_etapa.find((l: any) => l.etapa === 'contrato_d');
  assert.ok(linha, 'a etapa cadastrada aparece no relatório');
  assert.equal(linha.nome, 'Contrato', 'o rótulo vem do cadastro');
  assert.equal(linha.forecast, 8000, '10.000 × 80% da etapa');

  let painel: any = null;
  await painelCrm({ query: {}, user: atorD } as any, { json: (v: any) => (painel = v) } as any);
  const noPainel = painel.pipeline.find((p: any) => p.etapa === 'contrato_d');
  assert.ok(noPainel, 'o pipeline mostra a etapa customizada');
  assert.equal(noPainel.origem, 'cadastro');
  assert.equal(noPainel.probabilidade, 80);
});

// ---------------------------------------------------------------------------
// Metadados: a opção de etapa do formulário vem do cadastro
// ---------------------------------------------------------------------------
test('metadados: /api/meta troca a lista fixa pelas etapas da empresa (optionsFrom)', async () => {
  const { metaComOpcoesDinamicas } = await import('../src/services');
  const metaA = await metaComOpcoesDinamicas(empresaA);
  const campo = metaA['crm_oportunidades']!.fields.find((f: any) => f.name === 'etapa')!;
  assert.ok(campo.optionsFrom, 'o campo declara que as opções vêm do banco');
  const chaves = (campo.options ?? []).map((o: any) => o.value);
  assert.ok(chaves.includes('demonstracao'), 'a etapa criada pela empresa aparece nas opções');
  assert.ok(!chaves.includes('contato_b'), 'etapa de OUTRA empresa não aparece');

  // Isolamento: empresa B recebe as opções dela.
  const metaB = await metaComOpcoesDinamicas(empresaB);
  const campoB = metaB['crm_oportunidades']!.fields.find((f: any) => f.name === 'etapa')!;
  const chavesB = (campoB.options ?? []).map((o: any) => o.value);
  assert.ok(chavesB.includes('contato_b'));
  assert.ok(!chavesB.includes('demonstracao'));

  // E o meta global não foi mutado (a lista canônica continua intacta como
  // semente — nada de vazar a empresa A para o próximo request).
  const { RESOURCES: R } = await import('../src/resources');
  const estatico = R['crm_oportunidades'].fields.find((f: any) => f.name === 'etapa')!;
  assert.equal((estatico.options ?? []).map((o: any) => o.value).join(','), 'prospeccao,qualificacao,proposta,negociacao,fechamento');
});
