// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › AUTORIDADE DE PREÇO NA IMPORTAÇÃO.
//
// O ERP é a ÚNICA autoridade dos preços internos. O preço que chega da loja é
// EVIDÊNCIA, nunca substituto silencioso do preço oficial:
//
//   RETAIL     → produtos.preco_venda      (+ override commerce_precos da loja)
//   WHOLESALE  → produtos.preco_atacado    (+ override commerce_precos da loja)
//
// O importador de pedidos (Multi-Store E legado) grava SEMPRE o preço oficial do
// ERP no item da venda. Quando o preço recebido diverge, a divergência é
// REGISTRADA (para conferência) e o preço remoto fica preservado como evidência —
// nunca como valor da venda, do total, do financeiro ou da comissão.
//
// Exceção legítima: preço NEGOCIADO explicitamente autorizado e auditado
// (`autorizarNegociado`). Sem autorização, o remoto NÃO vence.
// ============================================================================
import { getStore } from '../../services';
import { getResource } from '../../resources';
import type { Row, Tx } from '../../store';
import { FONTE_PRECO, type StoreKey } from './registry';
import { precoDaLoja } from './precos';

const R_PRECOS = () => getResource('commerce_precos')!;

/**
 * Linha de override de preço de canal VIGENTE para UMA loja, com queda para a
 * linha legada (sem loja) — e, se a coluna `store_key` ainda não existir
 * (pré-migration 0103), para o comportamento antigo. Garante que RETAIL e
 * WHOLESALE nunca compartilhem override (A06-12).
 */
export async function linhaOverrideDaLoja(
  empresaId: number,
  produtoId: number,
  canal: string,
  store: StoreKey,
  tx?: Tx
): Promise<Row | null> {
  const s = getStore();
  try {
    const daLoja = await s.findOneWhere(R_PRECOS(), { empresa_id: empresaId, produto_id: produtoId, canal, store_key: store }, tx);
    if (daLoja) return daLoja;
    return await s.findOneWhere(R_PRECOS(), { empresa_id: empresaId, produto_id: produtoId, canal, store_key: null }, tx);
  } catch {
    return s.findOneWhere(R_PRECOS(), { empresa_id: empresaId, produto_id: produtoId, canal }, tx);
  }
}

/** Origens possíveis do preço efetivamente gravado no item. */
export type OrigemPrecoPersistido = 'erp' | 'negociado';

export type DesfechoPreco = {
  /** Preço a persistir no item da venda (sempre autoridade ERP, salvo negociado). */
  preco: number;
  origem: OrigemPrecoPersistido;
  /** Campo de catálogo usado como base nesta loja. */
  fonte: 'preco_venda' | 'preco_atacado';
  /** Preço OFICIAL do ERP resolvido para a loja (base + override vigente). */
  preco_erp: number;
  /** Preço recebido da loja, quando veio um valor utilizável. */
  preco_remoto: number | null;
  /** true quando remoto ≠ oficial (registrado para conferência). */
  divergente: boolean;
  motivo: string | null;
};

/**
 * Preço oficial do ERP para UMA loja: a base do catálogo desta loja, já com o
 * override de `commerce_precos` (canal WOOCOMMERCE) da MESMA loja quando vigente.
 * Sem preço válido devolve 0 — o chamador decide (produto sem preço é pendente).
 */
export async function precoOficialDoErp(
  empresaId: number,
  produto: Row,
  store: StoreKey,
  tx?: Tx
): Promise<{ preco: number; fonte: 'preco_venda' | 'preco_atacado'; promo: number | null }> {
  const fonte = FONTE_PRECO[store];
  const linha = await linhaOverrideDaLoja(empresaId, Number(produto.id), 'WOOCOMMERCE', store, tx);
  const resolvido = precoDaLoja(produto, store, linha);
  return { preco: resolvido.preco, fonte, promo: resolvido.promo };
}

/**
 * Decide o preço do item importado sob a política de autoridade do ERP.
 *
 * `precoRemoto` é o valor recebido da loja (price ou total/quantidade), quando
 * houver. Ele NUNCA vence o preço oficial sem autorização explícita.
 */
export function decidirPrecoItem(opcoes: {
  precoErp: number;
  fonte: 'preco_venda' | 'preco_atacado';
  precoRemoto: number | null;
  negociadoAutorizado?: { valor: number; motivo: string } | null;
}): DesfechoPreco {
  const { precoErp, fonte, precoRemoto } = opcoes;
  const oficial = Number.isFinite(precoErp) && precoErp > 0 ? Math.round(precoErp * 100) / 100 : 0;
  const remoto = precoRemoto != null && Number.isFinite(precoRemoto) && precoRemoto > 0 ? Math.round(precoRemoto * 100) / 100 : null;

  if (opcoes.negociadoAutorizado && opcoes.negociadoAutorizado.valor > 0) {
    const negociado = Math.round(opcoes.negociadoAutorizado.valor * 100) / 100;
    return {
      preco: negociado,
      origem: 'negociado',
      fonte,
      preco_erp: oficial,
      preco_remoto: remoto,
      divergente: remoto != null && remoto !== negociado,
      motivo: `Preço negociado autorizado: ${opcoes.negociadoAutorizado.motivo}`,
    };
  }

  if (oficial <= 0) {
    return {
      preco: 0,
      origem: 'erp',
      fonte,
      preco_erp: 0,
      preco_remoto: remoto,
      divergente: false,
      motivo: `Produto sem ${fonte} válido no ERP — o preço remoto (${remoto ?? '—'}) não foi usado.`,
    };
  }

  const divergente = remoto != null && Math.abs(remoto - oficial) >= 0.01;
  return {
    preco: oficial,
    origem: 'erp',
    fonte,
    preco_erp: oficial,
    preco_remoto: remoto,
    divergente,
    motivo: divergente
      ? `Preço recebido da loja (${remoto}) diverge do preço oficial do ERP (${oficial}); prevaleceu o ERP.`
      : null,
  };
}
