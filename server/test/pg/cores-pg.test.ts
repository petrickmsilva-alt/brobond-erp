// ============================================================================
// CADASTROS › CORES — PostgreSQL REAL.
//
// Prova o que só o banco pode provar para o cadastro simples profissionalizado:
//   • HEX opcional no banco, normalizado em #RRGGBB na gravação;
//   • busca por nome/HEX e filtro `ativo` pela MESMA listagem paginada;
//   • "Utilização" = contagem real (SQL) recortada pela empresa ativa;
//   • a FK `produtos.cor_id` continua sendo a proteção final: DELETE direto na
//     store recebe 23503 (nada de CASCADE, nada de DELETE forçado);
//   • pela camada de serviço, o 409 traz o diagnóstico do CATÁLOGO com módulo,
//     quantidade e ids — e a cor permanece;
//   • cor sem vínculo é excluída normalmente;
//   • Produtos/Variações seguem lendo a cor do cadastro (label + HEX).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

test('cores em PostgreSQL real: HEX, busca/filtro, utilização por empresa, FK e diagnóstico', { skip }, async () => {
  const { query, migrate } = await import('../../src/db');
  await migrate();

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import('../../src/services');

  const admin: { id: number; name: string; perfil: 'admin' } = { id: 1, name: 'Admin PG Cores', perfil: 'admin' };

  // Duas empresas: a contagem de utilização é SEMPRE a da empresa ativa.
  const empA = await createRecord(RESOURCES.empresas, { nome: `CORES A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `CORES B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const atorA = { id: 0, name: 'Gerente A', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 0, name: 'Gerente B', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  const cor = await createRecord(RESOURCES.cores, { nome: `Azul Marinho ${sufixo}`, hex: '172038', ativo: true }, admin);
  const corId = Number(cor.id);

  // HEX canônico no banco (sem cerquilha na digitação, maiúsculas na gravação).
  const salvo = await query<{ hex: string }>('SELECT hex FROM cores WHERE id = $1', [corId]);
  assert.equal(salvo.rows[0]?.hex, '#172038');

  // HEX opcional continua permitido (contrato atual + dados existentes).
  const semHex = await createRecord(RESOURCES.cores, { nome: `Sem HEX ${sufixo}` }, admin);
  const salvoSem = await query<{ hex: string | null }>('SELECT hex FROM cores WHERE id = $1', [Number(semHex.id)]);
  assert.equal(salvoSem.rows[0]?.hex, null);

  // ---- Produtos que usam a cor (2 na empresa A, 1 na empresa B) -------------
  const p1 = await createRecord(RESOURCES.produtos, { sku: `COR-A1-${sufixo}`, nome: `Produto A1 ${sufixo}`, cor_id: corId }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `COR-A2-${sufixo}`, nome: `Produto A2 ${sufixo}`, cor_id: corId }, atorA);
  await createRecord(RESOURCES.produtos, { sku: `COR-B1-${sufixo}`, nome: `Produto B1 ${sufixo}`, cor_id: corId }, atorB);

  // ---- A) Listagem: busca por nome e HEX + filtro de status -----------------
  const porNome = await listRecords(RESOURCES.cores, { page: 1, pageSize: 50, q: 'azul marinho' }, atorA);
  assert.ok(porNome.rows.some((r) => Number(r.id) === corId), 'busca por nome (ILIKE) encontra a cor');

  const porHex = await listRecords(RESOURCES.cores, { page: 1, pageSize: 50, q: '172038' }, atorA);
  assert.ok(porHex.rows.some((r) => Number(r.id) === corId), 'busca alcança o HEX no PostgreSQL');

  await updateRecord(RESOURCES.cores, Number(semHex.id), { ativo: false }, admin);
  const inativas = await listRecords(RESOURCES.cores, { page: 1, pageSize: 100, filter: { ativo: 'false' } }, atorA);
  assert.ok(inativas.rows.some((r) => Number(r.id) === Number(semHex.id)));
  assert.ok(inativas.rows.every((r) => r.ativo === false));

  // ---- B) Utilização: contagem real, por empresa, sem número inventado ------
  const linhaA = (await listRecords(RESOURCES.cores, { page: 1, pageSize: 50, q: `Azul Marinho ${sufixo}` }, atorA)).rows[0];
  assert.equal(linhaA.uso_vinculado, 2);
  assert.equal(linhaA.uso_vinculado_label, '2 produtos');

  const linhaB = (await listRecords(RESOURCES.cores, { page: 1, pageSize: 50, q: `Azul Marinho ${sufixo}` }, atorB)).rows[0];
  assert.equal(linhaB.uso_vinculado, 1, 'a empresa B vê apenas os produtos dela');

  const semUso = (await listRecords(RESOURCES.cores, { page: 1, pageSize: 50, q: `Sem HEX ${sufixo}` }, atorA)).rows[0];
  assert.equal(semUso.uso_vinculado, 0);

  // ---- C) FK é a proteção final: DELETE direto na store dá 23503 ------------
  await assert.rejects(
    () => getStore().remove(RESOURCES.cores, corId),
    (e: any) => e?.code === '23503',
    'a FK produtos.cor_id impede o DELETE (NO ACTION)'
  );
  assert.equal((await query('SELECT id FROM cores WHERE id = $1', [corId])).rowCount, 1, 'nada foi apagado');

  // ---- D) Pela camada de serviço: 409 + diagnóstico do catálogo -------------
  let erro: any = null;
  try {
    await deleteRecord(RESOURCES.cores, corId, admin);
  } catch (e: any) {
    erro = e;
  }
  assert.ok(erro, 'a exclusão de cor vinculada é recusada');
  assert.equal(erro.status, 409);
  assert.equal(erro.code, 'dependencias_vinculadas');
  const diag = erro.details?.dependencias;
  assert.equal(diag.origem, 'postgresql', 'relações lidas do catálogo do PostgreSQL');
  assert.equal(diag.bloqueado, true);
  assert.ok(diag.modulosBloqueantes.includes('Produtos'));
  const vinculo = diag.vinculos.find((v: any) => v.tabela === 'produtos');
  assert.equal(vinculo.quantidade, 3, 'as três linhas que apontam para a cor (A e B)');
  assert.ok(vinculo.ids.includes(Number(p1.id)));
  assert.equal((await getRecord(RESOURCES.cores, corId, atorA)).nome, `Azul Marinho ${sufixo}`);

  // ---- E) Produtos continuam lendo rótulo + amostra do cadastro -------------
  const produto = (await listRecords(RESOURCES.produtos, { page: 1, pageSize: 50, q: `COR-A1-${sufixo}` }, atorA)).rows[0];
  assert.equal(produto.cor_id__label, `Azul Marinho ${sufixo}`);
  assert.equal(produto.cor_id__color, '#172038');

  // ---- F) Cor sem vínculo segue o fluxo normal ------------------------------
  const orfa = await createRecord(RESOURCES.cores, { nome: `Órfã ${sufixo}`, hex: '#94A3B8' }, admin);
  await deleteRecord(RESOURCES.cores, Number(orfa.id), admin);
  const restou = await query('SELECT id FROM cores WHERE id = $1', [Number(orfa.id)]);
  assert.equal(restou.rowCount, 0);

  // ---- G) Desativar (a saída recomendada) preserva o registro ---------------
  const desativada = await updateRecord(RESOURCES.cores, corId, { ativo: false }, admin);
  assert.equal(desativada.ativo, false);
  assert.equal((await query('SELECT id FROM cores WHERE id = $1', [corId])).rowCount, 1);
});
