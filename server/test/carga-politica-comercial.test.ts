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
const { previewCarga, confirmarCarga, classificarColuna, normalizarItem, descricaoBase, skuPaiDe, sanitizarXlsx } = await import(
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
  // Colunas CALCULADAS — devem ser classificadas como conferência e ignoradas.
  'Margem MGB (%)', 'Preço Varejo', 'Preço Atacado',
];

type Linha = Partial<Record<(typeof CABECALHO)[number], string | number>>;

/** Monta o XLSX no leiaute da origem e devolve base64. */
async function xlsxBase64(linhas: Linha[], barras: { codigo: string; industria: string }[] = []): Promise<string> {
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
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

const LINHAS_BASE: Linha[] = [
  { Item: '1001', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': 'CAMISETA BORDADO B PRETA', Tamanho: 'P', 'Código Industria': 'CB2B010', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Altura CM': 2, 'Largura CM': 30, 'Comprimento ou profundidade CM': 40, 'Custo Unitário Fabricação': 25.5, 'Margem MGB (%)': 60, 'Preço Varejo': 79.9 },
  { Item: '1002', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': 'CAMISETA BORDADO B PRETA', Tamanho: 'M', 'Código Industria': 'CB2B011', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5 },
  { Item: '1003', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'BRANCA', 'DESCRIÇÃO': 'CAMISETA BORDADO B BRANCA', Tamanho: 'P', 'Código Industria': 'CB2B020', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5 },
  { Item: '1004', 'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: 'BORDADO B', 'VARIANTE COR': 'BRANCA', 'DESCRIÇÃO': 'CAMISETA BORDADO B BRANCA', Tamanho: 'M', 'Código Industria': 'CB2B021', Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5 },
  // Produto simples (família de uma linha só).
  { Item: '2001', 'Cód Categoria': 'SOR', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'ÓCULOS DE SOL', COLEÇÃO: 'VINTAGE POLARIZADO', 'VARIANTE COR': 'PRETO', 'DESCRIÇÃO': 'ÓCULOS DE SOL VINTAGE PRETO', Tamanho: '', 'Código Industria': 'SOR15101', Tipo: 'UN', STATUS: 'INATIVO', 'Peso KG': 0.05, 'Custo Unitário Fabricação': 40 },
];

// ---------------------------------------------------------------------------
// Unidade: helpers puros.
// ---------------------------------------------------------------------------
test('a classificação separa entrada, conferência e ignorada', () => {
  assert.equal(classificarColuna('Custo Unitário Fabricação').natureza, 'entrada');
  assert.equal(classificarColuna('Código Industria').natureza, 'entrada');
  assert.equal(classificarColuna('Margem MGB (%)').natureza, 'conferencia');
  assert.equal(classificarColuna('Preço Varejo').natureza, 'conferencia');
  assert.equal(classificarColuna('Preço Atacado').natureza, 'conferencia');
  assert.equal(classificarColuna('Coluna7').natureza, 'ignorada');
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

test('a confirmação cria pai + variações, sem estoque e sem preço', async () => {
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
  assert.equal(Number(varPreta!.preco_venda), 0, 'preço de varejo NÃO é importado');
  assert.equal(Number(varPreta!.preco_atacado), 0, 'preço de atacado NÃO é importado');
  assert.equal(varPreta!.codigo_barras, null, 'concatenação não vira código de barras');
  assert.equal(Number(varPreta!.peso_liquido_g), 200);
  assert.equal(Number(varPreta!.altura_mm), 20);
  assert.equal(Number(varPreta!.largura_mm), 300);
  assert.equal(Number(varPreta!.profundidade_mm), 400);

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

  const resp = await request(app()).post('/api/carga/politica-comercial/confirmar').send({ conteudo, nome: 'x.xlsx' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.produtos, 0, 'nenhum produto novo');
  assert.equal(resp.body.variacoes, 0, 'nenhuma variação nova');
  assert.equal(resp.body.ignorados, 5, 'todas as linhas já existiam');

  const depois = await s.countWhere(RESOURCES.produtos, { empresa_id: 1 });
  assert.equal(depois, antes, 'a contagem de produtos não muda');
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
