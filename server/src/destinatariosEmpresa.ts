// R-12 (Fase 4.2) — destinatários autorizados por empresa para e-mails com dados de negócio.
//
// Regras (todas obrigatórias):
//  - a lista configurada (SCHEDULE_EMAILS / NOTIFICAR_EMAILS) só RESTRINGE a distribuição;
//    nunca a amplia: quem não está na lista não recebe nada;
//  - o destinatário precisa ser um usuário real (mesmo caminho do login: findUserByEmail),
//    com acesso vigente (ativo e não expirado), vinculado à empresa (empresasDoUsuario) e com
//    permissão de leitura (RBAC existente, checkAccess) em TODOS os recursos do e-mail;
//  - sem identificação segura, nada é enviado para aquela empresa.
import { checkAccess, getStore } from './services';
import { getResource } from './resources';
import { empresasDoUsuario } from './empresasAcesso';

export interface DestinoEmpresa {
  empresaId: number;
  emails: string[];
}

export const normalizarEmail = (e: unknown): string => String(e ?? '').trim().toLowerCase();

/** O usuário tem leitura de TODOS os recursos? Reaproveita o RBAC de `checkAccess` (sem regra nova). */
export function podeLerTodos(usuario: Record<string, unknown>, chavesRecursos: string[]): boolean {
  return chavesRecursos.every((chave) => {
    const r = getResource(chave);
    if (!r) return false;
    try {
      checkAccess(r, usuario as any, 'read');
      return true;
    } catch {
      return false;
    }
  });
}

/** Acesso vigente: não bloqueado e não expirado. */
export function acessoVigente(usuario: Record<string, unknown>, agora = Date.now()): boolean {
  if (usuario.ativo === false || usuario.ativo === 0) return false;
  const expira = usuario.acesso_expira_em ? Date.parse(String(usuario.acesso_expira_em)) : NaN;
  return !(Number.isFinite(expira) && expira < agora);
}

/**
 * Para cada empresa, os destinatários autorizados dentro de `permitidos`.
 * Empresa sem destinatário identificado não aparece na lista (e seus dados não são enviados).
 */
export async function destinosPorEmpresa(permitidos: string[], chavesRecursos: string[]): Promise<DestinoEmpresa[]> {
  const emails = [...new Set(permitidos.map(normalizarEmail).filter(Boolean))];
  if (!emails.length) return [];
  const s = getStore();
  const empresas = await s.list(getResource('empresas')!, { page: 1, pageSize: 500 });
  const idsEmpresas = empresas.rows.map((e) => Number(e.id)).filter((n) => n > 0);
  const porEmpresa = new Map<number, Set<string>>();
  for (const email of emails) {
    // findUserByEmail = SELECT * (mesmo caminho do login): traz `usuarios.empresa_id` e as permissões.
    // Listar pelo recurso `usuarios` NÃO traz `empresa_id` (a coluna não é declarada no recurso).
    const usuario = await s.findUserByEmail(email);
    if (!usuario) continue;
    if (!acessoVigente(usuario)) continue;
    if (!podeLerTodos(usuario, chavesRecursos)) continue;
    const vinculadas = await empresasDoUsuario(Number(usuario.id), Number(usuario.empresa_id) || undefined);
    for (const id of idsEmpresas) {
      if (!vinculadas.includes(id)) continue;
      const atual = porEmpresa.get(id) ?? new Set<string>();
      atual.add(email);
      porEmpresa.set(id, atual);
    }
  }
  return [...porEmpresa.entries()]
    .map(([empresaId, conjunto]) => ({ empresaId, emails: [...conjunto].sort() }))
    .sort((a, b) => a.empresaId - b.empresaId);
}
