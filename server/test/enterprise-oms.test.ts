import { test } from 'node:test'; import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services'); const { RESOURCES } = await import('../src/resources');
const { expirarCheckoutsPendentes } = await import('../src/commerce/pedidos');

test('OMS: pedidos encerrados antes da página 2 não escondem checkout vencido', async () => {
  const s = getStore();
  for (let i = 0; i < 501; i++) await s.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', pedido_externo: `terminal-${i}`, estado: 'CANCELADO' });
  const due = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', pedido_externo: 'vencido', estado: 'AGUARDANDO_PAGAMENTO', expira_em: '2020-01-01T00:00:00.000Z' });
  await expirarCheckoutsPendentes(); assert.equal((await s.get(RESOURCES.commerce_pedidos, Number(due.id)))?.estado, 'EXPIRADO');
});

test('OMS: falha de liberação de cupom reverte a expiração inteira', async () => {
  const s = getStore(); const coupon = await s.insert(RESOURCES.commerce_cupons, { empresa_id: 1, codigo: 'TESTE-FALHA', tipo: 'valor', valor: 1, uso_atual: 1, ativo: true });
  const due = await s.insert(RESOURCES.commerce_pedidos, { empresa_id: 1, canal: 'BROBOND', pedido_externo: 'vencido-falha', estado: 'AGUARDANDO_PAGAMENTO', expira_em: '2020-01-01T00:00:00.000Z', cupom_codigo: 'TESTE-FALHA' });
  const original = s.tryUpdateIf.bind(s);
  s.tryUpdateIf = async (r, id, expected, data, tx) => { if (r.key === 'commerce_cupons') throw new Error('falha simulada'); return original(r, id, expected, data, tx); };
  try { await assert.rejects(() => expirarCheckoutsPendentes(), /falha simulada/); }
  finally { s.tryUpdateIf = original; }
  assert.equal((await s.get(RESOURCES.commerce_pedidos, Number(due.id)))?.estado, 'AGUARDANDO_PAGAMENTO');
  assert.equal((await s.get(RESOURCES.commerce_cupons, Number(coupon.id)))?.uso_atual, 1);
  await expirarCheckoutsPendentes(); assert.equal((await s.get(RESOURCES.commerce_pedidos, Number(due.id)))?.estado, 'EXPIRADO');
  assert.equal((await s.get(RESOURCES.commerce_cupons, Number(coupon.id)))?.uso_atual, 0);
});
