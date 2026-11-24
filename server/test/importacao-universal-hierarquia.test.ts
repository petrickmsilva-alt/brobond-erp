import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inventariarArquivoUniversal, type ArquivoInventariado } from '../src/importacaoUniversalLeitura';
import { interpretarCamposUniversal, type AnaliseSemantica } from '../src/importacaoUniversalSemantica';
import { reconhecerEntidadesUniversal, construirModeloDependencias } from '../src/importacaoUniversalEntidades';
import { reconciliarImportacaoUniversal } from '../src/importacaoUniversalRecon';
import { analisarArquivoUniversal } from '../src/importacaoUniversalAnalise';
import {
  construirPlanoHierarquiaUniversal,
  planoHierarquiaDeMapeamentos,
  planoHierarquiaDeAnalise,
  baseSkuPorPadrao,
  nomeBaseHierarquia,
  type MapeamentoHierarquia,
} from '../src/importacaoUniversalHierarquia';

// Avoids the auth module's dev warning (non-ASCII stdout) on Node 22 runners.
process.env.JWT_SECRET ||= 'hierarquia-test-secret';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${raiz}/server/test/fixtures/catalogo-canonico-comercial.csv`;
const csvCanonico = readFileSync(FIXTURE, 'utf8');

async function arquivo(nome: string, csv: string): Promise<ArquivoInventariado> {
  return inventariarArquivoUniversal({ nomeArquivo: nome, bytes: Buffer.from(csv, 'utf8') });
}
function mapeamentos(sem: AnaliseSemantica): MapeamentoHierarquia[] {
  return sem.sugestoes.map((s) => ({
    aba: s.aba, colunaOriginal: s.colunaOriginal, campoCanonico: s.campoCanonico,
    ignorado: false, usar: !s.requerConfirmacao,
  }));
}
function semanticaConfirmada(sem: AnaliseSemantica): AnaliseSemantica {
  return { ...sem, sugestoes: sem.sugestoes.map((s) => ({ ...s, requerConfirmacao: false })) };
}
function plano(csv: string, erp?: { id: number; sku: string; nome: string; produto_pai_id: number | null }[]) {
  const arq = { abas: csvParaAbas(csv) };
  return planoHierarquiaDeMapeamentos(arq, csvMapeamentos(csv), { produtosERP: erp });
}
function csvParaAbas(csv: string) {
  const linhas = csv.trim().split(/\r?\n/);
  const cabecalhos = linhas[0].split(';');
  return [{ nome: 'Catalogo', linhas: linhas.slice(1).map((linha, i) => {
    const celulas = linha.split(';');
    const valores: Record<string, unknown> = {};
    cabecalhos.forEach((c, j) => { const v = (celulas[j] ?? '').trim(); if (v) valores[c] = v; });
    return { linhaOrigem: i + 2, valores };
  }) }];
}
function csvMapeamentos(csv: string): MapeamentoHierarquia[] {
  const cabecalhos = csv.trim().split(/\r?\n/)[0].split(';');
  const sem = interpretarCamposUniversal({ abas: [{ nome: 'Catalogo', cabecalhos, linhas: [] }] } as unknown as ArquivoInventariado);
  return mapeamentos(sem);
}
const CAB = 'sku;referencia_comercial;codigo_base;nome;cor;tamanho;codigo_barras;custo;preco_venda;preco_atacado;atacado_vista;margem_atacado_vista;politica_comercial;ativo';
const linha = (sku: string, ref: string, base: string, nome: string, cor: string, tam: string, ean: string) =>
  `${sku};${ref};${base};${nome};${cor};${tam};${ean};26,75;79,90;59,90;59,90;35%;ATACADO_PADRAO;sim`;

// ---------------------------------------------------------------------------
// 1. CSV with products and variants, WITHOUT a physical parent row (the bug)
// ---------------------------------------------------------------------------
test('single CSV without a parent sheet resolves hierarchy and unblocks import', async () => {
  const arq = await arquivo('catalogo-canonico.csv', csvCanonico);
  const sem = interpretarCamposUniversal(arq);
  const hierarquia = planoHierarquiaDeMapeamentos(arq, mapeamentos(sem));
  assert.ok(hierarquia.familias.length >= 2);
  assert.ok(hierarquia.familias.every((f) => f.resolvida));
  const entidades = reconhecerEntidadesUniversal(arq, sem, hierarquia.porAba);
  const deps = construirModeloDependencias(entidades.entidades, entidades.relacionamentos, undefined, hierarquia.porAba);
  const dep = deps.find((d) => d.aba === arq.abas[0].nome);
  assert.equal(dep?.estado, 'vinculada');
  assert.equal(dep?.resolvidaNaOrigem, true);
  assert.deepEqual(dep?.bloqueios, []);
  assert.ok(!JSON.stringify(dep).includes('Não existe aba candidata de pai'));
  const result = reconciliarImportacaoUniversal(arq, semanticaConfirmada(sem), { ...entidades, hierarquia, dependencias: deps }, [], []);
  assert.equal(result.totais.variacao_sem_produto, 0);
  assert.equal(result.hierarquia?.familias.length, hierarquia.familias.length);
  assert.equal(result.importacaoLiberada, false, 'reconciliation is still read-only');
});

test('analysis endpoint exposes the hierarchy plan and resolves the dependency', async () => {
  const result = await analisarArquivoUniversal({ nomeArquivo: 'catalogo-canonico.csv', bytes: Buffer.from(csvCanonico) });
  assert.ok(result.hierarquia.familias.length >= 2);
  const dep = result.entidades.dependencias[0];
  assert.equal(dep.estado, 'vinculada');
  assert.equal(dep.resolvidaNaOrigem, true);
  assert.ok(result.entidades.alertas.some((a) => a.includes('nenhuma aba separada')));
});

// ---------------------------------------------------------------------------
// 2. Several colours and sizes; 3. one SKU per variant
// ---------------------------------------------------------------------------
test('multiple colours and sizes produce one unique SKU per valid combination', async () => {
  const arq = await arquivo('catalogo-canonico.csv', csvCanonico);
  const hierarquia = planoHierarquiaDeMapeamentos(arq, mapeamentos(interpretarCamposUniversal(arq)));
  const familia = hierarquia.familias.find((f) => f.totalVariantes === 6);
  assert.ok(familia, 'expected a 2-colour x 3-size family');
  assert.equal(new Set(familia.variantes.map((v) => v.sku)).size, 6);
  assert.equal(new Set(familia.variantes.map((v) => v.chaveVariacao)).size, 6);
  assert.equal(new Set(familia.variantes.map((v) => v.cor)).size, 2);
  assert.equal(new Set(familia.variantes.map((v) => v.tamanho)).size, 3);
  assert.ok(familia.variantes.every((v) => v.chaveVariacao.startsWith('COR:') && v.chaveVariacao.includes('|TAM:')));
  assert.equal(familia.pai.acao, 'criar');
  assert.equal(familia.totalVariantes, familia.variantes.length);
});

// ---------------------------------------------------------------------------
// 4. Family by common commercial reference
// ---------------------------------------------------------------------------
test('common commercial reference identifies the family without a parent row', () => {
  const csv = [CAB,
    linha('REF-A-1', 'REF-A', '', 'CAMISETA POLO', 'AZUL', 'M', '7890000000017'),
    linha('REF-A-2', 'REF-A', '', 'CAMISETA POLO', 'AZUL', 'G', '7890000000024'),
    linha('REF-A-3', 'REF-A', '', 'CAMISETA POLO', 'PRETO', 'M', '7890000000031'),
  ].join('\n');
  const p = plano(csv);
  assert.equal(p.familias.length, 1);
  assert.equal(p.familias[0].cenario, 'B');
  assert.ok(p.familias[0].evidencias.includes('referencia_comercial'));
  assert.ok(p.familias[0].evidencias.includes('nome_normalizado'));
  assert.equal(p.familias[0].totalVariantes, 3);
  assert.ok(p.familias[0].confianca >= 0.9);
});

// ---------------------------------------------------------------------------
// 5. Family by proven base code
// ---------------------------------------------------------------------------
test('proven base code identifies the family only when SKUs carry that base', () => {
  const csv = [CAB,
    linha('CAM-DTF-1', 'REF-A', 'CAM-DTF', 'CAMISETA DTF', 'AZUL', 'M', '7890000000017'),
    linha('CAM-DTF-2', 'REF-A', 'CAM-DTF', 'CAMISETA DTF', 'PRETO', 'G', '7890000000024'),
  ].join('\n');
  const p = plano(csv);
  assert.equal(p.familias.length, 1);
  assert.equal(p.familias[0].cenario, 'B');
  assert.ok(p.familias[0].evidencias.includes('codigo_base'));
  const invalido = [CAB,
    linha('OUTRO-1', 'REF-A', 'SEM-PROVA', 'CAMISETA DTF', 'AZUL', 'M', '7890000000017'),
    linha('OUTRO-2', 'REF-A', 'SEM-PROVA', 'CAMISETA DTF', 'PRETO', 'G', '7890000000024'),
  ].join('\n');
  // Reference still groups them, but the unproven base code is never evidence.
  const p2 = plano(invalido);
  assert.ok(!p2.familias.some((f) => f.evidencias.includes('codigo_base')));
});

// ---------------------------------------------------------------------------
// 6. Validated SKU pattern (suffix explained by colour/size)
// ---------------------------------------------------------------------------
test('validated SKU pattern groups variants; generic prefixes never do', () => {
  const csv = [CAB,
    linha('CAM100-AZUL-M', 'REF-X', '', 'CAMISETA BASICA', 'AZUL', 'M', '7890000000017'),
    linha('CAM100-PRETO-G', 'REF-Y', '', 'CAMISETA BASICA', 'PRETO', 'G', '7890000000024'),
  ].join('\n');
  assert.equal(baseSkuPorPadrao('CAM100-AZUL-M', 'AZUL', 'M'), 'CAM100');
  const p = plano(csv);
  assert.equal(p.familias.length, 1);
  assert.equal(p.familias[0].cenario, 'C');
  assert.ok(p.familias[0].evidencias.includes('sku_base_validado'));
  assert.ok(p.familias[0].confianca < 0.9, 'pattern inference is deliberately less confident');
  assert.equal(baseSkuPorPadrao('BB100-1', 'AZUL', 'M'), null);
  assert.equal(nomeBaseHierarquia('CAMISETA MARFIM M', '', 'M'), 'CAMISETA MARFIM', 'size removed as a token only');
});

// ---------------------------------------------------------------------------
// 7. Independent products without variation axes
// ---------------------------------------------------------------------------
test('products without variation axes stay independent and hierarchy is not applied', () => {
  const csv = 'sku;nome;preco_venda;custo\nA-1;Produto A;10,00;4,00\nA-2;Produto B;12,00;5,00';
  const p = plano(csv);
  assert.equal(p.familias.length, 0);
  assert.equal(p.porAba.Catalogo.aplicavel, false);
  assert.equal(p.resumo.variantes, 0);
});

// ---------------------------------------------------------------------------
// 8. Similar names, different families
// ---------------------------------------------------------------------------
test('similar names with distinct references are never merged into one family', () => {
  const csv = [CAB,
    linha('POLO-MASC-AZUL-M', 'REF-MASC', '', 'CAMISETA POLO MASCULINA', 'AZUL', 'M', '7890000000017'),
    linha('POLO-MASC-PRETO-G', 'REF-MASC', '', 'CAMISETA POLO MASCULINA', 'PRETO', 'G', '7890000000024'),
    linha('POLO-FEM-AZUL-M', 'REF-FEM', '', 'CAMISETA POLO FEMININA', 'AZUL', 'M', '7890000000031'),
    linha('POLO-FEM-PRETO-G', 'REF-FEM', '', 'CAMISETA POLO FEMININA', 'PRETO', 'G', '7890000000048'),
  ].join('\n');
  const p = plano(csv);
  assert.equal(p.familias.length, 2);
  for (const f of p.familias) assert.equal(f.totalVariantes, 2);
  assert.equal(new Set(p.familias.map((f) => f.pai.sku)).size, 2);
  assert.ok(p.familias.every((f) => f.variantes.every((v) => v.sku.startsWith(f.variantes[0].sku.split('-')[0] + '-' + f.variantes[0].sku.split('-')[1]))));
});

// ---------------------------------------------------------------------------
// 9. Similar SKU prefixes that must NOT be grouped
// ---------------------------------------------------------------------------
test('similar SKU prefixes without a proven suffix produce no families', () => {
  const csv = [CAB,
    linha('BB100-1', 'REF-1', '', 'SHORT A', 'AZUL', 'M', '7890000000017'),
    linha('BB101-1', 'REF-2', '', 'SHORT B', 'AZUL', 'M', '7890000000024'),
    linha('BB100-2', 'REF-3', '', 'SHORT A', 'PRETO', 'G', '7890000000031'),
    linha('BB101-2', 'REF-4', '', 'SHORT B', 'PRETO', 'G', '7890000000048'),
  ].join('\n');
  const p = plano(csv);
  assert.equal(p.familias.length, 0);
  assert.equal(p.independentes.length, 4);
  assert.ok(p.independentes.every((i) => i.motivo === 'sem_evidencia_familia'));
  assert.ok(p.conflitos.some((c) => c.tipo === 'familia_sem_evidencia'));
});

// ---------------------------------------------------------------------------
// 10. Missing colour or size; explicit base row becomes the parent
// ---------------------------------------------------------------------------
test('missing colour/size is supported and a base row is used as the parent', () => {
  const cab = 'sku;sku_pai;nome;cor;tamanho;preco_venda';
  const csv = [cab,
    'PAI-OCULOS;PAI-OCULOS;OCULOS SOLAR;;;199,90',
    'OCULOS-AZUL;PAI-OCULOS;OCULOS SOLAR;AZUL;;199,90',
    'OCULOS-PRETO;PAI-OCULOS;OCULOS SOLAR;PRETO;;199,90',
  ].join('\n');
  const p = plano(csv);
  assert.equal(p.familias.length, 1);
  assert.equal(p.familias[0].cenario, 'A');
  assert.equal(p.familias[0].pai.origem, 'linha');
  assert.equal(p.familias[0].pai.sku, 'PAI-OCULOS');
  assert.equal(p.familias[0].totalVariantes, 2);
  assert.ok(p.familias[0].variantes.every((v) => v.chaveVariacao.startsWith('COR:') && !v.chaveVariacao.includes('TAM:')));
});

test('SKU-pai explicito sem linha fisica de pai tambem e resolvido', () => {
  const cab = 'sku;sku_pai;nome;cor;tamanho';
  const csv = [cab,
    'FILHO-1;PAI-INFERIDO;CAMISETA;AZUL;M',
    'FILHO-2;PAI-INFERIDO;CAMISETA;PRETO;G',
  ].join('\n');
  const p = plano(csv);
  assert.equal(p.familias.length, 1);
  assert.equal(p.familias[0].pai.sku, 'PAI-INFERIDO');
  assert.equal(p.familias[0].pai.origem, 'inferido');
  assert.equal(p.familias[0].totalVariantes, 2);
});

// ---------------------------------------------------------------------------
// 11. Duplicate SKU
// ---------------------------------------------------------------------------
test('duplicate SKU is reported as a family conflict, not silently deduplicated', async () => {
  const cab = 'sku;sku_pai;nome;cor;tamanho';
  const csv = [cab,
    'FILHO-1;PAI-X;CAMISETA;AZUL;M',
    'FILHO-1;PAI-X;CAMISETA;AZUL;M',
    'FILHO-2;PAI-X;CAMISETA;PRETO;G',
  ].join('\n');
  const arq = await arquivo('duplicado.csv', csv);
  const sem = interpretarCamposUniversal(arq);
  const hierarquia = planoHierarquiaDeMapeamentos(arq, mapeamentos(sem));
  assert.ok(hierarquia.familias.some((f) => !f.resolvida && f.conflitos.some((c) => c.tipo === 'sku_duplicado')));
  assert.ok(hierarquia.conflitos.some((c) => c.tipo === 'conflito_familia'));
  const entidades = reconhecerEntidadesUniversal(arq, sem, hierarquia.porAba);
  const result = reconciliarImportacaoUniversal(arq, semanticaConfirmada(sem), { ...entidades, hierarquia, dependencias: entidades.dependencias }, [], []);
  assert.ok(result.totais.conflito_familia >= 1);
  assert.ok(result.totais.duplicado_origem >= 1, 'existing duplicate-SKU blocker is preserved');
});

// ---------------------------------------------------------------------------
// 12. Existing parent-child relation in ERP; 13. idempotent reimport
// ---------------------------------------------------------------------------
test('existing ERP parent-child relation is reused and reimport is idempotent', async () => {
  const arq = await arquivo('catalogo-canonico.csv', csvCanonico);
  const sem = interpretarCamposUniversal(arq);
  const primeiro = planoHierarquiaDeMapeamentos(arq, mapeamentos(sem));
  const familia = primeiro.familias.find((f) => f.totalVariantes === 6)!;
  const erp = [
    { id: 100, sku: familia.pai.sku, nome: familia.pai.nome, produto_pai_id: null },
    ...familia.variantes.map((v, i) => ({ id: 101 + i, sku: v.sku, nome: v.nome, produto_pai_id: 100 })),
  ];
  const reimportado = planoHierarquiaDeMapeamentos(arq, mapeamentos(sem), { produtosERP: erp });
  const f2 = reimportado.familias.find((f) => f.chave === familia.chave)!;
  assert.equal(f2.pai.sku, familia.pai.sku, 'parent SKU is deterministic');
  assert.equal(f2.pai.acao, 'reutilizar');
  assert.ok(f2.variantes.every((v) => v.acao === 'atualizar'));
  assert.equal(reimportado.resumo.paisACriar, primeiro.resumo.paisACriar - 1);
  const terceiro = planoHierarquiaDeMapeamentos(arq, mapeamentos(sem), { produtosERP: erp });
  assert.deepEqual(terceiro.familias.map((f) => f.pai.sku), reimportado.familias.map((f) => f.pai.sku));
  assert.deepEqual(terceiro.familias.map((f) => f.variantes.map((v) => v.acao)), reimportado.familias.map((f) => f.variantes.map((v) => v.acao)));
});

// ---------------------------------------------------------------------------
// 14. Real family ambiguity: visible conflict, does not block the whole import
// ---------------------------------------------------------------------------
test('real ambiguity is shown in the preview and does not block other families', async () => {
  const cab = 'sku;familia_id;nome;cor;tamanho';
  const csv = [cab,
    'AMB-1;F1;CAMISETA GOLA O;AZUL;M',
    'AMB-2;F1;SHORT NAVALHADO;PRETO;G',
    'OK-1;F2;CAMISETA BORDADO;AZUL;M',
    'OK-2;F2;CAMISETA BORDADO;PRETO;G',
  ].join('\n');
  const arq = await arquivo('ambiguo.csv', csv);
  const sem = interpretarCamposUniversal(arq);
  const hierarquia = planoHierarquiaDeMapeamentos(arq, mapeamentos(sem));
  assert.equal(hierarquia.familias.length, 2);
  assert.ok(hierarquia.familias.some((f) => !f.resolvida && f.conflitos.some((c) => c.tipo === 'nome_base_divergente')));
  assert.ok(hierarquia.familias.some((f) => f.resolvida));
  const entidades = reconhecerEntidadesUniversal(arq, sem, hierarquia.porAba);
  const deps = construirModeloDependencias(entidades.entidades, entidades.relacionamentos, undefined, hierarquia.porAba);
  assert.equal(deps[0].estado, 'vinculada', 'ambiguity does not reintroduce the parent-sheet blocker');
  const result = reconciliarImportacaoUniversal(arq, semanticaConfirmada(sem), { ...entidades, hierarquia, dependencias: deps }, [], []);
  const conflito = result.divergencias.find((d) => d.tipo === 'conflito_familia');
  assert.ok(conflito);
  assert.equal((conflito?.detalhes as any)?.naoBloqueiaImportacao, true);
  assert.ok(result.previaConsolidada.registros.some((r) => r.status.includes('Conflito de família')));
  assert.ok(result.previaConsolidada.registros.some((r) => r.acaoPersistencia === 'criar'));
});

// ---------------------------------------------------------------------------
// 15. Preservation of price, cost, EAN, references and commercial policy
// ---------------------------------------------------------------------------
test('materialization payload preserves price, cost, EAN, references and policy', async () => {
  const { productImportPayload } = await import('../src/importacaoUniversalExecutor');
  const { RESOURCES } = await import('../src/resources');
  const arq = await arquivo('catalogo-canonico.csv', csvCanonico);
  const sem = interpretarCamposUniversal(arq);
  const hierarquia = planoHierarquiaDeMapeamentos(arq, mapeamentos(sem));
  const familia = hierarquia.familias.find((f) => f.totalVariantes === 6)!;
  assert.ok(familia.variantes.every((v) => /^789\d{10}$/.test(v.codigoBarras)));
  const entidades = reconhecerEntidadesUniversal(arq, sem, hierarquia.porAba);
  const result = reconciliarImportacaoUniversal(arq, semanticaConfirmada(sem), { ...entidades, hierarquia, dependencias: entidades.dependencias }, [], []);
  const previa = result.previaConsolidada.registros.find((r) => r.skuPai === familia.pai.sku)!;
  assert.equal(previa.mapeado.custo, '26,75');
  assert.equal(previa.mapeado.preco_venda, '79,90');
  assert.equal(previa.mapeado.preco_atacado, '59,90');
  assert.equal(previa.mapeado.atacado_vista, undefined, 'alias maps to the canonical condition-price field');
  assert.equal((previa.mapeado as any).preco_atacado_vista, '59,90');
  assert.ok((previa.mapeado as any).margem_bruta_atacado_vista);
  assert.equal((previa.mapeado as any).politica_comercial, 'ATACADO_PADRAO');
  const payload = productImportPayload(previa.mapeado as Record<string, unknown>, {}, RESOURCES.produtos, { categorias: [], colecoes: [], cores: [], fornecedores: [] });
  assert.equal(payload.custo, '26,75');
  assert.equal(payload.preco_venda, '79,90');
  assert.equal(payload.preco_atacado, '59,90');
  assert.equal(payload.codigo_barras, previa.mapeado.codigo_barras);
  const extras = payload.atributos_adicionais as Record<string, unknown>;
  assert.equal(extras.politica_comercial_origem, 'ATACADO_PADRAO');
  assert.equal(extras.referencia_comercial_origem, 'REF-DTF');
  assert.equal(extras.preco_atacado_vista_origem, '59,90');
  assert.equal(extras.margem_bruta_atacado_vista_origem, '35%');
});

// ---------------------------------------------------------------------------
// Regression: operational stock sheets keep the existing product validation
// ---------------------------------------------------------------------------
test('stock-only sheet is not converted into product hierarchy or independent products', async () => {
  const csv = 'sku;tamanho;quantidade;local\nSKU-ESTOQUE;M;11;LOJA\n';
  const arq = await arquivo('saldo.csv', csv);
  const analise = await analisarArquivoUniversal({ nomeArquivo: 'saldo.csv', bytes: Buffer.from(csv, 'utf8') });
  const aba = arq.abas[0].nome;
  assert.equal(analise.entidades.entidades[0].tipo, 'estoque');
  assert.equal(analise.hierarquia.porAba[aba]?.aplicavel, false);
  assert.equal(analise.hierarquia.familias.length, 0);
  assert.equal(analise.hierarquia.independentes.length, 0);
  const dep = analise.entidades.dependencias.find((d) => d.aba === aba);
  assert.equal(dep?.tipo, 'estoque');
  assert.equal(dep?.resolvidaNaOrigem, false);
  assert.equal(dep?.estado, 'pendente');
  const result = reconciliarImportacaoUniversal(
    arq,
    semanticaConfirmada(analise.semantica),
    { ...analise.entidades, hierarquia: analise.hierarquia, dependencias: analise.entidades.dependencias },
    [],
    [],
  );
  assert.ok(result.divergencias.some((d) => d.tipo === 'estoque_sem_produto'));
  assert.ok(!result.previaConsolidada.registros.some((r) => r.acaoPersistencia === 'produto independente'));
});

// ---------------------------------------------------------------------------
// Real CSV fixture when available in the repository / execution environment
// ---------------------------------------------------------------------------
test('real audited catalog CSV is used as fixture when present', async () => {
  const candidatos = [
    `${raiz}/Brobond_241_Produtos_Canonico_Comercial_Auditado.csv`,
    `${raiz}/data/migrations/universal-ingestion/Brobond_241_Produtos_Canonico_Comercial_Auditado.csv`,
    `${raiz}/server/test/fixtures/Brobond_241_Produtos_Canonico_Comercial_Auditado.csv`,
    '/tmp/Brobond_241_Produtos_Canonico_Comercial_Auditado.csv',
  ];
  const real = candidatos.find((c) => existsSync(c));
  if (!real) {
    assert.ok(existsSync(FIXTURE), 'canonical structure fixture is always available');
    assert.ok(csvCanonico.includes('codigo_base'));
    return;
  }
  const conteudo = readFileSync(real, 'utf8');
  const arq = await arquivo('Brobond_241_Produtos_Canonico_Comercial_Auditado.csv', conteudo);
  const sem = interpretarCamposUniversal(arq);
  const hierarquia = planoHierarquiaDeAnalise(arq, sem);
  assert.ok(hierarquia);
  assert.ok(Array.isArray(hierarquia.familias));
  assert.ok(Object.keys(hierarquia.porAba).length >= 1);
  const entidades = reconhecerEntidadesUniversal(arq, sem, hierarquia.porAba);
  assert.ok(entidades.dependencias.length >= 1);
});
