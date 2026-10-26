// ============================================================================
// CADASTROS › GRADES — contrato do padrão profissional (memória).
//
// Grade é entidade ESTRUTURAL do catálogo: além dos campos do cadastro
// (nome, descricao, instrucoes_medidas, ativo) ela tem a relação ORDENADA
// muitos-para-muitos com tamanhos (`grade_tamanhos`). A tela virou LISTA →
// PÁGINA (/grades/novo e /grades/:id/editar — client/src/modules.ts ›
// FORM_DIRETO); este arquivo trava o contrato que a página e a lista usam:
//
//   A. metadado do padrão simples (SEM drawer/modal), filtro de status e uso;
//   B. criação grava `grade_tamanhos` com ordem = posição enviada;
//   C. edição PRESERVA a ordem e a reordenação atualiza a ordem gravada;
//   D. inclusão/remoção individual de tamanho;
//   E. tamanho duplicado não entra duas vezes (UNIQUE grade_id+tamanho_id);
//   F. nome obrigatório/único; descricao e instrucoes_medidas opcionais;
//   G. utilização real: produtos da empresa ativa + categorias (multiempresa);
//   H. estado da tabela de medidas: sem_tabela → parcial → completa;
//   I. desativar preserva tamanhos, medidas, produtos e histórico;
//   J. exclusão sem vínculos remove a grade (e a composição);
//   K. exclusão com vínculos é bloqueada com o DIAGNÓSTICO real (nada apagado);
//   L. RBAC preservado: operador lê, gerente+ escreve (o servidor é autoridade);
//   M. não regressão de produtos (grade efetiva na ordem da grade);
//   N. não regressão da tabela de medidas (GET/PUT + resumo);
//   O. SEM N+1: as consultas da listagem não crescem com o número de grades.
//
// A variante contra PostgreSQL real fica em test/pg/grades-pg.test.ts.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import(
  '../src/services'
);
const { escopoDeSistema } = await import('../src/empresa');
const { ADMIN, chamar, criarAtor, garantirAdmin, esperarErro, reqDe } = await import('./_p1util');

await garantirAdmin();
const s = getStore();
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'admin');
const atorB = await criarAtor(2, 'admin');

const sufixo = `${Date.now() % 1000000}`;

/** Tamanhos reais do dicionário (cria os que faltarem, na ordem do cadastro). */
async function tamanhos(codigos: string[]) {
  const out: number[] = [];
  let ordem = 900;
  for (const codigo of codigos) {
    ordem += 1;
    const achado = await s.findOneWhere(RESOURCES.tamanhos, { codigo });
    out.push(Number(achado ? achado.id : (await createRecord(RESOURCES.tamanhos, { codigo, ordem }, ADMIN)).id));
  }
  return out;
}

async function novaGrade(nome: string, tamanhoIds: number[], extra: Record<string, unknown> = {}, ator: any = atorA) {
  return createRecord(RESOURCES.grades, { nome, tamanhos: tamanhoIds, ...extra }, ator);
}

/** Itens de `grade_tamanhos` da grade, NA ORDEM gravada. */
async function itensDaGrade(gradeId: number) {
  const { rows } = await s.list(RESOURCES.grade_tamanhos, {
    page: 1,
    pageSize: 500,
    filter: { grade_id: gradeId },
    sort: 'ordem',
    dir: 'asc',
  });
  return rows.map((r) => ({ tamanho_id: Number(r.tamanho_id), ordem: Number(r.ordem) }));
}

/** Lista só as grades deste arquivo (o modo demonstração já tem grades de exemplo). */
async function listar(p: { q?: string; filter?: Record<string, unknown>; page?: number; pageSize?: number }, escopo = empresaA) {
  const res = await listRecords(RESOURCES.grades, { page: 1, pageSize: 500, ...p }, escopo);
  return { ...res, rows: res.rows.filter((r) => String(r.nome).includes(sufixo)) };
}

// ---------------------------------------------------------------------------
// A) Metadado: padrão LISTA → PÁGINA (fonte única de verdade)
// ---------------------------------------------------------------------------
test('grades declaram o padrão LISTA → PÁGINA (sem drawer/modal), filtro de status e uso real', () => {
  const r = RESOURCES.grades;
  // O BROBOND ERP não usa formulário sobreposto: inclusão/edição são as páginas
  // /grades/novo e /grades/:id/editar (rota registrada em client/src/App.tsx e
  // listada em client/src/modules.ts › FORM_DIRETO).
  assert.equal('editor' in r, false, 'Grades não declara drawer/modal: o formulário é página');
  assert.deepEqual(r.filterFields, ['ativo']);
  assert.equal(r.quickFilters?.[0]?.field, 'ativo');
  assert.deepEqual(
    r.quickFilters?.[0]?.options.map((o) => o.label),
    ['Todas', 'Ativas', 'Inativas']
  );
  assert.deepEqual(r.uso, { recurso: 'produtos', campo: 'grade_id', singular: 'produto', plural: 'produtos' });
  // RBAC do catálogo compartilhado não mudou (SEC-04/P1-01).
  assert.equal(r.minPerfilEscrita, 'gerente');

  // Campos REAIS do domínio — nenhum campo inventado pela interface.
  const nomes = r.fields.map((f) => f.name);
  for (const esperado of ['nome', 'tamanhos', 'descricao', 'instrucoes_medidas', 'ativo']) {
    assert.ok(nomes.includes(esperado), `o campo "${esperado}" continua no contrato`);
  }
  const tamanhosCampo = r.fields.find((f) => f.name === 'tamanhos');
  assert.equal(tamanhosCampo?.type, 'multiref', 'tamanhos é a relação muitos-para-muitos');
  assert.equal(tamanhosCampo?.ref, 'tamanhos');
  assert.equal(tamanhosCampo?.required, true, 'a grade exige ao menos um tamanho (regra já existente)');
  assert.equal(tamanhosCampo?.virtual, true, 'não é coluna de `grades`: vive em grade_tamanhos');
});

// ---------------------------------------------------------------------------
// B) Criação: ordem = posição enviada
// ---------------------------------------------------------------------------
test('criar a grade grava grade_tamanhos com ordem = posição dos ids enviados', async () => {
  const [p, m, g, gg] = await tamanhos(['P', 'M', 'G', 'GG']);
  const grade = await novaGrade(`Camisetas ${sufixo}`, [p, m, g, gg], {
    descricao: 'Malha e camisaria básica',
    instrucoes_medidas: 'Meça a peça sobre uma superfície plana, sem esticar. Tolerância de ±1 cm.',
  });

  const itens = await itensDaGrade(Number(grade.id));
  assert.deepEqual(
    itens.map((i) => i.tamanho_id),
    [p, m, g, gg],
    'a sequência gravada é exatamente a enviada'
  );
  assert.deepEqual(
    itens.map((i) => i.ordem),
    [1, 2, 3, 4],
    'ordem determinística a partir de 1'
  );

  const linha = (await listar({ q: `Camisetas ${sufixo}` })).rows[0];
  assert.deepEqual(linha.tamanhos, [p, m, g, gg], 'a listagem devolve os ids na ordem');
  assert.equal(linha.tamanhos__label, 'P · M · G · GG', 'os códigos aparecem na ordem da grade');
  assert.equal(linha.tamanhos_total, 4);
  assert.equal(linha.descricao, 'Malha e camisaria básica');
  assert.match(String(linha.instrucoes_medidas), /superfície plana/);
});

test('grade sem tamanho é recusada (a regra de obrigatoriedade já existia)', async () => {
  await esperarErro(() => novaGrade(`Sem tamanho ${sufixo}`, []), 400, /obrigatório|Verifique os campos/i);
  const achadas = await listar({ q: `Sem tamanho ${sufixo}` });
  assert.equal(achadas.rows.length, 0, 'nada foi gravado');
});

// ---------------------------------------------------------------------------
// C/D) Edição: ordem preservada, reordenação, inclusão e remoção individual
// ---------------------------------------------------------------------------
test('editar sem mexer nos tamanhos PRESERVA a ordem existente', async () => {
  const [p, m, g] = await tamanhos(['P', 'M', 'G']);
  const grade = await novaGrade(`Ordem preservada ${sufixo}`, [g, p, m]);
  const antes = await itensDaGrade(Number(grade.id));

  const editada = await updateRecord(RESOURCES.grades, Number(grade.id), { descricao: 'Só a descrição mudou' }, atorA);
  assert.equal(editada.descricao, 'Só a descrição mudou');

  const depois = await itensDaGrade(Number(grade.id));
  assert.deepEqual(depois, antes, 'nenhum item de grade foi reescrito');
});

test('reordenar atualiza grade_tamanhos.ordem (a semântica de ordem não muda)', async () => {
  const [p, m, g, gg] = await tamanhos(['P', 'M', 'G', 'GG']);
  const grade = await novaGrade(`Reordenada ${sufixo}`, [p, m, g, gg]);
  assert.deepEqual(
    (await itensDaGrade(Number(grade.id))).map((i) => i.tamanho_id),
    [p, m, g, gg]
  );

  // GG para o início (é o que o ↑ ↓ da página produz: a mesma lista, outra ordem).
  await updateRecord(RESOURCES.grades, Number(grade.id), { tamanhos: [gg, p, m, g] }, atorA);
  const itens = await itensDaGrade(Number(grade.id));
  assert.deepEqual(
    itens.map((i) => i.tamanho_id),
    [gg, p, m, g]
  );
  assert.deepEqual(
    itens.map((i) => i.ordem),
    [1, 2, 3, 4],
    'a ordem volta a ser 1..N, sem buracos'
  );
  assert.equal((await getRecord(RESOURCES.grades, Number(grade.id), empresaA)).tamanhos__label, 'GG · P · M · G');
});

test('incluir e remover um tamanho individualmente mantém os demais na ordem', async () => {
  const [p, m, g, gg] = await tamanhos(['P', 'M', 'G', 'GG']);
  const grade = await novaGrade(`Inclusao remocao ${sufixo}`, [p, m, g]);

  // Inclusão no fim (comportamento do clique em "Tamanhos disponíveis").
  await updateRecord(RESOURCES.grades, Number(grade.id), { tamanhos: [p, m, g, gg] }, atorA);
  assert.deepEqual(
    (await itensDaGrade(Number(grade.id))).map((i) => i.tamanho_id),
    [p, m, g, gg]
  );

  // Remoção do meio: os seguintes sobem de posição, a ordem relativa permanece.
  await updateRecord(RESOURCES.grades, Number(grade.id), { tamanhos: [p, g, gg] }, atorA);
  const itens = await itensDaGrade(Number(grade.id));
  assert.deepEqual(
    itens.map((i) => i.tamanho_id),
    [p, g, gg]
  );
  assert.deepEqual(
    itens.map((i) => i.ordem),
    [1, 2, 3]
  );
});

// ---------------------------------------------------------------------------
// E) Duplicidade
// ---------------------------------------------------------------------------
test('tamanho duplicado não entra duas vezes (UNIQUE grade_id + tamanho_id)', async () => {
  const [p, m] = await tamanhos(['P', 'M']);
  const grade = await novaGrade(`Duplicada ${sufixo}`, [p, m, p, m, p]);
  const itens = await itensDaGrade(Number(grade.id));
  assert.deepEqual(
    itens.map((i) => i.tamanho_id),
    [p, m],
    'a primeira ocorrência vence e a ordem é mantida'
  );
  assert.deepEqual(
    itens.map((i) => i.ordem),
    [1, 2]
  );

  // O mesmo na edição: não estoura a UNIQUE nem duplica linha no modo demo.
  await updateRecord(RESOURCES.grades, Number(grade.id), { tamanhos: [m, m, p] }, atorA);
  const depois = await itensDaGrade(Number(grade.id));
  assert.deepEqual(
    depois.map((i) => i.tamanho_id),
    [m, p]
  );
});

// ---------------------------------------------------------------------------
// F) Nome/descrição/instruções — mesmas regras do ERP
// ---------------------------------------------------------------------------
test('nome é único e os textos opcionais viram null quando vazios', async () => {
  const [p] = await tamanhos(['P']);
  await novaGrade(`Unica ${sufixo}`, [p]);
  const erro: any = await esperarErro(() => novaGrade(`UNICA ${sufixo}`, [p]), 409, /Já existe um registro com este nome/i);
  assert.equal(erro.fields?.nome, 'Já cadastrado');

  const semTextos = await novaGrade(`Sem textos ${sufixo}`, [p], { descricao: '', instrucoes_medidas: '' });
  assert.equal(semTextos.descricao, null);
  assert.equal(semTextos.instrucoes_medidas, null);

  const comEspacos = await novaGrade(`Com espacos ${sufixo}`, [p], {
    descricao: '  Sarja e jeans  ',
    instrucoes_medidas: '  Tolerância de ±1 cm.  ',
  });
  assert.equal(comEspacos.descricao, 'Sarja e jeans', 'texto aparado');
  assert.equal(comEspacos.instrucoes_medidas, 'Tolerância de ±1 cm.');
});

// ---------------------------------------------------------------------------
// G) Busca e filtro de status (contrato existente, no servidor)
// ---------------------------------------------------------------------------
test('busca e filtro de status usam a mesma listagem paginada', async () => {
  const [p] = await tamanhos(['P']);
  await novaGrade(`Camiseta Busca ${sufixo}`, [p], { ativo: true });
  await novaGrade(`Calca Busca ${sufixo}`, [p], { ativo: false });

  const porNome = await listar({ q: 'busca' });
  assert.equal(porNome.rows.length, 2, 'busca parcial e sem caixa');

  const ativas = await listar({ q: 'busca', filter: { ativo: 'true' } });
  assert.deepEqual(ativas.rows.map((r) => r.nome), [`Camiseta Busca ${sufixo}`]);
  const inativas = await listar({ q: 'busca', filter: { ativo: 'false' } });
  assert.deepEqual(inativas.rows.map((r) => r.nome), [`Calca Busca ${sufixo}`]);
});

// ---------------------------------------------------------------------------
// G) Utilização real (produtos da empresa ativa + categorias) e MULTIEMPRESA
// ---------------------------------------------------------------------------
test('utilização conta produtos da EMPRESA ATIVA e categorias vinculadas — nunca número inventado', async () => {
  const [p, m] = await tamanhos(['P', 'M']);
  const grade = await novaGrade(`Uso ${sufixo}`, [p, m]);
  const gid = Number(grade.id);

  await createRecord(RESOURCES.produtos, { sku: `GR-A1-${sufixo}`, nome: `Produto A1 ${sufixo}`, grade_id: gid }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `GR-A2-${sufixo}`, nome: `Produto A2 ${sufixo}`, grade_id: gid }, atorA);
  // Produto da empresa B com a MESMA grade (o catálogo é global): não entra na
  // contagem de A e não vaza para a tela de A.
  await createRecord(RESOURCES.produtos, { sku: `GR-B1-${sufixo}`, nome: `Produto B1 ${sufixo}`, grade_id: gid }, atorB);
  await createRecord(RESOURCES.categorias, { nome: `Categoria uso ${sufixo}`, grade_id: gid }, atorA);

  const daA = (await listar({ q: `Uso ${sufixo}` }, empresaA)).rows[0];
  assert.equal(daA.uso_vinculado, 2, 'só os produtos da empresa ativa');
  assert.equal(daA.uso_categorias, 1, 'categorias que usam a grade como padrão');
  assert.equal(daA.uso_vinculado_label, '2 produtos · 1 categoria');

  const daB = (await listar({ q: `Uso ${sufixo}` }, empresaB)).rows[0];
  assert.equal(daB.uso_vinculado, 1, 'a empresa B vê apenas os produtos dela');
  assert.equal(daB.uso_vinculado_label, '1 produto · 1 categoria');

  const semUso = await novaGrade(`Sem uso ${sufixo}`, [p]);
  const linha = (await listar({ q: `Sem uso ${sufixo}` })).rows[0];
  assert.equal(linha.uso_vinculado, 0);
  assert.equal(linha.uso_categorias, 0);
  assert.equal(linha.uso_vinculado_label, '', 'sem utilização: a tela mostra o traço, não um número');
  assert.equal(Number(semUso.id), Number(linha.id));

  // O detalhe (GET /grades/:id) carrega a MESMA anotação — a tela não recalcula.
  const detalhe = await getRecord(RESOURCES.grades, gid, empresaA);
  assert.equal(detalhe.uso_vinculado, 2);
  assert.equal(detalhe.uso_categorias, 1);
});

// ---------------------------------------------------------------------------
// H) Estado da tabela de medidas (mesma regra de completude do módulo)
// ---------------------------------------------------------------------------
test('a listagem informa o estado REAL da tabela de medidas: sem tabela → parcial → completa', async () => {
  const [p, m] = await tamanhos(['P', 'M']);
  const grade = await novaGrade(`Medidas ${sufixo}`, [p, m]);
  const gid = Number(grade.id);

  const semTabela = (await listar({ q: `Medidas ${sufixo}` })).rows[0];
  assert.equal(semTabela.medidas_status, 'sem_tabela');
  assert.equal(semTabela.medidas_colunas, 0);

  // Salva a tabela pelo MESMO endpoint do módulo de medidas (nada recriado).
  const { saveMedidasGrade, getMedidasGrade } = await import('../src/medidas');
  await chamar(
    saveMedidasGrade,
    reqDe(
      {
        medidas: [
          { nome: 'Largura (A)', unidade: 'cm' },
          { nome: 'Comprimento (B)', unidade: 'cm' },
        ],
        valores: [
          { medida_nome: 'Largura (A)', tamanho_id: p, valor: 50 },
          { medida_nome: 'Largura (A)', tamanho_id: m, valor: 52 },
          { medida_nome: 'Comprimento (B)', tamanho_id: p, valor: 68 },
        ],
      },
      { params: { id: String(gid) }, user: atorA }
    )
  );

  const parcial = (await listar({ q: `Medidas ${sufixo}` })).rows[0];
  assert.equal(parcial.medidas_status, 'parcial');
  assert.equal(parcial.medidas_colunas, 2);
  assert.equal(parcial.medidas_celulas_total, 4, '2 colunas × 2 tamanhos');
  assert.equal(parcial.medidas_celulas_preenchidas, 3);
  assert.equal(parcial.medidas_pct, 75);
  assert.ok(parcial.medidas_atualizada_em, 'a data da última alteração acompanha');

  await chamar(
    saveMedidasGrade,
    reqDe(
      {
        medidas: [
          { nome: 'Largura (A)', unidade: 'cm' },
          { nome: 'Comprimento (B)', unidade: 'cm' },
        ],
        valores: [
          { medida_nome: 'Largura (A)', tamanho_id: p, valor: 50 },
          { medida_nome: 'Largura (A)', tamanho_id: m, valor: 52 },
          { medida_nome: 'Comprimento (B)', tamanho_id: p, valor: 68 },
          { medida_nome: 'Comprimento (B)', tamanho_id: m, valor: 70 },
        ],
      },
      { params: { id: String(gid) }, user: atorA }
    )
  );
  const completa = (await listar({ q: `Medidas ${sufixo}` })).rows[0];
  assert.equal(completa.medidas_status, 'completa');
  assert.equal(completa.medidas_pct, 100);

  // O endpoint do painel de completude continua dizendo o mesmo (fonte única).
  const resumo = await chamar(getMedidasGrade, reqDe({}, { params: { id: String(gid) }, user: atorA }));
  assert.equal(resumo.resumo.celulas_total, 4);
  assert.equal(resumo.resumo.celulas_preenchidas, 4);
});

// ---------------------------------------------------------------------------
// I/P) Status: desativar não apaga nada
// ---------------------------------------------------------------------------
test('desativar a grade preserva tamanhos, medidas, produtos e histórico', async () => {
  const [p, m] = await tamanhos(['P', 'M']);
  const grade = await novaGrade(`Desativar ${sufixo}`, [p, m], { ativo: true });
  const gid = Number(grade.id);
  const produto = await createRecord(RESOURCES.produtos, { sku: `GR-DES-${sufixo}`, nome: `Produto desativar ${sufixo}`, grade_id: gid }, atorA);
  const { saveMedidasGrade } = await import('../src/medidas');
  await chamar(
    saveMedidasGrade,
    reqDe({ medidas: [{ nome: 'Largura (A)', unidade: 'cm' }], valores: [{ medida_nome: 'Largura (A)', tamanho_id: p, valor: 48 }] }, {
      params: { id: String(gid) },
      user: atorA,
    })
  );

  // É exatamente o que a ação "Desativar grade" da tela faz: PUT { ativo }.
  const desativada = await updateRecord(RESOURCES.grades, gid, { ativo: false }, atorA);
  assert.equal(desativada.ativo, false);

  assert.deepEqual(
    (await itensDaGrade(gid)).map((i) => i.tamanho_id),
    [p, m],
    'os tamanhos continuam gravados, na mesma ordem'
  );
  assert.equal(await s.countWhere(RESOURCES.medidas, { grade_id: gid }), 1, 'a tabela de medidas permanece');
  assert.equal(await s.countWhere(RESOURCES.produtos, { grade_id: gid }), 1, 'o produto permanece vinculado');
  assert.equal(Number((await getRecord(RESOURCES.produtos, Number(produto.id), empresaA)).grade_id), gid);

  // Reativar volta ao estado anterior sem perder nada.
  const reativada = await updateRecord(RESOURCES.grades, gid, { ativo: true }, atorA);
  assert.equal(reativada.ativo, true);
  assert.deepEqual(
    (await itensDaGrade(gid)).map((i) => i.tamanho_id),
    [p, m]
  );
});

// ---------------------------------------------------------------------------
// J/K) Exclusão: sem vínculos × com vínculos (diagnóstico real)
// ---------------------------------------------------------------------------
test('grade sem vínculos é excluída (e a composição vai junto)', async () => {
  const [p, m] = await tamanhos(['P', 'M']);
  const grade = await novaGrade(`Orfa ${sufixo}`, [p, m]);
  const gid = Number(grade.id);
  assert.equal((await itensDaGrade(gid)).length, 2);

  await deleteRecord(RESOURCES.grades, gid, atorA);
  await esperarErro(() => getRecord(RESOURCES.grades, gid, empresaA), 404);
  assert.equal((await itensDaGrade(gid)).length, 0, 'grade_tamanhos é composição da grade');
});

test('grade vinculada NÃO é excluída e devolve o diagnóstico completo', async () => {
  const [p, m] = await tamanhos(['P', 'M']);
  const grade = await novaGrade(`Vinculada ${sufixo}`, [p, m]);
  const gid = Number(grade.id);
  const p1 = await createRecord(RESOURCES.produtos, { sku: `GR-DEP1-${sufixo}`, nome: `Dependente 1 ${sufixo}`, grade_id: gid }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `GR-DEP2-${sufixo}`, nome: `Dependente 2 ${sufixo}`, grade_id: gid }, atorA);
  await createRecord(RESOURCES.categorias, { nome: `Categoria vinculada ${sufixo}`, grade_id: gid }, atorA);

  const erro: any = await esperarErro(() => deleteRecord(RESOURCES.grades, gid, atorA), 409);
  assert.equal(erro.code, 'dependencias_vinculadas', 'código estável que abre o "Ver vínculos" na tela');
  const diag = erro.details?.dependencias;
  assert.ok(diag, 'o diagnóstico vai em details.dependencias');
  assert.equal(diag.recurso, 'grades');
  assert.equal(diag.bloqueado, true);
  assert.equal(diag.podeExcluir, false);
  assert.match(diag.titulo, /Não é possível excluir Grade/);
  assert.deepEqual(diag.modulosBloqueantes.slice().sort(), ['Categorias', 'Produtos']);
  assert.match(diag.orientacao, /desative/i, 'a orientação recomenda desativar em vez de apagar');

  const produtos = diag.vinculos.find((v: any) => v.tabela === 'produtos');
  assert.equal(produtos.quantidade, 2);
  assert.deepEqual(produtos.colunas, ['grade_id']);
  assert.ok(produtos.ids.includes(Number(p1.id)), 'os ids dos produtos vinculados aparecem');
  assert.equal(produtos.bloqueia, true);

  const categorias = diag.vinculos.find((v: any) => v.tabela === 'categorias');
  assert.equal(categorias.quantidade, 1);
  assert.equal(categorias.bloqueia, true);

  // A composição aparece como informação, sem bloquear (política existente).
  const composicao = diag.vinculos.find((v: any) => v.tabela === 'grade_tamanhos');
  assert.equal(composicao.tipo, 'composicao');
  assert.equal(composicao.bloqueia, false);

  // Nada foi apagado.
  assert.equal(Number((await getRecord(RESOURCES.grades, gid, empresaA)).id), gid);
  assert.equal((await itensDaGrade(gid)).length, 2);
  assert.equal(await s.countWhere(RESOURCES.produtos, { grade_id: gid }), 2);
  assert.equal(await s.countWhere(RESOURCES.categorias, { grade_id: gid }), 1);
});

// ---------------------------------------------------------------------------
// L) RBAC — o servidor continua sendo a autoridade
// ---------------------------------------------------------------------------
test('RBAC: operador lê grades, mas o servidor recusa criar/alterar/excluir; gerente pode', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');
  const [p] = await tamanhos(['P']);

  // Leitura operacional continua aberta (selects de produtos, venda, estoque).
  assert.doesNotThrow(() => checkAccess(RESOURCES.grades, operador as any, 'read'));

  // A checagem acontece em `checkAccess` (chamada pela rota HTTP): é ela que o
  // espelho de `minPerfilEscrita` da tela reflete, nunca o contrário.
  for (const op of ['create', 'update', 'delete'] as const) {
    assert.throws(
      () => checkAccess(RESOURCES.grades, operador as any, op),
      (e: any) => e.status === 403 && /gerentes e administradores/i.test(String(e.message)),
      `operador não pode ${op}`
    );
  }

  const criada = await novaGrade(`Do gerente ${sufixo}`, [p], {}, gerente);
  const alterada = await updateRecord(RESOURCES.grades, Number(criada.id), { ativo: false }, gerente);
  assert.equal(alterada.ativo, false);
  await deleteRecord(RESOURCES.grades, Number(criada.id), gerente);
});

// ---------------------------------------------------------------------------
// MULTIEMPRESA — catálogo global, contagens isoladas
// ---------------------------------------------------------------------------
test('a grade é catálogo global: as duas empresas leem, mas cada uma vê o seu uso', async () => {
  const [p] = await tamanhos(['P']);
  const grade = await novaGrade(`Multiempresa ${sufixo}`, [p]);
  const gid = Number(grade.id);
  await createRecord(RESOURCES.produtos, { sku: `GR-ME-A-${sufixo}`, nome: `Produto ME A ${sufixo}`, grade_id: gid }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `GR-ME-B-${sufixo}`, nome: `Produto ME B ${sufixo}`, grade_id: gid }, atorB);

  // A grade existe para as duas (catálogo compartilhado, sem empresa_id).
  assert.equal(Number((await getRecord(RESOURCES.grades, gid, empresaA)).id), gid);
  assert.equal(Number((await getRecord(RESOURCES.grades, gid, empresaB)).id), gid);
  assert.equal((await listar({ q: `Multiempresa ${sufixo}` }, empresaA)).rows[0].uso_vinculado, 1);
  assert.equal((await listar({ q: `Multiempresa ${sufixo}` }, empresaB)).rows[0].uso_vinculado, 1);
});

// ---------------------------------------------------------------------------
// M) Não regressão de PRODUTOS (grade efetiva e ordem dos tamanhos)
// ---------------------------------------------------------------------------
test('produtos continuam resolvendo a grade efetiva e a ordem dos tamanhos', async () => {
  const [p, m, g] = await tamanhos(['P', 'M', 'G']);
  const grade = await novaGrade(`Grade produto ${sufixo}`, [g, m, p]);
  const gid = Number(grade.id);
  const categoria = await createRecord(RESOURCES.categorias, { nome: `Cat produto ${sufixo}`, grade_id: gid }, atorA);
  const produto = await createRecord(
    RESOURCES.produtos,
    { sku: `GR-PROD-${sufixo}`, nome: `Produto da grade ${sufixo}`, categoria_id: Number(categoria.id) },
    atorA
  );

  const { produtoTamanhos } = await import('../src/detail');
  const resposta = await chamar(produtoTamanhos, reqDe({}, { params: { id: String(produto.id) }, user: atorA }));
  assert.equal(resposta.grade.id, gid);
  assert.equal(resposta.grade.nome, `Grade produto ${sufixo}`);
  assert.deepEqual(
    resposta.tamanhos.map((t: any) => t.id),
    [g, m, p],
    'a ordem da grade é a ordem oferecida ao estoque/venda'
  );

  // A grade do produto sobrescreve a da categoria (regra existente preservada).
  const outra = await novaGrade(`Grade override ${sufixo}`, [p]);
  await updateRecord(RESOURCES.produtos, Number(produto.id), { grade_id: Number(outra.id) }, atorA);
  const sobrescrita = await chamar(produtoTamanhos, reqDe({}, { params: { id: String(produto.id) }, user: atorA }));
  assert.equal(sobrescrita.grade.id, Number(outra.id));
  assert.deepEqual(sobrescrita.tamanhos.map((t: any) => t.id), [p]);

  // E um tamanho fora da grade continua sendo recusado no estoque.
  const { validarTamanhoNaGrade } = await import('../src/services');
  await esperarErro(() => validarTamanhoNaGrade(Number(produto.id), m, undefined, empresaA), 400);
});

// ---------------------------------------------------------------------------
// N) Não regressão da TABELA DE MEDIDAS (resumo de todas as grades)
// ---------------------------------------------------------------------------
test('o resumo de completude continua devolvendo o mesmo contrato para todas as grades', async () => {
  const { resumoMedidasGrades } = await import('../src/medidas');
  const corpo = await chamar(resumoMedidasGrades, reqDe({}, { user: atorA }));
  assert.equal(typeof corpo.total, 'number');
  assert.ok(Array.isArray(corpo.grades) && corpo.grades.length > 0);
  const linha = corpo.grades.find((g: any) => String(g.nome).includes(`Medidas ${sufixo}`));
  assert.ok(linha, 'a grade deste arquivo está no resumo');
  for (const chave of ['id', 'nome', 'ativo', 'tamanhos', 'colunas', 'celulas_total', 'celulas_preenchidas', 'pct']) {
    assert.ok(chave in linha, `o campo "${chave}" continua no contrato`);
  }
  assert.equal(linha.tamanhos, 2);
  assert.equal(linha.colunas, 2);
  assert.equal(linha.celulas_total, 4);
  assert.equal(linha.pct, 100);

  // Grade sem tabela de medidas continua aparecendo (com zeros reais).
  const semTabela = corpo.grades.find((g: any) => String(g.nome).includes(`Sem uso ${sufixo}`));
  assert.ok(semTabela, 'todas as grades entram no resumo');
  assert.equal(semTabela.colunas, 0);
  assert.equal(semTabela.celulas_total, 0);
  assert.equal(semTabela.pct, 0);
});

// ---------------------------------------------------------------------------
// O) SEM N+1 — as consultas da listagem não crescem com o número de grades
// ---------------------------------------------------------------------------
test('a listagem de grades não faz uma consulta por grade (sem N+1)', async () => {
  const [p] = await tamanhos(['P']);
  for (let i = 0; i < 5; i += 1) await novaGrade(`N1 ${sufixo} ${i}`, [p]);

  // Conta as idas ao store durante UMA listagem (o modo demonstração usa o
  // MemStore; em PostgreSQL os mesmos métodos são os agregados do banco).
  async function contar(fn: () => Promise<unknown>) {
    const originais = {
      list: s.list.bind(s),
      countWhere: s.countWhere.bind(s),
      countGroupBy: s.countGroupBy.bind(s),
    };
    const contagem = { list: 0, countWhere: 0, countGroupBy: 0 };
    (s as any).list = async (...args: any[]) => {
      contagem.list += 1;
      return originais.list(...args);
    };
    (s as any).countWhere = async (...args: any[]) => {
      contagem.countWhere += 1;
      return originais.countWhere(...args);
    };
    (s as any).countGroupBy = async (...args: any[]) => {
      contagem.countGroupBy += 1;
      return originais.countGroupBy(...args);
    };
    try {
      await fn();
    } finally {
      (s as any).list = originais.list;
      (s as any).countWhere = originais.countWhere;
      (s as any).countGroupBy = originais.countGroupBy;
    }
    return contagem;
  }

  const uma = await contar(() => listRecords(RESOURCES.grades, { page: 1, pageSize: 1, q: `N1 ${sufixo}` }, empresaA));
  const cinco = await contar(() => listRecords(RESOURCES.grades, { page: 1, pageSize: 5, q: `N1 ${sufixo}` }, empresaA));

  assert.equal(cinco.list, uma.list, 'o número de leituras não depende da quantidade de linhas');
  assert.equal(cinco.countWhere, uma.countWhere, 'nenhum countWhere por linha');
  assert.equal(cinco.countGroupBy, uma.countGroupBy, 'contagem de uso agrupada (uma por empresa/recurso)');
  assert.ok(cinco.countGroupBy >= 2, 'produtos + categorias em lote');
  assert.equal(cinco.countWhere, 0, 'a utilização não usa mais contagem por registro');
});
