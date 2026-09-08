// Utilitários compartilhados (evita duplicação entre módulos).
// Antes de usar Math.round direto em itens.ts, producao.ts, services.ts e memdb.ts,
// importe daqui para manter consistência.

/** Arredonda para 2 casas decimais (valores monetários). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Soma valores monetários em centavos inteiros e devolve reais já arredondados.
 * Somar `number` direto acumulando centavos fracionários (0.1 + 0.2) é como o
 * total "andava" um centavo numa agregação longa; aqui a soma é exata.
 */
export function somaMoeda(vals: number[]): number {
  let centavos = 0;
  for (const v of vals) centavos += Math.round((Number(v) || 0) * 100);
  return centavos / 100;
}

/** Arredonda para 3 casas decimais (quantidades de insumo). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Formata valor monetário em pt-BR. */
export function formatMoney(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Formata número em pt-BR. */
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Gera token aleatório seguro (hex). */
export function generateToken(bytes = 24): string {
  const { randomBytes } = require('node:crypto');
  return randomBytes(bytes).toString('hex');
}

/** Verifica se um valor é "vazio" (null, undefined, string em branco). */
export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Converte "1.234,56" / "1234.56" / 1234.56 em número. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/\s|R\$|%/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Sleep simples (para retries, delays). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Trunca string com sufixo. */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
