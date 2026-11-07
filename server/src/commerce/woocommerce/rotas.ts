// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › ROTAS HTTP.
//
// Painel e ações por loja. Toda rota:
//   • exige identidade e recorta pela EMPRESA do ator (nunca a empresa do
//     corpo da requisição);
//   • exige o RECURSO (checkAccess) e perfil de gestão — sincronizar mexe em
//     cadastro de terceiros (clientes) e no que está publicado no site;
//   • devolve diagnóstico sem credencial: nenhuma resposta carrega CK/CS, URL
//     com usuário/senha ou corpo remoto da loja.
//
// A loja vem SEMPRE do path (`:store` = RETAIL | WHOLESALE), validada contra o
// registry — não há "loja padrão" implícita.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from '../../errors';
import { currentUser } from '../../auth';
import { checkAccess } from '../../services';
import { escopoDoAtor } from '../../empresa';
import { getResource } from '../../resources';
import { STORE_KEYS, ehStoreKey, exigirStoreDaEmpresa, multiStoreHabilitado, statusStoresDaEmpresa, dryRun, type StoreKey } from './registry';
import { painelTodasLojas, painelDaLoja, reconciliarLoja } from './painel';
import { sincronizarEstoqueDaLoja } from './estoque';
import { importarPedidosDaLoja } from './pedidos';
import { publicarProdutoNaLoja } from './publicacao';
import { enfileirarEstoqueDaLoja, enfileirarPedidosDaLoja, enfileirarPublicacaoDaLoja } from './outboxStore';
import { listarEntregas, contarEntregas, recuperarEntregasPendentes, reenfileirarEntrega } from './webhookInbox';
import { listarDivergencias, contarDivergencias, reconciliarLojaCompleta, corrigirDivergencia } from './reconciliacao';
import { webhookHabilitado } from './webhookSeguranca';

function exigirGestao(req: Request): ReturnType<typeof currentUser> {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas gerentes e administradores operam as lojas WooCommerce.');
  }
  return actor;
}

function lojaDoPath(req: Request): StoreKey {
  const bruto = String(req.params.store ?? '').trim().toUpperCase();
  if (!ehStoreKey(bruto)) {
    throw new HttpError(400, `Loja inválida. Use ${STORE_KEYS.join(' ou ')}.`);
  }
  return bruto;
}

/** GET /api/commerce/woocommerce/lojas — painel por loja (?testar=1 testa a conexão). */
export async function painelLojas(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const testar = req.query.testar === '1';
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    multi_store_habilitado: multiStoreHabilitado(),
    dry_run: dryRun(),
    lojas: await painelTodasLojas(empresaId, { testar }),
  });
}

/** GET /api/commerce/woocommerce/lojas/:store — painel de uma loja. */
export async function painelLoja(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  exigirStoreDaEmpresa(store, empresaId);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await painelDaLoja(empresaId, store, { testar: req.query.testar === '1' }));
}

/**
 * POST /api/commerce/woocommerce/lojas/:store/estoque — empurra o estoque do
 * ERP para a loja. `enfileirar=1` só enfileira no outbox (retry com backoff).
 */
export async function sincronizarEstoqueDaLojaRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  const cfg = exigirStoreDaEmpresa(store, empresaId);
  if (req.query.enfileirar === '1' || req.body?.enfileirar === true) {
    const evento = await enfileirarEstoqueDaLoja(empresaId, store);
    res.json({ ok: true, enfileirado: true, evento_id: Number(evento.id), store_key: store });
    return;
  }
  const resultado = await sincronizarEstoqueDaLoja(cfg, empresaId);
  res.json({ ...resultado, ok: resultado.ok, store_key: store });
}

/** POST /api/commerce/woocommerce/lojas/:store/pedidos — importa pedidos da loja. */
export async function importarPedidosDaLojaRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  const cfg = exigirStoreDaEmpresa(store, empresaId);
  if (req.query.enfileirar === '1' || req.body?.enfileirar === true) {
    const evento = await enfileirarPedidosDaLoja(empresaId, store);
    res.json({ ok: true, enfileirado: true, evento_id: Number(evento.id), store_key: store });
    return;
  }
  const resultado = await importarPedidosDaLoja(cfg, empresaId, {
    dias: Number(req.body?.dias) || undefined,
    limite: Number(req.body?.limite) || undefined,
    incremental: req.body?.incremental === true,
    actor: { id: actor.id ?? null, name: actor.name },
  });
  res.json(resultado);
}

/**
 * POST /api/commerce/woocommerce/lojas/:store/produtos/:id/publicar — publica UM
 * produto na loja. `enfileirar=1` enfileira (o worker publica com retry).
 */
export async function publicarProdutoNaLojaRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  const cfg = exigirStoreDaEmpresa(store, empresaId);
  const produtoId = Number(req.params.id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(400, 'Produto inválido.');
  if (req.query.enfileirar === '1' || req.body?.enfileirar === true) {
    const evento = await enfileirarPublicacaoDaLoja(empresaId, store, produtoId);
    res.json({ ok: true, enfileirado: true, evento_id: Number(evento.id), store_key: store, produto_id: produtoId });
    return;
  }
  res.json({ ok: true, store_key: store, produto_id: produtoId, ...(await publicarProdutoNaLoja(cfg, empresaId, produtoId)) });
}

/** GET /api/commerce/woocommerce/lojas/:store/reconciliacao — ERP × vínculos. */
export async function reconciliarLojaRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  exigirStoreDaEmpresa(store, empresaId);
  const divergencias = await reconciliarLoja(empresaId, store);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ store_key: store, total: divergencias.length, divergencias });
}

/**
 * GET /api/commerce/woocommerce/status — diagnóstico de configuração (sem
 * credencial). Serve para responder "o que falta para a loja funcionar?".
 */
export async function statusLojas(_req: Request, res: Response) {
  const actor = exigirGestao(_req);
  const { empresaId } = escopoDoAtor(actor);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    multi_store_habilitado: multiStoreHabilitado(),
    dry_run: dryRun(),
    empresa_id: empresaId,
    // A06-09: apenas as lojas da empresa autenticada.
    lojas: statusStoresDaEmpresa(empresaId).map((s) => ({ ...s, webhook_habilitado: webhookHabilitado(s.store_key) })),
  });
}

// ----------------------------------------------------------------------------
// WEBHOOKS — painel, recuperação e reprocessamento.
// ----------------------------------------------------------------------------

/** GET /api/commerce/woocommerce/lojas/:store/webhooks — estado e métricas. */
export async function painelWebhooks(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  exigirStoreDaEmpresa(store, empresaId);
  const entregas = await listarEntregas(empresaId, store, { pageSize: 500 });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    store_key: store,
    webhook_habilitado: webhookHabilitado(store),
    total: entregas.length,
    por_status: contarEntregas(entregas),
    entregas: entregas.slice(0, 100).map((e) => ({
      id: Number(e.id),
      topic: String(e.topic || ''),
      recurso: String(e.recurso || ''),
      external_resource_id: e.external_resource_id != null ? String(e.external_resource_id) : null,
      status: String(e.status || ''),
      attempts: Number(e.attempts || 0),
      assinatura_ok: e.assinatura_ok === true,
      received_at: e.received_at ? String(e.received_at) : null,
      processed_at: e.processed_at ? String(e.processed_at) : null,
      last_error: e.last_error ? String(e.last_error) : null,
    })),
  });
}

/** POST /api/commerce/woocommerce/lojas/:store/webhooks/reprocessar — re-enfileira presos. */
export async function reprocessarWebhooksRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  exigirStoreDaEmpresa(store, empresaId);
  const resultado = await recuperarEntregasPendentes(empresaId, store);
  res.json({ ok: true, store_key: store, ...resultado });
}

/** POST /api/commerce/woocommerce/lojas/:store/webhooks/:id/reprocessar — uma entrega. */
export async function reprocessarEntregaRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  exigirStoreDaEmpresa(store, empresaId);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Entrega inválida.');
  // Re-enfileira pela MESMA chave idempotente (reusa a linha do outbox).
  const ok = await reenfileirarEntrega(empresaId, store, id);
  if (!ok) throw new HttpError(404, 'Entrega não encontrada nesta loja.');
  res.json({ ok: true, store_key: store, entrega_id: id, enfileirada: true });
}

// ----------------------------------------------------------------------------
// RECONCILIAÇÃO — execução e painel de divergências.
// ----------------------------------------------------------------------------

/** POST /api/commerce/woocommerce/lojas/:store/reconciliar — executa. */
export async function executarReconciliacaoRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  const cfg = exigirStoreDaEmpresa(store, empresaId);
  const resultado = await reconciliarLojaCompleta(cfg, empresaId);
  res.json(resultado);
}

/** GET /api/commerce/woocommerce/lojas/:store/divergencias — painel. */
export async function listarDivergenciasRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  exigirStoreDaEmpresa(store, empresaId);
  const categoria = String(req.query.categoria ?? '').trim().toUpperCase();
  const status = String(req.query.status ?? '').trim().toUpperCase();
  const divergencias = await listarDivergencias(empresaId, store, {
    ...(status ? { status } : {}),
    ...(categoria ? { categoria: categoria as 'CATALOGO' | 'PRECO' | 'ESTOQUE' | 'PEDIDOS' } : {}),
    pageSize: 1000,
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    store_key: store,
    total: divergencias.length,
    por_categoria: await contarDivergencias(empresaId, store),
    divergencias: divergencias.map((d) => ({
      id: Number(d.id),
      categoria: String(d.categoria || ''),
      tipo: String(d.tipo || ''),
      classificacao: String(d.classificacao || ''),
      produto_id: d.produto_id != null ? Number(d.produto_id) : null,
      sku: d.sku ? String(d.sku) : null,
      pedido_ref: d.pedido_ref ? String(d.pedido_ref) : null,
      detalhe: String(d.detalhe || ''),
      status: String(d.status || ''),
      detectada_em: d.detectada_em ? String(d.detectada_em) : null,
    })),
  });
}

/** POST /api/commerce/woocommerce/lojas/:store/divergencias/:id/corrigir — correção controlada. */
export async function corrigirDivergenciaRota(req: Request, res: Response) {
  const actor = exigirGestao(req);
  const { empresaId } = escopoDoAtor(actor);
  const store = lojaDoPath(req);
  exigirStoreDaEmpresa(store, empresaId);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Divergência inválida.');
  const resultado = await corrigirDivergencia(empresaId, store, id, { id: actor.id ?? null, name: actor.name });
  res.json({ store_key: store, ...resultado });
}
