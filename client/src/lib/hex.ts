// ============================================================================
// CÓDIGO HEXADECIMAL (#RRGGBB) — normalização e validação
//
// Espelha EXATAMENTE o contrato do servidor (server/src/validate.ts, `color`):
//   • trim + MAIÚSCULAS;
//   • `#` inicial é opcional na digitação;
//   • a forma curta `#RGB` é expandida para `#RRGGBB`;
//   • vazio é permitido (o HEX é OPCIONAL no cadastro de Cores e o banco não
//     tem NOT NULL);
//   • qualquer outra coisa é inválida e NÃO deve ser enviada à API.
//
// O mesmo normalizador alimenta a amostra (preview em tempo real), a listagem
// e o payload — nunca há duas regras de HEX no front.
// ============================================================================

/** Forma canônica aceita pela API e pelo banco. */
export const HEX_CANONICO = /^#[0-9A-F]{6}$/;

/**
 * Devolve o valor em forma canônica quando ele é válido (inclusive a forma
 * curta `#ABC` → `#AABBCC`) e o valor apenas "limpo" (trim + MAIÚSCULAS)
 * quando não é — assim a UI mostra o que a pessoa digitou, sem inventar cor.
 * Vazio continua vazio.
 */
export function normalizarHex(valor: unknown): string {
  let s = String(valor ?? '').trim().toUpperCase();
  if (!s) return '';
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9A-F]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return s;
}

/** O valor (já na forma canônica) é um HEX válido? Vazio NÃO é erro. */
export function hexValido(valor: unknown): boolean {
  const s = normalizarHex(valor);
  return s === '' || HEX_CANONICO.test(s);
}

/**
 * Mensagem de erro do campo HEX — `null` quando está válido (ou vazio).
 * Texto em linguagem de usuário, igual ao da API.
 */
export function erroHex(valor: unknown): string | null {
  return hexValido(valor) ? null : 'Informe o HEX no formato #RRGGBB (ex.: #172038).';
}

/**
 * Valor pronto para uso em CSS (`background-color`): só a forma canônica.
 * Qualquer outra entrada vira `null` — nada de string arbitrária no estilo.
 */
export function corSegura(valor: unknown): string | null {
  const s = normalizarHex(valor);
  return HEX_CANONICO.test(s) ? s : null;
}
