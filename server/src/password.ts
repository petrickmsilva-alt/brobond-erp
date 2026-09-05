// ============================================================
// Hash de senhas — Argon2id (padrão OWASP) com migração gradual do bcrypt.
//
//   • hashPassword(): sempre gera Argon2id ($argon2id$...).
//   • verifyPassword(): aceita Argon2id E hashes bcrypt antigos ($2a/$2b/$2y),
//     permitindo a troca gradual — cada login bem-sucedido com bcrypt
//     regrava o hash em Argon2id (transparente para o usuário).
//   • Senhas NUNCA são reversíveis: não existe cofre, cifra ou exibição.
// ============================================================
import bcrypt from 'bcryptjs';
import { hash, verify } from '@node-rs/argon2';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? Math.floor(n) : min));
}

// Parâmetros OWASP para Argon2id: m=19 MiB (19456 KiB), t=2, p=1.
export const ARGON2_MEMORY_KIB = clamp(Number(process.env.ARGON2_MEMORY_KIB) || 19456, 8192, 1_048_576);
export const ARGON2_TIME_COST = clamp(Number(process.env.ARGON2_TIME_COST) || 2, 1, 10);
export const ARGON2_PARALLELISM = clamp(Number(process.env.ARGON2_PARALLELISM) || 1, 1, 8);

const ARGON2_OPTS = { memoryCost: ARGON2_MEMORY_KIB, timeCost: ARGON2_TIME_COST, parallelism: ARGON2_PARALLELISM };

function isArgon2id(h: string): boolean {
  return h.startsWith('$argon2id$');
}
function isBcrypt(h: string): boolean {
  return h.startsWith('$2a$') || h.startsWith('$2b$') || h.startsWith('$2y$');
}

/** Hash seguro da senha (Argon2id). Nunca guarda nem devolve o texto puro. */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTS);
}

export type PasswordVerify = { ok: boolean; /** true quando o hash é válido mas deve ser regravado em Argon2id */ rehash: boolean };

export async function verifyPasswordDetailed(plain: string, stored: string | null | undefined): Promise<PasswordVerify> {
  if (!stored) return { ok: false, rehash: false };
  if (isArgon2id(stored)) {
    try {
      return { ok: await verify(stored, plain), rehash: false };
    } catch {
      return { ok: false, rehash: false };
    }
  }
  // Migração gradual: bcrypt continua válido no login, mas marcado para rehash.
  if (isBcrypt(stored)) {
    try {
      return { ok: await bcrypt.compare(plain, stored), rehash: true };
    } catch {
      return { ok: false, rehash: false };
    }
  }
  return { ok: false, rehash: false };
}

/** Verificação simples (compatibilidade com o restante do código). */
export async function verifyPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
  return (await verifyPasswordDetailed(plain, stored)).ok;
}

/** O hash atual já atende à política Argon2id vigente? */
export function hashAtualizado(stored: string | null | undefined): boolean {
  if (!stored || !isArgon2id(stored)) return false;
  const m = /m=(\d+),t=(\d+),p=(\d+)/.exec(stored);
  if (!m) return false;
  return Number(m[1]) >= ARGON2_MEMORY_KIB && Number(m[2]) >= ARGON2_TIME_COST && Number(m[3]) >= ARGON2_PARALLELISM;
}
