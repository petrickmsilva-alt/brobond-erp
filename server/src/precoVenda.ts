// ============================================================================
// FORMAÇÃO DE PREÇO DA VENDA — regra canônica única.
//
// Separa, em cada linha da venda:
//   • preço de TABELA  → referência da precificação/cadastro (snapshot);
//   • preço de VENDA   → preço comercial efetivamente praticado;
//   • desconto %       → percentual concedido SOBRE o preço de VENDA;
//   • desconto R$      → valor concedido SOBRE o preço de VENDA;
//   • SUBTOTAL         → preço líquido × quantidade.
//
// REGRA COMERCIAL DESTE ERP: a BASE do desconto é SEMPRE o preço de VENDA.
// O preço de tabela NÃO participa do cálculo do desconto — ele é apenas a
// referência comercial preservada como snapshot histórico da venda.
//
// Invariantes (garantidas em qualquer ordem de edição):
//   desconto_unit    = round2(preco_venda × pct/100)
//   preco_liquido    = round2(preco_venda − desconto_unit)
//   subtotal_linha   = round2(qtd × preco_liquido)
//
// PRECISÃO: dinheiro em 2 casas (round2), percentual em 2 casas. O percentual
// derivado de um desconto em R$ é calculado sobre o preço de venda e
// arredondado a 2 casas; o desconto em R$ derivado do percentual é a fonte do
// líquido, para que "preço de venda − desconto R$ = líquido" feche no centavo.
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

/** Preço de venda normalizado (2 casas, nunca negativo). */
export function normalizarPrecoVenda(preco: unknown): number {
  return round2(Math.max(0, num(preco)));
}

/** Desconto em R$ (unitário) a partir do preço de venda e do desconto %. */
export function descontoUnitarioDe(precoVenda: number, pct: number): number {
  return round2(Math.max(0, num(precoVenda) * (normalizarPct(pct) / 100)));
}

/** Preço líquido (unitário) = preço de venda − desconto em R$. */
export function precoLiquidoDe(precoVenda: number, descontoUnitario: number): number {
  return round2(Math.max(0, num(precoVenda) - num(descontoUnitario)));
}

/**
 * Preço líquido (unitário) a partir do preço de venda e do desconto %.
 * É o "preço de venda após desconto" — o que o operador enxerga na linha.
 */
export function precoLiquidoDePct(precoVenda: number, pct: number): number {
  return precoLiquidoDe(precoVenda, descontoUnitarioDe(precoVenda, pct));
}

/** Desconto % (2 casas) equivalente a um desconto em R$ sobre o preço de venda. */
export function pctDeDescontoUnitario(precoVenda: number, descontoUnitario: number): number {
  const base = num(precoVenda);
  if (base <= 0) return 0;
  return normalizarPct((num(descontoUnitario) / base) * 100);
}

/** Desconto % (2 casas) equivalente a um preço líquido informado. */
export function pctDePrecoLiquido(precoVenda: number, precoLiquido: number): number {
  const base = num(precoVenda);
  if (base <= 0) return 0;
  const desconto = Math.max(0, base - num(precoLiquido));
  return normalizarPct((desconto / base) * 100);
}

/**
 * Desconto em R$ (unitário) equivalente a um preço líquido desejado.
 * Limitado ao próprio preço de venda (o líquido nunca fica negativo).
 */
export function descontoUnitarioDePrecoLiquido(precoVenda: number, precoLiquido: number): number {
  const base = num(precoVenda);
  return round2(Math.min(base, Math.max(0, base - num(precoLiquido))));
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

/**
 * Fecha uma linha da venda a partir do preço de VENDA e do desconto %.
 *
 * O preço de tabela é apenas transportado como referência — ele não entra em
 * nenhuma conta. O subtotal é `round2(qtd × (preço de venda − desconto R$))`.
 */
export function linhaDePreco(quantidade: unknown, precoVenda: unknown, descontoPct: unknown, precoTabela: unknown = 0): LinhaPreco {
  const qtd = num(quantidade);
  const venda = normalizarPrecoVenda(precoVenda);
  const pct = normalizarPct(descontoPct);
  const tabela = round2(Math.max(0, num(precoTabela)));
  const descontoUnitario = descontoUnitarioDe(venda, pct);
  const liquido = precoLiquidoDe(venda, descontoUnitario);
  const bruto = round2(qtd * venda);
  const subtotal = round2(qtd * liquido);
  return {
    tabela,
    precoVenda: venda,
    descontoPct: pct,
    descontoUnitario,
    bruto,
    subtotal,
    desconto: round2(bruto - subtotal),
  };
}

export type ResumoVenda = {
  /** Soma dos itens pelo preço de venda (preço bruto). */
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
