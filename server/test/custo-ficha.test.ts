// ============================================================================
// CÁLCULO DE CUSTO DA FICHA TÉCNICA — GAP-PROD-CUSTO-SEM-TESTE
//
// `recalcularFichaValores` e `aplicarPrecoFicha` eram os dois cálculos de dinheiro
// do módulo de Produção sem nenhuma cobertura: `grep -rln "aplicarPrecoFicha\|
// recalcularFichaValores" server/test/` devolvia zero arquivos. São justamente
// os que definem o custo do produto e, por tabela, o preço de venda.
//
// Fórmula que estes testes travam:
//   insumos = Σ consumo × (1 + perda% / 100) × custo_médio
//   custo   = insumos + mão de obra + custos indiretos
//   preço   = custo × (1 + margem% / 100)
//
// E a regra de `aplicarPrecoFicha`: ele escreve custo E preço sugerido no
// produto, e não inventa nada quando a ficha não tem produto vinculado.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, escopoDe } = await import('../src/services');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoProduto, reqDe } = await import('./_p1util');
const producao = await import('../src/producao');

await garantirAdmin();
const ADMIN = await criarAtor(1, 'admin');
const OPERADOR = await criarAtor(1, 'operador');
const s = () => getStore();

async function fichaCom(itens: { consumo: number; perda: number; custo: number }[], opts: { maoObra?: number; indiretos?: number; margem?: number; produtoId?: number | null } = {}) {
  const produto = opts.produtoId === null ? null : await novoProduto();
  const ficha = await s().insert(RESOURCES.fichas, {
    produto_id: opts.produtoId === null ? null : Number(produto!.id),
    mao_obra: opts.maoObra ?? 0,
    custos_indiretos: opts.indiretos ?? 0,
    margem_pct: opts.margem ?? 0,
    empresa_id: 1,
  });
  for (const it of itens) {
    const insumo = await s().insert(RESOURCES.insumos, { nome: `Insumo ${Math.random().toString(36).slice(2, 9)}`, unidade: 'm', custo_medio: it.custo, ativo: true, empresa_id: 1 });
    await s().insert(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: it.consumo, perda_pct: it.perda, empresa_id: 1 });
  }
  const recalculada = (await producao.recalcularFichaValores(Number(ficha.id), undefined, escopoDe(ADMIN)))!;
  return { ficha: recalculada, produto };
}

test('custo: insumos + mão de obra + indiretos, com a perda multiplicando o consumo', async () => {
  // 2 m × (1 + 10%) × R$10 = 22; + mão de obra 5 + indiretos 3 = R$30
  const { ficha } = await fichaCom([{ consumo: 2, perda: 10, custo: 10 }], { maoObra: 5, indiretos: 3 });
  assert.equal(Number(ficha.custo_calculado), 30);
});

test('custo: vários insumos somam e a perda é por linha, não global', async () => {
  // linha 1: 2 × 1,10 × 10 = 22 | linha 2: 0,5 × 1,00 × 4 = 2  → 24 + 6 (mão de obra) = 30
  const { ficha } = await fichaCom(
    [
      { consumo: 2, perda: 10, custo: 10 },
      { consumo: 0.5, perda: 0, custo: 4 },
    ],
    { maoObra: 6 }
  );
  assert.equal(Number(ficha.custo_calculado), 30);
});

test('custo: margem gera o preço sugerido sobre o custo cheio', async () => {
  // custo 30 × (1 + 100%) = R$60
  const { ficha } = await fichaCom([{ consumo: 2, perda: 10, custo: 10 }], { maoObra: 5, indiretos: 3, margem: 100 });
  assert.equal(Number(ficha.custo_calculado), 30);
  assert.equal(Number(ficha.preco_sugerido), 60);
});

test('custo: margem zero deixa preço igual ao custo e insumo sem custo médio entra como zero', async () => {
  const { ficha } = await fichaCom([{ consumo: 5, perda: 20, custo: 0 }], { maoObra: 12, margem: 0 });
  assert.equal(Number(ficha.custo_calculado), 12, 'só a mão de obra conta quando o insumo não tem custo');
  assert.equal(Number(ficha.preco_sugerido), 12);
});

test('custo: ficha sem insumos custa só mão de obra + indiretos', async () => {
  const { ficha } = await fichaCom([], { maoObra: 8, indiretos: 2 });
  assert.equal(Number(ficha.custo_calculado), 10);
});

test('custo: recalcular depois de mudar o consumo reflete o novo valor', async () => {
  const { ficha } = await fichaCom([{ consumo: 1, perda: 0, custo: 10 }]);
  assert.equal(Number(ficha.custo_calculado), 10);
  const itens = await s().list(RESOURCES.itens_ficha_tecnica, { page: 1, pageSize: 10, filter: { ficha_id: Number(ficha.id) } });
  await s().update(RESOURCES.itens_ficha_tecnica, Number(itens.rows[0].id), { consumo: 3 });
  const deNovo = (await producao.recalcularFichaValores(Number(ficha.id), undefined, escopoDe(ADMIN)))!;
  assert.equal(Number(deNovo.custo_calculado), 30);
  assert.ok(deNovo.calculado_em, 'calculado_em é gravado');
});

test('custo: recalcular ficha inexistente devolve null em vez de estourar', async () => {
  assert.equal(await producao.recalcularFichaValores(999999, undefined, escopoDe(ADMIN)), null);
});

// ---------------------------------------------------------------------------
// aplicarPrecoFicha — escreve no produto
// ---------------------------------------------------------------------------

test('aplicar preço: copia custo e preço sugerido da ficha para o produto', async () => {
  const { ficha, produto } = await fichaCom([{ consumo: 2, perda: 10, custo: 10 }], { maoObra: 5, indiretos: 3, margem: 100 });
  const out = await chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: ficha.id }, user: ADMIN }));
  assert.equal(Number(out.custo), 30);
  assert.equal(Number(out.preco_venda), 60);
  assert.equal(Number(out.produto_id), Number(produto!.id));

  const depois = await s().get(RESOURCES.produtos, Number(produto!.id));
  assert.equal(Number(depois!.custo), 30, 'o custo do produto veio da ficha');
  assert.equal(Number(depois!.preco_venda), 60, 'o preço de venda veio do preço sugerido');
});

test('aplicar preço: regravar depois de mudar a ficha atualiza o produto de novo', async () => {
  const { ficha, produto } = await fichaCom([{ consumo: 1, perda: 0, custo: 10 }], { margem: 0 });
  await chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: ficha.id }, user: ADMIN }));
  assert.equal(Number((await s().get(RESOURCES.produtos, Number(produto!.id)))!.custo), 10);

  await s().update(RESOURCES.fichas, Number(ficha.id), { mao_obra: 15 });
  await producao.recalcularFichaValores(Number(ficha.id), undefined, escopoDe(ADMIN));
  await chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: ficha.id }, user: ADMIN }));
  assert.equal(Number((await s().get(RESOURCES.produtos, Number(produto!.id)))!.custo), 25);
});

test('aplicar preço: operador não aplica (mexe no preço de venda)', async () => {
  const { ficha } = await fichaCom([{ consumo: 1, perda: 0, custo: 10 }]);
  await esperarErro(() => chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: ficha.id }, user: OPERADOR })), 403);
});

test('aplicar preço: ficha sem produto é recusada com 400, não aplicada em lugar nenhum', async () => {
  const { ficha } = await fichaCom([{ consumo: 1, perda: 0, custo: 10 }], { produtoId: null });
  await esperarErro(() => chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: ficha.id }, user: ADMIN })), 400, /não está vinculada a um produto/);
});

test('aplicar preço: ficha inexistente é 404', async () => {
  await esperarErro(() => chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: 999999 }, user: ADMIN })), 404);
});

test('aplicar preço: fica auditado com os dois valores', async () => {
  const { ficha, produto } = await fichaCom([{ consumo: 2, perda: 10, custo: 10 }], { maoObra: 5, indiretos: 3, margem: 100 });
  await chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: ficha.id }, user: ADMIN }));
  const audit = await s().list(RESOURCES.auditoria, { page: 1, pageSize: 50, filter: { recurso: 'produtos', registro_id: Number(produto!.id) } });
  const linha = audit.rows.find((a) => /da ficha/.test(String(a.descricao)));
  assert.ok(linha, 'a aplicação do preço não foi auditada');
  // `dados` é gravado mas memdb.decorate() o apaga em toda leitura da API
  // (regra geral de segredo), então a conferência é na descrição — que é o que
  // o auditor lê na tela.
  assert.match(String(linha!.descricao), /custo R\$ 30/);
  assert.match(String(linha!.descricao), /preço sugerido R\$ 60/);
  assert.equal(linha!.acao, 'editar');
});
