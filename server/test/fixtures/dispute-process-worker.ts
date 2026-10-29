// Worker real em processo separado para verificar advisory lock em PostgreSQL.
process.env.NODE_ENV = 'test';
const { migrate, pool, isDbConnected } = await import('../../src/db');
await migrate();
if (!isDbConnected()) throw new Error('Banco indisponível no worker.');
process.send?.({ ready: true });
process.once('message', async (input: any) => {
  try {
    const { registerDispute } = await import('../../../modules/payments/application/disputes');
    let body: any; let status = 200;
    const response: any = { setHeader() {}, status(n: number) { status = n; return response; }, json(v: any) { body = v; return response; } };
    const request: any = { body: input.data, user: input.actor, params: {}, query: {}, get: () => input.key };
    await registerDispute(request, response);
    process.send?.({ ok: true, status, id: Number(body.dispute.id), idempotente: body.idempotente });
  } catch (e: any) { process.send?.({ ok: false, status: e.status, code: e.code, message: e.message }); }
  await pool?.end();
  process.disconnect?.();
});
