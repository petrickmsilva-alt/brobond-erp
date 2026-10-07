import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { limparToken } from './validate';
import { avisarOrigemIndefinida, linkPublicoAsync, urlAbsoluta } from './urlPublica';
import { getStore } from './services';
import type { Row } from './store';
import { loginBucketKey, registerLoginFailure, registerLoginSuccess, registrarFalha, registrarSucesso, exigirRateLimit } from './security';
import { validarPoliticaSenha } from './services';
import { hashPassword, verifyPassword, verifyPasswordDetailed, hashAtualizado } from './password';
import { abrirSessao, revogarTodas, revogarUma, listSessoesAtivas as listarAtivas } from './sessoes';
import { decifrarSegredoMfa, prepararDesafio, signMfaTicket, lerMfaTicket, cifrarSegredoMfa } from './mfa';
import { EMPRESA_PADRAO, empresasDoUsuario } from './empresasAcesso';

export { hashPassword, verifyPassword };

const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET não definido — usando valor padrão (NÃO use em produção).');
}
const TOKEN_TTL = process.env.JWT_TTL || '8h';
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@brobond.com.br').trim().toLowerCase();
export const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'brobond123').trim();
const RESET_TTL_MIN = Number(process.env.RESET_TTL_MINUTES) || 60;
export const REAUTH_TTL_MS = Number(process.env.REAUTH_TTL_MS) || 5 * 60_000;
// Bloqueio por usuário (além do rate limit por IP+e-mail): N senhas erradas
// seguidas bloqueiam a CONTA por alguns minutos — trava força-bruta distribuída.
export const USER_LOCK_MAX = Number(process.env.USER_LOCK_MAX_ATTEMPTS) || 5;
export const USER_LOCK_MIN = Number(process.env.USER_LOCK_MINUTES) || 15;

/** true quando a conta está bloqueada: manual (admin, sem prazo) ou temporário vigente. */
export function contaBloqueada(row: Row): boolean {
  if (!row) return false;
  if (row.bloqueio_manual === true) return true;
  return !!row.bloqueado_ate && new Date(String(row.bloqueado_ate)).getTime() > Date.now();
}

/** Mensagem de veto conforme o tipo de bloqueio (manual mostra o motivo). */
export function mensagemBloqueio(row: Row): string {
  if (row?.bloqueio_manual === true) {
    const motivo = String(row.motivo_bloqueio || '').trim();
    return motivo
      ? `Acesso bloqueado pelo administrador: ${motivo}`
      : 'Acesso bloqueado pelo administrador. Fale com o administrador para liberar.';
  }
  return `Acesso bloqueado temporariamente por excesso de tentativas incorretas. Tente novamente em ${minutosDeBloqueio(row)} minuto(s) ou fale com o administrador.`;
}

/** true quando o acesso temporário já venceu (acesso_expira_em no passado). */
export function acessoExpirado(row: Row): boolean {
  return !!row?.acesso_expira_em && new Date(String(row.acesso_expira_em)).getTime() < Date.now();
}

/** Minutos restantes de bloqueio (para a mensagem de erro). */
function minutosDeBloqueio(row: Row): number {
  const ms = new Date(String(row.bloqueado_ate)).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 60_000));
}

export type Perfil = 'admin' | 'gerente' | 'operador';
export type AuthUser = {
  id: number;
  name: string;
  email: string;
  perfil: Perfil;
  trocar_senha?: boolean;
  perm_catalogos?: string;
  perm_compartilhar?: string;
  perm_metricas?: string;
  perm_politicas?: string;
  perm_aprovar?: string;
  desconto_max_pct?: number | null;
  venda_sem_aprovacao_ate?: number | null;
  // ---- MULTIEMPRESA (ver empresa.ts) ----
  /** Empresa padrão do usuário (coluna `usuarios.empresa_id`). */
  empresa_id?: number;
  /** Permissão explícita de ver o grupo consolidado. */
  pode_consolidar?: boolean;
  /** Empresas concedidas (tabela `usuario_empresas`). */
  empresas?: number[];
  /** Empresa escolhida no seletor — vive na SESSÃO (claim `emp` do JWT). */
  empresa_sessao?: number | null;
  /** Pedido explícito de leitura consolidada nesta requisição. */
  consolidar?: boolean;
};

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
  // MULTIEMPRESA: a empresa padrão e a permissão de consolidar vêm SEMPRE da
  // linha do usuário no banco — revalidadas a cada requisição pelo requireAuth.
  user.empresa_id = Number(row.empresa_id) > 0 ? Number(row.empresa_id) : EMPRESA_PADRAO;
  user.pode_consolidar = row.pode_consolidar === true;
  if (row.trocar_senha === true) user.trocar_senha = true;
  for (const k of ['perm_catalogos','perm_compartilhar','perm_metricas','perm_politicas','perm_aprovar'] as const) user[k] = String(row[k] || 'herdar');
  user.desconto_max_pct = row.desconto_max_pct == null ? null : Number(row.desconto_max_pct);
  user.venda_sem_aprovacao_ate = row.venda_sem_aprovacao_ate == null ? null : Number(row.venda_sem_aprovacao_ate);
  return user;
}

export type SignOpts = {
  ver?: number;
  sid?: string;
  typ?: 'access' | 'mfa';
  lembrar?: boolean;
  expiresIn?: string | number;
  /** MULTIEMPRESA: empresa escolhida no seletor — persiste na SESSÃO. */
  emp?: number | null;
};

export function signToken(user: AuthUser, opts: SignOpts = {}): string {
  const payload: Record<string, unknown> = { ...user, typ: opts.typ || 'access' };
  // O claim `emp` é a única coisa que o token diz sobre empresa. Tudo mais
  // (empresa padrão, grants, permissão de consolidar) é relido do banco a cada
  // requisição, então revogar acesso a uma empresa tem efeito imediato.
  delete payload.empresas;
  delete payload.empresa_sessao;
  delete payload.consolidar;
  if (opts.emp !== undefined && opts.emp !== null) payload.emp = Number(opts.emp);
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
    if (contaBloqueada(row)) {
      return res.status(403).json({ error: mensagemBloqueio(row) });
    }
    if (acessoExpirado(row)) {
      return res.status(403).json({ error: 'Acesso expirado. Fale com o administrador para renovar.' });
    }
    const verificacao = await verifyPasswordDetailed(password, row.senha_hash);
    if (verificacao.ok) {
      await registerLoginSuccess(req);
      // Onda 4: senha vencida pela política vira troca obrigatória (antes do
      // MFA, para valer nos dois fluxos). O aviso vai na resposta.
      let senha_vence_em_dias: number | null = null;
      let senha_expirada = false;
      try {
        const { obterPolitica, vencimentoSenha } = await import('./politicaSenha');
        const venc = vencimentoSenha(row, await obterPolitica());
        senha_vence_em_dias = venc.venceEmDias;
        senha_expirada = venc.expirada;
        if (venc.expirada && !row.trocar_senha) {
          await store.update((await import('./resources')).RESOURCES.usuarios, Number(row.id), { trocar_senha: true });
          row.trocar_senha = true;
          await store
            .audit({
              usuario_id: Number(row.id),
              usuario: String(row.nome || row.email),
              acao: 'senha',
              recurso: 'usuarios',
              registro_id: Number(row.id),
              descricao: `Senha de ${String(row.email)} vencida pela política — troca obrigatória no acesso`,
            })
            .catch(() => undefined);
        }
      } catch {
        /* política indisponível: segue o login sem o aviso */
      }
      const user = toAuthUser(row);
      await store.touchLogin(user.id, clientIp(req) || null);
      // Limpa bloqueio vencido que tenha ficado para trás.
      if (row.bloqueado_ate) {
        try {
          await store.update((await import('./resources')).RESOURCES.usuarios, user.id, { bloqueado_ate: null, motivo_bloqueio: null });
        } catch { /* indiferente */ }
      }

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
          senha_vence_em_dias,
          senha_expirada,
        });
      }

      return emitirSessao(req, res, row, user, req.body?.lembrar === true, { senha_vence_em_dias, senha_expirada });
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
async function emitirSessao(req: Request, res: Response, row: Row, user: AuthUser, lembrar: boolean, extra: Record<string, unknown> = {}) {
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
  return res.json({ token, user: { ...user, lembrar }, ...extra });
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
  if (contaBloqueada(row)) return res.status(403).json({ error: mensagemBloqueio(row) });
  if (acessoExpirado(row)) return res.status(403).json({ error: 'Acesso expirado. Fale com o administrador para renovar.' });

  const { decifrarSegredoMfa } = await import('./mfa');
  const { verificarTOTP } = await import('./totp');
  const segredo = decifrarSegredoMfa(row.mfa_secret);
  if (!segredo) return res.status(400).json({ error: 'Não há MFA pendente para este usuário.' });

  // Código do app… ou código de recuperação (uso único, para quando o celular some).
  let restantesBackup: number | null = null;
  if (!verificarTOTP(segredo, codigo)) {
    const { lerRegistro, consumirCodigo, serializarRegistro } = await import('./mfaBackup');
    const consumido = consumirCodigo(lerRegistro(row.mfa_backup_hashes), codigo);
    if (!consumido) {
      const restantes = await registrarFalha('mfa', chaveMfa);
      await store
        .audit({
          usuario_id: Number(row.id),
          usuario: String(row.nome || row.email),
          acao: 'login_falha',
          recurso: null,
          registro_id: null,
          descricao: `Código MFA inválido para ${String(row.email)} (${ip || 'ip desconhecido'})`,
        })
        .catch(() => undefined);
      const dica = restantes > 0 && restantes <= 2 ? ` Restam ${restantes} tentativa${restantes === 1 ? '' : 's'}.` : '';
      return res.status(401).json({ error: `Código MFA inválido.${dica}` });
    }
    await store.update(RESOURCES.usuarios, Number(row.id), { mfa_backup_hashes: serializarRegistro(consumido.registro) });
    restantesBackup = consumido.restantes;
    await store
      .audit({
        usuario_id: Number(row.id),
        usuario: String(row.nome || row.email),
        acao: 'mfa',
        recurso: 'usuarios',
        registro_id: Number(row.id),
        descricao: `Login de ${String(row.email)} concluído com CÓDIGO DE RECUPERAÇÃO (restam ${consumido.restantes})`,
        dados: { via: 'codigo_recuperacao', restantes: consumido.restantes },
      })
      .catch(() => undefined);
  }
  await registrarSucesso('mfa', chaveMfa);

  // Primeiro login de administrador: o código correto confirma o app autenticador
  // e emite os códigos de recuperação (exibição única, junto na resposta).
  let codigosNovos: string[] | undefined;
  if (!row.mfa_ativado_em) {
    const { gerarLoteCodigos, serializarRegistro } = await import('./mfaBackup');
    const lote = gerarLoteCodigos();
    codigosNovos = lote.codigos;
    await store.update(RESOURCES.usuarios, Number(row.id), {
      mfa_ativado_em: new Date().toISOString(),
      mfa_backup_hashes: serializarRegistro(lote.registro),
    });
    await store
      .audit({
        usuario_id: Number(row.id),
        usuario: String(row.nome || row.email),
        acao: 'mfa',
        recurso: 'usuarios',
        registro_id: Number(row.id),
        descricao: `MFA (TOTP) ativado no primeiro login de ${String(row.email)} — ${lote.codigos.length} códigos de recuperação emitidos`,
      })
      .catch(() => undefined);
  }

  const user = toAuthUser(row);
  let avisoMfa: Record<string, unknown> = {};
  try {
    const { obterPolitica, vencimentoSenha } = await import('./politicaSenha');
    const venc = vencimentoSenha(row, await obterPolitica());
    avisoMfa = { senha_vence_em_dias: venc.venceEmDias, senha_expirada: venc.expirada };
  } catch {
    /* indiferente */
  }
  return emitirSessao(req, res, row, user, payload.lembrar === true, {
    ...(codigosNovos ? { mfa_backup_codigos: codigosNovos } : {}),
    ...(restantesBackup !== null ? { mfa_backup_restantes: restantesBackup } : {}),
    ...avisoMfa,
  });
}

/** POST /api/auth/mfa/desafio — { mfa_ticket } devolve QR + segredo do cadastro. */
export async function mfaDesafio(req: Request, res: Response) {
  const payload = lerMfaTicket(String(req.body?.mfa_ticket ?? ''));
  if (!payload) throw new HttpError(401, 'Sessão de verificação expirada. Entre novamente.');
  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(payload.id) });
  if (!row || row.ativo === false) throw new HttpError(401, 'Usuário desativado ou removido.');
  if (contaBloqueada(row)) throw new HttpError(403, mensagemBloqueio(row));
  if (acessoExpirado(row)) throw new HttpError(403, 'Acesso expirado. Fale com o administrador para renovar.');
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
  // Contador POR USUÁRIO: N falhas seguidas bloqueiam a conta por alguns minutos.
  if (row) await registrarFalhaUsuario(row, clientIp(req));
  if (left === 0) {
    await getStore()
      .audit({
        usuario_id: row ? Number(row.id) : null,
        usuario: row?.nome || normalizeEmail(req.body?.email) || null,
        acao: 'login_falha',
        recurso: null,
        registro_id: null,
        descricao: `Login BLOQUEADO temporariamente por excesso de tentativas — ${normalizeEmail(req.body?.email)} (${clientIp(req) || 'ip desconhecido'})`,
      })
      .catch(() => undefined);
  } else if (row) {
    // Trilha de tentativas (alimenta o gráfico de segurança do módulo Usuários;
    // a senha jamais é registrada). E-mails inexistentes não geram trilha.
    await getStore()
      .audit({
        usuario_id: Number(row.id),
        usuario: String(row.nome || row.email),
        acao: 'login_falha',
        recurso: null,
        registro_id: null,
        descricao: `Senha incorreta para ${String(row.email)} (${clientIp(req) || 'ip desconhecido'})`,
      })
      .catch(() => undefined);
  }
  const hint = left > 0 && left <= 2 ? ` Restam ${left} tentativa${left === 1 ? '' : 's'}.` : '';
  return res.status(401).json({ error: `E-mail ou senha incorretos.${hint}` });
}

/**
 * Incrementa as falhas consecutivas do usuário; ao atingir USER_LOCK_MAX,
 * bloqueia a conta por USER_LOCK_MIN minutos e registra na trilha.
 */
async function registrarFalhaUsuario(row: Row, ip: string): Promise<void> {
  try {
    const store = getStore();
    const { RESOURCES } = await import('./resources');
    const falhas = Number(row.tentativas_falhas || 0) + 1;
    const patch: Record<string, unknown> = { tentativas_falhas: falhas, ultimo_falha_em: new Date().toISOString(), ultimo_ip: ip || null };
    if (falhas >= USER_LOCK_MAX) {
      patch.bloqueado_ate = new Date(Date.now() + USER_LOCK_MIN * 60_000).toISOString();
      patch.motivo_bloqueio = `Bloqueio automático: ${falhas} tentativas incorretas seguidas`;
    }
    await store.update(RESOURCES.usuarios, Number(row.id), patch);
    if (falhas >= USER_LOCK_MAX) {
      await store
        .audit({
          usuario_id: Number(row.id),
          usuario: String(row.nome || row.email),
          acao: 'bloqueio',
          recurso: 'usuarios',
          registro_id: Number(row.id),
          descricao: `Acesso de ${String(row.email)} BLOQUEADO automaticamente por ${USER_LOCK_MIN} min (${falhas} senhas incorretas seguidas — ${ip || 'ip desconhecido'})`,
          dados: { tentativas: falhas, ip },
        })
        .catch(() => undefined);
    }
  } catch {
    // Falha ao gravar o contador não pode quebrar o fluxo de login.
  }
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

/**
 * Abre (ou renova) a janela de reautenticação do usuário. Devolve o instante
 * em que ela expira. É o único ponto que escreve no mapa — usado pelo
 * `POST /api/auth/reautenticar` e pelos testes das rotas sensíveis.
 */
export function registrarReautenticacao(id: number, ttlMs: number = REAUTH_TTL_MS): number {
  const validoAte = Date.now() + ttlMs;
  reautenticados.set(id, validoAte);
  return validoAte;
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
  const validoAte = registrarReautenticacao(u.id);
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
        // Bloqueio temporário e expiração derrubam a sessão ativa em até 30 s.
        if (contaBloqueada(row)) {
          userCache.delete(payload.id);
          return res.status(401).json({ error: `${mensagemBloqueio(row)} Sessão encerrada.` });
        }
        if (acessoExpirado(row)) {
          userCache.delete(payload.id);
          return res.status(401).json({ error: 'Acesso expirado. Fale com o administrador para renovar.' });
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

  // ------------------------------------------------------------------
  // MULTIEMPRESA: resolve a empresa ATIVA da requisição.
  //
  //   • `empresa_id` e `pode_consolidar` vêm da linha do usuário (acima);
  //   • `empresas` são as concessões vigentes — relidas do banco, para que
  //     revogar um acesso derrube o seletor em segundos;
  //   • o claim `emp` do token é o seletor de empresa da SESSÃO e só vence se
  //     estiver entre as concessões;
  //   • consolidar é opt-in por requisição (`?consolidado=1`) E exige a
  //     permissão explícita — nunca é o padrão silencioso.
  // ------------------------------------------------------------------
  const empClaim = Number((verificado as Record<string, unknown>).emp);
  payload.empresas = await empresasDoUsuario(payload.id, payload.empresa_id);
  payload.empresa_sessao = empClaim > 0 && payload.empresas.includes(empClaim) ? empClaim : null;
  const pedidoConsolidado = String(req.query?.consolidado ?? req.headers['x-empresa-consolidado'] ?? '');
  payload.consolidar = ['1', 'true', 'sim'].includes(pedidoConsolidado.toLowerCase());

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

export async function me(req: Request, res: Response) {
  // Enriquecido (best-effort, nunca lança — a rota não passa pelo wrap):
  // aviso de vencimento da senha para o usuário se antecipar.
  const user = currentUser(req);
  const extra: Record<string, unknown> = {};
  try {
    if (user.id > 0) {
      const { RESOURCES } = await import('./resources');
      const row = await getStore().findOneWhere(RESOURCES.usuarios, { id: user.id });
      if (row) {
        const { obterPolitica, vencimentoSenha } = await import('./politicaSenha');
        const venc = vencimentoSenha(row, await obterPolitica());
        extra.senha_expira_em = venc.expiraEm;
        extra.senha_vence_em_dias = venc.venceEmDias;
        extra.senha_expirada = venc.expirada;
      }
    }
  } catch {
    /* indiferente */
  }
  res.json({ user, ...extra });
}

/** Troca de senha do próprio usuário (exige a senha atual; derruba as OUTRAS sessões). */
export async function changePassword(req: Request, res: Response) {
  const u = currentUser(req);
  const atual = String(req.body?.senha_atual ?? '');
  const nova = String(req.body?.senha_nova ?? '');
  if (u.id <= 0) throw new HttpError(400, 'O acesso de emergência não permite trocar a senha por aqui.');

  const store = getStore();
  const { RESOURCES } = await import('./resources');
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: u.id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  // Política configurável + histórico (a nova senha não pode repetir as últimas).
  const { validarSenhaUsuario, obterPolitica, empurrarHistorico } = await import('./politicaSenha');
  const erro = await validarSenhaUsuario(nova, { email: u.email, historico: row.senha_historico, hashAtual: String(row.senha_hash || '') }, true);
  if (erro) throw new HttpError(400, erro, { senha_nova: erro });
  if (!(await verifyPassword(atual, row.senha_hash))) {
    throw new HttpError(400, 'Senha atual incorreta.', { senha_atual: 'Senha incorreta' });
  }
  const novaHash = await hashPassword(nova);
  await store.update(RESOURCES.usuarios, u.id, {
    senha_hash: novaHash,
    senha_historico: empurrarHistorico(row.senha_historico, String(row.senha_hash || ''), await obterPolitica()),
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
  const { enviarEmail, corpoEmail, blocoLinkEmail } = await import('./mail');
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
        // Link SEMPRE absoluto: relativo ("/redefinir/…") o cliente de e-mail
        // não resolve e a pessoa vê "URL inválida". Ver server/src/urlPublica.ts.
        const link = await linkPublicoAsync(`redefinir/${token}`, req);
        if (!urlAbsoluta(link)) avisarOrigemIndefinida('redefinição de senha');
        await enviarEmail({
          to: email,
          assunto: 'BROBOND ERP — redefinição de senha',
          html: corpoEmail([
            `<p>Recebemos um pedido para redefinir a senha do seu acesso ao BROBOND ERP.</p>`,
            `<p>Abra o link abaixo para escolher uma nova senha. Ele vale por <strong>${RESET_TTL_MIN} minutos</strong> e só pode ser usado uma vez.</p>`,
            blocoLinkEmail(link, 'Redefinir minha senha'),
            `<p style="font-size:13px;color:#64748b;">Se você não pediu esta troca, ignore este e-mail — sua senha atual continua válida.</p>`,
          ]),
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
  // Idem convite: link colado no e-mail pode vir com "."/")" grudado no token.
  const token = limparToken(req.body?.token);
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
  const { validarSenhaUsuario, obterPolitica, empurrarHistorico } = await import('./politicaSenha');
  const erro = await validarSenhaUsuario(senha, { email: String(row.email), historico: row.senha_historico, hashAtual: String(row.senha_hash || '') }, true);
  if (erro) throw new HttpError(400, erro, { senha: erro });
  const novaHash = await hashPassword(senha);
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: novaHash,
    senha_historico: empurrarHistorico(row.senha_historico, String(row.senha_hash || ''), await obterPolitica()),
    reset_token_hash: null,
    reset_expira_em: null,
    convite_token_hash: null,
    convite_expira_em: null,
    trocar_senha: false,
    senha_provisoria: false,
    senha_definida_em: new Date().toISOString(),
    token_versao: versao,
    // Quem prova a identidade pelo e-mail desbloqueia a conta e zera as falhas.
    bloqueado_ate: null,
    motivo_bloqueio: null,
    tentativas_falhas: 0,
    ultimo_falha_em: null,
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
