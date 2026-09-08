import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { getStore } from './services';
import type { Row } from './store';
import { loginBucketKey, registerLoginFailure, registerLoginSuccess, registrarFalha, registrarSucesso, exigirRateLimit } from './security';
import { validarPoliticaSenha } from './services';
import { hashPassword, verifyPassword, verifyPasswordDetailed, hashAtualizado } from './password';
import { abrirSessao, revogarTodas, revogarUma, listSessoesAtivas as listarAtivas } from './sessoes';
import { decifrarSegredoMfa, prepararDesafio, signMfaTicket, lerMfaTicket, cifrarSegredoMfa } from './mfa';

export { hashPassword, verifyPassword };

const isProd = process.env.NODE_ENV === 'production';
if (!process.env.JWT_SECRET) {
  // Com a chave padrão qualquer pessoa assina um JWT de admin. Em produção isso
  // é falha de deploy: melhor o serviço não subir do que subir vulnerável.
  if (isProd) {
    throw new Error('JWT_SECRET é obrigatório em produção (a chave padrão permite forjar tokens de administrador). Defina a variável no painel e faça redeploy.');
  }
  console.warn('⚠️  JWT_SECRET não definido — usando valor padrão (NÃO use em produção).');
}
const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';
const TOKEN_TTL = process.env.JWT_TTL || '8h';
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@brobond.com.br').trim().toLowerCase();
if (!process.env.ADMIN_PASSWORD && isProd) {
  // Sem ADMIN_PASSWORD o admin nasceria com a senha padrão, que é pública
  // (está no README). O primeiro acesso exige troca de senha e MFA, mas o
  // cadastro do MFA é self-service: com a senha padrão em mãos o portão cai.
  throw new Error('ADMIN_PASSWORD é obrigatório em produção. Defina a senha inicial do administrador (ou ADMIN_EMAIL próprio) no painel e faça redeploy.');
}
export const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'brobond123').trim();
const RESET_TTL_MIN = Number(process.env.RESET_TTL_MINUTES) || 60;
export const REAUTH_TTL_MS = Number(process.env.REAUTH_TTL_MS) || 5 * 60_000;

export type Perfil = 'admin' | 'gerente' | 'operador';
export type AuthUser = { id: number; name: string; email: string; perfil: Perfil; trocar_senha?: boolean };

export function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

/** Hash do token de convite/redefinição (guardamos apenas o hash SHA-256). */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Token aleatório de 256 bits (convite / redefinição). */
export function gerarResetToken(): string {
  return randomBytes(32).toString('hex');
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

export type SignOpts = { ver?: number; sid?: string; typ?: 'access' | 'mfa'; lembrar?: boolean; expiresIn?: string | number };

export function signToken(user: AuthUser, opts: SignOpts = {}): string {
  const payload: Record<string, unknown> = { ...user, typ: opts.typ || 'access' };
  if (opts.ver !== undefined) payload.ver = opts.ver;
  if (opts.sid) payload.sid = opts.sid;
  if (opts.lembrar !== undefined) payload.lembrar = opts.lembrar;
  return jwt.sign(payload, SECRET, { expiresIn: opts.expiresIn || TOKEN_TTL } as jwt.SignOptions);
}

/** Verifica um JWT; devolve o payload ou null (nunca lança). */
export function verifyToken(token: string): Record<string, any> | null {
  try {
    return jwt.verify(token, SECRET) as Record<string, any>;
  } catch {
    return null;
  }
}

export function clientIp(req: Request): string {
  const fwd = (req.headers['x-forwarded-for'] as string) || '';
  return (fwd.split(',')[0] || req.socket.remoteAddress || '').trim();
}

/**
 * Garante que o administrador definido em ADMIN_EMAIL/ADMIN_PASSWORD exista
 * no banco (com senha em hash Argon2id). Executado na inicialização.
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
        trocar_senha: true,
        senha_definida_em: new Date().toISOString(),
      });
      console.log(`👤 Usuário administrador criado: ${ADMIN_EMAIL} (id ${created.id})`);
      console.log('🔑 Troque a senha padrão no primeiro acesso (o sistema vai pedir) e ative o MFA (obrigatório para administradores).');
      return;
    }
    const patch: Record<string, unknown> = {};
    if (!existing.senha_hash || process.env.ADMIN_FORCE_PASSWORD === 'true') {
      patch.senha_hash = await hashPassword(ADMIN_PASSWORD);
      patch.trocar_senha = true;
      patch.senha_definida_em = new Date().toISOString();
      patch.senha_provisoria = false;
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

// ----------------------------------------------------------------------------
// Login
// ----------------------------------------------------------------------------

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
    const verificacao = await verifyPasswordDetailed(password, row.senha_hash);
    if (verificacao.ok) {
      await registerLoginSuccess(req);
      const user = toAuthUser(row);
      await store.touchLogin(user.id);

      // Migração gradual: hash bcrypt válido → regrava em Argon2id (transparente).
      if (verificacao.rehash || !hashAtualizado(row.senha_hash)) {
        try {
          await store.update((await import('./resources')).RESOURCES.usuarios, user.id, { senha_hash: await hashPassword(password) });
          await store
            .audit({
              usuario_id: user.id,
              usuario: user.name,
              acao: 'senha',
              recurso: 'usuarios',
              registro_id: user.id,
              descricao: 'Hash da senha migrado para Argon2id no login (migração gradual)',
              dados: { de: verificacao.rehash ? 'bcrypt' : 'argon2id-parametros-antigos', para: 'argon2id' },
            })
            .catch(() => undefined);
        } catch (e: any) {
          console.warn('⚠️  Não foi possível migrar o hash para Argon2id agora:', e?.message || e);
        }
      }

      // MFA: obrigatório para administradores (cadastro na 1ª vez, desafio depois);
      // opcional para demais perfis que ativarem por conta própria.
      const temMfaAtivado = !!row.mfa_ativado_em && !!row.mfa_secret;
      const adminSemMfa = user.perfil === 'admin' && !temMfaAtivado;
      if (temMfaAtivado || adminSemMfa) {
        const lembrar = req.body?.lembrar === true;
        if (!row.mfa_secret) {
          // Prepara o segredo pendente (cifrado) para o cadastro guiado.
          await prepararDesafio(row, async (segredo) => {
            await store.update((await import('./resources')).RESOURCES.usuarios, user.id, { mfa_secret: cifrarSegredoMfa(segredo) });
          });
        }
        return res.json({
          ...(temMfaAtivado ? { mfa_required: true } : { mfa_setup_required: true }),
          mfa_ticket: signMfaTicket(user, lembrar),
          user: { id: user.id, name: user.name, email: user.email, perfil: user.perfil },
        });
      }

      return emitirSessao(req, res, row, user, req.body?.lembrar === true);
    }
    return loginFailed(req, res, row);
  }

  // Acesso de emergência: banco indisponível e credenciais do administrador
  // configuradas nas variáveis de ambiente (sessão de 1 h, sem MFA — o banco
  // está fora; token carrega id 0 e não permite ações de escrita sensíveis).
  if (lookupFailed && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const user: AuthUser = { id: 0, name: 'Administrador', email, perfil: 'admin' };
    console.warn('⚠️  Login de emergência do administrador (banco indisponível).');
    return res.json({ token: signToken(user, { expiresIn: '1h' }), user });
  }

  return loginFailed(req, res, null);
}

/** Cria a sessão (registro + JTI no JWT), audita e responde. */
async function emitirSessao(req: Request, res: Response, row: Row, user: AuthUser, lembrar: boolean) {
  const sid = await abrirSessao({ usuarioId: user.id, lembrar, req });
  const token = signToken(user, { ver: Number(row.token_versao || 0), sid, lembrar, expiresIn: lembrar ? '30d' : undefined });
  await getStore()
    .audit({
      usuario_id: user.id,
      usuario: user.name,
      acao: 'login',
      recurso: null,
      registro_id: null,
      descricao: `Login concluído de ${user.email} (${clientIp(req) || 'ip desconhecido'})${lembrar ? ' com "Lembrar-me" (30 dias)' : ''}`,
      dados: { sessao: sid.slice(0, 8) },
    })
    .catch(() => undefined);
  return res.json({ token, user: { ...user, lembrar } });
}

/** POST /api/auth/login/mfa — { mfa_ticket, codigo } conclui o login com TOTP. */
export async function loginMFA(req: Request, res: Response) {
  const ticket = String(req.body?.mfa_ticket ?? '');
  const codigo = String(req.body?.codigo ?? '');
  const payload = lerMfaTicket(ticket);
  if (!payload) throw new HttpError(401, 'Sessão de verificação expirada. Entre novamente.');
  const ip = clientIp(req);
  const chaveMfa = `${payload.id}|${ip}`;
  await exigirRateLimit('mfa', chaveMfa);

  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(payload.id) });
  if (!row || row.ativo === false) return res.status(401).json({ error: 'Usuário desativado ou removido.' });

  const { decifrarSegredoMfa } = await import('./mfa');
  const { verificarTOTP } = await import('./totp');
  const segredo = decifrarSegredoMfa(row.mfa_secret);
  if (!segredo) return res.status(400).json({ error: 'Não há MFA pendente para este usuário.' });

  if (!verificarTOTP(segredo, codigo)) {
    const restantes = await registrarFalha('mfa', chaveMfa);
    await store
      .audit({
        usuario_id: Number(row.id),
        usuario: String(row.nome || row.email),
        acao: 'login',
        recurso: null,
        registro_id: null,
        descricao: `Código MFA inválido para ${String(row.email)} (${ip || 'ip desconhecido'})`,
      })
      .catch(() => undefined);
    const dica = restantes > 0 && restantes <= 2 ? ` Restam ${restantes} tentativa${restantes === 1 ? '' : 's'}.` : '';
    return res.status(401).json({ error: `Código MFA inválido.${dica}` });
  }
  await registrarSucesso('mfa', chaveMfa);

  // Primeiro login de administrador: o código correto confirma o app autenticador.
  if (!row.mfa_ativado_em) {
    await store.update(RESOURCES.usuarios, Number(row.id), { mfa_ativado_em: new Date().toISOString() });
    await store
      .audit({
        usuario_id: Number(row.id),
        usuario: String(row.nome || row.email),
        acao: 'mfa',
        recurso: 'usuarios',
        registro_id: Number(row.id),
        descricao: `MFA (TOTP) ativado no primeiro login de ${String(row.email)}`,
      })
      .catch(() => undefined);
  }

  const user = toAuthUser(row);
  return emitirSessao(req, res, row, user, payload.lembrar === true);
}

/** POST /api/auth/mfa/desafio — { mfa_ticket } devolve QR + segredo do cadastro. */
export async function mfaDesafio(req: Request, res: Response) {
  const payload = lerMfaTicket(String(req.body?.mfa_ticket ?? ''));
  if (!payload) throw new HttpError(401, 'Sessão de verificação expirada. Entre novamente.');
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(payload.id) });
  if (!row || row.ativo === false) throw new HttpError(401, 'Usuário desativado ou removido.');
  if (row.mfa_ativado_em) throw new HttpError(400, 'MFA já está ativado para este usuário. Apenas o código é necessário.');
  const dados = await prepararDesafio(row, async (segredo) => {
    await store.update(RESOURCES.usuarios, Number(row.id), { mfa_secret: cifrarSegredoMfa(segredo) });
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(dados);
}

/** Resposta padrão de falha de login: conta a tentativa e registra bloqueio na auditoria. */
async function loginFailed(req: Request, res: Response, row: Row | null) {
  const left = await registerLoginFailure(req);
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

// ----------------------------------------------------------------------------
// Reautenticação (step-up): confirma a senha para ações sensíveis por 5 min.
// ----------------------------------------------------------------------------
const reautenticados = new Map<number, number>();

export function exigirReautenticacao(req: Request): void {
  const u = currentUser(req);
  const ate = reautenticados.get(u.id) || 0;
  if (Date.now() > ate) {
    throw new HttpError(403, 'Reautenticação necessária: confirme sua senha para executar esta ação.', undefined, 'reauth_necessaria');
  }
}

export function limparReautenticacao(id: number): void {
  reautenticados.delete(id);
}

/** POST /api/auth/reautenticar — { senha } libera ações sensíveis por 5 min. */
export async function reautenticar(req: Request, res: Response) {
  const u = currentUser(req);
  const senha = String(req.body?.senha ?? '');
  if (!senha) throw new HttpError(400, 'Informe sua senha para confirmar.');
  let ok = false;
  if (u.id <= 0) {
    ok = senha === ADMIN_PASSWORD;
  } else {
    const store = getStore();
    const { RESOURCES } = await import('./resources');
    const row = await store.findOneWhere(RESOURCES.usuarios, { id: u.id });
    ok = !!(row && (await verifyPassword(senha, row.senha_hash)));
  }
  if (!ok) {
    await registrarFalha('reauth', `${clientIp(req)}|${u.id}`);
    await getStore()
      .audit({
        usuario_id: u.id || null,
        usuario: u.name,
        acao: 'seguranca',
        recurso: 'usuarios',
        registro_id: u.id || null,
        descricao: `Reautenticação FALHOU (senha incorreta) — ${u.email} (${clientIp(req) || 'ip desconhecido'})`,
      })
      .catch(() => undefined);
    throw new HttpError(401, 'Senha incorreta.', { senha: 'Senha incorreta' });
  }
  await registrarSucesso('reauth', `${clientIp(req)}|${u.id}`);
  const validoAte = Date.now() + REAUTH_TTL_MS;
  reautenticados.set(u.id, validoAte);
  await getStore()
    .audit({
      usuario_id: u.id || null,
      usuario: u.name,
      acao: 'seguranca',
      recurso: 'usuarios',
      registro_id: u.id || null,
      descricao: `Reautenticação confirmada — ações sensíveis liberadas por ${Math.round(REAUTH_TTL_MS / 60_000)} min`,
    })
    .catch(() => undefined);
  res.json({ ok: true, valido_ate: new Date(validoAte).toISOString(), ttl_segundos: Math.round(REAUTH_TTL_MS / 1000) });
}

// ----------------------------------------------------------------------------
// Sessões / logout
// ----------------------------------------------------------------------------

export function sidAtual(req: Request): string | undefined {
  return (req as any).sid as string | undefined;
}

/** POST /api/auth/logout — encerra a sessão atual (o token morre na hora). */
export async function logout(req: Request, res: Response) {
  const u = currentUser(req);
  const sid = sidAtual(req);
  if (u.id > 0 && sid) await revogarUma(sid);
  invalidateUserCache(u.id); // exige revalidação no próximo pedido (sem janela de 30 s)
  limparReautenticacao(u.id);
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
  await revogarTodas(u.id);
  await store.update(RESOURCES.usuarios, u.id, { token_versao: novo });
  await store.audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'seguranca',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} encerrou a sessão em todos os dispositivos`,
    dados: { token_versao: novo },
  });
  invalidateUserCache(u.id);
  limparReautenticacao(u.id);
  res.json({ ok: true });
}

/** GET /api/auth/sessoes — sessões ativas do usuário logado. */
export async function listarSessoes(req: Request, res: Response) {
  const u = currentUser(req);
  if (u.id <= 0) return res.json({ sessoes: [] });
  const atual = sidAtual(req);
  const sessoes = await listarAtivas(u.id);
  res.json({
    sessoes: sessoes.map((s) => ({
      sid: s.id,
      atual: s.id === atual,
      criada_em: s.criada_em,
      expira_em: s.expira_em,
      ip: s.ip,
      user_agent: s.user_agent,
    })),
  });
}

/** POST /api/auth/sessoes/:sid/revogar — derruba um dispositivo específico. */
export async function revogarSessaoHandler(req: Request, res: Response) {
  const u = currentUser(req);
  const sid = String(req.params.sid || '');
  const store = getStore();
  const sessao = await store.getSessao(sid);
  if (!sessao || Number(sessao.usuario_id) !== Number(u.id)) throw new HttpError(404, 'Sessão não encontrada.');
  await revogarUma(sid);
  invalidateUserCache(u.id);
  await store
    .audit({
      usuario_id: u.id,
      usuario: u.name,
      acao: 'seguranca',
      recurso: 'usuarios',
      registro_id: u.id,
      descricao: `${u.name} revogou uma sessão (${sessao.ip || 'ip desconhecido'})`,
      dados: { sessao: sid.slice(0, 8) },
    })
    .catch(() => undefined);
  res.json({ ok: true });
}

// Cache curto para não consultar o usuário no banco a cada requisição,
// mas ainda derrubar rapidamente quem for desativado.
const userCache = new Map<number, { user: AuthUser; sid?: string; at: number }>();
const USER_CACHE_MS = 30_000;

export function invalidateUserCache(id?: number) {
  if (id === undefined) userCache.clear();
  else userCache.delete(id);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken((req.headers.authorization as string) || '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });

  let payload: AuthUser & { ver?: number; sid?: string; typ?: string };
  const verificado = verifyToken(token);
  if (!verificado) {
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
  payload = verificado as AuthUser & { ver?: number; sid?: string; typ?: string };
  // Tickets de MFA não são tokens de acesso.
  if (payload.typ && payload.typ !== 'access') {
    return res.status(401).json({ error: 'Token inválido. Entre novamente.' });
  }

  // Revalida o usuário (ativo? perfil mudou? sessão revogada?) — exceto o
  // acesso de emergência (id 0).
  if (payload.id > 0) {
    if (!payload.sid) {
      // Tokens emitidos antes das sessões (deploy anterior) não são mais aceitos.
      return res.status(401).json({ error: 'Sessão inválida. Entre novamente.' });
    }
    const cached = userCache.get(payload.id);
    if (cached && Date.now() - cached.at < USER_CACHE_MS && cached.sid === payload.sid) {
      // Mantém o sid DO TOKEN (o AuthUser em cache não o carrega).
      payload = { ...cached.user, sid: cached.sid } as typeof payload;
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
        // Sessão específica: revogada (logout/troca de senha) ou expirada → 401.
        const sessao = await store.getSessao(String(payload.sid));
        if (!sessao || sessao.revogada_em || new Date(sessao.expira_em).getTime() < Date.now()) {
          userCache.delete(payload.id);
          return res.status(401).json({ error: 'Sessão encerrada. Entre novamente.' });
        }
        const user = toAuthUser(row);
        userCache.set(payload.id, { user, sid: String(payload.sid), at: Date.now() });
        payload = { ...user, sid: payload.sid } as typeof payload;
      } catch {
        // banco indisponível: segue com os dados do token
      }
    }
  }

  (req as any).user = payload;
  (req as any).sid = payload.sid;
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

/** Troca de senha do próprio usuário (exige a senha atual; derruba as OUTRAS sessões). */
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
  await store.update(RESOURCES.usuarios, u.id, {
    senha_hash: novaHash,
    trocar_senha: false,
    senha_provisoria: false,
    senha_definida_em: new Date().toISOString(),
  });
  // Invalida o acesso dos OUTROS dispositivos; a sessão atual continua válida.
  const outras = await revogarTodas(u.id, sidAtual(req));
  invalidateUserCache(u.id);
  limparReautenticacao(u.id);
  await store.audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} trocou a própria senha${outras ? ` — ${outras} sessão(ões) de outros dispositivos encerrada(s)` : ''}`,
  });
  invalidateUserCache(u.id);
  res.json({ ok: true, sessoes_encerradas: outras });
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
        const expira = new Date(Date.now() + RESET_TTL_MIN * 60_000).toISOString();
        await store.update(RESOURCES.usuarios, Number(row.id), { reset_token_hash: hashResetToken(token), reset_expira_em: expira });
        await store
          .audit({
            usuario_id: Number(row.id),
            usuario: row.nome || email,
            acao: 'senha',
            recurso: 'usuarios',
            registro_id: Number(row.id),
            descricao: `Solicitação de redefinição de senha para ${email}`,
          })
          .catch(() => undefined);
        const base = (process.env.APP_URL || '').replace(/\/+$/, '');
        const link = `${base || ''}/redefinir/${token}`;
        await enviarEmail({
          to: email,
          assunto: 'BROBOND ERP — redefinição de senha',
          html: `Olá! Recebemos um pedido para redefinir a senha do seu acesso ao BROBOND ERP.<br/><br/>Abra o link abaixo (válido por ${RESET_TTL_MIN} minutos):<br/><a href="${link}">${link}</a><br/><br/>Se você não pediu esta troca, ignore este e-mail.`,
        });
      }
    }
  } catch (e: any) {
    console.warn('⚠️  Falha ao processar "esqueci minha senha":', e?.message || e);
  }
  // Resposta idêntica existindo ou não o e-mail (evita descoberta de contas).
  res.json({ ok: true });
}

/** POST /api/auth/reset — { token, senha } redefine, derruba TODAS as sessões e limpa convites. */
export async function resetPassword(req: Request, res: Response) {
  const token = String(req.body?.token ?? '').trim();
  const senha = String(req.body?.senha ?? '');
  if (!token || !senha) throw new HttpError(400, 'Envie o token e a nova senha.');
  const ip = clientIp(req);
  await exigirRateLimit('reset', ip);
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const hash = hashResetToken(token);
  const row = await store.findOneWhere(RESOURCES.usuarios, { reset_token_hash: hash });
  if (!row) {
    await registrarFalha('reset', ip);
    throw new HttpError(400, 'Link inválido ou já utilizado. Peça um novo link em "Esqueci minha senha".');
  }
  if (!row.reset_expira_em || new Date(String(row.reset_expira_em)).getTime() < Date.now()) {
    throw new HttpError(400, 'Este link expirou. Peça um novo em "Esqueci minha senha".');
  }
  const erro = validarSenhaNova(senha, row.email);
  if (erro) throw new HttpError(400, erro, { senha: erro });
  const novaHash = await hashPassword(senha);
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: novaHash,
    reset_token_hash: null,
    reset_expira_em: null,
    convite_token_hash: null,
    convite_expira_em: null,
    trocar_senha: false,
    senha_provisoria: false,
    senha_definida_em: new Date().toISOString(),
    token_versao: versao,
  });
  await revogarTodas(Number(row.id));
  await registrarSucesso('reset', ip);
  await store
    .audit({
      usuario_id: Number(row.id),
      usuario: row.nome || String(row.email),
      acao: 'senha',
      recurso: 'usuarios',
      registro_id: Number(row.id),
      descricao: `Senha redefinida via link de recuperação (${String(row.email)}) — todas as sessões encerradas`,
      dados: { metodo: 'reset' },
    })
    .catch(() => undefined);
  invalidateUserCache(Number(row.id));
  res.json({ ok: true });
}

/**
 * Migração de segurança: em produção, nenhum senha_hash pode ser texto puro
 * (versões antigas gravavam sem hash). Quem estiver assim tem o hash trocado
 * por um valor aleatório e é marcado com trocar_senha (precisa recuperar).
 * Hashes bcrypt válidos migram para Argon2id gradualmente, no login.
 */
export async function migrarSenhasLegadas(): Promise<number> {
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  try {
    const usuarios = await store.listUsuariosRaw();
    let migrados = 0;
    for (const u of usuarios) {
      const h = u.senha_hash ? String(u.senha_hash) : '';
      const bcryptValido = h.startsWith('$2a$') || h.startsWith('$2b$') || h.startsWith('$2y$');
      const argon2Valido = h.startsWith('$argon2id$');
      if (h && !bcryptValido && !argon2Valido) {
        await store.update(RESOURCES.usuarios, Number(u.id), {
          senha_hash: await hashPassword(randomBytes(12).toString('hex')),
          trocar_senha: true,
          token_versao: Number(u.token_versao || 0) + 1,
        });
        await store
          .audit({
            usuario_id: Number(u.id),
            usuario: u.nome || String(u.email),
            acao: 'senha',
            recurso: 'usuarios',
            registro_id: Number(u.id),
            descricao: `Senha legada (texto puro) invalidada — recuperação obrigatória via "Esqueci minha senha"`,
          })
          .catch(() => undefined);
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

/** GET /api/admin/auditoria/verificar — confere a cadeia de hashes (integridade). */
export async function verificarAuditoriaHandler(_req: Request, res: Response) {
  res.json(await getStore().verificarAuditoria());
}
