// ============================================================================
// CADASTROS › GRADES — PostgreSQL REAL.
//
// Prova o que só o banco pode provar para o cadastro profissionalizado
// (LISTA → PÁGINA /grades/novo e /grades/:id/editar):
//   • `grade_tamanhos` é gravado com ordem = posição e a UNIQUE (grade_id,
//     tamanho_id) continua valendo — duplicata não cria linha extra;
//   • reordenar reescreve a ordem no banco (1..N, sem buracos);
//   • busca por nome e filtro `ativo` pela MESMA listagem paginada;
//   • "Utilização" = contagem real (SQL GROUP BY) recortada pela empresa ativa
//     + categorias que usam a grade como padrão (catálogo global);
//   • "Medidas" = estado real da tabela (sem_tabela → parcial → completa), com a
//     MESMA regra de completude do módulo de medidas;
//   • a FK `produtos.grade_id` continua sendo a proteção final: DELETE direto na
//     store recebe 23503 (nada de CASCADE, nada de DELETE forçado);
//   • pela camada de serviço, o 409 traz o diagnóstico do CATÁLOGO com módulo,
//     quantidade e ids — e a grade permanece;
//   • grade sem vínculo é excluída e `grade_tamanhos` sai em CASCADE;
//   • desativar preserva tamanhos, medidas e produtos;
//   • Produtos continuam lendo a grade do cadastro (rótulo + tamanhos na ordem).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

test('grades em PostgreSQL real: ordem dos tamanhos, utilização por empresa, medidas, FK e diagnóstico', { skip }, async () => {
  const { query, migrate } = await import('../../src/db');
  await migrate();

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import(
    '../../src/services'
  );
  const { chamar, reqDe } = await import('../_p1util');
  const { getMedidasGrade, saveMedidasGrade } = await import('../../src/medidas');

  const admin: { id: number; name: string; perfil: 'admin' } = { id: 1, name: 'Admin PG Grades', perfil: 'admin' };

  // Duas empresas: a contagem de utilização é SEMPRE a da empresa ativa.
  const empA = await createRecord(RESOURCES.empresas, { nome: `GRADES A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `GRADES B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const atorA = { id: 0, name: 'Gerente A', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 0, name: 'Gerente B', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  // Dicionário de tamanhos (código é UNIQUE e tem no máximo 10 caracteres).
  const sufixoCurto = sufixo.slice(-6);
  const ids: number[] = [];
  for (const [i, codigo] of ['PP', 'P', 'M', 'G'].entries()) {
    const t = await createRecord(RESOURCES.tamanhos, { codigo: `${codigo}${sufixoCurto}`, ordem: 500 + i }, admin);
    ids.push(Number(t.id));
  }
  const [pp, p, m, g] = ids;

  // ---- A) Criação: `grade_tamanhos` com ordem = posição enviada --------------
  const grade = await createRecord(
    RESOURCES.grades,
    {
      nome: `Camiseta ${sufixo}`,
      descricao: 'Malha e camisaria básica',
      instrucoes_medidas: 'Meça a peça sobre uma superfície plana, sem esticar.',
      ativo: true,
      tamanhos: [pp, p, m, g],
    },
    admin
  );
  const gid = Number(grade.id);

  const gravados = await query<{ tamanho_id: number; ordem: number }>(
    'SELECT tamanho_id, ordem FROM grade_tamanhos WHERE grade_id = $1 ORDER BY ordem',
    [gid]
  );
  assert.deepEqual(
    gravados.rows.map((r) => Number(r.tamanho_id)),
    [pp, p, m, g],
    'a sequência gravada é exatamente a enviada'
  );
  assert.deepEqual(
    gravados.rows.map((r) => Number(r.ordem)),
    [1, 2, 3, 4],
    'ordem determinística a partir de 1'
  );

  // ---- B) Duplicata não cria linha extra (UNIQUE grade_id + tamanho_id) ------
  const duplicada = await createRecord(
    RESOURCES.grades,
    { nome: `Duplicada ${sufixo}`, tamanhos: [p, m, p, m, p] },
    admin
  );
  const itensDuplicada = await query(
    'SELECT tamanho_id, ordem FROM grade_tamanhos WHERE grade_id = $1 ORDER BY ordem',
    [Number(duplicada.id)]
  );
  assert.equal(itensDuplicada.rowCount, 2, 'a UNIQUE do banco é respeitada sem erro de gravação');
  assert.deepEqual(
    itensDuplicada.rows.map((r) => Number(r.tamanho_id)),
    [p, m]
  );

  // ---- C) Reordenação reescreve a ordem no banco -----------------------------
  await updateRecord(RESOURCES.grades, gid, { tamanhos: [g, pp, p, m] }, admin);
  const reordenada = await query<{ tamanho_id: number; ordem: number }>(
    'SELECT tamanho_id, ordem FROM grade_tamanhos WHERE grade_id = $1 ORDER BY ordem',
    [gid]
  );
  assert.deepEqual(
    reordenada.rows.map((r) => Number(r.tamanho_id)),
    [g, pp, p, m]
  );
  assert.deepEqual(
    reordenada.rows.map((r) => Number(r.ordem)),
    [1, 2, 3, 4]
  );
  // Voltando à ordem original (o que a página faz com ↑ ↓).
  await updateRecord(RESOURCES.grades, gid, { tamanhos: [pp, p, m, g] }, admin);

  // Editar sem mexer nos tamanhos não reescreve a composição.
  const antesDaEdicao = await query('SELECT id FROM grade_tamanhos WHERE grade_id = $1 ORDER BY ordem', [gid]);
  await updateRecord(RESOURCES.grades, gid, { descricao: 'Sarja e jeans' }, admin);
  const depoisDaEdicao = await query('SELECT id FROM grade_tamanhos WHERE grade_id = $1 ORDER BY ordem', [gid]);
  assert.deepEqual(
    depoisDaEdicao.rows.map((r) => r.id),
    antesDaEdicao.rows.map((r) => r.id),
    'nenhum item de grade foi reescrito'
  );

  // ---- D) Listagem: busca por nome, filtro de status e rótulos na ordem ------
  const porNome = await listRecords(RESOURCES.grades, { page: 1, pageSize: 50, q: `camiseta ${sufixo}` }, atorA);
  const linha = porNome.rows.find((r) => Number(r.id) === gid);
  assert.ok(linha, 'busca por nome (ILIKE) encontra a grade');
  assert.deepEqual(linha!.tamanhos, [pp, p, m, g]);
  assert.equal(linha!.tamanhos_total, 4);
  assert.equal(
    linha!.tamanhos__label,
    `PP${sufixoCurto} · P${sufixoCurto} · M${sufixoCurto} · G${sufixoCurto}`,
    'os códigos aparecem na ordem da grade'
  );

  const inativas = await listRecords(RESOURCES.grades, { page: 1, pageSize: 100, filter: { ativo: 'false' } }, atorA);
  assert.ok(inativas.rows.every((r) => r.ativo === false));
  const ativas = await listRecords(RESOURCES.grades, { page: 1, pageSize: 100, filter: { ativo: 'true' } }, atorA);
  assert.ok(ativas.rows.some((r) => Number(r.id) === gid));

  // ---- E) Utilização: contagem REAL (SQL), recortada pela empresa ativa ------
  const p1 = await createRecord(
    RESOURCES.produtos,
    { sku: `GRD-A1-${sufixo}`, nome: `Produto A1 ${sufixo}`, grade_id: gid },
    atorA
  );
  await createRecord(RESOURCES.produtos, { sku: `GRD-A2-${sufixo}`, nome: `Produto A2 ${sufixo}`, grade_id: gid }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `GRD-B1-${sufixo}`, nome: `Produto B1 ${sufixo}`, grade_id: gid }, atorB);
  await createRecord(RESOURCES.categorias, { nome: `Categoria ${sufixo}`, grade_id: gid }, atorA);

  const usoA = (await listRecords(RESOURCES.grades, { page: 1, pageSize: 50, q: `Camiseta ${sufixo}` }, atorA)).rows.find(
    (r) => Number(r.id) === gid
  )!;
  assert.equal(usoA.uso_vinculado, 2, 'só os produtos da empresa ativa');
  assert.equal(usoA.uso_categorias, 1, 'categorias que usam a grade como padrão');
  assert.equal(usoA.uso_vinculado_label, '2 produtos · 1 categoria');

  const usoB = (await listRecords(RESOURCES.grades, { page: 1, pageSize: 50, q: `Camiseta ${sufixo}` }, atorB)).rows.find(
    (r) => Number(r.id) === gid
  )!;
  assert.equal(usoB.uso_vinculado, 1, 'a empresa B vê apenas os produtos dela');
  assert.equal(usoB.uso_vinculado_label, '1 produto · 1 categoria');

  // O detalhe carrega a mesma anotação (a tela não recalcula nada).
  const detalhe = await getRecord(RESOURCES.grades, gid, atorA);
  assert.equal(detalhe.uso_vinculado, 2);
  assert.equal(detalhe.uso_categorias, 1);

  // Grade sem vínculo: zero real, sem número inventado.
  const semUso = (await listRecords(RESOURCES.grades, { page: 1, pageSize: 50, q: `Duplicada ${sufixo}` }, atorA)).rows[0];
  assert.equal(semUso.uso_vinculado, 0);
  assert.equal(semUso.uso_vinculado_label, '');

  // ---- F) Tabela de medidas: estado real, pela MESMA regra do módulo ---------
  const semTabela = (await listRecords(RESOURCES.grades, { page: 1, pageSize: 50, q: `Camiseta ${sufixo}` }, atorA)).rows.find(
    (r) => Number(r.id) === gid
  )!;
  assert.equal(semTabela.medidas_status, 'sem_tabela');
  assert.equal(semTabela.medidas_colunas, 0);

  await chamar(
    saveMedidasGrade,
    reqDe(
      {
        medidas: [
          { nome: 'Largura (A)', unidade: 'cm' },
          { nome: 'Comprimento (B)', unidade: 'cm' },
        ],
        valores: [
          { medida_nome: 'Largura (A)', tamanho_id: pp, valor: 48 },
          { medida_nome: 'Largura (A)', tamanho_id: p, valor: 50 },
          { medida_nome: 'Largura (A)', tamanho_id: m, valor: 52 },
          { medida_nome: 'Largura (A)', tamanho_id: g, valor: 54 },
          { medida_nome: 'Comprimento (B)', tamanho_id: pp, valor: 66 },
        ],
      },
      { params: { id: String(gid) }, user: admin }
    )
  );

  const parcial = (await listRecords(RESOURCES.grades, { page: 1, pageSize: 50, q: `Camiseta ${sufixo}` }, atorA)).rows.find(
    (r) => Number(r.id) === gid
  )!;
  assert.equal(parcial.medidas_status, 'parcial');
  assert.equal(parcial.medidas_colunas, 2);
  assert.equal(parcial.medidas_celulas_total, 8, '2 colunas × 4 tamanhos');
  assert.equal(parcial.medidas_celulas_preenchidas, 5);
  assert.equal(parcial.medidas_pct, 63);

  // O endpoint do módulo de medidas continua dizendo exatamente o mesmo.
  const tabela = await chamar(getMedidasGrade, reqDe({}, { params: { id: String(gid) }, user: admin }));
  assert.equal(tabela.resumo.celulas_total, 8);
  assert.equal(tabela.resumo.celulas_preenchidas, 5);
  assert.equal(tabela.tamanhos.length, 4);
  assert.deepEqual(
    tabela.tamanhos.map((t: any) => Number(t.id)),
    [pp, p, m, g],
    'a tabela usa os tamanhos NA ORDEM da grade'
  );

  // ---- G) FK é a proteção final: DELETE direto na store dá 23503 -------------
  await assert.rejects(
    () => getStore().remove(RESOURCES.grades, gid),
    (e: any) => e?.code === '23503',
    'a FK produtos.grade_id impede o DELETE (NO ACTION)'
  );
  assert.equal((await query('SELECT id FROM grades WHERE id = $1', [gid])).rowCount, 1, 'nada foi apagado');
  assert.equal((await query('SELECT id FROM grade_tamanhos WHERE grade_id = $1', [gid])).rowCount, 4);

  // ---- H) Pela camada de serviço: 409 + diagnóstico do catálogo --------------
  let erro: any = null;
  try {
    await deleteRecord(RESOURCES.grades, gid, admin);
  } catch (e: any) {
    erro = e;
  }
  assert.ok(erro, 'a exclusão de grade vinculada é recusada');
  assert.equal(erro.status, 409);
  assert.equal(erro.code, 'dependencias_vinculadas');
  const diag = erro.details?.dependencias;
  assert.equal(diag.origem, 'postgresql', 'relações lidas do catálogo do PostgreSQL');
  assert.equal(diag.bloqueado, true);
  assert.deepEqual(diag.modulosBloqueantes.slice().sort(), ['Categorias', 'Produtos']);
  assert.match(diag.orientacao, /desative/i);
  const vinculoProdutos = diag.vinculos.find((v: any) => v.tabela === 'produtos');
  assert.equal(vinculoProdutos.quantidade, 3, 'as três linhas que apontam para a grade (A e B)');
  assert.ok(vinculoProdutos.ids.includes(Number(p1.id)));
  const composicao = diag.vinculos.find((v: any) => v.tabela === 'grade_tamanhos');
  assert.equal(composicao.tipo, 'composicao');
  assert.equal(composicao.bloqueia, false);
  assert.equal((await getRecord(RESOURCES.grades, gid, atorA)).nome, `Camiseta ${sufixo}`);

  // ---- I) Produtos continuam lendo a grade do cadastro -----------------------
  const produto = (await listRecords(RESOURCES.produtos, { page: 1, pageSize: 50, q: `GRD-A1-${sufixo}` }, atorA)).rows[0];
  assert.equal(produto.grade_id__label, `Camiseta ${sufixo}`);
  const { gradeDoProduto } = await import('../../src/services');
  const efetiva = await gradeDoProduto(produto);
  assert.equal(efetiva?.gradeId, gid);
  assert.equal(efetiva?.gradeNome, `Camiseta ${sufixo}`);
  assert.deepEqual(
    efetiva?.tamanhos.map((t: any) => Number(t.id)),
    [pp, p, m, g],
    'a ordem da grade é a ordem oferecida ao estoque/venda'
  );

  // ---- J) Desativar (a saída recomendada) preserva tudo ----------------------
  const desativada = await updateRecord(RESOURCES.grades, gid, { ativo: false }, admin);
  assert.equal(desativada.ativo, false);
  assert.equal((await query('SELECT id FROM grades WHERE id = $1', [gid])).rowCount, 1);
  assert.equal((await query('SELECT id FROM grade_tamanhos WHERE grade_id = $1', [gid])).rowCount, 4);
  assert.equal((await query('SELECT id FROM medidas WHERE grade_id = $1', [gid])).rowCount, 2);
  assert.equal((await query('SELECT id FROM produtos WHERE grade_id = $1', [gid])).rowCount, 3);
  await updateRecord(RESOURCES.grades, gid, { ativo: true }, admin);

  // ---- K) Grade sem vínculo segue o fluxo normal (com CASCADE da composição) --
  const orfa = await createRecord(RESOURCES.grades, { nome: `Órfã ${sufixo}`, tamanhos: [pp, p] }, admin);
  const orfaId = Number(orfa.id);
  assert.equal((await query('SELECT id FROM grade_tamanhos WHERE grade_id = $1', [orfaId])).rowCount, 2);
  await deleteRecord(RESOURCES.grades, orfaId, admin);
  assert.equal((await query('SELECT id FROM grades WHERE id = $1', [orfaId])).rowCount, 0);
  assert.equal((await query('SELECT id FROM grade_tamanhos WHERE grade_id = $1', [orfaId])).rowCount, 0);
});
