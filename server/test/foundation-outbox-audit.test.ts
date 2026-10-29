import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { enfileirarOutbox, processarOutbox, reprocessarOutbox } = await import('../src/commerce/outbox');
const { hashCadeiaAuditoria, verificarCadeiaAuditoria } = await import('../src/auditChain');
const s = getStore();

function request(actor: object, id: number) { return { user: actor, params: { id: String(id) }, body: {}, query: {} } as any; }
function response() { let body: any; return { res: { json: (v: any) => { body = v; } } as any, body: () => body }; }
const gerente = { id: 1, name: 'Gerente', perfil: 'gerente', empresa_id: 1, empresas: [1] };

test('outbox: ação inválida e Woo sem configuração ficam em ERRO, com tentativa e motivo', async () => {
  delete process.env.WOOCOMMERCE_URL; delete process.env.WOOCOMMERCE_CONSUMER_KEY; delete process.env.WOOCOMMERCE_CONSUMER_SECRET;
  const a = await enfileirarOutbox(1, 'sincronizacao', 'acao-invalida', { acao: 'inexistente' });
  const b = await enfileirarOutbox(1, 'sincronizacao', 'sem-config', { acao: 'woo-estoque' });
  const result = await processarOutbox();
  assert.equal(result.erros, 2);
  for (const [id, message] of [[a.id, /desconhecida/i], [b.id, /não configurado/i]] as const) {
    const row = await s.get(RESOURCES.commerce_outbox, Number(id));
    assert.equal(row?.estado, 'ERRO');
    assert.equal(row?.tentativas, 1);
    assert.equal(row?.claim_versao, 1);
    assert.match(row?.ultimo_erro, message);
    assert.equal(row?.proxima_tentativa_em, null);
  }
});

test('outbox: publicação ausente e conversão malformada não somem nem permanecem PROCESSANDO', async () => {
  const a = await enfileirarOutbox(1, 'publicacao', 'publicacao-inexistente', { publicacao_id: 8888 });
  const b = await enfileirarOutbox(1, 'conversao', 'conversao-malformada', {});
  assert.equal((await processarOutbox()).erros, 2);
  for (const row of [a, b]) assert.equal((await s.get(RESOURCES.commerce_outbox, Number(row.id)))?.estado, 'ERRO');
});

test('outbox: reenfileiramento exige gerente e empresa ativa e preserva versão de claim', async () => {
  const row = await enfileirarOutbox(1, 'sincronizacao', 'manual-retry', { acao: 'inexistente' });
  await processarOutbox();
  const other = { ...gerente, empresa_id: 2, empresas: [2] };
  await assert.rejects(() => reprocessarOutbox(request(other, row.id), response().res), (e: any) => e.status === 404);
  await assert.rejects(() => reprocessarOutbox(request({ ...gerente, perfil: 'operador' }, row.id), response().res), (e: any) => e.status === 403);
  const r = response();
  await reprocessarOutbox(request(gerente, row.id), r.res);
  assert.equal(r.body().estado, 'PENDENTE');
  const requeued = await s.get(RESOURCES.commerce_outbox, Number(row.id));
  assert.equal(requeued?.tentativas, 0);
  assert.equal(requeued?.claim_versao, 1);
  const oldClaim = await s.tryUpdateIf(RESOURCES.commerce_outbox, Number(row.id), { estado: 'PROCESSANDO', claim_versao: 1 }, { estado: 'PROCESSADO' });
  assert.equal(oldClaim, null);
  await processarOutbox();
  assert.equal((await s.get(RESOURCES.commerce_outbox, Number(row.id)))?.claim_versao, 2);
});

test('auditoria v2 inclui empresa e tempo; v1 histórica permanece verificável', async () => {
  const legacy = { id: 1, usuario_id: 1, usuario: 'Teste', acao: 'criar', recurso: 'vendas', registro_id: 1, descricao: 'histórico', dados: null, empresa_id: 1, data: '2020-01-01T00:00:00.000Z', hash_versao: 1, hash_anterior: '' };
  const oldHash = hashCadeiaAuditoria('', legacy as any);
  const current = { ...legacy, id: 2, data: '2026-01-01T00:00:00.000Z', hash_versao: 2, hash_anterior: oldHash };
  const currentHash = hashCadeiaAuditoria(oldHash, current as any);
  const rows = [{ ...legacy, hash: oldHash }, { ...current, hash: currentHash }];
  assert.equal(verificarCadeiaAuditoria(rows).ok, true);
  assert.equal(verificarCadeiaAuditoria([rows[0], { ...rows[1], empresa_id: 2 }]).ok, false);
  assert.equal(verificarCadeiaAuditoria([rows[0], { ...rows[1], data: '2026-01-01T00:00:01.000Z' }]).ok, false);
  await s.audit({ empresa_id: 1, usuario_id: 1, usuario: 'Teste', acao: 'ajuste', recurso: 'x', registro_id: 1, descricao: 'auditoria nova', dados: { antes: 1, depois: 2 } });
  assert.equal((await s.verificarAuditoria()).ok, true);
});

test('outbox Woo: evento de outra empresa não pode publicar estoque na loja global', async () => {
  process.env.WOOCOMMERCE_URL = 'https://example.test'; process.env.WOOCOMMERCE_CK = 'ck-test';
  process.env.WOOCOMMERCE_CS = 'cs-test'; process.env.WOOCOMMERCE_EMPRESA_ID = '1';
  const original = globalThis.fetch; let chamadas = 0;
  globalThis.fetch = (async () => { chamadas++; throw new Error('não deve chamar'); }) as typeof fetch;
  try {
    const row = await enfileirarOutbox(2, 'sincronizacao', 'woo-empresa-invalida', { acao: 'woo-estoque' });
    await processarOutbox();
    const after = await s.get(RESOURCES.commerce_outbox, Number(row.id));
    assert.equal(after?.estado, 'ERRO'); assert.match(after?.ultimo_erro, /empresa/i); assert.equal(chamadas, 0);
  } finally {
    globalThis.fetch = original; delete process.env.WOOCOMMERCE_URL; delete process.env.WOOCOMMERCE_CK;
    delete process.env.WOOCOMMERCE_CS; delete process.env.WOOCOMMERCE_EMPRESA_ID;
  }
});

test('agendador informa falhas por etapa em vez de sucesso silencioso', async () => {
  const { processarComercioAgendado } = await import('../src/commerce/outbox');
  await enfileirarOutbox(1, 'sincronizacao', 'scheduled-failure', { acao: 'desconhecida' });
  const result = await processarComercioAgendado();
  assert.ok(result.outbox.erros >= 1); assert.ok(result.falhas.includes('outbox'));
});

test('API genérica de outbox omite payload enquanto o worker mantém acesso interno', async () => {
  const { listRecords, getRecord } = await import('../src/services');
  const row = await enfileirarOutbox(1, 'alerta', 'secret-payload', { token: 'segredo-que-nao-sai-na-api' });
  const scope = { kind: 'empresa', empresaId: 1 } as const;
  const list = await listRecords(RESOURCES.commerce_outbox, { page: 1, pageSize: 100 }, scope);
  assert.equal(list.rows.find((r) => r.id === row.id)?.payload, undefined);
  assert.equal((await getRecord(RESOURCES.commerce_outbox, Number(row.id), scope)).payload, undefined);
  assert.equal((await s.findOneWhere(RESOURCES.commerce_outbox, { id: row.id, empresa_id: 1 }))?.payload.token, 'segredo-que-nao-sai-na-api');
});

test('auditoria: verificação por página preserva hash anterior e detecta adulteração na próxima página', () => {
  const a: any = { id: 1, usuario: 'teste', acao: 'criar', recurso: 'registro', empresa_id: 1, data: '2026-01-01T00:00:00.000Z', hash_versao: 2, hash_anterior: '' };
  a.hash = hashCadeiaAuditoria('', a);
  const b: any = { ...a, id: 2, data: '2026-01-02T00:00:00.000Z', hash_anterior: a.hash };
  b.hash = hashCadeiaAuditoria(a.hash, b);
  assert.equal(verificarCadeiaAuditoria([a]).ok, true);
  assert.equal(verificarCadeiaAuditoria([b], a.hash).ok, true);
  assert.equal(verificarCadeiaAuditoria([{ ...b, empresa_id: 2 }], a.hash).ok, false);
});
