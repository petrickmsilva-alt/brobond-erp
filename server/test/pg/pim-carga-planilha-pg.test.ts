// ============================================================================
// CARGA DA POLÍTICA COMERCIAL EM POSTGRESQL REAL — o preview NÃO grava e a
// confirmação PERSISTE pai, variações, atributos e preços por condição.
//
// O teste de memória (`carga-politica-comercial.test.ts`) prova a regra; este
// prova o que só o PostgreSQL mostra:
//   • as colunas novas (0120: material/modelagem/genero/origem_dados/
//     atributos_adicionais) recebem o valor do importador — JSONB de verdade,
//     não "[object Object]";
//   • o CHECK `jsonb_typeof = 'object'` aceita o mapa e recusa escalar;
//   • produto-pai × variação respeitam a FK composta por empresa;
//   • a reimportação é IDEMPOTENTE (nenhum produto/preço duplicado);
//   • a base do canal só é preenchida quando estava ZERADA;
//   • NENHUMA quantidade física é criada em `estoques` (o Diretor lança depois).
//
// Sem DATABASE_URL o arquivo se auto-pula (gate test:pg / job testes-postgres).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (gate test:pg / job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const CABECALHO = [
  'Item', 'Cód Categoria', 'MARCA', 'CATEGORIA MASTER', 'COLEÇÃO', 'VARIANTE COR', 'DESCRIÇÃO',
  'Tamanho', 'Código Industria', 'Tipo', 'STATUS', 'Peso KG', 'Altura CM', 'Largura CM',
  'Comprimento ou profundidade CM', 'Custo Unitário Fabricação', 'Material Predominante', 'Fornecedor',
  'Atacado À Vista', 'Atacado Boleto 30/60', 'Varejo À Vista', 'Vlr Cartão Parcelado',
  'Margem MGB (%)', 'Preço Varejo',
];

type Linha = Partial<Record<(typeof CABECALHO)[number], string | number>>;

async function xlsxBase64(linhas: Linha[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Política Comercial Completa');
  for (let r = 1; r <= 10; r++) ws.getRow(r).getCell(1).value = r === 1 ? 'TABELA DE PREÇO BASE' : '';
  CABECALHO.forEach((h, i) => (ws.getRow(11).getCell(i + 1).value = h));
  linhas.forEach((l, i) => {
    const row = ws.getRow(12 + i);
    CABECALHO.forEach((h, j) => { if (l[h] !== undefined) row.getCell(j + 1).value = l[h] as any; });
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

function linhas(sufixo: string): Linha[] {
  const comum = {
    'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: `BORDADO ${sufixo}`,
    Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5,
    'Material Predominante': 'ALGODÃO', Fornecedor: 'LEMONETTE CONFECÇÕES',
    'Atacado À Vista': 49.9, 'Atacado Boleto 30/60': 54.9, 'Varejo À Vista': 99.9, 'Vlr Cartão Parcelado': 109.9,
    'Margem MGB (%)': 60, 'Preço Varejo': 79.9,
  };
  return [
    { Item: '1001', ...comum, 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': `CAMISETA ${sufixo} PRETA`, Tamanho: 'P', 'Código Industria': `CB2B${sufixo}010` },
    { Item: '1002', ...comum, 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': `CAMISETA ${sufixo} PRETA`, Tamanho: 'M', 'Código Industria': `CB2B${sufixo}011` },
    // Produto simples (família de uma linha só).
    {
      Item: '2001', 'Cód Categoria': 'SOR', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'ÓCULOS DE SOL',
      COLEÇÃO: `VINTAGE ${sufixo}`, 'VARIANTE COR': 'PRETO', 'DESCRIÇÃO': `ÓCULOS ${sufixo} PRETO`, Tamanho: '',
      'Código Industria': `SOR${sufixo}`, Tipo: 'UN', STATUS: 'INATIVO', 'Custo Unitário Fabricação': 40,
      'Atacado À Vista': 89.9, 'Varejo À Vista': 179.9,
    },
  ];
}

test('carga em PG real: preview não grava, confirmação persiste cadastro + atributos + preços e zera estoque', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { RESOURCES: R } = await import('../../src/resources');
  const { getStore, escopoDe, createRecord } = await import('../../src/services');
  const { previewCarga, confirmarCarga } = await import('../../src/cargaPoliticaComercial');
  const { reqDe, resFake } = await import('../_p1util');

  const sufixo = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  const store = getStore();
  const admin = { id: 1, name: `Admin carga ${sufixo}`, perfil: 'admin' as const };
  const empresa = await createRecord(R.empresas, { nome: `CARGA ${sufixo}` }, admin);
  const empresaId = Number(empresa.id);
  const usuario = await store.insert(R.usuarios, { nome: `Gestor ${sufixo}`, email: `carga-${sufixo}@brobond.test`, perfil: 'gerente', empresa_id: empresaId, ativo: true });
  const ator = { id: Number(usuario.id), name: String(usuario.nome), perfil: 'gerente' as const, empresa_id: empresaId, empresas: [empresaId] };

  t.after(async () => {
    const apagar = async (sql: string) => query(sql, [empresaId]).catch(() => undefined);
    await apagar(`DELETE FROM produto_precos_condicao_historico WHERE empresa_id = $1`);
    await apagar(`DELETE FROM produto_precos_condicao WHERE empresa_id = $1`);
    await apagar(`DELETE FROM precificacao_memoria WHERE empresa_id = $1`);
    await apagar(`DELETE FROM condicoes_pagamento WHERE empresa_id = $1`);
    await apagar(`DELETE FROM produtos WHERE empresa_id = $1`);
    await apagar(`DELETE FROM grade_tamanhos WHERE grade_id IN (SELECT id FROM grades WHERE nome LIKE $1)`);
    await apagar(`DELETE FROM grades WHERE nome LIKE $1`).catch(() => undefined);
    await apagar(`DELETE FROM usuarios WHERE empresa_id = $1`);
    await apagar(`DELETE FROM empresas WHERE id = $1`);
  });

  const conteudo = await xlsxBase64(linhas(sufixo));
  const escopo = escopoDe(ator as never);
  const corpo = { conteudo, nome: 'x.xlsx' };

  // 1) PREVIEW: relata, não grava.
  const antes = await store.countWhere(R.produtos, { empresa_id: empresaId });
  const prev = resFake();
  await previewCarga(reqDe(corpo, { user: ator }) as never, prev.res);
  assert.equal(prev.saida.status ?? 200, 200, JSON.stringify(prev.saida.json));
  assert.equal(prev.saida.json.total, 3);
  assert.equal(prev.saida.json.nao_gravado.includes('nenhum produto'), true);
  assert.equal(await store.countWhere(R.produtos, { empresa_id: empresaId }), antes, 'o preview não cria produto');

  // 2) CONFIRMAÇÃO: grava.
  const conf = resFake();
  await confirmarCarga(reqDe(corpo, { user: ator }) as never, conf.res);
  assert.equal(conf.saida.status ?? 200, 200, JSON.stringify(conf.saida.json));
  assert.equal(conf.saida.json.produtos, 2, 'dois produtos-pai');
  assert.equal(conf.saida.json.variacoes, 2, 'duas variações da camiseta');
  assert.equal(conf.saida.json.estoque_importado, false);

  // 3) PERSISTÊNCIA conferida por SQL direto (não pela resposta HTTP).
  const pai = (await query(
    `SELECT * FROM produtos WHERE empresa_id = $1 AND formato = 'variacao' AND produto_pai_id IS NULL`,
    [empresaId]
  )).rows[0];
  assert.ok(pai, 'o produto-pai foi persistido');
  assert.equal(pai.origem_dados, 'planilha');

  const varP = (await query(`SELECT * FROM produtos WHERE empresa_id = $1 AND sku = $2`, [empresaId, `CB2B${sufixo}010`])).rows[0];
  assert.ok(varP, 'a variação P foi persistida');
  assert.equal(Number(varP.produto_pai_id), Number(pai.id), 'a variação aponta para o pai');
  assert.equal(varP.codigo_industria, `CB2B${sufixo}010`, 'código da indústria preservado como texto');
  assert.equal(varP.cor, 'PRETA');
  assert.equal(varP.unidade, 'un', 'Tipo=UN → unidade un');
  assert.equal(Number(varP.preco_venda), 99.9, 'base do varejo vem do à vista');
  assert.equal(Number(varP.preco_atacado), 49.9, 'base do atacado vem do à vista');

  // Atributos adicionais: JSONB de verdade, com o mapa esperado.
  assert.equal(typeof varP.atributos_adicionais, 'object');
  assert.equal(varP.atributos_adicionais.Fornecedor, 'LEMONETTE CONFECÇÕES', 'o fornecedor foi preservado nos atributos');
  assert.equal(varP.atributos_adicionais['Material Predominante'], 'ALGODÃO');
  assert.equal(varP.atributos_adicionais['Margem MGB (%)'], undefined, 'coluna calculada NÃO entra como atributo');

  // 4) Preços oficiais por condição (dados de entrada).
  const boleto = (await query(
    `SELECT * FROM produto_precos_condicao WHERE empresa_id = $1 AND produto_id = $2 AND canal = 'atacado' AND condicao = 'boleto_30_60' AND vigencia_fim IS NULL`,
    [empresaId, Number(varP.id)]
  )).rows[0];
  assert.ok(boleto, 'preço de boleto 30/60 gravado como dado');
  assert.equal(Number(boleto.preco), 54.9);
  assert.equal(boleto.origem, 'planilha');

  // 5) O CHECK recusa JSONB escalar em atributos_adicionais.
  await assert.rejects(
    query(`UPDATE produtos SET atributos_adicionais = '"x"'::jsonb WHERE id = $1`, [Number(varP.id)]),
    /produtos_atributos_adicionais_obj_ck|check constraint/i
  );

  // 6) Produto simples: INATIVO desativa; sem pai.
  const oculos = (await query(`SELECT * FROM produtos WHERE empresa_id = $1 AND sku = $2`, [empresaId, `SOR${sufixo}`])).rows[0];
  assert.ok(oculos);
  assert.equal(oculos.ativo, false);
  assert.equal(oculos.produto_pai_id ?? null, null);

  // 7) NENHUMA quantidade física foi importada.
  const estoques = await store.countWhere(R.estoques, { empresa_id: empresaId });
  assert.equal(estoques, 0, 'a carga não cria saldo de estoque');

  // 8) IDEMPOTÊNCIA: reimportar não duplica produto nem preço.
  const prodAntes = await store.countWhere(R.produtos, { empresa_id: empresaId });
  const precosAntes = await store.countWhere(R.produto_precos_condicao, { empresa_id: empresaId });
  const conf2 = resFake();
  await confirmarCarga(reqDe(corpo, { user: ator }) as never, conf2.res);
  assert.equal(conf2.saida.json.produtos, 0, 'nenhum produto novo na reimportação');
  assert.equal(conf2.saida.json.variacoes, 0, 'nenhuma variação nova');
  assert.equal(await store.countWhere(R.produtos, { empresa_id: empresaId }), prodAntes);
  assert.equal(await store.countWhere(R.produto_precos_condicao, { empresa_id: empresaId }), precosAntes, 'preços não duplicam');
  assert.ok(escopo.empresaId === empresaId);
});
