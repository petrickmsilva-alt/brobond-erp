// ============================================================================
// MULTIEMPRESA contra Postgres REAL.
//
// A suíte de memória prova as regras da camada de serviço. Esta prova as
// garantias que não dependem do app — as que continuam valendo se alguém
// abrir o psql:
//
//   • os triggers `trg_empresa_*` derivam a empresa do registro-pai;
//   • `adjustStock` (SQL cru, sem passar por resources.ts) cai na empresa
//     certa mesmo sem informar nada;
//   • SKU é único POR EMPRESA e não mais globalmente;
//   • o recorte de listagem chega ao SQL (e não só ao JavaScript).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

type Ator = { id: number; name: string; perfil: 'admin' | 'gerente'; empresa_id: number; empresas: number[] };

test('MULTIEMPRESA em Postgres real: triggers, unicidade por empresa e recorte no SQL', { skip }, async (t) => {
  const { query } = await import('../src/db');
  const { migrate } = await import('../src/db');
  await migrate();

  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getRecord, listRecords, getStore } = await import('../src/services');

  const admin = { id: 1, name: 'Admin PG', perfil: 'admin' as const };

  // Duas empresas de verdade no banco.
  const empA = await createRecord(RESOURCES.empresas, { nome: `PG EMPRESA A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `PG EMPRESA B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);

  const ana: Ator = { id: 0, name: 'Ana PG', perfil: 'gerente', empresa_id: A, empresas: [A] };
  const bruno: Ator = { id: 0, name: 'Bruno PG', perfil: 'gerente', empresa_id: B, empresas: [B] };

  await t.test('o mesmo SKU pode existir nas duas empresas (unicidade por empresa)', async () => {
    const sku = `SKU-${sufixo}`;
    const pa = await createRecord(RESOURCES.produtos, { sku, nome: 'Camiseta A', preco_venda: 10 }, ana);
    const pb = await createRecord(RESOURCES.produtos, { sku, nome: 'Camiseta B', preco_venda: 20 }, bruno);
    assert.equal(Number(pa.empresa_id), A);
    assert.equal(Number(pb.empresa_id), B);

    // Mas repetir dentro da MESMA empresa continua proibido.
    await assert.rejects(
      () => createRecord(RESOURCES.produtos, { sku, nome: 'Duplicata na A', preco_venda: 10 }, ana),
      (e: any) => e.status === 409
    );
  });

  await t.test('trigger: itens_venda herda a empresa da venda, mesmo via SQL cru', async () => {
    const cliente = await createRecord(RESOURCES.clientes, { nome: `Cliente B ${sufixo}` }, bruno);
    const venda = await createRecord(
      RESOURCES.vendas,
      { cliente_id: Number(cliente.id), data: '2026-10-06', status: 'aberta' },
      bruno
    );
    const produto = await createRecord(RESOURCES.produtos, { sku: `IT-${sufixo}`, nome: 'Item', preco_venda: 10 }, bruno);

    // INSERT direto, sem passar pela camada de serviço, e SEM informar empresa.
    const { rows } = await query(
      `INSERT INTO itens_venda (venda_id, produto_id, tamanho_id, quantidade, preco_unitario, subtotal)
       VALUES ($1, $2, NULL, 2, 10, 20) RETURNING empresa_id`,
      [Number(venda.id), Number(produto.id)]
    );
    assert.equal(Number(rows[0].empresa_id), B, 'o trigger precisa carimbar a empresa da venda-pai');
  });

  await t.test('trigger: adjustStock carimba a empresa do produto', async () => {
    const produto = await createRecord(RESOURCES.produtos, { sku: `EST-${sufixo}`, nome: 'Estoque', preco_venda: 10 }, ana);
    const { rows: tam } = await query(`SELECT id FROM tamanhos ORDER BY id LIMIT 1`);
    const tamanhoId = tam.length ? Number(tam[0].id) : null;
    if (tamanhoId === null) return; // base sem grade cadastrada

    const saldo = await getStore().adjustStock(Number(produto.id), tamanhoId, `pg-${sufixo}`, 7);
    assert.equal(Number(saldo.empresa_id), A);
    assert.equal(Number(saldo.quantidade), 7);
  });

  await t.test('o recorte por empresa é aplicado no SQL, não só no JavaScript', async () => {
    const lista = await listRecords(RESOURCES.produtos, { page: 1, pageSize: 500 }, ana);
    assert.ok(lista.rows.length > 0);
    assert.ok(lista.rows.every((r) => Number(r.empresa_id) === A), 'vazou produto de outra empresa');

    // O `total` também precisa refletir o recorte (senão a paginação denuncia
    // a existência dos registros alheios).
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM produtos WHERE empresa_id = $1`, [A]);
    assert.equal(lista.total, Number(rows[0].n));
  });

  await t.test('leitura por id de outra empresa responde 404 contra o banco real', async () => {
    const daB = await createRecord(RESOURCES.clientes, { nome: `Sigilo B ${sufixo}` }, bruno);
    await assert.rejects(
      () => getRecord(RESOURCES.clientes, Number(daB.id), ana),
      (e: any) => e.status === 404
    );
  });

  await t.test('o banco impede NF-e autorizada sem prova do provedor', async () => {
    // CHECK documentos_fiscais_autorizado_tem_prova: nem um INSERT manual
    // consegue inventar uma autorização fiscal.
    await assert.rejects(
      () =>
        query(
          `INSERT INTO documentos_fiscais (empresa_id, modelo, status, provider)
           VALUES ($1, '55', 'autorizado', 'nenhum')`,
          [A]
        ),
      (e: any) => e.code === '23514'
    );
  });
});
