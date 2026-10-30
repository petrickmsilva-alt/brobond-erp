// Worker independente para provar a trava PostgreSQL entre processos.
process.env.NODE_ENV = 'test';
const f = JSON.parse(process.env.CLOSURE_EXTRATO_FIXTURE || '{}');
const { migrate } = await import('../../src/db');
await migrate();
const { conciliarLinhaManual } = await import('../../src/extrato');
process.send?.({ type: 'ready' });
process.on('message', async (msg) => {
  if (msg !== 'go') return;
  try {
    let result: any;
    await conciliarLinhaManual({ user: f.actor, params: { id: f.bank }, body: { lancamento_id: f.title }, query: {} } as any,
      { json(value: unknown) { result = value; return this; } } as any);
    process.send?.({ type: 'result', ok: true, result });
  } catch (e: any) { process.send?.({ type: 'result', ok: false, status: e.status || e.code || 'unknown' }); }
});
