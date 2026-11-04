// Auditoria de segregação (Fase 4.1). LOCAL: store em memória, sem e-mail, sem rede.
// As asserções marcadas como CARACTERIZAÇÃO descrevem o comportamento ATUAL de risco
// (R-12 da matriz). Se mudarem, o teste quebra de propósito: é decisão do Diretor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const A = await import('../src/alertasFalhas');
const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { R_ENTREGAS, R_WEBHOOKS } = await import('../src/webhooks');
const W = await import('../src/commerce/whatsappStatus');
const { runScheduled } = await import('../src/scheduled');
const s = getStore();

test('R-12 (Fase 4.2): o resumo de falhas é por empresa; a contagem de outra empresa não aparece', async () => {
  const agora = new Date().toISOString();
  await s.insert(getResource('commerce_outbox')!, { empresa_id: 101, tipo: 'publicacao', chave: `seg-a-${Date.now()}`, estado: 'ERRO', tentativas: 10, criado_em: agora, atualizado_em: agora, proxima_tentativa_em: agora, payload: {} } as any);
  await s.insert(getResource('commerce_outbox')!, { empresa_id: 202, tipo: 'sincronizacao', chave: `seg-b-${Date.now()}`, estado: 'ERRO', tentativas: 10, criado_em: agora, atualizado_em: agora, proxima_tentativa_em: agora, payload: {} } as any);
  const resumo = await A.coletarFalhasEntrega(new Date(), { empresaId: 101 });
  const e101 = resumo.outbox.find((x) => x.empresa_id === 101);
  assert.ok(e101, 'a falha da própria empresa aparece');
  assert.equal(e101!.tipo, 'publicacao');
  assert.ok(!resumo.outbox.some((x) => x.empresa_id === 202), 'a falha da empresa 202 NÃO aparece no relatório da 101');
});

test('R-14 (Fase 4.2): falha de webhook não entra em relatório por empresa (webhooks não têm empresa_id)', async () => {
  // webhooks/webhook_entregas não têm empresa_id no esquema (db/schema.sql): são configuração
  // global criada por administrador. Logo a falha sai como empresa nula ("—") no relatório.
  // Se o Diretor decidir webhooks por empresa, este teste deve ser trocado (decisão, não correção silenciosa).
  const w2 = await s.insert(R_WEBHOOKS, { empresa_id: 302, nome: 'W302', url: 'https://exemplo.test/b', eventos: 'pedido.criado', ativo: true, segredo: 'x' } as any);
  const agora = new Date().toISOString();
  await s.insert(R_ENTREGAS, { webhook_id: Number(w2.id), evento: 'evento.iso', payload: '{}', estado: 'erro', tentativas: 1, concluida_em: agora } as any);
  // Sem empresa no esquema, a falha não pode ser atribuída com segurança: fica FORA do relatório por empresa.
  const resumo = await A.coletarFalhasEntrega(new Date(), { empresaId: 302 });
  assert.equal(resumo.webhooks.length, 0, 'webhook sem empresa não entra no relatório de nenhuma empresa');
  assert.ok(!resumo.webhooks.some((x) => x.evento === 'evento.iso'));
});

test('isolamento: evento de status WhatsApp altera só a notificação da empresa do wamid', async () => {
  const R = getResource('commerce_notificacoes')!;
  const base = { canal: 'WHATSAPP', evento: 'PEDIDO_CRIADO', estado: 'ENVIADO', provider_status: 'REQUEST_ACCEPTED' };
  const n1 = await s.insert(R, { ...base, empresa_id: 401, provider_message_id: 'wamid.ISO-401', chave_idempotencia: `iso-401-${Date.now()}` } as any);
  const n2 = await s.insert(R, { ...base, empresa_id: 402, provider_message_id: 'wamid.ISO-402', chave_idempotencia: `iso-402-${Date.now()}` } as any);
  assert.equal(await W.aplicarEventoStatusWhatsApp({ messageId: 'wamid.ISO-402', status: 'delivered' }), 'aplicado');
  assert.equal(((await s.get(R, Number(n2.id))) as any).provider_status, 'DELIVERED');
  assert.equal(((await s.get(R, Number(n1.id))) as any).provider_status, 'REQUEST_ACCEPTED', 'empresa 401 não é tocada');
});

test('isolamento: o HTML do relatório não expõe texto bruto de erro, corpo de resposta nem payload', async () => {
  const agora = new Date().toISOString();
  const w = await s.insert(R_WEBHOOKS, { nome: 'W-HTML', url: 'https://exemplo.test/html', eventos: 'x', ativo: true, segredo: 'x' } as any);
  await s.insert(R_ENTREGAS, { webhook_id: Number(w.id), evento: 'evento.html', payload: 'payload-bruto-teste', estado: 'erro', tentativas: 1, resposta_corpo: 'corpo-bruto-teste', erro: 'erro-bruto-teste Bearer abc', concluida_em: agora } as any);
  await s.insert(getResource('commerce_outbox')!, { empresa_id: 1, tipo: 'tipo-html-visivel', chave: `html-${Date.now()}`, estado: 'ERRO', tentativas: 10, criado_em: agora, atualizado_em: agora, proxima_tentativa_em: agora } as any);
  const html = A.htmlSecaoFalhasEntrega(await A.coletarFalhasEntrega(new Date(), { empresaId: 1 }));
  for (const bruto of ['payload-bruto-teste', 'corpo-bruto-teste', 'erro-bruto-teste', 'Bearer abc', 'exemplo.test/html']) {
    assert.ok(!html.includes(bruto), `não deve conter: ${bruto}`);
  }
  assert.ok(html.includes('tipo-html-visivel'), 'o tipo da falha (contagem) continua visível');
});

test('controle: execução manual do relatório exige perfil administrador', async () => {
  const res = { status() { return this; }, json() { return this; } } as any;
  await assert.rejects(
    () => runScheduled({ user: { id: 9, name: 'Gerente', perfil: 'gerente' } } as any, res),
    (erro: any) => erro?.status === 403 || /administrador/i.test(String(erro?.message ?? '')),
  );
});

test('estrutura: as rotas /api/admin/* são montadas depois da exigência de administrador', () => {
  const index = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const guarda = index.indexOf("app.use('/api/admin', requireRole('admin'))");
  assert.ok(guarda > 0, 'a guarda de administrador existe');
  // R-4 (Fase 4.2): o cron externo autentica só por CRON_SECRET e fica FORA da guarda de sessão
  // (ver cron-recorrencias-contrato.test.ts). Aqui ficam as rotas que exigem administrador.
  for (const rota of ["app.get('/api/admin/scheduled/run'", "app.post('/api/admin/notificacoes/smtp/teste'"]) {
    const pos = index.indexOf(rota);
    assert.ok(pos > guarda, `${rota} deve vir após a guarda de administrador`);
  }
});
