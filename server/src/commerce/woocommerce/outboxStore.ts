// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › OUTBOX POR LOJA.
//
// O outbox existente (commerce_outbox) é a fila at-least-once com claim CAS e
// retry com backoff. O modo multi-loja NÃO cria uma segunda fila: ele passa a
// levar `store_key` no payload e na coluna (migration 0100, aditiva).
//
// A CHAVE de idempotência inclui a loja — `woo-estoque:RETAIL` e
// `woo-estoque:WHOLESALE` são eventos DISTINTOS. Sem isso, o índice único
// (empresa, tipo, chave) faria a segunda loja ser engolida pela primeira.
//
// Nenhuma chamada externa acontece dentro da transação: o enfileiramento só
// grava a linha; quem fala com a loja é o worker.
// ============================================================================
import { getStore } from '../../services';
import { enfileirarOutbox, type TipoOutbox } from '../outbox';
import { getResource } from '../../resources';
import { HttpError } from '../../errors';
import type { Row } from '../../store';
import { STORE_KEYS, ehStoreKey, type ConfigStore, type StoreKey } from './registry';
import { buscarPedidoDaLoja, carregarContextoImportacao, importarPedidosDaLoja, importarUmPedido } from './pedidos';
import { sincronizarEstoqueDaLoja } from './estoque';
import { publicarProdutoNaLoja } from './publicacao';
import { exigirConfigStore, dryRun } from './registry';
import { wooStoreFetch, ehDryRun } from './cliente';
import { listarVinculos } from './vinculos';
import { avancarAguaMarcaPedidos } from './estado';
import { entregaPorId, marcarProcessamento } from './webhookInbox';

const R_OUTBOX = () => getResource('commerce_outbox')!;

/** Chave idempotente POR LOJA (a loja é parte da identidade do evento). */
export function chaveStore(acao: string, store: StoreKey, sufixo: string): string {
  return `${acao}:${store}:${sufixo}`;
}

/**
 * Re-arma um evento RECORRENTE que já terminou.
 *
 * O cron roda a cada ciclo com a MESMA chave idempotente
 * (`woo-estoque:<loja>:lote`). `enfileirarOutbox` devolve a linha existente sem
 * tocar num evento já `PROCESSADO` — sem re-armar, a sincronização periódica
 * aconteceria UMA única vez e nunca mais. Só o estado TERMINAL é re-armado:
 * `PENDENTE`/`PROCESSANDO` já têm trabalho em voo e não podem ser duplicados
 * (o CAS por `claim_versao` garante que não atropelamos um worker).
 */
async function rearmarRecorrente(evento: Row): Promise<Row> {
  if (String(evento.estado) !== 'PROCESSADO') return evento;
  const rearmado = await getStore().tryUpdateIf(
    R_OUTBOX(),
    Number(evento.id),
    { estado: 'PROCESSADO', claim_versao: Number(evento.claim_versao || 0), empresa_id: Number(evento.empresa_id) },
    { estado: 'PENDENTE', tentativas: 0, ultimo_erro: null, proxima_tentativa_em: new Date().toISOString() }
  );
  return rearmado ?? evento;
}

/**
 * Enfileira a sincronização de estoque de UMA loja. O payload carrega
 * `store_key` — o worker resolve a config daquela loja, e não a global.
 */
export async function enfileirarEstoqueDaLoja(empresaId: number, store: StoreKey): Promise<Row> {
  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveStore('woo-estoque', store, 'lote'),
    { acao: 'woo-estoque', store_key: store }
  );
  await marcarStoreKey(evento, store);
  return rearmarRecorrente(evento);
}

/** Enfileira a importação de pedidos de UMA loja. */
export async function enfileirarPedidosDaLoja(empresaId: number, store: StoreKey): Promise<Row> {
  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveStore('woo-pedidos', store, 'lote'),
    { acao: 'woo-pedidos', store_key: store }
  );
  await marcarStoreKey(evento, store);
  return rearmarRecorrente(evento);
}

/**
 * Enfileira a publicação de um produto em UMA loja. A chave é por
 * (loja, produto) — publicar o mesmo produto nas duas lojas gera dois eventos.
 */
export async function enfileirarPublicacaoDaLoja(empresaId: number, store: StoreKey, produtoId: number): Promise<Row> {
  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveStore('woo-publicacao', store, String(produtoId)),
    { acao: 'woo-publicacao', store_key: store, produto_id: produtoId }
  );
  await marcarStoreKey(evento, store);
  return evento;
}

/**
 * Grava `store_key` na COLUNA (o payload é JSON; a coluna permite índice e
 * relatório). Nunca falha o enfileiramento: a coluna é um índice operacional.
 */
async function marcarStoreKey(evento: Row, store: StoreKey): Promise<void> {
  if (String(evento.store_key || '') === store) return;
  await getStore()
    .update(R_OUTBOX(), Number(evento.id), { store_key: store })
    .catch(() => undefined);
}

/**
 * Processa UM evento multi-loja. Devolve `true` quando o evento foi tratado
 * (sucesso ou erro terminal) e `false` quando a loja está desabilitada — nesse
 * caso o evento permanece para o dono da fila decidir.
 */
export async function processarEventoStore(payload: Record<string, unknown>, empresaId: number): Promise<'ok' | 'ignorado'> {
  const store = payload.store_key;
  if (!ehStoreKey(store)) return 'ignorado';
  const acao = String(payload.acao || '');
  const cfg = exigirConfigStore(store);
  if (cfg.empresaId !== empresaId) {
    throw new HttpError(409, 'A loja não pertence à empresa do evento — sincronização recusada.');
  }
  if (dryRun()) return 'ok';

  if (acao === 'woo-estoque') {
    const r = await sincronizarEstoqueDaLoja(cfg, empresaId);
    if (!r.ok) throw new HttpError(502, r.erro || 'Falha ao sincronizar estoque.');
    return 'ok';
  }
  if (acao === 'woo-pedidos') {
    const r = await importarPedidosDaLoja(cfg, empresaId, { incremental: true, actor: { id: null, name: 'Commerce outbox' } });
    if (!r.ok) throw new HttpError(502, r.erro || 'Falha ao importar pedidos.');
    return 'ok';
  }
  if (acao === 'woo-publicacao') {
    const produtoId = Number(payload.produto_id);
    if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(409, 'Publicação sem produto.');
    await publicarProdutoNaLoja(cfg, empresaId, produtoId);
    return 'ok';
  }
  return 'ignorado';
}

/**
 * Processa UM evento de WEBHOOK. O webhook é NOTIFICAÇÃO, não fonte de
 * verdade: para pedido, o ERP CONFIRMA na API oficial antes de importar
 * (nunca aplica o corpo cego). O desfecho é gravado no inbox da entrega.
 *
 * Idempotência em três camadas: o inbox (entrega única), o outbox (chave por
 * entrega) e a própria importação (referência por loja). Reprocessar nunca
 * duplica. Nenhuma chamada externa dentro de transação longa — a importação
 * tem a transação dela e é curta.
 */
export async function processarEventoWebhook(
  payload: Record<string, unknown>,
  empresaId: number
): Promise<'ok' | 'ignorado'> {
  const store = payload.store_key;
  if (!ehStoreKey(store)) return 'ignorado';
  const cfg = exigirConfigStore(store);
  if (cfg.empresaId !== empresaId) throw new HttpError(409, 'A loja não pertence à empresa do evento — webhook recusado.');

  const webhookEventId = Number(payload.webhook_event_id);
  if (!Number.isInteger(webhookEventId) || webhookEventId <= 0) return 'ignorado';

  const entrega = await entregaPorId(empresaId, webhookEventId);
  if (!entrega) return 'ignorado';
  // Entrega já processada (reentrega/duplicata): nada a fazer.
  if (String(entrega.status) === 'processado') return 'ok';

  if (dryRun()) {
    await marcarProcessamento(empresaId, webhookEventId, { status: 'processado', erro: null });
    return 'ok';
  }

  const topic = String(entrega.topic || '');
  const recurso = String(entrega.recurso || topic.split('.')[0] || '');
  try {
    if (recurso === 'order' || topic.startsWith('order.')) {
      await processarEventoPedido(cfg, empresaId, entrega);
    } else if (recurso === 'product' || topic.startsWith('product.')) {
      await processarEventoProduto(cfg, empresaId, entrega);
    }
    await marcarProcessamento(empresaId, webhookEventId, { status: 'processado', erro: null });
    return 'ok';
  } catch (e) {
    const mensagem = e instanceof HttpError ? e.message : 'Falha ao processar o evento da loja.';
    await marcarProcessamento(empresaId, webhookEventId, { status: 'erro', erro: mensagem }).catch(() => undefined);
    throw e instanceof HttpError ? e : new HttpError(502, mensagem);
  }
}

/**
 * Pedido: CONFIRMA na API oficial e importa pelo fluxo existente. Um pedido
 * excluído/ausente na loja é apenas registrado (o webhook de deleted não
 * cancela nada no ERP). Evento fora de ordem não sobrescreve: a importação é
 * idempotente e NUNCA altera pagamento, status ou valores de venda já criada.
 */
async function processarEventoPedido(cfg: ConfigStore, empresaId: number, entrega: Row): Promise<void> {
  const pedidoId = entrega.external_resource_id != null ? String(entrega.external_resource_id) : '';
  if (!pedidoId) return; // sem id de recurso não há o que confirmar
  const confirmado = await buscarPedidoDaLoja(cfg, pedidoId);
  if (!confirmado) {
    // A loja não tem mais o pedido (excluído) — reportado, nunca aplicado.
    await getStore()
      .audit({
        usuario_id: null,
        usuario: 'WooCommerce multi-store',
        acao: 'editar',
        recurso: 'woocommerce_webhook_events',
        registro_id: Number(entrega.id),
        descricao: `Evento de pedido ${cfg.store_key}/${pedidoId}: o pedido não existe mais na loja (nenhuma ação aplicada).`,
        dados: { store_key: cfg.store_key, pedido_externo: pedidoId },
        empresa_id: empresaId,
      })
      .catch(() => undefined);
    return;
  }
  const contexto = await carregarContextoImportacao(empresaId);
  const desfecho = await importarUmPedido(cfg, contexto, confirmado);
  const numero = String(confirmado.number ?? confirmado.id ?? pedidoId);
  if (desfecho.tipo === 'importado') {
    await avancarAguaMarcaPedidos(empresaId, cfg.store_key, String(confirmado.date_created || new Date().toISOString())).catch(() => undefined);
  }
  await getStore()
    .audit({
      usuario_id: null,
      usuario: 'WooCommerce multi-store (webhook)',
      acao: 'importar',
      recurso: 'marketplace',
      registro_id: null,
      descricao: `Webhook de pedido ${cfg.store_key}: ${numero} — ${desfecho.tipo}`,
      dados: { origem: 'woocommerce-webhook', store_key: cfg.store_key, pedido: numero, desfecho: desfecho.tipo },
      empresa_id: empresaId,
    })
    .catch(() => undefined);
}

/**
 * Produto: confirma na loja e registra a divergência (catálogo/preço/estoque).
 * NÃO republica automaticamente nem sobrescreve preço canônico — quem decide é
 * o operador pelo painel de divergências.
 */
async function processarEventoProduto(cfg: ConfigStore, empresaId: number, entrega: Row): Promise<void> {
  const externalId = entrega.external_resource_id != null ? String(entrega.external_resource_id) : '';
  if (!externalId) return;
  const resposta = await wooStoreFetch<Record<string, unknown>>(cfg, `/products/${encodeURIComponent(externalId)}`);
  if (ehDryRun(resposta) || !resposta || typeof resposta !== 'object' || Array.isArray(resposta)) return;
  const skuLoja = String((resposta as { sku?: unknown }).sku ?? '').trim();
  const vínculo = skuLoja
    ? (await listarVinculos(empresaId, cfg.store_key, { pageSize: 20000 })).find(
        (v) => String(v.sku || '').trim().toUpperCase() === skuLoja.toUpperCase() && String(v.external_product_id) === externalId
      )
    : undefined;
  const tipo = vínculo ? 'PRODUTO_ALTERADO_EXTERNAMENTE' : 'PRODUTO_EXTERNO_SEM_VINCULO';
  const classificacao = vínculo ? 'LEGITIMA' : 'HUMANA';
  const { registrarDivergencia } = await import('./reconciliacao');
  await registrarDivergencia(empresaId, cfg.store_key, {
    categoria: 'CATALOGO',
    tipo,
    classificacao,
    produto_id: vínculo ? Number(vínculo.produto_id) : null,
    sku: skuLoja || null,
    external_product_id: externalId,
    detalhe: vínculo
      ? `A loja ${cfg.store_key} notificou alteração do produto externo ${externalId}; a reconciliação confirma a divergência real.`
      : `A loja ${cfg.store_key} notificou o produto externo ${externalId}, que não tem vínculo no ERP.`,
  });
}

/** Todas as lojas habilitadas com a empresa resolvida (para o agendado). */
export function lojasDaEmpresa(): { cfg: ReturnType<typeof exigirConfigStore>; empresaId: number }[] {
  const out: { cfg: ReturnType<typeof exigirConfigStore>; empresaId: number }[] = [];
  for (const store of STORE_KEYS) {
    try {
      const cfg = exigirConfigStore(store);
      out.push({ cfg, empresaId: cfg.empresaId });
    } catch {
      /* loja desabilitada ou incompleta: as outras seguem */
    }
  }
  return out;
}

export type { TipoOutbox };
