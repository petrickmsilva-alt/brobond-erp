process.env.NODE_ENV = 'test';
const f = JSON.parse(process.env.CLOSURE_CNAB_FIXTURE || '{}');
const { migrate } = await import('../../src/db'); await migrate();
const { importarCnab } = await import('../../src/cnab');
process.send?.({ type: 'ready' });
process.on('message', async (msg) => {
  if (msg !== 'go') return;
  try {
    let result: unknown;
    await importarCnab({ user: f.actor, body: { conta_id: f.account, conteudo: f.content }, params: {}, query: {} } as any,
      { json(value: unknown) { result = value; return this; } } as any);
    process.send?.({ type: 'result', ok: true, result });
  } catch (e: any) { process.send?.({ type: 'result', ok: false, status: e.status || e.code || 'unknown', message: String(e.message || '') }); }
});
