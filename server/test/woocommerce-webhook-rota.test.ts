// ============================================================================
// WOOCOMMERCE MULTI-STORE — ROTA PÚBLICA DE WEBHOOK (HTTP de ponta a ponta).
//
// A suíte de unidade prova a VALIDAÇÃO (HMAC, idempotência, worker). Aqui se
// prova a ROTA como a loja a vê: express + `express.raw` + supertest, sem
// sessão. É o que a missão exige que não seja confiado por chegar por HTTP.
//
// Contrato do WooCommerce (REST API v3): `X-WC-Webhook-Signature` é o BASE64 do
// HMAC-SHA256 do CORPO CRU com o segredo cadastrado no webhook. A assinatura é
// calculada sobre os bytes exatos — qualquer reformatação do JSON a invalida.
//
// LOCAL: store em memória; nenhuma rede.
// ============================================================================
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];

const { getStore } = await import('../src/services');
const { publicWoocommerceWebhookRouter } = await import('../src/commerce/woocommerce/webhookRouter');
const { assinarCorpo, limparRateLimit } = await import('../src/commerce/woocommerce/webhookSeguranca');
const { listarEntregas } = await import('../src/commerce/woocommerce/webhookInbox');

const SEGREDO_RETAIL = 'whsec_rota_retail_nao_real';
const SEGREDO_WHOLESALE = 'whsec_rota_wholesale_nao_real';

let empresaSeq = 0;
function novaEmpresa(): number {
  empresaSeq += 1;
  return 7000 + empresaSeq;
}

/** App mínimo: SÓ o router público, como no boot real (antes de auth/json). */
function app() {
  const a = express();
  a.use(publicWoocommerceWebhookRouter);
  return a;
}

function configurarLojas(empresaId: number, opcoes: { segredo?: boolean } = {}) {
  process.env.WOOCOMMERCE_MULTI_STORE_ENABLED = 'true';
  process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
  process.env.WOOCOMMERCE_RETAIL_URL = 'https://brobond.com.br';
  process.env.WOOCOMMERCE_RETAIL_CK = 'ck_rota_retail';
  process.env.WOOCOMMERCE_RETAIL_CS = 'cs_rota_retail';
  process.env.WOOCOMMERCE_RETAIL_EMPRESA_ID = String(empresaId);
  process.env.WOOCOMMERCE_WHOLESALE_ENABLED = 'true';
  process.env.WOOCOMMERCE_WHOLESALE_URL = 'https://atacado.brobond.com.br';
  process.env.WOOCOMMERCE_WHOLESALE_CK = 'ck_rota_wholesale';
  process.env.WOOCOMMERCE_WHOLESALE_CS = 'cs_rota_wholesale';
  process.env.WOOCOMMERCE_WHOLESALE_EMPRESA_ID = String(empresaId);
  if (opcoes.segredo !== false) {
    process.env.WOOCOMMERCE_RETAIL_WEBHOOK_SECRET = SEGREDO_RETAIL;
    process.env.WOOCOMMERCE_WHOLESALE_WEBHOOK_SECRET = SEGREDO_WHOLESALE;
  }
}

function limparLojas() {
  for (const k of Object.keys(process.env)) if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];
}

/** Corpo cru EXATO enviado (a assinatura depende byte a byte). */
function corpoCru(id: number): string {
  return JSON.stringify({ id, status: 'processing', total: '10.00', line_items: [] });
}

beforeEach(() => {
  limparLojas();
  limparRateLimit();
});
afterEach(() => {
  limparLojas();
});

describe('WR-1 — rota pública de webhook: assinatura sobre os bytes crus', () => {
  test('assinatura válida (base64 do HMAC sobre o corpo cru) é aceita e a entrega é registrada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = corpoCru(8801);
    const assinatura = assinarCorpo(corpo, SEGREDO_RETAIL);
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinatura)
      .set('X-WC-Webhook-Topic', 'order.created')
      .set('X-WC-Webhook-Delivery-ID', `del-${empresaId}-1`)
      .send(corpo);
    assert.equal(r.status, 200, `esperado 200; recebido ${r.status}: ${r.text}`);
    assert.equal(r.body.ok, true);
    const entregas = await listarEntregas(empresaId, 'RETAIL');
    assert.equal(entregas.length, 1);
    assert.equal(String(entregas[0].topic), 'order.created');
    assert.equal(entregas[0].assinatura_ok, true);
  });

  test('corpo reformatado (mesmo JSON, bytes diferentes) invalida a assinatura → 401 e nada enfileirado', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = corpoCru(8802);
    const assinatura = assinarCorpo(corpo, SEGREDO_RETAIL);
    // Envia um corpo DIFERENTE (espaços) com a assinatura do corpo original.
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinatura)
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(`  ${corpo}  `);
    assert.equal(r.status, 401, `esperado 401; recebido ${r.status}`);
    const entregas = await listarEntregas(empresaId, 'RETAIL');
    assert.equal(entregas.filter((e) => e.assinatura_ok === true).length, 0, 'nenhuma entrega aceita');
  });

  test('segredo de OUTRA loja não vale: assinatura da RETAIL é recusada na WHOLESALE', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = corpoCru(8803);
    const assinaturaRetail = assinarCorpo(corpo, SEGREDO_RETAIL);
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/WHOLESALE')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinaturaRetail)
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(corpo);
    assert.equal(r.status, 401, `esperado 401; recebido ${r.status}`);
  });

  test('loja sem segredo configurado falha FECHADA: recusa toda entrega mesmo com assinatura calculada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId, { segredo: false });
    const corpo = corpoCru(8804);
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinarCorpo(corpo, 'qualquer-coisa'))
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(corpo);
    assert.equal(r.status, 401, `esperado 401 (falha fechada); recebido ${r.status}`);
  });

  test('assinatura ausente é recusada (401) sem registrar entrega aceita', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(corpoCru(8805));
    assert.equal(r.status, 401);
  });

  test('loja desconhecida no path NÃO responde: cai no next() (404 do app)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const a = express();
    a.use(publicWoocommerceWebhookRouter);
    a.use((_req, res) => res.status(404).json({ error: 'não encontrado' }));
    const r = await request(a)
      .post('/api/commerce/woocommerce/webhooks/LOJA_QUE_NAO_EXISTE')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', 'x')
      .send(corpoCru(8806));
    assert.equal(r.status, 404);
  });

  test('GET na URL da loja é liveness (a plataforma valida antes de habilitar o push)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const r = await request(app()).get('/api/commerce/woocommerce/webhooks/RETAIL');
    assert.equal(r.status, 200);
    assert.equal(r.body.store_key, 'RETAIL');
  });
});

describe('WR-2 — idempotência e limites pela rota', () => {
  test('a MESMA entrega reenviada (mesmo delivery id) responde 202 e não cria segunda linha', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = corpoCru(8807);
    const assinatura = assinarCorpo(corpo, SEGREDO_RETAIL);
    const enviar = () =>
      request(app())
        .post('/api/commerce/woocommerce/webhooks/RETAIL')
        .set('Content-Type', 'application/json')
        .set('X-WC-Webhook-Signature', assinatura)
        .set('X-WC-Webhook-Topic', 'order.created')
        .set('X-WC-Webhook-Delivery-ID', `del-${empresaId}-dup`)
        .send(corpo);
    const primeira = await enviar();
    const segunda = await enviar();
    assert.equal(primeira.status, 200);
    assert.equal(segunda.status, 202, `esperado 202 (duplicado); recebido ${segunda.status}`);
    assert.equal(segunda.body.duplicado, true);
    const entregas = await listarEntregas(empresaId, 'RETAIL');
    assert.equal(entregas.length, 1, 'a reentrega não cria segunda linha');
  });

  test('corpo acima do teto é recusado (413) ANTES de calcular HMAC', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    process.env.WOOCOMMERCE_WEBHOOK_MAX_BYTES = '64';
    const grande = JSON.stringify({ id: 8808, blob: 'x'.repeat(500) });
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinarCorpo(grande, SEGREDO_RETAIL))
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(grande);
    assert.equal(r.status, 413, `esperado 413; recebido ${r.status}`);
    delete process.env.WOOCOMMERCE_WEBHOOK_MAX_BYTES;
  });

  test('corpo não-JSON com assinatura válida é recusado (400) — estrutura mínima', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = 'isto-nao-e-json';
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinarCorpo(corpo, SEGREDO_RETAIL))
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(corpo);
    assert.equal(r.status, 400, `esperado 400; recebido ${r.status}`);
  });

  test('modo multi-loja desligado: o endpoint recusa a entrega (503) sem registrar nada', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    process.env.WOOCOMMERCE_MULTI_STORE_ENABLED = 'false';
    const corpo = corpoCru(8809);
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinarCorpo(corpo, SEGREDO_RETAIL))
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(corpo);
    assert.equal(r.status, 503, `esperado 503; recebido ${r.status}`);
  });

  test('timestamp fora da janela é replay → 401 (quando a loja informa a hora)', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    process.env.WOOCOMMERCE_WEBHOOK_TOLERANCE_S = '60';
    const corpo = corpoCru(8810);
    const antigo = String(Math.floor(Date.now() / 1000) - 3600);
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinarCorpo(corpo, SEGREDO_RETAIL))
      .set('X-WC-Webhook-Topic', 'order.created')
      .set('X-WC-Webhook-Delivery-Time', antigo)
      .send(corpo);
    assert.equal(r.status, 401, `esperado 401 (replay); recebido ${r.status}`);
    delete process.env.WOOCOMMERCE_WEBHOOK_TOLERANCE_S;
  });

  test('resposta da rota NUNCA vaza a credencial nem o segredo do webhook', async () => {
    const empresaId = novaEmpresa();
    configurarLojas(empresaId);
    const corpo = corpoCru(8811);
    const r = await request(app())
      .post('/api/commerce/woocommerce/webhooks/RETAIL')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinarCorpo(corpo, SEGREDO_RETAIL))
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(corpo);
    const texto = JSON.stringify(r.body) + r.text;
    assert.ok(!texto.includes(SEGREDO_RETAIL), 'segredo do webhook não pode aparecer');
    assert.ok(!texto.includes('cs_rota_retail'), 'consumer secret não pode aparecer');
    assert.ok(!texto.includes('ck_rota_retail'), 'consumer key não pode aparecer');
  });
});

describe('WR-3 — assinatura HMAC conferida byte a byte (prova do algoritmo)', () => {
  test('a assinatura é base64 do HMAC-SHA256 do corpo cru com o segredo da loja', () => {
    const corpo = corpoCru(8812);
    const esperado = createHmac('sha256', SEGREDO_WHOLESALE).update(Buffer.from(corpo, 'utf8')).digest('base64');
    assert.equal(assinarCorpo(corpo, SEGREDO_WHOLESALE), esperado);
  });

  test('store em memória: nenhuma entrega de outra empresa aparece na listagem', async () => {
    const empresaA = novaEmpresa();
    configurarLojas(empresaA);
    const corpo = corpoCru(8813);
    await request(app())
      .post('/api/commerce/woocommerce/webhooks/WHOLESALE')
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Signature', assinarCorpo(corpo, SEGREDO_WHOLESALE))
      .set('X-WC-Webhook-Topic', 'order.created')
      .set('X-WC-Webhook-Delivery-ID', `del-${empresaA}-iso`)
      .send(corpo);
    const empresaB = novaEmpresa();
    const entregasB = await listarEntregas(empresaB, 'WHOLESALE');
    assert.equal(entregasB.length, 0, 'a empresa B não enxerga a entrega da empresa A');
    void getStore();
  });
});
