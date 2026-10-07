// ============================================================================
// CPF / CNPJ — validação MATEMÁTICA (dígitos verificadores), não só formato.
//
// "Tem 11 dígitos" não é validar CPF: 111.111.111-11 tem 11 dígitos e é
// inválido. A SEFAZ rejeita a NF-e com destinatário de documento inválido, e
// descobrir isso na hora de faturar é caro. Validamos no cadastro.
//
// A normalização guarda apenas os dígitos: é assim que o documento viaja no
// XML da NF-e e é assim que buscas e índices de duplicidade funcionam.
// ============================================================================

/** Mantém apenas dígitos. */
export function apenasDigitos(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Dígito verificador por soma ponderada módulo 11 (regra comum a CPF e CNPJ). */
function digitoModulo11(digitos: number[], pesos: number[]): number {
  const soma = digitos.reduce((acc, d, i) => acc + d * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** CPF válido? (11 dígitos + 2 dígitos verificadores corretos) */
export function cpfValido(valor: unknown): boolean {
  const cpf = apenasDigitos(valor);
  if (cpf.length !== 11) return false;
  // Sequências repetidas passam no cálculo, mas não existem.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const d = cpf.split('').map(Number);
  const dv1 = digitoModulo11(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (dv1 !== d[9]) return false;
  const dv2 = digitoModulo11(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv2 === d[10];
}

/** CNPJ válido? (14 dígitos + 2 dígitos verificadores corretos) */
export function cnpjValido(valor: unknown): boolean {
  const cnpj = apenasDigitos(valor);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const d = cnpj.split('').map(Number);
  const dv1 = digitoModulo11(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (dv1 !== d[12]) return false;
  const dv2 = digitoModulo11(d.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv2 === d[13];
}

export type TipoDocumento = 'cpf' | 'cnpj' | null;

/** Identifica o documento pelo comprimento (quando válido). */
export function tipoDocumento(valor: unknown): TipoDocumento {
  const d = apenasDigitos(valor);
  if (d.length === 11) return 'cpf';
  if (d.length === 14) return 'cnpj';
  return null;
}

/** CPF ou CNPJ — aceita qualquer um dos dois. */
export function documentoValido(valor: unknown): boolean {
  const tipo = tipoDocumento(valor);
  if (tipo === 'cpf') return cpfValido(valor);
  if (tipo === 'cnpj') return cnpjValido(valor);
  return false;
}

/**
 * Valida e devolve a mensagem de erro (ou null).
 * `aceita` restringe o tipo quando o campo só admite um deles.
 */
export function erroDocumento(valor: unknown, aceita: 'cpf' | 'cnpj' | 'ambos' = 'ambos'): string | null {
  const d = apenasDigitos(valor);
  if (!d) return null; // vazio é tratado pela obrigatoriedade do campo

  if (aceita === 'cpf') return cpfValido(d) ? null : 'CPF inválido (confira os dígitos)';
  if (aceita === 'cnpj') return cnpjValido(d) ? null : 'CNPJ inválido (confira os dígitos)';

  const tipo = tipoDocumento(d);
  if (tipo === null) return 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)';
  if (tipo === 'cpf' && !cpfValido(d)) return 'CPF inválido (confira os dígitos)';
  if (tipo === 'cnpj' && !cnpjValido(d)) return 'CNPJ inválido (confira os dígitos)';
  return null;
}

/** Máscara de exibição: 000.000.000-00 / 00.000.000/0000-00. */
export function formatarDocumento(valor: unknown): string {
  const d = apenasDigitos(valor);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return String(valor ?? '');
}

/**
 * CEP normalizado (8 dígitos) ou null.
 * Usado pelo cadastro e pelo serviço de busca de endereço (cep.ts).
 */
export function cepNormalizado(valor: unknown): string | null {
  const d = apenasDigitos(valor);
  return d.length === 8 ? d : null;
}

/** UFs brasileiras — usadas na validação de endereço e nas regras fiscais. */
export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

export type UF = (typeof UFS)[number];

export function ufValida(valor: unknown): boolean {
  return (UFS as readonly string[]).includes(String(valor ?? '').trim().toUpperCase());
}
