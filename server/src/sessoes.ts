// ============================================================
// Sessões de login — invalidação por dispositivo.
//
//   • Cada login cria um registro em `sessoes` com um id aleatório (JTI).
//   • O JWT carrega `sid`; o requireAuth confere se a sessão segue válida.
//   • Revogar uma sessão (ou todas) derruba o token na hora — sem esperar o
//     TTL do JWT. Troca de senha / reset / MFA desativado revogam sessões.
// ============================================================
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { getStore } from './services';
import type { Sessao } from './store';

/** TTL padrão da sessão: 8 h (ou 30 dias com "Lembrar-me"). */
export const SESSAO_TTL_MS = 8 * 3600_000;
export const SESSAO_TTL_LEMBRAR_MS = 30 * 24 * 3600_000;

export function ttlSessao(lembrar: boolean): number {
  return lembrar ? SESSAO_TTL_LEMBRAR_MS : SESSAO_TTL_MS;
}

/** Cria a sessão (linhas em `sessoes`) e devolve o id para embutir no JWT. */
export async function abrirSessao(opts: { usuarioId: number; lembrar: boolean; req: Request }): Promise<string> {
  const store = getStore();
  const id = randomBytes(24).toString('hex');
  const expira_em = new Date(Date.now() + ttlSessao(opts.lembrar)).toISOString();
  await store.criarSessao({
    id,
    usuario_id: opts.usuarioId,
    expira_em,
    ip: clientIpRaw(opts.req),
    user_agent: String(opts.req.headers?.['user-agent'] || '').slice(0, 250) || null,
  });
  return id;
}

function clientIpRaw(req: Request): string | null {
  const fwd = (req.headers?.['x-forwarded-for'] as string) || '';
  return (fwd.split(',')[0] || req.socket?.remoteAddress || '').trim() || null;
}

export function sessaoValida(s: Sessao | null | undefined): boolean {
  if (!s) return false;
  if (s.revogada_em) return false;
  return new Date(s.expira_em).getTime() > Date.now();
}

/** Revoga todas as sessões ativas do usuário, preservando a atual se pedido. */
export async function revogarTodas(usuarioId: number, exceto?: string): Promise<number> {
  return getStore().revogarSessoes(usuarioId, exceto);
}

/** Sessões ativas do usuário (mais recentes primeiro). */
export async function listSessoesAtivas(usuarioId: number) {
  return getStore().listSessoesAtivas(usuarioId);
}

export async function revogarUma(sid: string): Promise<boolean> {
  return getStore().revogarSessao(sid);
}

/** Limpeza periódica (chamada no boot e a cada 24 h). */
export async function limpezaPeriodica(): Promise<void> {
  const store = getStore();
  await store.limparSessoesEncerradas();
  await store.limparRateLimitsAntigos();
}
