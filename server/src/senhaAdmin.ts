// ============================================================================
// ADMIN_PASSWORD — resolução e comparação (Fase 4.3, item 13).
//
// Módulo SEM dependências do restante do servidor, de propósito: `auth.ts` e
// `security.ts` se importam mutuamente; uma constante aqui evita o ciclo.
// ============================================================================
import { createHash, timingSafeEqual } from 'node:crypto';

/** Sem fallback: ausência de configuração nunca autentica nem provisiona o administrador. */
export function senhaAdministradorConfigurada(env: NodeJS.ProcessEnv = process.env): string {
  const valor = String(env.ADMIN_PASSWORD || '').trim();
  // O valor legado permanece rejeitado em produção pela guarda de boot.
  if (env.NODE_ENV === 'production' && (valor.length < 8 || valor === 'brobond123')) return '';
  return valor;
}

/** Comparação de senhas em tempo constante. Vazio nunca é igual a nada. */
export function senhasIguais(recebida: string, esperada: string): boolean {
  if (!esperada || !recebida) return false;
  const a = createHash('sha256').update(recebida).digest();
  const b = createHash('sha256').update(esperada).digest();
  return timingSafeEqual(a, b) && recebida.length === esperada.length;
}
