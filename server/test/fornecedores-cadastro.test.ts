// ============================================================================
// CADASTROS › FORNECEDORES — contrato do padrão profissional (memória).
//
// O módulo continua sendo o CRUD genérico dirigido por `resources.ts`. O que
// este arquivo trava é o contrato que a TELA usa (agora no padrão LISTA →
// PÁGINA, como Cores, Coleções, Grades e Insumos):
//   • metadado do padrão LISTA → PÁGINA (sem drawer/modal), com as seções do
//     formulário, filtros reais e uso real — e NENHUM campo inventado (o
//     domínio de `fornecedores` é o do schema + migration 0021: identificação,
//     fiscal, endereço, contato, comercial e ativo);
//   • PF/PJ preservados: o dicionário de `pessoa` é o do servidor e o CPF/CNPJ
//     tem dígito verificador conferido e normalização para só dígitos;
//   • busca (nome, documento por dígitos, contatos) e filtros (pessoa, UF,
//     status) no SERVIDOR, na mesma listagem paginada (sem SQL paralelo);
//   • coluna "Utilização" = contagem REAL de pedidos de compra
//     (`compras.fornecedor_id`), agregada em UMA consulta por página — nunca
//     um N+1, nunca número inventado — e recortada pela empresa ativa;
//   • RBAC preservado: `fornecedores` é cadastro POR EMPRESA (sem piso de
//     escrita) e o operador não exclui (o servidor bloqueia);
//   • exclusão: fornecedor vinculado a compras devolve o diagnóstico de
//     vínculos (409 `dependencias_vinculadas`) e o registro permanece; a saída
//     é DESATIVAR (o histórico continua apontando para ele);
//   • multiempresa: criação, leitura, edição e exclusão isoladas por empresa.
//
// A variante contra PostgreSQL real (inclusive o CNPJ duplicado por empresa,
// que o MemStore não impõe) fica em test/pg/fornecedores-pg.test.ts.
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

// Documentos VÁLIDOS (dígito verificador conferido — os mesmos usados no
// smoke E2E): CNPJ 12.345.678/0001-95 e CPF 529.982.247-25.
const CNPJ_VALIDO = '12345678000195';
const CPF_VALIDO = '52998224725';

async function novoFornecedor(nome: string, extra: Record<string, unknown> = {}, ator: any = atorA) {
  return createRecord(RESOURCES.fornecedores, { nome: `${nome} ${sufixo}`, ...extra }, ator);
}

/** Lista só os fornecedores deste arquivo (o modo demonstração já tem outros). */
async function listar(
  p: { q?: string; filter?: Record<string, unknown>; page?: number; pageSize?: number; sort?: string; dir?: 'asc' | 'desc' },
  escopo = empresaA
) {
  const res = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 500, ...p }, escopo);
  const rows = res.rows.filter((r) => String(r.nome).includes(sufixo));
  return { ...res, rows };
}

// ---------------------------------------------------------------------------
// A) Metadado do padrão LISTA → PÁGINA (fonte única de verdade)
// ---------------------------------------------------------------------------
test('cadastro declara o padrão LISTA → PÁGINA (sem drawer/modal), filtros reais e uso real', () => {
  const r = RESOURCES.fornecedores;
  // O BROBOND ERP não usa formulário sobreposto: a inclusão/edição é a página
  // /fornecedores/novo e /fornecedores/:id/editar. O metadado não oferece
  // superfície de drawer nem de modal — a rota vive em
  // client/src/modules.ts › FORM_DIRETO.
  assert.equal('editor' in r, false, 'Fornecedores não declara drawer/modal: o formulário é página');
  assert.equal(r.empresa, true, 'cadastro por EMPRESA (multiempresa preservada)');
  assert.equal(r.minPerfilEscrita, undefined, 'sem piso de escrita: é cadastro por empresa');
  assert.deepEqual(r.ops, { create: true, update: true, delete: true });

  // Filtros: SOMENTE campos que existem de verdade em `fornecedores`.
  assert.deepEqual(r.filterFields, ['pessoa', 'uf', 'ativo']);
  assert.equal(r.quickFilters?.[0]?.field, 'ativo');
  assert.deepEqual(
    r.quickFilters?.[0]?.options.map((o) => o.label),
    ['Todos', 'Ativos', 'Inativos']
  );
  // Utilização real: os pedidos de compra do fornecedor (compras é o vínculo
  // bloqueante canônico; insumos/produtos entram no diagnóstico de exclusão).
  assert.deepEqual(r.uso, {
    recurso: 'compras',
    campo: 'fornecedor_id',
    singular: 'compra',
    plural: 'compras',
  });
  // A orientação de desativação (a saída quando há vínculos) vem do metadado.
  assert.match(String(r.notice), /DESATIVADO/);
});

test('as seções do formulário são as reais do recurso (Identificação · Fiscal · Endereço · Contato · Comercial)', () => {
  const r = RESOURCES.fornecedores;
  const secoes = Array.from(new Set(r.fields.map((f) => f.section).filter(Boolean)));
  assert.deepEqual(secoes, ['Identificação', 'Fiscal', 'Endereço', 'Contato', 'Comercial']);
  // A busca do servidor cobre os campos declarados search:true.
  const buscaveis = r.fields.filter((f) => f.search).map((f) => f.name);
  for (const esperado of ['nome', 'cnpj', 'nome_fantasia', 'ie', 'cidade', 'contato', 'telefone', 'whatsapp', 'email']) {
    assert.ok(buscaveis.includes(esperado), `${esperado} é buscável`);
  }
});

// ---------------------------------------------------------------------------
// A) NENHUM campo inventado — o domínio real de `fornecedores`
// ---------------------------------------------------------------------------
test('os campos do formulário são exatamente os que existem em `fornecedores` — nenhum inventado', () => {
  const r = RESOURCES.fornecedores;
  const nomes = r.fields.map((f) => f.name);
  assert.deepEqual(nomes, [
    'nome',
    'pessoa',
    'cnpj',
    'razao_social',
    'nome_fantasia',
    'ie',
    'indicador_ie',
    'im',
    'cep',
    'logradouro',
    'numero',
    'complemento',
    'bairro',
    'cidade',
    'uf',
    'codigo_municipio',
    'contato',
    'telefone',
    'whatsapp',
    'email',
    'prazo_entrega_dias',
    'condicao_pagamento',
    'observacoes',
    'ativo',
    'criado_em',
    'atualizado_em',
  ], 'o formulário usa os campos reais da tabela fornecedores (schema + migration 0021)');

  // Nada de código/SKU próprio, NCM, categoria, limite de crédito, banco/PIX,
  // foto ou tabela de preços — nada disso existe no domínio.
  for (const proibido of [
    'sku',
    'codigo',
    'codigo_fornecedor',
    'ncm',
    'descricao',
    'categoria_id',
    'limite_credito',
    'banco',
    'pix',
    'agencia',
    'conta',
    'foto',
    'imagem',
    'tabela_preco',
  ]) {
    assert.equal(nomes.includes(proibido), false, `${proibido} não existe em fornecedores`);
  }

  // O dicionário de tipo de pessoa é o do servidor (PF/PJ/estrangeiro).
  const pessoa = r.fields.find((f) => f.name === 'pessoa');
  assert.equal(pessoa?.type, 'select');
  assert.equal(pessoa?.required, true);
  assert.equal(pessoa?.default, 'pj');
  assert.deepEqual(pessoa?.options?.map((o) => o.value), ['pj', 'pf', 'estrangeiro']);

  // O documento é do tipo `document` (máscara + dígito verificador no servidor).
  const doc = r.fields.find((f) => f.name === 'cnpj');
  assert.equal(doc?.type, 'document');
});

// ---------------------------------------------------------------------------
// PF/PJ: dígito verificador, normalização e máscaras (autoridade: servidor)
// ---------------------------------------------------------------------------
test('CNPJ/CPF: dígito verificador conferido, valor normalizado para só dígitos', async () => {
  // CNPJ inválido (dígito verificador errado) é recusado com erro no campo.
  const erroCnpj: any = await esperarErro(
    () => createRecord(RESOURCES.fornecedores, { nome: `Doc inválido ${sufixo}`, cnpj: '12345678000196' }, atorA),
    400
  );
  assert.ok(erroCnpj.fields?.cnpj, 'o erro aponta o campo cnpj');
  assert.match(String(erroCnpj.fields.cnpj), /CNPJ inválido/);

  // CPF inválido também é recusado.
  const erroCpf: any = await esperarErro(
    () => createRecord(RESOURCES.fornecedores, { nome: `CPF inválido ${sufixo}`, cnpj: '11144477736' }, atorA),
    400
  );
  assert.ok(erroCpf.fields?.cnpj);
  assert.match(String(erroCpf.fields.cnpj), /CPF inválido/);

  // PJ com CNPJ válido, enviado COM máscara: o banco guarda só dígitos
  // (é como o documento entra na NF-e e nos índices de busca).
  const pj = await novoFornecedor('Têxtil Bella', { pessoa: 'pj', cnpj: '12.345.678/0001-95' });
  assert.equal(pj.cnpj, CNPJ_VALIDO, 'CNPJ normalizado para dígitos');

  // PF com CPF válido: mesma regra.
  const pf = await novoFornecedor('João da Silva', { pessoa: 'pf', cnpj: '529.982.247-25' });
  assert.equal(pf.cnpj, CPF_VALIDO, 'CPF normalizado para dígitos');

  // Estrangeiro sem documento brasileiro: permitido (o campo é opcional).
  const ext = await novoFornecedor('China Fabrics', { pessoa: 'estrangeiro' });
  assert.equal(ext.cnpj, null);

  // Telefone: guarda o valor canônico sem máscara (regra existente do ERP).
  const comFone = await novoFornecedor('Com telefone', { telefone: '+55 (62) 3333-4444' });
  assert.equal(comFone.telefone, '6233334444');

  // UF inválida é recusada; válida é normalizada em caixa alta.
  await esperarErro(() => novoFornecedor('UF inválida', { uf: 'ZZ' }), 400);
  const comUf = await novoFornecedor('UF válida', { cidade: 'Goiânia', uf: 'go' });
  assert.equal(comUf.uf, 'GO');

  // CEP inválido é recusado; válido fica com 8 dígitos.
  await esperarErro(() => novoFornecedor('CEP inválido', { cep: '123' }), 400);
  const comCep = await novoFornecedor('CEP válido', { cep: '75.045-090' });
  assert.equal(comCep.cep, '75045090');
});

test('validação: nome é obrigatório (regra existente, sem alteração)', async () => {
  const erroNome: any = await esperarErro(() => createRecord(RESOURCES.fornecedores, { nome: '   ' }, atorA), 400);
  assert.ok(erroNome.fields?.nome, 'erro no campo nome');
});

// ---------------------------------------------------------------------------
// B/C) Busca e filtros no SERVIDOR, na mesma listagem paginada
// ---------------------------------------------------------------------------
test('busca encontra por nome, nome fantasia e documento (dígitos) — filtros pessoa/UF/status recortam no servidor', async () => {
  await novoFornecedor('Malharia Aurora', {
    pessoa: 'pj',
    cnpj: CNPJ_VALIDO,
    nome_fantasia: `Aurora Fashion ${sufixo}`,
    cidade: 'Goiânia',
    uf: 'GO',
    contato: `Ana Souza ${sufixo}`,
    telefone: '6233334444',
    email: `ana${sufixo}@aurora.com.br`,
  });
  await novoFornecedor('Maria Costureira', { pessoa: 'pf', cnpj: CPF_VALIDO, cidade: 'Anápolis', uf: 'GO' });
  await novoFornecedor('Fornecedor SP', { pessoa: 'pj', cidade: 'São Paulo', uf: 'SP', ativo: false });

  // q por nome (parcial, sem caixa).
  const porNome = await listar({ q: 'malharia' });
  assert.equal(porNome.rows.length, 1);
  assert.equal(String(porNome.rows[0].nome), `Malharia Aurora ${sufixo}`);

  // q pelo CNPJ em dígitos (a busca de documento ignora máscara).
  const porDocumento = await listar({ q: CNPJ_VALIDO });
  assert.ok(porDocumento.rows.some((r) => String(r.nome).startsWith('Malharia Aurora')), 'busca por dígitos do CNPJ');

  // q por nome fantasia, contato, telefone e e-mail.
  assert.equal((await listar({ q: `Aurora Fashion ${sufixo}` })).rows.length, 1);
  assert.equal((await listar({ q: `Ana Souza ${sufixo}` })).rows.length, 1);
  assert.ok((await listar({ q: '6233334444' })).rows.some((r) => String(r.nome).startsWith('Malharia Aurora')));
  assert.equal((await listar({ q: `ana${sufixo}@aurora.com.br` })).rows.length, 1);

  // Filtro de tipo de pessoa (contrato f.pessoa da tela).
  const pfs = await listar({ q: 'Maria Costureira', filter: { pessoa: 'pf' } });
  assert.deepEqual(pfs.rows.map((r) => String(r.nome)), [`Maria Costureira ${sufixo}`]);
  const pjSemPf = await listar({ q: 'Maria Costureira', filter: { pessoa: 'pj' } });
  assert.equal(pjSemPf.rows.length, 0, 'o filtro de tipo recorta no servidor');

  // Filtro de UF (contrato f.uf da tela).
  const goias = await listar({ q: sufixo, filter: { uf: 'GO' } });
  assert.ok(goias.rows.every((r) => r.uf === 'GO'));
  const nomesGo = goias.rows.map((r) => String(r.nome));
  assert.ok(nomesGo.includes(`Malharia Aurora ${sufixo}`) && nomesGo.includes(`Maria Costureira ${sufixo}`));
  const paulista = await listar({ q: sufixo, filter: { uf: 'SP' } });
  assert.deepEqual(paulista.rows.map((r) => String(r.nome)), [`Fornecedor SP ${sufixo}`]);

  // Filtro de status (contrato f.ativo dos atalhos Todos/Ativos/Inativos).
  const inativos = await listar({ q: sufixo, filter: { ativo: 'false' } });
  assert.deepEqual(inativos.rows.map((r) => String(r.nome)), [`Fornecedor SP ${sufixo}`]);
  const ativos = await listar({ q: sufixo, filter: { ativo: 'true' } });
  assert.ok(ativos.rows.length >= 2);
  assert.ok(ativos.rows.every((r) => r.ativo !== false));
});

test('paginação server-side: page/pageSize recortam a mesma consulta (total real)', async () => {
  await novoFornecedor('Paginado 1');
  await novoFornecedor('Paginado 2');
  await novoFornecedor('Paginado 3');

  const pagina1 = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 2, q: `Paginado` }, empresaA);
  const nossos = pagina1.total;
  assert.ok(nossos >= 3, 'o total conta todos os fornecedores do recorte');
  assert.equal(pagina1.rows.length, 2, 'a página respeita o pageSize');

  const pagina2 = await listRecords(RESOURCES.fornecedores, { page: 2, pageSize: 2, q: `Paginado` }, empresaA);
  assert.equal(pagina2.rows.length, Math.max(0, nossos - 2));
  const ids1 = new Set(pagina1.rows.map((r) => Number(r.id)));
  assert.ok(pagina2.rows.every((r) => !ids1.has(Number(r.id))), 'as páginas não se repetem');
});

// ---------------------------------------------------------------------------
// Utilização: contagem REAL de compras, agregada em UMA consulta (sem N+1)
// ---------------------------------------------------------------------------
test('utilização conta os pedidos de compra reais do fornecedor', async () => {
  const fornecedor = await novoFornecedor('Com compras');
  const semCompras = await novoFornecedor('Sem compras');

  await createRecord(RESOURCES.compras, { fornecedor_id: Number(fornecedor.id), data: '2026-10-01' }, atorA);
  await createRecord(RESOURCES.compras, { fornecedor_id: Number(fornecedor.id), data: '2026-10-02' }, atorA);

  const linha = (await listar({ q: `Com compras ${sufixo}` })).rows.find((r) => Number(r.id) === Number(fornecedor.id));
  assert.ok(linha, 'o fornecedor aparece na listagem');
  assert.equal(linha!.uso_vinculado, 2, 'dois pedidos de compra reais');
  assert.equal(linha!.uso_vinculado_label, '2 compras');

  const linhaSem = (await listar({ q: `Sem compras ${sufixo}` })).rows.find((r) => Number(r.id) === Number(semCompras.id));
  assert.equal(linhaSem?.uso_vinculado, 0, 'sem compras = 0 (a UI mostra "—"), nunca número inventado');
  assert.equal(linhaSem?.uso_vinculado_label, '0 compras');
});

test('a agregação da utilização é uma única consulta por página (nenhum N+1)', async () => {
  const f1 = await novoFornecedor('N+1 alvo A');
  const f2 = await novoFornecedor('N+1 alvo B');
  await createRecord(RESOURCES.compras, { fornecedor_id: Number(f1.id), data: '2026-10-01' }, atorA);
  await createRecord(RESOURCES.compras, { fornecedor_id: Number(f2.id), data: '2026-10-01' }, atorA);

  const store = getStore();
  const original = store.countByColumn.bind(store);
  let chamadas = 0;
  const spy = async (...args: any[]) => {
    chamadas += 1;
    return (original as any)(...args);
  };
  (store as any).countByColumn = spy;
  try {
    const res = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 25, q: `N+1 alvo` }, empresaA);
    assert.equal(res.rows.length, 2, 'os dois fornecedores estão na mesma página');
  } finally {
    (store as any).countByColumn = original;
  }
  assert.equal(chamadas, 1, 'UMA chamada agregada (countByColumn) serve a página inteira');
});

// ---------------------------------------------------------------------------
// RBAC: `fornecedores` é cadastro POR EMPRESA (sem piso de escrita)
// ---------------------------------------------------------------------------
test('RBAC preservado: o operador lê e edita, mas o servidor recusa o DELETE', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');

  assert.doesNotThrow(() => checkAccess(RESOURCES.fornecedores, operador as any, 'read'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.fornecedores, operador as any, 'create'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.fornecedores, operador as any, 'update'));
  assert.throws(
    () => checkAccess(RESOURCES.fornecedores, operador as any, 'delete'),
    (e: any) => e.status === 403,
    'o operador não exclui fornecedores (o servidor é a autoridade)'
  );
  assert.doesNotThrow(() => checkAccess(RESOURCES.fornecedores, gerente as any, 'delete'));

  // O cadastro segue funcionando para os perfis que já o operavam.
  const criado = await createRecord(RESOURCES.fornecedores, { nome: `Do gerente ${sufixo}` }, gerente);
  const alterado = await updateRecord(RESOURCES.fornecedores, Number(criado.id), { ativo: false }, gerente);
  assert.equal(alterado.ativo, false);
});

// ---------------------------------------------------------------------------
// Multiempresa: criação, leitura, edição e exclusão isoladas
// ---------------------------------------------------------------------------
test('multiempresa: o fornecedor de uma empresa não é lido, editado nem excluído por outra', async () => {
  const fornecedorA = await novoFornecedor('Só A');
  const idA = Number(fornecedorA.id);
  const fornecedorB = await createRecord(RESOURCES.fornecedores, { nome: `Só B ${sufixo}` }, atorB);

  // B não enxerga o registro de A (e A não enxerga o de B).
  await esperarErro(() => getRecord(RESOURCES.fornecedores, idA, empresaB), 404);
  const listaB = await listar({ q: `Só A ${sufixo}` }, empresaB);
  assert.equal(listaB.rows.length, 0);
  const listaA = await listar({ q: `Só B ${sufixo}` }, empresaA);
  assert.equal(listaA.rows.length, 0);

  // B não edita nem exclui o registro de A.
  await esperarErro(() => updateRecord(RESOURCES.fornecedores, idA, { nome: 'Invadido' }, atorB), 404);
  await esperarErro(() => deleteRecord(RESOURCES.fornecedores, idA, atorB), 404);

  // A continua dono do registro.
  const aindaA = await getRecord(RESOURCES.fornecedores, idA, empresaA);
  assert.equal(String(aindaA.nome), `Só A ${sufixo}`);

  // As opções de select também são recortadas por empresa.
  const opcoesA = await optionsFor(RESOURCES.fornecedores, empresaA);
  assert.ok(opcoesA.some((o) => o.value === idA));
  assert.ok(!opcoesA.some((o) => o.value === Number(fornecedorB.id)), 'a empresa A não oferece o fornecedor da B');
});

// ---------------------------------------------------------------------------
// Exclusão: diagnóstico de vínculos × fluxo normal
// ---------------------------------------------------------------------------
test('fornecedor vinculado a compras NÃO é excluído e devolve o diagnóstico completo', async () => {
  const fornecedor = await novoFornecedor('Vinculado');
  await createRecord(RESOURCES.compras, { fornecedor_id: Number(fornecedor.id), data: '2026-10-01' }, atorA);

  const erro: any = await esperarErro(() => deleteRecord(RESOURCES.fornecedores, Number(fornecedor.id), atorA), 409, /vinculad/i);
  assert.equal(erro.code, 'dependencias_vinculadas', 'código estável que abre o "Ver vínculos" na tela');
  const diag = erro.details?.dependencias;
  assert.ok(diag, 'o diagnóstico vai em details.dependencias');
  assert.equal(diag.bloqueado, true);
  assert.equal(diag.podeExcluir, false);
  assert.ok(diag.modulosBloqueantes.includes('Compras'), 'o diagnóstico aponta o módulo Compras');
  const vinculo = diag.vinculos.find((v: any) => v.tabela === 'compras');
  assert.ok(vinculo, 'o vínculo de compras está detalhado');
  assert.equal(vinculo.quantidade, 1);

  // Nada foi apagado: o fornecedor e a compra continuam lá.
  assert.equal(Number((await getRecord(RESOURCES.fornecedores, Number(fornecedor.id), empresaA)).id), Number(fornecedor.id));
});

test('fornecedor sem vínculo segue o fluxo normal de exclusão', async () => {
  const fornecedor = await novoFornecedor('Órfão');
  await deleteRecord(RESOURCES.fornecedores, Number(fornecedor.id), atorA);
  await esperarErro(() => getRecord(RESOURCES.fornecedores, Number(fornecedor.id), empresaA), 404);
});

// ---------------------------------------------------------------------------
// Desativação preserva o histórico (nada é apagado)
// ---------------------------------------------------------------------------
test('desativar o fornecedor preserva as compras — o histórico continua apontando para ele', async () => {
  const fornecedor = await novoFornecedor('Desativado');
  const id = Number(fornecedor.id);
  const compra = await createRecord(RESOURCES.compras, { fornecedor_id: id, data: '2026-10-01' }, atorA);

  const desativado = await updateRecord(RESOURCES.fornecedores, id, { ativo: false }, atorA);
  assert.equal(desativado.ativo, false);

  // O registro continua existindo (desativar ≠ apagar).
  const aindaExiste = await getRecord(RESOURCES.fornecedores, id, empresaA);
  assert.equal(aindaExiste.ativo, false);
  assert.equal(String(aindaExiste.nome), `Desativado ${sufixo}`);

  // A compra continua vinculada e legível.
  const compraIntacta = await getRecord(RESOURCES.compras, Number(compra.id), empresaA);
  assert.equal(Number(compraIntacta.fornecedor_id), id);

  // A utilização continua contando o vínculo (nada foi apagado).
  const linha = (await listar({ q: `Desativado ${sufixo}` })).rows.find((r) => Number(r.id) === id);
  assert.equal(linha?.uso_vinculado, 1);

  // E o desativado sai da seleção de NOVOS cadastros marcado como inativo
  // (regra existente das opções do ERP — o histórico permanece referenciável).
  const opcoes = await optionsFor(RESOURCES.fornecedores, empresaA);
  const opcao = opcoes.find((o) => o.value === id);
  assert.ok(opcao, 'a opção continua existindo para os registros antigos');
  assert.match(opcao!.label, /\(inativo\)$/);
});
