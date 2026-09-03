import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { HttpError } from './errors';
import { getStore } from './services';
import type { Row } from './store';
import { registerLoginFailure, registerLoginSuccess } from './security';

const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';
const TOKEN_TTL = process.env.JWT_TTL || '8h';
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@brobond.com.br').trim().toLowerCase();
export const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'brobond123').trim();
const BCRYPT_ROUNDS = 10;

export type Perfil = 'admin' | 'gerente' | 'operador';
export type AuthUser = { id: number; name: string; email: string; perfil: Perfil };

export function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
    return bcrypt.compare(plain, hash);
  }
  // Compatibilidade com senhas gravadas em texto puro em versões antigas
  return plain === hash;
}

function extractToken(header: string): string {
  if (!header) return '';
  const trimmed = header.trim();
  return /^Bearer\s+/i.test(trimmed) ? trimmed.replace(/^Bearer\s+/i, '').trim() : trimmed;
}

function toAuthUser(row: Row): AuthUser {
  const perfil = (['admin', 'gerente', 'operador'] as Perfil[]).includes(row.perfil) ? row.perfil : 'operador';
  return { id: Number(row.id), name: row.nome || 'Usuário', email: row.email, perfil };
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, SECRET, { expiresIn: TOKEN_TTL } as jwt.SignOptions);
}

export function clientIp(req: Request): string {
  const fwd = (req.headers['x-forwarded-for'] as string) || '';
  return (fwd.split(',')[0] || req.socket.remoteAddress || '').trim();
}

/**
 * Garante que o administrador definido em ADMIN_EMAIL/ADMIN_PASSWORD exista
 * no banco (com senha em hash bcrypt). Executado na inicialização.
 *  - não existe → cria
 *  - existe sem senha → define a senha
 *  - existe com senha → mantém (a senha pode ter sido trocada pela interface),
 *    a menos que ADMIN_FORCE_PASSWORD=true (útil para recuperar o acesso).
 */
export async function ensureAdmin(): Promise<void> {
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const r = RESOURCES.usuarios;
  try {
    const existing = await store.findUserByEmail(ADMIN_EMAIL);
    if (!existing) {
      const created = await store.insert(r, {
        nome: 'Administrador',
        email: ADMIN_EMAIL,
        senha_hash: await hashPassword(ADMIN_PASSWORD),
        perfil: 'admin',
        ativo: true,
      });
      console.log(`👤 Usuário administrador criado: ${ADMIN_EMAIL} (id ${created.id})`);
      return;
    }
    const patch: Record<string, unknown> = {};
    if (!existing.senha_hash || process.env.ADMIN_FORCE_PASSWORD === 'true') {
      patch.senha_hash = await hashPassword(ADMIN_PASSWORD);
    }
    if (existing.perfil !== 'admin') patch.perfil = 'admin';
    if (existing.ativo === false) patch.ativo = true;
    if (Object.keys(patch).length) {
      await store.update(r, Number(existing.id), patch);
      console.log(`👤 Usuário administrador atualizado: ${ADMIN_EMAIL}`);
    }
  } catch (e: any) {
    console.warn('⚠️  Não foi possível garantir o usuário administrador:', e?.message || e);
  }
}

export async function login(req: Request, res: Response) {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password ?? '').trim();

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
  }

  const store = getStore();
  let row: Row | null = null;
  let lookupFailed = false;
  try {
    row = await store.findUserByEmail(email);
  } catch (e: any) {
    lookupFailed = true;
    console.warn('⚠️  Falha ao consultar usuários:', e?.message || e);
  }

  if (row) {
    if (row.ativo === false) {
      return res.status(403).json({ error: 'Usuário desativado. Fale com o administrador.' });
    }
    if (await verifyPassword(password, row.senha_hash)) {
      const user = toAuthUser(row);
      registerLoginSuccess(req);
      await store.touchLogin(user.id);
      await store
        .audit({
          usuario_id: user.id,
          usuario: user.name,
          acao: 'login',
          recurso: null,
          registro_id: null,
          descricao: `Login de ${user.email} (${clientIp(req) || 'ip desconhecido'})`,
        })
        .catch(() => undefined);
      return res.json({ token: signToken(user), user });
    }
    return loginFailed(req, res, row);
  }

  // Acesso de emergência: banco indisponível e credenciais do administrador
  // configuradas nas variáveis de ambiente.
  if (lookupFailed && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const user: AuthUser = { id: 0, name: 'Administrador', email, perfil: 'admin' };
    console.warn('⚠️  Login de emergência do administrador (banco indisponível).');
    return res.json({ token: signToken(user), user });
  }

  return loginFailed(req, res, null);
}

/** Resposta padrão de falha de login: conta a tentativa e registra bloqueio na auditoria. */
async function loginFailed(req: Request, res: Response, row: Row | null) {
  const left = registerLoginFailure(req);
  if (left === 0) {
    await getStore()
      .audit({
        usuario_id: row ? Number(row.id) : null,
        usuario: row?.nome || normalizeEmail(req.body?.email) || null,
        acao: 'login',
        recurso: null,
        registro_id: null,
        descricao: `Login BLOQUEADO temporariamente por excesso de tentativas — ${normalizeEmail(req.body?.email)} (${clientIp(req) || 'ip desconhecido'})`,
      })
      .catch(() => undefined);
  }
  const hint = left > 0 && left <= 2 ? ` Restam ${left} tentativa${left === 1 ? '' : 's'}.` : '';
  return res.status(401).json({ error: `E-mail ou senha incorretos.${hint}` });
}

// Cache curto para não consultar o usuário no banco a cada requisição,
// mas ainda derrubar rapidamente quem for desativado.
const userCache = new Map<number, { user: AuthUser; at: number }>();
const USER_CACHE_MS = 30_000;

export function invalidateUserCache(id?: number) {
  if (id === undefined) userCache.clear();
  else userCache.delete(id);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken((req.headers.authorization as string) || '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });

  let payload: AuthUser;
  try {
    payload = jwt.verify(token, SECRET) as AuthUser;
  } catch (err: any) {
    if (process.env.NODE_ENV !== 'production') console.warn('Token inválido:', err.message);
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }

  // Revalida o usuário (ativo? perfil mudou?) — exceto o acesso de emergência (id 0)
  if (payload.id > 0) {
    const cached = userCache.get(payload.id);
    if (cached && Date.now() - cached.at < USER_CACHE_MS) {
      payload = cached.user;
    } else {
      try {
        const store = getStore();
        const { RESOURCES } = await import('./resources');
        const row = await store.findOneWhere(RESOURCES.usuarios, { id: payload.id });
        if (!row || row.ativo === false) {
          userCache.delete(payload.id);
          return res.status(401).json({ error: 'Usuário desativado ou removido.' });
        }
        payload = toAuthUser(row);
        userCache.set(payload.id, { user: payload, at: Date.now() });
      } catch {
        // banco indisponível: segue com os dados do token
      }
    }
  }

  (req as any).user = payload;
  next();
}

export function currentUser(req: Request): AuthUser {
  return (req as any).user as AuthUser;
}

export function requireRole(...roles: Perfil[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = currentUser(req);
    if (!u || !roles.includes(u.perfil)) {
      return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    }
    next();
  };
}

export function me(req: Request, res: Response) {
  res.json({ user: currentUser(req) });
}

/** Troca de senha do próprio usuário (exige a senha atual). */
export async function changePassword(req: Request, res: Response) {
  const u = currentUser(req);
  const atual = String(req.body?.senha_atual ?? '');
  const nova = String(req.body?.senha_nova ?? '');
  if (u.id <= 0) throw new HttpError(400, 'O acesso de emergência não permite trocar a senha por aqui.');
  if (nova.length < 6) throw new HttpError(400, 'A nova senha deve ter pelo menos 6 caracteres.', { senha_nova: 'Mínimo de 6 caracteres' });

  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: u.id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (!(await verifyPassword(atual, row.senha_hash))) {
    throw new HttpError(400, 'Senha atual incorreta.', { senha_atual: 'Senha incorreta' });
  }
  await store.update(RESOURCES.usuarios, u.id, { senha_hash: await hashPassword(nova) });
  await store.audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} trocou a própria senha`,
  });
  res.json({ ok: true });
}
