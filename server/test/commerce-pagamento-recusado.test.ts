// ============================================================================
// FECHAMENTO DO CICLO — PAGAMENTO_RECUSADO (gateway `falhou` → REJECTED).
//
// Antes, `confirmarPagamentoCobranca` ignorava `status='falhou'`: o pedido
// ficava em AGUARDANDO_PAGAMENTO, a reserva/cupom não eram liberados e o
// comprador não recebia nenhum evento. Aqui provamos a transição real, a
// liberação e a emissão de PAYMENT_REJECTED + ORDER_CANCELLED no outbox.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
delete process.env.WHATSAPP_CLOUD_API_TOKEN;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const gateway = await import('../src/gateway');
const { confirmarPagamentoCobranca } = await import('../src/commerce/pedidos');
const { EVENTOS_NOTIFICACAO, MAPA_EVENTOS_HOMOLOGACAO } = await import('../src/commerce/notificacoes');
const { normalizarComprador } = await import('../src/commerce/cliente');
const s = getStore();

/** Eventos são emitidos de forma assíncrona (não bloqueiam o pedido). */
async function aguardarEventos(pedidoId: number): Promise<string[]> {
  for (let i = 0; i < 40; i += 1) {
    const lista = await s.list(RESOURCES.commerce_notificacoes, {
      page: 1, pageSize: 50, filter: { empresa_id: 1, pedido_id: pedidoId },
    });
    const eventos = [...new Set(lista.rows.map((r) => String(r.evento)))];
    if (eventos.includes('PAYMENT_REJECTED') && eventos.includes('ORDER_CANCELLED')) return eventos;
    await new Promise((r) => setTimeout(r, 10));
  }
  const lista = await s.list(RESOURCES.commerce_notificacoes, {
    page: 1, pageSize: 50, filter: { empresa_id: 1, pedido_id: pedidoId },
  });
  return [...new Set(lista.rows.map((r) => String(r.evento)))];
}

test('contrato do comprador: fixtures PG contêm nome completo e WhatsApp E.164', () => {
  // Exatamente o formato usado em server/test/pg/commerce-cart.test.ts e
  // commerce-e2e.test.ts. Se este teste falhar, os E2E PG voltam a responder
  // 400 ("Informe ...") antes de chegar às asserções de estoque/frete/409.
  const fixture = { nome: 'Cliente X', email: 'x@example.invalid', whatsapp: '62999991234' };
  const ok = normalizarComprador(fixture);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.comprador.whatsapp, '5562999991234');
  assert.equal(ok.ok && ok.comprador.marketing_opt_in, false);
  assert.equal(ok.ok && ok.comprador.consentimento_em, null);
  const semWhatsapp = normalizarComprador({ nome: 'Cliente X', email: 'x@example.invalid' });
  assert.equal(semWhatsapp.ok, false);
  assert.equal(semWhatsapp.ok === false && semWhatsapp.campo, 'whatsapp');
  const nomeCurto = normalizarComprador({ ...fixture, nome: 'X' });
  assert.equal(nomeCurto.ok, false);
  assert.equal(nomeCurto.ok === false && nomeCurto.campo, 'nome');
});

test('vocabulário de homologação cobre PAGAMENTO_RECUSADO com constante persistida', () => {
  assert.equal(MAPA_EVENTOS_HOMOLOGACAO.PAGAMENTO_RECUSADO, 'PAYMENT_REJECTED');
  assert.ok(EVENTOS_NOTIFICACAO.includes('PAYMENT_REJECTED'));
  for (const chave of Object.keys(MAPA_EVENTOS_HOMOLOGACAO)) {
    const constante = MAPA_EVENTOS_HOMOLOGACAO[chave as keyof typeof MAPA_EVENTOS_HOMOLOGACAO];
    assert.ok(EVENTOS_NOTIFICACAO.includes(constante), `${chave} → ${constante} não existe`);
  }
});

test('cobrança `falhou` cancela pedido, libera reserva e emite PAGAMENTO_RECUSADO', async () => {
  const ref = `recusado-${Date.now()}`;
  const cobranca = await s.insert(gateway.R_GATEWAY_COBRANCAS, {
    empresa_id: 1, provider: 'mercadopago', metodo: 'pix', status: 'falhou', provider_ref: ref,
    valor: 80, valor_liquido: 80, taxa_pct: 0, parcelas: 1, idempotency_key: ref,
  });
  const pedido = await s.insert(RESOURCES.commerce_pedidos, {
    empresa_id: 1, canal: 'BROBOND', pedido_externo: ref, chave_checkout: ref,
    estado: 'AGUARDANDO_PAGAMENTO', pagamento_estado: 'PENDING',
    cobranca_id: cobranca.id, total: 80,
    comprador: { nome: 'Maria Silva', email: 'maria@example.invalid', whatsapp: '5562999991234' },
    checkout_token: 'b'.repeat(64),
  });
  const produto = await s.insert(RESOURCES.produtos, {
    empresa_id: 1, sku: `SKU-RECUSADO-${Date.now()}`, nome: 'COTTON "B"', ativo: true,
    preco_base: 80, preco_venda: 80, unidade: 'UN',
  });
  const reserva = await s.insert(RESOURCES.estoque_reservas, {
    empresa_id: 1, produto_id: Number(produto.id), quantidade: 1, status: 'ativa', tipo: 'reserva',
    origem_recurso: 'commerce_checkout', origem_id: Number(pedido.id),
  });

  await confirmarPagamentoCobranca({ empresaId: 1, cobrancaId: Number(cobranca.id), intencao: 'cancelado' });

  const depois = await s.get(RESOURCES.commerce_pedidos, Number(pedido.id));
  assert.equal(depois?.estado, 'CANCELADO', 'pedido recusado não pode ficar aguardando pagamento');
  assert.equal(depois?.pagamento_estado, 'REJECTED');
  const liberada = await s.get(RESOURCES.estoque_reservas, Number(reserva.id));
  assert.ok(!liberada || String(liberada.status) !== 'ativa', 'reserva precisa ser liberada na recusa');

  const eventos = await aguardarEventos(Number(pedido.id));
  assert.ok(eventos.includes('PAYMENT_REJECTED'), `PAGAMENTO_RECUSADO ausente: ${eventos.join(',')}`);
  assert.ok(eventos.includes('ORDER_CANCELLED'), `PEDIDO_CANCELADO ausente: ${eventos.join(',')}`);
  const outbox = await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: 1 } });
  const trabalhos = outbox.rows.filter((r) => String(r.tipo) === 'sincronizacao'
    && (r.payload as Record<string, unknown>)?.acao === 'notificacao');
  assert.ok(trabalhos.length >= 2, 'um trabalho por evento no outbox, com tipo aceito pela cadeia de migrations');
  assert.ok(trabalhos.some((r) => (r.payload as Record<string, unknown>)?.evento === 'PAYMENT_REJECTED'));

  // Replay do mesmo webhook: nenhuma linha nova de notificação (idempotência).
  const antes = await s.list(RESOURCES.commerce_notificacoes, {
    page: 1, pageSize: 50, filter: { empresa_id: 1, pedido_id: Number(pedido.id) },
  });
  await confirmarPagamentoCobranca({ empresaId: 1, cobrancaId: Number(cobranca.id), intencao: 'cancelado' });
  const depoisReplay = await s.list(RESOURCES.commerce_notificacoes, {
    page: 1, pageSize: 50, filter: { empresa_id: 1, pedido_id: Number(pedido.id) },
  });
  assert.equal(depoisReplay.total, antes.total, 'webhook duplicado não duplica notificação');
});
