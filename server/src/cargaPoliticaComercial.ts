// ============================================================================
// CARGA OFICIAL DA POLÍTICA COMERCIAL — importação da planilha-base do ERP.
//
// A planilha ("TABELA DE PREÇO BASE PARA ERP.xlsx") é a FONTE DO CADASTRO: traz
// identificadores, atributos e parâmetros de ENTRADA. O ERP continua sendo a
// autoridade de cálculo — margens, impostos, formação de preço de varejo e
// atacado e política comercial NÃO são importados nem sobrescritos aqui.
//
// Princípios (adendo operacional):
//   • só a aba "Política Comercial Completa" é fonte de cadastro (cabeçalho na
//     linha 11; dados a partir da linha 12);
//   • identificadores preservados como TEXTO (zeros à esquerda intactos);
//   • estoque NÃO é importado — o saldo físico é lançado depois, à parte;
//   • nenhuma fórmula da planilha é transportada; colunas calculadas (margens,
//     impostos, preços resultantes) servem de CONFERÊNCIA, nunca de autoridade;
//   • idempotente: reimportar o mesmo arquivo não duplica produto nem variação.
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
// PREÇOS OFICIAIS DA PLANILHA (dados de ENTRADA, não fórmulas).
//
// A planilha-base traz os preços comerciais OFICIAIS da Brobond por canal e
// condição de pagamento. Eles são IMPORTADOS para `produto_precos_condicao`
// (canal × condição) — o ERP não os recalcula. `Atacado À Vista` e
// `Varejo À Vista` também definem a BASE do canal (`preco_atacado`/`preco_venda`),
// mas SÓ quando a base ainda está zerada: nunca sobrescrevemos preço já definido.
//
// O rótulo casa por nome normalizado (sem acento, minúsculo), tolerando os
// espaços duplos e o erro de digitação da origem ("Débido").
// ---------------------------------------------------------------------------
export type PrecoOficial = { rotulo: string; canal: 'atacado' | 'varejo'; condicao: string; base?: 'atacado' | 'varejo' };
export const PRECOS_OFICIAIS: PrecoOficial[] = [
  { rotulo: 'Atacado À Vista', canal: 'atacado', condicao: 'atacado_vista', base: 'atacado' },
  { rotulo: 'Atacado Boleto 30', canal: 'atacado', condicao: 'boleto_30' },
  { rotulo: 'Atacado Boleto 30/60', canal: 'atacado', condicao: 'boleto_30_60' },
  { rotulo: 'Atacado Boleto 30/60/90', canal: 'atacado', condicao: 'boleto_30_60_90' },
  { rotulo: 'Atacado Cartão Débido', canal: 'atacado', condicao: 'cartao_debito' },
  { rotulo: 'Atacado Cartão Crédito à vista', canal: 'atacado', condicao: 'cartao_credito_vista' },
  { rotulo: 'Atacado Cartão Crédito 30/60', canal: 'atacado', condicao: 'cartao_credito_30_60' },
  { rotulo: 'Atacado Cartão Crédito 30/60/90', canal: 'atacado', condicao: 'cartao_credito_30_60_90' },
  { rotulo: 'Varejo À Vista', canal: 'varejo', condicao: 'varejo_vista', base: 'varejo' },
  { rotulo: 'VRJ 2 Un', canal: 'varejo', condicao: 'varejo_2un' },
  { rotulo: 'Vlr Cartão à Vista', canal: 'varejo', condicao: 'cartao_vista' },
  { rotulo: 'Vlr Cartão Parcelado', canal: 'varejo', condicao: 'cartao_parcelado' },
];
const PRECOS_OFICIAIS_POR_ROTULO = new Map(PRECOS_OFICIAIS.map((p) => [normalizarRotulo(p.rotulo), p]));

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
  { codigo: 'varejo_2un', nome: 'Varejo 2 unidades', canal: 'varejo', parcelas: 1, prazo_dias: 0 },
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
  // Margens/tributação calculadas pela planilha: CONFERÊNCIA (não autoridade).
  { match: /mgb|mgl|margem/, natureza: 'conferencia', nota: 'Margem calculada pela planilha — referência, não autoridade.' },
  { match: /imposto|icms|simples nacional|total valor|custo\s*tt/, natureza: 'conferencia', nota: 'Tributação/custo com imposto calculado pela planilha.' },
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
  // Preço OFICIAL (canal × condição) é dado de ENTRADA — precisa vencer a regra
  // genérica de "preço calculado" logo abaixo.
  if (PRECOS_OFICIAIS_POR_ROTULO.has(r)) return { natureza: 'entrada', nota: 'Preço oficial por condição de pagamento (dado de entrada).' };
  for (const c of CLASSIFICACAO) if (c.match.test(r)) return { natureza: c.natureza, nota: c.nota };
  return { natureza: 'ignorada', nota: 'Coluna não reconhecida — depende de validação.' };
}

// ---------------------------------------------------------------------------
// Leitura do arquivo.
// ---------------------------------------------------------------------------
export type LinhaBruta = { linha: number; celulas: Record<string, string> };
export type Leitura = {
  aba: string;
  cabecalho: string[];
  linhas: LinhaBruta[];
  classificacao: { coluna: string; natureza: NaturezaColuna; nota: string }[];
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

/** Lê a aba-fonte de um worksheet já carregado. */
export function extrairLinhas(ws: ExcelJS.Worksheet): Leitura {
  const cabRow = ws.getRow(LINHA_CABECALHO);
  const cabecalho: string[] = [];
  const colunas: { index: number; rotulo: string }[] = [];
  const maxCol = Math.max(ws.columnCount || 0, cabRow.cellCount || 0);
  for (let c = 1; c <= maxCol; c++) {
    const rotulo = celulaTexto(cabRow.getCell(c).value).replace(/\s+/g, ' ').trim();
    cabecalho.push(rotulo);
    colunas.push({ index: c, rotulo });
  }
  const linhas: LinhaBruta[] = [];
  for (let r = PRIMEIRA_LINHA_DADOS; r <= ws.rowCount; r++) {
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
  return { aba: ws.name, cabecalho: cabecalho.filter((c) => c), linhas, classificacao };
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
  /** Preços oficiais da linha, por condição de pagamento (dados de ENTRADA). */
  precos: { canal: 'atacado' | 'varejo'; condicao: string; preco: number }[];
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

/** Descrição-base do produto-pai: remove o sufixo de cor da descrição. */
export function descricaoBase(descricao: string, cor: string): string {
  const d = String(descricao ?? '').trim();
  const c = String(cor ?? '').trim();
  if (c && d.toUpperCase().endsWith(c.toUpperCase())) return d.slice(0, d.length - c.length).replace(/\s+$/, '');
  return d;
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

function numero(v: string): number | null {
  const n = parseNumeroTexto(v);
  return n === null || !Number.isFinite(n) ? null : n;
}

function cmParaMm(cm: number | null): number | null {
  if (cm === null) return null;
  const mm = Math.round(cm * 10);
  return mm > 0 ? mm : null;
}

/** Normaliza uma linha bruta (sem consultar o banco). */
export function normalizarItem(linha: LinhaBruta, barcodePorIndustria: Map<string, string>): ItemNormalizado {
  const c = linha.celulas;
  const descricao = pegar(c, 'DESCRIÇÃO').trim();
  const cor = pegar(c, 'VARIANTE COR').trim();
  const codigo_industria = pegar(c, 'Código Industria').trim();
  const categoria_master = pegar(c, 'CATEGORIA MASTER').trim();
  const colecao = pegar(c, 'COLEÇÃO').trim();
  const marca = pegar(c, 'MARCA').trim();
  const base = descricaoBase(descricao, cor);
  const familia = [categoria_master, colecao, marca, base].map((x) => normalizarRotulo(x)).join('|');
  const pesoKg = numero(pegar(c, 'Peso KG'));
  return {
    linha: linha.linha,
    item: pegar(c, 'Item').trim(),
    codigo_categoria: pegar(c, 'Cód Categoria').trim(),
    categoria_master,
    colecao,
    cor,
    descricao,
    tamanho: normalizarTamanho(pegar(c, 'Tamanho')),
    codigo_industria,
    tipo: pegar(c, 'Tipo').trim(),
    status: pegar(c, 'STATUS').trim().toUpperCase(),
    peso_g: pesoKg === null ? null : Math.round(pesoKg * 1000),
    altura_mm: cmParaMm(numero(pegar(c, 'Altura CM', 'Altura\nCM'))),
    largura_mm: cmParaMm(numero(pegar(c, 'Largura CM', 'Largura\nCM'))),
    profundidade_mm: cmParaMm(numero(pegar(c, 'Comprimento ou profundidade CM', 'Comprimento ou profundidade\nCM'))),
    custo_base: numero(pegar(c, 'Custo Unitário Fabricação')),
    marca,
    codigo_barras: barcodePorIndustria.get(codigo_industria) || null,
    familia,
    nome_pai: base || descricao || codigo_industria,
    pai_sku: skuPaiDe(categoria_master, colecao),
    precos: extrairPrecosOficiais(c),
  };
}

/** Lê os preços oficiais da linha (canal × condição). Ignora célula vazia. */
export function extrairPrecosOficiais(celulas: Record<string, string>): { canal: 'atacado' | 'varejo'; condicao: string; preco: number }[] {
  const out: { canal: 'atacado' | 'varejo'; condicao: string; preco: number }[] = [];
  for (const [k, v] of Object.entries(celulas)) {
    const spec = PRECOS_OFICIAIS_POR_ROTULO.get(normalizarRotulo(k));
    if (!spec) continue;
    const p = numero(v);
    if (p === null || p <= 0) continue;
    out.push({ canal: spec.canal, condicao: spec.condicao, preco: p });
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
  /** Conflito DENTRO do arquivo: mesmo SKU+canal+condição com valores distintos. */
  precos_conflitantes_arquivo: string[];
};

export type Plano = { itens: PlanoItem[]; familias: PlanoFamilia[]; validacoes: Validacoes };

/**
 * Monta o plano de carga. Uma família com mais de uma linha (mesma categoria,
 * coleção, marca e descrição-base) é um produto COM variação: cada linha vira
 * uma variação e um produto-pai é criado uma única vez. Família de uma linha só
 * é um produto simples.
 */
export function planejar(leitura: Leitura, barcodePorIndustria: Map<string, string>, opcoes: { codigos_barras_concat?: number; codigos_barras_invalidos?: number } = {}): Plano {
  const itens = leitura.linhas.map((l) => normalizarItem(l, barcodePorIndustria));

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
    if (multi && !it.tamanho) semTamanho.push(it.item || it.codigo_industria);
    if (!it.cor) semCor.push(it.item || it.codigo_industria);
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
      const chave = `${p.codigo_industria}|${preco.canal}|${preco.condicao}`;
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

/** Lê o arquivo do corpo e devolve leitura + plano (com códigos de barras válidos). */
export async function lerPlano(body: Record<string, unknown>): Promise<{ leitura: Leitura; plano: Plano; barcodes: { validos: number; concat: number; invalidos: number } }> {
  const wb = await abrirWorkbook(String(body?.conteudo ?? ''), String(body?.nome ?? ''));
  const ws = abaFonte(wb);
  const leitura = extrairLinhas(ws);
  if (!leitura.linhas.length) {
    throw new HttpError(400, `A aba "${ABA_FONTE}" está vazia ou sem linhas de dados a partir da linha ${PRIMEIRA_LINHA_DADOS}.`);
  }
  const { mapa, concat, invalidos } = extrairCodigosBarras(wb);
  const plano = planejar(leitura, mapa, { codigos_barras_concat: concat, codigos_barras_invalidos: invalidos });
  return { leitura, plano, barcodes: { validos: mapa.size, concat, invalidos } };
}

export async function previewCarga(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGestor(actor);
  checkAccess(RESOURCES.produtos, actor, 'create');
  try {
    const { leitura, plano } = await lerPlano((req.body || {}) as Record<string, unknown>);
    res.json({
      aba: leitura.aba,
      total: plano.validacoes.registros,
      validacoes: plano.validacoes,
      familias: plano.familias.map((f) => ({ nome: f.nome, sku: f.sku, categoria_master: f.categoria_master, colecao: f.colecao, itens: f.itens, tamanhos: f.tamanhos, cores: f.cores })),
      amostra: plano.itens.slice(0, 200).map((it) => ({
        linha: it.linha, item: it.item, sku: it.codigo_industria, pai_sku: it.pai_sku,
        categoria_master: it.categoria_master, colecao: it.colecao, cor: it.cor, tamanho: it.tamanho,
        codigo_barras: it.codigo_barras, acao: it.acao, erros: it.erros,
        precos: it.precos, precos_conflitantes: it.precos_conflitantes,
      })),
      limite: LIMITE_CARGA,
      truncado: plano.itens.length > LIMITE_CARGA,
      nao_gravado: 'Prévia apenas: nenhum produto, variação, preço ou estoque foi gravado.',
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
    const { plano } = await lerPlano((req.body || {}) as Record<string, unknown>);
    if (plano.itens.length > LIMITE_CARGA) {
      throw new HttpError(413, `A carga aceita no máximo ${LIMITE_CARGA} linhas por vez. Divida a planilha.`);
    }
    const resultado = await s.transaction(async (tx) => executarCarga(plano, actor, escopo, tx));
    res.json({
      ok: true,
      ...resultado,
      estoque_importado: false,
      precos_sobrescritos: false,
      formulas_importadas: false,
      observacao: 'Preços oficiais gravados como DADOS de entrada (produto_precos_condicao). A base do canal só foi preenchida onde estava zerada. Margens, impostos e formação de preço do ERP não foram tocados.',
    });
  } catch (e) {
    throw toHttpError(e, RESOURCES.produtos);
  }
}

// ---------------------------------------------------------------------------
// Execução (dentro de UMA transação; reexecutável sem duplicar).
// ---------------------------------------------------------------------------
async function executarCarga(plano: Plano, actor: { id?: number; name?: string }, escopo: Escopo, tx: Tx) {
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

  const catCache = new Map<string, number>();
  const colCache = new Map<string, number>();
  const tamCache = new Map<string, number>();
  const gradeCache = new Map<string, number>();
  /** SKU (Código Industria) → id do produto canônico, para gravar os preços. */
  const idPorSku = new Map<string, number>();

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
        { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao } },
        tx
      );
      const vigente = rows.find((r) => r.vigencia_fim === null || r.vigencia_fim === undefined) ?? null;

      if (!vigente) {
        await s.insert(RESOURCES.produto_precos_condicao, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao, preco: valor,
          origem: 'planilha', vigencia_inicio: hoje, vigencia_fim: null, criado_por: autorId, atualizado_por: autorId,
        }, tx);
        await s.insert(RESOURCES.produto_precos_condicao_historico, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao,
          preco_anterior: null, preco_novo: valor, vigencia_inicio: hoje, vigencia_fim: null, origem: 'planilha', usuario_id: autorId,
        }, tx);
        precosGravados++;
      } else if (round2(Number(vigente.preco)) === valor) {
        precosIgnorados++;
      } else {
        // Fecha a vigência anterior (histórico) e abre a nova. Um dia de
        // sobreposição é aceitável; o motor resolve pela vigência mais recente.
        await s.update(RESOURCES.produto_precos_condicao, Number(vigente.id), { vigencia_fim: hoje, atualizado_por: autorId }, tx);
        await s.insert(RESOURCES.produto_precos_condicao, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao, preco: valor,
          origem: 'planilha', vigencia_inicio: hoje, vigencia_fim: null, criado_por: autorId, atualizado_por: autorId,
        }, tx);
        await s.insert(RESOURCES.produto_precos_condicao_historico, {
          empresa_id: escopo.empresaId, produto_id: produtoId, canal: preco.canal, condicao: preco.condicao,
          preco_anterior: round2(Number(vigente.preco)), preco_novo: valor, vigencia_inicio: hoje, vigencia_fim: null, origem: 'planilha', usuario_id: autorId,
        }, tx);
        precosVersionados++;
        conflitosPreco.push(`${it.codigo_industria}|${preco.canal}|${preco.condicao}: ${Number(vigente.preco)} → ${valor}`);
      }
    }
  }

  /**
   * Define a BASE do canal (`preco_atacado`/`preco_venda`) a partir do preço
   * "à vista" da planilha — SOMENTE quando a base ainda está ZERADA. Nunca
   * sobrescreve um preço já definido no ERP.
   */
  async function definirBaseSeVazia(produtoId: number, produto: Row, it: ItemNormalizado): Promise<void> {
    const patch: Payload = {};
    for (const spec of PRECOS_OFICIAIS) {
      if (!spec.base) continue;
      const preco = it.precos.find((p) => p.condicao === spec.condicao);
      if (!preco) continue;
      const campo = spec.base === 'atacado' ? 'preco_atacado' : 'preco_venda';
      if (Number(produto[campo] || 0) === 0) patch[campo] = round2(preco.preco);
    }
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

      // Produto-pai: criado UMA vez por família.
      const ehFamiliaVariacao = familia.itens > 1;
      let pai = paisPorFamilia.get(familia.chave) ?? null;
      let paiNovo = false;
      if (!pai) {
        const skuPai = ehFamiliaVariacao ? familia.sku : it.codigo_industria;
        const existente = await s.findOneWhere(RESOURCES.produtos, { sku: skuPai, empresa_id: escopo.empresaId }, tx);
        if (existente) pai = existente;
        else {
          const payload = payloadPai(familia, it, catId, colId, escopo.empresaId, ehFamiliaVariacao);
          // Valida com o contrato canônico (tipos, GTIN, limites). Insere o
          // payload original porque os campos de vínculo (produto_pai_id,
          // variacao_chave, variacao_tamanho_id) são `readonly` e o validador
          // os descarta — exatamente como o fluxo de variações já faz.
          validatePayload(RESOURCES.produtos, payload, 'create');
          pai = await s.insert(RESOURCES.produtos, payload, tx);
          paiNovo = true;
          produtos++;
          ids.push(Number(pai.id));
        }
        paisPorFamilia.set(familia.chave, pai);
      }

      // Família de uma linha só: o próprio pai é o produto — nada mais a criar.
      if (it.acao === 'criar_pai') {
        if (!paiNovo) ignorados++;
        idPorSku.set(it.codigo_industria, Number(pai.id));
        continue;
      }

      // Variação (idempotente por SKU).
      const existente = await s.findOneWhere(RESOURCES.produtos, { sku: it.codigo_industria, empresa_id: escopo.empresaId }, tx);
      if (existente) { ignorados++; ids.push(Number(existente.id)); idPorSku.set(it.codigo_industria, Number(existente.id)); continue; }
      const tamId = await tamanhoId(it.tamanho);
      const gid = await gradeDaFamilia(familia);
      const payload = payloadVariacao(it, { categoria_id: catId, colecao_id: colId, grade_id: gid, empresa_id: escopo.empresaId, produto_pai_id: Number(pai.id), variacao_tamanho_id: tamId });
      validatePayload(RESOURCES.produtos, payload, 'create');
      const filho = await s.insert(RESOURCES.produtos, payload, tx);
      variacoes++;
      ids.push(Number(filho.id));
      idPorSku.set(it.codigo_industria, Number(filho.id));
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
      if (produto) await definirBaseSeVazia(produtoId, produto, it);
    } catch (e: any) {
      const h = toHttpError(e, RESOURCES.produtos);
      rejeitados.push({ linha: it.linha, motivo: `Preço: ${h.message}` });
    }
  }

  // O pai que ganhou variações declara o formato (a variação herda a ficha).
  for (const pai of paisPorFamilia.values()) {
    if (String(pai.formato || 'simples') === 'variacao') continue;
    const temFilho = await s.countWhere(RESOURCES.produtos, { produto_pai_id: Number(pai.id), empresa_id: escopo.empresaId }, tx);
    if (temFilho > 0) await s.update(RESOURCES.produtos, Number(pai.id), { formato: 'variacao' }, tx);
  }

  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name || 'Carga da política comercial',
      acao: 'importar',
      recurso: 'produtos',
      registro_id: null,
      descricao: `Carga da política comercial: ${produtos} produto(s)-pai, ${variacoes} variação(ões), ${ignorados} ignorado(s), ${precosGravados} preço(s) oficial(is) gravado(s), ${precosVersionados} preço(s) versionado(s), ${rejeitados.length} rejeitado(s). Nenhuma quantidade física importada; nenhuma margem/fórmula do ERP sobrescrita.`,
      dados: { produtos, variacoes, ignorados, precos_gravados: precosGravados, precos_ignorados: precosIgnorados, precos_versionados: precosVersionados, base_preco_definida: basePrecoDefinida, conflitos_preco: conflitosPreco.slice(0, 100), rejeitados: rejeitados.slice(0, 100), ids: ids.slice(0, 100) },
      empresa_id: empresaDoAtorAudit(actor),
    },
    tx
  );

  return {
    produtos,
    variacoes,
    ignorados,
    precos_gravados: precosGravados,
    precos_ignorados: precosIgnorados,
    precos_versionados: precosVersionados,
    base_preco_definida: basePrecoDefinida,
    conflitos_preco: conflitosPreco,
    rejeitados,
    total_identificadores: plano.validacoes.skus_distintos,
  };
}

// ---------------------------------------------------------------------------
// Montagem dos payloads canônicos (só campos de ENTRADA; nada calculado).
// ---------------------------------------------------------------------------
function camposComuns(it: ItemNormalizado, empresaId: number): Payload {
  return {
    sku: it.codigo_industria,
    nome: (it.descricao || it.nome_pai).slice(0, 120),
    ativo: it.status !== 'INATIVO',
    marca: it.marca || null,
    codigo_item: it.item || null,
    codigo_categoria: it.codigo_categoria || null,
    codigo_industria: it.codigo_industria || null,
    descricao: it.descricao || null,
    cor: it.cor || null,
    custo: it.custo_base,
    peso_liquido_g: it.peso_g,
    peso_bruto_g: it.peso_g,
    altura_mm: it.altura_mm,
    largura_mm: it.largura_mm,
    profundidade_mm: it.profundidade_mm,
    codigo_barras: it.codigo_barras || null,
    empresa_id: empresaId,
  };
}

function payloadPai(familia: PlanoFamilia, it: ItemNormalizado, categoria_id: number | null, colecao_id: number | null, empresaId: number, ehVariacao: boolean): Payload {
  const base = camposComuns(it, empresaId);
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
    codigo_barras: null,
    codigo_industria: null,
    formato: 'simples',
    categoria_id,
    colecao_id,
  };
}

function payloadVariacao(it: PlanoItem, extra: { categoria_id: number | null; colecao_id: number | null; grade_id: number | null; empresa_id: number; produto_pai_id: number; variacao_tamanho_id: number | null }): Payload {
  return {
    ...camposComuns(it, extra.empresa_id),
    formato: 'variacao',
    categoria_id: extra.categoria_id,
    colecao_id: extra.colecao_id,
    grade_id: extra.grade_id,
    produto_pai_id: extra.produto_pai_id,
    variacao_chave: it.variacao_chave,
    variacao_tamanho_id: extra.variacao_tamanho_id,
  };
}
