// ============================================================================
// ERP-UX-02.1 — fechamento dos bloqueadores de navegação/acesso.
//
// Estes testes são deliberadamente negativos onde a segurança está em jogo:
// uma resposta 2xx para o tenant/perfil errado é falha, não "comportamento
// alternativo". O harness em memória prova o contrato dos handlers; a prova
// de persistência/HTTP real fica no arquivo PG irmão.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, getStore, listRecords } = await import('../src/services');
const { ADMIN, chamar, criarAtor, esperarErro, garantirAdmin, novoProduto, reqDe, resFake, saldoInicial } = await import('./_p1util');
const catalogos = await import('../src/catalogos');
const portal = await import('../src/portal');
const pdf = await import('../src/pdf');
const qrcode = await import('../src/qrcode');
const nfe = await import('../src/nfe');
const quality = await import('../src/quality');
const pdv = await import('../src/pdv');

await garantirAdmin();
const store = getStore();
await store.insert(RESOURCES.empresas, { id: 2, nome: 'Empresa B UX-02.1', ativo: true }).catch(() => undefined);

function capturePdf() {
  const res: any = {
    headers: new Map<string, string>(),
    chunks: [] as Buffer[],
    statusCode: 200,
    setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); return this; },
    write(chunk: any) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk?: any) { if (chunk) this.write(chunk); this.ended = true; return this; },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
  return res;
}

async function assertPdfGerado(handler: (req: any, res: any) => Promise<void>, req: any) {
  const res = capturePdf();
  await handler(req, res);
  // PDFKit é um stream: o handler resolve quando agenda `doc.end()`, não
  // necessariamente quando o último chunk foi entregue ao `write` falso.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.concat(res.chunks).length > 100, 'PDF positivo deve gerar bytes');
}

async function fixturesTenant() {
  const aGerente = await criarAtor(1, 'gerente');
  const bGerente = await criarAtor(2, 'gerente');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clienteA = await store.insert(RESOURCES.clientes, { empresa_id: 1, nome: `Cliente A ${stamp}`, tipo: 'pf', ativo: true });
  const clienteB = await store.insert(RESOURCES.clientes, { empresa_id: 2, nome: `Cliente B ${stamp}`, tipo: 'pf', ativo: true });
  const catalogoA = await store.insert(RESOURCES.catalogos, { empresa_id: 1, nome: `Catálogo A ${stamp}`, token: `a${stamp.replace(/\W/g, '')}`, ativo: true });
  const catalogoB = await store.insert(RESOURCES.catalogos, { empresa_id: 2, nome: `Catálogo B ${stamp}`, token: `b${stamp.replace(/\W/g, '')}`, ativo: true });
  const produtoA = await store.insert(RESOURCES.produtos, { empresa_id: 1, sku: `A-${stamp}`, nome: 'Produto A UX021', preco_venda: 10, ativo: true });
  const produtoB = await store.insert(RESOURCES.produtos, { empresa_id: 2, sku: `B-${stamp}`, nome: 'Produto B UX021', preco_venda: 20, ativo: true });
  const ordemA = await store.insert(RESOURCES.ordens, { empresa_id: 1, produto_id: Number(produtoA.id), tipo: 'grade', quantidade: 3, status: 'planejada' });
  const ordemB = await store.insert(RESOURCES.ordens, { empresa_id: 2, produto_id: Number(produtoB.id), tipo: 'grade', quantidade: 3, status: 'planejada' });
  const vendaA = await store.insert(RESOURCES.vendas, { empresa_id: 1, cliente_id: Number(clienteA.id), data: '2026-10-13', status: 'aberta', total: 10 });
  const vendaB = await store.insert(RESOURCES.vendas, { empresa_id: 2, cliente_id: Number(clienteB.id), data: '2026-10-13', status: 'aberta', total: 20 });
  const compraA = await store.insert(RESOURCES.compras, { empresa_id: 1, data: '2026-10-13', status: 'pendente', total: 10, previsao_entrega: '2026-10-20' });
  const compraB = await store.insert(RESOURCES.compras, { empresa_id: 2, data: '2026-10-13', status: 'pendente', total: 20, previsao_entrega: '2026-10-20' });
  const compA = await store.insert(RESOURCES.catalogo_compartilhamentos, { catalogo_id: Number(catalogoA.id), cliente_id: Number(clienteA.id), usuario_id: Number(aGerente.id), token_hash: `a-${stamp}`, canal: 'link', acessos: 0 });
  const compB = await store.insert(RESOURCES.catalogo_compartilhamentos, { catalogo_id: Number(catalogoB.id), cliente_id: Number(clienteB.id), usuario_id: Number(bGerente.id), token_hash: `b-${stamp}`, canal: 'link', acessos: 0 });
  return { aGerente, bGerente, clienteA, clienteB, catalogoA, catalogoB, produtoA, produtoB, ordemA, ordemB, vendaA, vendaB, compraA, compraB, compA, compB };
}

test('UX02.1/P0-01: portal administrativo não lista, gera nem revoga acesso de outra empresa', async () => {
  const f = await fixturesTenant();
  const positivo = await chamar(portal.administrarAcessosPortal, reqDe({}, { user: f.aGerente, params: { id: f.clienteA.id } }));
  assert.equal(positivo.cliente, f.clienteA.nome);

  await esperarErro(() => portal.administrarAcessosPortal(reqDe({}, { user: f.aGerente, params: { id: f.clienteB.id } }), resFake().res), 404);
  await esperarErro(() => portal.gerarAcessoPortal(reqDe({ validade_dias: 1 }, { user: f.aGerente, params: { id: f.clienteB.id } }), resFake().res), 404);
  await esperarErro(() => portal.administrarAcessosPortal(reqDe({}, { user: f.bGerente, params: { id: f.clienteA.id } }), resFake().res), 404);

  const gerado = await chamar(portal.gerarAcessoPortal, reqDe({ validade_dias: 1 }, { user: f.aGerente, params: { id: f.clienteA.id } }), 201);
  assert.ok(gerado.token);
  const lista = await chamar(portal.administrarAcessosPortal, reqDe({}, { user: f.aGerente, params: { id: f.clienteA.id } }));
  const acessoId = Number(lista.acessos[0].id);
  await esperarErro(() => portal.revogarAcessoPortal(reqDe({}, { user: f.bGerente, params: { id: f.clienteA.id, acessoId } }), resFake().res), 404);
  await chamar(portal.revogarAcessoPortal, reqDe({}, { user: f.aGerente, params: { id: f.clienteA.id, acessoId } }));
});

test('UX02.1/P0-01: catálogo administrativo compartilha, agrega e revoga só no tenant', async () => {
  const f = await fixturesTenant();
  const compartilhado = await chamar(catalogos.compartilharCatalogo, reqDe({ cliente_id: f.clienteA.id }, { user: f.aGerente, params: { id: f.catalogoA.id } }));
  assert.ok(compartilhado.compartilhamento_id);
  await esperarErro(() => catalogos.compartilharCatalogo(reqDe({ cliente_id: f.clienteB.id }, { user: f.aGerente, params: { id: f.catalogoA.id } }), resFake().res), 400);
  await esperarErro(() => catalogos.compartilharCatalogo(reqDe({}, { user: f.aGerente, params: { id: f.catalogoB.id } }), resFake().res), 404);
  await esperarErro(() => catalogos.compartilharCatalogo(reqDe({}, { user: f.bGerente, params: { id: f.catalogoA.id } }), resFake().res), 404);

  const inteligenciaA = await chamar(catalogos.inteligenciaCatalogos, reqDe({}, { user: f.aGerente }));
  assert.ok(inteligenciaA.recentes.every((x: any) => !String(x.catalogo).includes('Catálogo B')));
  assert.ok(inteligenciaA.recentes.some((x: any) => Number(x.id) === Number(f.compA.id)));
  assert.ok(!inteligenciaA.recentes.some((x: any) => Number(x.id) === Number(f.compB.id)));

  await esperarErro(() => catalogos.revogarCompartilhamento(reqDe({}, { user: f.aGerente, params: { id: f.compB.id } }), resFake().res), 404);
  await chamar(catalogos.revogarCompartilhamento, reqDe({}, { user: f.aGerente, params: { id: f.compA.id } }));
  assert.ok((await store.get(RESOURCES.catalogo_compartilhamentos, Number(f.compA.id)))?.revogado_em);
  assert.equal((await store.get(RESOURCES.catalogo_compartilhamentos, Number(f.compB.id)))?.revogado_em ?? null, null);
});

test('UX02.1/P0-01: PDF, QR e NF-e anterior respeitam a empresa do registro e dos relacionados', async () => {
  const f = await fixturesTenant();
  await assertPdfGerado(pdf.vendaPDF, reqDe({}, { user: f.aGerente, params: { id: f.vendaA.id } }));
  await esperarErro(() => pdf.vendaPDF(reqDe({}, { user: f.aGerente, params: { id: f.vendaB.id } }), resFake().res), 404);
  await assertPdfGerado(pdf.compraPDF, reqDe({}, { user: f.bGerente, params: { id: f.compraB.id } }));
  await esperarErro(() => pdf.compraPDF(reqDe({}, { user: f.bGerente, params: { id: f.compraA.id } }), resFake().res), 404);

  const qrA = await chamar(qrcode.produtoQRDados, reqDe({}, { user: f.aGerente, params: { id: f.produtoA.id } }));
  assert.equal(qrA.sku, f.produtoA.sku);
  await esperarErro(() => qrcode.produtoQRDados(reqDe({}, { user: f.aGerente, params: { id: f.produtoB.id } }), resFake().res), 404);
  await esperarErro(() => qrcode.produtoQRDados(reqDe({}, { user: f.bGerente, params: { id: f.produtoA.id } }), resFake().res), 404);
  // QR `/dados` continua atrás de sessão (montagem em index.ts) e agora
  // também aplica produtos:read no handler; a negação HTTP de sessão é
  // provada no harness PG, onde `requireAuth` roda de verdade.

  const statusA = await chamar(nfe.nfeStatus, reqDe({}, { user: f.aGerente, params: { id: f.vendaA.id } }));
  assert.equal(Number(statusA.venda_id), Number(f.vendaA.id));
  await esperarErro(() => nfe.nfeStatus(reqDe({}, { user: f.aGerente, params: { id: f.vendaB.id } }), resFake().res), 404);
  await esperarErro(() => nfe.nfeDados(reqDe({}, { user: f.bGerente, params: { id: f.vendaA.id } }), resFake().res), 404);
});

test('UX02.1/P0-01: qualidade lê/escreve e agrega somente eventos da empresa', async () => {
  const f = await fixturesTenant();
  await chamar(quality.createQualidade, reqDe({ etapa: 'corte', defeito: 'furo', quantidade: 1 }, { user: f.aGerente, params: { id: f.ordemA.id } }), 201);
  await chamar(quality.createQualidade, reqDe({ etapa: 'corte', defeito: 'mancha', quantidade: 2 }, { user: f.bGerente, params: { id: f.ordemB.id } }), 201);

  const listaA = await chamar(quality.listQualidade, reqDe({}, { user: f.aGerente, params: { id: f.ordemA.id } }));
  assert.equal(listaA.length, 1);
  // O store remove `dados` das leituras genéricas de auditoria por projeto;
  // a pertença do evento é provada pela OP/tenant e pelo relatório abaixo.
  assert.equal(Number(listaA[0].id) > 0, true);
  await esperarErro(() => quality.listQualidade(reqDe({}, { user: f.aGerente, params: { id: f.ordemB.id } }), resFake().res), 404);
  await esperarErro(() => quality.createQualidade(reqDe({ etapa: 'corte', defeito: 'furo', quantidade: 1 }, { user: f.bGerente, params: { id: f.ordemA.id } }), resFake().res), 404);

  const relA = await chamar(quality.relatorioQualidade, reqDe({}, { user: f.aGerente }));
  assert.ok(relA.itens.every((x: any) => Number(x.ordem_id) === Number(f.ordemA.id)));
  assert.ok(!relA.itens.some((x: any) => Number(x.ordem_id) === Number(f.ordemB.id)));
});

test('UX02.1/P0-02: recursos de listas/envios têm a mesma alçada de gerente no servidor', async () => {
  const operador = await criarAtor(1, 'operador');
  const gerente = await criarAtor(1, 'gerente');
  for (const key of ['listas_preco', 'envios']) {
    const r = RESOURCES[key];
    assert.equal(r.minPerfil, 'gerente', `${key} deve declarar gerente`);
    assert.throws(() => checkAccess(r, operador as any, 'read'), (e: any) => e.status === 403);
    assert.doesNotThrow(() => checkAccess(r, gerente as any, 'read'));
    assert.doesNotThrow(() => checkAccess(r, ADMIN as any, 'read'));
  }
  // O aviso de políticas é uma exceção comercial real (herdar/permitir/negar),
  // não um minPerfil simples: operador sem permissão continua negado e com
  // `permitir` continua autorizado pela capacidade.
  const politicas = RESOURCES.politicas_comerciais;
  assert.throws(() => checkAccess(politicas, operador as any, 'read'), (e: any) => e.status === 403);
  assert.doesNotThrow(() => checkAccess(politicas, { ...operador, perm_politicas: 'permitir' } as any, 'read'));
  assert.throws(() => checkAccess(politicas, { ...gerente, perm_politicas: 'negar' } as any, 'read'), (e: any) => e.status === 403);
});

test('UX02.1/P0-02+P0-03: PDV separa descoberta operacional de gestão da gaveta', async () => {
  const gerente = await criarAtor(1, 'gerente');
  const operador = await criarAtor(1, 'operador');
  const abertos = await store.list(RESOURCES.pdv_caixas, { page: 1, pageSize: 100, filter: { status: 'aberto', empresa_id: 1 } });
  for (const c of abertos.rows) await store.update(RESOURCES.pdv_caixas, Number(c.id), { status: 'fechado', fechamento_em: new Date().toISOString() });

  // Sem caixa: a descoberta responde o estado, não 403; vender continua 409.
  const semCaixa = await chamar(pdv.caixaAberto, reqDe({}, { user: operador }));
  assert.equal(semCaixa.caixa, null);
  const p = await novoProduto({ preco_venda: 7 });
  await saldoInicial(p, 20);
  await esperarErro(() => pdv.venderPdv(reqDe({ itens: [{ produto_id: p.id, tamanho_id: null, quantidade: 1, desconto_pct: 0 }], pagamentos: [{ forma: 'dinheiro', valor: 7 }] }, { user: operador }), resFake().res), 409);

  // Gerente abre; operador descobre e vende, mas não gere a gaveta.
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: `UX021-${Date.now()}`, valor_abertura: 10 }, { user: gerente }), 201);
  const descoberto = await chamar(pdv.caixaAberto, reqDe({}, { user: operador }));
  assert.equal(Number(descoberto.caixa.id), Number(caixa.id));
  const venda = await chamar(pdv.venderPdv, reqDe({ caixa_id: caixa.id, itens: [{ produto_id: p.id, tamanho_id: null, quantidade: 1, desconto_pct: 0 }], pagamentos: [{ forma: 'dinheiro', valor: 7 }] }, { user: operador }), 201);
  assert.equal(Number(venda.calculo.total), 7);

  await esperarErro(() => pdv.abrirCaixa(reqDe({ numero: 'UX021-OPERADOR', valor_abertura: 1 }, { user: operador }), resFake().res), 403);
  await esperarErro(() => pdv.movimentoCaixa(reqDe({ tipo: 'sangria', valor: 1 }, { user: operador, params: { id: caixa.id } }), resFake().res), 403);
  await esperarErro(() => pdv.resumoCaixaHandler(reqDe({}, { user: operador, params: { id: caixa.id } }), resFake().res), 403);
  await esperarErro(() => pdv.fecharCaixa(reqDe({ valor_fechamento: 17 }, { user: operador, params: { id: caixa.id } }), resFake().res), 403);

  // O fechamento pelo gerente continua funcionando e a descoberta some.
  await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 17 }, { user: gerente, params: { id: caixa.id } }));
  assert.equal((await chamar(pdv.caixaAberto, reqDe({}, { user: operador }))).caixa, null);
});

test('UX02.1: listagem genérica continua tenantada após os guards especializados', async () => {
  const f = await fixturesTenant();
  const lista = await listRecords(RESOURCES.clientes, { page: 1, pageSize: 100 }, f.aGerente as any);
  assert.ok(lista.rows.some((x: any) => Number(x.id) === Number(f.clienteA.id)));
  assert.ok(!lista.rows.some((x: any) => Number(x.id) === Number(f.clienteB.id)));
});
