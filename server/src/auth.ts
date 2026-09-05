import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { HttpError } from './errors';
import { getStore } from './services';
import type { Row } from './store';
import { registerLoginFailure, registerLoginSuccess } from './security';
import { validarPoliticaSenha } from './services';

const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET não definido — usando valor padrão (NÃO use em produção).');
}
const TOKEN_TTL = process.env.JWT_TTL || '8h';
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@brobond.com.br').trim().toLowerCase();
export const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'brobond123').trim();
const BCRYPT_ROUNDS = 10;

export type Perfil = 'admin' | 'gerente' | 'operador';
export type AuthUser = { id: number; name: string; email: string; perfil: Perfil; trocar_senha?: boolean };

export function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** Sem fallback de texto puro: apenas hashes bcrypt ($2a/$2b/$2y) são aceitos. */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  if (!(hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$'))) return false;
  return bcrypt.compare(plain, hash);
}

/** Hash do token de redefinição de senha (guardamos apenas o hash). */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function gerarResetToken(): string {
  return randomBytes(24).toString('hex');
}

export function validarSenhaNova(senha: unknown, email?: string): string | null {
  const s = String(senha ?? '');
  const erro = validarPoliticaSenha(s, email);
  return erro ? erro.replace(/A senha deve ter/, 'A nova senha deve ter') : null;
}

function extractToken(header: string): string {
  if (!header) return '';
  const trimmed = header.trim();
  return /^Bearer\s+/i.test(trimmed) ? trimmed.replace(/^Bearer\s+/i, '').trim() : trimmed;
}

function toAuthUser(row: Row): AuthUser {
  const perfil = (['admin', 'gerente', 'operador'] as Perfil[]).includes(row.perfil) ? row.perfil : 'operador';
  const user: AuthUser = { id: Number(row.id), name: row.nome || 'Usuário', email: row.email, perfil };
  if (row.trocar_senha === true) user.trocar_senha = true;
  return user;
}

export type SignOpts = { ver?: number; expiresIn?: string | number };

export function signToken(user: AuthUser, opts: SignOpts = {}): string {
  const payload: Record<string, unknown> = { ...user };
  if (opts.ver !== undefined) payload.ver = opts.ver;
  return jwt.sign(payload, SECRET, { expiresIn: opts.expiresIn || TOKEN_TTL } as jwt.SignOptions);
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
        senha_cifrada: (await import('./passwordVault')).encryptVaultPassword(ADMIN_PASSWORD),
        perfil: 'admin',
        ativo: true,
        trocar_senha: true,
      });
      console.log(`👤 Usuário administrador criado: ${ADMIN_EMAIL} (id ${created.id})`);
      console.log('🔑 Troque a senha padrão no primeiro acesso (o sistema vai pedir).');
      return;
    }
    const patch: Record<string, unknown> = {};
    if (!existing.senha_hash || process.env.ADMIN_FORCE_PASSWORD === 'true') {
      patch.senha_hash = await hashPassword(ADMIN_PASSWORD);
      patch.senha_cifrada = (await import('./passwordVault')).encryptVaultPassword(ADMIN_PASSWORD);
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
          descricao: `Login de ${user.email} (${clientIp(req) || 'ip desconhecido'})${req.body?.lembrar ? ' com "Lembrar-me" (30 dias)' : ''}`,
        })
        .catch(() => undefined);
      const lembrar = req.body?.lembrar === true;
      const token = signToken(user, { ver: Number(row.token_versao || 0), expiresIn: lembrar ? '30d' : undefined });
      return res.json({ token, user: { ...user, lembrar } });
    }
    return loginFailed(req, res, row);
  }

  // Acesso de emergência: banco indisponível e credenciais do administrador
  // configuradas nas variáveis de ambiente.
  if (lookupFailed && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const user: AuthUser = { id: 0, name: 'Administrador', email, perfil: 'admin' };
    console.warn('⚠️  Login de emergência do administrador (banco indisponível).');
    return res.json({ token: signToken(user, { expiresIn: '1h' }), user });
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

  let payload: AuthUser & { ver?: number };
  try {
    payload = jwt.verify(token, SECRET) as AuthUser & { ver?: number };
  } catch (err: any) {
    if (process.env.NODE_ENV !== 'production') console.warn('Token inválido:', err.message);
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }

  // Revalida o usuário (ativo? perfil mudou? sessão derrubada?) — exceto o
  // acesso de emergência (id 0).
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
        // "Sair de todos os dispositivos" incrementa token_versao → token antigo cai.
        if (Number(row.token_versao || 0) !== Number(payload.ver || 0)) {
          userCache.delete(payload.id);
          return res.status(401).json({ error: 'Sessão encerrada em outro dispositivo. Entre novamente.' });
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
  const erro = validarSenhaNova(nova, u.email);
  if (erro) throw new HttpError(400, erro, { senha_nova: erro });

  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: u.id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (!(await verifyPassword(atual, row.senha_hash))) {
    throw new HttpError(400, 'Senha atual incorreta.', { senha_atual: 'Senha incorreta' });
  }
  const novaHash = await hashPassword(nova);
  const { encryptVaultPassword } = await import('./passwordVault');
  await store.update(RESOURCES.usuarios, u.id, { senha_hash: novaHash, senha_cifrada: encryptVaultPassword(nova), trocar_senha: false });
  await store.audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} trocou a própria senha`,
  });
  // Mantém as outras sessões válidas (mesmo token_versao), só conclui a troca.
  invalidateUserCache(u.id);
  res.json({ ok: true });
}

/** POST /api/auth/logout-all — derruba as sessões de todos os dispositivos. */
export async function logoutAll(req: Request, res: Response) {
  const u = currentUser(req);
  if (u.id <= 0) return res.status(200).json({ ok: true });
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: u.id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  const novo = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, u.id, { token_versao: novo });
  await store.audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} encerrou a sessão em todos os dispositivos`,
    dados: { token_versao: novo },
  });
  invalidateUserCache(u.id);
  res.json({ ok: true });
}

/** POST /api/auth/forgot — sempre 200; só age (e envia e-mail) se o e-mail existir. */
export async function forgotPassword(req: Request, res: Response) {
  const email = normalizeEmail(req.body?.email);
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const { enviarEmail } = await import('./mail');
  try {
    if (email) {
      const row = await store.findUserByEmail(email);
      if (row && row.ativo !== false) {
        const token = gerarResetToken();
        const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await store.update(RESOURCES.usuarios, Number(row.id), { reset_token_hash: hashResetToken(token), reset_expira_em: expira });
        await store.audit({
          usuario_id: Number(row.id),
          usuario: row.nome || email,
          acao: 'senha',
          recurso: 'usuarios',
          registro_id: Number(row.id),
          descricao: `Solicitação de redefinição de senha para ${email}`,
        }).catch(() => undefined);
        const base = (process.env.APP_URL || '').replace(/\/+$/, '');
        const link = `${base || ''}/redefinir/${token}`;
        await enviarEmail({
          to: email,
          assunto: 'BROBOND ERP — redefinição de senha',
          html: `Olá! Recebemos um pedido para redefinir a senha do seu acesso ao BROBOND ERP.<br/><br/>Abra o link abaixo (válido por 1 hora):<br/><a href="${link}">${link}</a><br/><br/>Se você não pediu esta troca, ignore este e-mail.`,
        });
      }
    }
  } catch (e: any) {
    console.warn('⚠️  Falha ao processar "esqueci minha senha":', e?.message || e);
  }
  // Resposta idêntica existindo ou não o e-mail (evita descoberta de contas).
  res.json({ ok: true });
}

/** POST /api/auth/reset — { token, senha } redefine e derruba outras sessões. */
export async function resetPassword(req: Request, res: Response) {
  const token = String(req.body?.token ?? '').trim();
  const senha = String(req.body?.senha ?? '');
  if (!token || !senha) throw new HttpError(400, 'Envie o token e a nova senha.');
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const hash = hashResetToken(token);
  const row = await store.findOneWhere(RESOURCES.usuarios, { reset_token_hash: hash });
  if (!row) throw new HttpError(400, 'Link inválido ou já utilizado. Peça um novo link em "Esqueci minha senha".');
  if (!row.reset_expira_em || new Date(String(row.reset_expira_em)).getTime() < Date.now()) {
    throw new HttpError(400, 'Este link expirou. Peça um novo em "Esqueci minha senha".');
  }
  const erro = validarSenhaNova(senha, row.email);
  if (erro) throw new HttpError(400, erro, { senha: erro });
  const novaHash = await hashPassword(senha);
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: novaHash,
    senha_cifrada: (await import('./passwordVault')).encryptVaultPassword(senha),
    reset_token_hash: null,
    reset_expira_em: null,
    trocar_senha: false,
    token_versao: versao,
  });
  await store.audit({
    usuario_id: Number(row.id),
    usuario: row.nome || String(row.email),
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: Number(row.id),
    descricao: `Senha redefinida via link de recuperação (${String(row.email)})`,
    dados: { metodo: 'reset' },
  }).catch(() => undefined);
  invalidateUserCache(Number(row.id));
  res.json({ ok: true });
}

/**
 * Migração de segurança: em produção, nenhum senha_hash pode ser texto puro
 * (versões antigas gravavam sem hash). Quem estiver assim tem o hash trocado
 * por um valor aleatório e é marcado com trocar_senha (precisa recuperar).
 */
export async function migrarSenhasLegadas(): Promise<number> {
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  try {
    const usuarios = await store.listUsuariosRaw();
    let migrados = 0;
    for (const u of usuarios) {
      const h = u.senha_hash ? String(u.senha_hash) : '';
      if (h && !(h.startsWith('$2a$') || h.startsWith('$2b$') || h.startsWith('$2y$'))) {
        await store.update(RESOURCES.usuarios, Number(u.id), {
          senha_hash: await hashPassword(randomBytes(12).toString('hex')),
          trocar_senha: true,
          token_versao: Number(u.token_versao || 0) + 1,
        });
        await store.audit({
          usuario_id: Number(u.id),
          usuario: u.nome || String(u.email),
          acao: 'senha',
          recurso: 'usuarios',
          registro_id: Number(u.id),
          descricao: `Senha legada (texto puro) invalidada — recuperação obrigatória via "Esqueci minha senha"`,
        }).catch(() => undefined);
        migrados++;
      }
    }
    if (migrados) console.warn(`🔒 ${migrados} usuário(s) com senha em texto puro foram marcados para troca obrigatória.`);
    return migrados;
  } catch (e: any) {
    console.warn('⚠️  Verificação de senhas legadas falhou:', e?.message || e);
    return 0;
  }
}

/** GET /api/auth/preferences — preferências locais do usuário (JSONB). */
export async function getPreferences(req: Request, res: Response) {
  const u = currentUser(req);
  if (u.id <= 0) return res.json({ preferencias: {} });
  const prefs = await getStore().getPreferences(u.id);
  res.json({ preferencias: prefs || {} });
}

/** PUT /api/auth/preferences — salva preferências do usuário (body: { preferencias }). */
export async function savePreferences(req: Request, res: Response) {
  const u = currentUser(req);
  if (u.id <= 0) throw new HttpError(400, 'O acesso de emergência não usa preferências.');
  const body = (req.body || {}) as { preferencias?: unknown };
  if (!body.preferencias || typeof body.preferencias !== 'object' || Array.isArray(body.preferencias)) {
    throw new HttpError(400, 'Envie { preferencias: { ... } }.', { preferencias: 'Formato inválido' });
  }
  const prefs = body.preferencias as Record<string, unknown>;
  const chaves = Object.keys(prefs);
  if (chaves.length > 30) throw new HttpError(400, 'Limite de 30 preferências por usuário.');
  for (const [k, v] of Object.entries(prefs)) {
    if (!/^[a-z_][a-z0-9_]{0,39}$/i.test(k)) throw new HttpError(400, `Chave de preferência inválida: "${k}".`);
    const tipo = typeof v;
    if (!['string', 'number', 'boolean'].includes(tipo) && v !== null) {
      throw new HttpError(400, `Valor de "${k}" deve ser texto, número, booleano ou nulo.`);
    }
  }
  const atuais = await getStore().getPreferences(u.id);
  await getStore().setPreferences(u.id, { ...atuais, ...prefs });
  res.json({ ok: true, preferencias: { ...atuais, ...prefs } });
}
