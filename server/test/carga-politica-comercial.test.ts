// ============================================================================
// CARGA DA POLÍTICA COMERCIAL — planilha-base como FONTE DE CADASTRO.
//
// O que precisa ser verdade (adendo operacional):
//   • só a aba "Política Comercial Completa" é lida, com cabeçalho na linha 11;
//   • prévia NÃO grava nada;
//   • a confirmação cria o produto-pai e as variações (cor × tamanho);
//   • reimportar o mesmo arquivo NÃO duplica produto nem variação;
//   • NENHUMA quantidade física/estoque é importada;
//   • NENHUM preço/margem da planilha sobrescreve a regra do ERP;
//   • identificadores preservados como texto (zeros à esquerda intactos);
//   • códigos de barras concatenados NÃO entram como código de barras.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

process.env.NODE_ENV = 'test';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { previewCarga, confirmarCarga, classificarColuna, normalizarItem, descricaoBase, descricaoSemTamanho, descricaoSemCor, parseCodigoRoupas, skuPaiDe, sanitizarXlsx, extrairPrecosOficiais, hashChave } = await import(
  '../src/cargaPoliticaComercial'
);

const ADMIN = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };

function app(user: any = ADMIN) {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req: any, _res: any, next: any) => {
    req.user = user;
    next();
  });
  const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next);
  a.post('/api/carga/politica-comercial/preview', wrap(previewCarga));
  a.post('/api/carga/politica-comercial/confirmar', wrap(confirmarCarga));
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message, details: err.details }));
  return a;
}

// ---------------------------------------------------------------------------
// Planilha sintética no LEIAUTE da origem.
// ---------------------------------------------------------------------------
const CABECALHO = [
  'Item', 'Cód Categoria', 'MARCA', 'CATEGORIA MASTER', 'COLEÇÃO', 'VARIANTE COR', 'DESCRIÇÃO',
  'Tamanho', 'Código Industria', 'Tipo', 'STATUS', 'Peso KG', 'Altura CM', 'Largura CM',
  'Comprimento ou profundidade CM', 'Custo Unitário Fabricação',
  // Preços OFICIAIS (dados de ENTRADA) — importados como preço por condição.
  'Atacado À Vista', 'Atacado Boleto 30/60', 'Varejo À Vista', 'Vlr Cartão Parcelado',
  // Colunas CALCULADAS — devem ser classificadas como conferência e ignoradas.
  'Margem MGB (%)', 'Preço Varejo', 'Preço Atacado',
];

type Linha = Partial<Record<(typeof CABECALHO)[number], string | number>>;

/** Escreve uma aba genérica: cabeçalho na linha `cab` e dados a partir de `cab+1`. */
function abaGenerica(wb: ExcelJS.Workbook, nome: string, cabecalho: string[], linhas: Record<string, string | number>[], cab = 1) {
  const ws = wb.addWorksheet(nome);
  cabecalho.forEach((h, i) => (ws.getRow(cab).getCell(i + 1).value = h));
  linhas.forEach((l, i) => {
    const row = ws.getRow(cab + 1 + i);
    cabecalho.forEach((h, j) => { if (l[h] !== undefined) row.getCell(j + 1).value = l[h] as any; });
  });
  return ws;
}

/** Monta o XLSX no leiaute da origem e devolve base64. */
async function xlsxBase64(
  linhas: Linha[],
  barras: { codigo: string; industria: string }[] = [],
  extras: { controle?: Record<string, string | number>[]; roupas?: Record<string, string | number>[]; movimentacao?: boolean } = {}
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Política Comercial Completa');
  for (let r = 1; r <= 10; r++) ws.getRow(r).getCell(1).value = r === 1 ? 'TABELA DE PREÇO BASE' : '';
  CABECALHO.forEach((h, i) => (ws.getRow(11).getCell(i + 1).value = h));
  linhas.forEach((l, i) => {
    const row = ws.getRow(12 + i);
    CABECALHO.forEach((h, j) => {
      if (l[h] !== undefined) row.getCell(j + 1).value = l[h] as any;
    });
  });
  const wsB = wb.addWorksheet('Código de Barras');
  wsB.getRow(1).getCell(1).value = 'Código Industria';
  wsB.getRow(1).getCell(2).value = 'Código Barra';
  barras.forEach((b, i) => {
    wsB.getRow(2 + i).getCell(1).value = b.industria;
    wsB.getRow(2 + i).getCell(2).value = b.codigo;
  });
  if (extras.controle) {
    abaGenerica(wb, 'BASE CONTROLE DE ESTOQUE',
      ['Item', 'COLEÇÃO', 'CATEGORIA', 'SUBCATEGORIA', 'Descrição do produto/serviço2', 'Tamanho', 'Código Industria', 'Tipo', 'Fornecedor', 'Valor unitário Custo', 'ATACADO À Vista Min. 10 Pças', 'VRJ À VISTA'],
      extras.controle, 11);
  }
  if (extras.roupas) {
    abaGenerica(wb, 'Política Comercial Roupas (2)',
      ['Item', 'Categoria', 'Descrição do produto/serviço2', 'Código Industria', 'Tipo', 'Fornecedor', 'Qtd. Estoque', 'Valor unitário Custo', 'Preço à Vista  10% Desc.', 'Preço de Venda Cartão'],
      extras.roupas, 4);
  }
  if (extras.movimentacao) {
    // Aba de MOVIMENTAÇÃO: tem código de indústria e quantidade, mas NÃO é cadastro.
    abaGenerica(wb, 'ENTRADA MERCADORIA',
      ['Codigo Cadastro', 'COLEÇÃO', 'CATEGORIA', 'SUBCATEGORIA', 'Código Internto Industria', 'Descrição', 'Nº', 'Entrada Estque'],
      [{ 'Codigo Cadastro': '15101', 'Código Internto Industria': 'SOR15101', Descrição: 'CAMISETA', 'Entrada Estque': 999 }], 7);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

const LINHAS_BASE: Linha[] = [
  { Item: '1001', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': 'CAMISETA BORDADO B PRETA', Tamanho: 'P', 'Código Industria': 'CB2B010', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Altura CM': 2, 'Largura CM': 30, 'Comprimento ou profundidade CM': 40, 'Custo Unitário Fabricação': 25.5, 'Atacado À Vista': 49.9, 'Atacado Boleto 30/60': 54.9, 'Varejo À Vista': 99.9, 'Vlr Cartão Parcelado': 109.9, 'Margem MGB (%)': 60, 'Preço Varejo': 79.9 },
  { Item: '1002', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': 'CAMISETA BORDADO B PRETA', Tamanho: 'M', 'Código Industria': 'CB2B011', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5, 'Atacado À Vista': 49.9, 'Varejo À Vista': 99.9 },
  { Item: '1003', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'BRANCA', 'DESCRIÇÃO': 'CAMISETA BORDADO B BRANCA', Tamanho: 'P', 'Código Industria': 'CB2B020', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5, 'Atacado À Vista': 49.9, 'Varejo À Vista': 99.9 },
  { Item: '1004', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'BRANCA', 'DESCRIÇÃO': 'CAMISETA BORDADO B BRANCA', Tamanho: 'M', 'Código Industria': 'CB2B021', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5, 'Atacado À Vista': 49.9, 'Varejo À Vista': 99.9 },
  // Produto simples (família de uma linha só).
  { Item: '2001', 'Cód Categoria': 'SOR', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'ÓCULOS DE SOL', COLEÇÃO: 'VINTAGE POLARIZADO', 'VARIANTE COR': 'PRETO', 'DESCRIÇÃO': 'ÓCULOS DE SOL VINTAGE PRETO', Tamanho: '', 'Código Industria': 'SOR15101', Tipo: 'UN', STATUS: 'INATIVO', 'Peso KG': 0.05, 'Custo Unitário Fabricação': 40, 'Atacado À Vista': 89.9, 'Varejo À Vista': 179.9 },
];

// ---------------------------------------------------------------------------
// Unidade: helpers puros.
// ---------------------------------------------------------------------------
test('a classificação separa entrada, conferência e ignorada', () => {
  assert.equal(classificarColuna('Custo Unitário Fabricação').natureza, 'entrada');
  assert.equal(classificarColuna('Código Industria').natureza, 'entrada');
  assert.equal(classificarColuna('Atacado À Vista').natureza, 'entrada');
  assert.equal(classificarColuna('Vlr Cartão Parcelado').natureza, 'entrada');
  assert.equal(classificarColuna('Margem MGB (%)').natureza, 'conferencia');
  assert.equal(classificarColuna('Preço Varejo').natureza, 'conferencia');
  assert.equal(classificarColuna('Preço Atacado').natureza, 'conferencia');
  assert.equal(classificarColuna('Coluna7').natureza, 'ignorada');
});

test('os preços oficiais são lidos por canal e condição (não viram conferência)', () => {
  const precos = extrairPrecosOficiais({ 'Atacado À Vista': '49,90', 'Atacado Boleto 30/60': '54.9', 'Varejo À Vista': '99.9', 'Margem MGB (%)': '60' });
  const porCond = Object.fromEntries(precos.map((p) => [p.condicao, p.preco]));
  assert.equal(porCond['atacado_vista'], 49.9);
  assert.equal(porCond['boleto_30_60'], 54.9);
  assert.equal(porCond['varejo_vista'], 99.9);
  assert.equal(precos.length, 3, 'a coluna de margem calculada NÃO vira preço');
});

test('a descrição-base remove o sufixo de cor e o SKU do pai é determinístico', () => {
  assert.equal(descricaoBase('CAMISETA BORDADO B PRETA', 'PRETA'), 'CAMISETA BORDADO B');
  assert.equal(descricaoBase('ÓCULOS DE SOL VINTAGE PRETO', 'AZUL'), 'ÓCULOS DE SOL VINTAGE PRETO');
  assert.equal(skuPaiDe('CAMISETA', 'BORDADO B'), 'CAMISETA-BORDADO-B');
  assert.equal(skuPaiDe('CALÇAS', 'JEANS SLIN FIT'), 'CALCAS-JEANS-SLIN-FIT');
});

test('identificadores são preservados como texto (zeros à esquerda)', () => {
  const it = normalizarItem(
    { linha: 12, celulas: { Item: '007', 'Código Industria': '000123', 'CATEGORIA MASTER': 'X', 'DESCRIÇÃO': 'X', 'VARIANTE COR': '' } },
    new Map()
  );
  assert.equal(it.item, '007');
  assert.equal(it.codigo_industria, '000123');
});

test('o sanitizador remove as partes de tabela do XLSX sem tocar nos valores', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.ms-excel.table"/></Types>');
  zip.file('xl/tables/table1.xml', '<table name="T1"><tableColumns count="1"><tableColumn/></tableColumns></table>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>');
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId1" Type="http://x/table" Target="../tables/table1.xml"/><Relationship Id="rId2" Type="http://x/other" Target="../other.xml"/></Relationships>');
  const entrada = await zip.generateAsync({ type: 'nodebuffer' });

  const saida = await sanitizarXlsx(entrada);
  const z2 = await JSZip.loadAsync(saida);
  assert.equal(z2.files['xl/tables/table1.xml'], undefined, 'a tabela foi removida');
  const sheet = await z2.files['xl/worksheets/sheet1.xml'].async('string');
  assert.ok(!sheet.includes('tableParts'), 'o tableParts saiu da aba');
  assert.ok(sheet.includes('<v>7</v>'), 'o valor da célula permanece');
  const rels = await z2.files['xl/worksheets/_rels/sheet1.xml.rels'].async('string');
  assert.ok(!rels.includes('table1.xml'), 'a relação da tabela saiu');
  assert.ok(rels.includes('other.xml'), 'as demais relações permanecem');
});

// ---------------------------------------------------------------------------
// Fluxo HTTP com o banco em memória.
// ---------------------------------------------------------------------------
test('a prévia não grava nada e reporta as validações', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE);
  const s = getStore();
  const antes = await s.countWhere(RESOURCES.produtos, {});

  const resp = await request(app()).post('/api/carga/politica-comercial/preview').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.total, 5);
  assert.equal(resp.body.validacoes.familias, 2);
  assert.equal(resp.body.validacoes.campos_conferencia, 3, 'as 3 colunas calculadas viram conferência');
  assert.ok(resp.body.familias.some((f: any) => f.itens === 4), 'família CAMISETA com 4 itens');
  assert.ok(resp.body.familias.some((f: any) => f.itens === 1), 'família ÓCULOS com 1 item');

  const depois = await s.countWhere(RESOURCES.produtos, {});
  assert.equal(depois, antes, 'a prévia não cria produtos');
});

test('a confirmação cria pai + variações, importa preços oficiais e NÃO importa estoque', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE, [
    { industria: 'CB2B010', codigo: 'DTF ORIGINALPRETAP' }, // concatenação: NÃO é GTIN
    { industria: 'CB2B011', codigo: '7891234567895' }, // EAN-13 com dígito verificador VÁLIDO
  ]);
  const s = getStore();
  const resp = await request(app()).post('/api/carga/politica-comercial/confirmar').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.produtos, 2, 'dois produtos-pai (CAMISETA e ÓCULOS)');
  assert.equal(resp.body.variacoes, 4, 'quatro variações da camiseta');
  assert.equal(resp.body.estoque_importado, false);
  assert.equal(resp.body.precos_sobrescritos, false);
  assert.equal(resp.body.formulas_importadas, false);

  const pai = await s.findOneWhere(RESOURCES.produtos, { sku: 'CAMISETA-BORDADO-B', empresa_id: 1 });
  assert.ok(pai, 'o produto-pai foi criado');
  assert.equal(pai!.formato, 'variacao');
  assert.equal(pai!.marca, 'BROBOND');
  assert.equal(pai!.categoria_id, (await s.findOneWhere(RESOURCES.categorias, { nome: 'CAMISETA' }))!.id);

  const varPreta = await s.findOneWhere(RESOURCES.produtos, { sku: 'CB2B010', empresa_id: 1 });
  assert.ok(varPreta);
  assert.equal(Number(varPreta!.produto_pai_id), Number(pai!.id));
  assert.equal(varPreta!.variacao_chave, 'COR:PRETA|TAM:P');
  assert.equal(varPreta!.cor, 'PRETA');
  assert.equal(varPreta!.codigo_item, '1001');
  assert.equal(varPreta!.codigo_categoria, 'CB2B');
  assert.equal(varPreta!.codigo_industria, 'CB2B010');
  assert.equal(Number(varPreta!.custo), 25.5, 'o custo-base é importado');
  assert.equal(Number(varPreta!.preco_venda), 99.9, 'a BASE do varejo vem do preço oficial à vista');
  assert.equal(Number(varPreta!.preco_atacado), 49.9, 'a BASE do atacado vem do preço oficial à vista');
  assert.equal(varPreta!.codigo_barras, null, 'concatenação não vira código de barras');
  assert.equal(Number(varPreta!.peso_liquido_g), 200);
  assert.equal(Number(varPreta!.altura_mm), 20);
  assert.equal(Number(varPreta!.largura_mm), 300);
  assert.equal(Number(varPreta!.profundidade_mm), 400);

  // Preços OFICIAIS gravados por condição (dados de entrada, não fórmula).
  const condBoleto = await s.findOneWhere(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(varPreta!.id), canal: 'atacado', condicao: 'boleto_30_60' });
  assert.ok(condBoleto, 'o preço de atacado boleto 30/60 foi importado');
  assert.equal(Number(condBoleto!.preco), 54.9);
  const condParcelado = await s.findOneWhere(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(varPreta!.id), canal: 'varejo', condicao: 'cartao_parcelado' });
  assert.ok(condParcelado);
  assert.equal(Number(condParcelado!.preco), 109.9);

  // Cadastro estrutural das condições de pagamento criado (idempotente).
  assert.ok(await s.findOneWhere(RESOURCES.condicoes_pagamento, { empresa_id: 1, codigo: 'boleto_30_60' }));
  assert.ok(await s.findOneWhere(RESOURCES.condicoes_pagamento, { empresa_id: 1, codigo: 'cartao_parcelado' }));

  const varBranca = await s.findOneWhere(RESOURCES.produtos, { sku: 'CB2B021', empresa_id: 1 });
  assert.equal(varBranca!.codigo_barras, null, 'sem EAN válido, o campo fica ausente');

  const varComEan = await s.findOneWhere(RESOURCES.produtos, { sku: 'CB2B011', empresa_id: 1 });
  assert.equal(varComEan!.codigo_barras, '7891234567895', 'EAN-13 válido é preservado');

  const oculos = await s.findOneWhere(RESOURCES.produtos, { sku: 'SOR15101', empresa_id: 1 });
  assert.ok(oculos);
  assert.equal(oculos!.ativo, false, 'STATUS INATIVO desativa o produto');
  assert.equal(oculos!.produto_pai_id ?? null, null, 'produto simples não tem pai');

  // NENHUMA quantidade física foi criada.
  const estoques = await s.countWhere(RESOURCES.estoques, { empresa_id: 1 });
  assert.equal(estoques, 0, 'nenhum saldo de estoque importado');
});

test('reimportar o mesmo arquivo não duplica nada (idempotência)', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE);
  const s = getStore();
  const antes = await s.countWhere(RESOURCES.produtos, { empresa_id: 1 });
  const precosAntes = await s.countWhere(RESOURCES.produto_precos_condicao, { empresa_id: 1 });

  const resp = await request(app()).post('/api/carga/politica-comercial/confirmar').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.produtos, 0, 'nenhum produto novo');
  assert.equal(resp.body.variacoes, 0, 'nenhuma variação nova');
  assert.equal(resp.body.ignorados, 5, 'todas as linhas já existiam');

  const depois = await s.countWhere(RESOURCES.produtos, { empresa_id: 1 });
  assert.equal(depois, antes, 'a contagem de produtos não muda');
  const precosDepois = await s.countWhere(RESOURCES.produto_precos_condicao, { empresa_id: 1 });
  assert.equal(precosDepois, precosAntes, 'a reimportação não duplica preços por condição');
  const condicoes = await s.countWhere(RESOURCES.condicoes_pagamento, { empresa_id: 1 });
  assert.equal(condicoes, 4, 'as condições de pagamento também são idempotentes');
});

test('mudar o preço de uma condição VERSIONA (fecha a vigência e registra histórico), nunca apaga', async () => {
  const s = getStore();
  const variacao = await s.findOneWhere(RESOURCES.produtos, { sku: 'CB2B010', empresa_id: 1 });
  assert.ok(variacao, 'a variação CB2B010 existe da carga anterior');

  // Nova versão do arquivo com o boleto 30/60 de 54,90 → 59,90.
  const linhas = LINHAS_BASE.map((l) =>
    l['Código Industria'] === 'CB2B010' ? { ...l, 'Atacado Boleto 30/60': 59.9 } : l
  );
  const conteudo = await xlsxBase64(linhas);
  const resp = await request(app()).post('/api/carga/politica-comercial/confirmar').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.produtos, 0, 'nenhum produto novo');
  assert.equal(resp.body.precos_versionados, 1, 'um preço versionado');
  assert.equal(resp.body.precos_gravados, 0, 'nenhuma linha nova "vigente" contada como gravação simples');

  // Vigente agora é o preço novo.
  const vigente = await s.findOneWhere(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(variacao!.id), canal: 'atacado', condicao: 'boleto_30_60', vigencia_fim: null });
  assert.ok(vigente, 'existe linha vigente');
  assert.equal(Number(vigente!.preco), 59.9);

  // A linha antiga NÃO foi apagada: virou histórico (vigência fechada).
  const { rows } = await s.list(RESOURCES.produto_precos_condicao, { page: 1, pageSize: 50, filter: { empresa_id: 1, produto_id: Number(variacao!.id), canal: 'atacado', condicao: 'boleto_30_60' } });
  assert.equal(rows.length, 2, 'histórico + vigente coexistem (nada apagado)');
  const antiga = rows.find((r) => r.vigencia_fim !== null && r.vigencia_fim !== undefined);
  assert.ok(antiga, 'a linha anterior tem vigência fechada');
  assert.equal(Number(antiga!.preco), 54.9);

  // E a mudança está auditada em `produto_precos_condicao_historico`.
  const { rows: hist } = await s.list(RESOURCES.produto_precos_condicao_historico, { page: 1, pageSize: 50, filter: { empresa_id: 1, produto_id: Number(variacao!.id), canal: 'atacado', condicao: 'boleto_30_60' } });
  const mudanca = hist.find((h) => Number(h.preco_anterior) === 54.9 && Number(h.preco_novo) === 59.9);
  assert.ok(mudanca, 'a mudança 54,90 → 59,90 entrou no histórico');
});

test('status inválido é reportado sem descartar a linha em silêncio', async () => {
  const conteudo = await xlsxBase64([
    { Item: '9001', 'Cód Categoria': 'X', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'TESTE STATUS', COLEÇÃO: 'C', 'VARIANTE COR': 'AZUL', 'DESCRIÇÃO': 'PRODUTO X AZUL', Tamanho: 'U', 'Código Industria': 'TSK001', STATUS: 'PENDENTE' },
  ]);
  const resp = await request(app()).post('/api/carga/politica-comercial/preview').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.validacoes.status_invalidos.length, 1);
  assert.match(resp.body.validacoes.status_invalidos[0], /9001:PENDENTE/);
});

test('a carga exige gestor (operador é recusado)', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE);
  const op = { id: 9, name: 'Op', perfil: 'operador' as const, empresa_id: 1, empresas: [1] };
  const resp = await request(app(op)).post('/api/carga/politica-comercial/preview').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 403);
});

// ---------------------------------------------------------------------------
// CARGA INTEGRAL: todas as abas de CADASTRO (não só a principal).
//
// O Diretor apontou produtos que "ainda não aparecem no ERP": eles estão nas
// abas "BASE CONTROLE DE ESTOQUE" e "Política Comercial Roupas (2)", com códigos
// PRÓPRIOS que não colidem com a principal. As abas de MOVIMENTAÇÃO não entram.
// ---------------------------------------------------------------------------
const EXTRAS = {
  controle: [
    { Item: '1001', 'COLEÇÃO': 'COLEÇÃO 2 STAMPA', CATEGORIA: 'BROBOND ORIGINAL', SUBCATEGORIA: 'BRANCA', 'Descrição do produto/serviço2': 'CAMISETA BROBOND GOLA "O" BRANCA SILK ORIGINAL - P', Tamanho: 'P', 'Código Industria': '1001P', Tipo: 'PÇ', 'Valor unitário Custo': 30, 'ATACADO À Vista Min. 10 Pças': 49.9, 'VRJ À VISTA': 69.9 },
    { Item: '1002', 'COLEÇÃO': 'COLEÇÃO 2 STAMPA', CATEGORIA: 'BROBOND ORIGINAL', SUBCATEGORIA: 'BRANCA', 'Descrição do produto/serviço2': 'CAMISETA BROBOND GOLA "O" BRANCA SILK ORIGINAL - M', Tamanho: 'M', 'Código Industria': '1002M', Tipo: 'PÇ', 'Valor unitário Custo': 30, 'ATACADO À Vista Min. 10 Pças': 49.9, 'VRJ À VISTA': 69.9 },
  ],
  roupas: [
    { Item: '1', Categoria: 'SHORT', 'Descrição do produto/serviço2': '93882 SHORT FITA DE BRILHO:40', 'Código Industria': '93882-40', Tipo: 'UN', Fornecedor: 'LEMONETTE', 'Qtd. Estoque': 1, 'Valor unitário Custo': 89.9, 'Preço à Vista  10% Desc.': 128.43, 'Preço de Venda Cartão': 142.7 },
    { Item: '2', Categoria: 'SHORT', 'Descrição do produto/serviço2': '93882 SHORT FITA DE BRILHO:42', 'Código Industria': '93882-42', Tipo: 'UN', Fornecedor: 'LEMONETTE', 'Qtd. Estoque': 1, 'Valor unitário Custo': 89.9, 'Preço à Vista  10% Desc.': 128.43, 'Preço de Venda Cartão': 142.7 },
  ],
};

test('a prévia examina TODAS as abas e separa cadastro de movimentação', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE, [], { ...EXTRAS, movimentacao: true });
  const resp = await request(app()).post('/api/carga/politica-comercial/preview').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  const rec = resp.body.reconciliacao;
  assert.ok(rec, 'a prévia traz a reconciliação das abas');
  const porAba = Object.fromEntries(rec.abas.map((a: any) => [a.aba, a]));
  assert.equal(porAba['BASE CONTROLE DE ESTOQUE'].usada_como_cadastro, true);
  assert.equal(porAba['Política Comercial Roupas (2)'].usada_como_cadastro, true);
  assert.equal(porAba['ENTRADA MERCADORIA'].usada_como_cadastro, false, 'movimentação não é cadastro');
  assert.equal(rec.produtos_por_fonte.principal, 5);
  assert.equal(rec.produtos_por_fonte.controle_estoque, 2);
  assert.equal(rec.produtos_por_fonte.roupas, 2);
  // Os códigos das abas extras não existem na principal — eram os "sumidos".
  assert.deepEqual(rec.codigos_aba_ausentes_na_principal['BASE CONTROLE DE ESTOQUE'].sort(), ['1001P', '1002M']);
  assert.deepEqual(rec.codigos_aba_ausentes_na_principal['Política Comercial Roupas (2)'].sort(), ['93882-40', '93882-42']);
});

test('a confirmação cria produtos das TRÊS abas de cadastro e NÃO importa a quantidade de controle', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE, [], { ...EXTRAS, movimentacao: true });
  const s = getStore();
  const resp = await request(app()).post('/api/carga/politica-comercial/confirmar').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.estoque_importado, false);

  // Produto da aba de CONTROLE: cadastro próprio, custo e preço-base preservados.
  const controle = await s.findOneWhere(RESOURCES.produtos, { sku: '1001P', empresa_id: 1 });
  assert.ok(controle, 'o SKU da aba de controle foi criado');
  assert.equal(Number(controle!.custo), 30, 'o custo-base da aba de controle é importado');
  assert.equal(Number(controle!.preco_atacado), 49.9, 'o preço atacado à vista define a base do atacado');

  // Produto da aba de ROUPAS: cadastro próprio e preço de venda.
  const roupas = await s.findOneWhere(RESOURCES.produtos, { sku: '93882-40', empresa_id: 1 });
  assert.ok(roupas, 'o SKU de roupas foi criado');
  assert.equal(Number(roupas!.custo), 89.9);
  assert.equal(Number(roupas!.preco_venda), 128.43, 'a base do varejo vem do preço oficial à vista');
  const condCartao = await s.findOneWhere(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(roupas!.id), canal: 'varejo', condicao: 'cartao_parcelado' });
  assert.ok(condCartao, 'o preço de venda no cartão entra como preço por condição');
  assert.equal(Number(condCartao!.preco), 142.7);

  // A quantidade de controle ("Qtd. Estoque" = 1) NÃO virou estoque/movimentação.
  const movs = await s.countWhere(RESOURCES.movimentacoes, { empresa_id: 1 });
  assert.equal(movs, 0, 'nenhuma movimentação de estoque foi criada');
});

test('reimportar com as abas extras não duplica (idempotência entre fontes)', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE, [], EXTRAS);
  const s = getStore();
  const r1 = await request(app()).post('/api/carga/politica-comercial/confirmar').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const antes = await s.countWhere(RESOURCES.produtos, {});
  const r2 = await request(app()).post('/api/carga/politica-comercial/confirmar').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.produtos, 0, 'a segunda passada não cria produto-pai novo');
  assert.equal(r2.body.variacoes, 0, 'a segunda passada não cria variação nova');
  assert.equal(await s.countWhere(RESOURCES.produtos, {}), antes, 'o cadastro total não muda');
});

// ---------------------------------------------------------------------------
// COLISÃO de SKU de produto-pai (bug real da planilha).
//
// Duas famílias distintas podem gerar o MESMO SKU de pai: (a) o slug trunca em
// 40 chars, então "BORDADO BB" e "BORDADO B" convergem; (b) nas abas extras o
// pai nasce da descrição. Sem desempate, famílias distintas virariam UM produto.
// ---------------------------------------------------------------------------
test('hashChave distingue chaves vizinhas (não pega os dígitos de maior ordem)', () => {
  assert.notEqual(hashChave('roupas|5'), hashChave('roupas|6'));
  assert.notEqual(hashChave('roupas|6'), hashChave('roupas|7'));
  assert.equal(hashChave('roupas|5'), hashChave('roupas|5'), 'é determinístico');
  assert.equal(hashChave('x').length, 6);
});

test('a colisão de SKU de pai é desempatada e REPORTADA (famílias não se fundem)', async () => {
  // Duas famílias de controle cujo SKU de pai colide: as descrições só diferem
  // DEPOIS do corte de 40 chars do slug ("…PREMIUM ALFA" × "…PREMIUM BETA").
  const comum = 'CAMISETA BROBOND GOLA O BORDADO ESPECIAL LINHA PREMIUM';
  const conteudo = await xlsxBase64(LINHAS_BASE, [], {
    controle: [
      { Item: '1', 'COLEÇÃO': 'CLEAN', CATEGORIA: 'BORDADO B', SUBCATEGORIA: 'BRANCA', 'Descrição do produto/serviço2': `${comum} ALFA - P`, Tamanho: 'P', 'Código Industria': '5001P', Tipo: 'PÇ' },
      { Item: '2', 'COLEÇÃO': 'CLEAN', CATEGORIA: 'BORDADO B', SUBCATEGORIA: 'BRANCA', 'Descrição do produto/serviço2': `${comum} ALFA - M`, Tamanho: 'M', 'Código Industria': '5002M', Tipo: 'PÇ' },
      { Item: '3', 'COLEÇÃO': 'CLEAN', CATEGORIA: 'BORDADO BB', SUBCATEGORIA: 'BRANCA', 'Descrição do produto/serviço2': `${comum} BETA - P`, Tamanho: 'P', 'Código Industria': '5003P', Tipo: 'PÇ' },
      { Item: '4', 'COLEÇÃO': 'CLEAN', CATEGORIA: 'BORDADO BB', SUBCATEGORIA: 'BRANCA', 'Descrição do produto/serviço2': `${comum} BETA - M`, Tamanho: 'M', 'Código Industria': '5004M', Tipo: 'PÇ' },
    ],
  });
  const resp = await request(app()).post('/api/carga/politica-comercial/preview').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  const skus = resp.body.familias.map((f: any) => f.sku);
  assert.equal(new Set(skus).size, skus.length, 'cada família tem SKU de pai próprio');
  assert.ok(skus.every((s: string) => s.length <= 40), 'nenhum SKU passa de 40 chars');
  assert.equal(resp.body.validacoes.skus_pai_colididos.length, 1, 'a colisão é reportada, não escondida');
});

test('descricaoSemTamanho não come letra de palavra (MARFIM ≠ MARFI)', () => {
  // Bug real: remover o tamanho "M" de "…BORDADA MARFIM" partia a família.
  assert.equal(descricaoSemTamanho('SHORT LINHO BORDADA MARFIM', 'M'), 'SHORT LINHO BORDADA MARFIM');
  assert.equal(descricaoSemTamanho('CAMISETA BORDADO B PRETA - P', 'P'), 'CAMISETA BORDADO B PRETA');
  assert.equal(descricaoSemTamanho('CALÇA JEANS TAMANHO: 42', '42'), 'CALÇA JEANS');
  assert.equal(descricaoSemTamanho('SHORT NAVALHADO tamanho:42', '42'), 'SHORT NAVALHADO');
});

test('código da aba Roupas é PRODUTO-TAMANHO (variação, não produto novo)', () => {
  assert.deepEqual(parseCodigoRoupas('93882-40'), { produto: '93882', cor: '', tamanho: '40' });
  assert.deepEqual(parseCodigoRoupas('94004-AREIA-42'), { produto: '94004', cor: 'AREIA', tamanho: '42' });
  assert.deepEqual(parseCodigoRoupas('94000-branco-gg'), { produto: '94000', cor: 'branco', tamanho: 'GG' });
  assert.deepEqual(parseCodigoRoupas('117176'), { produto: '117176', cor: '', tamanho: '' });
});

test('roupas: dois tamanhos do MESMO código são pai + variações (não dois produtos)', async () => {
  const conteudo = await xlsxBase64(LINHAS_BASE, [], {
    roupas: [
      { Item: '1', Categoria: 'SHORT', 'Descrição do produto/serviço2': '93845 SHORT NAVALHADO:40', 'Código Industria': '93845-40', Tipo: 'UN', 'Valor unitário Custo': 89.9 },
      { Item: '2', Categoria: 'SHORT', 'Descrição do produto/serviço2': '93845 SHORT NAVALHADO:42', 'Código Industria': '93845-42', Tipo: 'UN', 'Valor unitário Custo': 89.9 },
    ],
  });
  const resp = await request(app()).post('/api/carga/politica-comercial/preview').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  const roupas = resp.body.familias.filter((f: any) => f.colecao === '' && f.categoria_master === 'SHORT');
  assert.equal(roupas.length, 1, 'um único produto-pai para os dois tamanhos');
  assert.equal(roupas[0].itens, 2);
  assert.equal(roupas[0].sku, '93845');
  assert.deepEqual([...roupas[0].tamanhos].sort(), ['40', '42']);
});

test('descricaoSemCor remove a cor no MEIO da descrição (controle de estoque)', () => {
  assert.equal(descricaoSemCor('CAMISETA BROBOND GOLA O BRANCA BORDADO BB', 'BRANCA'), 'CAMISETA BROBOND GOLA O BORDADO BB');
  assert.equal(descricaoSemCor('CAMISETA BROBOND GOLA O PRETA BORDADO BB', 'PRETA'), 'CAMISETA BROBOND GOLA O BORDADO BB');
  // Não come letra de palavra.
  assert.equal(descricaoSemCor('SHORT MARFIM', 'MARFIM'), 'SHORT');
  assert.equal(descricaoSemCor('BLUSA VERDE', 'VERDE'), 'BLUSA');
});
