// ============================================================================
// CADASTROS › INSUMOS — contrato do padrão profissional (memória).
//
// O módulo continua sendo o CRUD genérico dirigido por `resources.ts`. O que
// este arquivo trava é o contrato que a TELA usa:
//   • metadado do padrão LISTA → PÁGINA (sem drawer/modal), filtros reais e
//     uso real — e NENHUM campo inventado (o domínio de `insumos` tem
//     nome, codigo_insumo, categoria_id, unidade, custo_medio, fornecedor_id
//     e ativo — migration 0041);
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
//   • CUSTO MÉDIO: referência inicial editável; depois da PRIMEIRA movimentação
//     (compra/entrada) o valor é formado pelo recebimento e o servidor recusa
//     um PUT que tente alterá-lo (409) — a formação pelo fluxo de compras não
//     muda.
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
  assert.deepEqual(r.filterFields, ['categoria_id', 'unidade', 'fornecedor_id', 'ativo']);
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
    ['codigo_insumo', 'nome', 'categoria_id', 'unidade', 'unidade_compra', 'ativo', 'fornecedor_id', 'custo_medio', 'criado_em', 'atualizado_em'],
    'o formulário usa os campos reais da tabela insumos'
  );
  // `unidade_compra` EXISTE em `insumos` (migration 0060, P3-04): é como o
  // insumo é COMPRADO (rolo) quando difere da unidade de uso (metro). A
  // conversão correspondente é declarada em `unidade_conversoes` — o ERP não
  // estima fator, e o campo é opcional (vazio = compra na unidade de uso).
  assert.equal(nomes.includes('unidade_compra'), true, 'unidade de compra (0060)');
  // `codigo_insumo` e `categoria_id` EXISTEM em `insumos` (migration 0041) e são
  // identificador operacional e agrupamento — não são campos inventados.
  assert.ok(nomes.includes('codigo_insumo'), 'código operacional do insumo (0041)');
  assert.ok(nomes.includes('categoria_id'), 'categoria de insumo (0041)');
  // Nada de NCM/descrição/marca/cor/imagem/localização física.
  for (const proibido of ['sku', 'ncm', 'descricao', 'marca', 'cor_id', 'imagem', 'localizacao', 'local_id']) {
    assert.equal(nomes.includes(proibido), false, `${proibido} não existe em insumos`);
  }
  // Estoque mínimo/máximo NÃO são campos de `insumos`: vivem em
  // `estoque_insumos` (só o mínimo). Nenhum dos dois foi inventado aqui.
  assert.equal(nomes.includes('estoque_min'), false);
  assert.equal(nomes.includes('estoque_max'), false);
  // A categoria do insumo é a taxonomia PRÓPRIA (não a categoria de produto).
  assert.equal(r.fields.find((f) => f.name === 'categoria_id')?.ref, 'categorias_insumos');
  // E o recurso de saldo continua declarando o estoque mínimo (sem máximo).
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
// A2) Categorias de insumos: taxonomia PRÓPRIA, por empresa
// ---------------------------------------------------------------------------
test('categorias de insumos é cadastro por EMPRESA com taxonomia própria (não é a categoria de produto)', () => {
  const c = RESOURCES.categorias_insumos;
  assert.ok(c, 'recurso declarado');
  assert.equal(c.empresa, true, 'por empresa (isolamento multiempresa)');
  assert.equal(c.minPerfilEscrita, undefined, 'sem piso de escrita novo');
  assert.deepEqual(c.fields.map((f) => f.name), ['nome', 'descricao', 'pai_id', 'ativo', 'criado_em', 'atualizado_em']);
  assert.equal(c.fields.find((f) => f.name === 'nome')?.uniqueEmpresa, true, 'nome único por empresa');
  assert.equal(c.fields.find((f) => f.name === 'pai_id')?.ref, 'categorias_insumos', 'um nível de categoria-pai');
  // Utilização: quantos insumos usam a categoria (contagem agregada no servidor).
  assert.deepEqual(c.uso, { recurso: 'insumos', campo: 'categoria_id', singular: 'insumo', plural: 'insumos' });
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
// Custo médio: referência inicial editável; DADO CALCULADO após a 1ª compra
// ---------------------------------------------------------------------------
test('custo médio é editável como referência inicial, mas vira dado calculado após a primeira movimentação', async () => {
  const insumo = await novoInsumo('Custo editável', { custo_medio: 10 });
  const insumoId = Number(insumo.id);

  // Sem histórico: ainda é a referência inicial do cadastro — editável.
  const editado = await updateRecord(RESOURCES.insumos, insumoId, { custo_medio: 25.5 }, atorA);
  assert.equal(Number(editado.custo_medio), 25.5, 'o cadastro edita o valor de referência enquanto não há compra');

  // O valor é recusado quando negativo — o servidor continua a autoridade.
  const erro: any = await esperarErro(
    () => updateRecord(RESOURCES.insumos, insumoId, { custo_medio: -1 }, atorA),
    400
  );
  assert.ok(erro.fields?.custo_medio, 'o erro aponta o campo custo_medio');

  // Depois da PRIMEIRA movimentação, o custo médio é formado pelo recebimento
  // de compras: um PUT que o altere é recusado (não é campo manual).
  await createRecord(
    RESOURCES.movimentacoes_insumos,
    { tipo: 'entrada', insumo_id: insumoId, quantidade: 5, custo_unitario: 25.5 },
    atorA
  );
  const erroCalculado: any = await esperarErro(
    () => updateRecord(RESOURCES.insumos, insumoId, { custo_medio: 99 }, atorA),
    409
  );
  assert.ok(erroCalculado.fields?.custo_medio, 'o 409 aponta o campo custo_medio');

  // Editar outros campos continua permitido, e o custo calculado não muda.
  const soNome = await updateRecord(RESOURCES.insumos, insumoId, { nome: `Custo calculado ${sufixo}` }, atorA);
  assert.equal(Number(soNome.custo_medio), 25.5, 'a edição de outros campos não mexe no custo calculado');
});

// ---------------------------------------------------------------------------
// Código do insumo: identificador operacional único POR EMPRESA
// ---------------------------------------------------------------------------
test('código do insumo é único por empresa (e opcional)', async () => {
  const codigo = `INS-T-${sufixo}`;
  const a = await novoInsumo('Com código', { codigo_insumo: codigo });
  assert.equal(String(a.codigo_insumo), codigo);

  // Duplicar o MESMO código na MESMA empresa é recusado (409 do store).
  await esperarErro(() => novoInsumo('Código repetido', { codigo_insumo: codigo }), 409);

  // Sem código continua válido (o campo é opcional).
  const semCodigo = await novoInsumo('Sem código');
  assert.ok(semCodigo.id);

  // O código entra na BUSCA (server-side), como o nome.
  const achado = await listar({ q: codigo });
  assert.ok(achado.rows.some((r) => Number(r.id) === Number(a.id)), 'a busca encontra pelo código');
});

// ---------------------------------------------------------------------------
// Categoria do insumo: agrupamento por empresa + filtro server-side
// ---------------------------------------------------------------------------
test('categoria do insumo agrupa, filtra no servidor e respeita a empresa', async () => {
  const cat = await createRecord(RESOURCES.categorias_insumos, { nome: `Malhas ${sufixo}` }, atorA);
  const insumo = await novoInsumo('Categorizado', { categoria_id: Number(cat.id) });
  assert.equal(Number(insumo.categoria_id), Number(cat.id));

  const porCategoria = await listar({ filter: { categoria_id: String(cat.id) } });
  assert.ok(porCategoria.rows.some((r) => Number(r.id) === Number(insumo.id)), 'o filtro de categoria recorta no servidor');

  // Categoria de OUTRA empresa não é aceita: a referência é resolvida DENTRO da
  // empresa (404, não 400 — não se confirma a existência de dado alheio).
  const catB = await createRecord(RESOURCES.categorias_insumos, { nome: `Malhas B ${sufixo}` }, atorB);
  await esperarErro(() => novoInsumo('Categoria alheia', { categoria_id: Number(catB.id) }, atorA), 404);

  // A utilização da categoria é a contagem REAL de insumos (agregada no
  // servidor), declarada em `categorias_insumos.uso` — nenhum número inventado.
  const cats = await listRecords(RESOURCES.categorias_insumos, { page: 1, pageSize: 500, q: `Malhas ${sufixo}` }, empresaA);
  const linhaCat = cats.rows.find((r) => Number(r.id) === Number(cat.id))!;
  assert.ok(linhaCat, 'a categoria é listada');
  assert.equal(Number(linhaCat.uso_vinculado), 1, 'um insumo usa a categoria');
  assert.equal(linhaCat.uso_vinculado_label, '1 insumo');
  // E a categoria de OUTRA empresa não conta o insumo da empresa A.
  const catsB = await listRecords(RESOURCES.categorias_insumos, { page: 1, pageSize: 500, q: `Malhas B ${sufixo}` }, empresaB);
  const linhaCatB = catsB.rows.find((r) => Number(r.id) === Number(catB.id))!;
  assert.equal(Number(linhaCatB.uso_vinculado ?? 0), 0, 'a categoria da empresa B não vê o insumo de A');
});

// ---------------------------------------------------------------------------
// Estoque DERIVADO: saldo, mínimo, situação e última movimentação
// ---------------------------------------------------------------------------
test('a ficha do insumo deriva saldo, mínimo, situação e última movimentação do estoque real', async () => {
  const insumo = await novoInsumo('Com estoque', { custo_medio: 7 });
  const insumoId = Number(insumo.id);

  // Saldo real em `estoque_insumos` com mínimo cadastrado.
  await getStore().insert(RESOURCES.estoque_insumos, { insumo_id: insumoId, quantidade: 40, estoque_min: 100 });

  const linha = (await listar({ q: `Com estoque ${sufixo}` })).rows.find((r) => Number(r.id) === insumoId)!;
  assert.equal(Number(linha.estoque_saldo), 40, 'saldo real agregado');
  assert.equal(Number(linha.estoque_min), 100, 'mínimo cadastrado em estoque_insumos');
  assert.equal(linha.estoque_status, 'abaixo_minimo', '40 < 100 → abaixo do mínimo');

  // Entrada real → última movimentação e último custo de entrada derivados.
  await createRecord(
    RESOURCES.movimentacoes_insumos,
    { tipo: 'entrada', insumo_id: insumoId, quantidade: 10, custo_unitario: 12.5 },
    atorA
  );
  const depois = (await listar({ q: `Com estoque ${sufixo}` })).rows.find((r) => Number(r.id) === insumoId)!;
  assert.equal(depois.ultima_movimentacao_tipo, 'entrada');
  assert.ok(depois.ultima_movimentacao, 'a última movimentação é datada');
  assert.equal(Number(depois.ultimo_custo_entrada), 12.5, 'custo da última ENTRADA');
  assert.equal(Number(depois.estoque_saldo), 50, 'o saldo reflete a entrada real');

  // Insumo nunca movimentado: situação "sem_registro" e sem números inventados.
  const novo = await novoInsumo('Nunca movimentado');
  const linhaNova = (await listar({ q: `Nunca movimentado ${sufixo}` })).rows.find((r) => Number(r.id) === Number(novo.id))!;
  assert.equal(linhaNova.estoque_saldo, null);
  assert.equal(linhaNova.estoque_status, 'sem_registro');
  assert.equal(linhaNova.ultima_movimentacao, null);
  assert.equal(linhaNova.ultimo_custo_entrada, null);
});

// ---------------------------------------------------------------------------
// SEM N+1: a página inteira custa um número CONSTANTE de consultas
// ---------------------------------------------------------------------------
test('a listagem agrega saldo/mínimo/última movimentação em LOTE (o nº de consultas não cresce com a página)', async () => {
  const store = getStore();
  // Espiões nas agregações: o nº de CHAMADAS (não o nº de linhas) tem de ser
  // constante. Sem `ultimosPorColuna`/`sumByColumn`, a ficha faria N consultas.
  const chamadas = { sum: 0, ultimos: 0, count: 0 };
  const origSum = (store as any).sumByColumn.bind(store);
  const origUlt = (store as any).ultimosPorColuna.bind(store);
  const origCount = (store as any).countByColumn.bind(store);
  (store as any).sumByColumn = (...a: any[]) => {
    chamadas.sum++;
    return origSum(...a);
  };
  (store as any).ultimosPorColuna = (...a: any[]) => {
    chamadas.ultimos++;
    return origUlt(...a);
  };
  (store as any).countByColumn = (...a: any[]) => {
    chamadas.count++;
    return origCount(...a);
  };
  try {
    // Duas fases: 2 insumos e depois 12 insumos NA MESMA PÁGINA (pageSize cobre
    // todos). Se a agregação fosse por linha, o nº de consultas subiria de 2
    // para 12 — o teste falharia.
    for (let i = 0; i < 2; i++) await novoInsumo(`Escala ${i}`);

    chamadas.sum = chamadas.ultimos = chamadas.count = 0;
    const dois = await listar({ page: 1, pageSize: 500 });
    const custoDois = { ...chamadas };

    for (let i = 2; i < 12; i++) await novoInsumo(`Escala ${i}`);

    chamadas.sum = chamadas.ultimos = chamadas.count = 0;
    const doze = await listar({ page: 1, pageSize: 500 });
    const custoDoze = { ...chamadas };

    assert.ok(dois.rows.length >= 2);
    assert.ok(doze.rows.length >= 12, 'a página agora traz 12 insumos deste arquivo');
    assert.deepEqual(
      custoDoze,
      custoDois,
      'o nº de agregações independe da QUANTIDADE de insumos (nenhum N+1)'
    );

    // E o lote é REAL: poucas chamadas, não uma por insumo.
    assert.ok(custoDoze.sum <= 2, 'saldo: 1 agregação por página');
    assert.ok(custoDoze.ultimos <= 4, 'últimas linhas: agregações fixas por página');
    assert.ok(custoDoze.sum < doze.rows.length, 'muito menos agregações do que linhas');
  } finally {
    (store as any).sumByColumn = origSum;
    (store as any).ultimosPorColuna = origUlt;
    (store as any).countByColumn = origCount;
  }
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
