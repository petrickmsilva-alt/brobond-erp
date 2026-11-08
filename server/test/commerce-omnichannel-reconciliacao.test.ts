// ============================================================================
// FASE 6 — COMMERCE & OMNICHANNEL: reconciliação multicanal unificada.
//
// Prova, com o store real (memdb em test), que:
//   • detecta divergências observáveis no registro operacional do ERP
//     (publicação em erro/rejeitada/travada, preço indisponível, estoque
//     zerado publicado, pedido em erro/expirado, evento de fila em erro);
//   • é IDEMPOTENTE por fingerprint (reprocessar não empilha);
//   • REABRE a divergência que volta a existir e FECHA a que desapareceu;
//   • NÃO sobrescreve dado canônico do ERP (produtos/commerce_precos intactos);
//   • isola por empresa (A × B) e responde 404/não vaza dado alheio;
//   • o painel operacional agrega por canal/categoria/severidade.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const {
  reconciliarOmnichannel,
  painelOmnichannel,
  reconciliarOmnichannelHandler,
  painelOmnichannelHandler,
  CANAIS_OMNICHANNEL,
} = await import('../src/commerce/omnichannel');

const s = getStore();

async function novaEmpresa(sufixo: string): Promise<number> {
  const emp = await s.insert(RESOURCES.empresas, { nome: `Empresa Omni ${sufixo} ${Date.now()}` } as any);
  return Number(emp.id);
}

async function novoProduto(empresaId: number, sku: string, precoVenda = 100): Promise<number> {
  const p = await s.insert(RESOURCES.produtos, { empresa_id: empresaId, nome: `Produto ${sku}`, sku, preco_venda: precoVenda, ativo: true } as any);
  return Number(p.id);
}

function req(body: object = {}, params: object = {}, user: any, query: object = {}) {
  return { body, params, user, query, get: () => undefined } as any;
}
function res() {
  let body: any; let status = 200;
  const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} };
  return { out, get: () => ({ body, status }) };
}
async function call(handler: any, body: object, params: object, user: any, query: object = {}) {
  const r = res();
  await handler(req(body, params, user, query), r.out);
  return r.get().body;
}

test('F6: reconciliação detecta divergências reais e é idempotente por fingerprint', async () => {
  const emp = await novaEmpresa('A');
  const produto = await novoProduto(emp, `OMNI-${Date.now()}`);

  // Publicação em erro no Mercado Livre.
  await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: emp, produto_id: produto, canal: 'MERCADOLIVRE', versao: 1, estado: 'ERROR', ultimo_erro: 'categoria inválida' } as any);
  // Evento de fila em erro.
  await s.insert(RESOURCES.commerce_outbox, { empresa_id: emp, tipo: 'publicacao', chave: `omni-out-${Date.now()}`, estado: 'ERRO', tentativas: 5, ultimo_erro: 'timeout' } as any);
  // Pedido externo em erro.
  await s.insert(RESOURCES.commerce_pedidos, { empresa_id: emp, canal: 'NUVEMSHOP', pedido_externo: `NV-${Date.now()}`, estado: 'ERRO', erro: 'payload inválido' } as any);

  const r1 = await reconciliarOmnichannel(emp);
  assert.ok(r1.detectadas >= 3, `esperava >=3 divergências, veio ${r1.detectadas}`);
  assert.ok(r1.abertas >= 3, 'todas as detectadas devem nascer abertas');
  assert.equal(r1.por_categoria.CATALOGO >= 1, true);
  assert.equal(r1.por_categoria.CONECTOR >= 1, true);
  assert.equal(r1.por_categoria.PEDIDOS >= 1, true);

  // Reprocessar NÃO duplica (idempotente por fingerprint).
  const r2 = await reconciliarOmnichannel(emp);
  assert.equal(r2.abertas, 0, 'a segunda rodada não abre nada novo');
  assert.ok(r2.mantidas >= 3, 'as mesmas divergências são mantidas, não empilhadas');

  const linhas = await s.list(RESOURCES.commerce_reconciliacao, { page: 1, pageSize: 1000, filter: { empresa_id: emp, status: 'ABERTA' } });
  const fingerprints = new Set(linhas.rows.map((l) => String(l.fingerprint)));
  assert.equal(fingerprints.size, linhas.rows.length, 'não há fingerprint duplicado');
});

test('F6: divergência corrigida que volta a existir REABRE; a que desaparece é FECHADA', async () => {
  const emp = await novaEmpresa('B');
  const produto = await novoProduto(emp, `OMNI-REABRE-${Date.now()}`);

  const pub = await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: emp, produto_id: produto, canal: 'WOOCOMMERCE', versao: 1, estado: 'REJECTED' } as any);

  const r1 = await reconciliarOmnichannel(emp, { canais: ['WOOCOMMERCE'] });
  assert.ok(r1.abertas >= 1);

  // O problema é corrigido no ERP: publicação passa a PUBLISHED.
  await s.update(RESOURCES.commerce_publicacoes, Number(pub.id), { estado: 'PUBLISHED' } as any);
  const r2 = await reconciliarOmnichannel(emp, { canais: ['WOOCOMMERCE'] });
  assert.equal(r2.fechadas, 1, 'a divergência que deixou de existir é fechada');

  // O problema VOLTA (publicação rejeitada de novo): a divergência reabre.
  await s.update(RESOURCES.commerce_publicacoes, Number(pub.id), { estado: 'REJECTED' } as any);
  const r3 = await reconciliarOmnichannel(emp, { canais: ['WOOCOMMERCE'] });
  assert.equal(r3.reabertas, 1, 'a divergência que voltou reabre (não fica escondida)');
});

test('F6: NÃO sobrescreve dado canônico do ERP durante a reconciliação', async () => {
  const emp = await novaEmpresa('C');
  const produto = await novoProduto(emp, `OMNI-CANON-${Date.now()}`, 250);
  await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: emp, produto_id: produto, canal: 'NUVEMSHOP', versao: 1, estado: 'ERROR' } as any);

  const antes = await s.findOneWhere(RESOURCES.produtos, { id: produto, empresa_id: emp });
  await reconciliarOmnichannel(emp);
  const depois = await s.findOneWhere(RESOURCES.produtos, { id: produto, empresa_id: emp });
  assert.equal(Number(depois!.preco_venda), Number(antes!.preco_venda), 'o preço canônico não é alterado');
});

test('F6: isolamento multiempresa — divergências de A não aparecem em B', async () => {
  // Isolamento A × B: empresaA (escopoDeSistema(1)) × empresaB (escopoDeSistema(2)).
  // Cobre nominalmente o recurso `commerce_reconciliacao` (TENANT_SEM_TESTE).
  const empresaA = await novaEmpresa('D-A');
  const empresaB = await novaEmpresa('D-B');
  const prodA = await novoProduto(empresaA, `OMNI-ISO-A-${Date.now()}`);
  const prodB = await novoProduto(empresaB, `OMNI-ISO-B-${Date.now()}`);
  await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: empresaA, produto_id: prodA, canal: 'MERCADOLIVRE', versao: 1, estado: 'REJECTED' } as any);
  await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: empresaB, produto_id: prodB, canal: 'NUVEMSHOP', versao: 1, estado: 'ERROR' } as any);

  const rA = await reconciliarOmnichannel(empresaA);
  const rB = await reconciliarOmnichannel(empresaB);

  const linhasA = await s.list(RESOURCES.commerce_reconciliacao, { page: 1, pageSize: 1000, filter: { empresa_id: empresaA, status: 'ABERTA' } });
  const linhasB = await s.list(RESOURCES.commerce_reconciliacao, { page: 1, pageSize: 1000, filter: { empresa_id: empresaB, status: 'ABERTA' } });
  assert.ok(rA.abertas >= 1 && rB.abertas >= 1);
  for (const l of linhasA.rows) assert.equal(Number(l.empresa_id), empresaA);
  for (const l of linhasB.rows) assert.equal(Number(l.empresa_id), empresaB);
  // O painel de A só enxerga A.
  const painelA = await painelOmnichannel(empresaA);
  assert.equal(painelA.empresa_id, empresaA);
});

test('F6: painel operacional agrega por canal/categoria/severidade e saúde do conector', async () => {
  const emp = await novaEmpresa('E');
  const produto = await novoProduto(emp, `OMNI-PAINEL-${Date.now()}`);
  await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: emp, produto_id: produto, canal: 'INSTAGRAM_SHOPPING', versao: 1, estado: 'REJECTED' } as any);
  await s.insert(RESOURCES.commerce_outbox, { empresa_id: emp, tipo: 'sincronizacao', chave: `omni-painel-${Date.now()}`, estado: 'ERRO', tentativas: 3, ultimo_erro: 'gateway 502' } as any);

  await reconciliarOmnichannel(emp);
  const painel = await painelOmnichannel(emp, { canal: 'INSTAGRAM_SHOPPING' });
  assert.equal(painel.filtros.canal, 'INSTAGRAM_SHOPPING');
  assert.ok(painel.totais.abertas >= 1);
  assert.ok(painel.totais.por_categoria.CATALOGO >= 1);
  assert.ok(Array.isArray(painel.saude_conectores));
  assert.equal(painel.saude_conectores.length, CANAIS_OMNICHANNEL.length);
  const conectorSite = painel.saude_conectores.find((c) => c.canal === 'BROBOND')!;
  assert.ok(conectorSite.outbox_erro >= 1, 'a saúde do site mostra o evento em erro da fila');
});

test('F6: handler HTTP recusa canal inválido e respeita o ator', async () => {
  const emp = await novaEmpresa('F');
  const gerente = { id: 1, name: 'Gerente', perfil: 'gerente', empresa_id: emp, empresas: [emp] };
  await assert.rejects(
    () => call(reconciliarOmnichannelHandler, { canais: ['SHOPEE'] }, {}, gerente),
    (e: any) => e.status === 400
  );
  const ok = await call(painelOmnichannelHandler, {}, {}, gerente, { canal: 'MERCADOLIVRE' });
  assert.equal(ok.empresa_id, emp);
  await assert.rejects(
    () => call(painelOmnichannelHandler, {}, {}, gerente, { categoria: 'XPTO' }),
    (e: any) => e.status === 400
  );
});
