// Testes das promoções ESCOPADAS (migração 0108) — regra pura, sem banco.
// Cobre: escopo produto/categoria, elegibilidade por canal, precedência
// determinística e o teto do desconto (nunca acima da base elegível).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const {
  avaliarPromocao,
  baseElegivel,
  canalElegivel,
  melhorPromocaoEscopada,
  melhorDesconto,
} = await import('../src/commerce/regras');
type PromocaoEscopada = import('../src/commerce/regras').PromocaoEscopada;

function promo(over: Partial<PromocaoEscopada> = {}): PromocaoEscopada {
  return {
    id: 1,
    nome: 'P',
    tipo: 'percentual',
    valor: 10,
    minimoPedido: 0,
    escopo: 'pedido',
    canal: 'todos',
    prioridade: 0,
    alvosProduto: [],
    alvosCategoria: [],
    ...over,
  };
}

const itens = [
  { subtotal: 100, produtoId: 1, categoriaId: 10 },
  { subtotal: 50, produtoId: 2, categoriaId: 20 },
];

test('0108: promoção de pedido desconta o subtotal inteiro (compatível com o legado)', () => {
  const av = avaliarPromocao(promo({ valor: 10 }), itens, 150);
  assert.equal(av?.desconto, 15);
  assert.equal(av?.base, 150);
});

test('0108: escopo produto desconta só o subtotal elegível, nunca o pedido inteiro', () => {
  const av = avaliarPromocao(promo({ escopo: 'produto', alvosProduto: [1], valor: 10 }), itens, 150);
  assert.equal(av?.base, 100, 'base = apenas o item 1');
  assert.equal(av?.desconto, 10);
});

test('0108: escopo categoria desconta só as linhas da categoria alvo', () => {
  const av = avaliarPromocao(promo({ escopo: 'categoria', alvosCategoria: [20], tipo: 'valor', valor: 30 }), itens, 150);
  assert.equal(av?.base, 50);
  assert.equal(av?.desconto, 30);
});

test('0108: valor fixo nunca ultrapassa a base elegível (sem preço negativo)', () => {
  const av = avaliarPromocao(promo({ escopo: 'categoria', alvosCategoria: [20], tipo: 'valor', valor: 999 }), itens, 150);
  assert.equal(av?.desconto, 50, 'desconto limitado à base de 50');
});

test('0108: produto fora dos alvos não gera desconto (candidata nula)', () => {
  assert.equal(avaliarPromocao(promo({ escopo: 'produto', alvosProduto: [99] }), itens, 150), null);
});

test('0108: elegibilidade por canal — varejo não vale no atacado e vice-versa', () => {
  assert.equal(canalElegivel(promo({ canal: 'todos' }), 'atacado'), true);
  assert.equal(canalElegivel(promo({ canal: 'varejo' }), 'varejo'), true);
  assert.equal(canalElegivel(promo({ canal: 'varejo' }), 'atacado'), false);
  assert.equal(avaliarPromocao(promo({ canal: 'varejo' }), itens, 150, 'atacado'), null);
  assert.equal(avaliarPromocao(promo({ canal: 'varejo' }), itens, 150, 'varejo')?.desconto, 15);
});

test('0108: mínimo do pedido é conferido sobre o subtotal, não sobre a base elegível', () => {
  const p = promo({ escopo: 'produto', alvosProduto: [2], valor: 10, minimoPedido: 120 });
  assert.equal(avaliarPromocao(p, itens, 150)?.desconto, 5, 'mín 120 ≤ 150 → aplica sobre a base 50');
  assert.equal(avaliarPromocao(p, itens, 100), null, 'mín 120 > 100 → não aplica');
});

test('0108: precedência — maior desconto vence', () => {
  const lista = [promo({ id: 1, valor: 5 }), promo({ id: 2, valor: 20 })];
  const { melhor } = melhorPromocaoEscopada(lista, itens, 150);
  assert.equal(melhor?.id, 2);
});

test('0108: precedência — empate de desconto desempata pela MAIOR prioridade', () => {
  const lista = [promo({ id: 1, valor: 10, prioridade: 0 }), promo({ id: 2, valor: 10, prioridade: 5 })];
  const { melhor } = melhorPromocaoEscopada(lista, itens, 150);
  assert.equal(melhor?.id, 2);
});

test('0108: precedência — empate de desconto e prioridade desempata pela mais recente (maior id)', () => {
  const lista = [promo({ id: 1, valor: 10, prioridade: 0 }), promo({ id: 9, valor: 10, prioridade: 0 })];
  const { melhor } = melhorPromocaoEscopada(lista, itens, 150);
  assert.equal(melhor?.id, 9);
});

test('0108: a lista de candidatas sai ordenada (auditoria/simulador)', () => {
  const lista = [promo({ id: 1, valor: 5 }), promo({ id: 2, valor: 20 }), promo({ id: 3, valor: 10 })];
  const { avaliacoes } = melhorPromocaoEscopada(lista, itens, 150);
  assert.deepEqual(avaliacoes.map((a) => a.id), [2, 3, 1]);
});

test('0108: baseElegivel de escopo pedido é o próprio subtotal', () => {
  assert.equal(baseElegivel(promo({ escopo: 'pedido' }), itens, 150), 150);
});

test('0108: cupom maior que a promoção vence; promoção maior que o cupom vence', () => {
  const promo1 = { tipo: 'percentual' as const, valor: 10 };
  const cupom10 = { tipo: 'percentual' as const, valor: 10 };
  const cupom30 = { tipo: 'percentual' as const, valor: 30 };
  assert.equal(melhorDesconto(100, { promocao: promo1, cupom: cupom10 }).origem, 'promocao', 'empate → promoção');
  assert.equal(melhorDesconto(100, { promocao: promo1, cupom: cupom30 }).origem, 'cupom');
  assert.equal(melhorDesconto(100, { promocao: promo1, cupom: cupom30 }).desconto, 30);
});
