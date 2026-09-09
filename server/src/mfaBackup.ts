// ============================================================
// Códigos de recuperação do MFA — o "plano B" do segundo fator.
//
//   • 10 códigos de uso único (formato XXXX-XXXX, sem caracteres
//     ambíguos), exibidos UMA única vez na ativação ou regeneração.
//   • O banco guarda apenas hashes SHA-256 + carimbo de uso (JSON na
//     coluna usuarios.mfa_backup_hashes) — nunca o código em claro.
//   • Cada código vale UM login; o uso é auditado com o saldo restante.
//   • Regenerar invalida o lote anterior; desativar/resetar o MFA limpa tudo.
// ============================================================
import { createHash, randomBytes } from 'node:crypto';

export const MFA_BACKUP_QTD = 10;

// Sem 0/O, 1/I/L para digitação sem erro.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type CodigoBackupRegistro = { hash: string; usado_em: string | null };

/** Normaliza a digitação (caixa alta, ignora traço/espaços). */
export function normalizarCodigo(codigo: unknown): string {
  return String(codigo || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Hash SHA-256 do código normalizado (entropia de 40 bits — suficiente). */
export function hashCodigo(codigo: string): string {
  return createHash('sha256').update(normalizarCodigo(codigo)).digest('hex');
}

/** Gera um código no formato XXXX-XXXX. */
export function gerarCodigoBackup(): string {
  const buf = randomBytes(8);
  let s = '';
  for (const b of buf) s += ALFABETO[b % ALFABETO.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Gera um lote inédito: os códigos (exibição única) + o registro p/ o banco. */
export function gerarLoteCodigos(qtd = MFA_BACKUP_QTD): { codigos: string[]; registro: CodigoBackupRegistro[] } {
  const unicos = new Set<string>();
  while (unicos.size < qtd) unicos.add(gerarCodigoBackup());
  const codigos = [...unicos];
  return { codigos, registro: codigos.map((c) => ({ hash: hashCodigo(c), usado_em: null })) };
}

/** Lê o JSON da coluna (tolerante a nulo/corrompido). */
export function lerRegistro(valor: unknown): CodigoBackupRegistro[] {
  if (!valor) return [];
  try {
    const arr = typeof valor === 'string' ? JSON.parse(valor) : valor;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.hash === 'string')
      .map((e) => ({ hash: e.hash, usado_em: typeof e.usado_em === 'string' ? e.usado_em : null }));
  } catch {
    return [];
  }
}

export function serializarRegistro(reg: CodigoBackupRegistro[]): string {
  return JSON.stringify(reg);
}

export function restantesRegistro(reg: CodigoBackupRegistro[]): number {
  return reg.filter((e) => !e.usado_em).length;
}

/**
 * Tenta consumir um código: devolve o registro atualizado + saldo, ou null
 * quando o código é inválido ou já foi usado.
 */
export function consumirCodigo(
  reg: CodigoBackupRegistro[],
  codigo: string
): { registro: CodigoBackupRegistro[]; restantes: number } | null {
  const h = hashCodigo(codigo);
  const alvo = reg.find((e) => e.hash === h && !e.usado_em);
  if (!alvo) return null;
  alvo.usado_em = new Date().toISOString();
  return { registro: reg, restantes: restantesRegistro(reg) };
}
