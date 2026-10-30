process.env.NODE_ENV = 'test';
const { migrate } = await import('../../src/db'); await migrate();
const gateway = await import('../../src/gateway');
const { escopoDeSistema } = await import('../../src/empresa');
gateway.mockProvider.criaCobranca = async () => {
  // Simula término após a reserva, antes de uma resposta externa definitiva.
  if (process.send) process.send({ type: 'reserved' }, () => process.exit(73));
  return new Promise<never>(() => {});
};
const empresa = Number(process.env.CRASH_COMPANY);
await gateway.criarCobrancaGateway(escopoDeSistema(empresa), {
  provider: 'mock', metodo: 'pix', valor: 27, idempotencyKey: 'legacy-create-crash-pg', actor: { id: null, name: 'Worker PG' },
});
