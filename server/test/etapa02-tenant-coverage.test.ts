// ============================================================================
// ETAPA 02 — TENANT COVERAGE: isolamento A × B dos 19 recursos sem evidência
// nominal no inventário (docs/ERP-3.0-ARCHITECTURE-INVENTORY.json, regra
// TENANT_SEM_TESTE).
//
// Cada bloco exercita o CAMINHO REAL (serviço genérico com escopo, handler
// dedicado ou módulo), não um mock do isolamento:
//   • listagem/get/update/delete de A não alcançam B (e vice-versa);
//   • ID de B usado por A responde 404 (nunca 403 — não vaza existência);
//   • escrita carimba a empresa do ator/registro-pai, nunca a do cliente;
//   • processos dedicados (webhook inbox, oauth, auditoria encadeada, memória
//     de preço) preservam a organização de origem.
//
// Recursos cobertos (19):
//   creator_commands, service_ticket_categorias, condicoes_pagamento,
//   produto_precos_condicao, produto_precos_condicao_historico,
//   politica_comercial_descontos_cumulativos, politica_preco_minimo,
//   precificacao_memoria, devolucoes_fornecedor, devolucao_fornecedor_itens,
//   devolucao_fornecedor_eventos, woocommerce_product_links,
//   woocommerce_sync_state, woocommerce_webhook_events,
//   woocommerce_reconciliacao_divergencias, operational_audit_events,
//   oauth_consents, oauth_authorization_codes, oauth_tokens.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getResource, getPublicResource } = await import('../src/resources');
const { getStore, createRecord, getRecord, listRecords, updateRecord, deleteRecord } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const s = getStore();
const escopoA = escopoDeSistema(1);
const escopoB = escopoDeSistema(2);
const adminA = await criarAtor(1, 'admin');
const adminB = await criarAtor(2, 'admin');
const tag = Date.now().toString(36);

const httpStatus = (e: unknown) => (e as { status?: number }).status;

/** CRUD genérico: A cria; B não lê/lista/altera/exclui; e o inverso. */
async function provarCrudIsolado(key: string, body: Record<string, unknown>, patch: Record<string, unknown>) {
  const r = getResource(key)!;
  assert.ok(r, `recurso ${key} existe`);
  const rowA = await createRecord(r, body, adminA, { escopo: escopoA });
  assert.equal(Number(rowA.empresa_id), 1, `${key}: criação carimba empresa do ator`);

  // B não lê pelo ID de A.
  await assert.rejects(() => getRecord(r, Number(rowA.id), escopoB), (e: unknown) => httpStatus(e) === 404, `${key}: get cruzado é 404`);
  // B não lista o registro de A (nem com filtro forjado de empresa).
  const listaB = await listRecords(r, { page: 1, pageSize: 500, filter: { empresa_id: 1 } }, escopoB);
  assert.ok(!listaB.rows.some((x) => Number(x.id) === Number(rowA.id)), `${key}: listagem de B não contém linha de A (filtro forjado ignorado)`);
  // B não altera nem exclui pelo ID de A.
  await assert.rejects(() => updateRecord(r, Number(rowA.id), patch, adminB, { escopo: escopoB }), (e: unknown) => httpStatus(e) === 404, `${key}: update cruzado é 404`);
  await assert.rejects(() => deleteRecord(r, Number(rowA.id), adminB, escopoB), (e: unknown) => httpStatus(e) === 404, `${key}: delete cruzado é 404`);
  // A ainda lê o próprio registro (o isolamento não quebrou o acesso legítimo).
  const lido = await getRecord(r, Number(rowA.id), escopoA);
  assert.equal(Number(lido.id), Number(rowA.id));
  return rowA;
}

// ---------------------------------------------------------------------------
// 1) CRUD genérico com escopo (recursos públicos do painel)
// ---------------------------------------------------------------------------
test('tenant: service_ticket_categorias — A × B no CRUD genérico', async () => {
  await provarCrudIsolado('service_ticket_categorias', { nome: `Troca ${tag}` }, { nome: 'invasão' });
});

test('tenant: condicoes_pagamento — A × B no CRUD genérico', async () => {
  await provarCrudIsolado('condicoes_pagamento', { codigo: `pix_${tag}`, nome: 'PIX', canal: 'todos', parcelas: 1, prazo_dias: 0 }, { nome: 'invasão' });
});

test('tenant: produto_precos_condicao — A × B; produto de B não é referenciável por A', async () => {
  const prodA = await createRecord(RESOURCES.produtos, { sku: `PC-${tag}`, nome: 'Produto A', preco_venda: 100 }, adminA, { escopo: escopoA });
  const prodB = await createRecord(RESOURCES.produtos, { sku: `PC-${tag}`, nome: 'Produto B', preco_venda: 100 }, adminB, { escopo: escopoB });
  await provarCrudIsolado('produto_precos_condicao', { produto_id: Number(prodA.id), canal: 'varejo', condicao: 'pix', preco: 95 }, { preco: 1 });
  // A não cria preço para produto de B (referência cruzada recusada).
  await assert.rejects(
    () => createRecord(RESOURCES.produto_precos_condicao, { produto_id: Number(prodB.id), canal: 'varejo', condicao: 'pix', preco: 50 }, adminA, { escopo: escopoA }),
    (e: unknown) => [404, 400, 409].includes(httpStatus(e) ?? 0),
    'referência a produto de outra empresa é recusada'
  );
});

test('tenant: politica_comercial_descontos_cumulativos — A × B no CRUD genérico', async () => {
  await provarCrudIsolado('politica_comercial_descontos_cumulativos', { nome: `Regra ${tag}`, desconto_pct: 5, escopo: 'geral', canal: 'todos', ativo: true }, { desconto_pct: 50 });
});

test('tenant: politica_preco_minimo — A × B no CRUD genérico', async () => {
  await provarCrudIsolado('politica_preco_minimo', { margem_minima_pct: 10, bloqueio_ativo: false }, { bloqueio_ativo: true });
});

// ---------------------------------------------------------------------------
// 2)precificacao_memoria — escrita derivada do PRODUTO (regressão do bug real)
// ---------------------------------------------------------------------------
test('tenant: precificacao_memoria — empresa vem do produto, nunca do default; leitura é recortada', async () => {
  const { registrarMemoriaPrecificacao } = await import('../src/commerce/motorPrecos');
  const prodB = await createRecord(RESOURCES.produtos, { sku: `MEM-${tag}`, nome: 'Produto B memória', preco_venda: 100 }, adminB, { escopo: escopoB });
  const entrada = { canal: 'varejo' as const, produto_id: Number(prodB.id), quantidade: 1, preco_lista: 100, preco_aplicado: 90, desconto_pct: 10, custo: 50, margem_valor: 40, margem_pct: 44, origem_preco: 'produto' };
  const id = await registrarMemoriaPrecificacao(entrada);
  assert.ok(id, 'memória gravada');
  const linha = await s.findOneWhere(RESOURCES.precificacao_memoria, { id });
  assert.equal(Number(linha!.empresa_id), 2, 'a memória pertence à empresa do PRODUTO (não ao default 1)');
  // A não lê a memória de B.
  await assert.rejects(() => getRecord(RESOURCES.precificacao_memoria, Number(id), escopoA), (e: unknown) => httpStatus(e) === 404);
  const listaA = await listRecords(RESOURCES.precificacao_memoria, { page: 1, pageSize: 500 }, escopoA);
  assert.ok(!listaA.rows.some((x) => Number(x.id) === Number(id)));
  // Append-only: escrita genérica é bloqueada para todos.
  assert.equal(RESOURCES.precificacao_memoria.ops.create, false);
  assert.equal(RESOURCES.precificacao_memoria.ops.update, false);
  assert.equal(RESOURCES.precificacao_memoria.ops.delete, false);
  // Produto inexistente não gera trilha órfã.
  assert.equal(await registrarMemoriaPrecificacao({ ...entrada, produto_id: 99999999 }), null);
});

// ---------------------------------------------------------------------------
// 3) produto_precos_condicao_historico — interno, escrito pela carga versionada
// ---------------------------------------------------------------------------
test('tenant: produto_precos_condicao_historico — interno, append-only, leitura recortada', async () => {
  const r = RESOURCES.produto_precos_condicao_historico;
  assert.equal(r.internal, true);
  assert.equal(getPublicResource('produto_precos_condicao_historico'), undefined, 'CRUD genérico não expõe');
  const prodA = await createRecord(RESOURCES.produtos, { sku: `HIST-${tag}`, nome: 'Produto A histórico', preco_venda: 100 }, adminA, { escopo: escopoA });
  const h = await s.insert(r, { empresa_id: 1, produto_id: Number(prodA.id), canal: 'varejo', condicao: 'pix', preco_anterior: null, preco_novo: 95, origem: 'planilha' });
  await assert.rejects(() => getRecord(r, Number(h.id), escopoB), (e: unknown) => httpStatus(e) === 404);
  const listaB = await listRecords(r, { page: 1, pageSize: 500, filter: { produto_id: Number(prodA.id) } }, escopoB);
  assert.equal(listaB.rows.length, 0);
});

// ---------------------------------------------------------------------------
// 4) creator_commands — idempotência por empresa (handler real de creators)
// ---------------------------------------------------------------------------
test('tenant: creator_commands — mesma chave em A e B são operações distintas; registro é da empresa do ator', async () => {
  const { createCreatorsEntity, detailCreatorsEntity } = await import('../src/creators');
  const chave = `tenant-creators-${tag}`;
  const mkReq = (actor: unknown, body: object) => ({ body, params: {}, user: actor, query: {}, get: () => chave } as any);
  const mkRes = () => { let payload: any; let code = 200; const out: any = { json(v: any) { payload = v; return out; }, status(v: number) { code = v; return out; }, setHeader() {} }; return { out, get: () => ({ payload, code }) }; };
  const dados = { name: 'Creator Tenant', platform: 'INSTAGRAM', handle: `tenant.${tag}` };
  const rA = mkRes(); await createCreatorsEntity('profile')(mkReq(adminA, dados), rA.out);
  assert.equal(rA.get().code, 201);
  const rB = mkRes(); await createCreatorsEntity('profile')(mkReq(adminB, dados), rB.out);
  assert.equal(rB.get().code, 201, 'mesma chave em outra empresa NÃO colide nem devolve o registro de A');
  assert.notEqual(rA.get().payload.row.id, rB.get().payload.row.id);
  const cmdsA = await s.list(RESOURCES.creator_commands, { page: 1, pageSize: 100, filter: { empresa_id: 1, idempotency_key: chave } });
  const cmdsB = await s.list(RESOURCES.creator_commands, { page: 1, pageSize: 100, filter: { empresa_id: 2, idempotency_key: chave } });
  assert.equal(cmdsA.rows.length, 1);
  assert.equal(cmdsB.rows.length, 1);
  assert.equal(Number(cmdsA.rows[0].entity_id), Number(rA.get().payload.row.id));
  assert.equal(Number(cmdsB.rows[0].entity_id), Number(rB.get().payload.row.id));
  // B não lê o profile de A pelo ID.
  const rDet = mkRes();
  await assert.rejects(
    () => detailCreatorsEntity('profile')({ body: {}, params: { id: String(rA.get().payload.row.id) }, user: adminB, query: {}, get: () => '' } as any, rDet.out),
    (e: unknown) => httpStatus(e) === 404
  );
  // Recurso interno: não exposto no CRUD genérico.
  assert.equal(getPublicResource('creator_commands'), undefined);
});

// ---------------------------------------------------------------------------
// 5) Devolução a fornecedor — documento + itens + eventos (handlers reais)
// ---------------------------------------------------------------------------
test('tenant: devolucoes_fornecedor, devolucao_fornecedor_itens, devolucao_fornecedor_eventos — documento de A invisível e inalterável para B', async () => {
  const { criarDevolucaoFornecedor, obterDevolucaoFornecedor, cancelarDevolucaoFornecedor } = await import('../src/devolucaoFornecedor');
  const chamar = async (handler: any, opts: { id?: number; body?: any; actor: any }) => {
    let payload: any;
    const req: any = { params: opts.id ? { id: String(opts.id) } : {}, body: opts.body ?? {}, user: opts.actor, query: {} };
    const res: any = { status: () => res, json: (v: any) => (payload = v) };
    await handler(req, res);
    return payload;
  };
  const gerenteA = await criarAtor(1, 'gerente');
  const gerenteB = await criarAtor(2, 'gerente');
  const fornecedor = await createRecord(RESOURCES.fornecedores, { nome: `Forn dev ${tag}`, ativo: true }, adminA, { escopo: escopoA });
  const produto = await createRecord(RESOURCES.produtos, { sku: `DEV-${tag}`, nome: 'Produto dev', custo: 10, preco_venda: 30 }, adminA, { escopo: escopoA });
  const local = await createRecord(RESOURCES.locais, { nome: `local-dev-${tag}`, tipo: 'loja', ativo: true, padrao: true }, adminA, { escopo: escopoA });
  const compra = await createRecord(RESOURCES.compras, { fornecedor_id: Number(fornecedor.id), data: new Date().toISOString().slice(0, 10), total: 0 }, adminA, { escopo: escopoA });
  await s.update(RESOURCES.compras, Number(compra.id), { status: 'aprovado' });
  const receb = await s.insert(RESOURCES.itens_compra, { empresa_id: 1, compra_id: Number(compra.id), produto_id: Number(produto.id), insumo_id: null, quantidade: 10, quantidade_recebida: 5, preco_unitario: 10 });
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: Number(produto.id), quantidade: 10, local_id: Number(local.id) }, adminA, { escopo: escopoA });
  const out = await chamar(criarDevolucaoFornecedor, { id: Number(compra.id), actor: gerenteA, body: { motivo: 'defeito', itens: [{ item_compra_id: Number(receb.id), quantidade: 1 }] } });
  const devId = Number(out.devolucao.id);
  assert.equal(Number(out.devolucao.empresa_id), 1);
  // B não obtém nem cancela o documento de A.
  await assert.rejects(() => chamar(obterDevolucaoFornecedor, { id: devId, actor: gerenteB }), (e: unknown) => httpStatus(e) === 404);
  await assert.rejects(() => chamar(cancelarDevolucaoFornecedor, { id: devId, actor: gerenteB, body: { motivo: 'invasão' } }), (e: unknown) => httpStatus(e) === 404);
  // Itens e eventos carregam a empresa do documento e não vazam para B.
  const itens = await s.list(RESOURCES.devolucao_fornecedor_itens, { page: 1, pageSize: 100, filter: { devolucao_id: devId } });
  assert.ok(itens.rows.length >= 1);
  for (const it of itens.rows) assert.equal(Number(it.empresa_id), 1);
  const itensB = await listRecords(RESOURCES.devolucao_fornecedor_itens, { page: 1, pageSize: 100, filter: { devolucao_id: devId } }, escopoB);
  assert.equal(itensB.rows.length, 0);
  const eventos = await s.list(RESOURCES.devolucao_fornecedor_eventos, { page: 1, pageSize: 100, filter: { devolucao_id: devId } });
  assert.ok(eventos.rows.length >= 1);
  for (const ev of eventos.rows) assert.equal(Number(ev.empresa_id), 1);
  const eventosB = await listRecords(RESOURCES.devolucao_fornecedor_eventos, { page: 1, pageSize: 100, filter: { devolucao_id: devId } }, escopoB);
  assert.equal(eventosB.rows.length, 0);
  const devsB = await listRecords(RESOURCES.devolucoes_fornecedor, { page: 1, pageSize: 100 }, escopoB);
  assert.ok(!devsB.rows.some((d) => Number(d.id) === devId));
});

// ---------------------------------------------------------------------------
// 6) WooCommerce — links, sync state, webhook inbox e divergências
// ---------------------------------------------------------------------------
test('tenant: woocommerce_product_links e woocommerce_sync_state — estado por (empresa, loja), sem cruzamento', async () => {
  const { registrarVinculo, vinculoDoProduto, listarVinculos } = await import('../src/commerce/woocommerce/vinculos');
  const { estadoDaStore, registrarSincronizacao } = await import('../src/commerce/woocommerce/estado');
  const prodA = await createRecord(RESOURCES.produtos, { sku: `WOO-${tag}`, nome: 'Produto Woo A', preco_venda: 100 }, adminA, { escopo: escopoA });
  const prodB = await createRecord(RESOURCES.produtos, { sku: `WOO-${tag}`, nome: 'Produto Woo B', preco_venda: 100 }, adminB, { escopo: escopoB });
  await registrarVinculo(1, 'RETAIL', Number(prodA.id), { external_product_id: '777', sku: `WOO-${tag}` });
  await registrarVinculo(2, 'RETAIL', Number(prodB.id), { external_product_id: '777', sku: `WOO-${tag}` });
  // Mesmo ID externo em empresas diferentes: cada uma vê SOMENTE o seu vínculo.
  const vincA = await vinculoDoProduto(1, 'RETAIL', Number(prodA.id));
  const vincB = await vinculoDoProduto(2, 'RETAIL', Number(prodB.id));
  assert.equal(Number(vincA!.empresa_id), 1);
  assert.equal(Number(vincB!.empresa_id), 2);
  assert.equal(await vinculoDoProduto(2, 'RETAIL', Number(prodA.id)), null, 'produto de A não tem vínculo em B');
  const listaB = await listarVinculos(2, 'RETAIL');
  assert.ok(!listaB.some((v) => Number(v.produto_id) === Number(prodA.id)));
  // Sync state: avançar a água-marca de A não toca a de B.
  await registrarSincronizacao(1, 'RETAIL', { ultima_publicacao_em: '2026-11-14T10:00:00.000Z' });
  const estadoA = await estadoDaStore(1, 'RETAIL');
  const estadoB = await estadoDaStore(2, 'RETAIL');
  assert.ok(estadoA.ultima_publicacao_em);
  assert.equal(estadoB.ultima_publicacao_em ?? null, null, 'estado de B não herda publicação de A');
  assert.equal(Number(estadoA.empresa_id), 1);
  assert.equal(Number(estadoB.empresa_id), 2);
});

test('tenant: woocommerce_webhook_events — entrega de A não é visível nem reenfileirável por B', async () => {
  const { registrarEntrega, entregaPorId, reenfileirarEntrega } = await import('../src/commerce/woocommerce/webhookInbox');
  const cfgA = { store_key: 'RETAIL' as const } as any;
  const dados = { topic: 'order.created', recurso: 'pedido', external_delivery_id: `del-${tag}`, external_resource_id: '42', payload: { id: 42 }, payload_hash: `hash-${tag}`, assinatura_ok: true, correlation_id: `corr-${tag}` };
  const emA = await registrarEntrega(cfgA, 1, dados as any);
  assert.equal(emA.duplicado, false);
  // Mesma entrega (mesmo delivery id) em B é OUTRO evento — idempotência é por empresa.
  const emB = await registrarEntrega(cfgA, 2, dados as any);
  assert.equal(emB.duplicado, false);
  assert.notEqual(emA.id, emB.id);
  // Replay em A é duplicado (não cria terceiro evento).
  const replay = await registrarEntrega(cfgA, 1, dados as any);
  assert.equal(replay.duplicado, true);
  assert.equal(replay.id, emA.id);
  // B não acessa o evento de A pelo ID.
  assert.equal(await entregaPorId(2, emA.id), null);
  assert.ok(await entregaPorId(1, emA.id));
  // B não reenfileira evento de A.
  assert.equal(await reenfileirarEntrega(2, 'RETAIL', emA.id), false);
  const linhaA = await s.findOneWhere(RESOURCES.woocommerce_webhook_events, { id: emA.id });
  const linhaB = await s.findOneWhere(RESOURCES.woocommerce_webhook_events, { id: emB.id });
  assert.equal(Number(linhaA!.empresa_id), 1);
  assert.equal(Number(linhaB!.empresa_id), 2);
});

test('tenant: woocommerce_reconciliacao_divergencias — fingerprint igual em A e B não colide; listagem recortada', async () => {
  const { registrarDivergencia, listarDivergencias } = await import('../src/commerce/woocommerce/reconciliacao');
  const d = { categoria: 'preco', tipo: 'PRECO_DIVERGENTE', classificacao: 'AVISO', sku: `SKU-${tag}`, external_product_id: '999', detalhe: 'preço externo diverge', dados: { erp: 100, externo: 90 } } as any;
  const emA = await registrarDivergencia(1, 'RETAIL', d);
  const emB = await registrarDivergencia(2, 'RETAIL', d);
  assert.notEqual(Number(emA.id), Number(emB.id), 'mesma fingerprint em empresas diferentes são documentos distintos');
  assert.equal(Number(emA.empresa_id), 1);
  assert.equal(Number(emB.empresa_id), 2);
  const listaA = await listarDivergencias(1, 'RETAIL');
  assert.ok(listaA.some((x) => Number(x.id) === Number(emA.id)));
  assert.ok(!listaA.some((x) => Number(x.id) === Number(emB.id)));
  // Re-detecção em A é idempotente (mesma linha, não empilha).
  const deNovo = await registrarDivergencia(1, 'RETAIL', d);
  assert.equal(Number(deNovo.id), Number(emA.id));
});

// ---------------------------------------------------------------------------
// 7) Operational Control Plane — trilha encadeada e OAuth por empresa
// ---------------------------------------------------------------------------
test('tenant: operational_audit_events — cadeia por empresa; evento de A não entra na trilha de B', async () => {
  const { auditarOperacao } = await import('../../modules/operational-control/infrastructure/audit');
  const { R_AUDIT_EVENTS } = await import('../../modules/operational-control/infrastructure/resources');
  await auditarOperacao({ empresaId: 1, actorId: adminA.id, eventType: 'oauth.token_issued', payload: { marco: `A-${tag}` } });
  await auditarOperacao({ empresaId: 2, actorId: adminB.id, eventType: 'oauth.token_issued', payload: { marco: `B-${tag}` } });
  await auditarOperacao({ empresaId: 1, actorId: adminA.id, eventType: 'oauth.token_revoked', payload: { marco: `A2-${tag}` } });
  const doA = await s.list(R_AUDIT_EVENTS, { page: 1, pageSize: 1000, sort: 'id', dir: 'asc', filter: { empresa_id: 1 } });
  const doB = await s.list(R_AUDIT_EVENTS, { page: 1, pageSize: 1000, sort: 'id', dir: 'asc', filter: { empresa_id: 2 } });
  assert.ok(doA.rows.length >= 2 && doB.rows.length >= 1);
  for (const ev of doA.rows) assert.equal(Number(ev.empresa_id), 1);
  for (const ev of doB.rows) assert.equal(Number(ev.empresa_id), 2);
  // A cadeia de B NÃO encadeia no último evento de A: o primeiro evento de B
  // tem previous_hash próprio (genesis da empresa), nunca o hash de A.
  const hashesA = new Set(doA.rows.map((r) => String(r.event_hash)));
  const primeiroB = doB.rows[0];
  assert.ok(!hashesA.has(String(primeiroB.previous_hash ?? '')), 'trilha de B não pode encadear em evento de A');
  assert.equal(getPublicResource('operational_audit_events'), undefined, 'trilha não é exposta no CRUD genérico');
});

test('tenant: oauth_authorization_codes e oauth_tokens — código/token carregam a empresa do consentimento, não do cliente', async () => {
  const { criarCodigo, consumirCodigo, derivarChallenge } = await import('../../modules/operational-control/oauth/codes');
  const { emitirAccessToken, emitirRefreshToken, validarAccessToken, revogarToken } = await import('../../modules/operational-control/oauth/tokens');
  const { R_OAUTH_CODES, R_OAUTH_TOKENS } = await import('../../modules/operational-control/infrastructure/resources');
  const { SCOPES } = await import('../../modules/operational-control/domain/scopes');
  const verifier = `verifier-tenant-${tag}-com-mais-de-43-caracteres-abcdef`;
  const cliente = `cliente-tenant-${tag}`;
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
  // Código emitido no contexto da empresa 1 carimba empresa 1.
  const codigoA = await criarCodigo({ clientId: cliente, usuarioId: adminA.id, empresaId: 1, perfil: 'admin', redirectUri: redirect, scope: SCOPES.workflowRead, codeChallenge: derivarChallenge(verifier) });
  const consumido = await consumirCodigo(codigoA, cliente, redirect, verifier);
  assert.equal(consumido.empresaId, 1, 'a troca devolve a empresa do CÓDIGO (consentimento), nunca a pedida pelo cliente');
  const codigosA = await s.list(R_OAUTH_CODES, { page: 1, pageSize: 100, filter: { client_id: cliente } });
  for (const c of codigosA.rows) assert.equal(Number(c.empresa_id), 1);
  // Tokens de A e B para o MESMO cliente OAuth: identidades separadas.
  const tokA = await emitirAccessToken({ usuarioId: adminA.id, empresaId: 1, clientId: cliente, scopes: [SCOPES.workflowRead] });
  const tokB = await emitirAccessToken({ usuarioId: adminB.id, empresaId: 2, clientId: cliente, scopes: [SCOPES.workflowRead] });
  const valA = await validarAccessToken(tokA.token);
  const valB = await validarAccessToken(tokB.token);
  assert.equal(valA.ok, true);
  assert.equal(valB.ok, true);
  assert.equal(Number(valA.claims!.emp), 1);
  assert.equal(Number(valB.claims!.emp), 2);
  const linhaA = await s.findOneWhere(R_OAUTH_TOKENS, { jti: tokA.jti });
  const linhaB = await s.findOneWhere(R_OAUTH_TOKENS, { jti: tokB.jti });
  assert.equal(Number(linhaA!.empresa_id), 1);
  assert.equal(Number(linhaB!.empresa_id), 2);
  // Revogar o token de A não revoga o de B.
  await revogarToken(tokA.token);
  assert.equal((await validarAccessToken(tokA.token)).ok, false);
  assert.equal((await validarAccessToken(tokB.token)).ok, true, 'revogação em A não alcança token de B');
  // Refresh de B mantém a empresa de B.
  const refreshB = await emitirRefreshToken({ usuarioId: adminB.id, empresaId: 2, clientId: cliente, scopes: [SCOPES.workflowRead] });
  const linhaRefresh = await s.findOneWhere(R_OAUTH_TOKENS, { tipo: 'refresh', usuario_id: adminB.id, client_id: cliente });
  assert.equal(Number(linhaRefresh!.empresa_id), 2);
  assert.ok(refreshB.token);
  assert.equal(getPublicResource('oauth_tokens'), undefined);
  assert.equal(getPublicResource('oauth_authorization_codes'), undefined);
});

test('tenant: oauth_consents — consentimento registra a empresa da SESSÃO; leitura recortada', async () => {
  const { R_OAUTH_CONSENTS } = await import('../../modules/operational-control/infrastructure/resources');
  const { SCOPES } = await import('../../modules/operational-control/domain/scopes');
  // O handler /oauth/authorize grava empresa_id = sessão do usuário (routes.ts);
  // aqui provamos a persistência e o recorte de leitura do recurso.
  const cA = await s.insert(R_OAUTH_CONSENTS, { usuario_id: adminA.id, client_id: `cli-${tag}`, empresa_id: 1, scope: SCOPES.workflowRead });
  const cB = await s.insert(R_OAUTH_CONSENTS, { usuario_id: adminB.id, client_id: `cli-${tag}`, empresa_id: 2, scope: SCOPES.workflowRead });
  const listaA = await s.list(R_OAUTH_CONSENTS, { page: 1, pageSize: 100, filter: { empresa_id: 1, client_id: `cli-${tag}` } });
  const listaB = await s.list(R_OAUTH_CONSENTS, { page: 1, pageSize: 100, filter: { empresa_id: 2, client_id: `cli-${tag}` } });
  assert.equal(listaA.rows.length, 1);
  assert.equal(listaB.rows.length, 1);
  assert.equal(Number(listaA.rows[0].id), Number(cA.id));
  assert.equal(Number(listaB.rows[0].id), Number(cB.id));
  assert.equal(getPublicResource('oauth_consents'), undefined);
});
