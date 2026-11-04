// Fase 7 (P2-08) — falhas de envio no relatório de alertas.
// LOCAL: função pura + store em memória. Sem e-mail real, sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const A = await import('../src/alertasFalhas');
const { getStore } = await import('../src/services');
const { coletarFalhasEntrega, htmlSecaoFalhasEntrega } = A;
const { getResource } = await import('../src/resources');
const { R_ENTREGAS, R_WEBHOOKS } = await import('../src/webhooks');
const s = getStore();

const AGORA = new Date('2026-11-03T12:00:00-03:00');
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3600_000).toISOString();

test('sem falhas: resumo zerado e seção HTML vazia (relatório segue sem bloco de falhas)', () => {
  const r = A.agruparFalhasEntrega([], [], () => null, AGORA);
  assert.equal(r.total, 0);
  assert.equal(A.htmlSecaoFalhasEntrega({ ...r, truncado: false }), '');
});

test('agrupa outbox em ERRO por empresa e tipo, e entregas por empresa do webhook dentro de 24h', () => {
  const outbox = [
    { empresa_id: 1, tipo: 'publicacao' }, { empresa_id: 1, tipo: 'publicacao' }, { empresa_id: 2, tipo: 'sincronizacao' },
  ];
  const entregas = [
    { webhook_id: 10, evento: 'pedido.criado', concluida_em: horasAtras(2) },
    { webhook_id: 10, evento: 'pedido.criado', concluida_em: horasAtras(23) },
    { webhook_id: 10, evento: 'pedido.criado', concluida_em: horasAtras(30) }, // fora da janela
    { webhook_id: 99, evento: 'estoque.baixo', concluida_em: horasAtras(1) },  // webhook sem empresa conhecida
  ];
  const mapa: Record<number, number> = { 10: 1 };
  const r = A.agruparFalhasEntrega(outbox, entregas, (id) => mapa[id] ?? null, AGORA);
  assert.equal(r.outbox.find((x) => x.empresa_id === 1)?.total, 2);
  assert.equal(r.outbox.find((x) => x.empresa_id === 2)?.total, 1);
  assert.equal(r.webhooks.find((x) => x.evento === 'pedido.criado')?.total, 2);
  assert.equal(r.webhooks.find((x) => x.evento === 'estoque.baixo')?.empresa_id, null);
  assert.equal(r.total, 3 + 2 + 1);
});

test('seção HTML mostra só contagens e escapa rótulos; nunca traz payload ou texto de erro', () => {
  const resumo = A.agruparFalhasEntrega(
    [{ empresa_id: 7, tipo: '<b>publicacao</b>' }],
    [{ webhook_id: 3, evento: 'pedido.<script>', concluida_em: horasAtras(1) }],
    () => 7,
    AGORA,
  );
  const html = A.htmlSecaoFalhasEntrega({ ...resumo, truncado: true });
  assert.ok(html.includes('Empresa #7'));
  assert.ok(!html.includes('<b>publicacao</b>') && html.includes('&lt;b&gt;publicacao&lt;/b&gt;'));
  assert.ok(!html.includes('<script>') && html.includes('pedido.&lt;script&gt;'));
  assert.ok(html.includes('Leitura limitada'));
});

test('leitura do banco: falha de outbox e entrega aparece no resumo; texto bruto de erro não sai no e-mail', async () => {
  const empresaId = 1;
  const webhook = await s.insert(R_WEBHOOKS, { empresa_id: empresaId, nome: 'Webhook teste P7', url: 'https://exemplo.test/hook', eventos: 'pedido.criado', ativo: true, segredo: 'x' } as any);
  const segredoBruto = 'token-bruto-do-provedor-12345';
  await s.insert(R_ENTREGAS, { webhook_id: Number(webhook.id), evento: 'pedido.criado', payload: '{"telefone":"5562999990000"}', estado: 'erro', tentativas: 1, erro: `HTTP 500 ${segredoBruto}`, concluida_em: new Date().toISOString() } as any);
  await s.insert(getResource('commerce_outbox')!, { empresa_id: empresaId, tipo: 'publicacao', chave: `p7-outbox-${Date.now()}`, estado: 'ERRO', tentativas: 10, ultimo_erro: `falha ${segredoBruto}`, payload: { sku: 'X' }, proxima_tentativa_em: new Date().toISOString(), criado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() } as any);

  // R-12/R-14 (Fase 4.2): leitura por empresa. Falha de webhook (sem empresa no esquema) não entra no total.
  const resumo = await coletarFalhasEntrega(new Date(), { empresaId });
  assert.ok(resumo.total >= 1, `total=${resumo.total}`);
  assert.equal(resumo.webhooks.length, 0, 'webhook sem empresa fica fora do relatório por empresa');
  const html = htmlSecaoFalhasEntrega(resumo);
  assert.ok(html.includes('Falhas de envio'));
  assert.ok(!html.includes(segredoBruto), 'texto bruto de erro não pode sair no e-mail');
  assert.ok(!html.includes('5562999990000'), 'payload/telefone não pode sair no e-mail');
});

test('notificações em falha (estado ERRO ou provider FAILED) entram no resumo, agrupadas por canal e empresa', () => {
  const r = A.agruparFalhasEntrega([], [], () => null, AGORA, 24, [
    { empresa_id: 1, canal: 'WHATSAPP', quando: horasAtras(3) },
    { empresa_id: 1, canal: 'WHATSAPP', quando: horasAtras(5) },
    { empresa_id: 1, canal: 'EMAIL', quando: horasAtras(30) }, // fora da janela
  ]);
  assert.equal(r.total, 2);
  assert.deepEqual(r.notificacoes, [{ empresa_id: 1, canal: 'WHATSAPP', total: 2 }]);
  const html = A.htmlSecaoFalhasEntrega({ ...r, truncado: false });
  assert.ok(html.includes('Notificações (e-mail/WhatsApp) não entregues'));
  assert.ok(html.includes('WHATSAPP'));
});

test('leitura do banco: notificação em erro conta uma vez mesmo que apareça em ERRO e FAILED', async () => {
  const R = getResource('commerce_notificacoes')!;
  const textoBruto = 'resposta bruta com telefone 5562988880000 e token-zzz';
  await s.insert(R, { empresa_id: 1, canal: 'WHATSAPP', evento: 'PEDIDO_PAGO', estado: 'ERRO', provider_status: 'FAILED', provider_message_id: 'wamid.P7-1', ultimo_erro: textoBruto, chave_idempotencia: `p7-notif-${Date.now()}`, atualizado_em: new Date().toISOString() } as any);
  const resumo = await coletarFalhasEntrega(new Date(), { empresaId: 1 });
  const linhaWhats = resumo.notificacoes.find((x) => x.canal === 'WHATSAPP' && x.empresa_id === 1);
  assert.ok(linhaWhats && linhaWhats.total >= 1);
  const html = htmlSecaoFalhasEntrega(resumo);
  assert.ok(!html.includes('token-zzz') && !html.includes('5562988880000'));
});
