// ============================================================================
// Máscaras do checkout — SOMENTE apresentação. O backend revalida tudo e
// persiste a forma canônica (dígitos). O navegador nunca é a autoridade.
// ============================================================================

export const soDigitos = (valor: string): string => String(valor ?? '').replace(/\D/g, '');

/** (62) 99999-9999 / (62) 9999-9999. Aceita colar "+55 62 …" (remove o 55). */
export function mascararTelefoneBR(valor: string): string {
  let d = soDigitos(valor);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  if (d.length <= 6) return `(${ddd}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${ddd}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${ddd}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** Telefone BR completo: DDD + 8 ou 9 dígitos. */
export function telefoneBRCompleto(valor: string): boolean {
  const d = soDigitos(valor);
  return d.length === 10 || d.length === 11;
}

/** 000.000.000-00 */
export function mascararCPF(valor: string): string {
  const d = soDigitos(valor).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** Dígitos verificadores do CPF (mesma regra do backend). */
export function cpfValido(valor: string): boolean {
  const d = soDigitos(valor);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10]);
}

/** 74000-000 (8 dígitos persistidos). */
export function mascararCEP(valor: string): string {
  const d = soDigitos(valor).slice(0, 8);
  return d.length <= 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`;
}

/** UF: duas letras maiúsculas. */
export function normalizarUF(valor: string): string {
  return String(valor ?? '').replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase();
}

/** Nome: sem espaços nas pontas e sem espaços repetidos. */
export function normalizarNome(valor: string): string {
  return String(valor ?? '').replace(/\s+/g, ' ').trim();
}

/** E-mail: sem espaços e em minúsculas (o backend revalida o formato). */
export function normalizarEmail(valor: string): string {
  return String(valor ?? '').trim().toLowerCase();
}
