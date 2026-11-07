// ============================================================================
// AGENTE 05 / MISSÃO B — PIPELINE ÚNICO DE WEBHOOKS (P1-07).
//
// O ADR-001 registrava "duas portas de entrada" de webhook de pagamento. A
// arquitetura final possui UM PONTO DE ENTRADA por provedor
// (`POST /api/gateway/webhooks/:provider`) que roteia internamente ao Engine, e
// UMA ÚNICA REGRA DE INGESTÃO — `classificarEntrega` — aplicada a todos os
// provedores. Estes testes fixam a regra:
//
//   • assinatura verificada sobre os bytes crus ANTES da deduplicação;
//   • evento autenticado persistido antes do processamento;
//   • deduplicação por (provedor, evento_id) com isolamento por empresa;
//   • rejeição anterior reaproveitada (não empilha linha);
//   • reentrega já aceita responde duplicado sem segundo efeito.
//
// LOCAL: sem banco, sem rede.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { classificarEntrega } = await import('../../modules/payments/application/webhook-ingest');
type Evento = import('../../modules/payments/application/webhook-ingest').EventoPersistido;

const ev = (over: Partial<Evento> = {}): Evento => ({
  id: 1,
  empresa_id: 1,
  status: 'recebido',
  assinatura_ok: true,
  referencia: 'ORDE_1',
  ...over,
});

test('sem evento anterior: entrega autenticada é persistida', () => {
  const d = classificarEntrega({ anteriores: [], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
  assert.deepEqual(d, { acao: 'persistir', reutilizar: null });
});

test('reentrega idêntica já aceita: duplicado, sem segundo efeito', () => {
  const d = classificarEntrega({ anteriores: [ev()], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
  assert.equal(d.acao, 'duplicado');
});

test('assinatura inválida sobre evento aceito: rejeita SEM gravar (nunca ACK de duplicata)', () => {
  const d = classificarEntrega({ anteriores: [ev()], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: false });
  assert.deepEqual(d, { acao: 'rejeitar', reutilizar: null, persistir: false }, 'não insere segunda linha (índice único) nem confirma o evento aceito');
});

test('rejeição anterior reaproveitada em nova entrega autenticada (sem empilhar linha)', () => {
  const rejeitado = ev({ id: 7, status: 'ignorado', assinatura_ok: false });
  const d = classificarEntrega({ anteriores: [rejeitado], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
  assert.equal(d.acao, 'persistir');
  assert.equal((d as { reutilizar: Evento | null }).reutilizar?.id, 7, 'reaproveita a linha rejeitada');
});

test('rejeição legada SEM empresa não é conflito e é reaproveitada', () => {
  const legado = ev({ id: 3, empresa_id: null, status: 'ignorado', assinatura_ok: false });
  const d = classificarEntrega({ anteriores: [legado], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
  assert.equal(d.acao, 'persistir');
});

test('mesmo evento_id de OUTRA empresa é conflito (isolamento multiempresa)', () => {
  const outro = ev({ id: 9, empresa_id: 2, referencia: 'ORDE_1' });
  const d = classificarEntrega({ anteriores: [outro], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
  assert.equal(d.acao, 'conflito');
});

test('mesmo evento_id para OUTRA cobrança é conflito', () => {
  const outra = ev({ id: 9, referencia: 'ORDE_2' });
  const d = classificarEntrega({ anteriores: [outra], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
  assert.equal(d.acao, 'conflito');
});

test('evento em erro (sem assinatura) volta a ser persistido numa entrega autenticada', () => {
  const erro = ev({ id: 4, status: 'erro', assinatura_ok: false });
  const d = classificarEntrega({ anteriores: [erro], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
  assert.equal(d.acao, 'persistir');
  assert.equal((d as { reutilizar: Evento | null }).reutilizar?.id, 4);
});

test('provedor sem segredo (mock): reentrega idêntica ainda deduplica pelo evento_id', () => {
  const d = classificarEntrega({ anteriores: [ev({ assinatura_ok: true })], empresaId: 1, referencia: 'ORDE_1', temSegredo: false, assinaturaOk: false });
  assert.equal(d.acao, 'duplicado');
});

test('a REGRA é única: os mesmos casos valem para PagBank e Stripe (mesma função)', () => {
  // A função não recebe provedor: não há caminho paralelo que possa divergir.
  for (const provedor of ['pagbank', 'stripe', 'mercadopago', 'mock']) {
    void provedor;
    const d = classificarEntrega({ anteriores: [ev()], empresaId: 1, referencia: 'ORDE_1', temSegredo: true, assinaturaOk: true });
    assert.equal(d.acao, 'duplicado', `${provedor} usa a mesma regra`);
  }
});
