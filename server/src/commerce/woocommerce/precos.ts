// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › RESOLUÇÃO DE PREÇO POR LOJA.
//
// A regra comercial da empresa é UMA só e não é reinventada aqui:
//
//   RETAIL     → produtos.preco_venda      (base de varejo)
//   WHOLESALE  → produtos.preco_atacado    (base de atacado)
//
// O preço da WHOLESALE ainda passa por `atacado_min_qtd`: quantidade mínima
// para o preço de atacado valer. Um preço de atacado inválido (ausente ou zero)
// NUNCA é publicado — a loja ficaria com um anúncio sem preço. Nesse caso a
// publicação é recusada com motivo acionável.
//
// A precedência de promoção por canal continua no Commerce (`precoEfetivo` em
// regras.ts): quando existe linha vigente em `commerce_precos` para o canal, ela
// vence a base. O que muda por loja é APENAS a base.
// ============================================================================
import { precoEfetivo, round2 } from '../regras';
import type { Row } from '../../store';
import type { StoreKey } from './registry';
import { FONTE_PRECO } from './registry';

export type PrecoLoja = {
  /** Preço cheio publicado. */
  preco: number;
  /** Preço promocional (menor), quando houver linha de canal vigente. */
  promo: number | null;
  /** De onde saiu o número — para a tela explicar sem recalcular. */
  origem: 'canal' | 'base';
  /** Fonte de catálogo aplicada nesta loja. */
  fonte: 'preco_venda' | 'preco_atacado';
};

/**
 * Resolve o preço do produto para UMA loja.
 *
 * `linhaCanal` é a linha de `commerce_precos` (empresa, produto, canal), quando
 * existir e estiver vigente; ela sobrepõe a base da loja. Sem linha vigente,
 * vale a base (`preco_venda` na RETAIL, `preco_atacado` na WHOLESALE).
 */
export function precoDaLoja(produto: Row, store: StoreKey, linhaCanal?: Row | null, hoje = new Date()): PrecoLoja {
  const fonte = FONTE_PRECO[store];
  const base = Number(produto?.[fonte] ?? 0);
  const efetivo = linhaCanal
    ? precoEfetivo({
        base,
        precoCanal: Number(linhaCanal.preco ?? 0),
        precoPromoCanal: linhaCanal.preco_promo != null ? Number(linhaCanal.preco_promo) : null,
        hoje,
        vigenciaInicio: (linhaCanal.vigencia_inicio as string | null) ?? null,
        vigenciaFim: (linhaCanal.vigencia_fim as string | null) ?? null,
      })
    : precoEfetivo({ base, hoje });
  return { preco: efetivo.preco, promo: efetivo.promo, origem: efetivo.origem, fonte };
}

/** Quantidade mínima de atacado declarada no produto (0 = sem mínimo). */
export function minimoAtacado(produto: Row): number {
  return Math.max(0, Math.trunc(Number(produto?.atacado_min_qtd ?? 0) || 0));
}

export type MotivoPrecoInvalido = { codigo: 'SEM_PRECO' | 'ABAIXO_MINIMO'; mensagem: string };

/**
 * Valida se o preço da loja pode ser publicado.
 *
 * Regras:
 *   • preço ausente ou <= 0 → recusa (nunca publica anúncio sem preço);
 *   • WHOLESALE com `atacado_min_qtd` > 0 e `preco_atacado` inválido → recusa
 *     com o motivo real (o produto não atende a política de atacado).
 */
export function validarPrecoPublicavel(preco: PrecoLoja, produto: Row, store: StoreKey): MotivoPrecoInvalido | null {
  if (!Number.isFinite(preco.preco) || preco.preco <= 0) {
    const rotulo = store === 'WHOLESALE' ? 'preço de atacado (produtos.preco_atacado)' : 'preço de venda (produtos.preco_venda)';
    return { codigo: 'SEM_PRECO', mensagem: `O produto não tem ${rotulo} válido — publique-o depois de cadastrar o preço.` };
  }
  if (store === 'WHOLESALE' && minimoAtacado(produto) > 0 && round2(Number(produto?.preco_atacado ?? 0)) <= 0) {
    return {
      codigo: 'ABAIXO_MINIMO',
      mensagem: `A loja WHOLESALE exige quantidade mínima de atacado (${minimoAtacado(produto)}), mas o produto não tem preço de atacado válido.`,
    };
  }
  return null;
}
