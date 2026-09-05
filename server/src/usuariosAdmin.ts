// ============================================================
// Administração de usuários — fluxo profissional de acesso:
//   • Convite por token (e-mail): o usuário define a PRÓPRIA senha.
//   • Senha temporária gerada pelo servidor, exibida UMA única vez.
//   • Reset do MFA de um usuário (por administrador, com reautenticação).
//   • Nenhuma senha trafega em texto puro além da exibição única; nenhuma
//     senha é recuperável depois (hash Argon2id irreversível).
// ============================================================
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { currentUser, exigirReautenticacao, hashPassword, hashResetToken, gerarResetToken, validarSenhaNova, invalidateUserCache, clientIp } from './auth';
import { getStore } from './services';
import { RESOURCES } from './resources';
import { smtpConfigurado, enviarEmail } from './mail';
import { revogarTodas } from './sessoes';
import { exigirRateLimit, registrarFalha } from './security';

const CONVITE_TTL_HORAS = Number(process.env.INVITE_TTL_HOURS) || 48;

/** Gera uma senha temporária forte (sem caracteres ambíguos). */
export function gerarSenhaTemporaria(bytes = 12): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += alfabeto[b % alfabeto.length];
  // Garante as classes mínimas da política.
  if (!/[a-z]/.test(out)) out = 'a' + out.slice(1);
  if (!/[A-Z]/.test(out)) out = out.slice(0, -1) + 'K';
  if (!/\d/.test(out)) out = out.slice(0, -2) + '7' + out.slice(-1);
  return out;
}

/** Grava o convite (hash + expiração) e envia o e-mail. Devolve o link apenas sem SMTP (dev). */
export async function gerarConvite(row: Record<string, any>, actor: { id: number; name: string } | null, tx?: any): Promise<string | undefined> {
  const store = getStore();
  const token = gerarResetToken();
  const expira = new Date(Date.now() + CONVITE_TTL_HORAS * 3600_000).toISOString();
  await store.update(
    RESOURCES.usuarios,
    Number(row.id),
    { convite_token_hash: hashResetToken(token), convite_expira_em: expira, trocar_senha: true },
    tx
  );
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const link = `${base}/convite/${token}`;
  await enviarEmail({
    to: String(row.email),
    assunto: 'BROBOND ERP — convite de acesso',
    html: `Olá ${String(row.nome || '')}! Você foi convidado(a) para acessar o BROBOND ERP.<br/><br/>Abra o link abaixo (válido por ${CONVITE_TTL_HORAS} horas) para definir a sua senha:<br/><a href="${link}">${link}</a><br/><br/>Se você não esperava este convite, ignore este e-mail.`,
  });
  await store
    .audit({
      usuario_id: actor?.id || null,
      usuario: actor?.name || 'sistema',
      acao: 'convite',
      recurso: 'usuarios',
      registro_id: Number(row.id),
      descricao: `Convite de acesso enviado para ${String(row.email)} (válido por ${CONVITE_TTL_HORAS} h)`,
    })
    .catch(() => undefined);
  return smtpConfigurado() ? undefined : link;
}

/** GET /api/convites/:token — valida o convite (dados mínimos para a tela). */
export async function infoConvite(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { convite_token_hash: hashResetToken(token) });
  if (!row || row.ativo === false) return res.status(404).json({ error: 'Convite inválido. Peça um novo convite ao administrador.' });
  const expirado = !row.convite_expira_em || new Date(String(row.convite_expira_em)).getTime() < Date.now();
  res.json({ nome: String(row.nome || ''), email: String(row.email), expirado });
}

/** POST /api/convites/aceitar — { token, senha }: o usuário define a própria senha. */
export async function aceitarConvite(req: Request, res: Response) {
  const token = String(req.body?.token ?? '').trim();
  const senha = String(req.body?.senha ?? '');
  if (!token || !senha) throw new HttpError(400, 'Envie o token do convite e a nova senha.');
  const ip = clientIp(req);
  await exigirRateLimit('convite', ip);
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { convite_token_hash: hashResetToken(token) });
  if (!row || row.ativo === false) {
    await registrarFalha('convite', ip);
    throw new HttpError(400, 'Convite inválido ou já utilizado. Peça um novo convite ao administrador.');
  }
  if (!row.convite_expira_em || new Date(String(row.convite_expira_em)).getTime() < Date.now()) {
    throw new HttpError(400, 'Este convite expirou. Peça um novo convite ao administrador.');
  }
  const erro = validarSenhaNova(senha, String(row.email));
  if (erro) throw new HttpError(400, erro, { senha: erro });
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: await hashPassword(senha),
    convite_token_hash: null,
    convite_expira_em: null,
    trocar_senha: false,
    senha_provisoria: false,
    senha_definida_em: new Date().toISOString(),
    token_versao: versao,
  });
  await revogarTodas(Number(row.id));
  await store
    .audit({
      usuario_id: Number(row.id),
      usuario: String(row.nome || row.email),
      acao: 'convite',
      recurso: 'usuarios',
      registro_id: Number(row.id),
      descricao: `Convite aceito — ${String(row.email)} definiu a própria senha`,
      dados: { metodo: 'convite' },
    })
    .catch(() => undefined);
  invalidateUserCache(Number(row.id));
  res.json({ ok: true });
}

/** POST /api/usuarios/:id/reenviar-convite — novo token + e-mail (admin). */
export async function reenviarConvite(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores reenviam convites.');
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(req.params.id) });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (row.senha_hash) throw new HttpError(409, 'Este usuário já definiu a senha. Use "Gerar senha temporária" para redefinir o acesso.');
  const link = await gerarConvite(row, actor);
  res.json({ ok: true, ...(link ? { convite_link: link } : {}) });
}

/**
 * POST /api/usuarios/:id/senha-temporária — admin gera senha temporária.
 * Requer reautenticação recente. A senha aparece UMA única vez na resposta
 * (Cache-Control: no-store); o banco guarda apenas o hash Argon2id, e todas
 * as sessões anteriores do usuário são derrubadas.
 */
export async function senhaTemporaria(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores geram senhas temporárias.');
  exigirReautenticacao(req);
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(req.params.id) });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (row.ativo === false) throw new HttpError(409, 'Usuário desativado: reative-o antes de gerar uma senha temporária.');
  if (Number(row.id) === Number(actor.id)) throw new HttpError(400, 'Use "Trocar senha" nas Configurações para a sua própria senha.');

  const senha = gerarSenhaTemporaria();
  const versao = Number(row.token_versao || 0) + 1;
  await store.update(RESOURCES.usuarios, Number(row.id), {
    senha_hash: await hashPassword(senha),
    trocar_senha: true,
    senha_provisoria: true,
    senha_definida_em: new Date().toISOString(),
    convite_token_hash: null,
    convite_expira_em: null,
    token_versao: versao,
  });
  const sessoes = await revogarTodas(Number(row.id));
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'senha',
    recurso: 'usuarios',
    registro_id: Number(row.id),
    descricao: `Senha temporária gerada para ${String(row.email)} (exibição única)${sessoes ? ` — ${sessoes} sessão(ões) encerrada(s)` : ''}`,
    dados: { metodo: 'senha_temporaria', sessoes_encerradas: sessoes },
  });
  invalidateUserCache(Number(row.id));
  res.setHeader('Cache-Control', 'no-store');
  // Única exibição: a senha NÃO é armazenada em texto puro nem logada.
  res.json({ senha_temporaria: senha, trocar_senha: true, sessoes_encerradas: sessoes });
}

/** POST /api/usuarios/:id/resetar-mfa — admin limpa o MFA do usuário (reautenticação exigida). */
export async function resetarMfaUsuario(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores resetam o MFA.');
  exigirReautenticacao(req);
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { id: Number(req.params.id) });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  if (!row.mfa_ativado_em && !row.mfa_secret) throw new HttpError(400, 'Este usuário não possui MFA configurado.');
  await store.update(RESOURCES.usuarios, Number(row.id), { mfa_secret: null, mfa_ativado_em: null });
  const sessoes = await revogarTodas(Number(row.id));
  await store.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'mfa',
    recurso: 'usuarios',
    registro_id: Number(row.id),
    descricao: `MFA de ${String(row.email)} resetado por ${actor.name} (reautenticado) — o usuário refaz o cadastro no próximo login`,
    dados: { sessoes_encerradas: sessoes },
  });
  invalidateUserCache(Number(row.id));
  res.json({ ok: true });
}
