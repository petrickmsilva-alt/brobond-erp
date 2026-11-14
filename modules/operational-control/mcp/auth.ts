// ============================================================================
// OPERATIONAL CONTROL › MCP › IDENTIDADE
//
// O MCP é Resource Server: aceita SOMENTE o access token OAuth 2.1 (RS256,
// audience do recurso). NÃO aceita a sessão do ERP (HS256) — o agente não é um
// usuário logado. NÃO aceita `user_id`, `perfil`, `empresa_id` ou `role`
// enviados no corpo como prova: a identidade sai EXCLUSIVAMENTE do token.
//
// A autorização é a MESMA do Control Plane (`exigirAutorizacao`: escopo OAuth ∩
// perfil ∩ política) — o MCP não duplica regra de negócio.
// ============================================================================
import type { NextFunction, Request, Response } from 'express';
import { getStore } from '../../../server/src/services';
import { RESOURCES } from '../../../server/src/resources';
import { empresasDoUsuario } from '../../../server/src/empresasAcesso';
import { normalizarEscopos } from '../domain/scopes';
import { validarAccessToken } from '../oauth/tokens';
import { auditarOperacao } from '../infrastructure/audit';
import { OperationalError } from '../domain/errors';
import type { OperationalActor } from '../domain/operation';

const MENSAGEM_401 = 'Autenticação OAuth 2.1 obrigatória (Bearer token RS256 do recurso MCP).';

function extrairBearer(header: unknown): string {
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? ''));
  return m ? m[1].trim() : '';
}

/** O Bearer é um JWT RS256 (token OAuth do MCP)? A sessão do ERP é HS256. */
export function bearerEhOAuth(req: Request): boolean {
  const token = extrairBearer(req.headers.authorization);
  const partes = token.split('.');
  if (partes.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8')) as { alg?: string };
    return String(header.alg ?? '').toUpperCase() === 'RS256';
  } catch {
    return false;
  }
}

/** Reconstrói o ator a partir do token validado. Nunca lê identidade do corpo. */
export async function atorDoTokenMcp(sub: string, scopes: string[], empresaToken: number): Promise<OperationalActor> {
  const id = Number(String(sub).replace(/^user:/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new OperationalError('NAO_AUTENTICADO', 'Token sem identidade de usuário.');
  const row = await getStore().findOneWhere(RESOURCES.usuarios, { id });
  if (!row || row.ativo === false) throw new OperationalError('NAO_AUTENTICADO', 'Usuário inexistente ou desativado.');
  const permitidas = await empresasDoUsuario(id, Number(row.empresa_id) || 1);
  if (!permitidas.includes(Number(empresaToken))) {
    throw new OperationalError('SEM_PERMISSAO', 'O token não tem mais acesso à empresa do consentimento.');
  }
  return {
    id,
    name: String(row.nome ?? ''),
    perfil: (row.perfil as OperationalActor['perfil']) ?? 'operador',
    empresa_id: Number(empresaToken),
    scopes,
    viaMcp: true,
  };
}

/**
 * Resolve o ator do token. Em falha, responde 401 com o cabeçalho
 * `WWW-Authenticate` apontando para os metadados do recurso (descoberta OAuth
 * do MCP). Não grava token em log.
 */
export async function autenticarMcp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extrairBearer(req.headers.authorization);
    if (!token) throw new OperationalError('NAO_AUTENTICADO', MENSAGEM_401);
    const v = await validarAccessToken(token);
    if (!v.ok || !v.claims) {
      await auditarOperacao({ empresaId: 0, actorId: null, eventType: 'access.denied', payload: { motivo: v.motivo ?? 'token_invalido', origem: 'mcp' } }).catch(() => {});
      throw new OperationalError('NAO_AUTENTICADO', MENSAGEM_401);
    }
    const c = v.claims;
    (req as Request & { mcpActor?: OperationalActor }).mcpActor = await atorDoTokenMcp(c.sub, normalizarEscopos(c.scope), Number(c.emp));
    next();
  } catch (e) {
    if (e instanceof OperationalError && e.status === 401) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', baseDoRecurso()).toString()}"`);
    }
    next(e);
  }
}

/** URL base pública do recurso (para montar o link de metadados). */
export function baseDoRecurso(): string {
  const aud = process.env.OAUTH_RESOURCE ?? 'https://mcp.brobond.com.br/mcp';
  try {
    const u = new URL(aud);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://mcp.brobond.com.br';
  }
}

/** Ator já resolvido (lança 401 se ausente). */
export function atorMcp(req: Request): OperationalActor {
  const actor = (req as Request & { mcpActor?: OperationalActor }).mcpActor;
  if (!actor) throw new OperationalError('NAO_AUTENTICADO', MENSAGEM_401);
  return actor;
}
