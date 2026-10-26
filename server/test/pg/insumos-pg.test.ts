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

  const fornecedor = await createRecord(RESOURCES.fornecedores, { nome: `Fornecedor ${sufixo}`, ativo: true }, admin);

  const insumo = await createRecord(
    RESOURCES.insumos,
    { nome: `Malha penteada ${sufixo}`, unidade: 'm', custo_medio: 12.5, fornecedor_id: Number(fornecedor.id), ativo: true },
    admin
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
  // A empresa B não tem saldo para este insumo: o recorte impede o vazamento.
  const linhaB = (await listRecords(RESOURCES.insumos, { page: 1, pageSize: 50, q: `malha penteada ${sufixo}` }, atorB)).rows[0];
  assert.ok(!linhaB, 'a empresa B não enxerga o insumo da empresa A');

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
    await deleteRecord(RESOURCES.insumos, insumoId, admin);
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
  const orfa = await createRecord(RESOURCES.insumos, { nome: `Órfã ${sufixo}`, unidade: 'un', ativo: true }, admin);
  await deleteRecord(RESOURCES.insumos, Number(orfa.id), admin);
  const restou = await query('SELECT id FROM insumos WHERE id = $1', [Number(orfa.id)]);
  assert.equal(restou.rowCount, 0);

  // ---- G) Desativar (a saída recomendada) preserva registro e saldo ---------
  const desativado = await updateRecord(RESOURCES.insumos, insumoId, { ativo: false }, admin);
  assert.equal(desativado.ativo, false);
  assert.equal((await query('SELECT id FROM insumos WHERE id = $1', [insumoId])).rowCount, 1, 'o registro continua');
  const saldo = await query<{ quantidade: string }>('SELECT quantidade FROM estoque_insumos WHERE insumo_id = $1', [insumoId]);
  assert.equal(Number(saldo.rows[0]?.quantidade), 250, 'o saldo do insumo desativado continua no estoque');
});
