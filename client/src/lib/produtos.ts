// ============================================================================
// PRODUTOS — máscara, normalização e validação dos campos do cadastro.
//
// Cada regra aqui ESPELHA uma regra do servidor (resources.produtos +
// validate.ts): o formulário avisa ANTES de enviar, e o servidor continua sendo
// a autoridade. Nenhuma regra de domínio nasce só no front.
//
// Campo por campo (o que é formato conhecido tem formato conhecido):
//   • SKU / Referência ....... texto curto; preserva LETRAS, números e
//                              separadores; só remove espaço acidental (das
//                              pontas e duplicado). A CAIXA é preservada — o
//                              SKU é a chave do domínio e o servidor o compara
//                              literalmente;
//   • Código de barras (EAN) . só dígitos; 8, 12, 13 ou 14 (aceita GTIN-12/14,
//                              como o servidor e as etiquetas);
//   • NCM .................... 8 dígitos, exibido pontuado (6205.20.00);
//   • CEST ................... 7 dígitos, exibido pontuado (28.038.00);
//   • CFOP ................... exatamente 4 dígitos;
//   • GTIN tributário ........ 8, 12, 13 ou 14 dígitos (vazio é permitido);
//   • Preço/Custo ............ moeda BR (R$ 1.500,00) — máscara do format.ts;
//   • Percentuais ............ 0,00 % (máx. 2 decimais);
//   • Quantidades ............ inteiro >= 0;
//   • Peso/Dimensões ......... inteiro >= 0 (mm e g);
//   • Tags ................... lista separada por vírgula, sem espaços nas pontas.
//
// Não há máscara onde ela não faz sentido: nome, descrição, composição e
// observações são texto livre (com limite de caracteres, como no servidor).
// ============================================================================
import { maskMoneyInput, soDigitos } from './format';
import { erroGtin } from './barcode';

export const SKU_MAX = 40;
export const NOME_MAX = 120;
export const CODIGO_BARRAS_MAX = 14;

/** Formatos de código de barras aceitos (o servidor usa a MESMA lista). */
export const CODIGO_BARRAS_PATTERN = /^(\d{8}|\d{12,14})$/;
/** GTIN tributário aceita a mesma família do código de barras. */
export const GTIN_TRIBUTARIO_PATTERN = /^(\d{8}|\d{12,14})$/;

/** SKU: preserva a caixa e os separadores; remove só espaço acidental. */
export function normalizarSku(valor: unknown): string {
  return String(valor ?? '').trim().replace(/\s+/g, ' ');
}

/** Código de barras: só dígitos (a etiqueta imprime sem separador). */
export function normalizarCodigoBarras(valor: unknown): string {
  return soDigitos(valor).slice(0, CODIGO_BARRAS_MAX);
}

/** NCM pontuado: 8 dígitos → "6205.20.00" (o cadastro guarda com pontos). */
export function normalizarNcm(valor: unknown): string {
  const d = soDigitos(valor).slice(0, 8);
  if (d.length !== 8) return d;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
}

/** CEST pontuado: 7 dígitos → "28.038.00". */
export function normalizarCest(valor: unknown): string {
  const d = soDigitos(valor).slice(0, 7);
  if (d.length !== 7) return d;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
}

/** CFOP: só dígitos, 4 posições. */
export function normalizarCfop(valor: unknown): string {
  return soDigitos(valor).slice(0, 4);
}

/** Tags: separadas por vírgula, sem espaços nas pontas e sem vazios. */
export function normalizarTags(valor: unknown): string {
  return String(valor ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(', ');
}

// ----------------------------------------------------------------------------
// Validação (devolve a mensagem de erro ou null quando o valor é aceitável)
// ----------------------------------------------------------------------------

export function erroSku(valor: unknown): string | null {
  const s = normalizarSku(valor);
  if (!s) return 'Informe o SKU / referência.';
  if (s.length > SKU_MAX) return `Máximo de ${SKU_MAX} caracteres.`;
  return null;
}

export function erroNome(valor: unknown): string | null {
  const s = String(valor ?? '').trim();
  if (!s) return 'Informe o nome do produto.';
  if (s.length > NOME_MAX) return `Máximo de ${NOME_MAX} caracteres.`;
  return null;
}

export function erroCodigoBarras(valor: unknown): string | null {
  // P0: além da forma (8/12/13/14 dígitos), o DÍGITO VERIFICADOR GS1 é
  // conferido (erroGtin, de barcode.ts — o mesmo algoritmo que desenha a
  // etiqueta; o servidor repete a conferência em ean.ts e é a autoridade).
  // SKU interno não passa por aqui: é texto livre e imprime em Code 128.
  return erroGtin(normalizarCodigoBarras(valor));
}

export function erroNcm(valor: unknown): string | null {
  const d = soDigitos(valor);
  if (!d) return null;
  if (d.length !== 8) return 'NCM deve ter 8 dígitos (ex.: 6205.20.00).';
  return null;
}

export function erroCest(valor: unknown): string | null {
  const d = soDigitos(valor);
  if (!d) return null;
  if (d.length !== 7) return 'CEST deve ter 7 dígitos (ex.: 28.038.00).';
  return null;
}

export function erroCfop(valor: unknown): string | null {
  const s = normalizarCfop(valor);
  if (!s) return null;
  if (s.length !== 4) return 'CFOP tem 4 dígitos (ex.: 5102).';
  return null;
}

export function erroGtinTributario(valor: unknown): string | null {
  return erroGtin(normalizarCodigoBarras(valor));
}

/** Estoque máximo não pode ficar abaixo do mínimo (mesma CHECK do banco). */
export function erroEstoqueMax(minimo: unknown, maximo: unknown): string | null {
  const max = String(maximo ?? '').trim();
  if (!max) return null;
  const min = String(minimo ?? '').trim();
  if (min && Number(max) < Number(min)) return 'Deve ser maior ou igual ao estoque mínimo.';
  return null;
}

/**
 * Máscara de moeda para os campos de valor (custo e preços): aceita "1.500,5"
 * enquanto digita e normaliza para o padrão BR com até 2 decimais.
 */
export function mascararMoeda(valor: string): string {
  return maskMoneyInput(valor);
}

/**
 * Normaliza o payload do produto antes de enviar: os formatos conhecidos saem
 * canônicos (barcode/GTIN só dígitos, NCM/CEST/CFOP pontuados como o domínio
 * guarda, tags organizadas). O SKU mantém a caixa — é chave do domínio e o
 * servidor o compara literalmente. O servidor revalida tudo — isto evita ida e
 * volta por causa de separador digitado.
 */
export function normalizarPayloadProduto(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  if ('sku' in out) out.sku = normalizarSku(out.sku);
  if ('codigo_barras' in out) out.codigo_barras = normalizarCodigoBarras(out.codigo_barras) || null;
  if ('gtin_tributario' in out) out.gtin_tributario = normalizarCodigoBarras(out.gtin_tributario) || null;
  if ('ncm' in out) out.ncm = normalizarNcm(out.ncm) || null;
  if ('cest' in out) out.cest = normalizarCest(out.cest) || null;
  if ('cfop_saida' in out) out.cfop_saida = normalizarCfop(out.cfop_saida) || null;
  if ('tags' in out) out.tags = normalizarTags(out.tags) || null;
  if ('codigo_fornecedor' in out) out.codigo_fornecedor = String(out.codigo_fornecedor ?? '').trim() || null;
  return out;
}
