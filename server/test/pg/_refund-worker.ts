// Independent processes exercise the PostgreSQL operation claim; the only
// simulated provider write is announced to the parent and never repeated.
const fixture = JSON.parse(process.env.CLOSURE_REFUND_FIXTURE || '{}');
const { migrate, pool } = await import('../../src/db'); await migrate();
const { providerRegistry } = await import('../../../modules/payments/providers/registry');
const { paymentEngine } = await import('../../../modules/payments/orchestration/payment-orchestrator');
const provider = providerRegistry.get('MERCADO_PAGO');
provider.refund = async (_ctx, ref, amount) => {
  process.send?.({ type: 'write' });
  await new Promise<void>((resolve) => { const onMessage = (m: unknown) => { if (m === 'release') { process.off('message', onMessage); resolve(); } }; process.on('message', onMessage); });
  return { reference: ref, status: 'PARTIALLY_REFUNDED', amount: 10000, currency: 'BRL', refunded: amount,
    refundEvidence: { reference: `cross-process-${ref}`, paymentReference: ref, amount, status: 'SUCCEEDED' } };
};
process.send?.({ type: 'ready' });
process.on('message', async (message) => {
  if (message !== 'go') return;
  try { await paymentEngine.mutate(fixture.company, fixture.intent, 'refund', 'cross-process-refund', 3000); process.send?.({ type: 'result', ok: true }); }
  catch (error: any) { process.send?.({ type: 'result', ok: false, status: error?.status, code: error?.code }); }
  await pool?.end(); process.disconnect?.();
});
