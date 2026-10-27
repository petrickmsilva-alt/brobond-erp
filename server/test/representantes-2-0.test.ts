// ============================================================================
// REPRESENTANTE 2.0 — CONTRATO DO CADASTRO MESTRE (modo memória)
//
// Prova, sem PostgreSQL, o que o serviço garante nos DOIS modos:
//   • código comercial único por empresa, gerado quando em branco e PRESERVADO
//     (limpar o campo na edição não apaga o identificador histórico);
//   • PF × PJ coerentes (CPF OU CNPJ, dígito verificador, unicidade por
//     empresa — o mesmo documento em OUTRA empresa continua permitido);
//   • contato e endereço profissionais normalizados (celular, CEP, UF, país);
//   • status × desligamento (desligado não fica ativo; a data não apaga nada);
//   • território do MESMO tenant (o de outra empresa responde 404);
//   • listagem: equipe e carteira anotadas em LOTE (projeção das fontes
//     oficiais) + filtros virtuais por equipe;
//   • painel do representante: carteira, equipe, hierarquia, metas, comissão,
//     indicadores e ranking derivados — nada digitado;
//   • auditoria: a alteração cadastral registra ANTES → EVENTO → DEPOIS.
//
// O PostgreSQL real (16.14) cobre o que só o banco prova — índices únicos
// parciais, trigger de tenant e CHECKs — em test/pg/representantes-pg.test.ts.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getRecord, getStore, listRecords, updateRecord, deleteRecord } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { escopoDeSistema } = await import('../src/empresa');
const { painelDoRepresentante } = await import('../src/comercial');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'admin');
const atorB = await criarAtor(2, 'admin');

const sufixo = `${Date.now() % 1000000}`;

// CPFs VÁLIDOS (dígito verificador conferido) — cada um usado UMA vez por
// empresa, porque a unicidade agora vale também no modo demonstração.
const CPF_A = '52998224725';
const CPF_B = '39053344705';
const CPF_C = '98765432100';
// CNPJ VÁLIDO (14 dígitos + DV): 11.222.333/0001-81.
const CNPJ_A = '11222333000181';
const CNPJ_B = '11444777000161';

async function novo(nome: string, extra: Record<string, unknown> = {}, ator: any = atorA) {
  return createRecord(RESOURCES.representantes, { nome: `${nome} ${sufixo}`, ...extra }, ator);
}

async function listar(q: string, filter: Record<string, unknown> = {}, escopo = empresaA) {
  const res = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 200, q, filter }, escopo);
  return res.rows.filter((r) => String(r.nome).includes(sufixo));
}

// ---------------------------------------------------------------------------
// CÓDIGO COMERCIAL
// ---------------------------------------------------------------------------
test('código comercial: gerado quando em branco, único por empresa e preservado na edição', async () => {
  const semCodigo = await novo('Sem código');
  assert.match(String(semCodigo.codigo), /^REP\d{5}$/, 'o servidor gera REP00001 no padrão');

  // Código explícito é normalizado (maiúsculo, sem espaços).
  const explicito = await novo('Com código', { codigo: ` rep-${sufixo}-a ` });
  assert.equal(explicito.codigo, `REP-${sufixo}-A`);

  // Duplicidade na MESMA empresa → 409 com erro no campo.
  const dup: any = await esperarErro(() => novo('Código repetido', { codigo: `REP-${sufixo}-A` }), 409);
  assert.equal(dup.code, 'representante_codigo_duplicado');
  assert.ok(dup.fields?.codigo, 'o erro aponta o campo código');

  // O MESMO código em OUTRA empresa é permitido (unicidade por empresa).
  const emB = await createRecord(
    RESOURCES.representantes,
    { nome: `Código em B ${sufixo}`, codigo: `REP-${sufixo}-A` },
    atorB
  );
  assert.equal(emB.codigo, `REP-${sufixo}-A`);

  // Limpar o campo na EDIÇÃO não apaga o identificador histórico.
  const preservado = await updateRecord(RESOURCES.representantes, Number(explicito.id), { codigo: '' }, atorA);
  assert.equal(preservado.codigo, `REP-${sufixo}-A`, 'código é preservado');

  // O código é pesquisável e ordenável (coluna real, indexada).
  const porCodigo = await listar(`REP-${sufixo}-A`);
  assert.ok(porCodigo.some((r) => Number(r.id) === Number(explicito.id)), 'busca pelo código encontra');
});

// ---------------------------------------------------------------------------
// PF × PJ
// ---------------------------------------------------------------------------
test('PF × PJ: documento coerente, DV conferido e CNPJ único por empresa', async () => {
  const pj = await novo('Representante PJ', {
    tipo_pessoa: 'PJ',
    cnpj: '11.222.333/0001-81',
    razao_social: '  Distribuidora   Exemplo   Ltda  ',
    nome_fantasia: 'Exemplo Comercial',
  });
  assert.equal(pj.tipo_pessoa, 'PJ');
  assert.equal(pj.cnpj, CNPJ_A, 'CNPJ gravado sem máscara');
  assert.equal(pj.razao_social, 'Distribuidora Exemplo Ltda', 'espaços normalizados');

  const dup: any = await esperarErro(
    () => novo('CNPJ repetido', { tipo_pessoa: 'PJ', cnpj: CNPJ_A }),
    409
  );
  assert.equal(dup.code, 'representante_cnpj_duplicado');
  assert.ok(dup.fields?.cnpj);

  // O mesmo CNPJ em OUTRA empresa é permitido.
  const emB = await createRecord(
    RESOURCES.representantes,
    { nome: `PJ em B ${sufixo}`, tipo_pessoa: 'PJ', cnpj: CNPJ_A },
    atorB
  );
  assert.ok(Number(emB.id) > 0);

  // PJ sem CNPJ → 400 apontando o campo (não se exige CPF).
  const semDoc: any = await esperarErro(() => novo('PJ sem documento', { tipo_pessoa: 'PJ' }), 400);
  assert.equal(semDoc.code, 'representante_cnpj_obrigatorio');
  assert.ok(semDoc.fields?.cnpj);

  // CNPJ inválido (DV errado) → 400 no campo.
  const dvErrado: any = await esperarErro(
    () => novo('PJ inválido', { tipo_pessoa: 'PJ', cnpj: '11222333000182' }),
    400
  );
  assert.ok(dvErrado.fields?.cnpj);

  // PF com CNPJ (ou PJ com CPF) é incoerência de tipo.
  const incoerente: any = await esperarErro(
    () => novo('PF com CNPJ', { tipo_pessoa: 'PF', cnpj: CNPJ_B }),
    400
  );
  assert.equal(incoerente.code, 'representante_documento_incoerente');

  const incoerente2: any = await esperarErro(
    () => novo('PJ com CPF', { tipo_pessoa: 'PJ', cpf: CPF_C }),
    400
  );
  assert.equal(incoerente2.code, 'representante_documento_incoerente');

  // Os dois documentos ao mesmo tempo → 400 (nunca se exige os dois).
  const ambiguo: any = await esperarErro(
    () => novo('Dois documentos', { cpf: CPF_C, cnpj: CNPJ_B }),
    400
  );
  assert.equal(ambiguo.code, 'representante_documento_ambiguo');

  // PJ válido com CPF do representante no OUTRO tipo de pessoa.
  const pf = await novo('Pessoa física', { tipo_pessoa: 'PF', cpf: CPF_A });
  assert.equal(pf.cpf, CPF_A);
  const dupCpf: any = await esperarErro(() => novo('CPF repetido', { cpf: CPF_A }), 409);
  assert.equal(dupCpf.code, 'representante_duplicado');
  assert.ok(dupCpf.fields?.cpf);
});

// ---------------------------------------------------------------------------
// CONTATO E ENDEREÇO
// ---------------------------------------------------------------------------
test('contato profissional: celular normalizado, e-mail validado e telefone canônico', async () => {
  const rep = await novo('Contato completo', {
    telefone: '+55 (62) 3333-4444',
    celular: '(62) 99999-8888',
    whatsapp: '62 98888-7777',
    email: 'REPRESENTANTE.TESTE@BROBOND.COM.BR',
  });
  assert.equal(rep.telefone, '6233334444');
  assert.equal(rep.celular, '62999998888');
  assert.equal(rep.whatsapp, '62988887777');
  assert.equal(rep.email, 'representante.teste@brobond.com.br', 'e-mail normalizado em minúsculas');

  const emailRuim: any = await esperarErro(() => novo('E-mail ruim', { email: 'sem-arroba' }), 400);
  assert.ok(emailRuim.fields?.email);

  const foneRuim: any = await esperarErro(() => novo('Telefone ruim', { celular: '1234' }), 400);
  assert.ok(foneRuim.fields?.celular, 'o celular passa pela mesma validação de telefone');
});

test('endereço estruturado: CEP/UF normalizados, coerência mínima e país padrão Brasil', async () => {
  const rep = await novo('Endereço ok', {
    cep: '74.000-000',
    logradouro: 'Avenida  Central',
    numero: '100',
    complemento: 'Sala 2',
    bairro: 'Setor Bueno',
    cidade: 'Goiânia',
    uf: 'go',
  });
  assert.equal(rep.cep, '74000000', 'CEP só dígitos');
  assert.equal(rep.uf, 'GO', 'UF em maiúsculas');
  assert.equal(rep.logradouro, 'Avenida Central');
  assert.equal(rep.pais, 'Brasil', 'país nasce Brasil quando há endereço');

  const semCidade: any = await esperarErro(
    () => novo('Endereço sem cidade', { logradouro: 'Rua A', uf: 'GO' }),
    400
  );
  assert.equal(semCidade.code, 'representante_endereco_incompleto');
  assert.ok(semCidade.fields?.cidade);

  const semLogradouro: any = await esperarErro(() => novo('Número sem rua', { numero: '10' }), 400);
  assert.equal(semLogradouro.code, 'representante_endereco_incompleto');
  assert.ok(semLogradouro.fields?.logradouro);

  const cepRuim: any = await esperarErro(() => novo('CEP ruim', { cep: '123' }), 400);
  assert.ok(cepRuim.fields?.cep);

  const ufRuim: any = await esperarErro(() => novo('UF ruim', { uf: 'ZZ' }), 400);
  assert.ok(ufRuim.fields?.uf);
});

// ---------------------------------------------------------------------------
// DADOS PROFISSIONAIS
// ---------------------------------------------------------------------------
test('dados profissionais: tipo de representante, registro e data de nascimento', async () => {
  const rep = await novo('Gerente regional', {
    tipo_representante: 'GERENTE',
    cargo: 'Gerente comercial',
    registro_profissional: `CORE-${sufixo}`,
    orgao_registro: 'core',
    data_nascimento: '1985-04-12',
  });
  assert.equal(rep.tipo_representante, 'GERENTE', 'tipo é PAPEL comercial, não o cargo');
  assert.equal(rep.cargo, 'Gerente comercial');
  assert.equal(rep.orgao_registro, 'CORE');
  assert.equal(String(rep.data_nascimento).slice(0, 10), '1985-04-12');

  const tipoRuim: any = await esperarErro(() => novo('Tipo inválido', { tipo_representante: 'CHEFE' }), 400);
  assert.ok(tipoRuim.fields?.tipo_representante);

  const orgaoSemRegistro: any = await esperarErro(
    () => novo('Órgão sem registro', { orgao_registro: 'CORE' }),
    400
  );
  assert.equal(orgaoSemRegistro.code, 'representante_registro_incompleto');

  const futuro: any = await esperarErro(() => novo('Nascimento futuro', { data_nascimento: '2999-01-01' }), 400);
  assert.ok(futuro.fields?.data_nascimento);

  // Registro profissional é OPCIONAL (nem todo representante precisa de CORE).
  const semRegistro = await novo('Sem registro');
  assert.equal(semRegistro.registro_profissional, null);
});

test('status × desligamento: desligar desativa para NOVAS atribuições e preserva o registro', async () => {
  const rep = await novo('Desligamento', { admissao: '2024-01-10' });
  assert.equal(rep.ativo, true);

  const desligado = await updateRecord(RESOURCES.representantes, Number(rep.id), { desligamento: '2025-12-31' }, atorA);
  assert.equal(desligado.ativo, false, 'desligamento desativa o cadastro automaticamente');
  assert.equal(String(desligado.desligamento).slice(0, 10), '2025-12-31');
  assert.equal((await getRecord(RESOURCES.representantes, Number(rep.id), empresaA)).nome, `Desligamento ${sufixo}`);

  // Desligado + "ativo" explícito é incoerência: recusa com orientação.
  const conflito: any = await esperarErro(
    () => updateRecord(RESOURCES.representantes, Number(rep.id), { ativo: true }, atorA),
    409
  );
  assert.equal(conflito.code, 'representante_desligado_ativo');

  // Desligamento anterior à admissão é inválido.
  const ordem: any = await esperarErro(() => novo('Ordem inválida', { admissao: '2025-01-01', desligamento: '2024-01-01' }), 400);
  assert.equal(ordem.code, 'representante_desligamento_invalido');

  // Reverter o desligamento NÃO reativa sozinho (a decisão é do operador).
  const revertido = await updateRecord(RESOURCES.representantes, Number(rep.id), { desligamento: null }, atorA);
  assert.equal(revertido.ativo, false, 'voltar a data não reativa automaticamente');
  const reativado = await updateRecord(RESOURCES.representantes, Number(rep.id), { ativo: true }, atorA);
  assert.equal(reativado.ativo, true);
});

// ---------------------------------------------------------------------------
// TERRITÓRIO — domínio próprio, sem duplicação
// ---------------------------------------------------------------------------
test('território: vínculo com o domínio existente e recusa de território de outra empresa', async () => {
  const territorioA = await createRecord(
    RESOURCES.territorios,
    { nome: `Território A ${sufixo}`, codigo: `TA${sufixo}`, tipo: 'comercial' },
    atorA
  );
  const territorioB = await createRecord(
    RESOURCES.territorios,
    { nome: `Território B ${sufixo}`, codigo: `TB${sufixo}`, tipo: 'comercial' },
    atorB
  );

  const rep = await novo('Com território', { territorio_id: Number(territorioA.id), regiao: 'Centro-Oeste' });
  assert.equal(Number(rep.territorio_id), Number(territorioA.id));
  assert.equal(rep.regiao, 'Centro-Oeste', 'o texto legado continua válido');

  // A listagem traz o rótulo do território (join do próprio domínio).
  const linha = (await listar(`Com território ${sufixo}`)).find((r) => Number(r.id) === Number(rep.id));
  assert.equal(linha?.territorio_id__label, `Território A ${sufixo}`);

  // Filtro server-side por território.
  const filtrado = await listar(`Com território ${sufixo}`, { territorio_id: Number(territorioA.id) });
  assert.deepEqual(filtrado.map((r) => Number(r.id)), [Number(rep.id)]);

  // Território de OUTRA empresa no payload → 404 (não vaza existência).
  const cruzado: any = await esperarErro(
    () => novo('Território cruzado', { territorio_id: Number(territorioB.id) }),
    404
  );
  assert.match(String(cruzado.message), /Território não encontrado/);
});

// ---------------------------------------------------------------------------
// LISTAGEM: projeções em LOTE (equipe/carteira) e filtros virtuais
// ---------------------------------------------------------------------------
test('listagem: equipe e carteira são anotadas em LOTE e o filtro por equipe é server-side', async () => {
  const rep = await novo('Com equipe e carteira');
  const equipe = await createRecord(
    RESOURCES.equipes_comerciais,
    { nome: `Equipe ${sufixo}`, codigo: `EQ${sufixo}` },
    atorA
  );
  await createRecord(
    RESOURCES.equipe_membros,
    { equipe_id: Number(equipe.id), representante_id: Number(rep.id), papel: 'membro', entrada: '2026-01-01' },
    atorA
  );
  const cliente = await createRecord(RESOURCES.clientes, { nome: `Cliente carteira ${sufixo}`, pessoa: 'pj' }, atorA);
  await createRecord(
    RESOURCES.representante_cliente,
    { representante_id: Number(rep.id), cliente_id: Number(cliente.id), inicio: '2026-01-01' },
    atorA
  );

  const linhas = await listar(`Com equipe e carteira ${sufixo}`);
  const linha = linhas.find((r) => Number(r.id) === Number(rep.id));
  assert.ok(linha, 'a listagem encontra o representante');
  assert.equal(linha!.equipe_label, `Equipe ${sufixo}`, 'equipe vigente projetada');
  assert.deepEqual(linha!.equipe_ids, [Number(equipe.id)]);
  assert.equal(Number(linha!.carteira_vinculos), 1, 'vínculo de carteira vigente');
  assert.equal(Number(linha!.carteira_historico), 1);

  // Filtro VIRTUAL por equipe: resolve a composição, com total correto.
  const porEquipe = await listRecords(
    RESOURCES.representantes,
    { page: 1, pageSize: 50, q: sufixo, filter: { equipe_id: Number(equipe.id) } },
    empresaA
  );
  assert.deepEqual(porEquipe.rows.map((r) => Number(r.id)), [Number(rep.id)]);
  assert.equal(porEquipe.total, 1);

  // Busca pelo NOME da equipe também encontra o representante.
  const porNomeEquipe = await listRecords(
    RESOURCES.representantes,
    { page: 1, pageSize: 50, q: `Equipe ${sufixo}` },
    empresaA
  );
  assert.ok(porNomeEquipe.rows.some((r) => Number(r.id) === Number(rep.id)));

  // Equipe de outra empresa não aparece no recorte da empresa ativa.
  const equipeB = await createRecord(RESOURCES.equipes_comerciais, { nome: `Equipe B ${sufixo}` }, atorB);
  const semVazamento = await listRecords(
    RESOURCES.representantes,
    { page: 1, pageSize: 50, filter: { equipe_id: Number(equipeB.id) } },
    empresaA
  );
  assert.equal(semVazamento.total, 0);
});

// ---------------------------------------------------------------------------
// PAINEL (página do representante)
// ---------------------------------------------------------------------------
test('painel: cadastro, estrutura, carteira, metas, comissão, indicadores e ranking derivados', async () => {
  const rep = await novo('Painel completo', { tipo_representante: 'SUPERVISOR', cpf: CPF_B });
  const repId = Number(rep.id);

  const territorio = await createRecord(
    RESOURCES.territorios,
    { nome: `Território painel ${sufixo}`, codigo: `TP${sufixo}` },
    atorA
  );
  await updateRecord(RESOURCES.representantes, repId, { territorio_id: Number(territorio.id) }, atorA);

  const equipe = await createRecord(RESOURCES.equipes_comerciais, { nome: `Equipe painel ${sufixo}` }, atorA);
  await createRecord(
    RESOURCES.equipe_membros,
    { equipe_id: Number(equipe.id), representante_id: repId, papel: 'supervisor', entrada: '2026-01-01' },
    atorA
  );

  // Hierarquia: um subordinado.
  const subordinado = await novo('Subordinado do painel');
  await createRecord(
    RESOURCES.representante_hierarquia,
    { supervisor_id: repId, subordinado_id: Number(subordinado.id), nivel: 'supervisor', inicio: '2026-01-01' },
    atorA
  );

  // Carteira: 1 cliente ativo + 1 cliente inativo.
  const clienteAtivo = await createRecord(RESOURCES.clientes, { nome: `Cliente ativo ${sufixo}`, pessoa: 'pj' }, atorA);
  const clienteInativo = await createRecord(
    RESOURCES.clientes,
    { nome: `Cliente inativo ${sufixo}`, pessoa: 'pf', ativo: false },
    atorA
  );
  await createRecord(
    RESOURCES.representante_cliente,
    { representante_id: repId, cliente_id: Number(clienteAtivo.id), inicio: '2026-01-01' },
    atorA
  );
  await createRecord(
    RESOURCES.representante_cliente,
    { representante_id: repId, cliente_id: Number(clienteInativo.id), inicio: '2026-02-01' },
    atorA
  );

  // Meta ativa + venda faturada no período (realizado derivado).
  await createRecord(
    RESOURCES.metas,
    {
      nome: `Meta ${sufixo}`,
      alvo_tipo: 'representante',
      representante_id: repId,
      metrica: 'faturamento',
      periodo_inicio: '2026-01-01',
      periodo_fim: '2026-12-31',
      valor_meta: 10000,
      status: 'ativa',
    },
    atorA
  );
  // Fixture de LEITURA: a venda nasce já faturada direto no store (o fluxo de
  // faturamento com itens/estoque é coberto por itens.test.ts). O painel só lê.
  await getStore().insert(RESOURCES.vendas, {
    empresa_id: 1,
    cliente_id: Number(clienteAtivo.id),
    representante_id: repId,
    data: '2026-03-10',
    status: 'faturada',
    total: 2500,
  });

  const painel: any = await painelDoRepresentante(getStore(), empresaA, repId);

  assert.equal(painel.representante.id, repId);
  assert.equal(painel.representante.tipo_representante, 'SUPERVISOR');
  assert.equal(painel.representante.tipo_pessoa, 'PF');
  assert.equal(painel.estrutura.territorio.id, Number(territorio.id));
  assert.deepEqual(painel.estrutura.equipes.map((e: any) => e.equipe_id), [Number(equipe.id)]);
  assert.deepEqual(painel.estrutura.hierarquia.subordinados.map((s: any) => s.representante_id), [Number(subordinado.id)]);
  assert.equal(painel.carteira.vigentes, 2);
  assert.equal(painel.carteira.clientes_ativos, 1);
  assert.equal(painel.carteira.clientes_inativos, 1);
  assert.equal(painel.carteira.total, 2);
  assert.equal(painel.metas.total, 1);
  assert.equal(painel.metas.linhas[0].meta, 10000);
  assert.equal(painel.metas.linhas[0].realizado, 2500, 'realizado derivado da venda faturada');
  assert.equal(painel.metas.linhas[0].atingimento_pct, 25);
  assert.equal(painel.indicadores.faturamento, 2500);
  assert.deepEqual(painel.comissao.padrao_pct, 0);
  assert.ok(painel.ranking.total >= 1);

  // Cross-company: o painel não abre representante de outra empresa.
  await esperarErro(() => painelDoRepresentante(getStore(), empresaB, repId), 404);
});

// ---------------------------------------------------------------------------
// HISTÓRICO (auditoria) E EXCLUSÃO
// ---------------------------------------------------------------------------
test('histórico: a alteração cadastral é registrada com ANTES → DEPOIS (append-only)', async () => {
  const rep = await novo('Histórico', { cpf: CPF_C, cargo: 'Vendedor' });
  await updateRecord(
    RESOURCES.representantes,
    Number(rep.id),
    { cargo: 'Gerente regional', tipo_representante: 'GERENTE', uf: 'GO', cidade: 'Goiânia', logradouro: 'Rua B', numero: '10' },
    atorA
  );

  const auditoria = getResource('auditoria');
  assert.ok(auditoria, 'a trilha de auditoria é um recurso real');
  const eventos = await getStore().list(
    auditoria!,
    { page: 1, pageSize: 100, filter: { empresa_id: 1, registro_id: Number(rep.id) }, sort: 'id', dir: 'desc' },
    undefined
  );
  const edicoes = eventos.rows.filter((e) => e.acao === 'editar' && e.recurso === 'representantes');
  assert.equal(edicoes.length, 1, 'a edição gerou UM evento na trilha');
  assert.match(String(edicoes[0].descricao), /cargo/, 'o evento identifica os campos alterados');
  assert.equal(Number(edicoes[0].registro_id), Number(rep.id));

  // Append-only: uma segunda alteração cria OUTRO evento; o primeiro não é
  // reescrito (ANTES → EVENTO → DEPOIS). O diff completo (de/para) é lido no
  // PostgreSQL real em test/pg/representantes-pg.test.ts (coluna `dados` não
  // trafega pela API genérica — de propósito).
  await updateRecord(RESOURCES.representantes, Number(rep.id), { cargo: 'Diretor comercial' }, atorA);
  const eventos2 = await getStore().list(
    auditoria!,
    { page: 1, pageSize: 100, filter: { empresa_id: 1, registro_id: Number(rep.id) }, sort: 'id', dir: 'asc' },
    undefined
  );
  const edicoes2 = eventos2.rows.filter((e) => e.acao === 'editar' && e.recurso === 'representantes');
  assert.equal(edicoes2.length, 2, 'nada é sobrescrito: cada alteração é um evento novo');
  assert.equal((await getRecord(RESOURCES.representantes, Number(rep.id), empresaA)).cargo, 'Diretor comercial');
});

test('exclusão: cadastro com histórico continua recusado (o caminho é desativar)', async () => {
  const rep = await novo('Com histórico de venda');
  const cliente = await createRecord(RESOURCES.clientes, { nome: `Cliente hist ${sufixo}`, pessoa: 'pj' }, atorA);
  await createRecord(
    RESOURCES.vendas,
    { cliente_id: Number(cliente.id), representante_id: Number(rep.id), data: '2026-04-01' },
    atorA
  );

  const erro: any = await esperarErro(() => deleteRecord(RESOURCES.representantes, Number(rep.id), atorA), 409);
  assert.equal(erro.code, 'dependencias_vinculadas');
  assert.equal(erro.details?.dependencias?.bloqueado, true);
  assert.equal((await getRecord(RESOURCES.representantes, Number(rep.id), empresaA)).nome, `Com histórico de venda ${sufixo}`);

  // Desativar resolve, e a venda continua apontando para ele.
  const desativado = await updateRecord(RESOURCES.representantes, Number(rep.id), { ativo: false }, atorA);
  assert.equal(desativado.ativo, false);
  const vendas = await getStore().countWhere(getResource('vendas')!, { representante_id: Number(rep.id) });
  assert.equal(vendas, 1, 'a venda do representante desativado permanece');
});

// ---------------------------------------------------------------------------
// MULTIEMPRESA — 404 em toda operação fora do tenant
// ---------------------------------------------------------------------------
test('multiempresa: 404 em leitura/edição/exclusão de representante de outra empresa', async () => {
  const repA = await novo('SóEmpresaA');
  const repB = await createRecord(RESOURCES.representantes, { nome: `SóEmpresaB${sufixo}` }, atorB);

  await esperarErro(() => getRecord(RESOURCES.representantes, Number(repA.id), empresaB), 404);
  await esperarErro(() => updateRecord(RESOURCES.representantes, Number(repA.id), { nome: 'Invasor' }, atorB), 404);
  await esperarErro(() => deleteRecord(RESOURCES.representantes, Number(repA.id), atorB), 404);
  await esperarErro(() => painelDoRepresentante(getStore(), empresaB, Number(repA.id)), 404);

  // A listagem da B não vê a A (e vice-versa).
  const listaB = await listar('SóEmpresaA', {}, empresaB);
  assert.equal(listaB.length, 0);
  const listaA = await listar(`SóEmpresaB${sufixo}`, {}, empresaA);
  assert.equal(listaA.length, 0);
  assert.ok(Number(repB.id) > 0);
});
