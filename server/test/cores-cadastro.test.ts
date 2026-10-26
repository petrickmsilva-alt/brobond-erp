// ============================================================================
// CADASTROS › CORES — contrato do padrão profissional (memória).
//
// O módulo continua sendo o CRUD genérico dirigido por `resources.ts`. O que
// este arquivo trava é o contrato que a tela usa:
//   • metadado do padrão simples (SEM drawer/modal, filtro de status, uso);
//   • HEX opcional, normalizado e recusado quando inválido;
//   • busca por nome e por HEX na MESMA listagem paginada (sem SQL paralelo);
//   • filtro `f.ativo` (o recorte Todas/Ativas/Inativas da tela);
//   • coluna "Utilização" = contagem REAL, recortada pela empresa ativa;
//   • RBAC preservado no servidor: operador lê, mas não inclui/altera/exclui;
//   • exclusão: cor vinculada devolve o diagnóstico de vínculos (PR #83) e a
//     cor permanece; cor sem vínculo segue o fluxo normal;
//   • Produtos continuam selecionando cores e gerando variações Produto+Cor+Tamanho.
//
// A variante contra PostgreSQL real fica em test/pg/cores-pg.test.ts.
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
const empresaB = escopoDeSistema(2);
const atorA = await criarAtor(1, 'admin');
const atorB = await criarAtor(2, 'admin');

const sufixo = `${Date.now() % 1000000}`;

async function novaCor(nome: string, hex?: string | null, extra: Record<string, unknown> = {}, ator: any = atorA) {
  return createRecord(RESOURCES.cores, { nome, ...(hex === undefined ? {} : { hex }), ...extra }, ator);
}

/** Lista só as cores deste arquivo (o modo demonstração já tem uma cartela). */
async function listar(p: { q?: string; filter?: Record<string, unknown>; page?: number; pageSize?: number }, escopo = empresaA) {
  const res = await listRecords(RESOURCES.cores, { page: 1, pageSize: 500, ...p }, escopo);
  const rows = res.rows.filter((r) => String(r.nome).includes(sufixo));
  return { ...res, rows };
}

// ---------------------------------------------------------------------------
// A) Metadado do padrão simples (fonte única de verdade)
// ---------------------------------------------------------------------------
test('cadastro declara o padrão LISTA → PÁGINA (sem drawer/modal), filtro de status e uso real', () => {
  const r = RESOURCES.cores;
  // O BROBOND ERP não usa formulário sobreposto: a inclusão/edição é a página
  // /cores/novo e /cores/:id/editar. O metadado não oferece superfície de
  // drawer nem de modal — a rota vive em client/src/modules.ts › FORM_DIRETO.
  assert.equal('editor' in r, false, 'Cores não declara drawer/modal: o formulário é página');
  assert.deepEqual(r.filterFields, ['ativo']);
  assert.equal(r.quickFilters?.[0]?.field, 'ativo');
  assert.deepEqual(
    r.quickFilters?.[0]?.options.map((o) => o.label),
    ['Todas', 'Ativas', 'Inativas']
  );
  assert.deepEqual(r.uso, { recurso: 'produtos', campo: 'cor_id', singular: 'produto', plural: 'produtos' });
  // O formulário continua vindo dos metadados: nenhum campo novo, nenhuma
  // obrigatoriedade nova (o HEX segue opcional).
  const hex = r.fields.find((f) => f.name === 'hex');
  assert.equal(hex?.type, 'color');
  assert.equal(hex?.required, undefined, 'HEX continua OPCIONAL (contrato e dados existentes)');
  assert.equal(hex?.search, true, 'a busca da listagem alcança o HEX');
  // RBAC do catálogo compartilhado não mudou.
  assert.equal(r.minPerfilEscrita, 'gerente');
});

// ---------------------------------------------------------------------------
// E/F/G) HEX: opcional, canônico e inválido recusado antes do banco
// ---------------------------------------------------------------------------
test('HEX é opcional, normalizado para #RRGGBB e inválido vira erro de campo', async () => {
  const semHex = await novaCor(`Sem hex ${sufixo}`);
  assert.equal(semHex.hex, null, 'salvar sem HEX continua permitido');

  const minusculo = await novaCor(`Curto ${sufixo}`, 'abc');
  assert.equal(minusculo.hex, '#AABBCC', 'forma curta expandida e em maiúsculas');

  const semCerquilha = await novaCor(`Sem cerquilha ${sufixo}`, '172038');
  assert.equal(semCerquilha.hex, '#172038');

  const erro: any = await esperarErro(() => novaCor(`Inválida ${sufixo}`, '#12'), 400, /hexadecimal/i);
  assert.equal(erro.fields?.hex, 'Informe a cor em hexadecimal (ex.: #1F3A5F)', 'erro no campo hex');
});

// ---------------------------------------------------------------------------
// NOME: trim e a MESMA regra de duplicidade do ERP (nenhuma regra paralela)
// ---------------------------------------------------------------------------
test('nome é aparado e a duplicidade reaproveita a regra existente', async () => {
  const criada = await novaCor(`  Duplicada ${sufixo}  `);
  assert.equal(criada.nome, `Duplicada ${sufixo}`, 'espaços sobrando não são gravados');

  const erro: any = await esperarErro(
    () => novaCor(`DUPLICADA ${sufixo}`),
    409,
    /Já existe um registro com este nome/i
  );
  assert.equal(erro.fields?.nome, 'Já cadastrado', 'o erro aponta o campo, como nos demais cadastros');

  const todas = await listar({ q: `Duplicada ${sufixo}` });
  assert.equal(todas.rows.length, 1, 'a tentativa duplicada não criou registro');
});

// ---------------------------------------------------------------------------
// B/C) Busca e filtro no SERVIDOR, na mesma listagem paginada
// ---------------------------------------------------------------------------
test('busca encontra a cor pelo nome (parcial, sem caixa) e pelo HEX', async () => {
  await novaCor(`Azul Marinho ${sufixo}`, '#1A2B3C');
  await novaCor(`Azul Royal ${sufixo}`, '#1D4ED8');
  await novaCor(`Preto ${sufixo}`, '#000000');
  await novaCor(`Off-white ${sufixo}`, '#F5F5F0');

  const azuis = await listar({ q: 'azul' });
  assert.deepEqual(
    azuis.rows.map((r) => r.nome).sort(),
    [`Azul Marinho ${sufixo}`, `Azul Royal ${sufixo}`],
    '"azul" encontra todas as cores azuis do cadastro'
  );

  const porHex = await listar({ q: '1A2B3C' });
  assert.deepEqual(porHex.rows.map((r) => r.nome), [`Azul Marinho ${sufixo}`]);

  const porHexParcial = await listar({ q: 'F5F5' });
  assert.deepEqual(porHexParcial.rows.map((r) => r.nome), [`Off-white ${sufixo}`]);
});

test('filtro de status separa ativas de inativas (contrato f.ativo)', async () => {
  await novaCor(`Ativa ${sufixo}`, '#111111', { ativo: true });
  await novaCor(`Inativa ${sufixo}`, '#222222', { ativo: false });

  const ativas = await listar({ filter: { ativo: 'true' } });
  const inativas = await listar({ filter: { ativo: 'false' } });

  assert.ok(ativas.rows.length > 0);
  assert.ok(ativas.rows.every((r) => r.ativo !== false), 'Ativas não traz inativa');
  assert.deepEqual(inativas.rows.map((r) => r.nome), [`Inativa ${sufixo}`]);
  // "Todas" = sem recorte: as duas aparecem.
  const todas = await listar({});
  assert.ok(todas.rows.some((r) => r.nome === `Ativa ${sufixo}`));
  assert.ok(todas.rows.some((r) => r.nome === `Inativa ${sufixo}`));
});

// ---------------------------------------------------------------------------
// P) UTILIZAÇÃO: contagem real e multiempresa preservada
// ---------------------------------------------------------------------------
test('utilização conta os produtos da empresa ativa — nunca número inventado', async () => {
  const cor = await novaCor(`Cor uso ${sufixo}`, '#0F172A');
  await createRecord(RESOURCES.produtos, { sku: `USO-A1-${sufixo}`, nome: `Produto A1 ${sufixo}`, cor_id: Number(cor.id) }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `USO-A2-${sufixo}`, nome: `Produto A2 ${sufixo}`, cor_id: Number(cor.id) }, atorA);
  // Produto da empresa B com a MESMA cor (catálogo é global) — não entra na
  // contagem de A nem vaza para a tela de A.
  await createRecord(RESOURCES.produtos, { sku: `USO-B1-${sufixo}`, nome: `Produto B1 ${sufixo}`, cor_id: Number(cor.id), empresa_id: 2 }, atorB);

  const daA = (await listar({ q: `Cor uso ${sufixo}` }, empresaA)).rows[0];
  assert.equal(daA.uso_vinculado, 2, 'só os produtos da empresa ativa');
  assert.equal(daA.uso_vinculado_label, '2 produtos');

  const daB = (await listar({ q: `Cor uso ${sufixo}` }, empresaB)).rows[0];
  assert.equal(daB.uso_vinculado, 1, 'a contagem da empresa B é a dela');
  assert.equal(daB.uso_vinculado_label, '1 produto');

  const semUso = await novaCor(`Cor sem uso ${sufixo}`, '#334155');
  const linha = (await listar({ q: `Cor sem uso ${sufixo}` })).rows[0];
  assert.equal(linha.uso_vinculado, 0);
  assert.equal(linha.uso_vinculado_label, '0 produtos');
  assert.equal(Number(semUso.id), Number(linha.id));

  // O detalhe (GET) carrega a MESMA contagem — a tela não recalcula nada.
  const detalhe = await getRecord(RESOURCES.cores, Number(cor.id), empresaA);
  assert.equal(detalhe.uso_vinculado, 2);
});

// ---------------------------------------------------------------------------
// J/K) RBAC: guard do servidor + rotas do CRUD genérico
// ---------------------------------------------------------------------------
test('RBAC: operador lê, mas o servidor recusa incluir/alterar/excluir; gerente pode', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');

  // Leitura operacional continua aberta (selects de Produtos, venda, estoque).
  assert.doesNotThrow(() => checkAccess(RESOURCES.cores, operador as any, 'read'));

  // Mesma guarda usada pelas rotas POST/PUT/DELETE do CRUD genérico.
  for (const op of ['create', 'update', 'delete'] as const) {
    assert.throws(
      () => checkAccess(RESOURCES.cores, operador as any, op),
      (e: any) => e.status === 403 && /gerentes e administradores/i.test(String(e.message)),
      `operador não pode ${op}`
    );
  }
  assert.doesNotThrow(() => checkAccess(RESOURCES.cores, gerente as any, 'create'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.cores, gerente as any, 'update'));
  assert.doesNotThrow(() => checkAccess(RESOURCES.cores, gerente as any, 'delete'));

  // O cadastro segue funcionando para quem tem o piso (gerente+).
  const criada = await novaCor(`Do gerente ${sufixo}`, '#7C3AED', {}, gerente);
  const alterada = await updateRecord(RESOURCES.cores, Number(criada.id), { ativo: false }, gerente);
  assert.equal(alterada.ativo, false);
});

// ---------------------------------------------------------------------------
// I) Status preservado na edição
// ---------------------------------------------------------------------------
test('editar preserva o status atual quando o payload não o altera', async () => {
  const ativa = await novaCor(`Status ativo ${sufixo}`, '#16A34A', { ativo: true });
  const inativa = await novaCor(`Status inativo ${sufixo}`, '#B91C1C', { ativo: false });

  const e1 = await updateRecord(RESOURCES.cores, Number(ativa.id), { nome: `Status ativo editado ${sufixo}` }, atorA);
  assert.equal(e1.ativo, true);
  const e2 = await updateRecord(RESOURCES.cores, Number(inativa.id), { nome: `Status inativo editado ${sufixo}` }, atorA);
  assert.equal(e2.ativo, false, 'editar não reativa um cadastro inativo por acidente');
});

// ---------------------------------------------------------------------------
// L/M) Exclusão: diagnóstico de vínculos × fluxo normal
// ---------------------------------------------------------------------------
test('cor vinculada NÃO é excluída e devolve o diagnóstico completo', async () => {
  const cor = await novaCor(`Cor vinculada ${sufixo}`, '#1F2937');
  const p1 = await createRecord(RESOURCES.produtos, { sku: `DEP-1-${sufixo}`, nome: `Dependente 1 ${sufixo}`, cor_id: Number(cor.id) }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `DEP-2-${sufixo}`, nome: `Dependente 2 ${sufixo}`, cor_id: Number(cor.id) }, atorA);

  const erro: any = await esperarErro(() => deleteRecord(RESOURCES.cores, Number(cor.id), atorA), 409, /vinculad/i);
  assert.equal(erro.code, 'dependencias_vinculadas', 'código estável que abre o modal na tela');
  const diag = erro.details?.dependencias;
  assert.ok(diag, 'o diagnóstico vai em details.dependencias');
  assert.equal(diag.bloqueado, true);
  assert.equal(diag.podeExcluir, false);
  assert.deepEqual(diag.modulosBloqueantes, ['Produtos']);
  const vinculo = diag.vinculos.find((v: any) => v.tabela === 'produtos');
  assert.equal(vinculo.quantidade, 2);
  assert.deepEqual(vinculo.colunas, ['cor_id']);
  assert.ok(vinculo.ids.includes(Number(p1.id)), 'os ids dos produtos que usam a cor aparecem no diagnóstico');
  assert.match(vinculo.motivo, /banco recusa a exclusão|vínculo ativo/i);
  assert.match(diag.orientacao, /desative/i, 'a orientação recomenda desativar');

  // Nada foi apagado: a cor e os produtos continuam lá.
  assert.equal(Number((await getRecord(RESOURCES.cores, Number(cor.id), empresaA)).id), Number(cor.id));
  assert.equal(await getStore().countWhere(RESOURCES.produtos, { cor_id: Number(cor.id) }), 2);
});

test('cor sem vínculo segue o fluxo normal de exclusão', async () => {
  const cor = await novaCor(`Cor órfã ${sufixo}`, '#94A3B8');
  await deleteRecord(RESOURCES.cores, Number(cor.id), atorA);
  await esperarErro(() => getRecord(RESOURCES.cores, Number(cor.id), empresaA), 404);
});

// ---------------------------------------------------------------------------
// N) Produtos: a seleção de cor continua pelo contrato existente
// ---------------------------------------------------------------------------
test('Produtos continuam listando a cor do cadastro (rótulo + amostra do HEX)', async () => {
  const cor = await novaCor(`Cor produto ${sufixo}`, '#172038');
  const produto = await createRecord(
    RESOURCES.produtos,
    { sku: `PROD-COR-${sufixo}`, nome: `Produto com cor ${sufixo}`, cor_id: Number(cor.id) },
    atorA
  );

  const lista = await listRecords(RESOURCES.produtos, { page: 1, pageSize: 500, q: `PROD-COR-${sufixo}` }, empresaA);
  const linha = lista.rows.find((r) => Number(r.id) === Number(produto.id));
  assert.ok(linha, 'o produto aparece na listagem');
  assert.equal(linha!.cor_id__label, `Cor produto ${sufixo}`, 'rótulo da cor vem do cadastro');
  assert.equal(linha!.cor_id__color, '#172038', 'a amostra do produto vem do HEX do cadastro');

  // As opções do seletor de cor seguem disponíveis (tela operacional).
  const opcoes = await getStore().options(RESOURCES.cores);
  assert.ok(opcoes.some((o) => Number(o.value) === Number(cor.id) && o.label.includes(`Cor produto ${sufixo}`)));
});

// ---------------------------------------------------------------------------
// O) Variações Produto + Cor + Tamanho não foram afetadas
// ---------------------------------------------------------------------------
test('variações Produto + Cor + Tamanho continuam sendo geradas a partir da cor', async () => {
  const { combinar, fatiaSku } = await import('../src/variacoes');
  const cor = await novaCor(`Azul Variação ${sufixo}`, '#0033AA');
  const tamanhos = await Promise.all(
    ['P', 'M'].map(async (codigo, i) => {
      const achado = await getStore().findOneWhere(RESOURCES.tamanhos, { codigo });
      return achado ?? createRecord(RESOURCES.tamanhos, { codigo, ordem: i + 1 }, atorA);
    })
  );

  // A combinação é a MESMA função pura usada pela geração de variações.
  const combinacoes = combinar(
    { sku: `VAR-${sufixo}`, nome: `Camisa Variação ${sufixo}` },
    [{ id: Number(cor.id), nome: String(cor.nome) }],
    tamanhos.map((t) => ({ id: Number(t.id), codigo: String(t.codigo) }))
  );
  const corSku = fatiaSku(String(cor.nome));
  assert.equal(combinacoes.length, 2);
  assert.deepEqual(combinacoes.map((c) => c.sku), [`VAR-${sufixo}-${corSku}-P`, `VAR-${sufixo}-${corSku}-M`]);

  // E o produto+cor salvos continuam aceitos pelo contrato (mesma FK de antes).
  const pai = await createRecord(
    RESOURCES.produtos,
    { sku: `VAR-${sufixo}`, nome: `Camisa Variação ${sufixo}`, cor_id: Number(cor.id), formato: 'variacao' },
    atorA
  );
  assert.equal(Number(pai.cor_id), Number(cor.id));
});
