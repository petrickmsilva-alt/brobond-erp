// R-10 (Fase 4.3) — rota pública de webhook do gateway (POST /api/gateway/webhooks/pagbank).
// LOCAL: store em memória, sem rede. Verifica que o access token NUNCA vira segredo de webhook:
// sem PAGBANK_WEBHOOK_SECRET cadastrado, a notificação é recusada (falha fechada), mesmo com
// x-authenticity-token calculado com o token da conta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const gateway: any = await import('../src/gateway');
const { getStore } = await import('../src/services');
const { cifrarSegredo } = await import('../src/segredos');
const s: any = getStore();

const sufixo = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const EMP = 1;
const TOKEN_CONTA = `tok-conta-${sufixo}`;
const REF = `ORDE_R10_${sufixo}`;

async function cenario(comSegredoProprio: boolean) {
  const antigas = await s.list(gateway.R_GATEWAY_CONFIGS, { page: 1, pageSize: 100 });
  for (const c of antigas.rows) await s.remove(gateway.R_GATEWAY_CONFIGS, Number(c.id));
  const cobsAntigas = await s.list(gateway.R_GATEWAY_COBRANCAS, { page: 1, pageSize: 100, filter: { provider_ref: REF } });
  for (const c of cobsAntigas.rows) await s.remove(gateway.R_GATEWAY_COBRANCAS, Number(c.id));
  await s.insert(gateway.R_GATEWAY_CONFIGS, {
    empresa_id: EMP,
    provider: 'pagbank',
    ativo: true,
    ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: TOKEN_CONTA })),
    webhook_segredo_cifrado: comSegredoProprio ? cifrarSegredo(`segredo-proprio-${sufixo}`) : null,
  });
  await s.insert(gateway.R_GATEWAY_COBRANCAS, {
    empresa_id: EMP, provider: 'pagbank', provider_ref: REF, status: 'pendente', valor: 10, metodo: 'pix',
  });
}

function app() {
  const a = express();
  a.use(gateway.publicGatewayRouter);
  return a;
}

const corpo = JSON.stringify({ id: REF, status: 'PAID' });
// Assinatura no formato documentado pelo provedor: SHA-256 hex de "{token}-{corpo cru}", com o token da conta.
const assinaturaComToken = createHash('sha256').update(`${TOKEN_CONTA}-${corpo}`).digest('hex');

test('R-10: sem PAGBANK_WEBHOOK_SECRET cadastrado, assinatura calculada com o access token é recusada (401)', { timeout: 20000 }, async () => {
  await cenario(false);
  const r = await request(app())
    .post('/api/gateway/webhooks/pagbank')
    .set('Content-Type', 'application/json')
    .set('x-authenticity-token', assinaturaComToken)
    .send(corpo);
  assert.equal(r.status, 401, `falha fechada esperada; recebido ${r.status}`);
  const eventos = await s.list(gateway.R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 20, filter: { provider: 'pagbank' } });
  assert.equal(eventos.rows.filter((e: any) => e.assinatura_ok === true).length, 0, 'nenhum evento com assinatura aceita');
  const cob = (await s.list(gateway.R_GATEWAY_COBRANCAS, { page: 1, pageSize: 5, filter: { provider_ref: REF } })).rows[0];
  assert.equal(cob.status, 'pendente', 'cobrança intocada');
});

test('R-10: sem segredo próprio, assinatura inválida também é recusada (controle negativo)', { timeout: 20000 }, async () => {
  await cenario(false);
  const r = await request(app())
    .post('/api/gateway/webhooks/pagbank')
    .set('Content-Type', 'application/json')
    .set('x-authenticity-token', '0'.repeat(64))
    .send(corpo);
  assert.equal(r.status, 401);
});
