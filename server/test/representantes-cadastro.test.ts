// ============================================================================
// CADASTROS › REPRESENTANTES — contrato do padrão profissional (memória).
//
// `representantes` é a entidade OFICIAL de vendedor/funcionário do ERP — não
// existe outra. O módulo agora segue o padrão LISTA → PÁGINA (como Clientes,
// Fornecedores, Insumos, Cores, Coleções, Grades e Tamanhos). Este arquivo
// trava o contrato que a TELA usa, sem tocar em vendas nem em comissões:
//   • metadado do padrão LISTA → PÁGINA (sem drawer/modal), com as SEÇÕES do
//     formulário (Identificação · Comercial · Acesso ao ERP · Contato ·
//     Situação profissional), filtros reais e uso real — e NENHUM campo
//     inventado (o domínio é o do schema + migration 0021: nome, cpf, cargo,
//     regiao, comissao_pct, usuario_id, telefone, whatsapp, email, admissao,
//     desligamento, observacoes e ativo);
//   • CPF: máscara aceita e normalizada para só dígitos, dígito verificador
//     conferido no SERVIDOR (a unicidade por empresa é índice do banco —
//     coberta em test/pg/representantes-pg.test.ts, porque o MemStore não
//     impõe índice único);
//   • comissão 0–100% (sem tocar em comissoes.ts) e explicação de que incide
//     sobre faturas LIQUIDADAS;
//   • busca (nome, CPF por dígitos, cargo, região, telefone, WhatsApp, e-mail)
//     e filtros (status e usuário vinculado) no SERVIDOR, na mesma listagem
//     paginada — sem SQL paralelo;
//   • coluna "Utilização" = contagem REAL de pedidos de venda
//     (`vendas.representante_id`), agregada em UMA consulta por página —
//     nunca um N+1, nunca faturamento/meta/ranking;
//   • RBAC preservado: cadastro POR EMPRESA (sem piso de escrita) e o operador
//     não exclui (o servidor bloqueia);
//   • exclusão: representante com histórico (vendas/clientes/propostas/
//     comissões) devolve 409 `dependencias_vinculadas` com diagnóstico; a
//     saída é DESATIVAR/DESLIGAR — nenhum CASCADE, nenhuma FK removida;
//   • multiempresa: criação, leitura, edição, exclusão e opções isoladas.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, deleteRecord, getRecord, getStore, listRecords, optionsFor, updateRecord } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'admin');
const atorB = await criarAtor(2, 'admin');

const sufixo = `${Date.now() % 1000000}`;

// CPF VÁLIDO (dígito verificador conferido — o mesmo usado no smoke E2E).
const CPF_VALIDO = '52998224725';
const CPF_MASCARADO = '529.982.247-25';

async function novoRepresentante(nome: string, extra: Record<string, unknown> = {}, ator: any = atorA) {
  return createRecord(RESOURCES.representantes, { nome: `${nome} ${sufixo}`, ...extra }, ator);
}

/** Cliente mínimo para abrir uma venda (vendas exige cliente_id e data). */
let clienteId: number | null = null;
async function clienteDoTeste() {
  if (clienteId == null) {
    const c = await createRecord(RESOURCES.clientes, { nome: `Cliente do representante ${sufixo}`, pessoa: 'pj' }, atorA);
    clienteId = Number(c.id);
  }
  return clienteId;
}

/** Lista só os representantes deste arquivo (o modo demonstração já tem outros). */
async function listar(
  p: { q?: string; filter?: Record<string, unknown>; page?: number; pageSize?: number; sort?: string; dir?: 'asc' | 'desc' },
  escopo = empresaA
) {
  const res = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 500, ...p }, escopo);
  const rows = res.rows.filter((r) => String(r.nome).includes(sufixo));
  return { ...res, rows };
}

// ---------------------------------------------------------------------------
// A) Metadado do padrão LISTA → PÁGINA (fonte única de verdade)
// ---------------------------------------------------------------------------
test('cadastro declara o padrão LISTA → PÁGINA (sem drawer/modal), filtros reais e uso real', () => {
  const r = RESOURCES.representantes;
  // O BROBOND ERP não usa formulário sobreposto: a inclusão/edição é a página
  // /representantes/novo e /representantes/:id/editar. O metadado não oferece
  // superfície de drawer nem de modal — a rota vive em
  // client/src/modules.ts › FORM_DIRETO.
  assert.equal('editor' in r, false, 'Representantes não declara drawer/modal: o formulário é página');
  assert.equal(r.empresa, true, 'cadastro por EMPRESA (multiempresa preservada)');
  assert.equal(r.minPerfilEscrita, undefined, 'sem piso de escrita: é cadastro por empresa');
  assert.deepEqual(r.ops, { create: true, update: true, delete: true });
  assert.deepEqual(r.labelFields, ['nome']);

  // Filtros: SOMENTE campos que existem de verdade em `representantes`.
  assert.deepEqual(r.filterFields, ['usuario_id', 'ativo']);
  assert.equal(r.quickFilters?.[0]?.field, 'ativo');
  assert.equal(r.quickFilters?.[0]?.label, 'Status');
  assert.deepEqual(
    r.quickFilters?.[0]?.options.map((o) => o.label),
    ['Todos', 'Ativos', 'Inativos']
  );

  // Utilização real: pedidos de venda do representante (vendas é o vínculo
  // bloqueante canônico; clientes/propostas/comissões entram no diagnóstico).
  assert.deepEqual(r.uso, {
    recurso: 'vendas',
    campo: 'representante_id',
    singular: 'venda',
    plural: 'vendas',
  });

  // A orientação de desativação (a saída quando há vínculos) vem do metadado e
  // deixa claro que desligar/desativar NÃO apaga histórico.
  assert.match(String(r.notice), /DESATIVADO/);
  assert.match(String(r.notice), /não apaga|NÃO apaga/);
});

test('as seções do formulário são as reais do recurso (Identificação · Comercial · Acesso ao ERP · Contato · Situação profissional)', () => {
  const r = RESOURCES.representantes;
  const secoes = Array.from(new Set(r.fields.map((f) => f.section).filter(Boolean)));
  assert.deepEqual(secoes, ['Identificação', 'Comercial', 'Acesso ao ERP', 'Contato', 'Situação profissional']);

  // A busca do servidor cobre os campos declarados search:true — inclusive o
  // CPF (comparado também por dígitos) e os contatos.
  const buscaveis = r.fields.filter((f) => f.search).map((f) => f.name);
  for (const esperado of ['nome', 'cpf', 'cargo', 'regiao', 'usuario_id', 'telefone', 'whatsapp', 'email']) {
    assert.ok(buscaveis.includes(esperado), `${esperado} é buscável`);
  }

  // A ordem dos campos é a das seções (o RecordForm agrupa preservando ordem).
  const nomes = r.fields.map((f) => f.name);
  assert.deepEqual(nomes, [
    'nome',
    'cpf',
    'cargo',
    'regiao',
    'comissao_pct',
    'usuario_id',
    'telefone',
    'whatsapp',
    'email',
    'admissao',
    'desligamento',
    'ativo',
    'observacoes',
    'criado_em',
    'atualizado_em',
  ]);
});

// ---------------------------------------------------------------------------
// A) NENHUM campo inventado — o domínio real de `representantes`
// ---------------------------------------------------------------------------
test('os campos são exatamente os do schema — nada de salário, meta, limite, banco/PIX ou foto', () => {
  const nomes = RESOURCES.representantes.fields.map((f) => f.name);
  for (const proibido of [
    'salario',
    'meta',
    'meta_vendas',
    'limite_credito',
    'banco',
    'pix',
    'agencia',
    'conta',
    'conta_corrente',
    'foto',
    'imagem',
    'ranking',
    'faturamento',
    'comissao_acumulada',
    'vendas_total',
    'departamento',
    'codigo',
    'tabela_preco',
  ]) {
    assert.equal(nomes.includes(proibido), false, `${proibido} não existe em representantes`);
  }

  const r = RESOURCES.representantes;
  // CPF é documento (máscara + dígito verificador no servidor).
  const cpf = r.fields.find((f) => f.name === 'cpf');
  assert.equal(cpf?.type, 'document');
  assert.equal(cpf?.documento, 'cpf');

  // Comissão em % (0–100) com o texto de que incide sobre faturas LIQUIDADAS —
  // a lógica de apuração (comissoes.ts) NÃO é alterada por esta entrega.
  const comissao = r.fields.find((f) => f.name === 'comissao_pct');
  assert.equal(comissao?.type, 'percent');
  assert.equal(comissao?.min, 0);
  assert.equal(comissao?.max, 100);
  assert.equal(comissao?.default, 0);
  assert.match(String(comissao?.hint), /LIQUIDADAS/);

  // Usuário do sistema: vínculo OPCIONAL e recortado por empresa.
  const usuario = r.fields.find((f) => f.name === 'usuario_id');
  assert.equal(usuario?.type, 'ref');
  assert.equal(usuario?.ref, 'usuarios');
  assert.equal(Boolean(usuario?.required), false, 'o vínculo com usuário é opcional');

  // Desligamento é data e a explicação preserva o histórico.
  const desligamento = r.fields.find((f) => f.name === 'desligamento');
  assert.equal(desligamento?.type, 'date');
  assert.match(String(desligamento?.hint), /NÃO apaga o histórico/);
});

// ---------------------------------------------------------------------------
// CPF: validação e normalização (autoridade: servidor)
// ---------------------------------------------------------------------------
test('CPF: dígito verificador conferido e valor normalizado para só dígitos', async () => {
  // CPF inválido (dígito verificador errado) é recusado com erro no campo.
  const invalido: any = await esperarErro(
    () => createRecord(RESOURCES.representantes, { nome: `CPF inválido ${sufixo}`, cpf: '11144477736' }, atorA),
    400
  );
  assert.ok(invalido.fields?.cpf, 'o erro aponta o campo cpf');
  assert.match(String(invalido.fields.cpf), /CPF inválido/);

  // CPF válido enviado COM máscara: o banco guarda só dígitos (é o formato do
  // índice único uq_representantes_cpf_empresa e da busca por dígitos).
  const ok = await novoRepresentante('Com CPF', { cpf: CPF_MASCARADO });
  assert.equal(ok.cpf, CPF_VALIDO, 'CPF normalizado para dígitos');

  // Telefone/WhatsApp seguem a regra existente do ERP: dígitos canônicos.
  const comFone = await novoRepresentante('Com contato', {
    telefone: '+55 (62) 3333-4444',
    whatsapp: '(62) 99999-8888',
    email: 'representante@brobond.com.br',
  });
  assert.equal(comFone.telefone, '6233334444');
  assert.equal(comFone.whatsapp, '62999998888');
  assert.equal(comFone.email, 'representante@brobond.com.br');
});

test('validação: nome obrigatório e comissão no intervalo 0–100', async () => {
  const erroNome: any = await esperarErro(() => createRecord(RESOURCES.representantes, { nome: '   ' }, atorA), 400);
  assert.ok(erroNome.fields?.nome, 'erro no campo nome');

  const erroComissao: any = await esperarErro(
    () => createRecord(RESOURCES.representantes, { nome: `Comissão inválida ${sufixo}`, comissao_pct: 150 }, atorA),
    400
  );
  assert.ok(erroComissao.fields?.comissao_pct, 'erro no campo comissao_pct');

  const comissaoOk = await novoRepresentante('Comissão válida', { comissao_pct: 7.5 });
  assert.equal(Number(comissaoOk.comissao_pct), 7.5);
});

// ---------------------------------------------------------------------------
// B/C) Busca e filtros no SERVIDOR, na mesma listagem paginada
// ---------------------------------------------------------------------------
test('busca encontra por nome, CPF (com e sem máscara), cargo, região, telefone e e-mail', async () => {
  await novoRepresentante('Ana Souza', {
    cpf: CPF_VALIDO,
    cargo: `Vendedora ${sufixo}`,
    regiao: 'Centro-Oeste',
    telefone: '6233334444',
    whatsapp: '62999998888',
    email: `ana${sufixo}@brobond.com.br`,
  });
  await novoRepresentante('Carlos Lima', { cargo: 'Representante', regiao: 'Norte' });

  // q pelo nome (parcial, sem caixa).
  const porNome = await listar({ q: 'ana souza' });
  assert.equal(porNome.rows.length, 1);
  assert.equal(String(porNome.rows[0].nome), `Ana Souza ${sufixo}`);

  // q pelo CPF em DÍGITOS e COM máscara: as duas formas acham o registro.
  assert.ok((await listar({ q: CPF_VALIDO })).rows.some((r) => String(r.nome).startsWith('Ana Souza')));
  assert.ok((await listar({ q: CPF_MASCARADO })).rows.some((r) => String(r.nome).startsWith('Ana Souza')));

  // q por cargo, região, telefone, WhatsApp e e-mail.
  assert.equal((await listar({ q: `Vendedora ${sufixo}` })).rows.length, 1);
  assert.ok((await listar({ q: 'Centro-Oeste' })).rows.some((r) => String(r.nome).startsWith('Ana Souza')));
  assert.ok((await listar({ q: '6233334444' })).rows.some((r) => String(r.nome).startsWith('Ana Souza')));
  assert.ok((await listar({ q: '62999998888' })).rows.some((r) => String(r.nome).startsWith('Ana Souza')));
  assert.equal((await listar({ q: `ana${sufixo}@brobond.com.br` })).rows.length, 1);
});

test('filtros recortam no servidor: status (Todos/Ativos/Inativos) e usuário vinculado', async () => {
  const ativo = await novoRepresentante('Filtro ativo', { ativo: true });
  const inativo = await novoRepresentante('Filtro inativo', { ativo: false });
  // Usuário REAL (criado pelo helper de atores): `usuario_id` é uma FK para
  // `usuarios`, então um id inventado seria recusado pelo próprio store.
  const usuarioId = Number(atorA.id);

  const inativos = await listar({ q: `Filtro inativo ${sufixo}`, filter: { ativo: 'false' } });
  assert.deepEqual(inativos.rows.map((r) => Number(r.id)), [Number(inativo.id)]);
  const ativos = await listar({ q: `Filtro ativo ${sufixo}`, filter: { ativo: 'true' } });
  assert.deepEqual(ativos.rows.map((r) => Number(r.id)), [Number(ativo.id)]);

  // f.usuario_id usa a coluna real (sem JOIN divergente).
  const vinculado = await novoRepresentante('Com usuário', { usuario_id: usuarioId });
  const porUsuario = await listar({ q: `Com usuário ${sufixo}`, filter: { usuario_id: usuarioId } });
  assert.deepEqual(porUsuario.rows.map((r) => Number(r.id)), [Number(vinculado.id)]);
  assert.equal(Number(vinculado.usuario_id), usuarioId);
});

test('paginação e ordenação server-side: page/pageSize e sort/dir na mesma consulta', async () => {
  await novoRepresentante('Paginado A', { cargo: 'Cargo A' });
  await novoRepresentante('Paginado B', { cargo: 'Cargo C' });
  await novoRepresentante('Paginado C', { cargo: 'Cargo B' });

  const pagina1 = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 2, q: 'Paginado' }, empresaA);
  assert.ok(pagina1.total >= 3, 'o total conta todo o recorte');
  assert.equal(pagina1.rows.length, 2, 'a página respeita o pageSize');

  const pagina2 = await listRecords(RESOURCES.representantes, { page: 2, pageSize: 2, q: 'Paginado' }, empresaA);
  const ids1 = new Set(pagina1.rows.map((r) => Number(r.id)));
  assert.ok(pagina2.rows.every((r) => !ids1.has(Number(r.id))), 'as páginas não se repetem');

  const porCargo = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 50, q: `Paginado`, sort: 'cargo', dir: 'asc' }, empresaA);
  const cargos = porCargo.rows.map((r) => String(r.cargo));
  assert.deepEqual(cargos, [...cargos].sort((a, b) => a.localeCompare(b)), 'ordenação no servidor por cargo');
});

// ---------------------------------------------------------------------------
// Utilização: contagem REAL de vendas, agregada em UMA consulta (sem N+1)
// ---------------------------------------------------------------------------
test('utilização conta os pedidos de venda reais do representante', async () => {
  const representante = await novoRepresentante('Com vendas');
  const semVendas = await novoRepresentante('Sem vendas');
  const cliente = await clienteDoTeste();

  await createRecord(RESOURCES.vendas, { cliente_id: cliente, representante_id: Number(representante.id), data: '2026-10-01' }, atorA);
  await createRecord(RESOURCES.vendas, { cliente_id: cliente, representante_id: Number(representante.id), data: '2026-10-02' }, atorA);

  const linha = (await listar({ q: `Com vendas ${sufixo}` })).rows.find((r) => Number(r.id) === Number(representante.id));
  assert.ok(linha, 'o representante aparece na listagem');
  assert.equal(linha!.uso_vinculado, 2, 'dois pedidos de venda reais');
  assert.equal(linha!.uso_vinculado_label, '2 vendas');

  const linhaSem = (await listar({ q: `Sem vendas ${sufixo}` })).rows.find((r) => Number(r.id) === Number(semVendas.id));
  assert.equal(linhaSem?.uso_vinculado, 0, 'sem vendas = 0 (a UI mostra "—"), nunca número inventado');
  assert.equal(linhaSem?.uso_vinculado_label, '0 vendas');

  // Não é faturamento, meta, ranking nem comissão: é CONTAGEM de pedidos.
  assert.equal(typeof linha!.uso_vinculado, 'number');
});

test('a agregação da utilização é uma única consulta por página (nenhum N+1)', async () => {
  const r1 = await novoRepresentante('N+1 alvo A');
  const r2 = await novoRepresentante('N+1 alvo B');
  const cliente = await clienteDoTeste();
  await createRecord(RESOURCES.vendas, { cliente_id: cliente, representante_id: Number(r1.id), data: '2026-10-01' }, atorA);
  await createRecord(RESOURCES.vendas, { cliente_id: cliente, representante_id: Number(r2.id), data: '2026-10-01' }, atorA);

  const store = getStore();
  const original = store.countByColumn.bind(store);
  let chamadas = 0;
  const spy = async (...args: any[]) => {
    chamadas += 1;
    return (original as any)(...args);
  };
  (store as any).countByColumn = spy;
  try {
    const res = await listRecords(RESOURCES.representantes, { page: 1, pageSize: 25, q: 'N+1 alvo' }, empresaA);
    assert.equal(res.rows.length, 2, 'os dois representantes estão na mesma página');
  } finally {
    (store as any).countByColumn = original;
  }
  assert.equal(chamadas, 1, 'UMA chamada agregada (countByColumn) serve a página inteira');
});

// ---------------------------------------------------------------------------
// RBAC: cadastro POR EMPRESA (sem piso de escrita); excluir é do gerente/admin
// ---------------------------------------------------------------------------
test('RBAC preservado: o operador lê e edita, mas o servidor recusa o DELETE', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');

  assert.doesNotThrow(() => checkAccess(RESOURCES.representantes, operador as any, 'read'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.representantes, operador as any, 'create'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.representantes, operador as any, 'update'));
  assert.throws(
    () => checkAccess(RESOURCES.representantes, operador as any, 'delete'),
    (e: any) => e.status === 403,
    'o operador não exclui representantes (o servidor é a autoridade)'
  );
  assert.doesNotThrow(() => checkAccess(RESOURCES.representantes, gerente as any, 'delete'));

  const criado = await createRecord(RESOURCES.representantes, { nome: `Do gerente ${sufixo}` }, gerente);
  const alterado = await updateRecord(RESOURCES.representantes, Number(criado.id), { ativo: false }, gerente);
  assert.equal(alterado.ativo, false);
});

// ---------------------------------------------------------------------------
// Multiempresa: criação, leitura, edição, exclusão e opções isoladas
// ---------------------------------------------------------------------------
test('multiempresa: o representante de uma empresa não é lido, editado nem excluído por outra', async () => {
  const repA = await novoRepresentante('Só A');
  const idA = Number(repA.id);
  const repB = await createRecord(RESOURCES.representantes, { nome: `Só B ${sufixo}` }, atorB);

  await esperarErro(() => getRecord(RESOURCES.representantes, idA, empresaB), 404);
  assert.equal((await listar({ q: `Só A ${sufixo}` }, empresaB)).rows.length, 0);
  assert.equal((await listar({ q: `Só B ${sufixo}` }, empresaA)).rows.length, 0);

  await esperarErro(() => updateRecord(RESOURCES.representantes, idA, { nome: 'Invadido' }, atorB), 404);
  await esperarErro(() => deleteRecord(RESOURCES.representantes, idA, atorB), 404);

  const aindaA = await getRecord(RESOURCES.representantes, idA, empresaA);
  assert.equal(String(aindaA.nome), `Só A ${sufixo}`);

  const opcoesA = await optionsFor(RESOURCES.representantes, empresaA);
  assert.ok(opcoesA.some((o) => o.value === idA));
  assert.ok(!opcoesA.some((o) => o.value === Number(repB.id)), 'a empresa A não oferece o representante da B');
});

// ---------------------------------------------------------------------------
// Exclusão: diagnóstico de vínculos × fluxo normal (nada de CASCADE)
// ---------------------------------------------------------------------------
test('representante com vendas NÃO é excluído e devolve o diagnóstico completo', async () => {
  const rep = await novoRepresentante('Vinculado');
  const venda = await createRecord(
    RESOURCES.vendas,
    { cliente_id: await clienteDoTeste(), representante_id: Number(rep.id), data: '2026-10-01' },
    atorA
  );

  const erro: any = await esperarErro(() => deleteRecord(RESOURCES.representantes, Number(rep.id), atorA), 409, /vinculad/i);
  assert.equal(erro.code, 'dependencias_vinculadas', 'código estável que abre o "Ver vínculos" na tela');
  const diag = erro.details?.dependencias;
  assert.ok(diag, 'o diagnóstico vai em details.dependencias');
  assert.equal(diag.bloqueado, true);
  assert.equal(diag.podeExcluir, false);
  assert.ok(diag.modulosBloqueantes.includes('Vendas'), 'o diagnóstico aponta o módulo Vendas');
  const vinculo = diag.vinculos.find((v: any) => v.tabela === 'vendas');
  assert.ok(vinculo, 'o vínculo de vendas está detalhado');
  assert.equal(vinculo.quantidade, 1);
  assert.equal(vinculo.acao, 'NO_ACTION', 'a FK real é NO ACTION — nenhum CASCADE foi criado');

  // Nada foi apagado: o representante e a venda continuam lá.
  assert.equal(Number((await getRecord(RESOURCES.representantes, Number(rep.id), empresaA)).id), Number(rep.id));
  assert.equal(Number((await getRecord(RESOURCES.vendas, Number(venda.id), empresaA)).representante_id), Number(rep.id));
});

test('representante sem vínculo segue o fluxo normal de exclusão', async () => {
  const rep = await novoRepresentante('Órfão');
  await deleteRecord(RESOURCES.representantes, Number(rep.id), atorA);
  await esperarErro(() => getRecord(RESOURCES.representantes, Number(rep.id), empresaA), 404);
});

// ---------------------------------------------------------------------------
// Desativação/desligamento preservam o histórico (nada é apagado)
// ---------------------------------------------------------------------------
test('desativar o representante preserva as vendas e o vínculo com o usuário do ERP', async () => {
  const rep = await novoRepresentante('Desativado');
  const id = Number(rep.id);
  const venda = await createRecord(
    RESOURCES.vendas,
    { cliente_id: await clienteDoTeste(), representante_id: id, data: '2026-10-01' },
    atorA
  );

  const desativado = await updateRecord(RESOURCES.representantes, id, { ativo: false }, atorA);
  assert.equal(desativado.ativo, false);

  // O registro continua existindo (desativar ≠ apagar) e a venda intacta.
  const aindaExiste = await getRecord(RESOURCES.representantes, id, empresaA);
  assert.equal(aindaExiste.ativo, false);
  assert.equal(String(aindaExiste.nome), `Desativado ${sufixo}`);
  assert.equal(Number((await getRecord(RESOURCES.vendas, Number(venda.id), empresaA)).representante_id), id);

  // A utilização continua contando o vínculo (nada foi apagado).
  const linha = (await listar({ q: `Desativado ${sufixo}` })).rows.find((r) => Number(r.id) === id);
  assert.equal(linha?.uso_vinculado, 1);

  // E o desativado sai da seleção de NOVOS cadastros marcado como inativo
  // (regra existente das opções do ERP — o histórico permanece referenciável).
  const opcoes = await optionsFor(RESOURCES.representantes, empresaA);
  const opcao = opcoes.find((o) => o.value === id);
  assert.ok(opcao, 'a opção continua existindo para os registros antigos');
  assert.match(opcao!.label, /\(inativo\)$/);
});

test('desligamento registra apenas a situação profissional — não apaga vendas nem comissões', async () => {
  const rep = await novoRepresentante('Desligado');
  const venda = await createRecord(
    RESOURCES.vendas,
    { cliente_id: await clienteDoTeste(), representante_id: Number(rep.id), data: '2026-10-01' },
    atorA
  );

  const desligado = await updateRecord(RESOURCES.representantes, Number(rep.id), { desligamento: '2026-01-31' }, atorA);
  assert.equal(String(desligado.desligamento).slice(0, 10), '2026-01-31');

  // O histórico comercial continua apontando para o representante.
  assert.equal(Number((await getRecord(RESOURCES.vendas, Number(venda.id), empresaA)).representante_id), Number(rep.id));
  assert.equal(Number((await getRecord(RESOURCES.representantes, Number(rep.id), empresaA)).id), Number(rep.id));
});
