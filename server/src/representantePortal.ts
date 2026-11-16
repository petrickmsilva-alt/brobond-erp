import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { getResource } from './resources';
import { getStore } from './services';

/**
 * Allowlist fechada para contas configuradas como acesso exclusivo ao portal.
 * Rotas de negócio só entram quando implementadas sob /api/representante/portal.
 */
export function portalRepresentantePodeAcessar(method: string, rawPath: string): boolean {
  const verbo = String(method || 'GET').toUpperCase();
  const caminho = String(rawPath || '').split('?')[0].replace(/\/+$/, '') || '/';

  if (caminho === '/api/meta' && verbo === 'GET') return true;
  if (caminho === '/api/auth/me' && verbo === 'GET') return true;
  if (caminho === '/api/auth/change-password' && verbo === 'POST') return true;
  if (caminho === '/api/auth/logout' && verbo === 'POST') return true;
  if (caminho === '/api/auth/logout-all' && verbo === 'POST') return true;
  if (caminho === '/api/auth/reautenticar' && verbo === 'POST') return true;
  if (caminho === '/api/auth/sessoes' && verbo === 'GET') return true;
  if (/^\/api\/auth\/sessoes\/[^/]+\/revogar$/.test(caminho) && verbo === 'POST') return true;
  if (caminho === '/api/auth/mfa/status' && verbo === 'GET') return true;
  if (['/api/auth/mfa/setup', '/api/auth/mfa/ativar', '/api/auth/mfa/desativar', '/api/auth/mfa/codigos'].includes(caminho) && verbo === 'POST') return true;
  if (caminho === '/api/auth/preferences' && ['GET', 'PUT'].includes(verbo)) return true;
  if (caminho.startsWith('/api/representante/portal/') && ['GET', 'POST'].includes(verbo)) return true;
  return false;
}

/** Impede que uma conta de portal use os endpoints gerais do ERP por chamada direta. */
export function restringirAcessoPortalRepresentante(req: Request, res: Response, next: NextFunction) {
  const actor = (req as Request & { user?: { portal_representante?: boolean; carteira?: number | null; perfil?: string } }).user;
  if (actor?.portal_representante !== true) return next();

  const carteira = Number(actor.carteira);
  if (actor.perfil !== 'operador' || !Number.isInteger(carteira) || carteira <= 0) {
    return res.status(403).json({ error: 'Acesso ao portal indisponível: vínculo de representante inválido.' });
  }

  const path = req.originalUrl || req.url || req.path;
  if (!portalRepresentantePodeAcessar(req.method, path)) {
    return res.status(403).json({ error: 'Esta conta possui acesso exclusivo ao Portal do Representante.' });
  }
  return next();
}

/** Identidade mínima e segura da conta autenticada no portal. */
export async function obterIdentidadeRepresentante(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.portal_representante !== true || actor.perfil !== 'operador') {
    throw new HttpError(403, 'Esta conta não está habilitada para o Portal do Representante.');
  }

  const escopo = escopoDoAtor(actor);
  const representanteId = Number(actor.carteira);
  if (!Number.isInteger(representanteId) || representanteId <= 0) {
    throw new HttpError(403, 'A conta não possui representante vinculado na empresa ativa.');
  }

  const recurso = getResource('representantes');
  if (!recurso) throw new HttpError(503, 'Cadastro de representantes indisponível.');

  const representante = await getStore().findOneWhere(recurso, {
    id: representanteId,
    empresa_id: escopo.empresaId,
    usuario_id: actor.id,
    ativo: true,
  });
  if (!representante) {
    throw new HttpError(403, 'O vínculo do representante está inativo ou não pertence à empresa ativa.');
  }

  res.json({
    representante: {
      id: Number(representante.id),
      codigo: representante.codigo ?? null,
      nome: String(representante.nome ?? ''),
      tipo_representante: representante.tipo_representante ?? null,
      email: representante.email ?? null,
      telefone: representante.telefone ?? null,
      celular: representante.celular ?? null,
      territorio_id: representante.territorio_id ?? null,
      regiao: representante.regiao ?? null,
    },
    empresa_id: escopo.empresaId,
    usuario: { nome: actor.name, email: actor.email },
  });
}
