// SMART PRODUCT SEARCH — prova no PostgreSQL real (job testes-postgres do CI).
// Sem DATABASE_URL este arquivo se auto-pula; ele nunca usa banco de produção.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';
const sufixo = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

type Ator = { id: number; name: string; perfil: 'gerente'; empresa_id: number; empresas: number[] };

test('Smart Product Search: ranking, atributos, variantes, estoque e tenant A/B no PostgreSQL', { skip }, async (t) => {
  const { migrate } = await import('../../src/db');
  await migrate();
  const { RESOURCES: R } = await import('../../src/resources');
  const { createRecord, escopoDe, getStore } = await import('../../src/services');
  const { searchProducts } = await import('../../src/productSearch');

  const admin = { id: 1, name: 'Admin Search PG', perfil: 'admin' as const };
  const empA = await createRecord(R.empresas, { nome: `SEARCH PG A ${sufixo}` }, admin);
  const empB = await createRecord(R.empresas, { nome: `SEARCH PG B ${sufixo}` }, admin);
  const aId = Number(empA.id);
  const bId = Number(empB.id);
  const atorA: Ator = { id: 0, name: 'Ator A', perfil: 'gerente', empresa_id: aId, empresas: [aId] };
  const atorB: Ator = { id: 0, name: 'Ator B', perfil: 'gerente', empresa_id: bId, empresas: [bId] };
  const escopoA = escopoDe(atorA as any);
  const escopoB = escopoDe(atorB as any);

  const categoria = await createRecord(R.categorias, { nome: `Categoria ${sufixo}`, ativo: true }, admin);
  const cor = await createRecord(R.cores, { nome: `Vermelha ${sufixo}`, hex: '#FF0000', ativo: true }, admin);
  const tamG = await createRecord(R.tamanhos, { codigo: `G-${sufixo}`.slice(0, 10), nome: 'G', ordem: 1, ativo: true }, admin);
  const tamGG = await createRecord(R.tamanhos, { codigo: `GG-${sufixo}`.slice(0, 10), nome: 'GG', ordem: 2, ativo: true }, admin);
  const grade = await createRecord(R.grades, { nome: `Grade ${sufixo}`, tamanhos: [Number(tamG.id), Number(tamGG.id)], ativo: true }, admin);
  const colecao = await createRecord(R.colecoes, { nome: `Coleção ${sufixo}`, temporada: 'Verão', ano: 2026 }, atorA as any);
  const fornecedor = await createRecord(R.fornecedores, { nome: `Fornecedor ${sufixo}`, ativo: true }, atorA as any);
  const localA = await createRecord(R.locais, { nome: `loja-${sufixo}`, tipo: 'loja', padrao: true, ativo: true }, atorA as any);
  const localB = await createRecord(R.locais, { nome: `loja-${sufixo}`, tipo: 'loja', padrao: true, ativo: true }, atorB as any);

  const skuPai = `CAM-${sufixo}`;
  const pai = await createRecord(R.produtos, {
    sku: skuPai,
    nome: `Camiseta Premium ${sufixo}`,
    descricao: 'Malha de algodão penteado para busca PostgreSQL',
    categoria_id: Number(categoria.id),
    colecao_id: Number(colecao.id),
    fornecedor_id: Number(fornecedor.id),
    grade_id: Number(grade.id),
    marca: 'BroBond Search PG',
    localizacao: 'Corredor PG',
    ncm: '6205.20.00',
    formato: 'variacao',
    preco_venda: 90,
    ativo: true,
  }, atorA as any);

  async function variante(sufixoVar: string, tamanhoId: number, barcode: string) {
    const criada = await createRecord(R.produtos, {
      sku: `${skuPai}-${sufixoVar}`,
      nome: `Camiseta Premium ${sufixo} Vermelha`,
      produto_pai_id: Number(pai.id),
      variacao_chave: `COR:VERMELHA|TAM:${tamanhoId}`,
      variacao_tamanho_id: tamanhoId,
      categoria_id: Number(categoria.id),
      cor_id: Number(cor.id),
      formato: 'variacao',
      codigo_barras: barcode,
      preco_venda: 95,
      ativo: true,
    }, atorA as any);
    // produto_pai_id/variacao_tamanho_id são readonly na API pública; o
    // gerador de variações também os grava pelo store, não pelo CRUD externo.
    return (await getStore().update(R.produtos, Number(criada.id), {
      produto_pai_id: Number(pai.id),
      variacao_chave: `COR:VERMELHA|TAM:${tamanhoId}`,
      variacao_tamanho_id: tamanhoId,
    }))!;
  }

  const filhoG = await variante('G', Number(tamG.id), '7895550001112');
  await variante('GG', Number(tamGG.id), '7895550002229');
  const store = getStore();
  await store.adjustStock(Number(pai.id), Number(tamG.id), String(localA.nome), 5, undefined, Number(localA.id), aId);
  await store.adjustStock(Number(pai.id), Number(tamGG.id), String(localA.nome), 7, undefined, Number(localA.id), aId);
  const semEstoque = await createRecord(R.produtos, { sku: `ZERO-${sufixo}`, nome: `Sem estoque ${sufixo}`, preco_venda: 10, ativo: true }, atorA as any);

  const outro = await createRecord(R.produtos, {
    sku: skuPai,
    nome: `Camiseta Premium ${sufixo}`,
    codigo_barras: '7895550009999',
    preco_venda: 20,
    ativo: true,
  }, atorB as any);
  await store.adjustStock(Number(outro.id), null, String(localB.nome), 99, undefined, Number(localB.id), bId);

  await t.test('múltiplos termos e atributos executam no banco', async () => {
    for (const q of ['camiseta vermelha', 'algodão penteado', `Fornecedor ${sufixo}`, `Coleção ${sufixo}`, `Grade ${sufixo}`, 'Corredor PG', '6205.20.00', '555000111']) {
      const resultado = await searchProducts(escopoA, { q, pageSize: 50 });
      assert.ok(resultado.rows.some((row) => row.id === Number(pai.id)), `${q} deveria encontrar o pai no PostgreSQL`);
    }
    const vazio = await searchProducts(escopoA, { q: "' OR 1=1; DROP TABLE produtos; --" });
    assert.equal(vazio.total, 0);
  });

  await t.test('variações mostram o saldo canônico do pai por tamanho', async () => {
    const resultado = await searchProducts(escopoA, { q: 'camiseta vermelha', localId: Number(localA.id) });
    const encontrado = resultado.rows.find((row) => row.id === Number(pai.id))!;
    assert.equal(encontrado.estoque_disponivel, 12);
    assert.equal(encontrado.variacoes.length, 2);
    assert.deepEqual(encontrado.variacoes.map((row) => row.estoque_disponivel).sort((a, b) => a - b), [5, 7]);
    const porId = await searchProducts(escopoA, { id: Number(filhoG.id), q: '' });
    assert.deepEqual(porId.rows.map((row) => row.id), [Number(filhoG.id)]);
  });

  await t.test('onlyInStock e tenant A/B valem no SQL, inclusive com mesmo SKU', async () => {
    const comSaldo = await searchProducts(escopoA, { q: sufixo, onlyInStock: true, pageSize: 50 });
    assert.ok(comSaldo.rows.some((row) => row.id === Number(pai.id)));
    assert.ok(!comSaldo.rows.some((row) => row.id === Number(semEstoque.id)));
    assert.ok(comSaldo.rows.every((row) => row.id !== Number(outro.id)));

    const doB = await searchProducts(escopoB, { q: sufixo, pageSize: 50 });
    assert.deepEqual(doB.rows.map((row) => row.id), [Number(outro.id)]);
    assert.equal(doB.rows[0].estoque_disponivel, 99);
    const idDeBemA = await searchProducts(escopoA, { id: Number(outro.id), q: '' });
    assert.equal(idDeBemA.total, 0);
  });

  await t.test('barcode exato tem prioridade sobre prefixo de SKU', async () => {
    const exato = await createRecord(R.produtos, { sku: `RANK-Z-${sufixo}`, nome: `Ranking ${sufixo}`, codigo_barras: '123456789012', preco_venda: 10, ativo: true }, atorA as any);
    await createRecord(R.produtos, { sku: `123456789012-X-${sufixo}`, nome: `Prefixo ${sufixo}`, preco_venda: 10, ativo: true }, atorA as any);
    const resultado = await searchProducts(escopoA, { q: '123456789012' });
    assert.equal(resultado.rows[0].id, Number(exato.id));
  });
});
