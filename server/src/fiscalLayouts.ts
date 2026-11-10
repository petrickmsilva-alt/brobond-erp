// ============================================================================
// FASE 9.5 — LEIAUTES FISCAIS SPED/EFD: REGISTRO VERSIONADO, GERADOR E VALIDADOR
//
// ESCOPO
// ------
// Estrutura de dados fiscal + geração/validação ESTRUTURAL do arquivo EFD
// ICMS/IPI. NÃO há transmissão, assinatura digital, emissão de documento fiscal
// real nem declaração de homologação pela Receita/SEFAZ. O que existe aqui é o
// modelo interno, o mapeamento para os registros oficiais, a validação de
// campos/tipos/relacionamentos/totais e o controle de versão do leiaute.
//
// FONTES OFICIAIS (consultadas em 2026-11-09 — ver docs/fiscal/REGULATORY-SOURCES.md)
//   • EFD ICMS/IPI — Guia Prático v3.2.2 (11/02/2026) e Manual de Orientação do
//     Leiaute (NT 2025.001, leiaute 020). http://sped.rfb.gov.br/pasta/show/1573
//   • EFD-Contribuições — Guia Prático v1.35, Tabela 3.1.1 (ADE Cofis).
//     http://sped.rfb.gov.br/item/show/1989
//
// REGRA DURA: nenhum campo, código (CFOP/CST/NCM) ou alíquota é inventado aqui.
// A gramática abaixo transcreve os campos PUBLICADOS nos guias; códigos de
// tributação vêm das regras da empresa (`regras_fiscais`) e da configuração
// fiscal (`empresa_fiscal_config`). Sem dado → sem arquivo (nunca um zero
// enganoso).
// ============================================================================
import { HttpError } from './errors';
import { getStore } from './services';
import { getResource } from './resources';
import type { Row } from './store';

export type SistemaFiscal = 'EFD_ICMS_IPI' | 'EFD_CONTRIBUICOES';

/** Gramática de um campo: nome, tipo (C caractere / N numérico) e obrigação. */
export type CampoLayout = {
  nome: string;
  tipo: 'C' | 'N';
  /** Obrigatório (O), condicional (OC) ou não obrigatório (N). */
  obrig: 'O' | 'OC' | 'N';
  /** Tamanho máximo; ausente = sem limite (campo texto livre). */
  tam?: number;
  /** Casas decimais (só para numéricos com dec). */
  dec?: number;
  /** Expressão que o valor precisa casar (após normalização). */
  regex?: RegExp;
};

export type LayoutRegistro = { nome: string; campos: CampoLayout[] };

const C = (nome: string, tam: number | undefined, obrig: CampoLayout['obrig'], regex?: RegExp): CampoLayout => ({ nome, tipo: 'C', tam, obrig, regex });
const N = (nome: string, tam: number | undefined, dec: number | undefined, obrig: CampoLayout['obrig'], regex?: RegExp): CampoLayout => ({ nome, tipo: 'N', tam, dec, obrig, regex });

const RE_DATA = /^\d{8}$/;
const RE_CNPJ = /^\d{14}$/;
const RE_CPF = /^\d{11}$/;
const RE_CHAVE = /^\d{44}$/;
const RE_CFOP = /^\d{4}$/;
const RE_NCM = /^\d{8}$/;
const RE_UF = /^[A-Z]{2}$/;

/**
 * Gramática EFD ICMS/IPI (leiaute 018/019/020 — os campos destes registros não
 * mudaram entre as três versões). Fonte: Guia Prático 3.2.2, capítulos 3 e 4.
 */
export const GRAMATICA_EFD_ICMS_IPI: Record<string, LayoutRegistro> = {
  '0000': { nome: 'Abertura do arquivo e identificação da entidade', campos: [
    C('REG', 4, 'O', /^0000$/), N('COD_VER', 3, undefined, 'O'), N('COD_FIN', 1, undefined, 'O', /^[01]$/),
    N('DT_INI', 8, undefined, 'O', RE_DATA), N('DT_FIN', 8, undefined, 'O', RE_DATA), C('NOME', 100, 'O'),
    N('CNPJ', 14, undefined, 'OC', RE_CNPJ), N('CPF', 11, undefined, 'OC', RE_CPF), C('UF', 2, 'O', RE_UF),
    C('IE', 14, 'O'), N('COD_MUN', 7, undefined, 'O'), C('IM', undefined, 'OC'), C('SUFRAMA', 9, 'OC'),
    C('IND_PERFIL', 1, 'O', /^[ABC]$/), N('IND_ATIV', 1, undefined, 'O', /^[01]$/),
  ] },
  '0001': { nome: 'Abertura do Bloco 0', campos: [C('REG', 4, 'O', /^0001$/), N('IND_MOV', 1, undefined, 'O', /^[01]$/)] },
  '0150': { nome: 'Cadastro do participante', campos: [
    C('REG', 4, 'O', /^0150$/), C('COD_PART', 60, 'O'), C('NOME', 100, 'O'), N('COD_PAIS', 5, undefined, 'O'),
    N('CNPJ', 14, undefined, 'OC', RE_CNPJ), N('CPF', 11, undefined, 'OC', RE_CPF), C('IE', 14, 'OC'),
    N('COD_MUN', 7, undefined, 'OC'), C('SUFRAMA', 9, 'OC'), C('END', 60, 'O'), C('NUM', 10, 'OC'),
    C('COMPL', 60, 'OC'), C('BAIRRO', 60, 'OC'),
  ] },
  '0190': { nome: 'Identificação das unidades de medida', campos: [
    C('REG', 4, 'O', /^0190$/), C('UNID', 6, 'O'), C('DESCR', undefined, 'O'),
  ] },
  '0200': { nome: 'Identificação do item (produto/serviço)', campos: [
    C('REG', 4, 'O', /^0200$/), C('COD_ITEM', 60, 'O'), C('DESCR_ITEM', undefined, 'O'), C('COD_BARRA', undefined, 'OC'),
    C('COD_ANT_ITEM', 60, 'OC'), C('UNID_INV', 6, 'O'), N('TIPO_ITEM', 2, undefined, 'O'), C('COD_NCM', 8, 'OC', RE_NCM),
    C('EX_IPI', 3, 'OC'), N('COD_GEN', 2, undefined, 'OC'), C('COD_LST', 5, 'OC'), N('ALIQ_ICMS', 6, 2, 'OC'), C('CEST', 7, 'OC'),
  ] },
  '0990': { nome: 'Encerramento do Bloco 0', campos: [C('REG', 4, 'O', /^0990$/), N('QTD_LIN_0', undefined, undefined, 'O')] },
  C001: { nome: 'Abertura do Bloco C', campos: [C('REG', 4, 'O', /^C001$/), N('IND_MOV', 1, undefined, 'O', /^[01]$/)] },
  C100: { nome: 'Nota fiscal (códigos 01, 1B, 04, 55, 65)', campos: [
    C('REG', 4, 'O', /^C100$/), C('IND_OPER', 1, 'O', /^[01]$/), C('IND_EMIT', 1, 'O', /^[01]$/), C('COD_PART', 60, 'OC'),
    C('COD_MOD', 2, 'O'), C('COD_SIT', 2, 'O'), C('SER', 3, 'OC'), N('NUM_DOC', 9, undefined, 'O'), N('CHV_NFE', 44, undefined, 'OC', RE_CHAVE),
    N('DT_DOC', 8, undefined, 'O', RE_DATA), N('DT_E_S', 8, undefined, 'OC', RE_DATA), N('VL_DOC', undefined, 2, 'O'),
    C('IND_PGTO', 1, 'O'), N('VL_DESC', undefined, 2, 'OC'), N('VL_ABAT_NT', undefined, 2, 'OC'), N('VL_MERC', undefined, 2, 'OC'),
    C('IND_FRT', 1, 'O'), N('VL_FRT', undefined, 2, 'OC'), N('VL_SEG', undefined, 2, 'OC'), N('VL_OUT_DA', undefined, 2, 'OC'),
    N('VL_BC_ICMS', undefined, 2, 'OC'), N('VL_ICMS', undefined, 2, 'OC'), N('VL_BC_ICMS_ST', undefined, 2, 'OC'),
    N('VL_ICMS_ST', undefined, 2, 'OC'), N('VL_IPI', undefined, 2, 'OC'), N('VL_PIS', undefined, 2, 'OC'),
    N('VL_COFINS', undefined, 2, 'OC'), N('VL_PIS_ST', undefined, 2, 'OC'), N('VL_COFINS_ST', undefined, 2, 'OC'),
  ] },
  C170: { nome: 'Itens do documento', campos: [
    C('REG', 4, 'O', /^C170$/), N('NUM_ITEM', 3, undefined, 'O'), C('COD_ITEM', 60, 'O'), C('DESCR_COMPL', undefined, 'OC'),
    N('QTD', undefined, 5, 'O'), C('UNID', 6, 'O'), N('VL_ITEM', undefined, 2, 'O'), N('VL_DESC', undefined, 2, 'OC'),
    C('IND_MOV', 1, 'O', /^[01]$/), N('CST_ICMS', 3, undefined, 'O'), N('CFOP', 4, undefined, 'O', RE_CFOP), C('COD_NAT', 10, 'OC'),
    N('VL_BC_ICMS', undefined, 2, 'OC'), N('ALIQ_ICMS', 6, 2, 'OC'), N('VL_ICMS', undefined, 2, 'OC'),
    N('VL_BC_ICMS_ST', undefined, 2, 'OC'), N('ALIQ_ST', 6, 2, 'OC'), N('VL_ICMS_ST', undefined, 2, 'OC'),
    N('IND_APUR', 1, undefined, 'OC'), N('CST_IPI', 2, undefined, 'OC'), C('COD_ENQ', 3, 'OC'), N('VL_BC_IPI', undefined, 2, 'OC'),
    N('ALIQ_IPI', 6, 2, 'OC'), N('VL_IPI', undefined, 2, 'OC'), N('CST_PIS', 2, undefined, 'OC'), N('VL_BC_PIS', undefined, 2, 'OC'),
    N('ALIQ_PIS', 8, 4, 'OC'), N('QUANT_BC_PIS', undefined, 3, 'OC'), N('ALIQ_PIS_QUANT', 8, 4, 'OC'), N('VL_PIS', undefined, 2, 'OC'),
    N('CST_COFINS', 2, undefined, 'OC'), N('VL_BC_COFINS', undefined, 2, 'OC'), N('ALIQ_COFINS', 8, 4, 'OC'),
    N('QUANT_BC_COFINS', undefined, 3, 'OC'), N('ALIQ_COFINS_QUANT', 8, 4, 'OC'), N('VL_COFINS', undefined, 2, 'OC'),
    C('COD_CTA', undefined, 'OC'), N('VL_ABAT_NT', undefined, 2, 'OC'),
  ] },
  C190: { nome: 'Registro analítico do documento', campos: [
    C('REG', 4, 'O', /^C190$/), N('CST_ICMS', 3, undefined, 'O'), N('CFOP', 4, undefined, 'O', RE_CFOP),
    N('ALIQ_ICMS', 6, 2, 'OC'), N('VL_OPR', undefined, 2, 'O'), N('VL_BC_ICMS', undefined, 2, 'OC'),
    N('VL_ICMS', undefined, 2, 'OC'), N('VL_BC_ICMS_ST', undefined, 2, 'OC'), N('VL_ICMS_ST', undefined, 2, 'OC'),
    N('VL_RED_BC', undefined, 2, 'OC'), N('VL_IPI', undefined, 2, 'OC'), C('COD_OBS', 6, 'OC'),
  ] },
  C990: { nome: 'Encerramento do Bloco C', campos: [C('REG', 4, 'O', /^C990$/), N('QTD_LIN_C', undefined, undefined, 'O')] },
  '9999': { nome: 'Encerramento do arquivo digital', campos: [C('REG', 4, 'O', /^9999$/), N('QTD_LIN', undefined, undefined, 'O')] },
};

/** Códigos de situação de documento que dispensam C170/C190 filhos. */
const COD_SIT_SEM_FILHOS = new Set(['02', '03', '04', '05']);

export type LinhaEfd = { numero: number; reg: string; campos: string[]; texto: string };

/** Divide uma linha `|a|b|c|` em registro + campos. Lança em linha malformada. */
export function parseLinhaEfd(texto: string, numero: number): LinhaEfd {
  const bruto = texto.replace(/\r$/, '');
  if (!bruto.startsWith('|') || !bruto.endsWith('|')) {
    throw new HttpError(422, `Linha ${numero}: registro EFD deve começar e terminar com "|".`);
  }
  const campos = bruto.slice(1, -1).split('|');
  return { numero, reg: campos[0] ?? '', campos, texto: bruto };
}

export type ProblemaEfd = { nivel: 'erro' | 'aviso'; linha?: number; registro?: string; campo?: string; codigo: string; mensagem: string };

export type ResultadoValidacaoEfd = {
  sistema: SistemaFiscal;
  codigo_versao: string;
  total_linhas: number;
  registros: Record<string, number>;
  erros: ProblemaEfd[];
  avisos: ProblemaEfd[];
  valido: boolean;
};

function numeroDeCampo(v: string): number | null {
  if (v === '') return null;
  // EFD usa vírgula como separador decimal no arquivo.
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * VALIDAÇÃO ESTRUTURAL de um arquivo EFD ICMS/IPI já montado (array de linhas).
 * Puro — não toca banco. Confere:
 *   • gramática (registro conhecido, quantidade de campos, tipo, obrigatórios);
 *   • formatos (datas, CNPJ/CPF, chave 44, CFOP, NCM, UF, enums);
 *   • controle de blocos (0001/0990, C001/C990) e QTD_LIN_0/C/9999;
 *   • filhos obrigatórios (C100 → ≥1 C170 e ≥1 C190, salvo situação de exceção);
 *   • integridade referencial (C170.COD_ITEM∈0200, C170.UNID∈0190, C100.COD_PART∈0150);
 *   • totais (Σ C170.VL_ITEM × C100.VL_MERC);
 *   • documento duplicado (mesma chave/série/número);
 *   • período coerente (DT_INI e DT_FIN no mesmo mês).
 */
export function validarEfd(sistema: SistemaFiscal, codigoVersao: string, linhas: string[]): ResultadoValidacaoEfd {
  const gramatica = sistema === 'EFD_ICMS_IPI' ? GRAMATICA_EFD_ICMS_IPI : null;
  const erros: ProblemaEfd[] = [];
  const avisos: ProblemaEfd[] = [];
  const registros: Record<string, number> = {};
  const push = (p: ProblemaEfd) => (p.nivel === 'erro' ? erros : avisos).push(p);

  if (!gramatica) {
    return {
      sistema, codigo_versao: codigoVersao, total_linhas: linhas.length, registros, valido: false,
      erros: [{ nivel: 'erro', codigo: 'SISTEMA_SEM_GRAMATICA', mensagem: `Validador estrutural ainda não cobre ${sistema}; sem gramática publicada no código.` }],
      avisos: [],
    };
  }

  const parsed: LinhaEfd[] = [];
  for (let i = 0; i < linhas.length; i++) {
    try {
      parsed.push(parseLinhaEfd(linhas[i], i + 1));
    } catch (e) {
      push({ nivel: 'erro', linha: i + 1, codigo: 'LINHA_MALFORMADA', mensagem: e instanceof Error ? e.message : String(e) });
    }
  }
  if (parsed.length === 0) {
    return { sistema, codigo_versao: codigoVersao, total_linhas: linhas.length, registros, valido: false, erros: [{ nivel: 'erro', codigo: 'ARQUIVO_VAZIO', mensagem: 'Arquivo sem registros.' }], avisos };
  }

  // ---- gramática por registro --------------------------------------------
  const codigos0200 = new Set<string>();
  const codigos0190 = new Set<string>();
  const codigos0150 = new Set<string>();
  const documentosVistos = new Set<string>();

  for (const linha of parsed) {
    registros[linha.reg] = (registros[linha.reg] ?? 0) + 1;
    const layout = gramatica[linha.reg];
    if (!layout) {
      push({ nivel: 'erro', linha: linha.numero, registro: linha.reg, codigo: 'REGISTRO_DESCONHECIDO', mensagem: `Registro "${linha.reg}" não existe no leiaute EFD ICMS/IPI.` });
      continue;
    }
    if (linha.campos.length !== layout.campos.length) {
      push({ nivel: 'erro', linha: linha.numero, registro: linha.reg, codigo: 'QTD_CAMPOS', mensagem: `Registro ${linha.reg} espera ${layout.campos.length} campos, veio ${linha.campos.length}.` });
      continue;
    }
    for (let k = 0; k < layout.campos.length; k++) {
      const spec = layout.campos[k];
      const valor = linha.campos[k] ?? '';
      if (spec.obrig === 'O' && valor === '') {
        push({ nivel: 'erro', linha: linha.numero, registro: linha.reg, campo: spec.nome, codigo: 'CAMPO_OBRIGATORIO', mensagem: `Campo obrigatório ${spec.nome} vazio em ${linha.reg}.` });
        continue;
      }
      if (valor === '') continue;
      if (spec.tipo === 'N' && numeroDeCampo(valor) === null) {
        push({ nivel: 'erro', linha: linha.numero, registro: linha.reg, campo: spec.nome, codigo: 'CAMPO_NAO_NUMERICO', mensagem: `Campo ${spec.nome} deveria ser numérico: "${valor}".` });
      }
      if (spec.tam !== undefined && valor.length > spec.tam) {
        push({ nivel: 'erro', linha: linha.numero, registro: linha.reg, campo: spec.nome, codigo: 'CAMPO_LONGO', mensagem: `Campo ${spec.nome} excede ${spec.tam} caracteres.` });
      }
      if (spec.regex && !spec.regex.test(valor)) {
        push({ nivel: 'erro', linha: linha.numero, registro: linha.reg, campo: spec.nome, codigo: 'CAMPO_FORMATO', mensagem: `Campo ${spec.nome} em formato inválido: "${valor}".` });
      }
    }
    if (linha.reg === '0200') codigos0200.add(linha.campos[1]);
    if (linha.reg === '0190') codigos0190.add(linha.campos[1]);
    if (linha.reg === '0150') codigos0150.add(linha.campos[1]);
  }

  // ---- período (0000) -----------------------------------------------------
  const reg0000 = parsed.find((l) => l.reg === '0000');
  if (!reg0000) {
    push({ nivel: 'erro', codigo: 'SEM_0000', mensagem: 'O primeiro registro deve ser o 0000.' });
  } else {
    if (parsed[0]?.reg !== '0000') push({ nivel: 'erro', linha: parsed[0]?.numero, codigo: 'PRIMEIRO_REGISTRO', mensagem: 'O registro 0000 deve ser o primeiro do arquivo.' });
    const dtIni = reg0000.campos[3] ?? '';
    const dtFin = reg0000.campos[4] ?? '';
    if (RE_DATA.test(dtIni) && RE_DATA.test(dtFin)) {
      if (dtIni.slice(2) !== dtFin.slice(2)) {
        push({ nivel: 'erro', linha: reg0000.numero, registro: '0000', campo: 'DT_FIN', codigo: 'PERIODO_INCOERENTE', mensagem: 'DT_INI e DT_FIN devem pertencer ao mesmo mês/ano.' });
      }
      if (reg0000.campos[1] !== codigoVersao) {
        push({ nivel: 'aviso', linha: reg0000.numero, registro: '0000', campo: 'COD_VER', codigo: 'VERSAO_DIVERGENTE', mensagem: `COD_VER do arquivo (${reg0000.campos[1]}) difere da versão validada (${codigoVersao}).` });
      }
    }
  }
  if (parsed[parsed.length - 1]?.reg !== '9999') {
    push({ nivel: 'erro', linha: parsed[parsed.length - 1]?.numero, codigo: 'ULTIMO_REGISTRO', mensagem: 'O último registro deve ser o 9999.' });
  }

  // ---- controle de blocos e QTD_LIN --------------------------------------
  const contarIntervalo = (abre: string, fecha: string): { total: number; erro: string | null } => {
    const i = parsed.findIndex((l) => l.reg === abre);
    const j = parsed.findIndex((l) => l.reg === fecha);
    if (i < 0 || j < 0) return { total: 0, erro: `Bloco sem ${abre}/${fecha}.` };
    if (j < i) return { total: 0, erro: `${fecha} antes de ${abre}.` };
    return { total: j - i + 1, erro: null };
  };
  const bloco0 = contarIntervalo('0001', '0990');
  const blocoC = contarIntervalo('C001', 'C990');
  for (const [fecha, calc] of [['0990', bloco0], ['C990', blocoC]] as const) {
    const linha = parsed.find((l) => l.reg === fecha);
    if (!linha) continue;
    if (calc.erro) { push({ nivel: 'erro', registro: fecha, codigo: 'BLOCO_INCOERENTE', mensagem: calc.erro }); continue; }
    const declarado = numeroDeCampo(linha.campos[1] ?? '');
    if (declarado !== null && declarado !== calc.total) {
      push({ nivel: 'erro', linha: linha.numero, registro: fecha, campo: fecha === '0990' ? 'QTD_LIN_0' : 'QTD_LIN_C', codigo: 'QTD_LIN_DIVERGENTE', mensagem: `${fecha} declara ${declarado} linhas, contadas ${calc.total}.` });
    }
  }
  const reg9999 = parsed.find((l) => l.reg === '9999');
  if (reg9999) {
    const declarado = numeroDeCampo(reg9999.campos[1] ?? '');
    if (declarado !== null && declarado !== parsed.length) {
      push({ nivel: 'erro', linha: reg9999.numero, registro: '9999', campo: 'QTD_LIN', codigo: 'QTD_LIN_DIVERGENTE', mensagem: `9999 declara ${declarado} linhas, contadas ${parsed.length}.` });
    }
  }

  // ---- C100 → filhos + integridade referencial + totais ------------------
  let docAtual: LinhaEfd | null = null;
  let itensDoc = 0;
  let c190Doc = 0;
  let somaItens = 0;
  const fecharDocumento = () => {
    if (!docAtual) return;
    const sit = docAtual.campos[5] ?? '';
    if (!COD_SIT_SEM_FILHOS.has(sit)) {
      if (itensDoc === 0) push({ nivel: 'erro', linha: docAtual.numero, registro: 'C100', codigo: 'C100_SEM_C170', mensagem: 'C100 exige ao menos um C170 (itens).' });
      if (c190Doc === 0) push({ nivel: 'erro', linha: docAtual.numero, registro: 'C100', codigo: 'C100_SEM_C190', mensagem: 'C100 exige ao menos um C190 (analítico).' });
      const vlMerc = numeroDeCampo(docAtual.campos[15] ?? '');
      if (vlMerc !== null && vlMerc > 0 && Math.abs(vlMerc - somaItens) > 0.01) {
        push({ nivel: 'erro', linha: docAtual.numero, registro: 'C100', campo: 'VL_MERC', codigo: 'TOTAL_DIVERGENTE', mensagem: `Σ itens (${somaItens.toFixed(2)}) difere de VL_MERC (${vlMerc.toFixed(2)}).` });
      }
    }
    docAtual = null; itensDoc = 0; c190Doc = 0; somaItens = 0;
  };
  for (const linha of parsed) {
    if (linha.reg === 'C100') {
      fecharDocumento();
      docAtual = linha;
      const chave = `${linha.campos[4]}|${linha.campos[6]}|${linha.campos[7]}|${linha.campos[8]}`;
      if (documentosVistos.has(chave)) {
        push({ nivel: 'erro', linha: linha.numero, registro: 'C100', codigo: 'DOCUMENTO_DUPLICADO', mensagem: `Documento repetido (modelo/série/número/chave): ${chave}.` });
      }
      documentosVistos.add(chave);
      const codPart = linha.campos[3] ?? '';
      if (codPart !== '' && !codigos0150.has(codPart)) {
        push({ nivel: 'erro', linha: linha.numero, registro: 'C100', campo: 'COD_PART', codigo: 'PARTICIPANTE_INEXISTENTE', mensagem: `COD_PART "${codPart}" não consta em 0150.` });
      }
    } else if (linha.reg === 'C170' && docAtual) {
      itensDoc++;
      const vl = numeroDeCampo(linha.campos[6] ?? '');
      if (vl !== null) somaItens += vl;
      const codItem = linha.campos[2] ?? '';
      if (codItem !== '' && !codigos0200.has(codItem)) {
        push({ nivel: 'erro', linha: linha.numero, registro: 'C170', campo: 'COD_ITEM', codigo: 'ITEM_INEXISTENTE', mensagem: `COD_ITEM "${codItem}" não consta em 0200.` });
      }
      const unid = linha.campos[5] ?? '';
      if (unid !== '' && !codigos0190.has(unid)) {
        push({ nivel: 'erro', linha: linha.numero, registro: 'C170', campo: 'UNID', codigo: 'UNIDADE_INEXISTENTE', mensagem: `UNID "${unid}" não consta em 0190.` });
      }
    } else if (linha.reg === 'C190' && docAtual) {
      c190Doc++;
    }
  }
  fecharDocumento();

  return {
    sistema, codigo_versao: codigoVersao, total_linhas: parsed.length, registros,
    erros, avisos, valido: erros.length === 0,
  };
}

// ----------------------------------------------------------------------------
// REGISTRO VERSIONADO (tabela `fiscal_layouts`) — vigência por período.
// ----------------------------------------------------------------------------

/**
 * Semente CANÔNICA dos leiautes oficiais. É a MESMA lista gravada pela migração
 * 0115 (a migração é a autoridade no PostgreSQL; este array existe para que os
 * testes de memória e a coerência código×SQL usem a mesma fonte, sem duplicar
 * dado à mão). Fonte oficial em `fonte_url`.
 */
export const SEED_LAYOUTS_FISCAIS: Array<Omit<LayoutVigente, 'id'>> = [
  { sistema: 'EFD_ICMS_IPI', codigo_versao: '020', versao_leiaute: '020', ato_normativo: 'Nota Técnica 2025.001 v1.0 (Ato COTEPE/ICMS)', vigencia_inicio: '2025-01-01', vigencia_fim: null, fonte_url: 'http://sped.rfb.gov.br/pasta/show/1573', consultado_em: '2026-11-09', registros: ['0000', '0001', '0005', '0010', '0150', '0190', '0200', '0990', 'C001', 'C100', 'C170', 'C190', 'C990', '9999'] },
  { sistema: 'EFD_ICMS_IPI', codigo_versao: '019', versao_leiaute: '019', ato_normativo: 'Nota Técnica 2024.001 v1.0 (Ato COTEPE/ICMS)', vigencia_inicio: '2024-01-01', vigencia_fim: '2024-12-31', fonte_url: 'http://sped.rfb.gov.br/pasta/show/1573', consultado_em: '2026-11-09', registros: ['0000', '0001', '0005', '0010', '0150', '0190', '0200', '0990', 'C001', 'C100', 'C170', 'C190', 'C990', '9999'] },
  { sistema: 'EFD_ICMS_IPI', codigo_versao: '018', versao_leiaute: '018', ato_normativo: 'Nota Técnica 2023.001 v1.2 (Ato COTEPE/ICMS)', vigencia_inicio: '2023-01-01', vigencia_fim: '2023-12-31', fonte_url: 'http://sped.rfb.gov.br/pasta/show/1573', consultado_em: '2026-11-09', registros: ['0000', '0001', '0005', '0010', '0150', '0190', '0200', '0990', 'C001', 'C100', 'C170', 'C190', 'C990', '9999'] },
  { sistema: 'EFD_CONTRIBUICOES', codigo_versao: '006', versao_leiaute: '3.2.0', ato_normativo: 'ADE Cofis (Guia Prático v1.35, Tabela 3.1.1)', vigencia_inicio: '2020-01-01', vigencia_fim: null, fonte_url: 'http://sped.rfb.gov.br/item/show/1989', consultado_em: '2026-11-09', registros: ['0000', '0001', '0100', '0110', '0140', '0150', '0190', '0200', '0990', 'A001', 'A100', 'A170', 'A990', 'C001', 'C100', 'C170', 'C990', 'D001', 'D100', 'D990', 'F001', 'F100', 'F990', 'M001', 'M200', 'M990', '9900', '9999'] },
  { sistema: 'EFD_CONTRIBUICOES', codigo_versao: '005', versao_leiaute: '3.1.0', ato_normativo: 'ADE Cofis nº 82/2018 (Guia Prático v1.35, Tabela 3.1.1)', vigencia_inicio: '2019-01-01', vigencia_fim: '2019-12-31', fonte_url: 'http://sped.rfb.gov.br/item/show/1989', consultado_em: '2026-11-09', registros: ['0000', '0001', '0100', '0110', '0140', '0150', '0190', '0200', '0990', 'A001', 'A100', 'A170', 'A990', 'C001', 'C100', 'C170', 'C990', 'D001', 'D100', 'D990', 'F001', 'F100', 'F990', 'M001', 'M200', 'M990', '9900', '9999'] },
  { sistema: 'EFD_CONTRIBUICOES', codigo_versao: '004', versao_leiaute: '3.0.0', ato_normativo: 'ADE Cofis nº 20/2012 (Guia Prático v1.35, Tabela 3.1.1)', vigencia_inicio: '2018-06-01', vigencia_fim: '2018-12-31', fonte_url: 'http://sped.rfb.gov.br/item/show/1989', consultado_em: '2026-11-09', registros: ['0000', '0001', '0100', '0110', '0140', '0150', '0190', '0200', '0990', 'A001', 'A100', 'A170', 'A990', 'C001', 'C100', 'C170', 'C990', 'D001', 'D100', 'D990', 'F001', 'F100', 'F990', 'M001', 'M200', 'M990', '9900', '9999'] },
];

export type LayoutVigente = {
  id: number; sistema: SistemaFiscal; codigo_versao: string; versao_leiaute: string;
  ato_normativo: string | null; vigencia_inicio: string; vigencia_fim: string | null;
  fonte_url: string; consultado_em: string; registros: string[];
};

/** Lista os leiautes cadastrados (opcionalmente de um sistema), para a tela. */
export async function listarLayoutsFiscais(sistema?: SistemaFiscal): Promise<LayoutVigente[]> {
  const r = getResource('fiscal_layouts');
  if (!r) return [];
  const { rows } = await getStore().list(r, { page: 1, pageSize: 200, sort: 'sistema', dir: 'asc', filter: sistema ? { sistema } : {} });
  return rows.map(mapearLayout);
}

function mapearLayout(row: Row): LayoutVigente {
  return {
    id: Number(row.id), sistema: row.sistema as SistemaFiscal, codigo_versao: String(row.codigo_versao),
    versao_leiaute: String(row.versao_leiaute), ato_normativo: row.ato_normativo == null ? null : String(row.ato_normativo),
    vigencia_inicio: String(row.vigencia_inicio), vigencia_fim: row.vigencia_fim == null ? null : String(row.vigencia_fim),
    fonte_url: String(row.fonte_url), consultado_em: String(row.consultado_em),
    registros: Array.isArray(row.registros) ? (row.registros as string[]) : [],
  };
}

/**
 * Resolve o leiaute VIGENTE para um sistema e um período de apuração (AAAA-MM).
 * Sem leiaute vigente cadastrado, LANÇA — nunca presume a versão "mais nova".
 */
export async function resolverLeiauteVigente(sistema: SistemaFiscal, periodo: string): Promise<LayoutVigente> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw new HttpError(400, 'Período inválido. Use AAAA-MM.');
  const layouts = (await listarLayoutsFiscais(sistema)).filter((l) => {
    const ref = `${periodo}-01`;
    return l.vigencia_inicio <= ref && (l.vigencia_fim === null || l.vigencia_fim >= ref);
  });
  if (layouts.length === 0) {
    throw new HttpError(422, `Nenhum leiaute de ${sistema} cadastrado vigente em ${periodo}. Cadastre a versão oficial antes de gerar qualquer arquivo.`);
  }
  // Se houver mais de um (sobreposição), escolhe o de vigência_inicio mais recente.
  layouts.sort((a, b) => (a.vigencia_inicio < b.vigencia_inicio ? 1 : -1));
  return layouts[0];
}
