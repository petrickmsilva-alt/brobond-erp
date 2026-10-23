// ============================================================================
// FORMAÇÃO DE PREÇO DA VENDA — espelho de UX.
//
// Mesmas fórmulas de `server/src/precoVenda.ts`, usadas apenas para resposta
// imediata na tela. O backend continua sendo a autoridade: ele recalcula e
// valida o que grava, e ignora qualquer `preco_tabela` enviado pelo cliente.
//
// A regra do ERP é: o desconto é sempre sobre o preço de TABELA e o SUBTOTAL é
// `preço de venda × quantidade`. O percentual é derivado do valor monetário
// arredondado para que "tabela − desconto R$ = preço de venda" feche no centavo.
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

/** Preço de venda (unitário) a partir do preço de tabela e do desconto %. */
export function precoVendaDe(tabela: number, pct: number): number {
  const t = Number(tabela) || 0;
  return arredondarMoeda(Math.max(0, t * (1 - normalizarPctVenda(pct) / 100)));
}

/** Desconto em R$ (unitário) a partir do preço de tabela e do desconto %. */
export function descontoUnitarioDe(tabela: number, pct: number): number {
  const t = Number(tabela) || 0;
  return arredondarMoeda(Math.max(0, t - precoVendaDe(t, pct)));
}

/** Desconto % equivalente a um preço de venda informado. */
export function pctDePrecoVenda(tabela: number, precoVenda: number): number {
  const t = Number(tabela) || 0;
  if (t <= 0) return 0;
  return normalizarPctVenda((1 - (Number(precoVenda) || 0) / t) * 100);
}

/** Desconto % equivalente a um desconto em R$ (unitário) informado. */
export function pctDeDescontoUnitario(tabela: number, descontoUnitario: number): number {
  const t = Number(tabela) || 0;
  if (t <= 0) return 0;
  return normalizarPctVenda(((Number(descontoUnitario) || 0) / t) * 100);
}

/** Preço de venda (unitário) a partir do desconto em R$ (unitário). */
export function precoVendaDeDescontoUnitario(tabela: number, descontoUnitario: number): number {
  const t = Number(tabela) || 0;
  return arredondarMoeda(Math.max(0, t - (Number(descontoUnitario) || 0)));
}

export type LinhaPreco = {
  tabela: number;
  precoVenda: number;
  descontoPct: number;
  descontoUnitario: number;
  bruto: number;
  subtotal: number;
  desconto: number;
};

/** Fecha uma linha da venda a partir da quantidade, preço de tabela e desconto %. */
export function linhaDePreco(quantidade: unknown, tabela: unknown, descontoPct: unknown): LinhaPreco {
  const qtd = Number(quantidade) || 0;
  const t = arredondarMoeda(Math.max(0, Number(tabela) || 0));
  const pct = normalizarPctVenda(descontoPct);
  const precoVenda = precoVendaDe(t, pct);
  const bruto = arredondarMoeda(qtd * t);
  // Fórmula canônica do ERP (a mesma que o backend grava), para a tela nunca
  // divergir do servidor em um centavo.
  const subtotal = arredondarMoeda(qtd * t * (1 - pct / 100));
  return {
    tabela: t,
    precoVenda,
    descontoPct: pct,
    descontoUnitario: arredondarMoeda(t - precoVenda),
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
