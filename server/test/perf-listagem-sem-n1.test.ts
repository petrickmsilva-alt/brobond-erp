// ============================================================================
// PERF-03 / PERF-04 — LISTAGEM SEM N+1 E COM ANOTAÇÕES PARALELAS.
//
// Estes testes existem para impedir a REGRESSÃO silenciosa de duas correções
// que não mudam contrato nenhum (a resposta é a mesma de antes):
//
//   PERF-03 — `anotarUsoLocal` fazia 5 consultas POR LOCAL da página
//             (4 contagens + a contagem de ativos). Numa página de 10 locais
//             eram 50 idas ao banco. Agora o número de consultas de agregação
//             é CONSTANTE (4 por página), independente do número de linhas.
//   PERF-04 — as anotações independentes de `listRecords` rodam em paralelo.
//             A regra de negócio que dependia da ordem (`anotarGrades` lê
//             `uso_vinculado`) continua respeitada.
//
// O que se prova aqui é CORRETUDE (números idênticos aos de antes) e CUSTO
// (contagem de consultas que não cresce com o número de linhas).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { listRecords, createRecord, getStore, usoDoLocal } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = await criarAtor(1, 'admin');
const escopo = escopoDeSistema(1);
const sufixo = `${Date.now() % 1000000}`;

test('uso de local: números corretos com UMA agregação por tabela (sem N+1)', async () => {
  const produtos = RESOURCES.produtos;
  const produto = await createRecord(
    produtos,
    { sku: `N1-${sufixo}`, nome: `Produto N1 ${sufixo}`, preco_venda: 10 },
    admin
  );

  // Três locais: um com vínculos, um sem vínculos, e um que será o "único ativo".
  const locais = [];
  for (const nome of [`L1-${sufixo}`, `L2-${sufixo}`, `L3-${sufixo}`]) {
    locais.push(await createRecord(RESOURCES.locais, { nome, ativo: true }, admin));
  }
  const [comVinculo] = locais;

  // Vínculos do primeiro local: 1 saldo de estoque + 1 movimentação + 1 inventário.
  await createRecord(
    RESOURCES.estoques,
    { produto_id: Number(produto.id), local_id: Number(comVinculo.id), quantidade: 5 },
    admin
  );
  await createRecord(
    RESOURCES.movimentacoes,
    {
      produto_id: Number(produto.id),
      local_id: Number(comVinculo.id),
      tipo: 'entrada',
      quantidade: 5,
      data: new Date().toISOString().slice(0, 10),
    },
    admin
  );
  await createRecord(RESOURCES.inventarios, { local_id: Number(comVinculo.id), status: 'aberto' }, admin).catch(
    async () => {
      // Alguns campos obrigatórios variam por versão do recurso; o teste não é
      // sobre inventário — se o cadastro exigir mais dados, segue sem ele.
      return null;
    }
  );

  // Conta quantas agregações por página o serviço dispara.
  const store = getStore() as any;
  const originalCountByColumn = store.countByColumn;
  const originalCountWhere = store.countWhere;
  let agregacoes = 0;
  let contagensWhere = 0;
  store.countByColumn = function (...args: any[]) {
    agregacoes++;
    return originalCountByColumn.apply(this, args);
  };
  store.countWhere = function (...args: any[]) {
    contagensWhere++;
    return originalCountWhere.apply(this, args);
  };

  let linhas: any[];
  try {
    const res = await listRecords(RESOURCES.locais, { page: 1, pageSize: 100 }, escopo);
    linhas = res.rows.filter((r: any) => String(r.nome).includes(sufixo));
  } finally {
    store.countByColumn = originalCountByColumn;
    store.countWhere = originalCountWhere;
  }

  assert.equal(linhas.length, 3, 'os três locais criados devem aparecer');

  // CORRETUDE: os mesmos números que `usoDoLocal` produz linha a linha.
  for (const linha of linhas) {
    const referencia = await usoDoLocal(linha);
    assert.equal(linha.uso_saldos, referencia.saldos, `saldos de ${linha.nome}`);
    assert.equal(linha.uso_movimentacoes, referencia.movimentacoes, `movimentações de ${linha.nome}`);
    assert.equal(linha.uso_inventarios, referencia.inventarios, `inventários de ${linha.nome}`);
    assert.equal(linha.em_uso, referencia.emUso, `em_uso de ${linha.nome}`);
  }

  const doPrimeiro = linhas.find((l) => Number(l.id) === Number(comVinculo.id))!;
  assert.equal(doPrimeiro.uso_saldos, 1);
  // `movimentacoes` pode registrar origem E destino local no mesmo lançamento;
  // o que importa aqui é que a contagem venha da agregação e não seja zero.
  assert.ok(Number(doPrimeiro.uso_movimentacoes) >= 1, 'a movimentação criada deve ser contada');
  assert.equal(doPrimeiro.em_uso, true);

  // CUSTO: agregações constantes (4 por página), não 4 por linha.
  // Sem a correção seriam >= 4 * linhas.length (=12) só em `countByColumn`.
  assert.ok(
    agregacoes <= 4,
    `esperava no máximo 4 agregações por página, houve ${agregacoes} (N+1 de volta?)`
  );
  assert.ok(agregacoes < 4 * linhas.length, 'o custo não pode crescer com o número de linhas');
  // Ativos por empresa: uma contagem por EMPRESA, nunca por local.
  assert.ok(contagensWhere <= 2, `contagem de ativos por empresa: ${contagensWhere}`);
});

test('cores compartilhadas: uso vinculado é agregado em UMA consulta por página', async () => {
  const cor = await createRecord(RESOURCES.cores, { nome: `COR-${sufixo}`, hex: '#123456' }, admin);
  await createRecord(
    RESOURCES.produtos,
    { sku: `COR-${sufixo}`, nome: `Produto cor ${sufixo}`, preco_venda: 20, cor_id: Number(cor.id) },
    admin
  );

  const store = getStore() as any;
  const original = store.countByColumn;
  let chamadas = 0;
  store.countByColumn = function (...args: any[]) {
    chamadas++;
    return original.apply(this, args);
  };
  let res: any;
  try {
    res = await listRecords(RESOURCES.cores, { page: 1, pageSize: 100 }, escopo);
  } finally {
    store.countByColumn = original;
  }
  const linha = res.rows.find((r: any) => Number(r.id) === Number(cor.id));
  assert.ok(linha, 'a cor criada deve aparecer na listagem');
  assert.equal(linha.uso_vinculado, 1, 'um produto usa esta cor');
  assert.ok(chamadas <= 2, `anotação de uso deve ser agregada, houve ${chamadas} consultas`);
});

test('grades mantêm o rótulo de uso mesmo com anotações em paralelo', async () => {
  // `anotarGrades` LÊ `uso_vinculado` (escrito por `anotarUsoVinculado`).
  // Este teste garante que a paralelização de PERF-04 não quebrou a ordem.
  // `grades` exige ao menos um tamanho (multiref) — cria dois para a grade.
  const t1 = await createRecord(RESOURCES.tamanhos, { codigo: `P${sufixo}`, ordem: 1 }, admin);
  const t2 = await createRecord(RESOURCES.tamanhos, { codigo: `M${sufixo}`, ordem: 2 }, admin);
  const grade = await createRecord(
    RESOURCES.grades,
    { nome: `GRADE-${sufixo}`, tamanhos: [Number(t1.id), Number(t2.id)] },
    admin
  );
  await createRecord(
    RESOURCES.produtos,
    { sku: `GR-${sufixo}`, nome: `Produto grade ${sufixo}`, preco_venda: 30, grade_id: Number(grade.id) },
    admin
  );

  const res = await listRecords(RESOURCES.grades, { page: 1, pageSize: 100 }, escopo);
  const linha = res.rows.find((r: any) => Number(r.id) === Number(grade.id));
  assert.ok(linha, 'a grade criada deve aparecer');
  assert.equal(linha.uso_vinculado, 1, 'um produto usa esta grade');
  assert.ok(
    typeof linha.uso_vinculado_label === 'string' && linha.uso_vinculado_label.length > 0,
    'o rótulo de uso é composto (depende da anotação anterior)'
  );
});
