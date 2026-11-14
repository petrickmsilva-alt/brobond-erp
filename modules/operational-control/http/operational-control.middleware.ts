// ============================================================================
// CONTROL PLANE › HTTP › MIDDLEWARE DE IDENTIDADE
//
// A identidade vem EXCLUSIVAMENTE do token validado. Duas portas:
//   • Bearer OAuth do MCP (RS256, audience do recurso) → identidade do token;
//   • sessão do ERP (requireAuth já montado no /api) → identidade do usuário.
//
// O cliente NUNCA envia `user_id`, `perfil`, `empresa_id` ou `role` como prova:
// se enviar, é ignorado (e o corpo é validado por schema sem esses campos).
// ============================================================================
import type { NextFunction, Request, Response } from 'express';
import { getStore } from '../../../server/src/services';
import { RESOURCES } from '../../../server/src/resources';
import { empresasDoUsuario } from '../../../server/src/empresasAcesso';
import { exigirReautenticacao, requireAuth } from '../../../server/src/auth';
import { normalizarEscopos } from '../domain/scopes';
import { validarAccessToken } from '../oauth/tokens';
import { auditarOperacao } from '../infrastructure/audit';
import { OperationalError } from '../domain/errors';
import type { OperationalActor } from '../domain/operation';

function extrairBearer(header: unknown): string {
  const h = String(header ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

/**
 * O Bearer é um access token do MCP? A distinção é pelo ALGORITMO declarado no
 * cabeçalho do JWT: o token OAuth é RS256 (assinado pela chave do Authorization
 * Server); o JWT de sessão do ERP é HS256. Sem isto, a sessão do ERP — que
 * também é um JWT (com pontos) — cairia no caminho OAuth e seria recusada.
 * O cabeçalho é apenas LIDO para rotear; a validação real continua sendo a
 * assinatura verificada em `validarAccessToken`.
 */
export function ehTokenOAuth(token: string): boolean {
  const partes = String(token ?? '').split('.');
  if (partes.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8')) as { alg?: string };
    return String(header.alg ?? '').toUpperCase() === 'RS256';
  } catch {
    return false;
  }
}

/**
 * A requisição traz um Bearer OAuth (MCP)? Exportado para o `index.ts` decidir
 * se aplica o `requireAuth` da sessão do ERP ou deixa o token OAuth para o
 * middleware do módulo — a montagem do Control Plane fica ANTES do guard global
 * justamente por isso (um token OAuth não é sessão do ERP).
 */
export function requisicaoComTokenOAuth(req: Request): boolean {
  const h = String(req.headers?.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? ehTokenOAuth(m[1].trim()) : false;
}

/** Reconstrói o ator a partir do `sub` (user:<id>) do token OAuth. */
async function atorDoToken(sub: string, scopes: string[], empresaToken: number): Promise<OperationalActor> {
  const id = Number(String(sub).replace(/^user:/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new OperationalError('NAO_AUTENTICADO', 'Token sem identidade de usuário.');
  const row = await getStore().findOneWhere(RESOURCES.usuarios, { id });
  if (!row || row.ativo === false) throw new OperationalError('NAO_AUTENTICADO', 'Usuário inexistente ou desativado.');
  const permitidas = await empresasDoUsuario(id, Number(row.empresa_id) || 1);
  // O recorte de empresa do token precisa continuar válido (revogar acesso derruba).
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

/** Middleware: popula `req.operationalActor` (OAuth ou sessão). Nunca confia no corpo. */
export async function identidadeOperacional(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extrairBearer(req.headers.authorization);
    if (token && ehTokenOAuth(token)) {
      // Formato JWT → tenta o caminho OAuth (RS256). Falha aqui é 401.
      const v = await validarAccessToken(token);
      if (!v.ok || !v.claims) {
        await auditarOperacao({ empresaId: 0, actorId: null, eventType: 'access.denied', payload: { motivo: v.motivo ?? 'token_invalido', origem: 'oauth' } }).catch(() => {});
        throw new OperationalError('NAO_AUTENTICADO', 'Token OAuth inválido ou expirado.');
      }
      const c = v.claims;
      (req as Request & { operationalActor?: OperationalActor }).operationalActor = await atorDoToken(c.sub, normalizarEscopos(c.scope), Number(c.emp));
      return next();
    }

    // Sem Bearer OAuth: aplica a guarda de sessão do ERP (mesma de /api) e usa
    // a identidade que ela resolveu. O Control Plane é montado ANTES do guard
    // global, então é AQUI que a sessão é validada nesse caminho.
    if (!(req as Request & { user?: { id: number } }).user) {
      let chamouNext = false;
      await new Promise<void>((resolve, reject) => {
        // A guarda pode RESPONDER (401/503) sem chamar `next`: nesse caso a
        // promessa dela se resolve sozinha e não devemos prosseguir.
        Promise.resolve(requireAuth(req, res, (err?: unknown) => {
          chamouNext = true;
          if (err) reject(err);
          else resolve();
        }))
          .then(() => resolve())
          .catch(reject);
      });
      if (res.headersSent || !chamouNext) return; // a guarda já respondeu (401/503)
    }
    const u = (req as Request & { user?: { id: number; name: string; perfil: string; empresa_id?: number; empresas?: number[]; empresa_sessao?: number | null } }).user;
    if (!u || !(Number(u.id) > 0)) throw new OperationalError('NAO_AUTENTICADO', 'Autenticação obrigatória.');
    const empresa = Number(u.empresa_sessao ?? u.empresa_id ?? (u.empresas?.[0] ?? 1));
    (req as Request & { operationalActor?: OperationalActor }).operationalActor = {
      id: u.id,
      name: u.name,
      perfil: (u.perfil as OperationalActor['perfil']) ?? 'operador',
      empresa_id: empresa,
      // Sessão do ERP: a política operacional é a autoridade (não há escopo OAuth).
      scopes: normalizarEscopos(process.env.OPERATIONAL_SESSION_SCOPES ?? 'brobond:system:read brobond:github:read brobond:workflow:read brobond:workflow:request brobond:workflow:approve brobond:audit:read'),
      viaMcp: false,
    };
    next();
  } catch (e) {
    next(e);
  }
}

/** Extrai o ator já resolvido (lança 401 se ausente). */
export function atorOperacional(req: Request): OperationalActor {
  const actor = (req as Request & { operationalActor?: OperationalActor }).operationalActor;
  if (!actor) throw new OperationalError('NAO_AUTENTICADO', 'Autenticação obrigatória.');
  return actor;
}

/**
 * Exige CONFIRMAÇÃO HUMANA RECENTE. O agente MCP nunca satisfaz: não há sessão
 * de navegador por trás de um token OAuth de cliente, então a aprovação por
 * essa via é recusada por desenho. Só a sessão do ERP (com reautenticação
 * recente) aprova.
 */
export function exigirConfirmacaoHumana(req: Request): void {
  const actor = atorOperacional(req);
  if (actor.viaMcp) {
    throw new OperationalError('SEM_PERMISSAO', 'A aprovação exige uma sessão autenticada do ERP com confirmação humana recente. O agente MCP não aprova.');
  }
  exigirReautenticacao(req);
}
