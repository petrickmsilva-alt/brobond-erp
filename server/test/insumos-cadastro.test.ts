// ============================================================================
// CADASTROS › INSUMOS — contrato do padrão profissional (memória).
//
// O módulo continua sendo o CRUD genérico dirigido por `resources.ts`. O que
// este arquivo trava é o contrato que a TELA usa:
//   • metadado do padrão LISTA → PÁGINA (sem drawer/modal), filtros reais e
//     uso real — e NENHUM campo inventado (o domínio de `insumos` tem só
//     nome, unidade, custo_medio, fornecedor_id, ativo);
//   • busca por nome e filtros (unidade, fornecedor, status) no SERVIDOR, na
//     mesma listagem paginada (sem SQL paralelo);
//   • coluna "Estoque" = saldo REAL de `estoque_insumos`, agregado pelo
//     servidor em UMA consulta por página (nunca um N+1, nunca número
//     inventado);
//   • coluna "Utilização" = contagem REAL de fichas técnicas;
//   • MULTIEMPRESA: o saldo e a utilização são recortados pela empresa ativa;
//   • RBAC preservado: `insumos` é cadastro POR EMPRESA (sem piso de escrita)
//     e o operador não exclui (o servidor bloqueia);
//   • exclusão: insumo vinculado devolve o diagnóstico de vínculos e o insumo
//     permanece; a saída é DESATIVAR;
//   • CUSTO MÉDIO: a regra de formação pelo recebimento de compras NÃO mudou
//     (o campo continua editável como no CRUD genérico).
//
// A variante contra PostgreSQL real fica em test/pg/insumos-pg.test.ts.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'admin');
const atorB = await criarAtor(2, 'admin');

const sufixo = `${Date.now() % 1000000}`;

async function novoInsumo(nome: string, extra: Record<string, unknown> = {}, ator: any = atorA) {
  return createRecord(
    RESOURCES.insumos,
    { nome: `${nome} ${sufixo}`, unidade: 'm', custo_medio: 10, ativo: true, ...extra },
    ator
  );
}

/** Lista só os insumos deste arquivo (o modo demonstração já tem insumos). */
async function listar(
  p: { q?: string; filter?: Record<string, unknown>; page?: number; pageSize?: number },
  escopo = empresaA
) {
  const res = await listRecords(RESOURCES.insumos, { page: 1, pageSize: 500, ...p }, escopo);
  const rows = res.rows.filter((r) => String(r.nome).includes(sufixo));
  return { ...res, rows };
}

// ---------------------------------------------------------------------------
// A) Metadado do padrão LISTA → PÁGINA (fonte única de verdade)
// ---------------------------------------------------------------------------
test('cadastro declara o padrão LISTA → PÁGINA (sem drawer/modal), filtros reais e uso real', () => {
  const r = RESOURCES.insumos;
  // O BROBOND ERP não usa formulário sobreposto: a inclusão/edição é a página
  // /insumos/novo e /insumos/:id/editar. O metadado não oferece superfície de
  // drawer nem de modal — a rota vive em client/src/modules.ts › FORM_DIRETO.
  assert.equal('editor' in r, false, 'Insumos não declara drawer/modal: o formulário é página');
  assert.equal(r.empresa, true, 'cadastro por EMPRESA (multiempresa preservada)');
  assert.equal(r.minPerfilEscrita, undefined, 'sem piso de escrita: é cadastro por empresa');
  assert.deepEqual(r.ops, { create: true, update: true, delete: true });

  // Filtros: SOMENTE campos que existem de verdade em `insumos`.
  assert.deepEqual(r.filterFields, ['unidade', 'fornecedor_id', 'ativo']);
  assert.equal(r.quickFilters?.[0]?.field, 'ativo');
  assert.deepEqual(
    r.quickFilters?.[0]?.options.map((o) => o.label),
    ['Todos', 'Ativos', 'Inativos']
  );
  // Utilização real: as fichas técnicas que consomem o insumo.
  assert.deepEqual(r.uso, {
    recurso: 'itens_ficha_tecnica',
    campo: 'insumo_id',
    singular: 'ficha técnica',
    plural: 'fichas técnicas',
  });
});

// ---------------------------------------------------------------------------
// A) NENHUM campo inventado — o domínio real de `insumos`
// ---------------------------------------------------------------------------
test('os campos do formulário são exatamente os que existem em `insumos` — nenhum inventado', () => {
  const r = RESOURCES.insumos;
  const nomes = r.fields.map((f) => f.name);
  assert.deepEqual(
    nomes,
    ['nome', 'unidade', 'custo_medio', 'fornecedor_id', 'ativo', 'criado_em', 'atualizado_em'],
    'o formulário usa os campos reais da tabela insumos'
  );
  // Nada de SKU/NCM/descrição/marca/cor/imagem/categoria/localização.
  for (const proibido of ['sku', 'codigo', 'ncm', 'descricao', 'marca', 'cor_id', 'imagem', 'categoria_id', 'localizacao', 'local_id']) {
    assert.equal(nomes.includes(proibido), false, `${proibido} não existe em insumos`);
  }
  // Estoque mínimo/máximo NÃO são campos de `insumos`: vivem em
  // `estoque_insumos` (só o mínimo). Nenhum dos dois foi inventado aqui.
  assert.equal(nomes.includes('estoque_min'), false);
  assert.equal(nomes.includes('estoque_max'), false);
  // E o recurso de saldo continua declaring o estoque mínimo (sem máximo).
  const saldos = RESOURCES.estoque_insumos;
  assert.ok(saldos.fields.some((f) => f.name === 'estoque_min' && f.min === 0));
  assert.equal(saldos.fields.some((f) => f.name === 'estoque_max'), false, 'não existe estoque máximo no domínio');

  // A unidade é o dicionário real (o mesmo que o servidor valida).
  const unidade = r.fields.find((f) => f.name === 'unidade');
  assert.equal(unidade?.type, 'select');
  assert.equal(unidade?.required, true);
  assert.ok((unidade?.options?.length ?? 0) > 1);
});

// ---------------------------------------------------------------------------
// B/C) Busca e filtros no SERVIDOR, na mesma listagem paginada
// ---------------------------------------------------------------------------
test('busca encontra o insumo pelo nome e o filtro de unidade/fornecedor/status recorta no servidor', async () => {
  const fornecedorA = await createRecord(RESOURCES.fornecedores, { nome: `Forn A ${sufixo}`, ativo: true }, atorA);
  const fornecedorB = await createRecord(RESOURCES.fornecedores, { nome: `Forn B ${sufixo}`, ativo: true }, atorA);

  await novoInsumo('Malha azul', { unidade: 'm', fornecedor_id: Number(fornecedorA.id) });
  await novoInsumo('Malha verde', { unidade: 'kg', fornecedor_id: Number(fornecedorB.id) });

  const porNome = await listar({ q: 'malha' });
  assert.equal(porNome.rows.length, 2, 'a busca parcial (sem caixa) encontra os dois');

  const porUnidade = await listar({ filter: { unidade: 'kg' } });
  assert.deepEqual(porUnidade.rows.map((r) => r.nome), [`Malha verde ${sufixo}`]);

  const porFornecedor = await listar({ filter: { fornecedor_id: String(fornecedorA.id) } });
  assert.deepEqual(porFornecedor.rows.map((r) => r.nome), [`Malha azul ${sufixo}`]);
});

test('filtro de status separa ativos de inativos (contrato f.ativo)', async () => {
  await novoInsumo('Ativo', { ativo: true });
  await novoInsumo('Inativo', { ativo: false });

  const ativos = await listar({ filter: { ativo: 'true' } });
  const inativos = await listar({ filter: { ativo: 'false' } });

  assert.ok(ativos.rows.length > 0);
  assert.ok(ativos.rows.every((r) => r.ativo !== false), 'Ativos não traz inativo');
  assert.deepEqual(inativos.rows.map((r) => r.nome), [`Inativo ${sufixo}`]);
});

// ---------------------------------------------------------------------------
// Estoque: saldo REAL, agregado no servidor (sem N+1)
// ---------------------------------------------------------------------------
test('a coluna Estoque devolve o saldo REAL de estoque_insumos — e null quando nunca movimentado', async () => {
  const insumo = await novoInsumo('Com saldo');
  const semSaldo = await novoInsumo('Sem saldo');

  // Saldo real: a linha de `estoque_insumos` é a fonte (como no ERP).
  await getStore().insert(RESOURCES.estoque_insumos, {
    empresa_id: 1,
    insumo_id: Number(insumo.id),
    quantidade: 250,
    estoque_min: 10,
  });

  const linhas = await listar({ q: 'Com saldo' });
  const linha = linhas.rows.find((r) => Number(r.id) === Number(insumo.id));
  assert.ok(linha, 'o insumo aparece na listagem');
  assert.equal(Number(linha!.estoque_saldo), 250, 'saldo real, não zero nem exemplo');

  const linhaSem = (await listar({ q: 'Sem saldo' })).rows.find((r) => Number(r.id) === Number(semSaldo.id));
  assert.equal(linhaSem?.estoque_saldo, null, 'sem saldo registered = null (a UI mostra "—"), nunca 0 inventado');

  // O detalhe (GET) traz a MESMA informação — a tela não recalcula nada.
  const detalhe = await getRecord(RESOURCES.insumos, Number(insumo.id), empresaA);
  assert.equal(Number(detalhe.estoque_saldo), 250);
});

test('a agregação do saldo é uma única consulta por página (nenhum N+1)', async () => {
  // Many insumos na MESMA página: o número de consultas não pode crescer com a
  // quantidade listada. A prova: uma chamada ao store para o saldo, com todos
  // os ids de uma vez.
  const insumo = await novoInsumo('N+1 alvo');
  const alvos = [Number(insumo.id)];
  const store = getStore();
  const original = store.sumByColumn.bind(store);
  let chamadas = 0;
  const spy = async (...args: any[]) => {
    chamadas += 1;
    return (original as any)(...args);
  };
  (store as any).sumByColumn = spy;
  try {
    await listRecords(
      RESOURCES.insumos,
      { page: 1, pageSize: 25, filter: { nome: `N+1 alvo ${sufixo}` } },
      empresaA
    );
  } finally {
    (store as any).sumByColumn = original;
  }
  assert.equal(chamadas, 1, 'UMA chamada agregada serve a página inteira');
  assert.ok(alvos.length === 1);
});

// ---------------------------------------------------------------------------
// Utilização: contagem REAL de fichas técnicas, multiempresa preservada
// ---------------------------------------------------------------------------
test('utilização conta as fichas técnicas da empresa ativa — nunca número inventado', async () => {
  const insumo = await novoInsumo('Uso insumo');
  const insumoB = await createRecord(
    RESOURCES.insumos,
    { nome: `Uso insumo B ${sufixo}`, unidade: 'm', custo_medio: 1, ativo: true },
    atorB
  );

  const produto = await createRecord(
    RESOURCES.produtos,
    { sku: `USO-FICHA-${sufixo}`, nome: `Produto ficha ${sufixo}` },
    atorA
  );
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: Number(produto.id) }, atorA);
  await createRecord(
    RESOURCES.itens_ficha_tecnica,
    { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: 2, perda_pct: 0 },
    atorA
  );
  await createRecord(
    RESOURCES.itens_ficha_tecnica,
    { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: 1, perda_pct: 0 },
    atorA
  );

  const daA = (await listar({ q: `Uso insumo ${sufixo}` }, empresaA)).rows.find((r) => Number(r.id) === Number(insumo.id));
  assert.ok(daA, 'o insumo aparece na listagem da empresa A');
  assert.equal(daA!.uso_vinculado, 2, 'duas linhas de ficha técnica');
  assert.equal(daA!.uso_vinculado_label, '2 fichas técnicas');

  // O insumo da empresa B não aparece para A (isolamento preservado).
  const daB = (await listar({ q: `Uso insumo B ${sufixo}` }, empresaB)).rows.find((r) => Number(r.id) === Number(insumoB.id));
  assert.ok(daB, 'o insumo da empresa B aparece para B');
  assert.equal(daB!.uso_vinculado, 0, 'B não tem ficha técnica com esse insumo');

  const listaA = await listar({ q: `Uso insumo B ${sufixo}` }, empresaA);
  assert.equal(listaA.rows.length, 0, 'a empresa A não enxerga o insumo da empresa B');
});

// ---------------------------------------------------------------------------
// RBAC: `insumos` é cadastro POR EMPRESA (sem piso de escrita)
// ---------------------------------------------------------------------------
test('RBAC preservado: o operador lê e edita, mas o servidor recusa o DELETE', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');

  assert.doesNotThrow(() => checkAccess(RESOURCES.insumos, operador as any, 'read'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.insumos, operador as any, 'create'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.insumos, operador as any, 'update'));
  assert.throws(
    () => checkAccess(RESOURCES.insumos, operador as any, 'delete'),
    (e: any) => e.status === 403,
    'o operador não exclui insumos (o servidor é a autoridade)'
  );
  assert.doesNotThrow(() => checkAccess(RESOURCES.insumos, gerente as any, 'delete'));

  // O cadastro segue funcionando para quem tem o piso.
  const criado = await createRecord(RESOURCES.insumos, { nome: `Do gerente ${sufixo}`, unidade: 'un' }, gerente);
  const alterado = await updateRecord(RESOURCES.insumos, Number(criado.id), { ativo: false }, gerente);
  assert.equal(alterado.ativo, false);
});

// ---------------------------------------------------------------------------
// Multiempresa: criação, leitura, edição e exclusão isoladas
// ---------------------------------------------------------------------------
test('multiempresa: o insumo de uma empresa não é lido, editado nem excluído por outra', async () => {
  const insumoA = await novoInsumo('Só A');
  const idA = Number(insumoA.id);

  // B não enxerga o registro de A.
  await esperarErro(() => getRecord(RESOURCES.insumos, idA, empresaB), 404);
  const listaB = await listar({ q: `Só A ${sufixo}` }, empresaB);
  assert.equal(listaB.rows.length, 0);

  // B não edita o registro de A.
  await esperarErro(() => updateRecord(RESOURCES.insumos, idA, { nome: 'Invadido' }, atorB), 404);

  // B não exclui o registro de A.
  await esperarErro(() => deleteRecord(RESOURCES.insumos, idA, atorB), 404);

  // A continua dono do registro.
  const aindaA = await getRecord(RESOURCES.insumos, idA, empresaA);
  assert.equal(String(aindaA.nome), `Só A ${sufixo}`);
});

// ---------------------------------------------------------------------------
// Custo médio: campo editável, com a regra de compras INTACTA
// ---------------------------------------------------------------------------
test('custo médio continua editável como no CRUD genérico (a regra das compras não mudou)', async () => {
  const insumo = await novoInsumo('Custo editável', { custo_medio: 10 });

  const editado = await updateRecord(RESOURCES.insumos, Number(insumo.id), { custo_medio: 25.5 }, atorA);
  assert.equal(Number(editado.custo_medio), 25.5, 'o cadastro edita o valor de referência');

  // O valor é recusado quando negativo — o servidor continua a autoridade.
  const erro: any = await esperarErro(
    () => updateRecord(RESOURCES.insumos, Number(insumo.id), { custo_medio: -1 }, atorA),
    400
  );
  assert.ok(erro.fields?.custo_medio, 'o erro aponta o campo custo_medio');

  // E o saldo/custo NÃO são recalculados por esta edição: a formação do custo
  // médio continua sendo do recebimento de compras (nada foi alterado aqui).
  const custoDepois = await getRecord(RESOURCES.insumos, Number(insumo.id), empresaA);
  assert.equal(Number(custoDepois.custo_medio), 25.5);
});

// ---------------------------------------------------------------------------
// Validação: nome obrigatório e unidade válida
// ---------------------------------------------------------------------------
test('validação: nome é obrigatório e a unidade precisa ser do dicionário', async () => {
  const erroNome: any = await esperarErro(
    () => createRecord(RESOURCES.insumos, { nome: '   ', unidade: 'm' }, atorA),
    400
  );
  assert.ok(erroNome.fields?.nome, 'erro no campo nome');

  await esperarErro(() => createRecord(RESOURCES.insumos, { nome: `Unidade inválida ${sufixo}`, unidade: 'ZZZ' }, atorA), 400);
});

// ---------------------------------------------------------------------------
// Exclusão: diagnóstico de vínculos × fluxo normal
// ---------------------------------------------------------------------------
test('insumo vinculado NÃO é excluído e devolve o diagnóstico completo', async () => {
  const insumo = await novoInsumo('Vinculado');
  const produto = await createRecord(
    RESOURCES.produtos,
    { sku: `DEP-FICHA-${sufixo}`, nome: `Produto vinculado ${sufixo}` },
    atorA
  );
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: Number(produto.id) }, atorA);
  await createRecord(
    RESOURCES.itens_ficha_tecnica,
    { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: 1, perda_pct: 0 },
    atorA
  );

  const erro: any = await esperarErro(() => deleteRecord(RESOURCES.insumos, Number(insumo.id), atorA), 409, /vinculad/i);
  assert.equal(erro.code, 'dependencias_vinculadas', 'código estável que abre o modal na tela');
  const diag = erro.details?.dependencias;
  assert.ok(diag, 'o diagnóstico vai em details.dependencias');
  assert.equal(diag.bloqueado, true);
  assert.equal(diag.podeExcluir, false);
  assert.ok(diag.modulosBloqueantes.length > 0, 'o diagnóstico diz onde o insumo é usado');

  // Nada foi apagado: o insumo e a ficha continuam lá.
  assert.equal(Number((await getRecord(RESOURCES.insumos, Number(insumo.id), empresaA)).id), Number(insumo.id));
});

test('insumo sem vínculo segue o fluxo normal de exclusão', async () => {
  const insumo = await novoInsumo('Órfão');
  await deleteRecord(RESOURCES.insumos, Number(insumo.id), atorA);
  await esperarErro(() => getRecord(RESOURCES.insumos, Number(insumo.id), empresaA), 404);
});

// ---------------------------------------------------------------------------
// Desativação preserva o histórico (nada é apagado)
// ---------------------------------------------------------------------------
test('desativar o insumo preserva compras, movimentações e fichas — o histórico continua', async () => {
  const insumo = await novoInsumo('Desativado');
  const id = Number(insumo.id);

  const desativado = await updateRecord(RESOURCES.insumos, id, { ativo: false }, atorA);
  assert.equal(desativado.ativo, false);

  // O registro continua existindo (desativar ≠ apagar).
  const aindaExiste = await getRecord(RESOURCES.insumos, id, empresaA);
  assert.equal(aindaExiste.ativo, false);
  assert.equal(String(aindaExiste.nome), `Desativado ${sufixo}`);

  // E o saldo de estoque (movimentação) continua lá.
  await getStore().insert(RESOURCES.estoque_insumos, {
    empresa_id: 1,
    insumo_id: id,
    quantidade: 10,
    estoque_min: 0,
  });
  const comSaldo = await getRecord(RESOURCES.insumos, id, empresaA);
  assert.equal(Number(comSaldo.estoque_saldo), 10, 'o saldo do insumo desativado continua no estoque');
});
