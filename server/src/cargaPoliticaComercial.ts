// ============================================================================
// CARGA OFICIAL DA POLÍTICA COMERCIAL — importação da planilha-base do ERP.
//
// A planilha ("TABELA DE PREÇO BASE PARA ERP.xlsx") é a fonte canônica do
// catálogo, identificadores, atributos, custos, política comercial e saldo
// físico inicial. O servidor recalcula preço, margem e tributos; a memória do
// cálculo fica associada ao SKU e às faixas de quantidade.
//
// Princípios:
//   • importa três fontes: Política Comercial Completa, BASE CONTROLE DE ESTOQUE
//     e Política Comercial Roupas (2);
//   • preserva Item/IDs da planilha e Código Industria como SKU (texto);
//   • consolida o estoque inicial das abas de saldo/contagem em um único local
//     LOJA; não cria saldos para varejo, atacado ou representantes;
//   • saídas históricas já abatidas no saldo da planilha não são reaplicadas;
//   • fórmulas externas não são executadas no servidor: o cálculo é reproduzido
//     com os parâmetros de entrada da própria planilha, com conferências;
//   • idempotente por SKU, faixa de quantidade e célula física canônica.
//
// Endpoints:
//   POST /api/carga/politica-comercial/preview   { conteudo, nome }  → prévia
//   POST /api/carga/politica-comercial/confirmar { conteudo, nome }  → grava
//
// O parse é deliberadamente específico do LEIAUTE desta planilha (nomes de
// coluna e linha de cabeçalho fixos): um importador genérico perderia os
// identificadores de origem que o adendo exige preservar. O servidor RE-LÊ o
// arquivo na confirmação — nunca grava payload montado pelo cliente.
// ============================================================================
import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { HttpError } from './errors';
import { empresaDoAtorAudit } from './empresa';
import { RESOURCES } from './resources';
import { checkAccess, escopoDe, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import { parseNumeroTexto } from './csv';
import { isValidGtin } from './ean';
import { round2 } from './utils';
import { validatePayload } from './validate';
import type { Payload, Row, Tx } from './store';

export const ABA_FONTE = 'Política Comercial Completa';
export const LINHA_CABECALHO = 11;
export const PRIMEIRA_LINHA_DADOS = 12;
export const LIMITE_CARGA = 5000;

// ---------------------------------------------------------------------------
// Classificação das colunas: entrada × conferência × ignorada.
// ---------------------------------------------------------------------------
export type NaturezaColuna = 'entrada' | 'conferencia' | 'ignorada';

// ---------------------------------------------------------------------------
// PARÂMETROS E RESULTADOS DA POLÍTICA COMERCIAL.
//
// Custo de fabricação/aquisição, alíquotas, margens-alvo e fatores financeiros
// são entradas. O servidor recalcula custo tributado e preço por condição;
// valores monetários e margens resultantes da planilha servem para conferência.
// Os preços finais ficam em `produto_precos_condicao` com faixa de quantidade,
// margem efetiva, ajuste financeiro e memória JSON da fórmula.
// `preco_venda`/`preco_atacado` recebem o preço-base unitário de cada canal
// para compatibilidade com integrações que exibem uma única faixa.
//
// O rótulo casa por nome normalizado (sem acento, minúsculo), tolerando
// espaços duplicados e o erro de digitação da origem ("Débido").
// ---------------------------------------------------------------------------
export type PrecoOficial = {
  rotulo: string;
  canal: 'atacado' | 'varejo';
  condicao: string;
  base?: 'atacado' | 'varejo';
  quantidade_minima?: number;
};
export const PRECOS_OFICIAIS: PrecoOficial[] = [
  { rotulo: 'Atacado À Vista', canal: 'atacado', condicao: 'atacado_vista', base: 'atacado', quantidade_minima: 1 },
  { rotulo: 'Atacado Boleto 30', canal: 'atacado', condicao: 'boleto_30', quantidade_minima: 1 },
  { rotulo: 'Atacado Boleto 30/60', canal: 'atacado', condicao: 'boleto_30_60', quantidade_minima: 1 },
  { rotulo: 'Atacado Boleto 30/60/90', canal: 'atacado', condicao: 'boleto_30_60_90', quantidade_minima: 1 },
  { rotulo: 'Atacado Cartão Débido', canal: 'atacado', condicao: 'cartao_debito', quantidade_minima: 1 },
  { rotulo: 'Atacado Cartão Crédito à vista', canal: 'atacado', condicao: 'cartao_credito_vista', quantidade_minima: 1 },
  { rotulo: 'Atacado Cartão Crédito 30/60', canal: 'atacado', condicao: 'cartao_credito_30_60', quantidade_minima: 1 },
  { rotulo: 'Atacado Cartão Crédito 30/60/90', canal: 'atacado', condicao: 'cartao_credito_30_60_90', quantidade_minima: 1 },
  { rotulo: 'Varejo À Vista', canal: 'varejo', condicao: 'varejo_vista', base: 'varejo', quantidade_minima: 1 },
  // A faixa de 2 unidades é o MESMO pagamento à vista, com preço unitário
  // reduzido. Não é uma forma de pagamento nova: quantidade_minima diferencia a faixa.
  { rotulo: 'VRJ 2 Un', canal: 'varejo', condicao: 'varejo_vista', quantidade_minima: 2 },
  { rotulo: 'Vlr Cartão à Vista', canal: 'varejo', condicao: 'cartao_vista', quantidade_minima: 1 },
  { rotulo: 'Vlr Cartão Parcelado', canal: 'varejo', condicao: 'cartao_parcelado', quantidade_minima: 2 },
];
const PRECOS_OFICIAIS_POR_ROTULO = new Map(PRECOS_OFICIAIS.map((p) => [normalizarRotulo(p.rotulo), p]));

// ---------------------------------------------------------------------------
// FONTES DE CADASTRO da planilha (todas as abas que trazem CADASTRO).
//
// A aba principal é a fonte canônica dos produtos com preço por condição. DUAS
// abas adicionais trazem universos de produto DISTINTOS (códigos que nunca
// colidem com a principal) — ignorá-las deixaria produtos FORA do ERP, que foi
// exatamente a lacuna apontada pelo Diretor:
//   • "BASE CONTROLE DE ESTOQUE" — SKUs de controle (1001P…), custo e preços;
//   • "Política Comercial Roupas (2)" — shorts de fornecedor (93882-40…), custo.
//
// As abas de MOVIMENTAÇÃO (entrada, saída, venda diária, situação de estoque)
// NÃO são cadastro: o adendo proíbe importá-las como fato transacional. Elas só
// entram na reconciliação (relatório), nunca como produto/estoque/quantidade.
// ---------------------------------------------------------------------------
export type FonteCadastro = 'principal' | 'controle_estoque' | 'roupas';
export type FonteSpec = { id: FonteCadastro; aba: string; cabecalho: number; primeira_linha: number; descricao: string };
export const FONTES_CADASTRO: FonteSpec[] = [
  { id: 'principal', aba: ABA_FONTE, cabecalho: LINHA_CABECALHO, primeira_linha: PRIMEIRA_LINHA_DADOS, descricao: 'Vestuário/óculos com preço por condição (fonte canônica).' },
  { id: 'controle_estoque', aba: 'BASE CONTROLE DE ESTOQUE', cabecalho: 11, primeira_linha: 12, descricao: 'SKUs de controle de estoque (código próprio) com custo e preços-base.' },
  { id: 'roupas', aba: 'Política Comercial Roupas (2)', cabecalho: 4, primeira_linha: 5, descricao: 'Roupas de fornecedor (código próprio) com custo e preço de venda.' },
];

/** Preços OFICIAIS explícitos da aba "Política Comercial Roupas (2)". */
export const PRECOS_ROUPAS: PrecoOficial[] = [
  { rotulo: 'Preço à Vista  10% Desc.', canal: 'varejo', condicao: 'varejo_vista', base: 'varejo' },
  { rotulo: 'Preço de Venda Cartão', canal: 'varejo', condicao: 'cartao_parcelado' },
];
const PRECOS_ROUPAS_POR_ROTULO = new Map(PRECOS_ROUPAS.map((p) => [normalizarRotulo(p.rotulo), p]));

/**
 * Preços OFICIAIS da aba "BASE CONTROLE DE ESTOQUE" (rótulos próprios). Só as
 * colunas de preço explícitas entram; as colunas com sufixo ("…2") são
 * duplicatas calculadas e NÃO casam (o rótulo normalizado é diferente).
 */
export const PRECOS_CONTROLE: PrecoOficial[] = [
  { rotulo: 'ATACADO À Vista Min. 10 Pças', canal: 'atacado', condicao: 'atacado_vista', base: 'atacado', quantidade_minima: 10 },
  { rotulo: 'ATACADO BOLETO Mín. 10 pças', canal: 'atacado', condicao: 'boleto_30', quantidade_minima: 10 },
  { rotulo: 'VRJ À VISTA', canal: 'varejo', condicao: 'varejo_vista', base: 'varejo', quantidade_minima: 1 },
  { rotulo: 'VRJ =/> 2 PÇ', canal: 'varejo', condicao: 'varejo_vista', quantidade_minima: 2 },
  { rotulo: 'VR CARTÃO À VISTA', canal: 'varejo', condicao: 'cartao_vista', quantidade_minima: 1 },
  { rotulo: 'VRJ =/> 2 PÇ CARTÃO PRAZO', canal: 'varejo', condicao: 'cartao_parcelado', quantidade_minima: 2 },
];
const PRECOS_CONTROLE_POR_ROTULO = new Map(PRECOS_CONTROLE.map((p) => [normalizarRotulo(p.rotulo), p]));

/** Localiza uma aba pelo nome exato ou normalizado (tolera acento/espaço). */
export function localizarAba(wb: ExcelJS.Workbook, nome: string): ExcelJS.Worksheet | null {
  return wb.getWorksheet(nome) ?? wb.worksheets.find((w) => normalizarRotulo(w.name) === normalizarRotulo(nome)) ?? null;
}

/** Condição de pagamento correspondente (cadastro estrutural) para cada preço. */
export const CONDICOES_DAS_PLANILHA: { codigo: string; nome: string; canal: 'atacado' | 'varejo'; parcelas: number; prazo_dias: number }[] = [
  { codigo: 'atacado_vista', nome: 'Atacado à vista', canal: 'atacado', parcelas: 1, prazo_dias: 0 },
  { codigo: 'boleto_30', nome: 'Atacado boleto 30', canal: 'atacado', parcelas: 1, prazo_dias: 30 },
  { codigo: 'boleto_30_60', nome: 'Atacado boleto 30/60', canal: 'atacado', parcelas: 2, prazo_dias: 30 },
  { codigo: 'boleto_30_60_90', nome: 'Atacado boleto 30/60/90', canal: 'atacado', parcelas: 3, prazo_dias: 30 },
  { codigo: 'cartao_debito', nome: 'Atacado cartão débito', canal: 'atacado', parcelas: 1, prazo_dias: 0 },
  { codigo: 'cartao_credito_vista', nome: 'Atacado cartão crédito à vista', canal: 'atacado', parcelas: 1, prazo_dias: 0 },
  { codigo: 'cartao_credito_30_60', nome: 'Atacado cartão crédito 30/60', canal: 'atacado', parcelas: 2, prazo_dias: 30 },
  { codigo: 'cartao_credito_30_60_90', nome: 'Atacado cartão crédito 30/60/90', canal: 'atacado', parcelas: 3, prazo_dias: 30 },
  { codigo: 'varejo_vista', nome: 'Varejo à vista', canal: 'varejo', parcelas: 1, prazo_dias: 0 },
  { codigo: 'cartao_vista', nome: 'Varejo cartão à vista', canal: 'varejo', parcelas: 1, prazo_dias: 0 },
  { codigo: 'cartao_parcelado', nome: 'Varejo cartão parcelado', canal: 'varejo', parcelas: 3, prazo_dias: 0 },
];

const CLASSIFICACAO: { match: RegExp; natureza: NaturezaColuna; nota: string }[] = [
  { match: /^item$/, natureza: 'entrada', nota: 'Identificador sequencial da origem.' },
  { match: /^cod categoria$/, natureza: 'entrada', nota: 'Código de categoria da origem.' },
  { match: /^marca$/, natureza: 'entrada', nota: 'Marca.' },
  { match: /^categoria master$/, natureza: 'entrada', nota: 'Categoria principal (vira a categoria do ERP).' },
  { match: /^cole[cç][aã]o$/, natureza: 'entrada', nota: 'Coleção.' },
  { match: /^variante cor$/, natureza: 'entrada', nota: 'Variante de cor.' },
  { match: /^descri[cç][aã]o$/, natureza: 'entrada', nota: 'Descrição comercial.' },
  { match: /^tamanho$/, natureza: 'entrada', nota: 'Tamanho da variação.' },
  { match: /^c[oó]digo industria$/, natureza: 'entrada', nota: 'Código da indústria (SKU canônico).' },
  { match: /^tipo$/, natureza: 'entrada', nota: 'Tipo/unidade do produto.' },
  { match: /^status$/, natureza: 'entrada', nota: 'Status cadastral.' },
  { match: /^peso kg$/, natureza: 'entrada', nota: 'Peso em quilogramas.' },
  { match: /^altura\s*cm$/, natureza: 'entrada', nota: 'Altura em centímetros.' },
  { match: /^largura\s*cm$/, natureza: 'entrada', nota: 'Largura em centímetros.' },
  { match: /^comprimento ou profundidade\s*cm$/, natureza: 'entrada', nota: 'Comprimento/profundidade em centímetros.' },
  { match: /^custo unit[aá]rio fabrica[cç][aã]o$/, natureza: 'entrada', nota: 'Custo unitário de fabricação (custo-base).' },
  // Taxas e margens são PARÂMETROS da política; valores monetários e totais derivados são conferência.
  { match: /^simples nacional$/, natureza: 'entrada', nota: 'Alíquota de Simples Nacional usada na formação do custo.' },
  { match: /^icms2?$/, natureza: 'entrada', nota: 'Alíquota fiscal usada na formação do custo.' },
  { match: /mgb|mgl|margem/, natureza: 'entrada', nota: 'Margem-alvo da política comercial usada pelo ERP para recalcular o preço.' },
  { match: /simples nacional valor|total imposto|total valor|custo\s*tt|valor imposto/, natureza: 'conferencia', nota: 'Valor fiscal/custo calculado na planilha; o ERP recalcula e compara.' },
  { match: /atacado|varejo|vrj|cart[aã]o|boleto|parcelad|d[eé]bito|desc|subtotal|combo|condi[cç][oõ]es/, natureza: 'conferencia', nota: 'Preço/desconto da planilha — referência para conferência.' },
];

/** Normaliza o cabeçalho: sem acento, minúsculo, espaços colapsados. */
export function normalizarRotulo(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Classifica uma coluna pelo rótulo. Desconhecida → 'ignorada'. */
export function classificarColuna(rotulo: string): { natureza: NaturezaColuna; nota: string } {
  const r = normalizarRotulo(rotulo);
  if (!r || /^coluna\d+$/.test(r)) return { natureza: 'ignorada', nota: 'Coluna sem rótulo/auxiliar da planilha.' };
  // Os valores monetários da aba principal são SAÍDAS da formação de preço.
  // O importador os usa somente para conferência; parâmetros de custo, alíquota,
  // margem e taxa financeira são lidos como entradas e recalculados no ERP.
  if (PRECOS_OFICIAIS_POR_ROTULO.has(r)) return { natureza: 'conferencia', nota: 'Preço resultante da planilha — conferido contra a formação de preço do ERP.' };
  for (const c of CLASSIFICACAO) if (c.match.test(r)) return { natureza: c.natureza, nota: c.nota };
  return { natureza: 'ignorada', nota: 'Coluna não reconhecida — depende de validação.' };
}

// ---------------------------------------------------------------------------
// Leitura do arquivo.
// ---------------------------------------------------------------------------
export type LinhaBruta = { linha: number; celulas: Record<string, string> };
export type ParametrosPrecificacaoPlanilha = {
  ajustes_por_condicao: Record<string, number | null>;
  desconto_varejo_2un_pct: number | null;
  linha_parametros: number;
};
export type Leitura = {
  aba: string;
  fonte: FonteCadastro;
  cabecalho: string[];
  linhas: LinhaBruta[];
  classificacao: { coluna: string; natureza: NaturezaColuna; nota: string }[];
  parametros_precificacao: ParametrosPrecificacaoPlanilha | null;
};

/** Converte um valor de célula em texto preservando identificadores. */
export function celulaTexto(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const obj = v as { text?: unknown; result?: unknown; richText?: unknown };
    if (Array.isArray(obj.richText)) return obj.richText.map((t: any) => String(t?.text ?? '')).join('');
    if (obj.text !== undefined) return String(obj.text);
    if (obj.result !== undefined) return String(obj.result);
    return String(v);
  }
  return String(v);
}

/**
 * Os fatores da linha imediatamente acima do cabeçalho pertencem às colunas
 * comerciais correspondentes. Ex.: boleto 30/60 = 8% significa preço-base /
 * (1 - 0,08). A linha 10 é dado de política, não preço final.
 */
function extrairParametrosPrecificacao(
  ws: ExcelJS.Worksheet,
  spec: FonteSpec,
): ParametrosPrecificacaoPlanilha | null {
  if (spec.id !== 'principal') return null;
  const cab = ws.getRow(spec.cabecalho);
  const fatores: Record<string, number | null> = {};
  let descontoVarejo2Un: number | null = null;
  for (let c = 1; c <= Math.max(ws.columnCount || 0, cab.cellCount || 0); c++) {
    const rotulo = normalizarRotulo(celulaTexto(cab.getCell(c).value));
    if (!rotulo) continue;
    const specPreco = PRECOS_OFICIAIS_POR_ROTULO.get(rotulo);
    if (!specPreco) continue;
    const valor = numero(celulaTexto(ws.getRow(spec.cabecalho - 1).getCell(c).value));
    const taxa = valor === null ? null : Math.abs(valor) > 1 ? valor / 100 : valor;
    const quantidadeMinima = specPreco.quantidade_minima ?? 1;
    fatores[`${specPreco.condicao}|${quantidadeMinima}`] = taxa;
    if (rotulo === normalizarRotulo('VRJ 2 Un')) descontoVarejo2Un = taxa;
  }
  return {
    ajustes_por_condicao: fatores,
    desconto_varejo_2un_pct: descontoVarejo2Un,
    linha_parametros: spec.cabecalho - 1,
  };
}

/** Lê uma aba-fonte (cabeçalho e dados em linhas configuráveis por fonte). */
export function extrairLinhas(ws: ExcelJS.Worksheet, spec: FonteSpec = FONTES_CADASTRO[0]): Leitura {
  const cabRow = ws.getRow(spec.cabecalho);
  const cabecalho: string[] = [];
  const colunas: { index: number; rotulo: string }[] = [];
  const maxCol = Math.max(ws.columnCount || 0, cabRow.cellCount || 0);
  for (let c = 1; c <= maxCol; c++) {
    const rotulo = celulaTexto(cabRow.getCell(c).value).replace(/\s+/g, ' ').trim();
    cabecalho.push(rotulo);
    colunas.push({ index: c, rotulo });
  }
  const linhas: LinhaBruta[] = [];
  for (let r = spec.primeira_linha; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const celulas: Record<string, string> = {};
    let vazia = true;
    for (const { index, rotulo } of colunas) {
      if (!rotulo) continue;
      const texto = celulaTexto(row.getCell(index).value).trim();
      if (texto) vazia = false;
      celulas[rotulo] = texto;
    }
    if (vazia) continue;
    linhas.push({ linha: r, celulas });
  }
  const classificacao = cabecalho.filter((c) => c).map((coluna) => ({ coluna, ...classificarColuna(coluna) }));
  return {
    aba: ws.name,
    fonte: spec.id,
    cabecalho: cabecalho.filter((c) => c),
    linhas,
    classificacao,
    parametros_precificacao: extrairParametrosPrecificacao(ws, spec),
  };
}

/**
 * Códigos de barras VÁLIDOS da aba auxiliar. A aba traz uma concatenação
 * (coleção+cor+SKU), que NÃO é GTIN — o adendo proíbe tratá-la como código de
 * barras. Só devolvemos entradas que passam no dígito verificador GS1.
 */
export function extrairCodigosBarras(wb: ExcelJS.Workbook): { mapa: Map<string, string>; invalidos: number; concat: number } {
  const mapa = new Map<string, string>();
  const ws = wb.getWorksheet('Código de Barras') ?? wb.worksheets.find((w) => normalizarRotulo(w.name) === normalizarRotulo('Código de Barras'));
  let invalidos = 0;
  let concat = 0;
  if (!ws) return { mapa, invalidos, concat };
  let headerRow = 0;
  let colCodigo = 0;
  let colIndustria = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
    const row = ws.getRow(r);
    for (let cc = 1; cc <= row.cellCount; cc++) {
      const rot = normalizarRotulo(celulaTexto(row.getCell(cc).value));
      if (rot === 'codigo barra') { colCodigo = cc; headerRow = r; }
      if (rot === 'codigo industria') colIndustria = cc;
    }
    if (headerRow) break;
  }
  if (!headerRow || !colCodigo || !colIndustria) return { mapa, invalidos, concat };
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const industria = celulaTexto(row.getCell(colIndustria).value).trim();
    const codigo = celulaTexto(row.getCell(colCodigo).value).trim();
    if (!industria || !codigo) continue;
    if (isValidGtin(codigo)) mapa.set(industria, codigo);
    else if (/[A-Za-z]/.test(codigo)) concat++;
    else invalidos++;
  }
  return { mapa, invalidos, concat };
}

/**
 * Remove as partes de TABELA/AUTOFILTRO do pacote XLSX antes de entregá-lo ao
 * ExcelJS. O workbook de origem declara uma tabela (`xl/tables/*.xml`) que o
 * ExcelJS não consegue ler — ele espera uma coluna por referência de autofiltro
 * e estoura com "Cannot set properties of undefined (setting 'filterButton')".
 * A tabela é só formatação (autofiltro/estilo de faixa); removê-la não altera
 * NENHUM valor de célula, que é tudo o que a carga lê.
 */
export async function sanitizarXlsx(buf: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    // Não é um zip válido: devolve como veio e deixa o ExcelJS dar o erro claro.
    return buf;
  }
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/tables\//.test(name)) {
      delete zip.files[name];
      continue;
    }
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      const x = await zip.files[name].async('string');
      zip.file(name, x.replace(/<tableParts[\s\S]*?<\/tableParts>/g, '').replace(/<tableParts[^>]*\/>/g, ''));
      continue;
    }
    if (/^xl\/worksheets\/_rels\//.test(name)) {
      const x = await zip.files[name].async('string');
      zip.file(name, x.replace(/<Relationship[^>]*\/table[^"]*"[^>]*\/>/gi, ''));
      continue;
    }
  }
  const ct = zip.files['[Content_Types].xml'];
  if (ct) {
    const x = await ct.async('string');
    zip.file('[Content_Types].xml', x.replace(/<Override[^>]*PartName="\/xl\/tables\/[^"]*"[^>]*\/>/gi, ''));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Carrega um workbook XLSX a partir do conteúdo base64 do corpo. */
export async function abrirWorkbook(conteudo: string, nome: string): Promise<ExcelJS.Workbook> {
  const c = String(conteudo ?? '').trim();
  if (!c) throw new HttpError(400, 'Envie o conteúdo do arquivo XLSX em base64.');
  if (String(nome ?? '').toLowerCase().endsWith('.csv')) throw new HttpError(400, `Use a planilha XLSX com a aba "${ABA_FONTE}".`);
  try {
    const buf = Buffer.from(c.replace(/^data:[^,]+,/, ''), 'base64');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await sanitizarXlsx(buf)) as any);
    return wb;
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `Não foi possível ler o XLSX: ${e?.message || 'arquivo inválido'}`);
  }
}

/** Seleciona a aba-fonte, com mensagem útil quando ela não existe. */
export function abaFonte(wb: ExcelJS.Workbook): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(ABA_FONTE) ?? wb.worksheets.find((w) => normalizarRotulo(w.name) === normalizarRotulo(ABA_FONTE));
  if (!ws) throw new HttpError(400, `A planilha não contém a aba "${ABA_FONTE}". Abas encontradas: ${wb.worksheets.map((w) => w.name).join(', ')}.`);
  return ws;
}

// ---------------------------------------------------------------------------
// Normalização de uma linha em item de cadastro.
// ---------------------------------------------------------------------------
export type ItemNormalizado = {
  linha: number;
  fonte: FonteCadastro;
  item: string;
  codigo_categoria: string;
  categoria_master: string;
  colecao: string;
  cor: string;
  descricao: string;
  tamanho: string;
  codigo_industria: string;
  tipo: string;
  status: string;
  peso_g: number | null;
  altura_mm: number | null;
  largura_mm: number | null;
  profundidade_mm: number | null;
  custo_base: number | null;
  marca: string;
  codigo_barras: string | null;
  familia: string;
  nome_pai: string;
  pai_sku: string;
  /** Unidade de medida normalizada do "Tipo" da origem (PÇ→pc, UN→un). */
  unidade: string | null;
  /** Nome do fornecedor da origem, quando a aba traz (ex.: Roupas). */
  fornecedor: string;
  /** Formação de preço calculada pelo servidor a partir das entradas da planilha. */
  calculo_precificacao: FormacaoPrecoCalculada | null;
  erros_precificacao: string[];
  /**
   * Propriedades da origem sem coluna tipada. Nunca substituem SKU, preço,
   * custos, política tributária ou estoque.
   */
  atributos_adicionais: Record<string, string>;
  /** Preços calculados pelo servidor (fonte principal) ou preços explícitos das fontes complementares. */
  precos: PrecoCalculado[];
};

export type PrecoCalculado = {
  canal: 'atacado' | 'varejo';
  condicao: string;
  quantidade_minima: number;
  preco: number;
  margem_pct: number | null;
  ajuste_pct: number;
  regra_calculo: Record<string, unknown>;
};

export type FormacaoPrecoCalculada = {
  /** Custo informado. Nas fontes principais é custo de fabricação; em roupas é custo de aquisição. */
  custo_fabricacao: number | null;
  custo_aquisicao_unitario: number | null;
  simples_nacional_pct: number | null;
  simples_nacional_valor: number | null;
  icms_pct: number | null;
  icms2_pct: number | null;
  icms_valor: number | null;
  icms2_valor: number | null;
  total_imposto_pct: number | null;
  total_imposto_valor: number | null;
  /** Custo unitário efetivamente usado na fórmula de preço. */
  custo_total: number;
  /** Só é preenchido quando a fonte contém alíquotas suficientes para calcular o custo tributado. */
  custo_total_com_impostos: number | null;
  margem_atacado_pct: number | null;
  margem_varejo_pct: number | null;
  margem_varejo_2un_pct: number | null;
  margem_varejo_cartao_pct: number | null;
  margem_varejo_combo_cartao_pct: number | null;
  memoria: Record<string, unknown>;
  conferencias: { campo: string; valor_planilha: number; valor_erp: number; diferenca: number; status: 'confere' | 'diverge' }[];
};

/** Busca tolerante ao rótulo: casa por nome normalizado (aceita \n e espaços). */
function pegar(celulas: Record<string, string>, ...rotulos: string[]): string {
  const alvos = rotulos.map(normalizarRotulo);
  for (const [k, v] of Object.entries(celulas)) {
    if (alvos.includes(normalizarRotulo(k))) return v;
  }
  return '';
}

const STATUS_VALIDOS = new Set(['ATIVO', 'INATIVO']);

/** Normaliza o tamanho: sem espaços, maiúsculo (a planilha traz " P", "p"). */
export function normalizarTamanho(t: string): string {
  return String(t ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Códigos de "Tipo" da origem → unidade de medida canônica do ERP. */
const UNIDADE_POR_TIPO: Record<string, string> = {
  'PC': 'pc', 'PÇ': 'pc', 'PCS': 'pc', 'PECA': 'pc', 'PEÇA': 'pc',
  'UN': 'un', 'UND': 'un', 'UNID': 'un', 'UNIDADE': 'un',
  'KG': 'kg', 'G': 'g', 'M': 'm', 'CM': 'cm', 'L': 'l', 'RL': 'rl', 'CX': 'cx', 'PCT': 'pct',
};

/**
 * Traduz o "Tipo" da planilha para a unidade de medida do ERP. Sem
 * correspondência conhecida devolve `null` — a unidade NÃO é inventada (o
 * recurso aplica o default `un`); o valor bruto fica em `atributos_adicionais`.
 */
export function unidadeDoTipo(tipo: string): string | null {
  const t = normalizarRotulo(tipo).toUpperCase().replace(/[.\s]/g, '');
  return UNIDADE_POR_TIPO[t] ?? null;
}

/** Rótulos de coluna que já viram coluna tipada — não repetir em atributos. */
const ROTULOS_TIPADOS = new Set([
  'item', 'cod categoria', 'marca', 'categoria master', 'categoria', 'colecao', 'coleção',
  'variante cor', 'subcategoria', 'descricao', 'descrição', 'descricao do produto/servico2',
  'descricao do produto/servico', 'tamanho', 'codigo industria', 'tipo', 'status', 'fornecedor',
  'peso kg', 'altura cm', 'largura cm', 'comprimento ou profundidade cm',
  'custo unitario fabricacao', 'valor unitario custo',
]);

/**
 * Colunas que NÃO são cadastro e por isso NUNCA entram em `atributos_adicionais`:
 * quantidade/saldo de estoque (movimento), preço (tabela própria), margem/
 * imposto/faturamento (cálculo da planilha — só conferência), data/compra/venda
 * (fato) e colunas auxiliares sem rótulo. Guardá-las como "atributo" do produto
 * faria o ERP tratar fórmula e movimento como cadastro — exatamente o que a
 * regra proíbe.
 */
const NAO_CADASTRAL = /\bqtd\b|quantidade|estoque|saldo|preco|preço|valor|vrj|atacado|varejo|cart[aã]o|boleto|parcel|desconto|\bdesc\b|combo|subtotal|frete|faturamento|lucro|margem|total|imposto|\bpis\b|cofins|\bicms\b|simples|\bipi\b|\biss\b|csll|irpj|\bcusto\b|\bdata\b|compra|venda|entrada|sa[ií]da|movimenta|vencimento|previs[aã]o|coluna\d/;

/**
 * Propriedades de cadastro da linha que NÃO têm coluna tipada própria (colunas
 * próprias de cada aba, metadados de fornecedor) — preservadas para não
 * descartar informação em silêncio. Preço, cálculo e movimento ficam FORA (ver
 * NAO_CADASTRAL): preço tem tabela própria e margem/imposto é conferência.
 */
export function atributosAdicionais(celulas: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const fornecedor = pegar(celulas, 'Fornecedor').trim();
  if (fornecedor) out['Fornecedor'] = fornecedor;
  for (const [rotulo, valor] of Object.entries(celulas)) {
    const v = String(valor ?? '').trim();
    if (!v) continue;
    const r = normalizarRotulo(rotulo);
    if (!r || ROTULOS_TIPADOS.has(r)) continue;
    const classe = classificarColuna(rotulo);
    // Só a coluna NÃO reconhecida é preservada como atributo livre.
    if (classe.natureza !== 'ignorada') continue;
    if (NAO_CADASTRAL.test(r)) continue;
    if (Object.prototype.hasOwnProperty.call(out, rotulo)) continue;
    out[rotulo] = v.slice(0, 200);
    if (Object.keys(out).length >= 25) break;
  }
  return out;
}

/** Descrição-base do produto-pai: remove o sufixo de cor da descrição. */
export function descricaoBase(descricao: string, cor: string): string {
  const d = String(descricao ?? '').trim();
  const c = String(cor ?? '').trim();
  if (c && d.toUpperCase().endsWith(c.toUpperCase())) return d.slice(0, d.length - c.length).replace(/\s+$/, '');
  return d;
}

/**
 * Remove a COR da descrição onde ela apareça como palavra isolada. Nas abas de
 * controle de estoque a cor vem no MEIO da descrição ("…GOLA O BRANCA BORDADO BB"),
 * não no fim — sem isso cada cor viraria um produto-pai distinto em vez de um
 * eixo de variação do mesmo produto.
 */
export function descricaoSemCor(descricao: string, cor: string): string {
  const d = String(descricao ?? '').trim();
  const c = String(cor ?? '').trim();
  if (!c) return d;
  const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sem = d
    .replace(new RegExp(`(^|[^0-9A-Za-zÀ-ÿ])${esc}(?=[^0-9A-Za-zÀ-ÿ]|$)`, 'gi'), '$1 ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—]\s*$/, '')
    .trim();
  return sem || d;
}

/**
 * Remove o sufixo de tamanho da descrição (ex.: "CAMISETA … - P" → "CAMISETA …").
 *
 * O tamanho só é removido como TOKEN isolado no fim (precedido de separador ou
 * fronteira de palavra). Sem isso, "MARFIM" com tamanho "M" viraria "MARFI" — e
 * a família do produto se PARTIA em duas (bug real da planilha).
 */
export function descricaoSemTamanho(descricao: string, tamanho: string): string {
  const d = String(descricao ?? '').trim();
  const t = String(tamanho ?? '').trim();
  if (!t) return d;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sem = d
    .replace(new RegExp(`[\\s:—–-]+${esc}\\s*$`, 'i'), '')
    .replace(new RegExp(`\\b${esc}\\s*$`, 'i'), '')
    .replace(/\b(tamanho|tam)\b\s*[:\-–—]*\s*$/i, '')
    .replace(/[\s:—–-]+$/, '')
    .trim();
  return sem || d;
}

/**
 * Quebra o código da aba "Roupas" no par produto × tamanho. Os códigos têm a
 * forma `PRODUTO[-COR]-TAMANHO` (ex.: `93882-40`, `94004-AREIA-42`,
 * `94000-branco-gg`): o produto é o prefixo numérico e o ÚLTIMO segmento é o
 * tamanho (P/M/G/GG/XG/EG ou número). Sem separar, dois tamanhos do MESMO produto
 * (93845-40 × 93845-42) nasceriam como dois produtos independentes.
 */
export function parseCodigoRoupas(codigo: string): { produto: string; cor: string; tamanho: string } {
  const partes = String(codigo ?? '').trim().split('-').map((s) => s.trim()).filter(Boolean);
  if (!partes.length) return { produto: '', cor: '', tamanho: '' };
  const ehTamanho = (s: string) => /^(XXG|XG|GG|EG|P|M|G|\d{2})$/.test(normalizarTamanho(s));
  const produto = partes[0];
  let tamanho = '';
  if (partes.length > 1 && ehTamanho(partes[partes.length - 1])) tamanho = normalizarTamanho(partes[partes.length - 1]);
  const meio = tamanho ? partes.slice(1, -1) : partes.slice(1);
  return { produto, cor: meio.join(' ').trim(), tamanho };
}

/** Slug determinístico de SKU: sem acento, maiúsculo, só A–Z, 0–9 e hífen. */
export function slugSku(valor: unknown): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** SKU do produto-pai, derivado da família (categoria master + coleção). */
export function skuPaiDe(categoriaMaster: string, colecao: string): string {
  return [slugSku(categoriaMaster), slugSku(colecao)].filter(Boolean).join('-').slice(0, 40);
}

/** Discriminador estável (base36, 6 chars) de uma chave — desempata SKU de pai. */
export function hashChave(chave: string): string {
  let h = 5381;
  for (let i = 0; i < chave.length; i++) h = ((h * 33) ^ chave.charCodeAt(i)) >>> 0;
  // Os dígitos MENOS significativos variam mais entre chaves vizinhas; pegar os
  // de maior ordem ("slice(0,6)") faria chaves como "roupas|5" e "roupas|6"
  // colidirem.
  return h.toString(36).toUpperCase().padStart(6, '0').slice(-6);
}

function numero(v: string): number | null {
  const n = parseNumeroTexto(v);
  return n === null || !Number.isFinite(n) ? null : n;
}

function cmParaMm(cm: number | null): number | null {
  if (cm === null) return null;
  const mm = Math.round(cm * 10);
  return mm > 0 ? mm : null;
}

function arredondar6(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 1_000_000) / 1_000_000;
}

/** Aceita percentual como fração Excel (0,06) ou número percentual (6). */
function percentualFracao(valor: number | null): number | null {
  if (valor === null) return null;
  const fracao = Math.abs(valor) > 1 ? valor / 100 : valor;
  if (!Number.isFinite(fracao) || fracao < 0 || fracao >= 1) return null;
  return fracao;
}

function efetivaMargemPct(preco: number, custo: number): number | null {
  if (!(preco > 0)) return null;
  return arredondar6(((preco - custo) / preco) * 100);
}

/** A planilha armazena várias taxas/margens como fração Excel (0,36 = 36%). */
function percentualPlanilhaParaPct(valor: number): number {
  return Math.abs(valor) <= 1 ? valor * 100 : valor;
}

function calcularFormacaoPrecoPrincipal(
  celulas: Record<string, string>,
  parametros: ParametrosPrecificacaoPlanilha | null,
  linha: number,
): { calculo: FormacaoPrecoCalculada | null; precos: PrecoCalculado[]; erros: string[] } {
  const erros: string[] = [];
  const custoFabricacao = numero(pegar(celulas, 'Custo Unitário Fabricação'));
  const simplesRate = percentualFracao(numero(pegar(celulas, 'Simples Nacional')));
  const icmsRate = percentualFracao(numero(pegar(celulas, 'ICMS'))) ?? 0;
  const icms2Rate = percentualFracao(numero(pegar(celulas, 'ICMS2'))) ?? 0;
  const margemAtacadoRate = percentualFracao(numero(pegar(celulas, 'Mgb Atacado Vista')));
  const margemVarejoRate = percentualFracao(numero(pegar(celulas, 'Mgb Vrj Vista')));
  const margemVarejo2UnRate = percentualFracao(numero(pegar(celulas, 'Mgb Vrj Vista 2 un')));
  const margemCartaoRate = percentualFracao(numero(pegar(celulas, 'MGL VRJ CARTÃO À VISTA')));
  const margemComboCartaoRate = percentualFracao(numero(pegar(celulas, 'VRJ =/> 2 PÇ CARTÃO até  3X')));

  if (custoFabricacao === null || custoFabricacao < 0) erros.push('Custo Unitário Fabricação ausente ou inválido.');
  if (simplesRate === null) erros.push('Alíquota Simples Nacional ausente ou inválida.');
  if (margemAtacadoRate === null) erros.push('Margem MGB Atacado à Vista ausente ou inválida.');
  if (margemVarejoRate === null) erros.push('Margem MGB Varejo à Vista ausente ou inválida.');
  if (erros.length || custoFabricacao === null || simplesRate === null || margemAtacadoRate === null || margemVarejoRate === null) {
    return { calculo: null, precos: [], erros };
  }

  const totalImpostoRate = simplesRate + icmsRate + icms2Rate;
  const simplesValor = arredondar6(custoFabricacao * simplesRate);
  const totalImpostoValor = arredondar6(custoFabricacao * totalImpostoRate);
  const custoTotal = arredondar6(custoFabricacao + totalImpostoValor);
  if (!(totalImpostoRate >= 0 && totalImpostoRate < 1)) {
    return { calculo: null, precos: [], erros: ['Soma das alíquotas de tributos inválida (deve ser menor que 100%).'] };
  }

  const precoAtacadoBase = round2(custoTotal / (1 - margemAtacadoRate));
  const precoVarejoBase = round2(custoTotal / (1 - margemVarejoRate));
  const precoVarejoCartaoBase = margemCartaoRate === null
    ? precoVarejoBase
    : round2(custoTotal / (1 - margemCartaoRate));
  const precoVarejoComboCartaoBase = margemComboCartaoRate === null
    ? precoVarejoCartaoBase
    : round2(custoTotal / (1 - margemComboCartaoRate));
  const taxaPorCondicao = parametros?.ajustes_por_condicao ?? {};
  const condicoesFinanceirasAtacado = PRECOS_OFICIAIS.filter((p) => p.canal === 'atacado');
  const fatoresAusentes = condicoesFinanceirasAtacado
    .filter((spec) => taxaPorCondicao[`${spec.condicao}|${spec.quantidade_minima ?? 1}`] === null ||
      taxaPorCondicao[`${spec.condicao}|${spec.quantidade_minima ?? 1}`] === undefined)
    .map((spec) => spec.condicao);
  if (fatoresAusentes.length) {
    return { calculo: null, precos: [], erros: [`Fatores financeiros da linha 10 ausentes para: ${fatoresAusentes.join(', ')}.`] };
  }
  const desconto2Un = parametros?.desconto_varejo_2un_pct ?? null;
  if (desconto2Un === null || desconto2Un < 0 || desconto2Un >= 1) {
    return { calculo: null, precos: [], erros: ['Fator financeiro da coluna VRJ 2 Un está ausente ou inválido na linha de parâmetros da planilha.'] };
  }

  const precos: PrecoCalculado[] = [];
  const referenciaColuna = new Map<string, string>(
    PRECOS_OFICIAIS.map((p) => [`${p.condicao}|${p.quantidade_minima ?? 1}`, p.rotulo])
  );
  for (const spec of PRECOS_OFICIAIS) {
    const quantidadeMinima = spec.quantidade_minima ?? 1;
    const chave = `${spec.condicao}|${quantidadeMinima}`;
    const ajusteDeclarado = taxaPorCondicao[chave];
    // Para condições atacadistas a planilha declara os fatores de financiamento
    // em AI:AP. Para cartão de varejo não há acréscimo declarado: conserva o
    // preço-base varejo calculado, sem inventar taxa.
    const ajuste = ajusteDeclarado ?? 0;
    const ehFaixaDescontoQuantidade = spec.canal === 'varejo' && spec.condicao === 'varejo_vista' && quantidadeMinima > 1;
    const base = spec.canal === 'atacado'
      ? precoAtacadoBase
      : spec.condicao === 'cartao_vista'
        ? precoVarejoCartaoBase
        : spec.condicao === 'cartao_parcelado'
          ? precoVarejoComboCartaoBase
          : precoVarejoBase;
    const preco = ehFaixaDescontoQuantidade
      ? round2(base * (1 - desconto2Un))
      : round2(base / (1 - ajuste));
    const ajusteAplicadoPct = ehFaixaDescontoQuantidade ? -desconto2Un * 100 : ajuste * 100;
    precos.push({
      canal: spec.canal,
      condicao: spec.condicao,
      quantidade_minima: quantidadeMinima,
      preco,
      margem_pct: efetivaMargemPct(preco, custoTotal),
      ajuste_pct: arredondar6(ajusteAplicadoPct),
      regra_calculo: {
        versao: 'BROBOND-PRECO-0125-v1',
        linha_planilha: linha,
        formula: ehFaixaDescontoQuantidade
          ? 'preco_unitario = preco_varejo_base * (1 - desconto_combo)'
          : 'preco_final = preco_base_canal / (1 - ajuste_financeiro)',
        custo_fabricacao: custoFabricacao,
        simples_nacional_pct: simplesRate * 100,
        icms_pct: icmsRate * 100,
        icms2_pct: icms2Rate * 100,
        total_imposto_pct: totalImpostoRate * 100,
        custo_total_imposto: custoTotal,
        margem_alvo_pct: (spec.canal === 'atacado' ? margemAtacadoRate : (ehFaixaDescontoQuantidade ? margemVarejo2UnRate : margemVarejoRate)) === null
          ? null
          : ((spec.canal === 'atacado' ? margemAtacadoRate : (ehFaixaDescontoQuantidade ? margemVarejo2UnRate : margemVarejoRate)) as number) * 100,
        ajuste_financeiro_pct: ajusteAppliedPercent(ajusteAplicadoPct),
        quantidade_minima: quantidadeMinima,
        preco_base_canal: base,
        preco_calculado: preco,
        margem_efetiva_pct: efetivaMargemPct(preco, custoTotal),
      },
    });
  }

  const conferencias: FormacaoPrecoCalculada['conferencias'] = [];
  const comparar = (campo: string, fonte: string, calculado: number, percentual = false) => {
    const bruto = numero(pegar(celulas, fonte));
    if (bruto === null) return;
    const esperado = percentual ? percentualPlanilhaParaPct(bruto) : bruto;
    const diferenca = arredondar6(calculado - esperado);
    conferencias.push({ campo, valor_planilha: esperado, valor_erp: calculado, diferenca, status: Math.abs(diferenca) <= 0.02 ? 'confere' : 'diverge' });
  };
  comparar('simples_nacional_valor', 'Simples Nacional Valor', simplesValor);
  comparar('total_imposto_pct', 'Total Imposto %', totalImpostoRate * 100, true);
  comparar('total_imposto_valor', 'Total Valor Imposto', totalImpostoValor);
  comparar('custo_total_imposto', 'Custo TT+IMP', custoTotal);
  comparar('margem_atacado_pct', 'Mgb Atacado Vista', margemAtacadoRate * 100, true);
  comparar('margem_varejo_pct', 'Mgb Vrj Vista', margemVarejoRate * 100, true);
  if (margemVarejo2UnRate !== null) comparar('margem_varejo_2un_pct', 'Mgb Vrj Vista 2 un', margemVarejo2UnRate * 100, true);
  if (margemCartaoRate !== null) comparar('margem_varejo_cartao_pct', 'MGL VRJ CARTÃO À VISTA', margemCartaoRate * 100, true);
  if (margemComboCartaoRate !== null) comparar('margem_varejo_combo_cartao_pct', 'VRJ =/> 2 PÇ CARTÃO até  3X', margemComboCartaoRate * 100, true);
  for (const preco of precos) {
    const rotulo = referenciaColuna.get(`${preco.condicao}|${preco.quantidade_minima}`);
    if (rotulo) comparar(`preco:${preco.canal}:${preco.condicao}:qtd${preco.quantidade_minima}`, rotulo, preco.preco);
  }

  const margemCartaoVista = efetivaMargemPct(
    precos.find((p) => p.condicao === 'cartao_vista' && p.quantidade_minima === 1)?.preco ?? precoVarejoCartaoBase,
    custoTotal
  );
  const margemComboCartao = efetivaMargemPct(
    precos.find((p) => p.condicao === 'cartao_parcelado' && p.quantidade_minima === 1)?.preco ?? precoVarejoComboCartaoBase,
    custoTotal
  );
  const memoria: Record<string, unknown> = {
    versao: 'BROBOND-PRECO-0125-v1',
    origem: 'TABELA DE PREÇO BASE PARA ERP',
    aba: ABA_FONTE,
    linha,
    parametros: {
      custo_fabricacao: custoFabricacao,
      simples_nacional_pct: simplesRate * 100,
      icms_pct: icmsRate * 100,
      icms2_pct: icms2Rate * 100,
      margem_atacado_pct: margemAtacadoRate * 100,
      margem_varejo_pct: margemVarejoRate * 100,
      margem_varejo_2un_pct: margemVarejo2UnRate === null ? null : margemVarejo2UnRate * 100,
      ajustes_por_condicao: taxaPorCondicao,
      desconto_varejo_2un_pct: desconto2Un * 100,
      linha_parametros: parametros?.linha_parametros ?? null,
    },
    resultados: {
      simples_nacional_valor: simplesValor,
      total_imposto_pct: totalImpostoRate * 100,
      total_imposto_valor: totalImpostoValor,
      custo_total_imposto: custoTotal,
      preco_atacado_base: precoAtacadoBase,
      preco_varejo_base: precoVarejoBase,
      preco_varejo_cartao_base: precoVarejoCartaoBase,
      preco_varejo_combo_cartao_base: precoVarejoComboCartaoBase,
    },
    conferencias,
  };
  return {
    calculo: {
      custo_fabricacao: custoFabricacao,
      custo_aquisicao_unitario: null,
      simples_nacional_pct: arredondar6(simplesRate * 100),
      simples_nacional_valor: simplesValor,
      icms_pct: arredondar6(icmsRate * 100),
      icms2_pct: arredondar6(icms2Rate * 100),
      icms_valor: arredondar6(custoFabricacao * icmsRate),
      icms2_valor: arredondar6(custoFabricacao * icms2Rate),
      total_imposto_pct: arredondar6(totalImpostoRate * 100),
      total_imposto_valor: totalImpostoValor,
      custo_total: custoTotal,
      custo_total_com_impostos: custoTotal,
      margem_atacado_pct: arredondar6(margemAtacadoRate * 100),
      margem_varejo_pct: arredondar6(margemVarejoRate * 100),
      margem_varejo_2un_pct: margemVarejo2UnRate === null ? (precos.find((p) => p.condicao === 'varejo_vista' && p.quantidade_minima === 2)?.margem_pct ?? null) : arredondar6(margemVarejo2UnRate * 100),
      margem_varejo_cartao_pct: margemCartaoRate === null ? (margemCartaoVista === null ? null : arredondar6(margemCartaoVista)) : arredondar6(margemCartaoRate * 100),
      margem_varejo_combo_cartao_pct: margemComboCartaoRate === null ? (margemComboCartao === null ? null : arredondar6(margemComboCartao)) : arredondar6(margemComboCartaoRate * 100),
      memoria,
      conferencias,
    },
    precos,
    erros,
  };
}

function calcularFormacaoPrecoControle(
  celulas: Record<string, string>,
  linha: number,
): { calculo: FormacaoPrecoCalculada | null; precos: PrecoCalculado[]; erros: string[] } {
  const custoAquisicao = numero(pegar(celulas, 'Valor unitário Custo'));
  const simplesRate = percentualFracao(numero(pegar(celulas, 'Simples Nacional')));
  const icmsRate = percentualFracao(numero(pegar(celulas, 'ICMS'))) ?? 0;
  const precoVarejo = numero(pegar(celulas, 'VRJ À VISTA'));
  const erros: string[] = [];
  if (custoAquisicao === null || custoAquisicao < 0) erros.push('Valor unitário Custo está ausente ou com #REF!; custo e margem pendentes.');
  if (simplesRate === null) erros.push('Alíquota Simples Nacional ausente ou inválida.');
  if (precoVarejo === null || precoVarejo <= 0) erros.push('Preço VRJ À VISTA ausente ou inválido; não há base para calcular os valores tributários desta aba.');
  if (erros.length || custoAquisicao === null || simplesRate === null || precoVarejo === null) {
    return { calculo: null, precos: extrairPrecosOficiais(celulas, 'controle_estoque'), erros };
  }

  // A planilha calcula os valores em R$ de Simples/ICMS sobre o preço varejo:
  // N = Simples Nacional × VRJ À VISTA; P = ICMS × VRJ À VISTA; R = N + P;
  // T = Valor unitário Custo + R. Reexecutamos a fórmula com os dados de entrada.
  const simplesValor = arredondar6(simplesRate * precoVarejo);
  const icmsValor = arredondar6(icmsRate * precoVarejo);
  const totalImpostoRate = simplesRate + icmsRate;
  const totalImpostoValor = arredondar6(simplesValor + icmsValor);
  const custoTotal = arredondar6(custoAquisicao + totalImpostoValor);
  if (totalImpostoRate >= 1) {
    return { calculo: null, precos: extrairPrecosOficiais(celulas, 'controle_estoque'), erros: ['Soma das alíquotas de tributos da BASE CONTROLE DE ESTOQUE inválida.'] };
  }

  const precos = extrairPrecosOficiais(celulas, 'controle_estoque').map((preco) => ({
    ...preco,
    margem_pct: efetivaMargemPct(preco.preco, custoTotal),
    regra_calculo: {
      ...preco.regra_calculo,
      custo_aquisicao_unitario: custoAquisicao,
      simples_nacional_pct: simplesRate * 100,
      simples_nacional_valor: simplesValor,
      icms_pct: icmsRate * 100,
      icms_valor: icmsValor,
      total_imposto_pct: totalImpostoRate * 100,
      total_imposto_valor: totalImpostoValor,
      custo_total_com_impostos: custoTotal,
      margem_efetiva_pct: efetivaMargemPct(preco.preco, custoTotal),
      formula_custo_total: 'custo_total = custo_aquisicao + (simples_nacional_pct + icms_pct) * preco_varejo_a_vista',
      linha_planilha: linha,
    },
  }));
  const margem = (condicao: string, quantidadeMinima = 1) =>
    precos.find((p) => p.condicao === condicao && p.quantidade_minima === quantidadeMinima)?.margem_pct ?? null;
  const comparar = (campo: string, fonte: string, calculado: number, percentual = false) => {
    const bruto = numero(pegar(celulas, fonte));
    if (bruto === null) return null;
    const esperado = percentual ? (Math.abs(bruto) <= 1 ? bruto * 100 : bruto) : bruto;
    const diferenca = arredondar6(calculado - esperado);
    return { campo, valor_planilha: esperado, valor_erp: calculado, diferenca, status: Math.abs(diferenca) <= 0.02 ? 'confere' as const : 'diverge' as const };
  };
  const conferencias = [
    comparar('simples_nacional_valor', 'PIS/CONFINS2', simplesValor),
    comparar('total_imposto_pct', 'TOTAL IMPOSTOS', totalImpostoRate * 100, true),
    comparar('total_imposto_valor', 'TOTAL IMPOSTOS2', totalImpostoValor),
    comparar('custo_total_imposto', 'CUSTO TT+IMP', custoTotal),
    comparar('margem_atacado_pct', 'MGL ATACADO', margem('atacado_vista', 10) ?? 0, true),
    comparar('margem_varejo_pct', 'MGL VRJ À VISTA', margem('varejo_vista', 1) ?? 0, true),
    comparar('margem_varejo_2un_pct', 'MGl VRJ À VISTA 2 PÇS', margem('varejo_vista', 2) ?? 0, true),
    comparar('margem_varejo_cartao_pct', 'MGL VRJ CARTÃO À VISTA', margem('cartao_vista', 1) ?? 0, true),
    comparar('margem_varejo_combo_cartao_pct', 'VRJ =/> 2 PÇ CARTÃO até  3X', margem('cartao_parcelado', 2) ?? 0, true),
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  const memoria: Record<string, unknown> = {
    versao: 'BROBOND-PRECO-0125-v1',
    origem: 'TABELA DE PREÇO BASE PARA ERP',
    aba: 'BASE CONTROLE DE ESTOQUE',
    linha,
    parametros: {
      custo_aquisicao_unitario: custoAquisicao,
      simples_nacional_pct: simplesRate * 100,
      icms_pct: icmsRate * 100,
      icms2_valor_planilha_recalculado: icmsValor,
      preco_varejo_base: precoVarejo,
    },
    resultados: {
      simples_nacional_valor: simplesValor,
      icms_valor: icmsValor,
      total_imposto_pct: totalImpostoRate * 100,
      total_imposto_valor: totalImpostoValor,
      custo_total_imposto: custoTotal,
      margens_efetivas_pct: {
        atacado: margem('atacado_vista', 10),
        varejo: margem('varejo_vista', 1),
        varejo_2un: margem('varejo_vista', 2),
        cartao_vista: margem('cartao_vista', 1),
        cartao_2un: margem('cartao_parcelado', 2),
      },
    },
    conferencias,
  };
  return {
    calculo: {
      custo_fabricacao: null,
      custo_aquisicao_unitario: custoAquisicao,
      simples_nacional_pct: arredondar6(simplesRate * 100),
      simples_nacional_valor: simplesValor,
      icms_pct: arredondar6(icmsRate * 100),
      icms2_pct: null,
      icms_valor: icmsValor,
      icms2_valor: null,
      total_imposto_pct: arredondar6(totalImpostoRate * 100),
      total_imposto_valor: totalImpostoValor,
      custo_total: custoTotal,
      custo_total_com_impostos: custoTotal,
      margem_atacado_pct: margem('atacado_vista', 10),
      margem_varejo_pct: margem('varejo_vista', 1),
      margem_varejo_2un_pct: margem('varejo_vista', 2),
      margem_varejo_cartao_pct: margem('cartao_vista', 1),
      margem_varejo_combo_cartao_pct: margem('cartao_parcelado', 2),
      memoria,
      conferencias,
    },
    precos,
    erros,
  };
}

function calcularFormacaoPrecoRoupas(
  celulas: Record<string, string>,
  linha: number,
): { calculo: FormacaoPrecoCalculada | null; precos: PrecoCalculado[]; erros: string[] } {
  const custo = numero(pegar(celulas, 'Valor unitário Custo'));
  const margemVista = percentualFracao(numero(pegar(celulas, 'Margem Luco Preço Vista')));
  const margemCartao = percentualFracao(numero(pegar(celulas, 'Margem Luco Prazo Cartão')));
  const erros: string[] = [];
  if (custo === null || custo < 0) erros.push('Valor unitário Custo ausente, inválido ou com erro de referência.');
  if (margemVista === null) erros.push('Margem Luco Preço Vista ausente ou inválida.');
  if (margemCartao === null) erros.push('Margem Luco Prazo Cartão ausente ou inválida.');
  if (erros.length || custo === null || margemVista === null || margemCartao === null) {
    return { calculo: null, precos: [], erros };
  }

  const precoVista = round2(custo / (1 - margemVista));
  const precoCartao = round2(custo / (1 - margemCartao));
  const margemVistaEfetiva = efetivaMargemPct(precoVista, custo);
  const margemCartaoEfetiva = efetivaMargemPct(precoCartao, custo);
  const comparar = (campo: string, fonte: string, calculado: number, percentual = false) => {
    const bruto = numero(pegar(celulas, fonte));
    if (bruto === null) return null;
    const esperado = percentual ? percentualPlanilhaParaPct(bruto) : bruto;
    const diferenca = arredondar6(calculado - esperado);
    return { campo, valor_planilha: esperado, valor_erp: calculado, diferenca, status: Math.abs(diferenca) <= 0.02 ? 'confere' as const : 'diverge' as const };
  };
  const conferencias = [
    comparar('preco_varejo_vista', 'Preço à Vista  10% Desc.', precoVista),
    comparar('preco_cartao_parcelado', 'Preço de Venda Cartão', precoCartao),
    comparar('margem_varejo_pct', 'Margem Luco Preço Vista', margemVista * 100, true),
    comparar('margem_varejo_cartao_pct', 'Margem Luco Prazo Cartão', margemCartao * 100, true),
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  const memoria: Record<string, unknown> = {
    versao: 'BROBOND-PRECO-0125-v1',
    origem: 'TABELA DE PREÇO BASE PARA ERP',
    aba: 'Política Comercial Roupas (2)',
    linha,
    criterio: 'Preço calculado por margem bruta sobre o preço de venda; sem tributos adicionais porque a aba não informa alíquotas.',
    parametros: {
      custo_aquisicao_unitario: custo,
      margem_preco_vista_pct: margemVista * 100,
      margem_cartao_pct: margemCartao * 100,
    },
    resultados: {
      preco_varejo_vista: precoVista,
      preco_cartao_parcelado: precoCartao,
      tributos_calculados: false,
      motivo: 'A fonte não fornece alíquotas aplicáveis ao produto; o custo informado é preservado sem acrescentar tributos estimados.',
    },
    conferencias,
  };
  const precos: PrecoCalculado[] = [
    {
      canal: 'varejo', condicao: 'varejo_vista', quantidade_minima: 1, preco: precoVista,
      margem_pct: margemVistaEfetiva, ajuste_pct: 0,
      regra_calculo: {
        versao: 'BROBOND-PRECO-0125-v1',
        origem: 'Política Comercial Roupas (2)',
        formula: 'preco = custo_aquisicao / (1 - margem_bruta_preco_vista)',
        custo_aquisicao: custo, margem_alvo_pct: margemVista * 100, preco_calculado: precoVista,
      },
    },
    {
      canal: 'varejo', condicao: 'cartao_parcelado', quantidade_minima: 1, preco: precoCartao,
      margem_pct: margemCartaoEfetiva, ajuste_pct: arredondar6((precoCartao / precoVista - 1) * 100),
      regra_calculo: {
        versao: 'BROBOND-PRECO-0125-v1',
        origem: 'Política Comercial Roupas (2)',
        formula: 'preco = custo_aquisicao / (1 - margem_bruta_prazo_cartao)',
        custo_aquisicao: custo, margem_alvo_pct: margemCartao * 100, preco_calculado: precoCartao,
      },
    },
  ];
  return {
    calculo: {
      custo_fabricacao: null,
      custo_aquisicao_unitario: custo,
      simples_nacional_pct: null,
      simples_nacional_valor: null,
      icms_pct: null,
      icms2_pct: null,
      total_imposto_pct: null,
      total_imposto_valor: null,
      icms_valor: null,
      icms2_valor: null,
      custo_total: custo,
      custo_total_com_impostos: null,
      margem_atacado_pct: null,
      margem_varejo_pct: arredondar6(margemVista * 100),
      margem_varejo_2un_pct: null,
      margem_varejo_cartao_pct: arredondar6(margemCartao * 100),
      margem_varejo_combo_cartao_pct: null,
      memoria,
      conferencias,
    },
    precos,
    erros,
  };
}

function ajusteAppliedPercent(valor: number): number {
  return arredondar6(valor);
}

/** Normaliza uma linha bruta (sem consultar o banco), por fonte de cadastro. */
export function normalizarItem(
  linha: LinhaBruta,
  barcodePorIndustria: Map<string, string>,
  fonte: FonteCadastro = 'principal',
  parametros: ParametrosPrecificacaoPlanilha | null = null,
): ItemNormalizado {
  const c = linha.celulas;
  const descricao = pegar(c, 'DESCRIÇÃO', 'Descrição do produto/serviço2', 'Descrição do produto/serviço').trim();
  const codigo_industria = pegar(c, 'Código Industria').trim();
  const marca = pegar(c, 'MARCA').trim();
  const tamanhoRaw = pegar(c, 'Tamanho').trim();
  const custo = pegar(c, 'Custo Unitário Fabricação', 'Valor unitário Custo', 'Valor\nunitário Custo');

  let categoria_master: string;
  let colecao: string;
  let cor: string;
  let tipo: string;
  let status: string;

  if (fonte === 'controle_estoque') {
    // Cabeçalho: Item, COLEÇÃO, CATEGORIA, SUBCATEGORIA, Descrição, Tamanho,
    // Código Industria, Tipo, Fornecedor, Valor unitário Custo…
    // Sem MARCA e sem STATUS na origem: o produto nasce ATIVO (a aba é de
    // controle de estoque ativo; não há coluna de inativação).
    categoria_master = pegar(c, 'CATEGORIA').trim();
    colecao = pegar(c, 'COLEÇÃO').trim();
    cor = pegar(c, 'SUBCATEGORIA').trim();
    tipo = pegar(c, 'Tipo').trim();
    status = 'ATIVO';
  } else if (fonte === 'roupas') {
    // Cabeçalho: Item, Categoria, Descrição, Código Industria, Tipo, Fornecedor,
    // Qtd. Estoque, Valor unitário Custo, Preço à Vista, Preço de Venda Cartão…
    // O código é `PRODUTO[-COR]-TAMANHO` (93882-40 × 93882-42 = MESMO produto, dois
    // tamanhos): o produto-pai é o prefixo numérico e o tamanho vira eixo de
    // variação (como na fonte canônica). A "Qtd. Estoque" NÃO é importada.
    categoria_master = pegar(c, 'Categoria').trim();
    colecao = '';
    cor = '';
    tipo = pegar(c, 'Tipo').trim();
    status = 'ATIVO';
  } else {
    categoria_master = pegar(c, 'CATEGORIA MASTER').trim();
    colecao = pegar(c, 'COLEÇÃO').trim();
    cor = pegar(c, 'VARIANTE COR').trim();
    tipo = pegar(c, 'Tipo').trim();
    status = pegar(c, 'STATUS').trim().toUpperCase();
  }

  const roupas = fonte === 'roupas' ? parseCodigoRoupas(codigo_industria) : null;
  const tamanho = fonte === 'roupas' ? (roupas!.tamanho || normalizarTamanho(tamanhoRaw)) : normalizarTamanho(tamanhoRaw);
  // Na aba "roupas" a cor é EIXO de variação e vem no CÓDIGO (`94000-nude-gg`):
  // o código separa cor e tamanho, então a cor precisa vir do parser, não da
  // coluna. Sem isso, cores distintas do mesmo tamanho colidiam na chave de
  // variação (`TAM:G` para azul claro × caramelo) e a segunda era rejeitada
  // como duplicada — variações reais eram perdidas.
  if (roupas?.cor) cor = roupas.cor;
  // Descrição-base do produto-pai: sem o tamanho e sem a cor. Na fonte canônica a
  // cor vem no fim da descrição; nas de controle, no meio ("GOLA O BRANCA BORDADO").
  const semCor = descricaoBase(descricaoSemTamanho(descricao, tamanho), cor);
  const base = fonte === 'controle_estoque' ? descricaoSemCor(semCor, cor) : semCor;
  // O saldo físico canônico é empresa + produto-pai + tamanho + local. Como
  // a célula não possui dimensão de cor, cada COR precisa ter seu próprio pai;
  // dentro desse pai, tamanhos continuam sendo variações. Isso impede que o
  // estoque de uma camiseta branca P seja somado ao da preta P.
  //  • principal: categoria + coleção + marca + descrição-base + cor;
  //  • controle_estoque: categoria + descrição-base + subcategoria/cor;
  //  • roupas: prefixo do produto + cor extraída do SKU.
  const familia = fonte === 'principal'
    ? [fonte, categoria_master, colecao, marca, base, cor].map((x) => normalizarRotulo(x)).join('|')
    : fonte === 'roupas'
      ? [fonte, roupas!.produto, roupas!.cor].map((x) => normalizarRotulo(x)).join('|')
      : [fonte, categoria_master, base, cor].map((x) => normalizarRotulo(x)).join('|');
  const pesoKg = numero(pegar(c, 'Peso KG'));
  const formacao = fonte === 'principal'
    ? calcularFormacaoPrecoPrincipal(c, parametros, linha.linha)
    : fonte === 'controle_estoque'
      ? calcularFormacaoPrecoControle(c, linha.linha)
      : fonte === 'roupas'
        ? calcularFormacaoPrecoRoupas(c, linha.linha)
        : null;
  const precos = formacao?.calculo
    ? formacao.precos
    : fonte === 'principal'
      ? []
      : extrairPrecosOficiais(c, fonte);
  const errosPrecificacao = formacao?.erros ?? (fonte === 'controle_estoque' && numero(custo) === null
    ? ['Custo da BASE CONTROLE DE ESTOQUE ausente ou com erro de referência (#REF!); preços explícitos podem ser preservados, mas custo e margem ficam pendentes.']
    : []);
  return {
    linha: linha.linha,
    fonte,
    item: pegar(c, 'Item').trim(),
    codigo_categoria: pegar(c, 'Cód Categoria').trim(),
    categoria_master,
    colecao,
    cor,
    descricao,
    tamanho,
    codigo_industria,
    tipo,
    status,
    peso_g: pesoKg === null ? null : Math.round(pesoKg * 1000),
    altura_mm: cmParaMm(numero(pegar(c, 'Altura CM', 'Altura\nCM'))),
    largura_mm: cmParaMm(numero(pegar(c, 'Largura CM', 'Largura\nCM'))),
    profundidade_mm: cmParaMm(numero(pegar(c, 'Comprimento ou profundidade CM', 'Comprimento ou profundidade\nCM'))),
    custo_base: numero(custo),
    marca,
    codigo_barras: barcodePorIndustria.get(codigo_industria) || null,
    familia,
    nome_pai: fonte === 'roupas' ? base : (base || descricao || codigo_industria),
    // O SKU sintético do pai carrega a cor, pois ela é fronteira de estoque.
    // O SKU original da indústria continua intacto na variação/produto simples.
    pai_sku: fonte === 'principal'
      ? skuPaiDe(categoria_master, [colecao, cor].filter(Boolean).join('-'))
      : fonte === 'roupas'
        ? slugSku([roupas!.produto, roupas!.cor].filter(Boolean).join('-')).slice(0, 40)
        : slugSku([base || descricao || codigo_industria, cor].filter(Boolean).join('-')).slice(0, 40),
    unidade: unidadeDoTipo(tipo),
    fornecedor: pegar(c, 'Fornecedor').trim(),
    atributos_adicionais: {
      ...atributosAdicionais(c),
      __planilha_fonte: fonte,
      __planilha_linha: String(linha.linha),
      __planilha_ids_item: pegar(c, 'IDs Item Origem') || pegar(c, 'Item'),
      __planilha_dados_originais: pegar(c, 'Linhas Originais Planilha') || JSON.stringify([c]),
    },
    calculo_precificacao: formacao?.calculo ?? null,
    erros_precificacao: errosPrecificacao,
    precos,
  };
}

/**
 * Deduplica SKU repetido na mesma aba quando a identidade comercial é
 * equivalente. Os IDs Item e as linhas originais são preservados em JSON;
 * quantidade física da fonte é somada (não se duplica produto/preço).
 * Qualquer divergência de custo, margem, condição, fornecedor ou identidade
 * bloqueia a carga para não escolher uma linha arbitrariamente.
 */
export function consolidarSkusRepetidos(leitura: Leitura): Leitura {
  const grupos = new Map<string, LinhaBruta[]>();
  for (const linha of leitura.linhas) {
    const sku = pegar(linha.celulas, 'Código Industria').trim();
    if (!sku) continue;
    const lista = grupos.get(sku) ?? [];
    lista.push(linha);
    grupos.set(sku, lista);
  }
  const linhasSaida: LinhaBruta[] = [];
  const usados = new Set<string>();
  for (const linha of leitura.linhas) {
    const sku = pegar(linha.celulas, 'Código Industria').trim();
    if (!sku || usados.has(sku)) {
      if (!sku) linhasSaida.push(linha);
      continue;
    }
    usados.add(sku);
    const grupo = grupos.get(sku) ?? [linha];
    if (grupo.length === 1 || leitura.fonte !== 'roupas') {
      linhasSaida.push(linha);
      continue;
    }

    const descrever = (texto: string) => normalizarRotulo(String(texto ?? '')
      .replace(/^\s*\d+\s*[-:]\s*/, '')
      .replace(/\btamanho\s*:?\s*(?:p|m|g|gg|xg|eg|\d{2})\b/gi, '')
      .replace(/\s+/g, ' '));
    const identidade = (celulas: Record<string, string>) => ({
      categoria: normalizarRotulo(pegar(celulas, 'Categoria')),
      descricao: descrever(pegar(celulas, 'Descrição do produto/serviço2', 'Descrição do produto/serviço')),
      tipo: normalizarRotulo(pegar(celulas, 'Tipo')),
      fornecedor: normalizarRotulo(pegar(celulas, 'Fornecedor')),
      custo_unitario: numero(pegar(celulas, 'Valor unitário Custo')),
      margem_vista: numero(pegar(celulas, 'Margem Luco Preço Vista')),
      margem_cartao: numero(pegar(celulas, 'Margem Luco Prazo Cartão')),
      preco_vista: numero(pegar(celulas, 'Preço à Vista  10% Desc.', 'Preço à Vista 10% Desc.')),
      preco_cartao: numero(pegar(celulas, 'Preço de Venda Cartão')),
    });
    const base = identidade(grupo[0].celulas);
    for (const repetida of grupo.slice(1)) {
      const atual = identidade(repetida.celulas);
      const divergencias = Object.keys(base).filter((k) => {
        const a = base[k as keyof typeof base];
        const b = atual[k as keyof typeof atual];
        return a !== b;
      });
      if (divergencias.length) {
        throw new HttpError(
          409,
          'SKU duplicado ' + sku + ' nas linhas ' + grupo.map((x) => x.linha).join(', ') +
          ' com divergência em ' + divergencias.join(', ') + '. A carga foi bloqueada.'
        );
      }
    }

    const consolidada: LinhaBruta = {
      linha: grupo[0].linha,
      celulas: { ...grupo[0].celulas },
    };
    const chavesQtd = Object.keys(consolidada.celulas).filter((k) => normalizarRotulo(k) === 'qtd estoque');
    const chaveQtd = chavesQtd[0];
    if (chaveQtd) {
      const soma = grupo.reduce((total, item) => total + (numero(pegar(item.celulas, chaveQtd)) ?? 0), 0);
      consolidada.celulas[chaveQtd] = String(soma);
    }
    const itemIds = [...new Set(grupo.map((x) => pegar(x.celulas, 'Item').trim()).filter(Boolean))];
    consolidada.celulas['IDs Item Origem'] = itemIds.join(',');
    consolidada.celulas['Linhas Originais Planilha'] = JSON.stringify(grupo.map((x) => ({ linha: x.linha, celulas: x.celulas })));
    linhasSaida.push(consolidada);
  }
  return {
    ...leitura,
    linhas: linhasSaida,
    classificacao: [
      ...leitura.classificacao,
      { coluna: 'IDs Item Origem', natureza: 'ignorada', nota: 'IDs múltiplos preservados por SKU consolidado.' },
      { coluna: 'Linhas Originais Planilha', natureza: 'ignorada', nota: 'Linhas originais preservadas integralmente em JSON.' },
    ],
  };
}

/** Lê os preços oficiais da linha (canal × condição), conforme a fonte. */
export function extrairPrecosOficiais(celulas: Record<string, string>, fonte: FonteCadastro = 'principal'): PrecoCalculado[] {
  const out: PrecoCalculado[] = [];
  const mapa = fonte === 'roupas' ? PRECOS_ROUPAS_POR_ROTULO : fonte === 'controle_estoque' ? PRECOS_CONTROLE_POR_ROTULO : PRECOS_OFICIAIS_POR_ROTULO;
  for (const [k, v] of Object.entries(celulas)) {
    const spec = mapa.get(normalizarRotulo(k));
    if (!spec) continue;
    const p = numero(v);
    if (p === null || p <= 0) continue;
    out.push({
      canal: spec.canal,
      condicao: spec.condicao,
      quantidade_minima: spec.quantidade_minima ?? 1,
      preco: p,
      margem_pct: null,
      ajuste_pct: 0,
      regra_calculo: { versao: 'BROBOND-PRECO-0125-v1', origem: fonte, coluna_origem: k, formula: 'preco_explicito_da_fonte_complementar' },
    });
  }
  return out;
}

/** Ordem canônica de tamanhos de vestuário (usada na grade e na listagem). */
const ORDEM_TAMANHO: Record<string, number> = { PP: 1, P: 2, M: 3, G: 4, GG: 5, XG: 6, EG: 7, EXG: 8 };
export function ordemTamanho(codigo: string): number {
  return ORDEM_TAMANHO[codigo] ?? (Number(codigo) || 20);
}

// ---------------------------------------------------------------------------
// Planejamento: agrupa itens em famílias (produto-pai) e valida a estrutura.
// ---------------------------------------------------------------------------
export type PlanoItem = ItemNormalizado & {
  familia_idx: number;
  acao: 'criar_pai' | 'criar_variacao';
  variacao_chave: string | null;
  erros: string[];
  /** Conflitos de preço DENTRO do arquivo para este item (mesma chave, valores distintos). */
  precos_conflitantes: string[];
};

export type PlanoFamilia = {
  chave: string; nome: string; sku: string;
  categoria_master: string; colecao: string; marca: string;
  tamanhos: string[]; cores: string[]; itens: number;
};

export type Validacoes = {
  registros: number;
  itens_distintos: number;
  skus_distintos: number;
  familias: number;
  identificadores_duplicados: string[];
  codigos_industria_repetidos: string[];
  variantes_sem_tamanho: string[];
  sem_cor: string[];
  sem_descricao: string[];
  status_invalidos: string[];
  codigos_barras_conflitantes: string[];
  codigos_barras_validos: number;
  codigos_barras_concat: number;
  codigos_barras_invalidos: number;
  campos_conferencia: number;
  colunas_nao_reconhecidas: string[];
  /** Linhas com pelo menos um preço oficial (entrada) identificado. */
  linhas_com_preco: number;
  /** Total de preços oficiais (canal × condição) reconhecidos no arquivo. */
  precos_oficiais: number;
  /** Conflito DENTRO do arquivo: mesmo SKU+canal+condição+faixa de quantidade com valores distintos. */
  precos_conflitantes_arquivo: string[];
  /** SKUs sem cálculo confiável por erro/ausência de custo, margem ou parâmetro. */
  precificacao_pendente: string[];
  /** SKUs com memória de cálculo e preços produzidos pelo servidor. */
  precificacao_calculada: number;
  /** SKUs com preços explícitos da fonte complementar, sem cálculo fiscal possível. */
  precificacao_preco_explicito: number;
  /** SKUs de produto-pai que colidiram entre famílias e foram desempatados. */
  skus_pai_colididos: string[];
};

/**
 * Desempata SKUs de produto-pai repetidos entre FAMÍLIAS distintas (in-place),
 * anexando um discriminador estável derivado da chave da família. Devolve a lista
 * de SKUs que colidiram (para o relatório). Sem colisão, nada muda.
 */
export function desempatarSkusPai(familias: PlanoFamilia[]): string[] {
  const porSku = new Map<string, number[]>();
  familias.forEach((f, i) => { const a = porSku.get(f.sku) ?? []; a.push(i); porSku.set(f.sku, a); });
  const colididos: string[] = [];
  for (const [sku, idxs] of porSku) {
    if (idxs.length < 2) continue;
    colididos.push(sku);
    for (const i of idxs) familias[i].sku = `${sku.slice(0, 33)}-${hashChave(familias[i].chave)}`;
  }
  return colididos;
}

export type Plano = { itens: PlanoItem[]; familias: PlanoFamilia[]; validacoes: Validacoes };

/**
 * Monta o plano de carga. Uma família com mais de uma linha (mesma categoria,
 * coleção, marca e descrição-base) é um produto COM variação: cada linha vira
 * uma variação e um produto-pai é criado uma única vez. Família de uma linha só
 * é um produto simples.
 */
export function planejar(leitura: Leitura, barcodePorIndustria: Map<string, string>, opcoes: { codigos_barras_concat?: number; codigos_barras_invalidos?: number } = {}): Plano {
  const itens = leitura.linhas.map((l) => normalizarItem(l, barcodePorIndustria, leitura.fonte, leitura.parametros_precificacao));

  const porFamilia = new Map<string, number[]>();
  itens.forEach((it, idx) => {
    const arr = porFamilia.get(it.familia) ?? [];
    arr.push(idx);
    porFamilia.set(it.familia, arr);
  });

  const familiaIdx = new Map<string, number>();
  const familias: PlanoFamilia[] = [];
  for (const [chave, idxs] of porFamilia) {
    const primeiro = itens[idxs[0]];
    familiaIdx.set(chave, familias.length);
    familias.push({
      chave,
      nome: primeiro.nome_pai,
      sku: primeiro.pai_sku,
      categoria_master: primeiro.categoria_master,
      colecao: primeiro.colecao,
      marca: primeiro.marca,
      tamanhos: [...new Set(idxs.map((i) => itens[i].tamanho).filter(Boolean))],
      cores: [...new Set(idxs.map((i) => itens[i].cor).filter(Boolean))],
      itens: idxs.length,
    });
  }

  // Colisão de SKU do pai: duas FAMÍLIAS distintas que geram o mesmo SKU. A
  // principal é protegida pelo próprio código da indústria; as fontes extras
  // derivam o SKU da descrição e podem truncar em 40 chars — sem desempate, duas
  // famílias (ex.: "BORDADO BB" × "BORDADO B") cairiam no MESMO produto-pai.
  const skusPaiColididos = desempatarSkusPai(familias);

  const vistosItem = new Set<string>();
  const vistosSku = new Set<string>();
  const dupItem: string[] = [];
  const dupSku: string[] = [];
  const semTamanho: string[] = [];
  const semCor: string[] = [];
  const semDesc: string[] = [];
  const statusInv: string[] = [];
  const barcodeConflito: string[] = [];
  const barcodePorSku = new Map<string, string>();

  for (const it of itens) {
    if (it.item) { if (vistosItem.has(it.item)) dupItem.push(it.item); vistosItem.add(it.item); }
    if (it.codigo_industria) { if (vistosSku.has(it.codigo_industria)) dupSku.push(it.codigo_industria); vistosSku.add(it.codigo_industria); }
    const multi = (porFamilia.get(it.familia)?.length ?? 0) > 1;
    // A COR é eixo de variação na fonte canônica (variações cor × tamanho) e na
    // de controle de estoque (SUBCATEGORIA). Na fonte "roupas" não há eixo de
    // cor — cobrar cor ali seria falso positivo. O tamanho só é obrigatório
    // quando a família TEM mais de uma linha (variação real).
    const exigeCor = it.fonte !== 'roupas';
    if (multi && !it.tamanho) semTamanho.push(it.item || it.codigo_industria);
    if (exigeCor && !it.cor) semCor.push(it.item || it.codigo_industria);
    if (!it.descricao) semDesc.push(it.item || it.codigo_industria);
    if (it.status && !STATUS_VALIDOS.has(it.status)) statusInv.push(`${it.item}:${it.status}`);
    if (it.codigo_barras && it.codigo_industria) {
      const anterior = barcodePorSku.get(it.codigo_barras);
      if (anterior && anterior !== it.codigo_industria) barcodeConflito.push(it.codigo_barras);
      barcodePorSku.set(it.codigo_barras, it.codigo_industria);
    }
  }

  const itensPlano: PlanoItem[] = itens.map((it) => {
    const idxs = porFamilia.get(it.familia)!;
    const ehPai = idxs.length > 1;
    const erros: string[] = [];
    if (!it.codigo_industria) erros.push('Sem Código Industria (SKU).');
    if (!it.categoria_master) erros.push('Sem CATEGORIA MASTER.');
    // Uma variação precisa de cor OU tamanho para ter identidade. Tamanho em
    // branco não é erro por si só: óculos variam só por cor. A ausência de
    // tamanho continua REPORTADA em `variantes_sem_tamanho` para conferência.
    if (ehPai && !it.cor && !it.tamanho) erros.push('Variação sem cor e sem tamanho.');
    return {
      ...it,
      familia_idx: familiaIdx.get(it.familia)!,
      acao: ehPai ? 'criar_variacao' : 'criar_pai',
      variacao_chave: ehPai ? [it.cor ? `COR:${it.cor}` : '', it.tamanho ? `TAM:${it.tamanho}` : ''].filter(Boolean).join('|') : null,
      erros,
      precos_conflitantes: [],
    };
  });

  // Conflito de preço DENTRO do arquivo: mesmo SKU + canal + condição com
  // valores distintos. Não descartamos em silêncio — reportamos a linha.
  const precosPorChave = new Map<string, { valor: number; linha: number }>();
  const precosConflitoArquivo: string[] = [];
  for (const p of itensPlano) {
    if (!p.codigo_industria) continue;
    for (const preco of p.precos) {
      const chave = `${p.codigo_industria}|${preco.canal}|${preco.condicao}|qtd_min:${preco.quantidade_minima}`;
      const anterior = precosPorChave.get(chave);
      if (anterior && anterior.valor !== preco.preco) {
        const aviso = `${chave}: ${anterior.valor} (linha ${anterior.linha}) × ${preco.preco} (linha ${p.linha})`;
        precosConflitoArquivo.push(aviso);
        if (!p.precos_conflitantes.includes(aviso)) p.precos_conflitantes.push(aviso);
      } else if (!anterior) {
        precosPorChave.set(chave, { valor: preco.preco, linha: p.linha });
      }
    }
  }

  const linhasComPreco = itensPlano.filter((p) => p.precos.length > 0).length;
  const totalPrecos = itensPlano.reduce((acc, p) => acc + p.precos.length, 0);
  const precificacaoPendente = itensPlano.filter((p) => p.erros_precificacao.length > 0).map((p) => `${p.codigo_industria || p.item}: ${p.erros_precificacao.join(' ')}`);
  const precificacaoCalculada = itensPlano.filter((p) => p.calculo_precificacao !== null).length;
  const precificacaoPrecoExplicito = itensPlano.filter((p) => p.fonte === 'controle_estoque' && p.precos.length > 0 && p.calculo_precificacao === null).length;

  return {
    itens: itensPlano,
    familias,
    validacoes: {
      registros: itens.length,
      itens_distintos: vistosItem.size,
      skus_distintos: vistosSku.size,
      familias: familias.length,
      identificadores_duplicados: dupItem,
      codigos_industria_repetidos: dupSku,
      variantes_sem_tamanho: semTamanho,
      sem_cor: semCor,
      sem_descricao: semDesc,
      status_invalidos: statusInv,
      codigos_barras_conflitantes: barcodeConflito,
      codigos_barras_validos: barcodePorSku.size,
      codigos_barras_concat: opcoes.codigos_barras_concat ?? 0,
      codigos_barras_invalidos: opcoes.codigos_barras_invalidos ?? 0,
      campos_conferencia: leitura.classificacao.filter((c) => c.natureza === 'conferencia').length,
      colunas_nao_reconhecidas: leitura.classificacao.filter((c) => c.natureza === 'ignorada').map((c) => c.coluna),
      linhas_com_preco: linhasComPreco,
      precos_oficiais: totalPrecos,
      precos_conflitantes_arquivo: precosConflitoArquivo,
      precificacao_pendente: precificacaoPendente,
      precificacao_calculada: precificacaoCalculada,
      precificacao_preco_explicito: precificacaoPrecoExplicito,
      skus_pai_colididos: skusPaiColididos,
    },
  };
}

// ---------------------------------------------------------------------------
// Handlers HTTP.
// ---------------------------------------------------------------------------
type Escopo = ReturnType<typeof escopoDe>;

function exigirGestor(actor: { perfil?: string }) {
  if (actor.perfil === 'operador') throw new HttpError(403, 'Somente gerentes e administradores executam a carga da política comercial.');
}

// ---------------------------------------------------------------------------
// RECONCILIAÇÃO DAS ABAS (relatório, sem gravar nada).
//
// O adendo exige examinar TODAS as abas e não descartar nenhuma em silêncio. As
// abas de cadastro viram produto; as abas de MOVIMENTAÇÃO/estoque/venda entram
// só como conferência (nunca como fato transacional). Nenhuma quantidade física
// é importada daqui.
// ---------------------------------------------------------------------------
export type ReconciliacaoAba = {
  aba: string;
  classificacao: string;
  registros: number;
  identificadores: number;
  usada_como_cadastro: boolean;
  nota: string;
};
export type Reconciliacao = {
  abas: ReconciliacaoAba[];
  codigos_aba_ausentes_na_principal: Record<string, string[]>;
  produtos_por_fonte: Record<string, number>;
  total_produtos_distintos: number;
};

/** Identifica a coluna de código de uma aba (por rótulo normalizado). */
function colunaCodigo(ws: ExcelJS.Worksheet, cabecalho: number): { col: number; rotulo: string } | null {
  const row = ws.getRow(cabecalho);
  for (let c = 1; c <= Math.max(ws.columnCount, row.cellCount); c++) {
    const rot = normalizarRotulo(celulaTexto(row.getCell(c).value));
    if (rot === 'codigo industria' || rot === 'codigo internto industria' || rot === 'codigo cadastro') return { col: c, rotulo: celulaTexto(row.getCell(c).value) };
  }
  return null;
}

/** Classificação documentada de cada aba da planilha (conferência × cadastro). */
const CLASSIFICACAO_ABAS: { aba: string; classificacao: string; cadastro: boolean; nota: string }[] = [
  { aba: ABA_FONTE, classificacao: 'Cadastro mestre + produto-pai + SKU/variação + preço + custo', cadastro: true, nota: 'Fonte canônica: cadastro e preços oficiais por condição.' },
  { aba: 'BASE CONTROLE DE ESTOQUE', classificacao: 'Cadastro mestre (código próprio) + custo + preço-base', cadastro: true, nota: 'Universo de SKU próprio (1001P…): entra como cadastro, sem importar a quantidade de controle.' },
  { aba: 'Política Comercial Roupas (2)', classificacao: 'Cadastro mestre (código próprio) + custo + preço de venda', cadastro: true, nota: 'Produtos de fornecedor (93882-40…): cadastro próprio; a Qtd. Estoque NÃO é importada.' },
  { aba: 'Código de Barras', classificacao: 'Código de barras (conferência)', cadastro: false, nota: 'Só entra GTIN com dígito verificador válido; a concatenação (coleção+cor+SKU) é descartada.' },
  { aba: 'Estrutura de Descr. Produtos', classificacao: 'Descrição (conferência)', cadastro: false, nota: 'Estrutura de montagem da descrição; serve para conferir o texto, não cria produto.' },
  { aba: 'Estoque Com Jefferson', classificacao: 'Controle de estoque / histórico (conferência)', cadastro: false, nota: 'Contagem física por pessoa — NÃO é saldo canônico; não gera movimentação.' },
  { aba: 'SITUAÇÃO ESTOQUE', classificacao: 'Controle de estoque / histórico (conferência)', cadastro: false, nota: 'Muitas células em #REF!/#N/A: planilha de controle, não de cadastro.' },
  { aba: 'ENTRADA MERCADORIA', classificacao: 'Entrada (histórico — conferência)', cadastro: false, nota: 'Entradas históricas NÃO viram estoque atual.' },
  { aba: 'CONTROLE ESTOQUE SAÍDA', classificacao: 'Saída / venda histórica (conferência)', cadastro: false, nota: 'Saídas históricas NÃO viram movimentação nem estoque.' },
  { aba: 'CONT. VENDA DIÁRIA JEFF E PETR', classificacao: 'Venda histórica (conferência)', cadastro: false, nota: 'Venda diária histórica por pessoa — não é fato transacional do ERP.' },
  { aba: 'Planilha3', classificacao: 'Filtro auxiliar', cadastro: false, nota: 'Painel de filtros da planilha (MARCA/CATEGORIA MASTER); sem cadastro.' },
];

/**
 * Examina TODAS as abas do arquivo: identifica a coluna de código de cada uma,
 * quantifica os identificadores e aponta quais códigos existem fora da aba
 * principal (os "produtos que ainda não aparecem no ERP").
 */
export function reconciliarAbas(wb: ExcelJS.Workbook, principal: Leitura): Reconciliacao {
  const codigosPrincipal = new Set(principal.linhas.map((l) => normalizarItem(l, new Map()).codigo_industria).filter(Boolean));
  const abas: ReconciliacaoAba[] = [];
  const ausentes: Record<string, string[]> = {};
  const porFonte: Record<string, number> = { principal: codigosPrincipal.size };
  const todosCodigos = new Set(codigosPrincipal);

  for (const ws of wb.worksheets) {
    const meta = CLASSIFICACAO_ABAS.find((c) => normalizarRotulo(c.aba) === normalizarRotulo(ws.name));
    // Descobre o cabeçalho da aba (procura a linha com 'Código Industria').
    let cabecalho = 0;
    let col: { col: number; rotulo: string } | null = null;
    for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
      const achado = colunaCodigo(ws, r);
      if (achado) { cabecalho = r; col = achado; break; }
    }
    const codigos = new Set<string>();
    if (col) {
      for (let r = cabecalho + 1; r <= ws.rowCount; r++) {
        const v = celulaTexto(ws.getRow(r).getCell(col.col).value).trim();
        if (v) codigos.add(v);
      }
    }
    const registros = col ? codigos.size : 0;
    abas.push({
      aba: ws.name,
      classificacao: meta?.classificacao ?? 'Histórico/controle complementar',
      registros,
      identificadores: codigos.size,
      usada_como_cadastro: meta?.cadastro ?? false,
      nota: meta?.nota ?? 'Aba sem cadastro identificado — mantida como conferência.',
    });
    if (meta?.cadastro && normalizarRotulo(ws.name) !== normalizarRotulo(ABA_FONTE)) {
      porFonte[FONTES_CADASTRO.find((f) => normalizarRotulo(f.aba) === normalizarRotulo(ws.name))?.id ?? ws.name] = codigos.size;
    }
    if (col) {
      const fora = [...codigos].filter((c) => !codigosPrincipal.has(c));
      if (fora.length) ausentes[ws.name] = fora.slice(0, 500);
      for (const c of codigos) todosCodigos.add(c);
    }
  }

  return { abas, codigos_aba_ausentes_na_principal: ausentes, produtos_por_fonte: porFonte, total_produtos_distintos: todosCodigos.size };
}

/** Concatena planos (principal + fontes extras) numa leitura unificada. */
function mesclarPlanos(planos: Plano[]): Plano {
  const familias: PlanoFamilia[] = [];
  const itens: PlanoItem[] = [];
  // `familia_idx` aponta para o array de famílias do PRÓPRIO plano; ao
  // concatenar, é preciso reindexar pelo deslocamento acumulado — sem isso um
  // item de uma fonte extra apontaria para a família de outra fonte.
  for (const p of planos) {
    const offset = familias.length;
    for (const it of p.itens) itens.push({ ...it, familia_idx: it.familia_idx + offset });
    familias.push(...p.familias);
  }
  const soma = (f: (v: Validacoes) => number) => planos.reduce((a, p) => a + f(p.validacoes), 0);
  const junto = (f: (v: Validacoes) => string[]) => planos.flatMap((p) => f(p.validacoes));
  // SKU do pai colidido ENTRE fontes (ou com o código de um produto simples): o
  // desempate por plano não enxerga o outro plano, então reaplica sobre o todo.
  const jaColididos = junto((v) => v.skus_pai_colididos);
  const colididosAgora = desempatarSkusPai(familias).filter((sku) => !jaColididos.includes(sku));
  return {
    itens,
    familias,
    validacoes: {
      registros: soma((v) => v.registros),
      itens_distintos: soma((v) => v.itens_distintos),
      skus_distintos: soma((v) => v.skus_distintos),
      familias: familias.length,
      identificadores_duplicados: junto((v) => v.identificadores_duplicados),
      codigos_industria_repetidos: junto((v) => v.codigos_industria_repetidos),
      variantes_sem_tamanho: junto((v) => v.variantes_sem_tamanho),
      sem_cor: junto((v) => v.sem_cor),
      sem_descricao: junto((v) => v.sem_descricao),
      status_invalidos: junto((v) => v.status_invalidos),
      codigos_barras_conflitantes: junto((v) => v.codigos_barras_conflitantes),
      codigos_barras_validos: soma((v) => v.codigos_barras_validos),
      codigos_barras_concat: soma((v) => v.codigos_barras_concat),
      codigos_barras_invalidos: soma((v) => v.codigos_barras_invalidos),
      campos_conferencia: soma((v) => v.campos_conferencia),
      colunas_nao_reconhecidas: junto((v) => v.colunas_nao_reconhecidas),
      linhas_com_preco: soma((v) => v.linhas_com_preco),
      precos_oficiais: soma((v) => v.precos_oficiais),
      precos_conflitantes_arquivo: junto((v) => v.precos_conflitantes_arquivo),
      precificacao_pendente: junto((v) => v.precificacao_pendente),
      precificacao_calculada: soma((v) => v.precificacao_calculada),
      precificacao_preco_explicito: soma((v) => v.precificacao_preco_explicito),
      skus_pai_colididos: [...jaColididos, ...colididosAgora],
    },
  };
}

export type EstoqueInicialPlanilha = {
  sku: string;
  fonte: FonteCadastro;
  quantidade: number;
  linhas_origem: number[];
  observacoes: string[];
};

export type InventarioPlanilha = {
  local_nome: 'LOJA';
  itens: EstoqueInicialPlanilha[];
  total_skus: number;
  total_unidades: number;
  total_celulas: number;
  por_fonte: Record<string, { skus: number; unidades: number }>;
  saldos_negativos: { sku: string; linha: number; saldo_calculado: number; estoque_petrick: number; saida_petrick: number; estoque_jefferson: number; saida_jefferson: number }[];
  contagens_sem_correspondencia: { descricao: string; tamanho: string; quantidade: number; linha: number; candidatos: string[] }[];
};

/** Coluna pelo cabeçalho normalizado; falha fechada se o layout mudou. */
function colunaDaPlanilha(ws: ExcelJS.Worksheet, linhaCabecalho: number, ...rotulos: string[]): number {
  const desejados = rotulos.map(normalizarRotulo);
  const row = ws.getRow(linhaCabecalho);
  for (let c = 1; c <= Math.max(ws.columnCount || 0, row.cellCount || 0); c++) {
    if (desejados.includes(normalizarRotulo(celulaTexto(row.getCell(c).value)))) return c;
  }
  throw new HttpError(422, 'Aba "' + ws.name + '" sem a coluna obrigatória: ' + rotulos.join(' / ') + '.');
}

/** Lê número armazenado ou resultado em cache de fórmula; fórmula sem cache retorna null. */
function valorNumericoDaCelula(ws: ExcelJS.Worksheet, linha: number, coluna: number, rotulo: string): number | null {
  const valor = ws.getRow(linha).getCell(coluna).value;
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'object' && valor !== null && 'formula' in valor) {
    const resultado = (valor as { result?: unknown }).result;
    if (resultado === null || resultado === undefined || resultado === '') return null;
    const brutoResultado = celulaTexto(resultado).trim();
    if (brutoResultado.startsWith('#')) {
      throw new HttpError(422, 'Resultado de fórmula inválido na aba "' + ws.name + '", linha ' + linha + ', coluna ' + rotulo + ': ' + brutoResultado + '.');
    }
    const n = numero(brutoResultado);
    if (n === null) throw new HttpError(422, 'Resultado não numérico na aba "' + ws.name + '", linha ' + linha + ', coluna ' + rotulo + '".');
    return n;
  }
  const bruto = celulaTexto(valor).trim();
  if (!bruto) return null;
  if (bruto.startsWith('#')) throw new HttpError(422, 'Valor de erro na aba "' + ws.name + '", linha ' + linha + ', coluna ' + rotulo + ': ' + bruto + '.');
  const n = numero(bruto);
  if (n === null) throw new HttpError(422, 'Valor não numérico na aba "' + ws.name + '", linha ' + linha + ', coluna ' + rotulo + ': "' + bruto + '".');
  return n;
}

/** Quantidade física inteira; #REF!, #N/A e textos não são convertidos para zero. */
function quantidadeFisicaDaCelula(ws: ExcelJS.Worksheet, linha: number, coluna: number, rotulo: string): number {
  const bruto = celulaTexto(ws.getRow(linha).getCell(coluna).value).trim();
  if (!bruto) return 0;
  if (bruto.startsWith('#')) {
    throw new HttpError(422, 'Quantidade inválida na aba "' + ws.name + '", linha ' + linha + ', coluna ' + rotulo + ': ' + bruto + '.');
  }
  const valor = numero(bruto);
  if (valor === null || !Number.isInteger(valor) || valor < 0) {
    throw new HttpError(422, 'Quantidade física inválida na aba "' + ws.name + '", linha ' + linha + ', coluna ' + rotulo + ': "' + bruto + '".');
  }
  return valor;
}

/**
 * Extrai somente SALDOS FÍSICOS finais das três origens:
 * 1) CONTROLE ESTOQUE SAÍDA: Estoque(Petrick)-Saída(Petrick)+Estoque(Jefferson)-Saída(Jefferson);
 * 2) contagem por tamanho em Estoque Com Jefferson, conciliada com o SKU da BASE CONTROLE;
 * 3) Qtd. Estoque da Política Comercial Roupas (2), somada por SKU (inclui duplicidades).
 *
 * ENTRADA MERCADORIA, venda diária e SITUAÇÃO ESTOQUE não são somadas:
 * as saídas já estão descontadas no saldo da primeira aba e a SITUAÇÃO contém #REF!.
 */
export function extrairInventarioPlanilha(wb: ExcelJS.Workbook, plano: Plano): InventarioPlanilha {
  type Acumulado = { quantidade: number; fonte: FonteCadastro; linhas: number[]; observacoes: string[] };
  const quantidades = new Map<string, Acumulado>();
  const saldosNegativos: InventarioPlanilha['saldos_negativos'] = [];
  const contagensSemCorrespondencia: InventarioPlanilha['contagens_sem_correspondencia'] = [];
  const skuFonte = new Map(plano.itens.map((it) => [it.codigo_industria, it.fonte] as const));
  const somar = (skuBruto: string, quantidade: number, fonte: FonteCadastro, linha: number, observacao: string) => {
    const sku = String(skuBruto ?? '').trim();
    if (!sku) throw new HttpError(422, 'A planilha tem uma quantidade física sem Código Industria na linha ' + linha + '.');
    if (!skuFonte.has(sku)) {
      throw new HttpError(422, 'A planilha atribui estoque ao SKU "' + sku + '" na linha ' + linha + ', mas esse SKU não existe no cadastro importável.');
    }
    const fonteCadastro = skuFonte.get(sku)!;
    if (fonteCadastro !== fonte) {
      throw new HttpError(422, 'O SKU "' + sku + '" foi encontrado em fontes de cadastro diferentes (' + fonteCadastro + ' / ' + fonte + ').');
    }
    const atual = quantidades.get(sku) ?? { quantidade: 0, fonte, linhas: [], observacoes: [] };
    atual.quantidade += quantidade;
    atual.linhas.push(linha);
    if (observacao) atual.observacoes.push(observacao);
    quantidades.set(sku, atual);
  };

  // 1) Saldo líquido consolidado de estoque e saídas. Os movimentos históricos
  // já estão abatidos no saldo por pessoa; não subtrair novamente em outras abas.
  const saidaWs = localizarAba(wb, 'CONTROLE ESTOQUE SAÍDA');
  if (!saidaWs) throw new HttpError(422, 'A planilha não contém a aba CONTROLE ESTOQUE SAÍDA.');
  const cabSaida = 7;
  const colSkuSaida = colunaDaPlanilha(saidaWs, cabSaida, 'Código Internto Industria', 'Código Interno Industria');
  const colEstoquePetrick = colunaDaPlanilha(saidaWs, cabSaida, 'Estoque');
  const colSaidaPetrick = colunaDaPlanilha(saidaWs, cabSaida, 'Saída');
  const colEstoqueJefferson = colunaDaPlanilha(saidaWs, cabSaida, 'Estoque2');
  const colSaidaJefferson = colunaDaPlanilha(saidaWs, cabSaida, 'Saída2');
  const colSaldoPetrick = colunaDaPlanilha(saidaWs, cabSaida, 'Saldo');
  const colSaldoJefferson = colunaDaPlanilha(saidaWs, cabSaida, 'Saldo2');
  const colTotalEstoque = colunaDaPlanilha(saidaWs, cabSaida, 'TT Est.');
  const colTotalSaida = colunaDaPlanilha(saidaWs, cabSaida, 'TT Saída');
  const colTotalSaldo = colunaDaPlanilha(saidaWs, cabSaida, 'TT Saldo');
  for (let linha = cabSaida + 1; linha <= saidaWs.rowCount; linha++) {
    const sku = celulaTexto(saidaWs.getRow(linha).getCell(colSkuSaida).value).trim();
    if (!sku) continue;
    const estoquePetrick = valorNumericoDaCelula(saidaWs, linha, colEstoquePetrick, 'Estoque') ?? 0;
    const saidaPetrick = valorNumericoDaCelula(saidaWs, linha, colSaidaPetrick, 'Saída') ?? 0;
    const estoqueJefferson = valorNumericoDaCelula(saidaWs, linha, colEstoqueJefferson, 'Estoque2') ?? 0;
    const saidaJefferson = valorNumericoDaCelula(saidaWs, linha, colSaidaJefferson, 'Saída2');
    const saldoPetrick = valorNumericoDaCelula(saidaWs, linha, colSaldoPetrick, 'Saldo');
    const saldoJefferson = valorNumericoDaCelula(saidaWs, linha, colSaldoJefferson, 'Saldo2');
    const totalEstoque = valorNumericoDaCelula(saidaWs, linha, colTotalEstoque, 'TT Est.');
    const totalSaida = valorNumericoDaCelula(saidaWs, linha, colTotalSaida, 'TT Saída');
    const saldoTotal = valorNumericoDaCelula(saidaWs, linha, colTotalSaldo, 'TT Saldo');
    let saldoCalculado: number;
    let criterio: string;
    if (saldoTotal !== null) {
      saldoCalculado = saldoTotal;
      criterio = 'TT Saldo da planilha';
    } else if (totalEstoque !== null && totalSaida !== null) {
      saldoCalculado = totalEstoque - totalSaida;
      criterio = 'TT Est. - TT Saída (reconstrução de fórmula sem cache)';
    } else if (saldoPetrick !== null && saldoJefferson !== null) {
      saldoCalculado = saldoPetrick + saldoJefferson;
      criterio = 'Saldo Petrick + Saldo Jefferson';
    } else if (
      valorNumericoDaCelula(saidaWs, linha, colEstoquePetrick, 'Estoque') === null &&
      valorNumericoDaCelula(saidaWs, linha, colSaidaPetrick, 'Saída') === null &&
      valorNumericoDaCelula(saidaWs, linha, colEstoqueJefferson, 'Estoque2') === null &&
      saidaJefferson === null
    ) {
      // Linha sem qualquer quantidade ou saldo calculável: saldo físico inicial zero.
      saldoCalculado = 0;
      criterio = 'linha sem estoque/saída física informada: zero';
    } else {
      throw new HttpError(422,
        'Não foi possível reconciliar o saldo final do SKU ' + sku + ' na linha ' + linha +
        ': TT Saldo e saldos individuais sem cache, mas existem valores físicos. Nenhuma substituição foi executada.');
    }
    if (!Number.isInteger(saldoCalculado)) {
      throw new HttpError(422, 'Saldo final não inteiro para o SKU ' + sku + ' na linha ' + linha + ': ' + saldoCalculado + '.');
    }
    const saldoFisico = Math.max(0, saldoCalculado);
    if (saldoCalculado < 0) {
      saldosNegativos.push({
        sku,
        linha,
        saldo_calculado: saldoCalculado,
        estoque_petrick: estoquePetrick,
        saida_petrick: saidaPetrick,
        estoque_jefferson: estoqueJefferson,
        saida_jefferson: saidaJefferson ?? 0,
      });
    }
    somar(sku, saldoFisico, 'principal', linha,
      criterio + ': ' + saldoCalculado + (saldoCalculado < 0 ? '; saldo negativo limitado a zero' : ''));
  }

  // 2) Contagem física de controle: os dois blocos de contagem, sem somar a
  // linha de resumo ao final da aba. Conciliação exata descrição-base + tamanho.
  const baseWs = localizarAba(wb, 'BASE CONTROLE DE ESTOQUE');
  const contagemWs = localizarAba(wb, 'Estoque Com Jefferson');
  if (!baseWs || !contagemWs) throw new HttpError(422, 'A planilha precisa conter BASE CONTROLE DE ESTOQUE e Estoque Com Jefferson.');
  const cabBase = 11;
  const colDescBase = colunaDaPlanilha(baseWs, cabBase, 'Descrição do produto/serviço2', 'Descrição');
  const colTamanhoBase = colunaDaPlanilha(baseWs, cabBase, 'Tamanho');
  const colSkuBase = colunaDaPlanilha(baseWs, cabBase, 'Código Industria');
  const basePorDescricaoTamanho = new Map<string, string[]>();
  for (let linha = cabBase + 1; linha <= baseWs.rowCount; linha++) {
    const sku = celulaTexto(baseWs.getRow(linha).getCell(colSkuBase).value).trim();
    if (!sku) continue;
    const descricao = celulaTexto(baseWs.getRow(linha).getCell(colDescBase).value).trim();
    const tamanho = normalizarTamanho(celulaTexto(baseWs.getRow(linha).getCell(colTamanhoBase).value));
    const descricaoBaseItem = descricaoSemTamanho(descricao, tamanho);
    const chave = normalizarRotulo(descricaoBaseItem) + '|' + tamanho;
    const lista = basePorDescricaoTamanho.get(chave) ?? [];
    lista.push(sku);
    basePorDescricaoTamanho.set(chave, lista);
  }
  const blocosContagem = [
    { cabecalho: 4, primeira: 5, ultima: 9 },
    { cabecalho: 12, primeira: 13, ultima: 17 },
  ];
  for (const bloco of blocosContagem) {
    const colDescricao = colunaDaPlanilha(contagemWs, bloco.cabecalho, 'DESCRIÇÃO');
    for (let colunaTamanho = 2; colunaTamanho <= contagemWs.getRow(bloco.cabecalho).cellCount; colunaTamanho++) {
      const tamanho = normalizarTamanho(celulaTexto(contagemWs.getRow(bloco.cabecalho).getCell(colunaTamanho).value));
      if (!tamanho || tamanho === 'TOTAL') continue;
      for (let linha = bloco.primeira; linha <= bloco.ultima; linha++) {
        const descricao = celulaTexto(contagemWs.getRow(linha).getCell(colDescricao).value).trim();
        if (!descricao) continue;
        const quantidade = quantidadeFisicaDaCelula(contagemWs, linha, colunaTamanho, tamanho);
        if (quantidade === 0) continue;
        const chave = normalizarRotulo(descricao) + '|' + tamanho;
        const candidatos = basePorDescricaoTamanho.get(chave) ?? [];
        if (candidatos.length !== 1) {
          contagensSemCorrespondencia.push({ descricao, tamanho, quantidade, linha, candidatos });
          continue;
        }
        somar(candidatos[0], quantidade, 'controle_estoque', linha,
          'Contagem física por tamanho na aba Estoque Com Jefferson');
      }
    }
  }
  if (contagensSemCorrespondencia.length) {
    throw new HttpError(422, 'Existem ' + contagensSemCorrespondencia.length +
      ' contagens físicas sem correspondência única com o SKU da BASE CONTROLE DE ESTOQUE. Nenhum estoque foi alterado. ' +
      JSON.stringify(contagensSemCorrespondencia.slice(0, 20)));
  }

  // 3) Roupas: Qtd. Estoque é quantidade física explícita. A soma por SKU
  // inclui todas as linhas repetidas já conciliadas pelo importador.
  const roupasWs = localizarAba(wb, 'Política Comercial Roupas (2)');
  if (!roupasWs) throw new HttpError(422, 'A planilha não contém a aba Política Comercial Roupas (2).');
  const cabRoupas = 4;
  const colSkuRoupas = colunaDaPlanilha(roupasWs, cabRoupas, 'Código Industria');
  const colQtdRoupas = colunaDaPlanilha(roupasWs, cabRoupas, 'Qtd. Estoque');
  for (let linha = cabRoupas + 1; linha <= roupasWs.rowCount; linha++) {
    const sku = celulaTexto(roupasWs.getRow(linha).getCell(colSkuRoupas).value).trim();
    if (!sku) continue;
    const quantidade = quantidadeFisicaDaCelula(roupasWs, linha, colQtdRoupas, 'Qtd. Estoque');
    somar(sku, quantidade, 'roupas', linha, 'Qtd. Estoque da Política Comercial Roupas (2)');
  }

  const todosSkus = new Set(plano.itens.map((it) => it.codigo_industria));
  for (const sku of quantidades.keys()) {
    if (!todosSkus.has(sku)) throw new HttpError(422, 'O saldo físico do SKU "' + sku + '" não encontrou um cadastro único no plano.');
  }
  const itens: EstoqueInicialPlanilha[] = plano.itens.map((it) => {
    const saldo = quantidades.get(it.codigo_industria);
    return {
      sku: it.codigo_industria,
      fonte: it.fonte,
      quantidade: saldo?.quantidade ?? 0,
      linhas_origem: saldo?.linhas ?? [],
      observacoes: saldo?.observacoes ?? ['Sem quantidade física declarada nas abas de saldo; estoque inicial zero.'],
    };
  });
  const porFonte: InventarioPlanilha['por_fonte'] = {};
  for (const item of itens) {
    const grupo = porFonte[item.fonte] ?? { skus: 0, unidades: 0 };
    grupo.skus++;
    grupo.unidades += item.quantidade;
    porFonte[item.fonte] = grupo;
  }
  return {
    local_nome: 'LOJA',
    itens,
    total_skus: itens.length,
    total_unidades: itens.reduce((total, item) => total + item.quantidade, 0),
    total_celulas: itens.length,
    por_fonte: porFonte,
    saldos_negativos: saldosNegativos,
    contagens_sem_correspondencia: contagensSemCorrespondencia,
  };
}

/**
 * Lê o arquivo do corpo e devolve a leitura unificada (todas as fontes de
 * cadastro), o plano mesclado, a reconciliação das abas e os códigos de barras.
 */
export async function lerPlano(body: Record<string, unknown>): Promise<{ leitura: Leitura; plano: Plano; reconciliacao: Reconciliacao; inventario: InventarioPlanilha; barcodes: { validos: number; concat: number; invalidos: number } }> {
  const wb = await abrirWorkbook(String(body?.conteudo ?? ''), String(body?.nome ?? ''));
  const wsPrincipal = abaFonte(wb);
  const principal = extrairLinhas(wsPrincipal, FONTES_CADASTRO[0]);
  if (!principal.linhas.length) {
    throw new HttpError(400, `A aba "${ABA_FONTE}" está vazia ou sem linhas de dados a partir da linha ${PRIMEIRA_LINHA_DADOS}.`);
  }
  const { mapa, concat, invalidos } = extrairCodigosBarras(wb);
  const opcoes = { codigos_barras_concat: concat, codigos_barras_invalidos: invalidos };

  const planos: Plano[] = [planejar(principal, mapa, opcoes)];
  const fontesExtra: Leitura[] = [];
  for (const spec of FONTES_CADASTRO.slice(1)) {
    const ws = localizarAba(wb, spec.aba);
    if (!ws) continue;
    const leituraBruta = extrairLinhas(ws, spec);
    if (!leituraBruta.linhas.length) continue;
    const leitura = consolidarSkusRepetidos(leituraBruta);
    fontesExtra.push(leitura);
    planos.push(planejar(leitura, mapa));
  }

  const plano = planos.length > 1 ? mesclarPlanos(planos) : planos[0];
  const reconciliacao = reconciliarAbas(wb, principal);
  const inventario = extrairInventarioPlanilha(wb, plano);
  return { leitura: principal, plano, reconciliacao, inventario, barcodes: { validos: mapa.size, concat, invalidos } };
}

export async function previewCarga(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGestor(actor);
  checkAccess(RESOURCES.produtos, actor, 'create');
  try {
    const { leitura, plano, reconciliacao, inventario } = await lerPlano((req.body || {}) as Record<string, unknown>);
    res.json({
      aba: leitura.aba,
      total: plano.validacoes.registros,
      validacoes: plano.validacoes,
      reconciliacao,
      inventario: {
        local_nome: inventario.local_nome,
        total_skus: inventario.total_skus,
        total_unidades: inventario.total_unidades,
        total_celulas: inventario.total_celulas,
        por_fonte: inventario.por_fonte,
        saldos_negativos_limitados_a_zero: inventario.saldos_negativos,
      },
      familias: plano.familias.map((f) => ({ nome: f.nome, sku: f.sku, categoria_master: f.categoria_master, colecao: f.colecao, itens: f.itens, tamanhos: f.tamanhos, cores: f.cores })),
      amostra: plano.itens.slice(0, 200).map((it) => ({
        linha: it.linha, fonte: it.fonte, item: it.item, sku: it.codigo_industria, pai_sku: it.pai_sku,
        categoria_master: it.categoria_master, colecao: it.colecao, cor: it.cor, tamanho: it.tamanho,
        codigo_barras: it.codigo_barras, acao: it.acao, erros: it.erros,
        unidade: it.unidade, fornecedor: it.fornecedor || null, atributos_adicionais: it.atributos_adicionais,
        precos: it.precos, precos_conflitantes: it.precos_conflitantes,
      })),
      limite: LIMITE_CARGA,
      truncado: plano.itens.length > LIMITE_CARGA,
      nao_gravado: 'Prévia apenas: nenhum produto, variação, preço ou estoque foi gravado. O saldo físico previsto será importado integralmente para um único local padrão LOJA.'
    });
  } catch (e) {
    throw toHttpError(e, RESOURCES.produtos);
  }
}

export async function confirmarCarga(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGestor(actor);
  checkAccess(RESOURCES.produtos, actor, 'create');
  const escopo = escopoDe(actor);
  const s = getStore();
  try {
    const { plano, reconciliacao, inventario } = await lerPlano((req.body || {}) as Record<string, unknown>);
    if (plano.itens.length > LIMITE_CARGA) {
      throw new HttpError(413, `A carga aceita no máximo ${LIMITE_CARGA} linhas por vez. Divida a planilha.`);
    }
    const resultado = await s.transaction(async (tx) => executarCarga(plano, inventario, actor, escopo, tx));
    res.json({
      ok: true,
      ...resultado,
      abas_examinadas: reconciliacao.abas.length,
      reconciliacao,
      estoque_importado: true,
      inventario_planilha: { local: inventario.local_nome, skus: inventario.total_skus, celulas: inventario.total_celulas, unidades: inventario.total_unidades, por_fonte: inventario.por_fonte, saldos_negativos_limitados_a_zero: inventario.saldos_negativos },
      precos_sobrescritos: false,
      formulas_planilha_importadas: false,
      observacao: 'Todas as abas de CADASTRO foram processadas; custos, tributos, margens e preços foram calculados no servidor e registrados com memória por SKU. O estoque físico anterior da empresa foi substituído pelo saldo final da planilha em um único local LOJA; movimentos históricos não foram apagados nem recalculados.'
    });
  } catch (e) {
    throw toHttpError(e, RESOURCES.produtos);
  }
}

// ---------------------------------------------------------------------------
// Execução (dentro de UMA transação; reexecutável sem duplicar).
// ---------------------------------------------------------------------------
async function executarCarga(plano: Plano, inventario: InventarioPlanilha, actor: { id?: number; name?: string }, escopo: Escopo, tx: Tx) {
  const s = getStore();
  // Autoria: só grava o id se o usuário existir de fato. Em banco novo (ou no
  // modo demonstração) o ator é sintético e uma FK inválida rejeitaria TODA a
  // gravação de preço — preferimos a autoria ausente à carga inteira perdida.
  const autorId = actor.id != null && (await s.get(RESOURCES.usuarios, Number(actor.id), tx)) ? Number(actor.id) : null;
  let produtos = 0;
  let variacoes = 0;
  let ignorados = 0;
  let precosGravados = 0;
  let precosIgnorados = 0;
  let precosVersionados = 0;
  let basePrecoDefinida = 0;
  const conflitosPreco: string[] = [];
  const rejeitados: { linha: number; motivo: string }[] = [];
  const ids: number[] = [];
  /** Fontes de cadastro efetivamente processadas nesta execução. */
  const fontesPresentes = [...new Set(plano.itens.map((it) => it.fonte))];

  const catCache = new Map<string, number>();
  const colCache = new Map<string, number>();
  const tamCache = new Map<string, number>();
  const gradeCache = new Map<string, number>();
  const corCache = new Map<string, number>();
  /** SKU da indústria → registro do produto usado para tabela de preços. */
  const idPorSku = new Map<string, number>();
  /** SKU da indústria → célula física canônica (produto-pai + tamanho). */
  const produtoEstoquePorSku = new Map<string, { produto_id: number; tamanho_id: number | null; linha: number }>();

  async function categoriaId(nome: string): Promise<number | null> {
    const chave = normalizarRotulo(nome);
    if (!chave) return null;
    if (catCache.has(chave)) return catCache.get(chave)!;
    const existente = await s.findOneWhere(RESOURCES.categorias, { nome }, tx);
    const id = existente ? Number(existente.id) : Number((await s.insert(RESOURCES.categorias, { nome, ativo: true }, tx)).id);
    catCache.set(chave, id);
    return id;
  }
  async function colecaoId(nome: string): Promise<number | null> {
    const chave = normalizarRotulo(nome);
    if (!chave) return null;
    if (colCache.has(chave)) return colCache.get(chave)!;
    const existente = await s.findOneWhere(RESOURCES.colecoes, { nome, empresa_id: escopo.empresaId }, tx);
    const id = existente ? Number(existente.id) : Number((await s.insert(RESOURCES.colecoes, { nome, empresa_id: escopo.empresaId }, tx)).id);
    colCache.set(chave, id);
    return id;
  }
  async function corId(nome: string): Promise<number | null> {
    const chave = normalizarRotulo(nome);
    if (!chave) return null;
    if (corCache.has(chave)) return corCache.get(chave)!;
    const todas = await s.list(RESOURCES.cores, { page: 1, pageSize: 2_000 }, tx);
    const existente = todas.rows.find((row) => normalizarRotulo(String(row.nome ?? '')) === chave);
    const id = existente
      ? Number(existente.id)
      : Number((await s.insert(RESOURCES.cores, { nome: nome.trim(), ativo: true }, tx)).id);
    corCache.set(chave, id);
    return id;
  }

  async function tamanhoId(codigo: string): Promise<number | null> {
    if (!codigo) return null;
    if (tamCache.has(codigo)) return tamCache.get(codigo)!;
    const existente = await s.findOneWhere(RESOURCES.tamanhos, { codigo }, tx);
    const id = existente ? Number(existente.id) : Number((await s.insert(RESOURCES.tamanhos, { codigo, ordem: ordemTamanho(codigo) }, tx)).id);
    tamCache.set(codigo, id);
    return id;
  }
  /** Cria (ou reaproveita) a grade da família, com seus tamanhos, e devolve o id. */
  async function gradeDaFamilia(familia: PlanoFamilia): Promise<number | null> {
    if (!familia.tamanhos.length) return null;
    if (gradeCache.has(familia.chave)) return gradeCache.get(familia.chave)!;
    const nome = familia.nome.slice(0, 60);
    const existente = await s.findOneWhere(RESOURCES.grades, { nome }, tx);
    const gid = existente ? Number(existente.id) : Number((await s.insert(RESOURCES.grades, { nome, ativo: true }, tx)).id);
    const vinculos = await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 500, filter: { grade_id: gid } }, tx);
    if (!vinculos.rows.length) {
      // Ordem canônica do vestuário (P, M, G, GG, XG, EG) e numérica para os
      // tamanhos em número (38, 40…). A grade é apresentada nessa ordem.
      const pares: { codigo: string; id: number }[] = [];
      for (const codigo of familia.tamanhos) {
        const t = await tamanhoId(codigo);
        if (t) pares.push({ codigo, id: t });
      }
      pares.sort((a, b) => ordemTamanho(a.codigo) - ordemTamanho(b.codigo) || a.codigo.localeCompare(b.codigo));
      let ordem = 1;
      for (const par of pares) {
        await s.insert(RESOURCES.grade_tamanhos, { grade_id: gid, tamanho_id: par.id, ordem }, tx);
        ordem++;
      }
    }
    gradeCache.set(familia.chave, gid);
    return gid;
  }

  const paisPorFamilia = new Map<string, Row>();

  /**
   * Grava os preços OFICIAIS (dados de ENTRADA) do item em
   * `produto_precos_condicao`, VERSIONANDO o preço anterior — nunca o apagando.
   *
   *   • sem preço vigente → cria a linha vigente (`vigencia_fim IS NULL`);
   *   • valor igual       → nada muda (idempotência: reimportar não versiona);
   *   • valor diferente   → FECHA a vigência anterior e abre uma nova; a linha
   *     fechada permanece como HISTÓRICO, e a mudança entra em
   *     `produto_precos_condicao_historico` (auditável).
   *
   * Divergência de valor vira registro no relatório (transparência), não
   * descarte silencioso.
   */
  async function gravarPrecos(produtoId: number, it: ItemNormalizado): Promise<void> {
    const hoje = new Date().toISOString().slice(0, 10);
    for (const preco of it.precos) {
      const valor = round2(preco.preco);
      const { rows } = await s.list(
        RESOURCES.produto_precos_condicao,
        { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao, quantidade_minima: preco.quantidade_minima } },
        tx
      );
      const vigente = rows.find((r) => r.vigencia_fim === null || r.vigencia_fim === undefined) ?? null;

      if (!vigente) {
        await s.insert(RESOURCES.produto_precos_condicao, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao,
          quantidade_minima: preco.quantidade_minima, preco: valor, margem_pct: preco.margem_pct,
          ajuste_pct: preco.ajuste_pct, regra_calculo: preco.regra_calculo,
          origem: it.fonte === 'principal' ? 'planilha_calculada' : 'planilha',
          vigencia_inicio: hoje, vigencia_fim: null, criado_por: autorId, atualizado_por: autorId,
        }, tx);
        await s.insert(RESOURCES.produto_precos_condicao_historico, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao,
          quantidade_minima: preco.quantidade_minima, preco_anterior: null, preco_novo: valor,
          margem_pct: preco.margem_pct, ajuste_pct: preco.ajuste_pct, regra_calculo: preco.regra_calculo,
          vigencia_inicio: hoje, vigencia_fim: null,
          origem: it.fonte === 'principal' ? 'planilha_calculada' : 'planilha', usuario_id: autorId,
        }, tx);
        precosGravados++;
      } else if (round2(Number(vigente.preco)) === valor) {
        // Valor idêntico: conserva vigência, mas atualiza a memória se a fórmula
        // ou os parâmetros de margem/taxa financeira tiverem sido enriquecidos.
        await s.update(RESOURCES.produto_precos_condicao, Number(vigente.id), {
          margem_pct: preco.margem_pct,
          ajuste_pct: preco.ajuste_pct,
          regra_calculo: preco.regra_calculo,
          origem: it.fonte === 'principal' ? 'planilha_calculada' : 'planilha',
          atualizado_por: autorId,
        }, tx);
        precosIgnorados++;
      } else {
        // Fecha a vigência anterior (histórico) e abre a nova. Um dia de
        // sobreposição é aceitável; o motor resolve pela vigência mais recente.
        await s.update(RESOURCES.produto_precos_condicao, Number(vigente.id), { vigencia_fim: hoje, atualizado_por: autorId }, tx);
        await s.insert(RESOURCES.produto_precos_condicao, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao,
          quantidade_minima: preco.quantidade_minima, preco: valor, margem_pct: preco.margem_pct,
          ajuste_pct: preco.ajuste_pct, regra_calculo: preco.regra_calculo,
          origem: it.fonte === 'principal' ? 'planilha_calculada' : 'planilha',
          vigencia_inicio: hoje, vigencia_fim: null, criado_por: autorId, atualizado_por: autorId,
        }, tx);
        await s.insert(RESOURCES.produto_precos_condicao_historico, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao,
          quantidade_minima: preco.quantidade_minima, preco_anterior: round2(Number(vigente.preco)), preco_novo: valor,
          margem_pct: preco.margem_pct, ajuste_pct: preco.ajuste_pct, regra_calculo: preco.regra_calculo,
          vigencia_inicio: hoje, vigencia_fim: null,
          origem: it.fonte === 'principal' ? 'planilha_calculada' : 'planilha', usuario_id: autorId,
        }, tx);
        precosVersionados++;
        conflitosPreco.push(`${it.codigo_industria}|${preco.canal}|${preco.condicao}: ${Number(vigente.preco)} → ${valor}`);
      }
    }
  }

  /**
   * A planilha-base é a política comercial oficial. Atualiza as bases de canal
   * com os preços calculados (ou preços explícitos das fontes complementares),
   * sem tocar em estoque físico ou movimentações.
   */
  async function definirBasesComerciais(produtoId: number, it: ItemNormalizado): Promise<void> {
    const patch: Payload = {};
    const vistaAtacado = it.precos.find((p) => p.canal === 'atacado' && p.condicao === 'atacado_vista');
    const vistaVarejo = it.precos.find((p) => p.canal === 'varejo' && p.condicao === 'varejo_vista' && p.quantidade_minima === 1);
    if (vistaAtacado) patch.preco_atacado = round2(vistaAtacado.preco);
    if (vistaVarejo) patch.preco_venda = round2(vistaVarejo.preco);
    const minAtacado = it.precos.filter((p) => p.canal === 'atacado').reduce<number | null>(
      (min, p) => min === null ? p.quantidade_minima : Math.min(min, p.quantidade_minima), null
    );
    if (minAtacado !== null) patch.atacado_min_qtd = minAtacado;
    if (Object.keys(patch).length) {
      await s.update(RESOURCES.produtos, produtoId, patch, tx);
      basePrecoDefinida++;
    }
  }

  for (const it of plano.itens) {
    try {
      if (it.erros.length) throw new HttpError(400, it.erros.join(' '));
      const familia = plano.familias[it.familia_idx];
      const catId = await categoriaId(it.categoria_master);
      const colId = await colecaoId(it.colecao);
      const corMasterId = await corId(it.cor);
      const tamanhoEstoqueId = await tamanhoId(it.tamanho);

      // Produto-pai: criado UMA vez por família. Em reimportação atualizamos
      // seus atributos; isso não toca na tabela de estoque nem nas movimentações.
      const ehFamiliaVariacao = familia.itens > 1;
      let pai = paisPorFamilia.get(familia.chave) ?? null;
      if (!pai) {
        const skuPai = ehFamiliaVariacao ? familia.sku : it.codigo_industria;
        const existentePai = await s.findOneWhere(RESOURCES.produtos, { sku: skuPai, empresa_id: escopo.empresaId }, tx);
        const payloadPaiRegistro = payloadPai(familia, it, catId, colId, escopo.empresaId, ehFamiliaVariacao, ehFamiliaVariacao ? null : corMasterId);
        if (ehFamiliaVariacao) {
          payloadPaiRegistro.ativo = plano.itens.some((linha) => linha.familia_idx === it.familia_idx && linha.status !== 'INATIVO');
        }
        if (existentePai) {
          pai = await s.update(RESOURCES.produtos, Number(existentePai.id), payloadPaiRegistro, tx) ?? existentePai;
          ignorados++;
        } else {
          validatePayload(RESOURCES.produtos, payloadPaiRegistro, 'create');
          pai = await s.insert(RESOURCES.produtos, payloadPaiRegistro, tx);
          produtos++;
          ids.push(Number(pai.id));
        }
        paisPorFamilia.set(familia.chave, pai);
      }

      // Família de uma linha só: o próprio pai é o SKU da indústria.
      if (it.acao === 'criar_pai') {
        idPorSku.set(it.codigo_industria, Number(pai.id));
        produtoEstoquePorSku.set(it.codigo_industria, { produto_id: Number(pai.id), tamanho_id: tamanhoEstoqueId, linha: it.linha });
        continue;
      }

      // Variação por código de indústria. Saldos próprios do produto antigo
      // são dados de teste/substituição e serão retirados no snapshot atômico
      // logo abaixo; por isso é seguro atualizar o vínculo para o pai canônico.
      const tamId = tamanhoEstoqueId;
      const gid = await gradeDaFamilia(familia);
      const payload = payloadVariacao(it, {
        categoria_id: catId,
        colecao_id: colId,
        grade_id: gid,
        empresa_id: escopo.empresaId,
        produto_pai_id: Number(pai.id),
        variacao_tamanho_id: tamId,
        cor_id: corMasterId,
      });
      const existenteFilho = await s.findOneWhere(RESOURCES.produtos, { sku: it.codigo_industria, empresa_id: escopo.empresaId }, tx);
      if (existenteFilho) {
        const paiAtual = existenteFilho.produto_pai_id == null ? null : Number(existenteFilho.produto_pai_id);
        if (paiAtual !== Number(pai.id)) {
          // A transação substitui todas as células físicas da empresa pela
          // planilha. O saldo anterior deste SKU será removido e compensado
          // por movimento de ajuste; não há estoque a preservar no vínculo velho.
        }
        const atualizado = await s.update(RESOURCES.produtos, Number(existenteFilho.id), payload, tx) ?? existenteFilho;
        ignorados++;
        ids.push(Number(atualizado.id));
        idPorSku.set(it.codigo_industria, Number(atualizado.id));
        produtoEstoquePorSku.set(it.codigo_industria, { produto_id: Number(pai.id), tamanho_id: tamId, linha: it.linha });
      } else {
        validatePayload(RESOURCES.produtos, payload, 'create');
        const filho = await s.insert(RESOURCES.produtos, payload, tx);
        variacoes++;
        ids.push(Number(filho.id));
        idPorSku.set(it.codigo_industria, Number(filho.id));
        produtoEstoquePorSku.set(it.codigo_industria, { produto_id: Number(pai.id), tamanho_id: tamId, linha: it.linha });
      }
    } catch (e: any) {
      const h = toHttpError(e, RESOURCES.produtos);
      rejeitados.push({ linha: it.linha, motivo: h.message });
    }
  }

  // Cadastro ESTRUTURAL das condições de pagamento usadas pela planilha
  // (pix/boleto/cartão). Idempotente por (empresa, código): não duplica.
  const condicoesPresentes = new Set(plano.itens.flatMap((it) => it.precos.map((p) => p.condicao)));
  for (const cond of CONDICOES_DAS_PLANILHA) {
    if (!condicoesPresentes.has(cond.codigo)) continue;
    const existente = await s.findOneWhere(RESOURCES.condicoes_pagamento, { empresa_id: escopo.empresaId, codigo: cond.codigo }, tx);
    if (!existente) {
      await s.insert(RESOURCES.condicoes_pagamento, {
        empresa_id: escopo.empresaId, codigo: cond.codigo, nome: cond.nome, canal: cond.canal,
        parcelas: cond.parcelas, prazo_dias: cond.prazo_dias, ativo: true,
      }, tx);
    }
  }

  // Preços OFICIAIS da planilha (dados de ENTRADA) → `produto_precos_condicao`.
  // Feito depois do cadastro para que o produto já exista; o conflito com o
  // valor já cadastrado é REPORTADO, nunca escondido. Nenhuma fórmula é gravada.
  for (const it of plano.itens) {
    const produtoId = idPorSku.get(it.codigo_industria);
    if (!produtoId || !it.precos.length) continue;
    try {
      await gravarPrecos(produtoId, it);
      const produto = await s.get(RESOURCES.produtos, produtoId, tx);
      if (produto) await definirBasesComerciais(produtoId, it);
    } catch (e: any) {
      const h = toHttpError(e, RESOURCES.produtos);
      rejeitados.push({ linha: it.linha, motivo: `Preço: ${h.message}` });
    }
  }

  // O estoque físico fica no produto-pai. Se os SKUs-filhos têm custos/preços
  // distintos, o pai recebe a média aritmética das variações como custo-base
  // para valorização do saldo único; cada filho conserva sua formação própria.
  const media = (valores: (number | null | undefined)[]): number | null => {
    const validos = valores.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    return validos.length ? arredondar6(validos.reduce((soma, v) => soma + v, 0) / validos.length) : null;
  };
  for (const familia of plano.familias) {
    if (familia.itens <= 1) continue;
    const pai = paisPorFamilia.get(familia.chave);
    if (!pai) continue;
    const variantes = plano.itens.filter((it) => it.familia_idx === plano.familias.indexOf(familia));
    const formacoes = variantes.filter((it) => it.calculo_precificacao !== null);
    if (!formacoes.length) continue;
    const precoMedio = (canal: 'atacado' | 'varejo', condicao: string) => media(
      formacoes.map((it) => it.precos.find((p) => p.canal === canal && p.condicao === condicao && p.quantidade_minima === 1)?.preco ?? null)
    );
    const custoTotal = media(formacoes.map((it) => it.calculo_precificacao!.custo_total))!;
    const minAtacadoFamilia = Math.max(0, ...variantes.map((it) => {
      const quantidades = it.precos.filter((p) => p.canal === 'atacado').map((p) => p.quantidade_minima);
      return quantidades.length ? Math.min(...quantidades) : 0;
    }));
    const memoriaFamilia = {
      versao: 'BROBOND-PRECO-0125-v1',
      tipo: 'media_das_variacoes_para_estoque_pai',
      metodo: 'media_aritmetica_simples_dos_skus_filhos',
      quantidade_variantes_com_formacao: formacoes.length,
      custo_medio_variacoes: custoTotal,
      variantes: formacoes.map((it) => ({
        sku: it.codigo_industria,
        tamanho: it.tamanho,
        cor: it.cor,
        custo_total_imposto: it.calculo_precificacao!.custo_total_com_impostos,
        preco_atacado: it.precos.find((p) => p.canal === 'atacado' && p.condicao === 'atacado_vista')?.preco ?? null,
        preco_varejo: it.precos.find((p) => p.canal === 'varejo' && p.condicao === 'varejo_vista' && p.quantidade_minima === 1)?.preco ?? null,
        memoria: it.calculo_precificacao!.memoria,
      })),
    };
    const patch: Payload = {
      custo: round2(custoTotal),
      custo_total_imposto: media(formacoes.map((it) => it.calculo_precificacao!.custo_total_com_impostos)),
      icms_planilha_valor: media(formacoes.map((it) => it.calculo_precificacao!.icms_valor)),
      icms2_planilha_valor: media(formacoes.map((it) => it.calculo_precificacao!.icms2_valor)),
      custo_unitario_fabricacao: media(formacoes.map((it) => it.calculo_precificacao!.custo_fabricacao)),
      custo_aquisicao_unitario: media(formacoes.map((it) => it.calculo_precificacao!.custo_aquisicao_unitario)),
      simples_nacional_pct: media(formacoes.map((it) => it.calculo_precificacao!.simples_nacional_pct)),
      simples_nacional_valor: media(formacoes.map((it) => it.calculo_precificacao!.simples_nacional_valor)),
      icms_planilha_pct: media(formacoes.map((it) => it.calculo_precificacao!.icms_pct)),
      icms2_planilha_pct: media(formacoes.map((it) => it.calculo_precificacao!.icms2_pct)),
      total_imposto_pct: media(formacoes.map((it) => it.calculo_precificacao!.total_imposto_pct)),
      total_imposto_valor: media(formacoes.map((it) => it.calculo_precificacao!.total_imposto_valor)),
      margem_atacado_pct: media(formacoes.map((it) => it.calculo_precificacao!.margem_atacado_pct)),
      margem_varejo_pct: media(formacoes.map((it) => it.calculo_precificacao!.margem_varejo_pct)),
      margem_varejo_2un_pct: media(formacoes.map((it) => it.calculo_precificacao!.margem_varejo_2un_pct)),
      margem_varejo_cartao_pct: media(formacoes.map((it) => it.calculo_precificacao!.margem_varejo_cartao_pct)),
      preco_atacado: precoMedio('atacado', 'atacado_vista'),
      atacado_min_qtd: minAtacadoFamilia,
      preco_venda: precoMedio('varejo', 'varejo_vista'),
      memoria_formacao_preco: memoriaFamilia,
    };
    await s.update(RESOURCES.produtos, Number(pai.id), patch, tx);
  }

  // GATE FECHADO: não substitui saldo se qualquer SKU, produto, preço ou
  // vínculo de variação tiver sido rejeitado. Toda a transação será revertida.
  if (rejeitados.length) {
    throw new HttpError(
      409,
      'Carga cancelada antes da substituição do estoque: ' + rejeitados.length +
      ' registro(s) foram rejeitados. Primeiro erro: ' + rejeitados[0].motivo
    );
  }
  if (idPorSku.size !== plano.itens.length || produtoEstoquePorSku.size !== inventario.total_skus) {
    throw new HttpError(409,
      'Carga cancelada: o mapeamento de SKU/produto/estoque não fechou. ' +
      'SKUs no plano=' + plano.itens.length + ', preços/produtos=' + idPorSku.size +
      ', SKUs de estoque=' + produtoEstoquePorSku.size + ', SKUs físicos esperados=' + inventario.total_skus + '.');
  }
  if (inventario.total_skus !== plano.itens.length || inventario.total_unidades < 0) {
    throw new HttpError(409, 'Carga cancelada: inventário físico e catálogo não têm a mesma quantidade de SKUs.');
  }

  // Resolve exatamente um local ativo e padrão chamado LOJA. Nenhum estoque
  // separado para varejo, atacado ou representantes é permitido.
  const locaisPadrao = await s.list(
    RESOURCES.locais,
    { page: 1, pageSize: 100, filter: { empresa_id: escopo.empresaId, ativo: true, padrao: true } },
    tx
  );
  if (locaisPadrao.total !== 1 || locaisPadrao.rows.length !== 1 ||
      normalizarRotulo(String(locaisPadrao.rows[0].nome ?? '')) !== normalizarRotulo(inventario.local_nome)) {
    throw new HttpError(409,
      'Carga cancelada: é obrigatório existir exatamente um local ativo/padrão "' + inventario.local_nome +
      '" para a empresa. Encontrados: ' + locaisPadrao.rows.map((l) => String(l.nome) + ' (#' + l.id + ')').join(', ') + '.');
  }
  const localPadrao = locaisPadrao.rows[0];
  const localId = Number(localPadrao.id);
  if (String(localPadrao.nome) !== inventario.local_nome) {
    await s.update(RESOURCES.locais, localId, { nome: inventario.local_nome }, tx);
  }
  const localNome = inventario.local_nome;

  // Prepara e valida TODOS os saldos antes de apagar qualquer célula antiga.
  // A chave física é produto-pai + tamanho + LOJA. Cor já foi isolada no pai.
  const estoqueRows: Payload[] = [];
  const movimentosAjusteRows: Payload[] = [];
  const celulasFisicas = new Set<string>();
  const skuPorCodigo = new Map(plano.itens.map((it) => [it.codigo_industria, it] as const));
  let unidadesFisicasPreparadas = 0;
  let skusComSaldo = 0;
  for (const itemEstoque of inventario.itens) {
    const destino = produtoEstoquePorSku.get(itemEstoque.sku);
    const itemPlano = skuPorCodigo.get(itemEstoque.sku);
    if (!destino || !itemPlano) {
      throw new HttpError(409, 'Carga cancelada: não existe vínculo de estoque para o SKU ' + itemEstoque.sku + '.');
    }
    if (!Number.isInteger(itemEstoque.quantidade) || itemEstoque.quantidade < 0) {
      throw new HttpError(422, 'Quantidade física inválida no SKU ' + itemEstoque.sku + '.');
    }
    const chaveCelula = String(destino.produto_id) + '|' + String(destino.tamanho_id ?? 0) + '|' + String(localId);
    if (celulasFisicas.has(chaveCelula)) {
      throw new HttpError(409,
        'Carga cancelada: dois SKUs seriam gravados na mesma célula física de produto/tamanho/local. SKU conflitante: ' +
        itemEstoque.sku + ', chave ' + chaveCelula + '.');
    }
    celulasFisicas.add(chaveCelula);
    unidadesFisicasPreparadas += itemEstoque.quantidade;
    if (itemEstoque.quantidade > 0) skusComSaldo++;
    estoqueRows.push({
      empresa_id: escopo.empresaId,
      produto_id: destino.produto_id,
      tamanho_id: destino.tamanho_id,
      local_id: localId,
      local: localNome,
      quantidade: itemEstoque.quantidade,
      estoque_min: 0,
    });
    // O movimento será calculado como delta contra a célula anterior logo
    // após a fotografia atual ser lida. Reimportação idêntica gera delta zero.
  }
  if (celulasFisicas.size !== inventario.total_celulas || unidadesFisicasPreparadas !== inventario.total_unidades) {
    throw new HttpError(409,
      'Carga cancelada: a soma das células preparadas não confere com a prévia. Células ' +
      celulasFisicas.size + '/' + inventario.total_celulas + '; unidades ' +
      unidadesFisicasPreparadas + '/' + inventario.total_unidades + '.');
  }

  // Só agora, com catálogo/preços/saldos todos reconciliados, substitui as
  // 101 células de teste (ou o snapshot anterior) pelo snapshot da planilha.
  const estoquesAnteriores = await s.list(
    RESOURCES.estoques,
    { page: 1, pageSize: 5_000, filter: { empresa_id: escopo.empresaId } },
    tx
  );
  if (estoquesAnteriores.total !== estoquesAnteriores.rows.length) {
    throw new HttpError(409,
      'Carga cancelada: a consulta de estoque anterior foi truncada (' +
      estoquesAnteriores.rows.length + '/' + estoquesAnteriores.total + ').');
  }

  const produtosAtuais = await s.list(
    RESOURCES.produtos,
    { page: 1, pageSize: 5_000, filter: { empresa_id: escopo.empresaId } },
    tx
  );
  if (produtosAtuais.total !== produtosAtuais.rows.length) {
    throw new HttpError(409, 'Carga cancelada: catálogo existente truncado; a substituição segura não pode continuar.');
  }
  const produtoPorId = new Map(produtosAtuais.rows.map((p) => [Number(p.id), p] as const));
  const saldoNovoPorCelula = new Map<string, number>();
  for (const row of estoqueRows) {
    const chave = String(row.produto_id) + '|' + String(row.tamanho_id ?? 0) + '|' + String(row.local_id ?? 0);
    if (saldoNovoPorCelula.has(chave)) {
      throw new HttpError(409, 'Carga cancelada: colisão de célula física ' + chave + '.');
    }
    saldoNovoPorCelula.set(chave, Number(row.quantidade));
  }
  const chavesAntigas = new Set<string>();
  for (const saldoAntigo of estoquesAnteriores.rows) {
    const produtoAntigo = produtoPorId.get(Number(saldoAntigo.produto_id));
    if (!produtoAntigo) {
      throw new HttpError(409, 'Carga cancelada: a célula antiga #' + saldoAntigo.id + ' aponta para produto inexistente.');
    }
    const chave = String(saldoAntigo.produto_id) + '|' + String(saldoAntigo.tamanho_id ?? 0) + '|' + String(saldoAntigo.local_id ?? 0);
    chavesAntigas.add(chave);
    const anterior = Number(saldoAntigo.quantidade ?? 0);
    const novo = saldoNovoPorCelula.get(chave) ?? 0;
    const delta = novo - anterior;
    if (delta !== 0) {
      movimentosAjusteRows.push({
        empresa_id: escopo.empresaId,
        tipo: 'ajuste',
        produto_id: Number(saldoAntigo.produto_id),
        tamanho_id: saldoAntigo.tamanho_id == null ? null : Number(saldoAntigo.tamanho_id),
        local_id: saldoAntigo.local_id == null ? null : Number(saldoAntigo.local_id),
        local: String(saldoAntigo.local ?? localNome),
        quantidade: delta,
        usuario_id: autorId,
        motivo: ('Substituição do saldo físico pela planilha-base | SKU ' + String(produtoAntigo.sku) +
          ' | anterior ' + anterior + ' | novo ' + novo + ' | delta ' + delta).slice(0, 200),
      });
    }
  }
  for (const row of estoqueRows) {
    const chave = String(row.produto_id) + '|' + String(row.tamanho_id ?? 0) + '|' + String(row.local_id ?? 0);
    if (chavesAntigas.has(chave)) continue;
    const delta = Number(row.quantidade ?? 0);
    if (delta === 0) continue;
    const produtoNovo = produtoPorId.get(Number(row.produto_id));
    if (!produtoNovo) throw new HttpError(409, 'Carga cancelada: produto pai não encontrado na nova célula ' + chave + '.');
    movimentosAjusteRows.push({
      empresa_id: escopo.empresaId,
      tipo: 'ajuste',
      produto_id: Number(row.produto_id),
      tamanho_id: row.tamanho_id == null ? null : Number(row.tamanho_id),
      local_id: Number(row.local_id),
      local: localNome,
      quantidade: delta,
      custo_unitario: produtoNovo.custo == null ? null : Number(produtoNovo.custo),
      usuario_id: autorId,
      motivo: ('Saldo físico inicial importado da planilha-base | SKU pai ' + String(produtoNovo.sku) +
        ' | saldo ' + delta).slice(0, 200),
    });
  }

  // O snapshot é substituído atomicamente. O razão recebe apenas o DELTA entre
  // a fotografia anterior e a nova; reimportação idêntica não cria movimentos.
  for (const saldoAntigo of estoquesAnteriores.rows) {
    await s.remove(RESOURCES.estoques, Number(saldoAntigo.id), tx);
  }
  await s.insertMany(RESOURCES.estoques, estoqueRows, tx);
  if (movimentosAjusteRows.length) {
    await s.insertMany(RESOURCES.movimentacoes, movimentosAjusteRows, tx);
  }

  // Produtos de teste fora do catálogo-base deixam de ser comercializados.
  // São inativados, não excluídos, para preservar referências históricas/FKs.
  const skusImportados = new Set<string>(idPorSku.keys());
  for (const familia of plano.familias) {
    if (familia.itens > 1) skusImportados.add(familia.sku);
  }
  let produtosAntigosInativados = 0;
  for (const produtoAtual of produtosAtuais.rows) {
    if (skusImportados.has(String(produtoAtual.sku))) continue;
    if (produtoAtual.ativo !== false) {
      await s.update(RESOURCES.produtos, Number(produtoAtual.id), {
        ativo: false,
        origem_dados: 'catalogo_teste_substituido_por_planilha_2026-11-17',
      }, tx);
      produtosAntigosInativados++;
    }
  }

  // O pai que ganhou variações declara o formato (a variação herda a ficha).
  for (const pai of paisPorFamilia.values()) {
    if (String(pai.formato || 'simples') === 'variacao') continue;
    const temFilho = await s.countWhere(RESOURCES.produtos, { produto_pai_id: Number(pai.id), empresa_id: escopo.empresaId }, tx);
    if (temFilho > 0) await s.update(RESOURCES.produtos, Number(pai.id), { formato: 'variacao' }, tx);
  }

  const resumoEstoque = {
    local_id: localId,
    local: localNome,
    celulas_importadas: estoqueRows.length,
    unidades_importadas: unidadesFisicasPreparadas,
    skus_com_saldo: skusComSaldo,
    movimentacoes_ajuste: movimentosAjusteRows.length,
    celulas_teste_substituidas: estoquesAnteriores.rows.length,
    produtos_antigos_inativados: produtosAntigosInativados,
    saldos_negativos_limitados_a_zero: inventario.saldos_negativos.length,
  };
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name || 'Carga da política comercial',
      acao: 'importar',
      recurso: 'produtos',
      registro_id: null,
      descricao: `Carga canônica da planilha: ${produtos} produto(s)-pai, ${variacoes} variação(ões), ${precosGravados} preços gravados, ${precosVersionados} preços versionados; estoque LOJA substituído: ${estoquesAnteriores.rows.length} célula(s) anterior(es) → ${estoqueRows.length} célula(s), ${unidadesFisicasPreparadas} unidade(s); ${produtosAntigosInativados} produto(s) de teste inativado(s).`,
      dados: {
        produtos, variacoes, ignorados,
        precos_gravados: precosGravados, precos_ignorados: precosIgnorados,
        precos_versionados: precosVersionados, base_preco_definida: basePrecoDefinida,
        fontes: fontesPresentes, conflitos_preco: conflitosPreco.slice(0, 100),
        rejeitados: rejeitados.slice(0, 100), ids: ids.slice(0, 100),
        estoque: resumoEstoque,
        inventario_planilha: inventario.por_fonte,
      },
      empresa_id: empresaDoAtorAudit(actor),
    },
    tx
  );

  return {
    produtos,
    variacoes,
    ignorados,
    fontes: fontesPresentes,
    precos_gravados: precosGravados,
    precos_ignorados: precosIgnorados,
    precos_versionados: precosVersionados,
    base_preco_definida: basePrecoDefinida,
    estoque: resumoEstoque,
    inventario_planilha: inventario.por_fonte,
    conflitos_preco: conflitosPreco,
    rejeitados,
    total_identificadores: plano.validacoes.skus_distintos,
  };
}

// ---------------------------------------------------------------------------
// Montagem dos payloads canônicos (só campos de ENTRADA; nada calculado).
// ---------------------------------------------------------------------------
function camposComuns(it: ItemNormalizado, empresaId: number, corId: number | null): Payload {
  const formacao = it.calculo_precificacao;
  const base: Payload = {
    sku: it.codigo_industria,
    nome: (it.descricao || it.nome_pai).slice(0, 120),
    ativo: it.status !== 'INATIVO',
    marca: it.marca || null,
    codigo_item: it.item || null,
    codigo_categoria: it.codigo_categoria || null,
    codigo_industria: it.codigo_industria || null,
    descricao: it.descricao || null,
    cor: it.cor || null,
    cor_id: corId,
    custo: formacao ? round2(formacao.custo_total) : it.custo_base,
    custo_unitario_fabricacao: formacao?.custo_fabricacao ?? (it.fonte === 'principal' ? it.custo_base : null),
    custo_aquisicao_unitario: formacao?.custo_aquisicao_unitario ?? (it.fonte === 'principal' ? null : it.custo_base),
    simples_nacional_pct: formacao?.simples_nacional_pct ?? null,
    simples_nacional_valor: formacao?.simples_nacional_valor ?? null,
    icms_planilha_pct: formacao?.icms_pct ?? null,
    icms2_planilha_pct: formacao?.icms2_pct ?? null,
    icms_planilha_valor: formacao?.icms_valor ?? null,
    icms2_planilha_valor: formacao?.icms2_valor ?? null,
    total_imposto_pct: formacao?.total_imposto_pct ?? null,
    total_imposto_valor: formacao?.total_imposto_valor ?? null,
    custo_total_imposto: formacao?.custo_total_com_impostos ?? null,
    margem_atacado_pct: formacao?.margem_atacado_pct ?? null,
    margem_varejo_pct: formacao?.margem_varejo_pct ?? null,
    margem_varejo_2un_pct: formacao?.margem_varejo_2un_pct ?? null,
    margem_varejo_cartao_pct: formacao?.margem_varejo_cartao_pct ?? null,
    margem_varejo_combo_cartao_pct: formacao?.margem_varejo_combo_cartao_pct ?? null,
    memoria_formacao_preco: formacao?.memoria ?? {},
    peso_liquido_g: it.peso_g,
    peso_bruto_g: it.peso_g,
    altura_mm: it.altura_mm,
    largura_mm: it.largura_mm,
    profundidade_mm: it.profundidade_mm,
    codigo_barras: it.codigo_barras || null,
    // Procedência auditável do cadastro + atributos livres da origem (colunas
    // próprias de cada aba). NUNCA substituem SKU/preço/cor/tamanho/categoria.
    origem_dados: 'planilha',
    atributos_adicionais: it.atributos_adicionais,
    empresa_id: empresaId,
  };
  // Unidade só quando o "Tipo" da planilha casa com uma unidade do ERP — o
  // valor bruto permanece em `atributos_adicionais` quando não casa.
  if (it.unidade) base.unidade = it.unidade;
  return base;
}

function payloadPai(familia: PlanoFamilia, it: ItemNormalizado, categoria_id: number | null, colecao_id: number | null, empresaId: number, ehVariacao: boolean, corId: number | null): Payload {
  const base = camposComuns(it, empresaId, corId);
  if (!ehVariacao) {
    // Produto simples: o próprio código da indústria é o SKU e o cadastro é o
    // da linha (cor, código de barras e descrição originais).
    return { ...base, formato: 'simples', categoria_id, colecao_id };
  }
  // Produto-pai de uma família com variação: SKU derivado da família; cor e
  // código de barras pertencem às variações, não ao pai.
  return {
    ...base,
    sku: familia.sku,
    nome: familia.nome.slice(0, 120),
    descricao: familia.nome,
    cor: null,
    cor_id: null,
    codigo_barras: null,
    codigo_industria: null,
    formato: 'simples',
    categoria_id,
    colecao_id,
  };
}

function payloadVariacao(it: PlanoItem, extra: { categoria_id: number | null; colecao_id: number | null; grade_id: number | null; empresa_id: number; produto_pai_id: number; variacao_tamanho_id: number | null; cor_id: number | null }): Payload {
  return {
    ...camposComuns(it, extra.empresa_id, extra.cor_id),
    formato: 'variacao',
    categoria_id: extra.categoria_id,
    colecao_id: extra.colecao_id,
    grade_id: extra.grade_id,
    produto_pai_id: extra.produto_pai_id,
    variacao_chave: it.variacao_chave,
    variacao_tamanho_id: extra.variacao_tamanho_id,
  };
}
