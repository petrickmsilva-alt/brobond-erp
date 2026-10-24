// ============================================================================
// FORMAÇÃO DE PREÇO DA VENDA — espelho de UX.
//
// Mesmas fórmulas de `server/src/precoVenda.ts`, usadas apenas para resposta
// imediata na tela. O backend continua sendo a autoridade: ele recalcula e
// valida o que grava.
//
// A regra do ERP é: a BASE do desconto é SEMPRE o preço de VENDA. O preço de
// TABELA é apenas referência comercial (snapshot) e NÃO participa do cálculo.
// O SUBTOTAL é `preço líquido × quantidade`, onde o preço líquido é
// `preço de venda − desconto R$`.
// ============================================================================

export const PCT_MAX_VENDA = 100;

export function arredondarMoeda(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function arredondarPct(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function normalizarPctVenda(pct: unknown): number {
  const n = Number(pct) || 0;
  if (n < 0) return 0;
  if (n > PCT_MAX_VENDA) return PCT_MAX_VENDA;
  return arredondarPct(n);
}

/** Preço de venda normalizado (2 casas, nunca negativo). */
export function normalizarPrecoVenda(preco: unknown): number {
  return arredondarMoeda(Math.max(0, Number(preco) || 0));
}

/** Desconto em R$ (unitário) a partir do preço de venda e do desconto %. */
export function descontoUnitarioDe(precoVenda: number, pct: number): number {
  const v = Number(precoVenda) || 0;
  return arredondarMoeda(Math.max(0, v * (normalizarPctVenda(pct) / 100)));
}

/** Preço líquido (unitário) = preço de venda − desconto em R$. */
export function precoLiquidoDe(precoVenda: number, descontoUnitario: number): number {
  const v = Number(precoVenda) || 0;
  return arredondarMoeda(Math.max(0, v - (Number(descontoUnitario) || 0)));
}

/** Preço líquido (unitário) a partir do preço de venda e do desconto %. */
export function precoLiquidoDePct(precoVenda: number, pct: number): number {
  return precoLiquidoDe(precoVenda, descontoUnitarioDe(precoVenda, pct));
}

/** Desconto % equivalente a um desconto em R$ (unitário) sobre o preço de venda. */
export function pctDeDescontoUnitario(precoVenda: number, descontoUnitario: number): number {
  const base = Number(precoVenda) || 0;
  if (base <= 0) return 0;
  return normalizarPctVenda(((Number(descontoUnitario) || 0) / base) * 100);
}

/** Desconto % equivalente a um preço líquido informado. */
export function pctDePrecoLiquido(precoVenda: number, precoLiquido: number): number {
  const base = Number(precoVenda) || 0;
  if (base <= 0) return 0;
  const desconto = Math.max(0, base - (Number(precoLiquido) || 0));
  return normalizarPctVenda((desconto / base) * 100);
}

/**
 * Desconto em R$ (unitário) equivalente a um preço líquido desejado.
 * Limitado ao próprio preço de venda (o líquido nunca fica negativo).
 */
export function descontoUnitarioDePrecoLiquido(precoVenda: number, precoLiquido: number): number {
  const base = Number(precoVenda) || 0;
  return arredondarMoeda(Math.min(base, Math.max(0, base - (Number(precoLiquido) || 0))));
}

export type LinhaPreco = {
  /** Preço de tabela (referência/snapshot). NÃO é base do desconto. */
  tabela: number;
  /** Preço de venda praticado — base do desconto. */
  precoVenda: number;
  descontoPct: number;
  descontoUnitario: number;
  /** Preço de venda × quantidade (preço bruto da linha). */
  bruto: number;
  /** Preço líquido × quantidade. */
  subtotal: number;
  /** Desconto total da linha (bruto − subtotal). */
  desconto: number;
};

/** Fecha uma linha da venda a partir da quantidade, preço de VENDA e desconto %. */
export function linhaDePreco(quantidade: unknown, precoVenda: unknown, descontoPct: unknown, precoTabela: unknown = 0): LinhaPreco {
  const qtd = Number(quantidade) || 0;
  const venda = normalizarPrecoVenda(precoVenda);
  const pct = normalizarPctVenda(descontoPct);
  const tabela = arredondarMoeda(Math.max(0, Number(precoTabela) || 0));
  const descontoUnitario = descontoUnitarioDe(venda, pct);
  const liquido = precoLiquidoDe(venda, descontoUnitario);
  const bruto = arredondarMoeda(qtd * venda);
  const subtotal = arredondarMoeda(qtd * liquido);
  return {
    tabela,
    precoVenda: venda,
    descontoPct: pct,
    descontoUnitario,
    bruto,
    subtotal,
    desconto: arredondarMoeda(bruto - subtotal),
  };
}

export type ResumoVenda = {
  bruto: number;
  descontoLinhas: number;
  descontoPedido: number;
  descontoTotal: number;
  descontoPct: number;
  subtotalLiquido: number;
  frete: number;
  total: number;
};

/**
 * Resumo consolidado da venda. O percentual total é
 * `desconto total / preço bruto total` — nunca média simples dos percentuais.
 */
export function resumoVenda(linhas: Array<{ bruto?: unknown; subtotal?: unknown }>, descontoPedido: unknown, frete: unknown): ResumoVenda {
  let bruto = 0;
  let subtotalLiquido = 0;
  for (const l of linhas) {
    bruto += Number(l.bruto) || 0;
    subtotalLiquido += Number(l.subtotal) || 0;
  }
  bruto = arredondarMoeda(bruto);
  subtotalLiquido = arredondarMoeda(subtotalLiquido);
  const descontoLinhas = arredondarMoeda(Math.max(0, bruto - subtotalLiquido));
  const descPedido = arredondarMoeda(Math.max(0, Number(descontoPedido) || 0));
  const descontoTotal = arredondarMoeda(descontoLinhas + descPedido);
  const freteNum = arredondarMoeda(Math.max(0, Number(frete) || 0));
  const total = arredondarMoeda(Math.max(0, subtotalLiquido - descPedido + freteNum));
  return {
    bruto,
    descontoLinhas,
    descontoPedido: descPedido,
    descontoTotal,
    descontoPct: bruto > 0 ? arredondarPct((descontoTotal / bruto) * 100) : 0,
    subtotalLiquido,
    frete: freteNum,
    total,
  };
}
