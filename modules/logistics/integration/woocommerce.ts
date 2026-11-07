// ============================================================================
// MOTOR DE FRETE › INTEGRAÇÃO › WOOCOMMERCE MULTI-STORE
//
// O módulo logístico se integra às DUAS lojas SEM duplicar a arquitetura de
// integração existente:
//
//   • a LOJA de origem vem do `store_key` da remessa (RETAIL / WHOLESALE) e é
//     validada contra o registry do WooCommerce (`exigirStoreDaEmpresa`);
//   • o RASTREIO é publicado na loja pelo `commerce_outbox` de sempre (ação
//     `logistics-woo-tracking`), com retry, backoff e idempotência — nenhuma
//     chamada externa acontece na requisição do usuário;
//   • o pedido externo é identificado por `WOO-<LOJA>-<id>` (a MESMA referência
//     da importação) — nunca por heurística;
//   • a falha de uma loja não bloqueia a outra (chaves e eventos distintos);
//   • NADA é publicado em massa nem cancelado automaticamente: o envio do
//     rastreio é uma operação explícita e registrada.
//
// Modo de homologação (`WOOCOMMERCE_SYNC_DRY_RUN`) é respeitado pelo cliente
// HTTP do WooCommerce: nada é escrito nas lojas.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { enfileirarOutbox } from '../../../server/src/commerce/outbox';
import { configStore, exigirStoreDaEmpresa, type ConfigStore, type StoreKey } from '../../../server/src/commerce/woocommerce/registry';
import { wooStoreFetch, ehDryRun } from '../../../server/src/commerce/woocommerce/cliente';
import { registrarSincronizacao } from '../../../server/src/commerce/woocommerce/estado';
import { ehStoreKey } from '../domain/contract';
import { auditarLogistica } from '../infrastructure/audit';
import type { Row, Tx } from '../../../server/src/store';

const R_ENVIO = () => getResource('envios')!;

/**
 * Modo de homologação do módulo logístico: quando ligado, NADA é escrito na
 * loja — a operação é registrada (auditoria) e reportada como enviada, sem
 * chamar o PUT. Complementa o `WOOCOMMERCE_SYNC_DRY_RUN` global.
 */
function logisticsDryRun(): boolean {
  const bruto = String(process.env.LOGISTICS_SYNC_DRY_RUN ?? '').trim().toLowerCase();
  return ['1', 'true', 'sim', 'yes', 'on'].includes(bruto);
}

/** Loja da remessa — recorte explícito e validado contra a empresa. */
export function lojaDaRemessa(envio: Row, empresaId: number): ConfigStore | null {
  const store = envio.store_key;
  if (!ehStoreKey(store)) return null;
  const cfg = configStore(store);
  if (!cfg || cfg.empresaId !== empresaId) return null;
  return cfg;
}

/** Chave idempotente do envio de rastreio para a loja. */
export function chaveRastreioLoja(store: StoreKey, envioId: number): string {
  return `logistics-woo-tracking:${store}:${envioId}`;
}

/**
 * Enfileira a publicação do rastreio na loja de origem da remessa.
 * Idempotente pela chave — repetir não duplica a entrega.
 */
export async function enfileirarRastreioLoja(empresaId: number, envioId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const envio = await s.get(R_ENVIO(), envioId, tx);
  if (!envio || Number(envio.empresa_id) !== empresaId) return null;
  if (!ehStoreKey(envio.store_key)) return null;
  const store = envio.store_key as StoreKey;
  const cfg = exigirStoreDaEmpresa(store, empresaId);
  const evento = await enfileirarOutbox(
    empresaId,
    'sincronizacao',
    chaveRastreioLoja(store, envioId),
    { acao: 'logistics-woo-tracking', store_key: store, envio_id: envioId, url_loja: cfg.url },
    tx
  );
  return evento;
}

/**
 * Publica o rastreio no pedido da loja. Executado PELO WORKER (outbox).
 * Só envia quando há código de rastreamento e o pedido externo é identificável.
 */
export async function publicarRastreioLoja(empresaId: number, envioId: number, tx?: Tx): Promise<'enviado' | 'ignorado' | 'erro'> {
  const s = getStore();
  const envio = await s.get(R_ENVIO(), envioId, tx);
  if (!envio || Number(envio.empresa_id) !== empresaId) return 'ignorado';
  const cfg = lojaDaRemessa(envio, empresaId);
  if (!cfg) return 'ignorado';
  const codigo = String(envio.codigo_rastreamento || '').trim();
  if (!codigo) return 'ignorado';

  // O pedido externo da venda carrega a referência da loja (WOO-<LOJA>-<id>).
  const venda = await s.get(getResource('vendas')!, Number(envio.venda_id), tx);
  if (!venda) return 'ignorado';
  const pedidoExterno = String(venda.pedido_externo_id || '').trim();
  const canal = String(venda.pedido_externo_canal || '');
  if (!pedidoExterno || canal !== `WOOCOMMERCE_${cfg.store_key}`) {
    // A venda não é desta loja — não publica em loja errada.
    return 'ignorado';
  }

  const transportadora = String(envio.provider || '').trim();
  const body = {
    // Campos padronizados de rastreio do WooCommerce (meta_data + status).
    meta_data: [
      { key: '_tracking_number', value: codigo },
      { key: '_tracking_provider', value: transportadora },
      { key: '_tracking_url', value: envio.etiqueta_url ? String(envio.etiqueta_url) : '' },
    ],
  };
  try {
    if (logisticsDryRun()) {
      await auditarLogistica(
        { empresaId, storeKey: cfg.store_key, entidade: 'envio', entidadeId: envioId, acao: 'woo_rastreio_dry_run', descricao: `[DRY-RUN] Rastreio ${codigo} NÃO foi publicado (homologação) no pedido ${pedidoExterno} da loja ${cfg.store_key}`, dados: { pedido_externo: pedidoExterno, transportadora } },
        tx
      );
      return 'enviado';
    }
    const resposta = await wooStoreFetch<Record<string, unknown>>(cfg, `/orders/${encodeURIComponent(pedidoExterno)}`, { method: 'PUT', body });
    if (ehDryRun(resposta)) {
      await registrarSincronizacao(empresaId, cfg.store_key, { erro: null });
      return 'enviado';
    }
    await registrarSincronizacao(empresaId, cfg.store_key, { erro: null });
    await auditarLogistica(
      { empresaId, storeKey: cfg.store_key, entidade: 'envio', entidadeId: envioId, acao: 'woo_rastreio_publicado', descricao: `Rastreio ${codigo} publicado no pedido ${pedidoExterno} da loja ${cfg.store_key}`, dados: { pedido_externo: pedidoExterno, transportadora } },
      tx
    );
    return 'enviado';
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : 'Falha ao publicar rastreio na loja.';
    await registrarSincronizacao(empresaId, cfg.store_key, { erro: mensagem });
    return 'erro';
  }
}

/** Loja de uma venda (para associar remessa ↔ pedido da loja). */
export async function lojaDaVenda(empresaId: number, vendaId: number, tx?: Tx): Promise<StoreKey | null> {
  const venda = await getStore().get(getResource('vendas')!, vendaId, tx);
  if (!venda || Number(venda.empresa_id) !== empresaId) return null;
  const canal = String(venda.pedido_externo_canal || '');
  if (canal === 'WOOCOMMERCE_RETAIL') return 'RETAIL';
  if (canal === 'WOOCOMMERCE_WHOLESALE') return 'WHOLESALE';
  return null;
}
