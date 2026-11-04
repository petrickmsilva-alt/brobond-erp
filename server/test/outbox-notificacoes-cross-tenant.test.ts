// ============================================================================
// REGRESSÃO CROSS-TENANT — outbox de notificações (Fase 4.3, auditoria transversal)
//
// Garante que uma linha do commerce_outbox só age sobre a empresa DA PRÓPRIA
// linha (coluna empresa_id), mesmo que o payload traga outro empresa_id, e que a
// idempotência e a leitura de pedido respeitam a empresa. Sem rede e sem provedor
// real: SMTP/Meta NÃO configurados; o resultado é apenas o estado local das linhas.
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
const { RESOURCES, getResource } = await import('../src/resources');
const { registrarEventoPedido, carregarDadosPedido } = await import('../src/commerce/notificacoes');
const { enfileirarOutbox, processarOutbox } = await import('../src/commerce/outbox');

const s = getStore();
const PEDIDO = 987654;
const EMPRESA_A = 1;
const EMPRESA_B = 2;
const contato = { nome: 'Cliente Teste', email: 'cliente.teste@example.invalid', whatsapp: '(62) 99999-0000' };

async function limparEmpresa(empresaId: number) {
  for (const r of [RESOURCES.commerce_notificacoes, RESOURCES.commerce_outbox]) {
    const lista = await s.list(r, { page: 1, pageSize: 500, filter: { empresa_id: empresaId } });
    for (const row of lista.rows) await s.remove(r, Number(row.id));
  }
}

async function inserirNotificacaoPendente(empresaId: number, destinatario: string) {
  const agora = new Date().toISOString();
  await s.insert(RESOURCES.commerce_notificacoes, {
    empresa_id: empresaId,
    pedido_id: PEDIDO,
    evento: 'ORDER_CREATED',
    canal: 'EMAIL',
    destinatario,
    template: null,
    estado: 'PENDENTE',
    tentativas: 0,
    ultimo_erro: null,
    provider_status: null,
    chave_idempotencia: `${PEDIDO}:ORDER_CREATED:EMAIL:${destinatario}`,
    criado_em: agora,
    atualizado_em: agora,
    enviado_em: null,
  });
}

async function notificacoesDa(empresaId: number) {
  const lista = await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 500, filter: { empresa_id: empresaId, pedido_id: PEDIDO } });
  return lista.rows.map((r) => ({ estado: String(r.estado), tentativas: Number(r.tentativas || 0) }));
}

describe('Outbox de notificações — isolamento cross-tenant', () => {
  test('mesmo pedido, evento e destinatário em duas empresas: cada empresa tem as próprias linhas (idempotência é por empresa)', async () => {
    await limparEmpresa(EMPRESA_A);
    await limparEmpresa(EMPRESA_B);
    const novasA = await registrarEventoPedido(contato, { empresaId: EMPRESA_A, pedidoId: PEDIDO, evento: 'ORDER_CREATED' });
    const novasB = await registrarEventoPedido(contato, { empresaId: EMPRESA_B, pedidoId: PEDIDO, evento: 'ORDER_CREATED' });
    assert.equal(novasA, 2, 'A cria EMAIL e WHATSAPP');
    assert.equal(novasB, 2, 'a chave de A não pode suprimir o evento de B');
    assert.equal((await notificacoesDa(EMPRESA_A)).length, 2);
    assert.equal((await notificacoesDa(EMPRESA_B)).length, 2);
  });

  test('linha do outbox com payload.empresa_id de OUTRA empresa age só sobre a empresa da própria linha', async () => {
    // RED antes da correção: `{ empresa_id: empresaId, ...payload }` deixava o payload
    // sobrescrever a empresa da linha; o processamento tocava as notificações de B.
    await limparEmpresa(EMPRESA_A);
    await limparEmpresa(EMPRESA_B);
    await inserirNotificacaoPendente(EMPRESA_A, 'a.cliente@example.invalid');
    await inserirNotificacaoPendente(EMPRESA_B, 'b.cliente@example.invalid');
    await enfileirarOutbox(EMPRESA_A, 'sincronizacao', `teste-cross-tenant-${PEDIDO}`, {
      acao: 'notificacao',
      pedido_id: PEDIDO,
      evento: 'ORDER_CREATED',
      empresa_id: EMPRESA_B, // payload adulterado: deve ser ignorado
    });

    await processarOutbox(10, ['sincronizacao']);

    const daB = await notificacoesDa(EMPRESA_B);
    assert.deepEqual(daB, [{ estado: 'PENDENTE', tentativas: 0 }], 'empresa B não pode ser processada por uma linha de A');
    const daA = await notificacoesDa(EMPRESA_A);
    assert.equal(daA[0].tentativas, 1, 'a linha de A deve processar as notificações de A');
  });

  test('leitura de dados do pedido é filtrada pela empresa: pedido de A não é lido sob B', async () => {
    await limparEmpresa(EMPRESA_A);
    await s.insert(getResource('commerce_pedidos')!, {
      id: PEDIDO, empresa_id: EMPRESA_A, pedido_externo: 'PED-SECRETO-A', checkout_token: 'c'.repeat(64),
      comprador: { nome: 'Dado Privado A' }, total: 123.45, estado: 'PENDENTE',
    } as Record<string, unknown>);

    const visto = await carregarDadosPedido(EMPRESA_B, PEDIDO, {});
    assert.equal(visto.nome, null, 'nome do comprador de A não pode aparecer para B');
    assert.equal(visto.total, null, 'total de A não pode aparecer para B');
    assert.notEqual(visto.numero, 'PED-SECRETO-A');
  });
});
