// Fase 2 — segurança e credenciais (sem rede, sem credenciais reais).
//   • webhooks fail-closed (ML, Mercado Pago do conector e legado);
//   • deduplicação do ML sem colisão entre eventos distintos;
//   • P2-10: conflito de evento_id não revela existência sem assinatura válida;
//   • cifra: chave primária + legadas para leitura (compatibilidade), sem
//     fallback de desenvolvimento em produção, diagnóstico sem valores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { createWebhookHandlers } = await import('../../modules/connectors/webhooks/handlers');
const { WebhookSignatureError } = await import('../../modules/connectors/core/errors');
const { verifyMercadoPagoWebhookSignature } = await import('../../modules/connectors/mercadopago/mercadopago.service');
const chaves = await import('../src/chavesCifra');
const segredos = await import('../src/segredos');
const mfa = await import('../src/mfa');

const CHAVES = ['MERCADOLIVRE_WEBHOOK_SECRET', 'MERCADOPAGO_WEBHOOK_SECRET', 'SEGREDOS_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY', 'JWT_SECRET', 'NODE_ENV'] as const;

/** Executa `fn` com as variáveis dadas e restaura o ambiente original depois. */
async function comEnv<T>(valores: Partial<Record<(typeof CHAVES)[number], string | undefined>>, fn: () => Promise<T> | T): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const nome of CHAVES) original[nome] = process.env[nome];
  for (const [nome, valor] of Object.entries(valores)) {
    if (valor === undefined) delete process.env[nome]; else process.env[nome] = valor;
  }
  chaves.limparCacheChaves();
  try {
    return await fn();
  } finally {
    for (const nome of CHAVES) {
      if (original[nome] === undefined) delete process.env[nome]; else process.env[nome] = original[nome];
    }
    chaves.limparCacheChaves();
  }
}

function repositorioEspiao() {
  const chamadas: string[] = [];
  const registrar = (nome: string) => async () => { chamadas.push(nome); return null; };
  return {
    chamadas,
    repository: {
      findByShopId: async () => { chamadas.push('findByShopId'); return { id: 1, empresaId: 1, usuarioId: 1 }; },
      hasEvent: async () => false,
      recordEvent: async () => { chamadas.push('recordEvent'); },
      markEventProcessed: async () => { chamadas.push('markEventProcessed'); },
      findEvent: registrar('findEvent'),
    } as any,
    ingestion: { processSaleIngestionEvent: async () => ({ status: 'ok', outcome: 'ok', saleId: '1' }) } as any,
  };
}

const corpoMl = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ topic: 'orders_v2', resource: '/orders/123', user_id: 42, ...extra });

// ----------------------------------------------------------------------------
// Mercado Livre — fail-closed e deduplicação
// ----------------------------------------------------------------------------

test('ML: sem MERCADOLIVRE_WEBHOOK_SECRET a entrega é recusada e nada é gravado', async () => {
  await comEnv({ MERCADOLIVRE_WEBHOOK_SECRET: undefined }, async () => {
    const espiao = repositorioEspiao();
    const handlers = createWebhookHandlers({ repository: espiao.repository, ingestion: espiao.ingestion });
    await assert.rejects(
      handlers.handleProviderWebhook('MERCADOLIVRE', { headers: {}, query: {}, rawBody: corpoMl() }),
      (e: unknown) => e instanceof WebhookSignatureError
    );
    assert.deepEqual(espiao.chamadas, [], 'nenhuma consulta nem gravação sem autenticação');
  });
});

test('ML: segredo presente mas errado ou ausente na URL é recusado', async () => {
  await comEnv({ MERCADOLIVRE_WEBHOOK_SECRET: 'segredo-ml-teste-0123456789' }, async () => {
    const espiao = repositorioEspiao();
    const handlers = createWebhookHandlers({ repository: espiao.repository, ingestion: espiao.ingestion });
    for (const query of [{}, { secret: 'errado' }]) {
      await assert.rejects(
        handlers.handleProviderWebhook('MERCADOLIVRE', { headers: {}, query, rawBody: corpoMl() }),
        (e: unknown) => e instanceof WebhookSignatureError
      );
    }
    assert.deepEqual(espiao.chamadas, []);
    const ok = await handlers.handleProviderWebhook('MERCADOLIVRE', { headers: {}, query: { secret: 'segredo-ml-teste-0123456789' }, rawBody: corpoMl() });
    assert.equal(ok.received, true);
    assert.ok(espiao.chamadas.includes('recordEvent'));
  });
});

test('ML: eventos distintos do mesmo recurso não colidem na deduplicação; reentrega idêntica colide', async () => {
  await comEnv({ MERCADOLIVRE_WEBHOOK_SECRET: 'segredo-ml-teste-0123456789' }, async () => {
    const gravados: string[] = [];
    const repository = {
      findByShopId: async () => ({ id: 1, empresaId: 1, usuarioId: 1 }),
      hasEvent: async (_e: number, _u: number, _p: string, id: string) => gravados.includes(id),
      recordEvent: async (_e: number, _u: number, evento: { externalEventId: string }) => { gravados.push(evento.externalEventId); },
      markEventProcessed: async () => {},
    } as any;
    const handlers = createWebhookHandlers({ repository, ingestion: repositorioEspiao().ingestion });
    const req = (rawBody: string) => ({ headers: {}, query: { secret: 'segredo-ml-teste-0123456789' }, rawBody });
    const pausado = await handlers.handleProviderWebhook('MERCADOLIVRE', req(corpoMl({ status: 'paused' })));
    const reativado = await handlers.handleProviderWebhook('MERCADOLIVRE', req(corpoMl({ status: 'active' })));
    assert.equal(pausado.duplicate, undefined);
    assert.equal(reativado.duplicate, undefined, 'evento distinto do mesmo recurso não pode ser descartado');
    const reentrega = await handlers.handleProviderWebhook('MERCADOLIVRE', req(corpoMl({ status: 'paused' })));
    assert.equal(reentrega.duplicate, true, 'reentrega idêntica continua deduplicada');
    assert.equal(new Set(gravados).size, 2);
  });
});

// ----------------------------------------------------------------------------
// Mercado Pago (conector) — fail-closed
// ----------------------------------------------------------------------------

test('Mercado Pago (conector): sem MERCADOPAGO_WEBHOOK_SECRET nenhuma assinatura é aceita', async () => {
  await comEnv({ MERCADOPAGO_WEBHOOK_SECRET: undefined }, () => {
    assert.equal(verifyMercadoPagoWebhookSignature({ dataId: '1', xSignature: 'ts=1,v1=00', xRequestId: 'r' }), false);
    assert.equal(verifyMercadoPagoWebhookSignature({ dataId: '1', xSignature: null, xRequestId: null }), false);
  });
});

test('Mercado Pago (conector): com segredo, assinatura válida passa e inválida falha', async () => {
  await comEnv({ MERCADOPAGO_WEBHOOK_SECRET: 'mp-teste-segredo-0123456789' }, () => {
    const ts = '1700000000';
    const v1 = createHmac('sha256', 'mp-teste-segredo-0123456789').update(`id:abc;request-id:req-1;ts:${ts};`).digest('hex');
    assert.equal(verifyMercadoPagoWebhookSignature({ dataId: 'abc', xSignature: `ts=${ts},v1=${v1}`, xRequestId: 'req-1' }), true);
    assert.equal(verifyMercadoPagoWebhookSignature({ dataId: 'abc', xSignature: `ts=${ts},v1=${'0'.repeat(64)}`, xRequestId: 'req-1' }), false);
  });
});

test('Mercado Pago (conector): entrega pelo tratador é recusada sem segredo', async () => {
  await comEnv({ MERCADOPAGO_WEBHOOK_SECRET: undefined }, async () => {
    const espiao = repositorioEspiao();
    const handlers = createWebhookHandlers({ repository: espiao.repository, ingestion: espiao.ingestion });
    const corpo = JSON.stringify({ id: 9, type: 'payment', data: { id: '55' } });
    await assert.rejects(
      handlers.handleProviderWebhook('MERCADOPAGO', { headers: { 'x-signature': 'ts=1,v1=00', 'x-request-id': 'r' }, query: {}, rawBody: corpo }),
      (e: unknown) => e instanceof WebhookSignatureError
    );
    assert.deepEqual(espiao.chamadas, []);
  });
});

// ----------------------------------------------------------------------------
// P2-10 — gateway legado: conflito de evento não revela existência sem assinatura
// ----------------------------------------------------------------------------

test('P2-10: evento de outra cobrança responde 401 uniforme sem assinatura e 409 só com assinatura válida', async () => {
  const { getStore } = await import('../src/services');
  const gw = await import('../src/gateway');
  const { mercadopagoProvider } = await import('../../modules/payments/providers/mercado-pago/legacy');
  const s = getStore();
  const SEGREDO = 'segredo-p210-0123456789';
  const dataId = 'P210-COBRANCA';
  const corpo = JSON.stringify({ id: 'P210-EVT', type: 'payment', data: { id: dataId } });
  const ts = '1793293200';
  const reqId = 'req-p210';
  const assinar = (segredo: string) => createHmac('sha256', segredo).update(`id:${dataId.toLowerCase()};request-id:${reqId};ts:${ts};`).digest('hex');

  await s.insert(gw.R_GATEWAY_CONFIGS, { empresa_id: 1, provider: 'mercadopago', ativo: true, ambiente: 'teste', webhook_segredo_cifrado: segredos.cifrarSegredo(SEGREDO) });
  await s.insert(gw.R_GATEWAY_COBRANCAS, { empresa_id: 1, provider: 'mercadopago', provider_ref: dataId, status: 'pendente' });
  const eventoId = mercadopagoProvider.parseWebhook(corpo)?.evento_id;
  assert.ok(eventoId, 'fixture: evento parseável');
  const alheio = await s.insert(gw.R_GATEWAY_WEBHOOK_EVENTS, {
    empresa_id: 2, provider: 'mercadopago', evento_id: eventoId, evento: 'payment', status: 'recebido', assinatura_ok: true,
    payload: { id: 'P210-EVT', data: { id: 'OUTRA-COBRANCA' } }, recebido_em: new Date().toISOString(),
  });

  const app = express();
  app.use(gw.publicGatewayRouter);
  const enviar = (assinatura: string) => request(app).post('/api/gateway/webhooks/mercadopago')
    .set('Content-Type', 'application/json').set('x-request-id', reqId).set('x-signature', `ts=${ts},v1=${assinatura}`).send(corpo);

  const semAssinatura = await enviar('0'.repeat(64));
  assert.equal(semAssinatura.status, 401, 'sem assinatura válida não pode haver 409 (sondagem de evento_id)');
  assert.equal(semAssinatura.body.error, 'Assinatura inválida.');
  assert.equal(String(semAssinatura.text).includes('outra cobrança'), false);
  const intacto = await s.get(gw.R_GATEWAY_WEBHOOK_EVENTS, Number(alheio.id));
  assert.equal(Number(intacto?.empresa_id), 2, 'registro de outra empresa não é tocado por requisição não autenticada');

  const comAssinatura = await enviar(assinar(SEGREDO));
  assert.equal(comAssinatura.status, 409, 'quem prova o segredo recebe o conflito real');
  assert.equal(comAssinatura.body.error, 'Evento já registrado para outra cobrança.');
});

test('legado Mercado Pago: sem segredo a assinatura nunca é aceita', async () => {
  const { mercadopagoProvider } = await import('../../modules/payments/providers/mercado-pago/legacy');
  const ctx = { webhookSegredo: null } as any;
  const ts = '1';
  assert.equal(mercadopagoProvider.verificaAssinatura(ctx, '{"data":{"id":"1"}}', { 'x-signature': `ts=${ts},v1=00`, 'x-request-id': 'r' }), false);
});

// ----------------------------------------------------------------------------
// Cifra — chave primária, legadas só para leitura, produção sem fallback
// ----------------------------------------------------------------------------

test('cifra: valor gravado com a chave legada (JWT) continua legível após definir chave dedicada', async () => {
  let antigo = '';
  await comEnv({ JWT_SECRET: 'jwt-legado-0123456789abcdef0123', SEGREDOS_ENCRYPTION_KEY: undefined, MFA_ENCRYPTION_KEY: undefined }, () => {
    antigo = segredos.cifrarSegredo('token-fiscal-antigo')!;
    const codigoAntigo = mfa.cifrarSegredoMfa('TOTP-ANTIGO');
    assert.equal(segredos.decifrarSegredo(antigo), 'token-fiscal-antigo');
    assert.equal(mfa.decifrarSegredoMfa(codigoAntigo), 'TOTP-ANTIGO');
  });
  await comEnv({ JWT_SECRET: 'jwt-legado-0123456789abcdef0123', SEGREDOS_ENCRYPTION_KEY: 'chave-dedicada-nova-0123456789', MFA_ENCRYPTION_KEY: 'mfa-dedicada-nova-0123456789' }, () => {
    assert.equal(segredos.decifrarSegredo(antigo), 'token-fiscal-antigo', 'leitura legada preservada');
    const novo = segredos.cifrarSegredo('token-fiscal-novo')!;
    assert.notEqual(novo, antigo);
    assert.equal(segredos.decifrarSegredo(novo), 'token-fiscal-novo');
    const diag = chaves.diagnosticoChaves();
    assert.equal(diag.find((d) => d.dominio === 'segredos')?.fonte, 'dedicada');
    assert.equal(diag.find((d) => d.dominio === 'segredos')?.legadaDisponivel, true);
  });
});

test('cifra: texto adulterado ou com chave trocada devolve null, sem lançar', async () => {
  await comEnv({ JWT_SECRET: 'jwt-legado-0123456789abcdef0123', SEGREDOS_ENCRYPTION_KEY: undefined }, () => {
    const cifrado = segredos.cifrarSegredo('abc')!;
    const [v, iv, tag, dados] = cifrado.split('.');
    assert.equal(segredos.decifrarSegredo(`${v}.${iv}.${tag}.${dados.slice(0, -2)}AA`), null);
    assert.equal(segredos.decifrarSegredo('v9.x.y.z'), null);
  });
});

test('produção sem nenhuma chave: cifrar falha, decifrar devolve null e o literal de desenvolvimento não é usado', async () => {
  await comEnv({ NODE_ENV: 'production', JWT_SECRET: undefined, SEGREDOS_ENCRYPTION_KEY: undefined, APP_ENCRYPTION_KEY: undefined, MFA_ENCRYPTION_KEY: undefined }, () => {
    assert.throws(() => segredos.cifrarSegredo('x'), chaves.ErroChaveCifra);
    assert.throws(() => mfa.cifrarSegredoMfa('x'), chaves.ErroChaveCifra);
    assert.throws(() => chaves.segredoJwt(), chaves.ErroChaveCifra);
    assert.equal(segredos.decifrarSegredo('v1.AAAA.AAAA.AAAA'), null);
    const diag = chaves.diagnosticoChaves();
    assert.ok(diag.every((d) => d.fonte === 'ausente'));
  });
});

test('produção com JWT mas sem chave dedicada: usa a derivação legada (sem quebrar instalações atuais)', async () => {
  await comEnv({ NODE_ENV: 'production', JWT_SECRET: 'jwt-prod-0123456789abcdef0123', SEGREDOS_ENCRYPTION_KEY: undefined, MFA_ENCRYPTION_KEY: undefined }, () => {
    const cifrado = segredos.cifrarSegredo('credencial')!;
    assert.equal(segredos.decifrarSegredo(cifrado), 'credencial');
    assert.equal(segredos.chaveFraca(), true, 'aviso operacional continua ativo');
    assert.equal(chaves.diagnosticoChaves().find((d) => d.dominio === 'mfa')?.fonte, 'derivada_jwt');
  });
});

test('diagnóstico de chaves não expõe valores', async () => {
  await comEnv({ JWT_SECRET: 'valor-secreto-jwt-0123456789abcdef', SEGREDOS_ENCRYPTION_KEY: 'valor-secreto-segredos-0123456789' }, () => {
    const texto = JSON.stringify(chaves.diagnosticoChaves());
    assert.equal(texto.includes('valor-secreto'), false);
  });
});

test('desenvolvimento sem nenhuma chave: fallback documentado continua funcionando (fora de produção)', async () => {
  await comEnv({ JWT_SECRET: undefined, SEGREDOS_ENCRYPTION_KEY: undefined, APP_ENCRYPTION_KEY: undefined, MFA_ENCRYPTION_KEY: undefined }, () => {
    assert.equal(segredos.decifrarSegredo(segredos.cifrarSegredo('dev')), 'dev');
    assert.notEqual(chaves.segredoJwt(), chaves.SEGREDO_DESENVOLVIMENTO);
    assert.ok(chaves.segredoJwt().length >= 32);
  });
});
