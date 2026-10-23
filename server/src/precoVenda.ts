// ============================================================================
// FORMAÇÃO DE PREÇO DA VENDA — regra canônica única.
//
// Separa, em cada linha da venda:
//   • preço de TABELA  → referência da precificação/cadastro (snapshot);
//   • preço de VENDA   → preço efetivamente praticado;
//   • desconto %       → percentual concedido SOBRE o preço de tabela;
//   • desconto R$      → valor concedido SOBRE o preço de tabela;
//   • SUBTOTAL         → preço de venda × quantidade.
//
// Invariantes (garantidas em qualquer ordem de edição):
//   preco_venda      = round2(tabela × (1 − pct/100))
//   desconto_unit    = round2(tabela − preco_venda)
//   bruto_linha      = round2(qtd × tabela)
//   subtotal_linha   = round2(qtd × tabela × (1 − pct/100))   (fórmula do ERP)
//   desconto_linha   = bruto_linha − subtotal_linha   (exato, sem centavo solto)
//
// PRECISÃO: dinheiro em 2 casas (round2), percentual em 2 casas. O percentual é
// derivado do valor monetário arredondado — nunca o contrário — para que
// "tabela − desconto R$ = preço de venda" feche sempre no centavo.
//
// Este módulo é a autoridade do backend. O frontend espelha as mesmas funções
// (client/src/lib/precoVenda.ts) apenas para resposta imediata na tela; o
// servidor RECALCULA e valida tudo o que grava.
// ============================================================================
import { round2 } from './utils';

export const PCT_MAX = 100;

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

/** Percentual normalizado para 2 casas, limitado a [0, 100]. */
export function normalizarPct(pct: unknown): number {
  const n = num(pct, 0);
  if (n < 0) return 0;
  if (n > PCT_MAX) return PCT_MAX;
  return round2(n);
}

/** Preço de venda (unitário) a partir do preço de tabela e do desconto %. */
export function precoVendaDe(tabela: number, pct: number): number {
  return round2(Math.max(0, num(tabela) * (1 - normalizarPct(pct) / 100)));
}

/** Desconto em R$ (unitário) a partir do preço de tabela e do desconto %. */
export function descontoUnitarioDe(tabela: number, pct: number): number {
  return round2(Math.max(0, num(tabela) - precoVendaDe(tabela, pct)));
}

/** Desconto % (2 casas) equivalente a um preço de venda informado. */
export function pctDePrecoVenda(tabela: number, precoVenda: number): number {
  const t = num(tabela);
  if (t <= 0) return 0;
  return normalizarPct((1 - num(precoVenda) / t) * 100);
}

/** Desconto % (2 casas) equivalente a um desconto em R$ (unitário) informado. */
export function pctDeDescontoUnitario(tabela: number, descontoUnitario: number): number {
  const t = num(tabela);
  if (t <= 0) return 0;
  return normalizarPct((num(descontoUnitario) / t) * 100);
}

/** Preço de venda (unitário) a partir do desconto em R$ (unitário). */
export function precoVendaDeDescontoUnitario(tabela: number, descontoUnitario: number): number {
  return round2(Math.max(0, num(tabela) - num(descontoUnitario)));
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

/**
 * Fecha uma linha da venda a partir do preço de TABELA e do desconto %.
 *
 * O subtotal usa a fórmula canônica do ERP — `round2(qtd × tabela × (1 − pct))`
 * — e não `round2(qtd × preço de venda)`: as duas coincidem em praticamente
 * todos os casos, mas a primeira é a que o backend grava, então é ela que a
 * tela precisa espelhar para não exibir um centavo diferente do servidor.
 * O desconto da linha é a diferença EXATA para o bruto.
 */
export function linhaDePreco(quantidade: unknown, tabela: unknown, descontoPct: unknown): LinhaPreco {
  const qtd = num(quantidade);
  const t = round2(Math.max(0, num(tabela)));
  const pct = normalizarPct(descontoPct);
  const precoVenda = precoVendaDe(t, pct);
  const bruto = round2(qtd * t);
  const subtotal = round2(qtd * t * (1 - pct / 100));
  return {
    tabela: t,
    precoVenda,
    descontoPct: pct,
    descontoUnitario: round2(t - precoVenda),
    bruto,
    subtotal,
    desconto: round2(bruto - subtotal),
  };
}

export type ResumoVenda = {
  /** Soma dos itens pelo preço de tabela (preço bruto). */
  bruto: number;
  /** Descontos concedidos nas linhas. */
  descontoLinhas: number;
  /** Desconto comercial aplicado ao pedido (nível cabeçalho). */
  descontoPedido: number;
  /** descontoLinhas + descontoPedido. */
  descontoTotal: number;
  /** Percentual total de desconto sobre o preço bruto (comercial, não média simples). */
  descontoPct: number;
  /** Soma dos subtotais das linhas (já líquidos de desconto de linha). */
  subtotalLiquido: number;
  frete: number;
  total: number;
};

type LinhaResumo = { bruto?: unknown; subtotal?: unknown };

/**
 * Resumo consolidado da venda. O desconto percentual é
 * `desconto total / preço bruto total` — nunca a média dos percentuais.
 */
export function resumoVenda(linhas: LinhaResumo[], descontoPedido: unknown, frete: unknown): ResumoVenda {
  let bruto = 0;
  let subtotalLiquido = 0;
  for (const l of linhas) {
    bruto += num(l.bruto);
    subtotalLiquido += num(l.subtotal);
  }
  bruto = round2(bruto);
  subtotalLiquido = round2(subtotalLiquido);
  const descontoLinhas = round2(Math.max(0, bruto - subtotalLiquido));
  const descPedido = round2(Math.max(0, num(descontoPedido)));
  const descontoTotal = round2(descontoLinhas + descPedido);
  const freteNum = round2(Math.max(0, num(frete)));
  const total = round2(Math.max(0, subtotalLiquido - descPedido + freteNum));
  return {
    bruto,
    descontoLinhas,
    descontoPedido: descPedido,
    descontoTotal,
    descontoPct: bruto > 0 ? round2((descontoTotal / bruto) * 100) : 0,
    subtotalLiquido,
    frete: freteNum,
    total,
  };
}
