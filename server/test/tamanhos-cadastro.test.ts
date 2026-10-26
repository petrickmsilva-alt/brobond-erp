// ============================================================================
// CADASTROS › TAMANHOS — contrato do padrão profissional (memória).
//
// O módulo continua sendo o CRUD genérico dirigido por `resources.ts`. Esta
// entrega é EXCLUSIVAMENTE de UX/arquitetura de cadastro: Tamanhos saiu do modal
// central (LISTA → MODAL) e passou ao padrão canônico LISTA → PÁGINA
// (`/tamanhos/novo`, `/tamanhos/:id/editar` — ver client/src/modules.ts ›
// FORM_DIRETO e TamanhoFormPage.tsx).
//
// Este arquivo trava o que NÃO pode mudar com essa migração:
//   • metadado real do recurso (SEM campo inventado): codigo, descricao, ordem;
//   • `codigo` é único e obrigatório; `ordem` é a sequência da grade;
//   • a listagem é ordenada por `ordem` (preservado);
//   • busca no servidor por código e descrição (mesma listagem paginada);
//   • RBAC preservado: catálogo COMPARTILHADO (minPerfilEscrita gerente+);
//   • exclusão: tamanho em uso no estoque devolve o diagnóstico (409 +
//     dependencias_vinculadas) e NÃO é apagado; tamanho sem uso é excluído;
//   • Grades, Produtos e Tabela de Medidas continuam usando os tamanhos pelo
//     contrato existente.
//
// A variante contra PostgreSQL real (FKs e CASCADE) fica no gate PG.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { ADMIN, criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');

await garantirAdmin();
const empresaA = escopoDeSistema(1);
const atorA = await criarAtor(1, 'admin');

const sufixo = `${Date.now() % 1000000}`;

async function novoTamanho(codigo: string, extra: Record<string, unknown> = {}, ator: any = atorA) {
  return createRecord(RESOURCES.tamanhos, { codigo, ...extra }, ator);
}

/** Lista só os tamanhos deste arquivo (o modo demonstração já tem o dicionário). */
async function listar(p: { q?: string; filter?: Record<string, unknown>; page?: number; pageSize?: number } = {}) {
  const res = await listRecords(RESOURCES.tamanhos, { page: 1, pageSize: 500, ...p }, empresaA);
  const rows = res.rows.filter((r) => String(r.codigo).includes(sufixo));
  return { ...res, rows };
}

// ---------------------------------------------------------------------------
// A) Metadado real do recurso — nenhum campo inventado, nenhuma superfície
// ---------------------------------------------------------------------------
test('cadastro declara o padrão LISTA → PÁGINA (sem drawer/modal) e os campos REAIS', () => {
  const r = RESOURCES.tamanhos;
  // O BROBOND ERP não usa formulário sobreposto: a inclusão/edição é a página
  // /tamanhos/novo e /tamanhos/:id/editar. O metadado não oferece superfície de
  // drawer nem de modal — a rota vive em client/src/modules.ts › FORM_DIRETO.
  assert.equal('editor' in r, false, 'Tamanhos não declara drawer/modal: o formulário é página');

  // Campos EXATAMENTE como o domínio sempre teve (nada de "ativo" inventado).
  const nomes = r.fields.map((f) => f.name);
  assert.deepEqual(nomes, ['codigo', 'descricao', 'ordem', 'criado_em', 'atualizado_em']);

  const codigo = r.fields.find((f) => f.name === 'codigo')!;
  assert.equal(codigo.type, 'text');
  assert.equal(codigo.required, true, 'código é obrigatório');
  assert.equal(codigo.unique, true, 'código é único');
  assert.equal(codigo.search, true, 'a busca alcança o código');
  assert.equal(codigo.maxLength, 10);

  const descricao = r.fields.find((f) => f.name === 'descricao')!;
  assert.equal(descricao.required, undefined, 'descrição continua OPCIONAL');
  assert.equal(descricao.search, true, 'a busca alcança a descrição');

  const ordem = r.fields.find((f) => f.name === 'ordem')!;
  assert.equal(ordem.type, 'integer');
  assert.equal(ordem.min, 0);
  assert.equal(ordem.default, 0);

  // Ordenação preservada: a lista do dicionário segue a sequência da grade.
  assert.deepEqual(r.orderBy, { field: 'ordem', dir: 'asc' });

  // RBAC do catálogo compartilhado não mudou.
  assert.equal(r.minPerfilEscrita, 'gerente');
});

// ---------------------------------------------------------------------------
// B) Código: trim, único e a MESMA regra de duplicidade do ERP
// ---------------------------------------------------------------------------
test('código é aparado, obrigatório e a duplicidade reaproveita a regra existente', async () => {
  const criado = await novoTamanho(`  X${sufixo}  `, { descricao: 'Teste', ordem: 7 });
  assert.equal(criado.codigo, `X${sufixo}`, 'espaços sobrando não são gravados');
  assert.equal(criado.ordem, 7);

  await esperarErro(() => novoTamanho(`X${sufixo}`), 409, /já existe/i);

  // Código vazio é recusado pelo servidor (a autoridade final do contrato).
  await esperarErro(() => novoTamanho('   '), 400, /obrigat/i);

  const todos = await listar({ q: `X${sufixo}` });
  assert.equal(todos.rows.length, 1, 'a tentativa duplicada não criou registro');
});

// ---------------------------------------------------------------------------
// C) Busca no SERVIDOR, na mesma listagem paginada e na ordem da grade
// ---------------------------------------------------------------------------
test('busca encontra o tamanho por código e por descrição, na ordem da grade', async () => {
  await novoTamanho(`A${sufixo}`, { descricao: 'Extra pequeno', ordem: 1 });
  await novoTamanho(`B${sufixo}`, { descricao: 'Extra grande', ordem: 5 });
  await novoTamanho(`C${sufixo}`, { descricao: 'Pequeno', ordem: 2 });

  const porDescricao = await listar({ q: `Extra` });
  assert.deepEqual(
    porDescricao.rows.map((r) => r.codigo).sort(),
    [`A${sufixo}`, `B${sufixo}`],
    '"Extra" encontra os dois tamanhos com essa palavra na descrição'
  );

  const porCodigo = await listar({ q: `C${sufixo}` });
  assert.deepEqual(porCodigo.rows.map((r) => r.codigo), [`C${sufixo}`]);

  // A ordenação padrão é por `ordem` (preservada — a UI não reordena nada).
  const todos = await listar();
  const ordens = todos.rows.map((r) => Number(r.ordem));
  assert.deepEqual(ordens, [...ordens].sort((a, b) => a - b), 'a lista sai ordenada por `ordem`');
});

// ---------------------------------------------------------------------------
// D) RBAC: guard do servidor (catálogo compartilhado, escrita gerente+)
// ---------------------------------------------------------------------------
test('RBAC: operador lê, mas o servidor recusa incluir/alterar/excluir; gerente pode', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');

  // Leitura operacional continua aberta (selects de Produtos, estoque, venda).
  assert.doesNotThrow(() => checkAccess(RESOURCES.tamanhos, operador as any, 'read'));

  // Mesma guarda usada pelas rotas POST/PUT/DELETE do CRUD genérico.
  for (const op of ['create', 'update', 'delete'] as const) {
    assert.throws(
      () => checkAccess(RESOURCES.tamanhos, operador as any, op),
      (e: any) => e.status === 403 && /gerentes e administradores/i.test(String(e.message)),
      `operador não pode ${op}`
    );
  }
  assert.doesNotThrow(() => checkAccess(RESOURCES.tamanhos, gerente as any, 'create'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.tamanhos, gerente as any, 'update'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.tamanhos, gerente as any, 'delete'));

  // O cadastro segue funcionando para quem tem o piso (gerente+).
  const criado = await novoTamanho(`G${sufixo}`, { ordem: 3 }, gerente);
  const alterado = await updateRecord(RESOURCES.tamanhos, Number(criado.id), { descricao: 'Editado' }, gerente);
  assert.equal(alterado.descricao, 'Editado');
});

// ---------------------------------------------------------------------------
// E) Exclusão: diagnóstico de vínculos × fluxo normal
// ---------------------------------------------------------------------------
test('tamanho em uso no estoque NÃO é excluído e devolve o diagnóstico completo', async () => {
  const tamanho = await novoTamanho(`U${sufixo}`, { ordem: 4 });
  const produto = await createRecord(
    RESOURCES.produtos,
    { sku: `TAM-USO-${sufixo}`, nome: `Produto uso ${sufixo}`, custo: 1, preco_venda: 2 },
    atorA
  );
  // Uma movimentação de estoque referencia o tamanho (FK NO ACTION): é o
  // vínculo REAL que impede a exclusão no domínio de Tamanhos.
  await createRecord(
    RESOURCES.movimentacoes,
    { tipo: 'entrada', produto_id: Number(produto.id), tamanho_id: Number(tamanho.id), quantidade: 5 },
    atorA
  );

  const erro: any = await esperarErro(() => deleteRecord(RESOURCES.tamanhos, Number(tamanho.id), atorA), 409, /vinculad/i);
  assert.equal(erro.code, 'dependencias_vinculadas', 'código estável que abre o diagnóstico na tela');
  const diag = erro.details?.dependencias;
  assert.ok(diag, 'o diagnóstico vai em details.dependencias');
  assert.equal(diag.bloqueado, true);
  assert.equal(diag.podeExcluir, false);
  assert.ok(diag.modulosBloqueantes.includes('Estoque'), 'o vínculo de estoque é apontado');

  // Nada foi apagado: o tamanho continua lá.
  assert.equal(Number((await getRecord(RESOURCES.tamanhos, Number(tamanho.id), empresaA)).id), Number(tamanho.id));
});

test('tamanho sem vínculo segue o fluxo normal de exclusão', async () => {
  const tamanho = await novoTamanho(`L${sufixo}`, { ordem: 6 });
  await deleteRecord(RESOURCES.tamanhos, Number(tamanho.id), atorA);
  await esperarErro(() => getRecord(RESOURCES.tamanhos, Number(tamanho.id), empresaA), 404);
});

// ---------------------------------------------------------------------------
// F) Uso por Grades / Produtos / Tabela de Medidas (contrato preservado)
// ---------------------------------------------------------------------------
test('Grades continuam compostas pelos tamanhos do dicionário (ordem preservada)', async () => {
  const t1 = await novoTamanho(`M1${sufixo}`, { ordem: 1 });
  const t2 = await novoTamanho(`M2${sufixo}`, { ordem: 2 });
  // `grades.tamanhos` é o multiref virtual que o CRUD genérico usa na criação.
  const grade = await createRecord(
    RESOURCES.grades,
    { nome: `Grade TAM ${sufixo}`, tamanhos: [Number(t1.id), Number(t2.id)] },
    atorA
  );

  const itens = (
    await getStore().list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 100, filter: { grade_id: Number(grade.id) }, sort: 'ordem', dir: 'asc' })
  ).rows;
  assert.deepEqual(itens.map((i) => Number(i.tamanho_id)), [Number(t1.id), Number(t2.id)]);

  // As opções do seletor de tamanho continuam disponíveis (telas operacionais).
  const opcoes = await getStore().options(RESOURCES.tamanhos);
  assert.ok(opcoes.some((o) => Number(o.value) === Number(t1.id)));
});

test('Tabela de Medidas continua aceitando valores por tamanho do dicionário', async () => {
  const tamanho = await novoTamanho(`V${sufixo}`, { ordem: 9 });
  const grade = await createRecord(RESOURCES.grades, { nome: `Grade MED ${sufixo}`, tamanhos: [Number(tamanho.id)] }, atorA);
  const medida = await createRecord(RESOURCES.medidas, { grade_id: Number(grade.id), nome: `Largura ${sufixo}` }, atorA);

  const valor = await createRecord(
    RESOURCES.medida_valores,
    { medida_id: Number(medida.id), tamanho_id: Number(tamanho.id), valor: '54' },
    atorA
  );
  assert.equal(Number(valor.tamanho_id), Number(tamanho.id));
});

test('o endpoint /tamanhos/options continua servindo as telas operacionais', async () => {
  const tamanho = await novoTamanho(`O${sufixo}`, { ordem: 8 });
  const opcoes = await getStore().options(RESOURCES.tamanhos);
  assert.ok(opcoes.some((o) => Number(o.value) === Number(tamanho.id)), 'o tamanho recém-criado aparece nas opções');
  assert.ok(opcoes.length > 0);
});

// ADMIN é usado para garantir que o usuário de teste existe (FKs de auditoria).
test('o ator de auditoria existe (criado_por válido)', () => {
  assert.equal(typeof ADMIN.id, 'number');
});
