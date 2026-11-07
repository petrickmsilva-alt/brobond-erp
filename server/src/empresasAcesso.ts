// ============================================================================
// MULTIEMPRESA — concessões de acesso (tabela `usuario_empresas`).
//
// Separado de empresa.ts de propósito: aquele módulo é PURO (não toca banco),
// o que o torna trivial de testar e impossível de tornar circular. Aqui mora a
// única parte que precisa de I/O — descobrir a quais empresas um usuário tem
// acesso — com um cache curto para não pagar uma consulta por requisição.
// ============================================================================
import { EMPRESA_PADRAO } from './empresa';
import { getResource } from './resources';
import { getStore } from './services';

export { EMPRESA_PADRAO };

/** Janela do cache. Curta de propósito: revogar acesso tem efeito em ~30 s. */
const CACHE_MS = 30_000;

const cache = new Map<number, { at: number; empresas: number[] }>();

/** Esvazia o cache (ou só o de um usuário) — usado ao conceder/revogar. */
export function invalidarCacheEmpresas(usuarioId?: number): void {
  if (usuarioId === undefined) cache.clear();
  else cache.delete(usuarioId);
}

/**
 * Empresas que o usuário pode acessar. A empresa padrão dele SEMPRE entra na
 * lista, mesmo que a concessão explícita tenha sumido — caso contrário um erro
 * de dados tiraria a pessoa do próprio ERP.
 */
export async function empresasDoUsuario(usuarioId: number, empresaPadrao: number = EMPRESA_PADRAO): Promise<number[]> {
  const padrao = Number(empresaPadrao) > 0 ? Number(empresaPadrao) : EMPRESA_PADRAO;
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) return [padrao];

  const hit = cache.get(usuarioId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.empresas;

  let empresas = [padrao];
  try {
    const r = getResource('usuario_empresas');
    if (r) {
      const { rows } = await getStore().list(r, { page: 1, pageSize: 500, filter: { usuario_id: usuarioId } });
      const ids = rows.map((row) => Number(row.empresa_id)).filter((n) => n > 0);
      empresas = [...new Set([padrao, ...ids])];
    }
  } catch {
    // Banco indisponível: o usuário continua restrito à própria empresa —
    // degradar para "vê tudo" seria exatamente o bug que esta camada evita.
    empresas = [padrao];
  }

  cache.set(usuarioId, { at: Date.now(), empresas });
  return empresas;
}

// ============================================================================
// A06-14 — CARTEIRA DO USUÁRIO (representante)
//
// O vínculo cadastral `representantes.usuario_id` NÃO era um papel de acesso: o
// representante enxergava a empresa inteira. Aqui o vínculo é resolvido para um
// ESCOPO DE CARTEIRA — o representante só lê a própria carteira. Perfis de
// gestão (admin/gerente) nunca são restritos.
//
// Fail-closed: para perfil não-gestão, uma falha de banco NÃO vira "sem
// restrição" (isso seria exatamente o vazamento que o achado descreve) — a
// exceção sobe e a requisição falha em vez de abrir a empresa.
// ============================================================================

const carteiraCache = new Map<number, { at: number; representanteId: number | null }>();

/** Esvazia o cache de carteira (ou só o de um usuário) ao editar o vínculo. */
export function invalidarCacheCarteira(usuarioId?: number): void {
  if (usuarioId === undefined) carteiraCache.clear();
  else carteiraCache.delete(usuarioId);
}

/**
 * Id do representante vinculado ao usuário, DENTRO das empresas concedidas.
 * Devolve `null` para perfis de gestão ou quando não há vínculo — nunca inventa
 * uma carteira. O vínculo de outra empresa do usuário não é adotado.
 */
export async function carteiraDoUsuario(actor: {
  id: number;
  perfil?: string;
  empresas?: number[];
}): Promise<number | null> {
  if (actor.perfil === 'admin' || actor.perfil === 'gerente') return null;
  const usuarioId = Number(actor.id);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) return null;

  const hit = carteiraCache.get(usuarioId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.representanteId;

  const r = getResource('representantes');
  let representanteId: number | null = null;
  if (r) {
    const permitidas = new Set((actor.empresas || []).map(Number));
    const { rows } = await getStore().list(r, { page: 1, pageSize: 50, filter: { usuario_id: usuarioId } });
    const dentro = rows.find((row) => permitidas.has(Number(row.empresa_id)));
    representanteId = dentro ? Number(dentro.id) : null;
  }
  carteiraCache.set(usuarioId, { at: Date.now(), representanteId });
  return representanteId;
}
