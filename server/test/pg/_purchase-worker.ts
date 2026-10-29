// Child process for the PostgreSQL advisory-lock/idempotency race test.
const fixture = JSON.parse(process.env.WAVE2_PURCHASE_FIXTURE || '{}');
const { migrate, pool } = await import('../../src/db');
await migrate();
const { receberParcial } = await import('../../src/compras');
process.send?.({ type: 'ready' });
process.once('message', async () => {
  const out: any = {};
  const res: any = { status(code: number) { out.status = code; return this; }, json(body: any) { out.body = body; return this; } };
  try {
    await receberParcial({ user: fixture.actor, params: { id: fixture.purchase }, query: {},
      header: () => undefined, body: { itens: [{ item_compra_id: fixture.item, quantidade: 5 }], idempotency_key: 'process-race' } } as any, res);
    process.send?.({ type: 'result', status: out.status, id: out.body?.recebimento_id, replay: out.body?.idempotente });
  } catch (error: any) { process.send?.({ type: 'error', status: error?.status || 500 }); }
  await pool?.end();
  process.disconnect?.();
});
