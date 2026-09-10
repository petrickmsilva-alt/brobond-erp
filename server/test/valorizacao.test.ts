// Valorização do estoque em três bases (custo de produção × atacado × varejo)
// nos três níveis (unidade, coleção, todas as peças) — o que o Dashboard mostra
// no lugar do antigo "Valor do estoque (a custo)". Modo memória.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { valorizarEstoque } = await import('../src/valorizacao');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

test('valorizarEstoque: unidade × coleção × total nas três bases; sem atacado vale o varejo', () => {
  const v = valorizarEstoque([
    // 10 peças: custo 40, atacado 70, varejo 100
    { id: 1, produto: 'A', colecao: 'Verão', pecas: 10, custo: 40, preco_venda: 100, preco_atacado: 70 },
    // 5 peças SEM preço de atacado → atacado = varejo (regra do catálogo/portal)
    { id: 2, produto: 'B', colecao: 'Verão', pecas: 5, custo: '20.5', preco_venda: 50, preco_atacado: 0 },
    // sem coleção
    { id: 3, produto: 'C', colecao: null, pecas: 2, custo: 10, preco_venda: 30, preco_atacado: 25 },
    // sem saldo: não entra em nada
    { id: 4, produto: 'D', colecao: 'Inverno', pecas: 0, custo: 999, preco_venda: 999, preco_atacado: 999 },
  ]);

  // Total de todas as peças
  assert.equal(v.pecas, 17);
  assert.equal(v.custo, 400 + 102.5 + 20); // 522.5
  assert.equal(v.atacado, 700 + 250 + 50); // 1000
  assert.equal(v.varejo, 1000 + 250 + 60); // 1310
  assert.equal(v.produtosComSaldo, 3);
  assert.equal(v.semPrecoAtacado, 1);

  // Por coleção (maior custo primeiro; "Sem coleção" por último; Inverno não aparece)
  assert.deepEqual(
    v.colecoes.map((c) => c.colecao),
    ['Verão', 'Sem coleção']
  );
  const verao = v.colecoes[0];
  assert.equal(verao.pecas, 15);
  assert.equal(verao.custo, 502.5);
  assert.equal(verao.atacado, 950);
  assert.equal(verao.varejo, 1250);

  // Por unidade (produto)
  const a = v.produtos.find((p) => p.id === 1)!;
  assert.deepEqual([a.custo_unit, a.atacado_unit, a.varejo_unit, a.atacado_definido], [40, 70, 100, true]);
  assert.deepEqual([a.custo, a.atacado, a.varejo], [400, 700, 1000]);
  const b = v.produtos.find((p) => p.id === 2)!;
  assert.equal(b.atacado_unit, 50);
  assert.equal(b.atacado_definido, false);
  assert.equal(v.produtos.some((p) => p.id === 4), false);
});

test('valorizarEstoque: soma em centavos (sem deriva de ponto flutuante) e respeita o limite de produtos', () => {
  const linhas = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, produto: `P${i}`, colecao: null, pecas: 1, custo: 0.1, preco_venda: 0.2, preco_atacado: 0.1 }));
  const v = valorizarEstoque(linhas, 5);
  assert.equal(v.custo, 3);
  assert.equal(v.varejo, 6);
  assert.equal(v.produtosComSaldo, 30);
  assert.equal(v.produtos.length, 5);
});

before(() => {
  getStore();
});

test('dashboard: valorização reflete os saldos reais somando tamanhos e locais', async () => {
  const col = await createRecord(RESOURCES.colecoes, { nome: 'Coleção Valorização', temporada: 'Verão', ano: 2026 }, admin);
  const p = await createRecord(RESOURCES.produtos, { sku: 'VAL-001', nome: 'Camisa Valorizada', custo: 30, preco_venda: 90, preco_atacado: 60, colecao_id: Number(col.id) }, admin);
  const pid = Number(p.id);
  // 4 peças no M (loja) + 6 peças no G (expedição) = 10 peças
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: pid, tamanho_id: 3, local: 'loja', quantidade: 4 }, admin);
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: pid, tamanho_id: 4, local: 'expedicao', quantidade: 6 }, admin);

  const d = await getStore().dashboard();
  const linha = d.valorizacao.produtos.find((x) => x.id === pid);
  assert.ok(linha, 'produto com saldo deve aparecer na valorização por unidade');
  assert.equal(linha.pecas, 10);
  assert.equal(linha.colecao, 'Coleção Valorização');
  assert.deepEqual([linha.custo, linha.atacado, linha.varejo], [300, 600, 900]);

  const c = d.valorizacao.colecoes.find((x) => x.colecao === 'Coleção Valorização');
  assert.ok(c);
  assert.deepEqual([c.pecas, c.custo, c.atacado, c.varejo], [10, 300, 600, 900]);

  // O total geral continua batendo com o KPI legado (valor a custo) e com as peças.
  assert.equal(d.valorizacao.custo, d.valorEstoque);
  assert.equal(d.valorizacao.pecas, d.pecasEstoque);
  assert.ok(d.valorizacao.varejo >= d.valorizacao.atacado);
  assert.ok(d.valorizacao.atacado >= d.valorizacao.custo);
});
