// ============================================================================
// STOREFRONT ENTERPRISE — NOTIFICATION ORCHESTRATOR (Outbox → Email/WhatsApp)
//
// DOMAIN EVENT → OUTBOX → commerce_notificacoes → adapter. Testes sem rede e
// sem provedor real: SMTP/Meta NÃO configurados devem manter o pedido válido e
// deixar a notificação em retry, nunca "falhou pedido".
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
delete process.env.WHATSAPP_CLOUD_API_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_TEMPLATE_TRANSACIONAL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const {
  EVENTOS_NOTIFICACAO, MENSAGENS, normalizarWhatsApp,
  registrarEventoPedido, registrarEventoSeguro, processarEventoNotificacao,
} = await import('../src/commerce/notificacoes');
const { validarCPF, normalizarCPF, mascararCPF, mascararWhatsApp } = await import('../src/commerce/cliente');

const s = getStore();
const contato = { nome: 'Maria Silva', email: 'maria@example.invalid', whatsapp: '(62) 99999-1234' };
const ctx = {
  empresaId: 1,
  pedidoId: 424242,
  evento: 'ORDER_CREATED' as const,
  pedidoExterno: 'CHK-2026-001',
  checkoutToken: 'a'.repeat(64),
  total: 109.9,
};

async function limpar() {
  for (const r of [RESOURCES.commerce_notificacoes, RESOURCES.commerce_outbox]) {
    const lista = await s.list(r, { page: 1, pageSize: 200, filter: { empresa_id: 1 } });
    for (const row of lista.rows) await s.remove(r, Number(row.id));
  }
}

describe('Notificações transacionais — eventos, idempotência, retry e privacidade', () => {
  test('CPF/WhatsApp: validação real, sem dado sensível em logs ou resposta pública', () => {
    assert.equal(validarCPF('529.982.247-25'), true);
    assert.equal(validarCPF('111.111.111-11'), false);
    assert.equal(validarCPF('529.982.247-26'), false);
    assert.equal(normalizarCPF('529.982.247-25'), '52998224725');
    assert.equal(normalizarWhatsApp('(62) 99999-1234'), '5562999991234');
    assert.equal(normalizarWhatsApp(''), null);
    assert.ok(!String(mascararCPF('52998224725')).includes('52998224725'));
    assert.ok(!String(mascararWhatsApp('5562999991234')).includes('5562999991234'));
  });

  test('10 eventos transacionais têm mensagem curta e NENHUM evento de marketing', () => {
    // +ORDER_EXPIRED: expiração do PIX não é "cancelado pelo cliente/loja".
    assert.equal(EVENTOS_NOTIFICACAO.length, 10);
    assert.ok(EVENTOS_NOTIFICACAO.includes('ORDER_EXPIRED'));
    for (const e of EVENTOS_NOTIFICACAO) assert.ok(MENSAGENS[e].length > 0, `sem mensagem para ${e}`);
    assert.ok(!EVENTOS_NOTIFICACAO.some((e) => /MARKETING|PROMOC/.test(e)));
    assert.ok(EVENTOS_NOTIFICACAO.includes('PIX_GENERATED'));
    assert.ok(EVENTOS_NOTIFICACAO.includes('PAYMENT_APPROVED'));
    assert.ok(EVENTOS_NOTIFICACAO.includes('PAYMENT_REJECTED'), 'PAGAMENTO_RECUSADO deve existir');
    assert.ok(EVENTOS_NOTIFICACAO.includes('ORDER_DELIVERED'));
    assert.ok(EVENTOS_NOTIFICACAO.includes('ORDER_CANCELLED'));
  });

  test('um evento gera 1 linha por canal + 1 trabalho no outbox; repetir é idempotente', async () => {
    await limpar();
    const novas = await registrarEventoPedido(contato, ctx);
    assert.equal(novas, 2, 'e-mail + WhatsApp');
    const notificacoes = await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 50, filter: { empresa_id: 1, pedido_id: ctx.pedidoId } });
    assert.equal(notificacoes.total, 2);
    const canais = notificacoes.rows.map((r) => String(r.canal)).sort();
    assert.deepEqual(canais, ['EMAIL', 'WHATSAPP']);
    for (const row of notificacoes.rows) {
      assert.equal(row.evento, 'ORDER_CREATED');
      assert.equal(row.estado, 'PENDENTE');
      assert.equal(Number(row.tentativas), 0);
      assert.ok(row.chave_idempotencia);
      assert.ok(row.criado_em && row.atualizado_em);
      assert.equal(row.enviado_em, null);
      assert.ok(!String(row.destinatario).includes('@example') || String(row.canal) === 'EMAIL');
    }
    const outbox = await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: 1 } });
    const trabalhos = outbox.rows.filter((r) => r.tipo === 'sincronizacao' && (r.payload as Record<string, unknown>)?.acao === 'notificacao');
    assert.equal(trabalhos.length, 1);
    assert.equal((trabalhos[0].payload as Record<string, unknown>).evento, 'ORDER_CREATED');

    // Webhook duplicado / replay do mesmo evento: zero linhas novas.
    const repetido = await registrarEventoPedido(contato, ctx);
    assert.equal(repetido, 0);
    const depois = await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 50, filter: { empresa_id: 1, pedido_id: ctx.pedidoId } });
    assert.equal(depois.total, 2);
  });

  test('evento desconhecido não cria notificação; evento inválido não gera retry infinito', async () => {
    await limpar();
    assert.equal(await registrarEventoPedido(contato, { ...ctx, evento: 'MARKETING_PROMO' as any }), 0);
    const r = await processarEventoNotificacao({ empresa_id: 1, pedido_id: ctx.pedidoId, evento: 'MARKETING_PROMO' });
    assert.equal(r.status, 'processado');
  });

  test('provedor indisponível NÃO invalida pedido: linhas voltam para retry com tentativas e erro', async () => {
    await limpar();
    await registrarEventoPedido(contato, ctx);
    const desfecho = await processarEventoNotificacao({ empresa_id: 1, pedido_id: ctx.pedidoId, evento: 'ORDER_CREATED', pedido_externo: ctx.pedidoExterno, checkout_token: ctx.checkoutToken });
    assert.equal(desfecho.status, 'retry');
    const linhas = await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 50, filter: { empresa_id: 1, pedido_id: ctx.pedidoId } });
    assert.equal(linhas.total, 2);
    for (const row of linhas.rows) {
      assert.equal(row.estado, 'PENDENTE');
      assert.equal(Number(row.tentativas), 1);
      assert.ok(String(row.ultimo_erro || '').length > 0);
      assert.equal(row.enviado_em, null);
      // Nenhum segredo/token/PII completo vazou para o campo de erro.
      assert.ok(!/APP_USR-|Bearer\s+\S+|@example\.invalid|5562999991234/i.test(String(row.ultimo_erro)));
    }
    // Pedido permanece intacto: o envoltório seguro nunca lança.
    await assert.doesNotReject(() => registrarEventoSeguro(contato, { ...ctx, evento: 'PIX_GENERATED' }));
  });

  test('WhatsApp Meta persiste message_id como REQUEST_ACCEPTED e concorrência não duplica envio', async (t) => {
    await limpar();
    const old = {
      token: process.env.WHATSAPP_CLOUD_API_TOKEN,
      phone: process.env.WHATSAPP_PHONE_NUMBER_ID,
      template: process.env.WHATSAPP_TEMPLATE_TRANSACIONAL,
    };
    process.env.WHATSAPP_CLOUD_API_TOKEN = 'fixture-meta-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'fixture-phone-number-id';
    process.env.WHATSAPP_TEMPLATE_TRANSACIONAL = 'order_update_approved_fixture';
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.fixture-001' }] }), { status: 200 });
    });
    try {
      await registrarEventoPedido(contato, ctx);
      const wa = await s.findOneWhere(RESOURCES.commerce_notificacoes, {
        empresa_id: 1, pedido_id: ctx.pedidoId, canal: 'WHATSAPP',
      });
      assert.ok(wa);
      await s.update(RESOURCES.commerce_notificacoes, Number(wa.id), { estado: 'ERRO' });
      const payload = { empresa_id: ctx.empresaId, pedido_id: ctx.pedidoId, evento: ctx.evento, pedido_externo: ctx.pedidoExterno };
      await Promise.all([processarEventoNotificacao(payload), processarEventoNotificacao(payload)]);
      assert.equal(calls, 1);
      const rows = await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 20, filter: { empresa_id: 1, pedido_id: ctx.pedidoId, canal: 'WHATSAPP' } });
      assert.equal(rows.total, 1);
      assert.equal(rows.rows[0]?.provider_message_id, 'wamid.fixture-001');
      assert.equal(rows.rows[0]?.provider_status, 'REQUEST_ACCEPTED');
      assert.equal(rows.rows[0]?.estado, 'ENVIADO');
      // Reprocessing after Meta acceptance must not send the same notification again.
      await processarEventoNotificacao(payload);
      assert.equal(calls, 1);
    } finally {
      if (old.token === undefined) delete process.env.WHATSAPP_CLOUD_API_TOKEN; else process.env.WHATSAPP_CLOUD_API_TOKEN = old.token;
      if (old.phone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = old.phone;
      if (old.template === undefined) delete process.env.WHATSAPP_TEMPLATE_TRANSACIONAL; else process.env.WHATSAPP_TEMPLATE_TRANSACIONAL = old.template;
    }
  });

  test('isolamento multiempresa: evento da empresa A não aparece para B', async () => {
    await limpar();
    await registrarEventoPedido(contato, ctx);
    const outra = await processarEventoNotificacao({ empresa_id: 2, pedido_id: ctx.pedidoId, evento: 'ORDER_CREATED' });
    assert.equal(outra.status, 'processado');
    const daEmpresaB = await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 50, filter: { empresa_id: 2, pedido_id: ctx.pedidoId } });
    assert.equal(daEmpresaB.total, 0);
  });
});
