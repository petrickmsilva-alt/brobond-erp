// ============================================================================
// ADMIN_PASSWORD — resolução e comparação (Fase 4.3, item 13).
//
// Módulo SEM dependências do restante do servidor, de propósito: `auth.ts` e
// `security.ts` se importam mutuamente; uma constante aqui evita o ciclo.
// ============================================================================
import { createHash, timingSafeEqual } from 'node:crypto';

/** Padrão de DESENVOLVIMENTO da senha do administrador. Nunca vale em produção. */
export const SENHA_ADMIN_DESENVOLVIMENTO = 'brobond123';

/**
 * Senha efetiva do administrador. Fora de produção, ausente usa o padrão de
 * desenvolvimento (testes locais). Em produção, ausente, curta (< 8) ou igual ao padrão
 * resolve para vazio: vazio não autentica em nenhum caminho.
 */
export function senhaAdministradorConfigurada(env: NodeJS.ProcessEnv = process.env): string {
  const valor = String(env.ADMIN_PASSWORD || '').trim();
  if (env.NODE_ENV === 'production') {
    return valor.length >= 8 && valor !== SENHA_ADMIN_DESENVOLVIMENTO ? valor : '';
  }
  return valor || SENHA_ADMIN_DESENVOLVIMENTO;
}

/** Comparação de senhas em tempo constante. Vazio nunca é igual a nada. */
export function senhasIguais(recebida: string, esperada: string): boolean {
  if (!esperada || !recebida) return false;
  const a = createHash('sha256').update(recebida).digest();
  const b = createHash('sha256').update(esperada).digest();
  return timingSafeEqual(a, b) && recebida.length === esperada.length;
}
