import { test } from 'node:test';
import assert from 'node:assert/strict';

const skip = process.env.DATABASE_URL ? false : 'requer PostgreSQL real';
process.env.NODE_ENV = 'test';

function request(empresaId: number, query: Record<string, unknown> = {}) {
  return {
    user: { id: 1, name: 'Pagamentos PG spec', perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] },
    query,
    params: {},
    body: {},
  } as any;
}

function response() {
  const body: { value?: any; headers: Record<string, string> } = { headers: {} };
  const res = {
    json(value: unknown) { body.value = value; return res; },
    setHeader(name: string, value: string) { body.headers[name] = value; return res; },
  };
  return { res: res as any, body };
}

test('PG commerce/pagamentos: vínculo além de 1000 pedidos, paginação e tenant', { skip }, async () => {
  const db = await import('../../src/db');
  await db.migrate();
  assert.equal(db.isDbConnected(), true, String(db.bootFailure()?.mensagem));
  const { listarPagamentosCommerce } = await import('../../src/commerce/pedidos');
  const ref = `pagamentos-projecao-${Date.now()}-${process.pid}`;
  const empresaB = Number((await db.query('INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id', [`Empresa B ${ref}`])).rows[0].id);
  const charge = (await db.query(
    `INSERT INTO gateway_cobrancas (empresa_id,provider,metodo,valor,status,provider_ref,idempotency_key)
     VALUES (1,'legado-pg','pix',80,'paga',$1,$2) RETURNING id`,
    [`provider-${ref}`, ref]
  )).rows[0];
  await db.query(
    `INSERT INTO gateway_cobrancas (empresa_id,provider,metodo,valor,status,provider_ref,idempotency_key)
     VALUES ($1,'legado-pg','pix',999,'paga',$2,$3)`,
    [empresaB, `provider-b-${ref}`, `b-${ref}`]
  );
  await db.query(
    `INSERT INTO commerce_pedidos (empresa_id,canal,pedido_externo,estado,total)
     SELECT 1,'BROBOND',$1 || '-' || n,'PAGO',1 FROM generate_series(1,1001) AS n`,
    [ref]
  );
  await db.query(
    `INSERT INTO commerce_pedidos (empresa_id,canal,pedido_externo,estado,total,cobranca_id)
     VALUES (1,'BROBOND',$1,'PAGO',80,$2)`,
    [`PEDIDO-PG-ALEM-1000-${ref}`, charge.id]
  );

  const atual = response();
  await listarPagamentosCommerce(request(1, { provider: 'legado-pg', page: 1, pageSize: 1 }), atual.res);
  assert.equal(atual.body.value.total, 1);
  assert.equal(atual.body.value.pageSize, 1);
  assert.equal(atual.body.value.pagamentos[0].pedido.pedido_externo, `PEDIDO-PG-ALEM-1000-${ref}`);
  assert.equal(atual.body.value.pagamentos[0].pedido.sale_id, null);
  assert.equal(atual.body.value.pagamentos[0].provider_ref, undefined);
  assert.equal(atual.body.headers['Cache-Control'], 'private, no-store');

  const outroTenant = response();
  await listarPagamentosCommerce(request(empresaB, { provider: 'legado-pg' }), outroTenant.res);
  assert.equal(outroTenant.body.value.total, 1);
  assert.equal(outroTenant.body.value.pagamentos[0].valor, 999);
  assert.equal(outroTenant.body.value.pagamentos[0].pedido, null);
});
