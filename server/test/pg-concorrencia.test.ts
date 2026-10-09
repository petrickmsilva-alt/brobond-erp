// ============================================================
// Testes que SÓ fazem sentido contra Postgres real.
//
// O modo demonstração (memdb) não tem isolamento: `transaction` tira snapshot do
// banco inteiro e restaura no erro, então duas requisições entrelaçadas se
// desfazem uma na outra e a janela que queremos provar não existe ali. É aqui
// que se verifica que o abate de saldo é atômico sob concorrência e que o runner
// de migrações (db/migrations) chega a um banco existente.
//
// Rodam no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula,
// para não quebrar a suíte local.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Actor = { id: number; name: string; perfil: string };
const admin: Actor = { id: 0, name: 'Teste PG', perfil: 'admin' };

async function fixture() {
  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getStore } = await import('../src/services');
  return { RESOURCES, createRecord, s: getStore() };
}

test('duas saídas concorrentes do mesmo saldo: exatamente uma vence', { skip }, async () => {
  const { migrate, pool } = await import('../src/db');
  await migrate();
  const { RESOURCES, createRecord, s } = await fixture();
  const sufixo = `${Date.now()}-${process.pid}`;

  const cat = await createRecord(RESOURCES.categorias, { nome: `pg-cat-${sufixo}` }, admin);
  // banco de teste vazio não tem seed: o tamanho é criado aqui se faltar
  let tam = (await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1 })).rows[0];
  let tamCriado: number | null = null;
  if (!tam) {
    tam = await createRecord(RESOURCES.tamanhos, { codigo: `P${sufixo.replace(/[^0-9]/g, '').slice(-8)}`, ordem: 999 }, admin);
    tamCriado = Number(tam.id);
  }
  const prod = await createRecord(RESOURCES.produtos, { sku: `PG-${sufixo}`, nome: 'PG Concorrência', categoria_id: Number(cat.id), custo: 1, preco_venda: 2 }, admin);
  const loc = await createRecord(RESOURCES.locais, { nome: `pg-${sufixo}` }, admin);
  const pid = Number(prod.id);
  const tid = Number(tam!.id);
  const lid = Number(loc.id);

  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: pid, tamanho_id: tid, quantidade: 1, local_id: lid }, admin);
  const tentar = () =>
    createRecord(RESOURCES.movimentacoes, { tipo: 'saida', produto_id: pid, tamanho_id: tid, quantidade: 1, local_id: lid }, admin).then(
      () => 'ok',
      (e: any) => String(e.status)
    );

  try {
    const resultados = (await Promise.all([tentar(), tentar()])).sort();
    assert.deepEqual(resultados, ['409', 'ok'], `as duas transações não podem abater a mesma peça: ${resultados.join(',')}`);

    const saldo = await s.list(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: pid } });
    const total = saldo.rows.reduce((a: number, e: any) => a + Number(e.quantidade), 0);
    assert.equal(total, 0, 'saldo final 0, nunca -1');

    const saidas = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { produto_id: pid, tipo: 'saida' } });
    assert.equal(saidas.rows.length, 1, 'a saída rejeitada não pode ter deixado linha');
  } finally {
    await pool!.query('DELETE FROM movimentacoes WHERE produto_id = $1', [pid]);
    await pool!.query('DELETE FROM estoques WHERE produto_id = $1', [pid]);
    await pool!.query('DELETE FROM produtos WHERE id = $1', [pid]);
    await pool!.query('DELETE FROM categorias WHERE id = $1', [Number(cat.id)]);
    await pool!.query('DELETE FROM locais WHERE id = $1', [lid]);
    if (tamCriado) await pool!.query('DELETE FROM tamanhos WHERE id = $1', [tamCriado]);
  }
});

test('runner de migrações: registra, aplica os CHECK de domínio, é idempotente e o banco recusa saldo negativo', { skip }, async () => {
  const { migrate, pool } = await import('../src/db');
  await migrate();
  await migrate(); // segunda passada no boot não pode falhar nem duplicar

  const tabelas = await pool!.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'`);
  assert.equal((tabelas.rows || []).length, 1, 'schema_migrations deve existir');

  const aplicadas = await pool!.query(`SELECT id FROM schema_migrations WHERE id = '0001_integridade_dominio.sql'`);
  assert.equal((aplicadas.rows || []).length, 1, 'a migração versionada tem de estar registrada');
  const contagem = await pool!.query(`SELECT COUNT(*)::int AS n FROM schema_migrations WHERE id = '0001_integridade_dominio.sql'`);
  assert.equal(contagem.rows[0].n, 1, 'duas passadas não podem registrar duas vezes');

  const constraints = await pool!.query(
    `SELECT conname FROM pg_constraint WHERE conname IN
       ('estoques_quantidade_nao_negativo', 'movimentacoes_tipo_valido', 'inventarios_status_valido', 'usuarios_perfil_valido', 'vendas_nfe_status_valido')`
  );
  assert.equal((constraints.rows || []).length, 5, `faltam CHECKs de domínio: ${constraints.rows.map((r: any) => r.conname).join(', ')}`);

  const recusado = await pool!.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'estoques' AND indexname = 'uq_e42_estoques_empresa_prod_sem_tam_local_id'`);
  assert.equal(recusado.rows.length, 1, 'a célula sem tamanho precisa de índice único por empresa/produto/ID do local');

  const { RESOURCES } = await import('../src/resources');
  const { createRecord } = await import('../src/services');
  const produto = await createRecord(RESOURCES.produtos, { sku: `PG-CHECK-${Date.now()}-${process.pid}`, nome: 'Produto CHECK' }, admin);
  let violou = '';
  try {
    await pool!.query(`INSERT INTO estoques (produto_id, tamanho_id, local, quantidade) VALUES ($1, NULL, 'pg-x', -1)`, [Number(produto.id)]);
  } catch (e: any) {
    violou = String(e.message);
  }
  assert.match(violou, /check constraint/i, 'o banco precisa recusar o saldo negativo mesmo em INSERT direto');
});
