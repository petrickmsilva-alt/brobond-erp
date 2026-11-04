// ============================================================================
// RECONCILIAÇÃO DE WEBHOOKS LEGADOS (Fase 4.3, item 5) — eventos de pagamento
//
// Regras testadas (store em memória, sem rede):
//  • Associação SOMENTE com evidência inequívoca no banco: uma cobrança do mesmo
//    provedor com a mesma referência e empresa definida.
//  • payload NUNCA define a empresa (campo empresa_id no corpo é ignorado).
//  • Ambiguidade (mais de uma cobrança), ausência de correspondência e ausência de
//    referência: o evento permanece sem empresa.
//  • Dry-run não grava nada; aplicar é idempotente; eventos de outra empresa não mudam.
//  • Toda associação gera registro de auditoria com a origem.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { R_GATEWAY_COBRANCAS, R_GATEWAY_WEBHOOK_EVENTS } = await import('../src/gateway');
const { planejarReconciliacaoEventos, aplicarReconciliacaoEventos, reconciliarWebhooksLegados, ORIGEM_RECONCILIACAO, CONFIRMACAO_RECONCILIACAO } = await import('../src/webhookReconciliacao');
const { HttpError } = await import('../src/errors');

const s = getStore();
const ATOR = { id: 1, name: 'Operador de teste' };

async function limpar() {
  for (const r of [R_GATEWAY_WEBHOOK_EVENTS, R_GATEWAY_COBRANCAS]) {
    const lista = await s.list(r, { page: 1, pageSize: 1000 });
    for (const row of lista.rows) await s.remove(r, Number(row.id));
  }
}

async function cobranca(empresa: number, provider_ref: string, provider = 'pagbank') {
  return s.insert(R_GATEWAY_COBRANCAS, {
    empresa_id: empresa, provider, provider_ref, metodo: 'PIX', valor: 10, status: 'PENDENTE',
    idempotency_key: `k-${provider_ref}-${empresa}`, valor_liquido: 10, taxa_pct: 0, parcelas: 1,
  } as never);
}

/** Evento legado: gravado antes da coluna empresa_id existir (empresa_id nulo). */
async function eventoLegado(provider: string, evento_id: string, ref: string | null, extra: Record<string, unknown> = {}) {
  const payload = ref ? { id: ref, status: 'PAID', ...extra } : { status: 'PAID', ...extra };
  const criado = await s.insert(R_GATEWAY_WEBHOOK_EVENTS, {
    empresa_id: 1, provider, evento_id, evento: 'order.updated', payload, assinatura_ok: true,
    status: 'recebido', tentativas: 0, erro: null,
  } as never);
  // O insert do store preenche a empresa padrão; o estado LEGADO (empresa_id NULL) é
  // gravado diretamente na tabela, como ficou no banco antes da coluna existir.
  forcarEmpresaNula(R_GATEWAY_WEBHOOK_EVENTS, Number(criado.id));
  return { ...criado, empresa_id: null } as typeof criado;
}

function forcarEmpresaNula(r: { table: string }, id: number) {
  const store = s as unknown as { table(nome: string): { rows: Map<number, Record<string, unknown>> } };
  const linha = store.table(r.table).rows.get(id);
  assert.ok(linha, 'linha legada precisa existir');
  linha!.empresa_id = null;
}

const linhaDo = (plano: { linhas: Array<{ id: number; decisao: string; empresa_id: number | null }> }, id: number) =>
  plano.linhas.find((l) => l.id === id)!;

describe('Reconciliação de eventos de pagamento legados', () => {
  test('correspondência inequívoca (uma cobrança, empresa definida) é associada', async () => {
    await limpar();
    const c = await cobranca(2, 'ORDE_REF_UNICA_1');
    const e = await eventoLegado('pagbank', 'EV-1', 'ORDE_REF_UNICA_1');
    const plano = await planejarReconciliacaoEventos();
    assert.equal(linhaDo(plano, Number(e.id)).decisao, 'associar');
    assert.equal(linhaDo(plano, Number(e.id)).empresa_id, 2);
    const r = await aplicarReconciliacaoEventos(plano, ATOR);
    assert.equal(r.associados, 1);
    const depois = await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(e.id) });
    assert.equal(Number(depois!.empresa_id), 2);
    assert.ok(c);
  });

  test('associação gera auditoria com a origem da decisão', async () => {
    await limpar();
    await cobranca(3, 'ORDE_REF_AUDIT_1');
    const e = await eventoLegado('pagbank', 'EV-AUD-1', 'ORDE_REF_AUDIT_1');
    await aplicarReconciliacaoEventos(await planejarReconciliacaoEventos(), ATOR);
    const trilha = await s.list(getResource('auditoria')!, { page: 1, pageSize: 200 });
    const texto = JSON.stringify(trilha.rows);
    assert.ok(texto.includes(ORIGEM_RECONCILIACAO), 'a origem da associação deve ficar registrada na auditoria');
    assert.ok(texto.includes('EV-AUD-1'), 'o evento associado deve ser identificado na auditoria');
    assert.ok(texto.includes(`"registro_id":${Number(e.id)}`) || texto.includes(`registro_id":${Number(e.id)}`));
  });

  test('ambiguidade (duas cobranças com a mesma referência) mantém o evento sem empresa', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_AMBIG');
    await cobranca(4, 'ORDE_REF_AMBIG');
    const e = await eventoLegado('pagbank', 'EV-AMB-1', 'ORDE_REF_AMBIG');
    const plano = await planejarReconciliacaoEventos();
    assert.equal(linhaDo(plano, Number(e.id)).decisao, 'ambiguo');
    await aplicarReconciliacaoEventos(plano, ATOR);
    assert.equal((await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(e.id) }))!.empresa_id, null);
  });

  test('sem correspondência e sem referência permanecem sem empresa (preservados, nunca apagados)', async () => {
    await limpar();
    const semCobranca = await eventoLegado('pagbank', 'EV-NC-1', 'ORDE_SEM_COBRANCA');
    const semRef = await eventoLegado('pagbank', 'EV-NR-1', null);
    const plano = await planejarReconciliacaoEventos();
    assert.equal(linhaDo(plano, Number(semCobranca.id)).decisao, 'sem_correspondencia');
    assert.equal(linhaDo(plano, Number(semRef.id)).decisao, 'sem_referencia');
    await aplicarReconciliacaoEventos(plano, ATOR);
    assert.ok(await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(semCobranca.id) }), 'evento não pode ser apagado');
    assert.equal((await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(semRef.id) }))!.empresa_id, null);
  });

  test('payload NÃO define a empresa: empresa_id no corpo é ignorado', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_ADULT');
    // Payload adulterado tentando apontar para a empresa 9 (que não tem cobrança).
    const e = await eventoLegado('pagbank', 'EV-ADULT-1', 'ORDE_REF_ADULT', { empresa_id: 9, cobranca_empresa: 9 });
    const plano = await planejarReconciliacaoEventos();
    assert.equal(linhaDo(plano, Number(e.id)).empresa_id, 2, 'a empresa vem da cobrança, não do payload');
    await aplicarReconciliacaoEventos(plano, ATOR);
    assert.equal(Number((await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(e.id) }))!.empresa_id), 2);
  });

  test('dry-run não grava nada', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_DRY');
    const e = await eventoLegado('pagbank', 'EV-DRY-1', 'ORDE_REF_DRY');
    await planejarReconciliacaoEventos();
    assert.equal((await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(e.id) }))!.empresa_id, null);
  });

  test('aplicar é idempotente: a segunda execução não associa nada de novo', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_IDEM');
    await eventoLegado('pagbank', 'EV-IDEM-1', 'ORDE_REF_IDEM');
    const primeira = await aplicarReconciliacaoEventos(await planejarReconciliacaoEventos(), ATOR);
    const segunda = await aplicarReconciliacaoEventos(await planejarReconciliacaoEventos(), ATOR);
    assert.equal(primeira.associados, 1);
    assert.equal(segunda.associados, 0);
  });

  test('evento já associado a outra empresa nunca é reatribuído', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_JA');
    const e = await s.insert(R_GATEWAY_WEBHOOK_EVENTS, {
      empresa_id: 7, provider: 'pagbank', evento_id: 'EV-JA-1', evento: 'order.updated',
      payload: { id: 'ORDE_REF_JA' }, assinatura_ok: true, status: 'recebido', tentativas: 0,
    } as never);
    const plano = await planejarReconciliacaoEventos();
    assert.equal(plano.linhas.some((l) => l.id === Number(e.id)), false, 'evento com empresa não entra no plano');
    await aplicarReconciliacaoEventos(plano, ATOR);
    assert.equal(Number((await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(e.id) }))!.empresa_id), 7);
  });

  test('provedor desconhecido não é associado', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_X', 'desconhecido');
    const e = await eventoLegado('desconhecido', 'EV-X-1', 'ORDE_REF_X');
    const plano = await planejarReconciliacaoEventos();
    assert.equal(linhaDo(plano, Number(e.id)).decisao, 'provedor_desconhecido');
  });

  test('aplicar sem confirmação explícita é recusado (400) e nada é gravado', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_HTTP');
    const e = await eventoLegado('pagbank', 'EV-HTTP-1', 'ORDE_REF_HTTP');
    const req = { body: { aplicar: true }, user: { id: 1, name: 'Admin', perfil: 'admin' } } as never;
    const res = { setHeader() {}, json() {} } as never;
    await assert.rejects(reconciliarWebhooksLegados(req, res), (err: unknown) => err instanceof HttpError && (err as InstanceType<typeof HttpError>).status === 400);
    assert.equal((await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(e.id) }))!.empresa_id, null);
    assert.ok(CONFIRMACAO_RECONCILIACAO);
  });

  test('dry-run pela rota responde sem payload e sem alterar dados', async () => {
    await limpar();
    await cobranca(2, 'ORDE_REF_HTTP2');
    const e = await eventoLegado('pagbank', 'EV-HTTP-2', 'ORDE_REF_HTTP2', { cliente_cpf: '000.000.000-00' });
    let corpo: Record<string, unknown> = {};
    const req = { body: {}, user: { id: 1, name: 'Admin', perfil: 'admin' } } as never;
    const res = { setHeader() {}, json(b: Record<string, unknown>) { corpo = b; } } as never;
    await reconciliarWebhooksLegados(req, res);
    const texto = JSON.stringify(corpo);
    assert.equal(corpo.modo, 'dry-run');
    assert.ok(!texto.includes('000.000.000-00'), 'payload não pode sair na resposta');
    assert.ok(!texto.includes('ORDE_REF_HTTP2'), 'referência de cobrança não pode sair na resposta');
    assert.equal((await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { id: Number(e.id) }))!.empresa_id, null);
  });
});
