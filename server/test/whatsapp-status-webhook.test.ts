// P1-05 — webhook de status do WhatsApp: fail-closed, assinatura, estados e persistência.
// LOCAL: servidor HTTP efêmero em loopback e store em memória. Sem Meta, sem rede externa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const W = await import('../src/commerce/whatsappStatus');
const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const s = getStore();

const SEGREDO = 'segredo-app-teste';
const TOKEN = 'token-verificacao-teste';

function corpoStatus(statuses: unknown[]) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses } }] }] };
}
const assinar = (corpo: string, segredo = SEGREDO) => 'sha256=' + createHmac('sha256', segredo).update(corpo).digest('hex');

async function servidor(deps: Parameters<typeof W.criarRouterWebhookStatusWhatsApp>[0]) {
  const app = express();
  app.use(W.criarRouterWebhookStatusWhatsApp(deps));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { base, fechar: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('sem segredo autorizado (estado atual): POST responde 401 e não processa nada, mesmo com assinatura "correta"', async () => {
  const chamadas: unknown[] = [];
  const srv = await servidor({ segredoApp: W.segredoAppWhatsApp, segredoVerificacao: W.segredoVerificacaoWhatsApp, aplicar: async (e) => { chamadas.push(e); return 'aplicado'; } });
  try {
    const corpo = JSON.stringify(corpoStatus([{ id: 'wamid.X', status: 'delivered' }]));
    const r = await fetch(`${srv.base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo) }, body: corpo });
    assert.equal(r.status, 401);
    assert.equal(chamadas.length, 0);
    const g = await fetch(`${srv.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`);
    assert.equal(g.status, 403);
  } finally { await srv.fechar(); }
});

test('com segredo: assinatura ausente, errada ou de outro segredo → 401, nada aplicado', async () => {
  const chamadas: unknown[] = [];
  const srv = await servidor({ segredoApp: () => SEGREDO, segredoVerificacao: () => TOKEN, aplicar: async (e) => { chamadas.push(e); return 'aplicado'; } });
  try {
    const corpo = JSON.stringify(corpoStatus([{ id: 'wamid.X', status: 'read' }]));
    const cenarios = [undefined, 'sha256=00', assinar(corpo, 'outro-segredo'), 'md5=' + createHmac('sha256', SEGREDO).update(corpo).digest('hex')];
    for (const sig of cenarios) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (sig !== undefined) headers['x-hub-signature-256'] = sig;
      const r = await fetch(`${srv.base}/api/webhooks/whatsapp`, { method: 'POST', headers, body: corpo });
      assert.equal(r.status, 401, `assinatura ${sig}`);
    }
    assert.equal(chamadas.length, 0);
  } finally { await srv.fechar(); }
});

test('com segredo e assinatura válida: aplica cada status e responde 200', async () => {
  const chamadas: unknown[] = [];
  const srv = await servidor({ segredoApp: () => SEGREDO, segredoVerificacao: () => TOKEN, aplicar: async (e) => { chamadas.push(e); return 'aplicado'; } });
  try {
    const corpo = JSON.stringify(corpoStatus([{ id: 'wamid.A', status: 'sent' }, { id: 'wamid.B', status: 'failed', errors: [{ code: 131026, title: 'Mensagem não entregável' }] }]));
    const r = await fetch(`${srv.base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo) }, body: corpo });
    assert.equal(r.status, 200);
    assert.equal(chamadas.length, 2);
    assert.deepEqual(chamadas[0], { messageId: 'wamid.A', status: 'sent' });
    assert.equal((chamadas[1] as { status: string }).status, 'failed');
  } finally { await srv.fechar(); }
});

test('desafio GET: token certo devolve o challenge; token errado ou ausente → 403', async () => {
  const srv = await servidor({ segredoApp: () => SEGREDO, segredoVerificacao: () => TOKEN, aplicar: async () => 'aplicado' });
  try {
    const ok = await fetch(`${srv.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=123456`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '123456');
    const ruim = await fetch(`${srv.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`);
    assert.equal(ruim.status, 403);
  } finally { await srv.fechar(); }
});

test('extração: só id, status e código de erro; telefone e texto não entram no evento', () => {
  const eventos = W.extrairEventosStatusWhatsApp(corpoStatus([
    { id: 'wamid.A', status: 'delivered', recipient_id: '5562999990000', timestamp: '1' },
    { id: 'wamid.B', status: 'failed', recipient_id: '5562999990000', errors: [{ code: 131047, title: 'Janela de 24h encerrada' }] },
    { id: '', status: 'read' },
    { id: 'wamid.C', status: 'pending' },
  ]));
  assert.equal(eventos.length, 2);
  const texto = JSON.stringify(eventos);
  assert.ok(!texto.includes('5562999990000'));
  assert.deepEqual(eventos[1], { messageId: 'wamid.B', status: 'failed', erro: 'Meta: Janela de 24h encerrada (código 131047)' });
  assert.deepEqual(W.extrairEventosStatusWhatsApp({ entry: 'x' }), []);
});

test('máquina de estados: avança, ignora atrasado, FAILED é terminal', () => {
  assert.equal(W.decidirTransicaoWhatsApp('REQUEST_ACCEPTED', 'sent'), 'aplicar');
  assert.equal(W.decidirTransicaoWhatsApp('SENT', 'delivered'), 'aplicar');
  assert.equal(W.decidirTransicaoWhatsApp('DELIVERED', 'read'), 'aplicar');
  assert.equal(W.decidirTransicaoWhatsApp('DELIVERED', 'sent'), 'ignorar');   // atrasado
  assert.equal(W.decidirTransicaoWhatsApp('READ', 'delivered'), 'ignorar');
  assert.equal(W.decidirTransicaoWhatsApp('READ', 'failed'), 'ignorar');      // failed não sobrescreve read
  assert.equal(W.decidirTransicaoWhatsApp('DELIVERED', 'failed'), 'ignorar'); // nem delivered
  assert.equal(W.decidirTransicaoWhatsApp('SENT', 'failed'), 'aplicar');
  assert.equal(W.decidirTransicaoWhatsApp('FAILED', 'delivered'), 'ignorar'); // terminal
  assert.equal(W.decidirTransicaoWhatsApp('FAILED', 'failed'), 'ignorar');
  assert.equal(W.decidirTransicaoWhatsApp(null, 'sent'), 'aplicar');
  assert.equal(W.decidirTransicaoWhatsApp('REQUEST_ACCEPTED', 'read'), 'aplicar');
});

test('assinatura: aceita HMAC exato e rejeita comprimento ou prefixo diferentes', () => {
  const corpo = Buffer.from('{"a":1}');
  assert.equal(W.assinaturaWhatsAppValida(corpo, assinar('{"a":1}'), SEGREDO), true);
  assert.equal(W.assinaturaWhatsAppValida(corpo, assinar('{"a":2}'), SEGREDO), false);
  assert.equal(W.assinaturaWhatsAppValida(corpo, 'sha256=abc', SEGREDO), false);
  assert.equal(W.assinaturaWhatsAppValida(corpo, 'zz', SEGREDO), false);
});

test('persistência: aplica na notificação pelo wamid, sem sobrescrever estado mais avançado', async () => {
  const R = getResource('commerce_notificacoes')!;
  const linha = await s.insert(R, { empresa_id: 1, canal: 'WHATSAPP', evento: 'PEDIDO_CRIADO', estado: 'ENVIADO', provider_message_id: 'wamid.P5-1', provider_status: 'REQUEST_ACCEPTED', chave_idempotencia: 'p5-1' } as any);
  const id = Number(linha.id);
  assert.equal(await W.aplicarEventoStatusWhatsApp({ messageId: 'wamid.P5-1', status: 'delivered' }), 'aplicado');
  assert.equal((await s.get(R, id) as any).provider_status, 'DELIVERED');
  assert.equal(await W.aplicarEventoStatusWhatsApp({ messageId: 'wamid.P5-1', status: 'sent' }), 'sem_alteracao');
  assert.equal((await s.get(R, id) as any).provider_status, 'DELIVERED');
  assert.equal(await W.aplicarEventoStatusWhatsApp({ messageId: 'wamid.P5-1', status: 'read' }), 'aplicado');
  assert.equal(await W.aplicarEventoStatusWhatsApp({ messageId: 'wamid.P5-1', status: 'failed', erro: 'x' }), 'sem_alteracao');
  assert.equal((await s.get(R, id) as any).provider_status, 'READ');
  assert.equal(await W.aplicarEventoStatusWhatsApp({ messageId: 'wamid.DESCONHECIDO', status: 'read' }), 'desconhecida');
});

test('persistência: failed grava FAILED e o motivo em ultimo_erro', async () => {
  const R = getResource('commerce_notificacoes')!;
  const linha = await s.insert(R, { empresa_id: 1, canal: 'WHATSAPP', evento: 'PEDIDO_PAGO', estado: 'ENVIADO', provider_message_id: 'wamid.P5-2', provider_status: 'REQUEST_ACCEPTED', chave_idempotencia: 'p5-2' } as any);
  assert.equal(await W.aplicarEventoStatusWhatsApp({ messageId: 'wamid.P5-2', status: 'failed', erro: 'Meta: Mensagem não entregável (código 131026)' }), 'aplicado');
  const after = await s.get(R, Number(linha.id)) as any;
  assert.equal(after.provider_status, 'FAILED');
  assert.equal(after.ultimo_erro, 'Meta: Mensagem não entregável (código 131026)');
});

// Decisão (d): fonte do segredo do app = variável WHATSAPP_SECRET (nome informado pelo Diretor).
// Os testes usam um valor fictício e restauram o ambiente. Nenhum valor real é lido.
test('segredo do app: lê WHATSAPP_SECRET; ausente ou só espaços = null (fail-closed)', async (t) => {
  const anterior = process.env.WHATSAPP_SECRET;
  t.after(() => { if (anterior === undefined) delete process.env.WHATSAPP_SECRET; else process.env.WHATSAPP_SECRET = anterior; });
  delete process.env.WHATSAPP_SECRET;
  assert.equal(W.segredoAppWhatsApp(), null);
  process.env.WHATSAPP_SECRET = '   ';
  assert.equal(W.segredoAppWhatsApp(), null);
  process.env.WHATSAPP_SECRET = 'segredo-ficticio-para-teste';
  assert.equal(W.segredoAppWhatsApp(), 'segredo-ficticio-para-teste');
});

test('router de produção: com WHATSAPP_SECRET definido, assinatura válida é aceita; sem ela, recusada', async (t) => {
  const anterior = process.env.WHATSAPP_SECRET;
  t.after(() => { if (anterior === undefined) delete process.env.WHATSAPP_SECRET; else process.env.WHATSAPP_SECRET = anterior; });
  const app = express();
  app.use(W.criarRouterWebhookStatusWhatsApp()); // dependências reais
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const corpo = JSON.stringify(corpoStatus([{ id: 'wamid.NAO-EXISTE-P5', status: 'read' }]));
    const segredo = 'segredo-ficticio-para-teste';
    delete process.env.WHATSAPP_SECRET;
    const semSegredo = await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo, segredo) }, body: corpo });
    assert.equal(semSegredo.status, 401);
    process.env.WHATSAPP_SECRET = segredo;
    const comSegredo = await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo, segredo) }, body: corpo });
    assert.equal(comSegredo.status, 200);
    const texto = await comSegredo.text();
    assert.ok(!texto.includes(segredo), 'o segredo nunca aparece na resposta');
    const errada = await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo, 'outro') }, body: corpo });
    assert.equal(errada.status, 401);
  } finally { await new Promise<void>((r) => srv.close(() => r())); }
});
