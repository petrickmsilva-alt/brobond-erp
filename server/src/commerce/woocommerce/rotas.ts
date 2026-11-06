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
import { STORE_KEYS, ehStoreKey, exigirStoreDaEmpresa, multiStoreHabilitado, statusStores, dryRun, type StoreKey } from './registry';
import { painelTodasLojas, painelDaLoja, reconciliarLoja } from './painel';
import { sincronizarEstoqueDaLoja } from './estoque';
import { importarPedidosDaLoja } from './pedidos';
import { publicarProdutoNaLoja } from './publicacao';
import { enfileirarEstoqueDaLoja, enfileirarPedidosDaLoja, enfileirarPublicacaoDaLoja } from './outboxStore';

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
    lojas: statusStores(),
  });
}
