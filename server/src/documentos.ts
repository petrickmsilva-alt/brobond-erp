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
  const texto = String(valor ?? '').trim();
  const d = apenasDigitos(valor);
  if (!d) {
    // Digitou algo sem nenhum dígito (letras, pontuação solta): não é vazio válido.
    return texto ? 'Documento inválido — informe apenas os números do CPF ou CNPJ.' : null;
  }

  if (aceita === 'cpf') return cpfValido(d) ? null : 'CPF inválido.';
  if (aceita === 'cnpj') return cnpjValido(d) ? null : 'CNPJ inválido.';

  const tipo = tipoDocumento(d);
  if (tipo === null) return 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)';
  if (tipo === 'cpf' && !cpfValido(d)) return 'CPF inválido.';
  if (tipo === 'cnpj' && !cnpjValido(d)) return 'CNPJ inválido.';
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

// ----------------------------------------------------------------------------
// TELEFONE — celular e fixo brasileiros, com tratamento profissional.
//
// Entrada aceita: "+55 (62) 99999-9999", "(62) 99999-9999", "62999999999",
// "55 62 99999-9999" — com ou sem pontuação. Guardamos SEM máscara, no formato
// canônico DDD+número (10–11 dígitos), que é o que a NF-e (fone do destinatário)
// e o link de WhatsApp precisam. A exibição "+55 (62) 99999-9999" é da UI.
//
// DDDs válidos do Brasil (67 códigos). Telefones internacionais (prefixo "+"
// e DDI diferente de 55) passam como dígitos com DDI — clientes estrangeiros
// também têm direito a telefone.
// ----------------------------------------------------------------------------

export const DDDS_BRASIL = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19', // SP
  '21', '22', '24', // RJ
  '27', '28', // ES
  '31', '32', '33', '34', '35', '37', '38', // MG
  '41', '42', '43', '44', '45', '46', // PR
  '47', '48', '49', // SC
  '51', '53', '54', '55', // RS
  '61', '62', '63', '64', '65', '66', '67', '68', '69', // DF/GO/TO/MT/MS/AC/RO
  '71', '73', '74', '75', '77', // BA
  '79', // SE
  '81', '87', // PE
  '82', // AL
  '83', // PB
  '84', // RN
  '85', '88', // CE
  '86', '89', // PI
  '91', '93', '94', // PA
  '92', '97', // AM
  '95', // RR
  '96', // AP
  '98', '99', // MA
]);

export const MSG_TELEFONE_INVALIDO = 'Telefone inválido. Use DDD + número (ex.: (62) 99999-9999).';

/** Telefone BR válido → dígitos DDD+número (10–11). Fora do padrão → null. */
export function telefoneBrasileiro(valor: unknown): string | null {
  const d = apenasDigitos(valor);
  // Com DDI 55 explícito (com ou sem "+"): 55 + DDD + número = 12–13 dígitos.
  const comDdi55 = d.length >= 12 && d.length <= 13 && d.startsWith('55');
  const local = comDdi55 ? d.slice(2) : d;
  if (local.length !== 10 && local.length !== 11) return null;
  if (!DDDS_BRASIL.has(local.slice(0, 2))) return null;
  const inicio = local[2];
  // Celular: 9 dígitos começando com 9. Fixo: 8 dígitos começando com 2–5.
  if (local.length === 11 && inicio !== '9') return null;
  if (local.length === 10 && !'2345'.includes(inicio)) return null;
  return local;
}

/**
 * Normalização canônica de telefone:
 *   • brasileiro   → DDD+número, 10–11 dígitos ("62999999999");
 *   • internacional→ dígitos com DDI, quando digitado com "+" e DDI ≠ 55.
 * Dígitos apenas — sem máscara, sem espaços.
 */
export function telefoneNormalizado(valor: unknown): string | null {
  const texto = String(valor ?? '').trim();
  const br = telefoneBrasileiro(texto);
  if (br) return br;
  const d = apenasDigitos(texto);
  const comDdi55 = d.length >= 12 && d.length <= 13 && d.startsWith('55');
  if (!comDdi55 && texto.startsWith('+') && d.length >= 8 && d.length <= 15) return d;
  return null;
}

/** Mensagem de erro do telefone (null quando válido ou vazio). */
export function erroTelefone(valor: unknown): string | null {
  const texto = String(valor ?? '').trim();
  if (!texto) return null; // vazio é tratado pela obrigatoriedade do campo
  return telefoneNormalizado(texto) === null ? MSG_TELEFONE_INVALIDO : null;
}

/**
 * Exibição brasileira: +55 (62) 99999-9999 / +55 (62) 3333-4444.
 * Valores internacionais e legados não reconhecidos saem como digitados.
 */
export function formatarTelefone(valor: unknown): string {
  const texto = String(valor ?? '').trim();
  if (!texto) return '';
  const br = telefoneBrasileiro(texto);
  if (br) {
    const ddd = br.slice(0, 2);
    const numero = br.slice(2);
    return numero.length === 9
      ? `+55 (${ddd}) ${numero.slice(0, 5)}-${numero.slice(5)}`
      : `+55 (${ddd}) ${numero.slice(0, 4)}-${numero.slice(4)}`;
  }
  const d = apenasDigitos(texto);
  if (texto.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return texto;
}
