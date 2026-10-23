// ============================================================================
// Formação profissional do preço da venda — módulo de UX do cliente.
//
// O cliente espelha a fórmula canônica do servidor para resposta imediata; o
// backend continua sendo a autoridade. Aqui garantimos que os três campos
// (preço de venda, desconto %, desconto R$) são bidirecionais e que o resumo
// bate com os 12 cenários obrigatórios do pedido.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  descontoUnitarioDe,
  linhaDePreco,
  normalizarPctVenda,
  pctDeDescontoUnitario,
  pctDePrecoVenda,
  precoVendaDe,
  precoVendaDeDescontoUnitario,
  resumoVenda,
} from './precoVenda';

describe('linhaDePreco — os 12 cenários obrigatórios', () => {
  it('1. tabela 90 com 20% → venda 72, desconto R$ 18', () => {
    const l = linhaDePreco(1, 90, 20);
    expect(l).toMatchObject({ tabela: 90, precoVenda: 72, descontoPct: 20, descontoUnitario: 18, subtotal: 72, desconto: 18 });
  });

  it('2. tabela 90 com 20,5% → venda 71,55, desconto R$ 18,45', () => {
    const l = linhaDePreco(1, 90, 20.5);
    expect(l.precoVenda).toBe(71.55);
    expect(l.descontoUnitario).toBe(18.45);
    expect(l.subtotal).toBe(71.55);
  });

  it('3. tabela 90 e preço de venda 68 → desconto R$ 22, desconto 24,44%', () => {
    const pct = pctDePrecoVenda(90, 68);
    expect(pct).toBe(24.44);
    const l = linhaDePreco(1, 90, pct);
    expect(l.precoVenda).toBe(68);
    expect(l.descontoUnitario).toBe(22);
  });

  it('4. tabela 90 e desconto R$ 15 → venda 75, desconto 16,67%', () => {
    expect(pctDeDescontoUnitario(90, 15)).toBe(16.67);
    expect(precoVendaDeDescontoUnitario(90, 15)).toBe(75);
    const l = linhaDePreco(1, 90, pctDeDescontoUnitario(90, 15));
    expect(l.precoVenda).toBe(75);
    expect(l.descontoUnitario).toBe(15);
  });

  it('5. sem desconto → tabela = venda, desconto 0, subtotal correto', () => {
    const l = linhaDePreco(3, 90, 0);
    expect(l).toMatchObject({ precoVenda: 90, descontoPct: 0, descontoUnitario: 0, subtotal: 270, desconto: 0 });
  });

  it('6. quantidade > 1 → subtotal = preço de venda × quantidade', () => {
    const l = linhaDePreco(2, 80, 20);
    expect(l.precoVenda).toBe(64);
    expect(l.subtotal).toBe(128);
    expect(l.bruto).toBe(160);
    expect(l.desconto).toBe(32);
  });

  it('7. múltiplas linhas com descontos diferentes somam corretamente', () => {
    const r = resumoVenda([linhaDePreco(1, 90, 20), linhaDePreco(1, 90, 0), linhaDePreco(2, 80, 20)], 0, 0);
    expect(r.bruto).toBe(340);
    expect(r.descontoLinhas).toBe(50);
    expect(r.subtotalLiquido).toBe(290);
    expect(r.total).toBe(290);
  });

  it('8. frete → subtotal líquido + frete = total', () => {
    const r = resumoVenda([linhaDePreco(1, 90, 20)], 0, 25);
    expect(r.subtotalLiquido).toBe(72);
    expect(r.total).toBe(97);
  });

  it('9. 20% em quatro linhas → tabela 430, desconto 86, total 344', () => {
    const r = resumoVenda(
      [linhaDePreco(1, 90, 20), linhaDePreco(1, 90, 20), linhaDePreco(1, 90, 20), linhaDePreco(2, 80, 20)],
      0,
      0
    );
    expect(r.bruto).toBe(430);
    expect(r.descontoLinhas).toBe(86);
    expect(r.subtotalLiquido).toBe(344);
    expect(r.total).toBe(344);
    expect(r.descontoPct).toBe(20);
  });

  it('10. alterar o preço de venda várias vezes não acumula erro de arredondamento', () => {
    for (const preco of [89.99, 71.55, 68, 90, 45.5, 12.34, 89.99, 68]) {
      const pct = pctDePrecoVenda(90, preco);
      const l = linhaDePreco(1, 90, pct);
      expect(l.descontoUnitario + l.precoVenda).toBeCloseTo(90, 2);
    }
    expect(precoVendaDe(90, pctDePrecoVenda(90, 68))).toBe(68);
  });

  it('11. alterar o desconto % várias vezes mantém o preço de venda coerente', () => {
    for (const pct of [0, 5, 12.5, 20, 20.5, 33.33, 50, 99.99, 100]) {
      const l = linhaDePreco(1, 90, pct);
      expect(l.precoVenda).toBe(precoVendaDe(90, pct));
      expect(l.descontoUnitario + l.precoVenda).toBeCloseTo(90, 2);
    }
    expect(linhaDePreco(1, 90, 100).precoVenda).toBe(0);
  });

  it('12. valores inválidos/negativos são normalizados para um intervalo seguro', () => {
    expect(normalizarPctVenda(-10)).toBe(0);
    expect(normalizarPctVenda(150)).toBe(100);
    expect(linhaDePreco(1, 90, -5).precoVenda).toBe(90);
    expect(linhaDePreco(1, 90, 120).precoVenda).toBe(0);
    expect(linhaDePreco(1, -50, 20).tabela).toBe(0);
  });
});

describe('bidirecionalidade dos três campos', () => {
  it('desconto % → preço de venda → desconto R$', () => {
    const tabela = 90;
    const pct = 20.5;
    const venda = precoVendaDe(tabela, pct);
    const rs = descontoUnitarioDe(tabela, pct);
    expect(venda).toBe(71.55);
    expect(rs).toBe(18.45);
  });

  it('preço de venda → desconto % → desconto R$', () => {
    const tabela = 90;
    const venda = 68;
    const pct = pctDePrecoVenda(tabela, venda);
    expect(pct).toBe(24.44);
    expect(descontoUnitarioDe(tabela, pct)).toBe(22);
  });

  it('desconto R$ → preço de venda → desconto %', () => {
    const tabela = 90;
    const rs = 15;
    const venda = precoVendaDeDescontoUnitario(tabela, rs);
    const pct = pctDeDescontoUnitario(tabela, rs);
    expect(venda).toBe(75);
    expect(pct).toBe(16.67);
    expect(precoVendaDe(tabela, pct)).toBe(75);
  });
});

describe('resumoVenda', () => {
  it('percentual total é desconto / bruto (não média simples dos percentuais)', () => {
    // 50% de desconto em 100 e 0% em 300 → desconto 50 / bruto 400 = 12,5%.
    const r = resumoVenda([linhaDePreco(1, 100, 50), linhaDePreco(1, 300, 0)], 0, 0);
    expect(r.bruto).toBe(400);
    expect(r.descontoLinhas).toBe(50);
    expect(r.descontoPct).toBe(12.5);
    expect(r.descontoPct).not.toBe(25); // média simples daria 25%
  });

  it('nunca mostra desconto − R$ 0,00 quando há desconto nas linhas', () => {
    const r = resumoVenda([linhaDePreco(1, 90, 20)], 0, 0);
    expect(r.descontoLinhas).toBeGreaterThan(0);
    expect(r.descontoTotal).toBe(18);
  });

  it('desconto comercial do cabeçalho entra no desconto total e no total', () => {
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
