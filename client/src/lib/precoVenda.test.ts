// ============================================================================
// Formação do preço da venda — módulo de UX do cliente.
//
// REGRA COMERCIAL: a BASE do desconto é SEMPRE o PREÇO DE VENDA. O preço de
// tabela é apenas referência (snapshot) e NÃO participa do cálculo.
//
// O cliente espelha a fórmula canônica do servidor para resposta imediata; o
// backend continua sendo a autoridade. Aqui garantimos que os três campos
// (preço de venda, desconto %, desconto R$) são bidirecionais e que o resumo
// bate com os casos obrigatórios da tarefa.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  descontoUnitarioDe,
  descontoUnitarioDePrecoLiquido,
  linhaDePreco,
  normalizarPctVenda,
  normalizarPrecoVenda,
  pctDeDescontoUnitario,
  pctDePrecoLiquido,
  precoLiquidoDe,
  resumoVenda,
} from './precoVenda';

describe('linhaDePreco — casos obrigatórios', () => {
  it('CASO 1 — venda 90 com 20% → desconto R$ 18 e líquido 72', () => {
    const l = linhaDePreco(1, 90, 20);
    expect(l).toMatchObject({ precoVenda: 90, descontoPct: 20, descontoUnitario: 18, subtotal: 72, desconto: 18 });
  });

  it('CASO 2 — venda 90 com desconto R$ 18 → 20% e líquido 72', () => {
    const pct = pctDeDescontoUnitario(90, 18);
    expect(pct).toBe(20);
    const l = linhaDePreco(1, 90, pct);
    expect(l.descontoUnitario).toBe(18);
    expect(l.subtotal).toBe(72);
  });

  it('CASO 3 — venda 90 com líquido desejado 72 → desconto R$ 18 e 20%', () => {
    const rs = descontoUnitarioDePrecoLiquido(90, 72);
    expect(rs).toBe(18);
    expect(pctDePrecoLiquido(90, 72)).toBe(20);
    expect(precoLiquidoDe(90, rs)).toBe(72);
  });

  it('CASO 4 — venda 90 menos R$ 15 → líquido 75 e 16,67%', () => {
    expect(pctDeDescontoUnitario(90, 15)).toBe(16.67);
    const l = linhaDePreco(1, 90, pctDeDescontoUnitario(90, 15));
    expect(l.subtotal).toBe(75);
    expect(l.descontoUnitario).toBe(15);
  });

  it('CASO 5 — venda 90 com 20,5% → desconto R$ 18,45 e líquido 71,55', () => {
    const l = linhaDePreco(1, 90, 20.5);
    expect(l.descontoUnitario).toBe(18.45);
    expect(l.subtotal).toBe(71.55);
  });

  it('sem desconto → desconto 0 e subtotal = venda × quantidade', () => {
    const l = linhaDePreco(3, 90, 0);
    expect(l).toMatchObject({ precoVenda: 90, descontoPct: 0, descontoUnitario: 0, subtotal: 270, desconto: 0 });
  });

  it('quantidade > 1 → subtotal = líquido × quantidade', () => {
    const l = linhaDePreco(2, 90, 20);
    expect(l.subtotal).toBe(144);
    expect(l.bruto).toBe(180);
    expect(l.desconto).toBe(36);
  });

  it('O PREÇO DE TABELA NÃO INTERFERE NO CÁLCULO (tabela 80, venda 90, 20%)', () => {
    const comTabela = linhaDePreco(1, 90, 20, 80);
    const semTabela = linhaDePreco(1, 90, 20);
    expect(comTabela.tabela).toBe(80);
    expect(comTabela.descontoUnitario).toBe(18);
    expect(comTabela.subtotal).toBe(72);
    // A única diferença entre as duas é o campo de referência.
    expect({ ...comTabela, tabela: 0 }).toEqual({ ...semTabela, tabela: 0 });
  });

  it('valores inválidos/negativos são normalizados para um intervalo seguro', () => {
    expect(normalizarPctVenda(-10)).toBe(0);
    expect(normalizarPctVenda(150)).toBe(100);
    expect(normalizarPrecoVenda(-5)).toBe(0);
    expect(linhaDePreco(1, 90, -5).descontoUnitario).toBe(0);
    expect(linhaDePreco(1, 90, 120).subtotal).toBe(0);
    expect(linhaDePreco(1, -50, 20).precoVenda).toBe(0);
  });
});

describe('bidirecionalidade dos três campos (base = preço de venda)', () => {
  it('desconto % → desconto R$', () => {
    expect(descontoUnitarioDe(90, 20.5)).toBe(18.45);
  });

  it('desconto R$ → desconto %', () => {
    expect(pctDeDescontoUnitario(90, 15)).toBe(16.67);
  });

  it('preço líquido → desconto R$ e %', () => {
    expect(descontoUnitarioDePrecoLiquido(90, 75)).toBe(15);
    expect(pctDePrecoLiquido(90, 75)).toBe(16.67);
  });

  it('alterar o desconto % várias vezes mantém a identidade venda − R$ = líquido', () => {
    for (const pct of [0, 5, 12.5, 20, 20.5, 33.33, 50, 99.99, 100]) {
      const l = linhaDePreco(1, 90, pct);
      expect(l.descontoUnitario + l.subtotal).toBeCloseTo(90, 2);
    }
    expect(linhaDePreco(1, 90, 100).subtotal).toBe(0);
  });

  it('desconto em R$ nunca deixa o líquido negativo', () => {
    expect(linhaDePreco(1, 90, pctDeDescontoUnitario(90, 999)).subtotal).toBe(0);
    expect(descontoUnitarioDePrecoLiquido(90, -50)).toBe(90);
  });
});

describe('resumoVenda', () => {
  it('múltiplas linhas somam corretamente (bruto − desconto = líquido)', () => {
    const r = resumoVenda([linhaDePreco(1, 90, 20), linhaDePreco(1, 90, 0), linhaDePreco(2, 90, 20)], 0, 0);
    expect(r.bruto).toBe(360);
    expect(r.descontoLinhas).toBe(54);
    expect(r.subtotalLiquido).toBe(306);
    expect(r.total).toBe(306);
  });

  it('percentual total é ponderado pelo valor bruto (não média simples)', () => {
    // 50% em 100 e 0% em 300 → desconto 50 / bruto 400 = 12,5%.
    const r = resumoVenda([linhaDePreco(1, 100, 50), linhaDePreco(1, 300, 0)], 0, 0);
    expect(r.bruto).toBe(400);
    expect(r.descontoLinhas).toBe(50);
    expect(r.descontoPct).toBe(12.5);
    expect(r.descontoPct).not.toBe(25); // média simples daria 25%
  });

  it('nunca mostra desconto − R$ 0,00 quando há desconto nas linhas', () => {
    const r = resumoVenda([linhaDePreco(1, 90, 20, 80)], 0, 0);
    expect(r.descontoTotal).toBe(18);
    expect(r.subtotalLiquido).toBe(72);
  });

  it('frete e desconto do pedido entram no total', () => {
    const r = resumoVenda([linhaDePreco(2, 90, 20)], 10, 5);
    expect(r.subtotalLiquido).toBe(144);
    expect(r.descontoLinhas).toBe(36);
    expect(r.descontoPedido).toBe(10);
    expect(r.descontoTotal).toBe(46);
    expect(r.total).toBe(139);
  });

  it('frete e desconto de pedido nunca deixam o total negativo', () => {
    const r = resumoVenda([linhaDePreco(1, 90, 20)], 999, 0);
    expect(r.total).toBe(0);
  });
});
