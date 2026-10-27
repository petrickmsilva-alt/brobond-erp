// ============================================================================
// CADASTROS › INSUMOS — PostgreSQL REAL.
//
// Prova o que só o banco pode provar para o cadastro profissionalizado:
//   • listagem paginada com busca (ILIKE) e filtros reais (unidade,
//     fornecedor, status) na MESMA query;
//   • "Estoque" = saldo REAL de `estoque_insumos`, agregado por UMA consulta
//     (GROUP BY) para a página inteira — nunca um N+1, nunca número inventado;
//   • "Utilização" = contagem real (SQL) de fichas técnicas, recortada pela
//     empresa ativa;
//   • MULTIEMPRESA: o saldo e a utilização não vazam entre empresas;
//   • a FK `itens_ficha_tecnica.insumo_id` continua sendo a proteção final:
//     DELETE direto na store recebe 23503 (nada de CASCADE, nada de DELETE
//     forçado);
//   • pela camada de serviço, o 409 traz o diagnóstico com módulo, quantidade
//     e ids — e o insumo permanece;
//   • desativar preserva o registro e o saldo (o histórico não é apagado).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

test('insumos em PostgreSQL real: listagem/filtros, saldo e utilização agregados, FK e diagnóstico', { skip }, async () => {
  const { query, migrate } = await import('../../src/db');
  await migrate();

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import('../../src/services');

  const admin: { id: number; name: string; perfil: 'admin' } = { id: 1, name: 'Admin PG Insumos', perfil: 'admin' };

  // Duas empresas: saldo e utilização são SEMPRE os da empresa ativa.
  const empA = await createRecord(RESOURCES.empresas, { nome: `INSUMOS A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `INSUMOS B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const atorA = { id: 0, name: 'Gerente A', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 0, name: 'Gerente B', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  // O insumo (e o fornecedor) pertencem à empresa A: criar com o ator da
  // empresa é o que o fluxo real faz — um admin de SISTEMA criaria em empresa
  // padrão e a listagem de A não o encontraria (era o defeito deste teste).
  const fornecedor = await createRecord(RESOURCES.fornecedores, { nome: `Fornecedor ${sufixo}`, ativo: true }, atorA);

  const insumo = await createRecord(
    RESOURCES.insumos,
    { nome: `Malha penteada ${sufixo}`, unidade: 'm', custo_medio: 12.5, fornecedor_id: Number(fornecedor.id), ativo: true },
    atorA
  );
  const insumoId = Number(insumo.id);

  // Saldo REAL na tabela `estoque_insumos` (um saldo por insumo).
  await query(
    `INSERT INTO estoque_insumos (empresa_id, insumo_id, quantidade, estoque_min)
     VALUES ($1, $2, $3, $4)`,
    [A, insumoId, 250, 10]
  );

  // ---- A) Listagem: busca + filtros reais na MESMA query -------------------
  const porNome = await listRecords(RESOURCES.insumos, { page: 1, pageSize: 50, q: 'malha penteada' }, atorA);
  const linhaA = porNome.rows.find((r) => Number(r.id) === insumoId);
  assert.ok(linhaA, 'busca por nome (ILIKE) encontra o insumo');
  assert.equal(linhaA!.unidade, 'm');
  assert.equal(Number(linhaA!.custo_medio), 12.5);
  assert.equal(linhaA!.fornecedor_id__label, `Fornecedor ${sufixo}`, 'rótulo do fornecedor vem do cadastro');

  // ---- A1) Identificação operacional e categorização (migration 0041) ------
  // Código único POR EMPRESA: o mesmo código em OUTRA empresa é permitido.
  const codigo = `INS-PG-${sufixo}`;
  await query('UPDATE insumos SET codigo_insumo = $1 WHERE id = $2', [codigo, insumoId]);
  const porCodigo = await listRecords(RESOURCES.insumos, { page: 1, pageSize: 50, q: codigo }, atorA);
  assert.ok(porCodigo.rows.some((r) => Number(r.id) === insumoId), 'a busca encontra pelo código (ILIKE)');
  await assert.rejects(
    () =>
      query('INSERT INTO insumos (empresa_id, nome, unidade, codigo_insumo) VALUES ($1, $2, $3, $4)', [
        A,
        `Duplicado ${sufixo}`,
        'm',
        codigo,
      ]),
    (e: any) => e?.code === '23505',
    'o índice único parcial uq_insumos_codigo_empresa recusa o código repetido na MESMA empresa'
  );

  // Categoria de insumo (taxonomia própria) + filtro server-side por categoria.
  const categoria = await createRecord(RESOURCES.categorias_insumos, { nome: `Malhas PG ${sufixo}` }, atorA);
  await updateRecord(RESOURCES.insumos, insumoId, { categoria_id: Number(categoria.id) }, atorA);
  const porCategoria = await listRecords(
    RESOURCES.insumos,
    { page: 1, pageSize: 100, filter: { categoria_id: String(categoria.id) } },
    atorA
  );
  assert.ok(porCategoria.rows.some((r) => Number(r.id) === insumoId), 'o filtro de categoria recorta no servidor');

  const porUnidade = await listRecords(RESOURCES.insumos, { page: 1, pageSize: 100, filter: { unidade: 'kg' } }, atorA);
  assert.ok(!porUnidade.rows.some((r) => Number(r.id) === insumoId), 'filtro de unidade recorta no servidor');

  const porFornecedor = await listRecords(
    RESOURCES.insumos,
    { page: 1, pageSize: 100, filter: { fornecedor_id: String(fornecedor.id) } },
    atorA
  );
  assert.ok(porFornecedor.rows.some((r) => Number(r.id) === insumoId), 'filtro de fornecedor recorta no servidor');

  const porStatus = await listRecords(RESOURCES.insumos, { page: 1, pageSize: 100, filter: { ativo: 'true' } }, atorA);
  assert.ok(porStatus.rows.some((r) => Number(r.id) === insumoId));

  // ---- B) Estoque: saldo REAL agregado, por empresa ------------------------
  assert.equal(Number(linhaA!.estoque_saldo), 250, 'saldo real de estoque_insumos');
  assert.equal(Number(linhaA!.estoque_min), 10, 'mínimo cadastrado em estoque_insumos (250 > 10 → normal)');
  assert.equal(linhaA!.estoque_status, 'normal', 'situação derivada do saldo × mínimo');
  // A empresa B não tem saldo para este insumo: o recorte impede o vazamento.
  const linhaB = (await listRecords(RESOURCES.insumos, { page: 1, pageSize: 50, q: `malha penteada ${sufixo}` }, atorB)).rows[0];
  assert.ok(!linhaB, 'a empresa B não enxerga o insumo da empresa A');

  // ---- B1) Última movimentação e último custo de entrada (DISTINCT ON) -----
  await createRecord(
    RESOURCES.movimentacoes_insumos,
    { tipo: 'entrada', insumo_id: insumoId, quantidade: 5, custo_unitario: 14.75 },
    atorA
  );
  const comMov = (await listRecords(RESOURCES.insumos, { page: 1, pageSize: 50, q: `malha penteada ${sufixo}` }, atorA)).rows[0];
  assert.equal(comMov.ultima_movimentacao_tipo, 'entrada');
  assert.ok(comMov.ultima_movimentacao, 'a última movimentação vem datada do banco');
  assert.equal(Number(comMov.ultimo_custo_entrada), 14.75, 'custo unitário da última ENTRADA');
  assert.equal(comMov.estoque_tem_movimentacao, true, 'a ficha sinaliza que há histórico (custo é calculado)');

  // ---- B2) CUSTO MÉDIO: dado calculado depois da 1ª movimentação -----------
  // Com histórico, o servidor RECUSA o PUT que tente editar o custo à mão — o
  // valor é formado pelo recebimento de compras, não pelo formulário.
  let erroCusto: any = null;
  try {
    await updateRecord(RESOURCES.insumos, insumoId, { custo_medio: 99 }, atorA);
  } catch (e: any) {
    erroCusto = e;
  }
  assert.ok(erroCusto, 'o custo médio é recusado quando já há movimentação');
  assert.equal(erroCusto.status, 409);
  assert.ok(erroCusto.fields?.custo_medio, 'o 409 aponta o campo custo_medio');
  assert.equal(Number((await getRecord(RESOURCES.insumos, insumoId, atorA)).custo_medio), 12.5, 'o custo calculado não mudou');

  // ---- C) Utilização: contagem real de fichas técnicas ----------------------
  const produto = await createRecord(
    RESOURCES.produtos,
    { sku: `INS-FICHA-${sufixo}`, nome: `Produto ficha ${sufixo}` },
    atorA
  );
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: Number(produto.id) }, atorA);
  await createRecord(
    RESOURCES.itens_ficha_tecnica,
    { ficha_id: Number(ficha.id), insumo_id: insumoId, consumo: 2, perda_pct: 0 },
    atorA
  );
  await createRecord(
    RESOURCES.itens_ficha_tecnica,
    { ficha_id: Number(ficha.id), insumo_id: insumoId, consumo: 1, perda_pct: 0 },
    atorA
  );

  const comUso = (await listRecords(RESOURCES.insumos, { page: 1, pageSize: 50, q: `malha penteada ${sufixo}` }, atorA)).rows[0];
  assert.equal(comUso.uso_vinculado, 2, 'duas linhas de ficha técnica');
  assert.equal(comUso.uso_vinculado_label, '2 fichas técnicas');

  // ---- D) FK é a proteção final: DELETE direto na store dá 23503 ------------
  await assert.rejects(
    () => getStore().remove(RESOURCES.insumos, insumoId),
    (e: any) => e?.code === '23503',
    'a FK itens_ficha_tecnica.insumo_id impede o DELETE (NO ACTION)'
  );
  assert.equal((await query('SELECT id FROM insumos WHERE id = $1', [insumoId])).rowCount, 1, 'nada foi apagado');

  // ---- E) Pela camada de serviço: 409 + diagnóstico do catálogo ------------
  let erro: any = null;
  try {
    await deleteRecord(RESOURCES.insumos, insumoId, atorA);
  } catch (e: any) {
    erro = e;
  }
  assert.ok(erro, 'a exclusão de insumo vinculado é recusada');
  assert.equal(erro.status, 409);
  assert.equal(erro.code, 'dependencias_vinculadas');
  const diag = erro.details?.dependencias;
  assert.equal(diag.origem, 'postgresql', 'relações lidas do catálogo do PostgreSQL');
  assert.equal(diag.bloqueado, true);
  assert.ok(diag.modulosBloqueantes.length > 0, 'o diagnóstico diz onde o insumo é usado');
  const vinculo = diag.vinculos.find((v: any) => v.tabela === 'itens_ficha_tecnica');
  assert.ok(vinculo, 'o vínculo da ficha técnica aparece no diagnóstico');
  assert.equal(vinculo.quantidade, 2);
  assert.equal((await getRecord(RESOURCES.insumos, insumoId, atorA)).nome, `Malha penteada ${sufixo}`);

  // ---- F) Insumo sem vínculo segue o fluxo normal ----------------------------
  const orfa = await createRecord(RESOURCES.insumos, { nome: `Órfã ${sufixo}`, unidade: 'un', ativo: true }, atorA);
  await deleteRecord(RESOURCES.insumos, Number(orfa.id), atorA);
  const restou = await query('SELECT id FROM insumos WHERE id = $1', [Number(orfa.id)]);
  assert.equal(restou.rowCount, 0);

  // ---- G) Desativar (a saída recomendada) preserva registro e saldo ---------
  const desativado = await updateRecord(RESOURCES.insumos, insumoId, { ativo: false }, atorA);
  assert.equal(desativado.ativo, false);
  assert.equal((await query('SELECT id FROM insumos WHERE id = $1', [insumoId])).rowCount, 1, 'o registro continua');
  const saldo = await query<{ quantidade: string }>('SELECT quantidade FROM estoque_insumos WHERE insumo_id = $1', [insumoId]);
  // 250 do saldo inicial + 5 da entrada real registrada em B1: o saldo do
  // insumo desativado continua no estoque, agora refletindo a movimentação.
  assert.equal(Number(saldo.rows[0]?.quantidade), 255, 'o saldo do insumo desativado continua no estoque');
});
