process.env.NODE_ENV = 'test';
const f = JSON.parse(process.env.CLOSURE_REC_FIXTURE || '{}');
const { migrate } = await import('../../src/db'); await migrate();
const { processarRecorrencias } = await import('../../src/financeiro');
process.send?.({ type: 'ready' });
process.on('message', async (msg) => { if (msg !== 'go') return;
  try { const result = await processarRecorrencias(f.actor, f.scope); process.send?.({ type: 'result', ok: true, result }); }
  catch (e: any) { process.send?.({ type: 'result', ok: false, status: e.status || e.code || 'unknown' }); }
});
