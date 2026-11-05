import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { listarPagamentosCommerce } = await import('../src/commerce/pedidos');
const { R_GATEWAY_COBRANCAS } = await import('../src/gateway');
const { RESOURCES } = await import('../src/resources');

function request(empresaId = 1, query: Record<string, unknown> = {}) {
  return {
    user: { id: 1, name: 'Pagamentos spec', perfil: 'admin', empresa_id: empresaId },
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

test('GET commerce/pagamentos lista cobranças reais, projeta pedido e isola tenant sem erro 500', async () => {
  const store = getStore();
  const sale = await store.insert(RESOURCES.sales, {
    id: 'pagamentos-api-spec', empresa_id: 1, usuario_id: 1, status: 'PAID', amount_cents: 8000,
    currency: 'BRL', channel: 'BROBOND', external_order_id: 'LOJA-PAGAMENTOS-SPEC', quantity: 1,
  });
  const charge = await store.insert(R_GATEWAY_COBRANCAS, {
    empresa_id: 1, provider: 'mercadopago', metodo: 'pix', valor: 80, status: 'paga',
    provider_ref: 'mp-pagamentos-api-spec', idempotency_key: 'pagamentos-api-spec',
  });
  await store.insert(RESOURCES.commerce_pedidos, {
    empresa_id: 1, canal: 'BROBOND', sale_id: sale.id, pedido_externo: 'LOJA-PAGAMENTOS-SPEC',
    cobranca_id: charge.id, estado: 'PAGO', total: 80,
  });
  await store.insert(R_GATEWAY_COBRANCAS, {
    empresa_id: 2, provider: 'mercadopago', metodo: 'pix', valor: 999, status: 'paga',
    provider_ref: 'mp-outro-tenant-spec', idempotency_key: 'pagamentos-outro-tenant-spec',
  });

  const { res, body } = response();
  await listarPagamentosCommerce(request(), res);
  assert.equal(body.value.total, 1);
  assert.equal(body.value.pagamentos[0].cobranca_id, Number(charge.id));
  assert.equal(body.value.pagamentos[0].status, 'APPROVED');
  assert.equal(body.value.pagamentos[0].pedido.sale_id, sale.id);
  assert.equal(body.headers['Cache-Control'], 'private, no-store');

  const empty = response();
  await listarPagamentosCommerce(request(99), empty.res);
  assert.deepEqual(empty.body.value.pagamentos, []);
  assert.equal(empty.body.value.total, 0);
});

test('GET commerce/pagamentos vincula pedido além dos primeiros 1000 registros do tenant', async () => {
  const store = getStore();
  const charge = await store.insert(R_GATEWAY_COBRANCAS, {
    empresa_id: 1, provider: 'legado', metodo: 'pix', valor: 80, status: 'paga',
    provider_ref: 'ref-antiga-spec', idempotency_key: 'pagamentos-antigo-spec',
  });
  for (let n = 0; n < 1001; n += 1) {
    await store.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', pedido_externo: `SEM-COBRANCA-${n}`, estado: 'PAGO', total: 1 });
  }
  await store.insert(RESOURCES.commerce_pedidos, {
    empresa_id: 1, canal: 'BROBOND', sale_id: 'SAL-ANTIGA-SPEC', pedido_externo: 'PEDIDO-ALEM-DE-1000',
    cobranca_id: charge.id, estado: 'PAGO', total: 80,
  });
  const { res, body } = response();
  await listarPagamentosCommerce(request(1, { provider: 'legado' }), res);
  assert.equal(body.value.total, 1);
  assert.equal(body.value.pagamentos[0].pedido.pedido_externo, 'PEDIDO-ALEM-DE-1000');
});

test('GET commerce/pagamentos aplica status, provider, método e paginação no backend', async () => {
  const store = getStore();
  await store.insert(R_GATEWAY_COBRANCAS, {
    empresa_id: 1, provider: 'mercadopago', metodo: 'pix', valor: 80, status: 'pendente',
    provider_ref: 'mp-pagamentos-pending-spec', idempotency_key: 'pagamentos-pending-spec',
  });
  await store.insert(R_GATEWAY_COBRANCAS, {
    empresa_id: 1, provider: 'pagbank', metodo: 'boleto', valor: 50, status: 'pendente',
    provider_ref: 'pb-pagamentos-pending-spec', idempotency_key: 'pagamentos-boleto-spec',
  });

  const filtered = response();
  await listarPagamentosCommerce(request(1, { status: 'PENDING', provider: 'mercadopago', metodo: 'pix', page: 1, pageSize: 1 }), filtered.res);
  assert.equal(filtered.body.value.total, 1);
  assert.equal(filtered.body.value.pageSize, 1);
  assert.equal(filtered.body.value.pagamentos[0].provider_ref, undefined, 'projeção não vaza payload/referência desnecessária');
  assert.equal(filtered.body.value.pagamentos[0].status_gateway, 'pendente');

  const paid = response();
  await listarPagamentosCommerce(request(1, { status: 'APPROVED' }), paid.res);
  assert.ok(paid.body.value.pagamentos.every((p: any) => p.status_gateway === 'paga'));
  await assert.rejects(() => listarPagamentosCommerce(request(1, { status: 'INVENTED' }), response().res), (e: any) => e.status === 400);
  await assert.rejects(() => listarPagamentosCommerce(request(1, { page: 'not-a-number' }), response().res), (e: any) => e.status === 400);
});
