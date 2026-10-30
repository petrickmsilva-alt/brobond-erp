// A separate process tests an advisory-lock waiter with its own PG snapshot.
const fixture = JSON.parse(process.env.CLOSURE_APPLY_FIXTURE || '{}');
const { migrate, pool } = await import('../../src/db'); await migrate();
const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
if (fixture.pauseSettlement) {
  const { getStore } = await import('../../src/services'); const store = getStore();
  const original = store.insert.bind(store); let trapped = false;
  store.insert = async (resource, value, tx) => {
    const row = await original(resource, value, tx);
    if (!trapped && resource.key === 'payment_settlements' && Number(value.payment_intent_id) === fixture.intent) {
      trapped = true; process.send?.({ type: 'settlement-inserted' });
      await new Promise<void>((resolve) => { const handler = (m: unknown) => { if (m === 'release') { process.off('message', handler); resolve(); } }; process.on('message', handler); });
    }
    return row;
  };
}
process.send?.({ type: 'ready' });
process.on('message', async (message) => {
  if (message !== 'go') return;
  process.send?.({ type: 'applying' });
  try {
    await paymentEngine.apply(fixture.company, fixture.intent, { reference: fixture.ref, status: 'PAID', amount: 10000, currency: 'BRL', refunded: 0 });
    process.send?.({ type: 'result', ok: true });
  } catch (error: any) { process.send?.({ type: 'result', ok: false, status: error?.status, code: error?.code }); }
  await pool?.end(); process.disconnect?.();
});
