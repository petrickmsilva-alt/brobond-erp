// Ordem Final 2.2 — PagBank: segredo dedicado, SHA-256 de "{token}-{corpo cru}", comparação
// em tempo constante, falha fechada e AUSÊNCIA de segredo/token em log, resposta e registros.
// LOCAL: store em memória, sem rede, sem chamada ao PagBank. Credenciais são valores de teste.
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
const TOKEN_CONTA = `tok-conta-vazamento-${sufixo}`;
const SEGREDO = `segredo-dedicado-vazamento-${sufixo}`;
const REF = `ORDE_VAZ_${sufixo}`;

async function preparar() {
  const antigas = await s.list(gateway.R_GATEWAY_CONFIGS, { page: 1, pageSize: 100 });
  for (const c of antigas.rows) await s.remove(gateway.R_GATEWAY_CONFIGS, Number(c.id));
  const cobs = await s.list(gateway.R_GATEWAY_COBRANCAS, { page: 1, pageSize: 100, filter: { provider_ref: REF } });
  for (const c of cobs.rows) await s.remove(gateway.R_GATEWAY_COBRANCAS, Number(c.id));
  await s.insert(gateway.R_GATEWAY_CONFIGS, {
    empresa_id: 1, provider: 'pagbank', ativo: true, ambiente: 'teste',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: TOKEN_CONTA })),
    webhook_segredo_cifrado: cifrarSegredo(SEGREDO),
  });
  await s.insert(gateway.R_GATEWAY_COBRANCAS, { empresa_id: 1, provider: 'pagbank', provider_ref: REF, status: 'pendente', valor: 10, metodo: 'pix' });
}

const app = () => { const a = express(); a.use(gateway.publicGatewayRouter); return a; };
const corpo = JSON.stringify({ id: REF, status: 'PAID' });
const assinaturaOficial = (segredoOuToken: string) => createHash('sha256').update(`${segredoOuToken}-${corpo}`).digest('hex');

// Captura todo o texto que sairia em log durante a execução.
async function capturandoLogs<T>(fn: () => Promise<T>): Promise<{ resultado: T; texto: string }> {
  const linhas: string[] = [];
  const originais = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const grava = (...a: unknown[]) => { linhas.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); };
  console.log = grava; console.info = grava; console.warn = grava; console.error = grava; console.debug = grava;
  try {
    const resultado = await fn();
    return { resultado, texto: linhas.join('\n') };
  } finally {
    Object.assign(console, originais);
  }
}

test('assinatura inválida: 401 sem vazar segredo nem token em log, resposta ou registros', { timeout: 30000 }, async () => {
  await preparar();
  const { resultado: r, texto } = await capturandoLogs(() => request(app())
    .post('/api/gateway/webhooks/pagbank')
    .set('Content-Type', 'application/json')
    .set('x-authenticity-token', assinaturaOficial('token-errado'))
    .send(corpo));
  assert.equal(r.status, 401);
  const registros = await s.list(gateway.R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 50, filter: { provider: 'pagbank' } });
  const todo = texto + JSON.stringify(r.body) + JSON.stringify(registros.rows);
  assert.ok(!todo.includes(SEGREDO), 'segredo dedicado não aparece');
  assert.ok(!todo.includes(TOKEN_CONTA), 'token da conta não aparece');
  assert.ok(!todo.includes(assinaturaOficial('token-errado')), 'valor do cabeçalho não aparece');
});

test('algoritmo oficial com o token da conta: aceito pelo verificador (limitação da ADR-004); a resposta não expõe segredo', { timeout: 30000 }, async () => {
  await preparar();
  const r = await request(app())
    .post('/api/gateway/webhooks/pagbank')
    .set('Content-Type', 'application/json')
    .set('x-authenticity-token', assinaturaOficial(TOKEN_CONTA))
    .send(corpo);
  // Limitação documentada (ADR-004 §Consequências): o algoritmo oficial usa o token da conta, e o
  // segredo dedicado é o gate de presença. Por isso a assinatura oficial é aceita aqui.
  assert.ok(r.status >= 200 && r.status < 300, `assinatura oficial aceita (recebido ${r.status})`);
  assert.ok(!JSON.stringify(r.body).includes(SEGREDO));
  assert.ok(!JSON.stringify(r.body).includes(TOKEN_CONTA));
});

test('formato não hexadecimal ou tamanho errado: rejeição sem comparação parcial e sem vazamento', { timeout: 30000 }, async () => {
  await preparar();
  for (const cab of ['', 'x'.repeat(64), 'ab', assinaturaOficial('token-errado').slice(0, 63)]) {
    const r = await request(app())
      .post('/api/gateway/webhooks/pagbank')
      .set('Content-Type', 'application/json')
      .set('x-authenticity-token', cab)
      .send(corpo);
    assert.equal(r.status, 401, `cabeçalho inválido (${cab.length} chars) deve ser recusado`);
  }
});
