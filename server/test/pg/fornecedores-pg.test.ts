// ============================================================================
// CADASTROS › FORNECEDORES — PostgreSQL REAL.
//
// Prova o que só o banco pode provar para o cadastro no padrão LISTA → PÁGINA:
//   • listagem paginada com busca (ILIKE — nome, documento por dígitos) e
//     filtros reais (pessoa, UF, status) na MESMA query;
//   • "Utilização" = contagem real (SQL) de pedidos de compra
//     (`compras.fornecedor_id`), recortada pela empresa ativa;
//   • MULTIEMPRESA: o cadastro e a utilização não vazam entre empresas;
//   • CNPJ/CPF ÚNICO POR EMPRESA (índice parcial `uq_fornecedores_documento_empresa`
//     da migration 0021): duplicado na mesma empresa devolve 409
//     `fornecedor_duplicado` com erro no campo `cnpj`; em outra empresa é
//     permitido; sem documento, quantos quiser (o índice é parcial);
//   • normalização: o documento entra com máscara e é gravado só com dígitos;
//   • a FK `compras.fornecedor_id` continua sendo a proteção final: DELETE
//     direto na store recebe 23503 (nada de CASCADE, nada de DELETE forçado);
//   • pela camada de serviço, o 409 traz o diagnóstico com módulo, quantidade
//     e ids — e o fornecedor permanece;
//   • desativar preserva o registro e as compras (o histórico não é apagado).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

// Documentos VÁLIDOS (dígito verificador conferido — os mesmos do smoke E2E).
const CNPJ_VALIDO = '12345678000195';

test('fornecedores em PostgreSQL real: busca/filtros, utilização, documento único por empresa, FK e diagnóstico', { skip }, async () => {
  const { query, migrate } = await import('../../src/db');
  await migrate();

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import('../../src/services');

  const admin: { id: number; name: string; perfil: 'admin' } = { id: 1, name: 'Admin PG Fornecedores', perfil: 'admin' };

  // Duas empresas: cadastro e utilização são SEMPRE os da empresa ativa.
  const empA = await createRecord(RESOURCES.empresas, { nome: `FORNEC A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `FORNEC B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const atorA = { id: 0, name: 'Gerente A', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 0, name: 'Gerente B', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  // ---- A) Criação: documento com máscara é gravado só com dígitos ----------
  const fornecedor = await createRecord(
    RESOURCES.fornecedores,
    {
      nome: `Têxtil PG ${sufixo}`,
      pessoa: 'pj',
      cnpj: '12.345.678/0001-95',
      cidade: 'Goiânia',
      uf: 'GO',
      telefone: '+55 (62) 3333-4444',
      ativo: true,
    },
    atorA
  );
  const fornecedorId = Number(fornecedor.id);
  const gravado = await query<{ cnpj: string; telefone: string; empresa_id: number }>(
    'SELECT cnpj, telefone, empresa_id FROM fornecedores WHERE id = $1',
    [fornecedorId]
  );
  assert.equal(gravado.rows[0].cnpj, CNPJ_VALIDO, 'CNPJ normalizado para dígitos no banco');
  assert.equal(gravado.rows[0].telefone, '6233334444', 'telefone canônico sem máscara');
  assert.equal(gravado.rows[0].empresa_id, A, 'o registro é da empresa ativa do ator');

  // ---- B) Documento único POR EMPRESA (índice parcial da migration 0021) ---
  // Na MESMA empresa, o mesmo documento (outra máscara) é recusado com 409
  // claro e erro no campo — a tradução do unique_violation (fornecedor_duplicado).
  let erroDup: any = null;
  try {
    await createRecord(RESOURCES.fornecedores, { nome: `Duplicado ${sufixo}`, pessoa: 'pj', cnpj: '12345678000195' }, atorA);
  } catch (e: any) {
    erroDup = e;
  }
  assert.ok(erroDup, 'CNPJ duplicado na mesma empresa é recusado');
  assert.equal(erroDup.status, 409);
  assert.equal(erroDup.code, 'fornecedor_duplicado');
  assert.match(String(erroDup.message), /Já existe um fornecedor cadastrado com este CNPJ ou CPF/);
  assert.equal(erroDup.fields?.cnpj, 'Já cadastrado', 'o erro aponta o campo cnpj do formulário');

  // Em OUTRA empresa, o mesmo documento é permitido (multiempresa preservada).
  const mesmoDocEmB = await createRecord(
    RESOURCES.fornecedores,
    { nome: `Têxtil PG B ${sufixo}`, pessoa: 'pj', cnpj: CNPJ_VALIDO, ativo: true },
    atorB
  );
  assert.ok(Number(mesmoDocEmB.id) > 0, 'o documento é único POR EMPRESA, não global');

  // Sem documento, quantos quiser: o índice único é PARCIAL (cnpj não vazio).
  const semDoc1 = await createRecord(RESOURCES.fornecedores, { nome: `Sem doc 1 ${sufixo}` }, atorA);
  const semDoc2 = await createRecord(RESOURCES.fornecedores, { nome: `Sem doc 2 ${sufixo}` }, atorA);
  assert.ok(Number(semDoc1.id) !== Number(semDoc2.id));

  // ---- C) Listagem: busca + filtros reais na MESMA query -------------------
  const porNome = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 50, q: `têxtil pg ${sufixo}` }, atorA);
  const linhaA = porNome.rows.find((r) => Number(r.id) === fornecedorId);
  assert.ok(linhaA, 'busca por nome (ILIKE, sem ligar para caixa/acento) encontra o fornecedor');
  assert.equal(linhaA!.pessoa, 'pj');
  assert.equal(linhaA!.uf, 'GO');

  const porDocumento = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 50, q: CNPJ_VALIDO }, atorA);
  assert.ok(porDocumento.rows.some((r) => Number(r.id) === fornecedorId), 'busca por dígitos do documento encontra');

  const porPessoa = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 100, filter: { pessoa: 'pf' } }, atorA);
  assert.ok(!porPessoa.rows.some((r) => Number(r.id) === fornecedorId), 'filtro de tipo de pessoa recorta no servidor');

  const porUf = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 100, filter: { uf: 'GO' } }, atorA);
  assert.ok(porUf.rows.some((r) => Number(r.id) === fornecedorId), 'filtro de UF recorta no servidor');

  const porStatus = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 100, filter: { ativo: 'true' } }, atorA);
  assert.ok(porStatus.rows.some((r) => Number(r.id) === fornecedorId));

  // ---- D) MULTIEMPRESA: a empresa B não enxerga o fornecedor da A ----------
  const listaB = await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 50, q: `têxtil pg ${sufixo}` }, atorB);
  assert.ok(!listaB.rows.some((r) => Number(r.id) === fornecedorId), 'a empresa B não enxerga o fornecedor da A');
  assert.ok(listaB.rows.some((r) => Number(r.id) === Number(mesmoDocEmB.id)), 'a B enxerga o SEU fornecedor');

  // ---- E) Utilização: contagem real de compras, por empresa ----------------
  await createRecord(RESOURCES.compras, { fornecedor_id: fornecedorId, data: '2026-10-01' }, atorA);
  await createRecord(RESOURCES.compras, { fornecedor_id: fornecedorId, data: '2026-10-02' }, atorA);
  await createRecord(RESOURCES.compras, { fornecedor_id: Number(mesmoDocEmB.id), data: '2026-10-01' }, atorB);

  const comUso = (await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 50, q: `têxtil pg ${sufixo}` }, atorA)).rows.find(
    (r) => Number(r.id) === fornecedorId
  );
  assert.equal(comUso!.uso_vinculado, 2, 'duas compras reais na empresa A');
  assert.equal(comUso!.uso_vinculado_label, '2 compras');

  const usoB = (await listRecords(RESOURCES.fornecedores, { page: 1, pageSize: 50, q: `têxtil pg b ${sufixo}` }, atorB)).rows.find(
    (r) => Number(r.id) === Number(mesmoDocEmB.id)
  );
  assert.equal(usoB!.uso_vinculado, 1, 'a utilização da B conta só as compras da B');

  // ---- F) FK é a proteção final: DELETE direto na store dá 23503 -----------
  await assert.rejects(
    () => getStore().remove(RESOURCES.fornecedores, fornecedorId),
    (e: any) => e?.code === '23503',
    'a FK compras.fornecedor_id impede o DELETE (NO ACTION)'
  );
  assert.equal((await query('SELECT id FROM fornecedores WHERE id = $1', [fornecedorId])).rowCount, 1, 'nada foi apagado');

  // ---- G) Pela camada de serviço: 409 + diagnóstico do catálogo ------------
  let erro: any = null;
  try {
    await deleteRecord(RESOURCES.fornecedores, fornecedorId, atorA);
  } catch (e: any) {
    erro = e;
  }
  assert.ok(erro, 'a exclusão de fornecedor vinculado é recusada');
  assert.equal(erro.status, 409);
  assert.equal(erro.code, 'dependencias_vinculadas');
  const diag = erro.details?.dependencias;
  assert.equal(diag.origem, 'postgresql', 'relações lidas do catálogo do PostgreSQL');
  assert.equal(diag.bloqueado, true);
  assert.ok(diag.modulosBloqueantes.includes('Compras'), 'o diagnóstico aponta o módulo Compras');
  const vinculo = diag.vinculos.find((v: any) => v.tabela === 'compras');
  assert.ok(vinculo, 'o vínculo de compras aparece no diagnóstico');
  assert.equal(vinculo.quantidade, 2);
  assert.equal((await getRecord(RESOURCES.fornecedores, fornecedorId, atorA)).nome, `Têxtil PG ${sufixo}`);

  // ---- H) Fornecedor sem vínculo segue o fluxo normal -----------------------
  const orfao = await createRecord(RESOURCES.fornecedores, { nome: `Órfão ${sufixo}` }, atorA);
  await deleteRecord(RESOURCES.fornecedores, Number(orfao.id), atorA);
  const restou = await query('SELECT id FROM fornecedores WHERE id = $1', [Number(orfao.id)]);
  assert.equal(restou.rowCount, 0);

  // ---- I) Desativar (a saída recomendada) preserva registro e compras -------
  const desativado = await updateRecord(RESOURCES.fornecedores, fornecedorId, { ativo: false }, atorA);
  assert.equal(desativado.ativo, false);
  assert.equal((await query('SELECT id FROM fornecedores WHERE id = $1', [fornecedorId])).rowCount, 1, 'o registro continua');
  const compras = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM compras WHERE fornecedor_id = $1', [fornecedorId]);
  assert.equal(Number(compras.rows[0].n), 2, 'as compras do fornecedor desativado continuam intactas');
});
