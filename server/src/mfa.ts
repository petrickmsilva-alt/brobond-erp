// ============================================================
// MFA/TOTP — gerenciamento por usuário.
//
//   • O segredo TOTP é gravado CIFRADO (AES-256-GCM) com chave derivada de
//     MFA_ENCRYPTION_KEY ou JWT_SECRET — nunca em texto puro no banco.
//   • Administradores são OBRIGADOS a ativar: o login deles só termina depois
//     do desafio TOTP (mfa_required) ou do cadastro (mfa_setup_required).
//   • Desativar exige reautenticação (senha recente) + código válido.
// ============================================================
import type { Request, Response } from 'express';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import QRCode from 'qrcode';
import { HttpError } from './errors';
import { empresaDoAtorAudit } from './empresa';
import { currentUser, signToken, verifyToken, type AuthUser } from './auth';
import { gerarSegredoTOTP, uriTOTP, verificarTOTP } from './totp';
import { getStore } from './services';
import { RESOURCES } from './resources';
import { revogarTodas } from './sessoes';
import { gerarLoteCodigos, lerRegistro, restantesRegistro, serializarRegistro } from './mfaBackup';

const TICKET_TTL = '10m';

function chaveMfa(): Buffer {
  const base = process.env.MFA_ENCRYPTION_KEY || process.env.JWT_SECRET || 'brobond-dev-secret';
  return scryptSync(base, 'brobond-mfa-v1', 32);
}

/** AES-256-GCM; formato versionado v1.iv.tag.ciphertext (base64url). */
export function cifrarSegredoMfa(segredo: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', chaveMfa(), iv);
  const encrypted = Buffer.concat([cipher.update(segredo, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decifrarSegredoMfa(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [version, iv, tag, encrypted] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', chaveMfa(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Tickets de MFA: JWT curto (10 min) provando que a SENHA já passou.
// Não dá acesso à API — só permite concluir o desafio TOTP.
// ------------------------------------------------------------------
export function signMfaTicket(user: AuthUser, lembrar: boolean): string {
  return signToken(user, { typ: 'mfa', expiresIn: TICKET_TTL, lembrar });
}

export function lerMfaTicket(token: string): (AuthUser & { lembrar?: boolean }) | null {
  const payload = verifyToken(token) as (AuthUser & { lembrar?: boolean; typ?: string }) | null;
  if (!payload || payload.typ !== 'mfa' || !payload.id) return null;
  return payload;
}

/** Gera (se preciso) e devolve o segredo pendente do usuário, mais QR e URI. */
export async function prepararDesafio(row: Record<string, any>, salvar: (segredo: string) => Promise<void>): Promise<{ segredo: string; uri: string; qr: string }> {
  let segredo = decifrarSegredoMfa(row.mfa_secret);
  if (!segredo) {
    segredo = gerarSegredoTOTP();
    await salvar(segredo);
  }
  const uri = uriTOTP(String(row.email), segredo);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  return { segredo, uri, qr };
}

export async function rowUsuario(id: number): Promise<Record<string, any>> {
  const store = getStore();
  const row = await store.findOneWhere(RESOURCES.usuarios, { id });
  if (!row) throw new HttpError(404, 'Usuário não encontrado.');
  return row;
}

export function sidAtual(req: Request): string | undefined {
  return (req as any).sid as string | undefined;
}

// ------------------------------------------------------------------
// Endpoints autenticados
// ------------------------------------------------------------------

/** GET /api/auth/mfa/status */
export async function mfaStatus(req: Request, res: Response) {
  const u = currentUser(req);
  if (u.id <= 0) return res.json({ ativado: false, obrigatorio: true, backup_restantes: 0 });
  const row = await rowUsuario(u.id);
  res.json({
    ativado: !!row.mfa_ativado_em,
    obrigatorio: u.perfil === 'admin',
    backup_restantes: restantesRegistro(lerRegistro(row.mfa_backup_hashes)),
  });
}

/** POST /api/auth/mfa/setup — gera segredo pendente e devolve QR + URI. */
export async function mfaSetup(req: Request, res: Response) {
  const u = currentUser(req);
  if (u.id <= 0) throw new HttpError(400, 'O acesso de emergência não configura MFA.');
  const row = await rowUsuario(u.id);
  if (row.mfa_ativado_em) throw new HttpError(400, 'MFA já está ativado. Desative-o antes de reconfigurar.');
  const { segredo, uri, qr } = await prepararDesafio(row, async (segredo) => {
    await getStore().update(RESOURCES.usuarios, u.id, { mfa_secret: cifrarSegredoMfa(segredo), mfa_ativado_em: null });
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ segredo, uri, qr });
}

/** POST /api/auth/mfa/ativar — { codigo } confirma o segredo pendente. */
export async function mfaAtivar(req: Request, res: Response) {
  const u = currentUser(req);
  if (u.id <= 0) throw new HttpError(400, 'O acesso de emergência não configura MFA.');
  const row = await rowUsuario(u.id);
  if (row.mfa_ativado_em) throw new HttpError(400, 'MFA já está ativado.');
  const segredo = decifrarSegredoMfa(row.mfa_secret);
  if (!segredo) throw new HttpError(400, 'Chame /api/auth/mfa/setup antes de ativar.');
  if (!verificarTOTP(segredo, req.body?.codigo)) {
    throw new HttpError(400, 'Código inválido. Confira o app autenticador e tente novamente.', { codigo: 'Código inválido' });
  }
  // Na ativação, o usuário recebe os códigos de recuperação (exibição única):
  // sem eles, perder o celular significa perder o acesso.
  const lote = gerarLoteCodigos();
  await getStore().update(RESOURCES.usuarios, u.id, {
    mfa_ativado_em: new Date().toISOString(),
    mfa_backup_hashes: serializarRegistro(lote.registro),
  });
  await getStore().audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'mfa',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} ativou o MFA (TOTP) — ${lote.codigos.length} códigos de recuperação emitidos`,
    empresa_id: empresaDoAtorAudit(u),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, codigos: lote.codigos, backup_restantes: lote.codigos.length });
}

/**
 * POST /api/auth/mfa/codigos — gera um NOVO lote de códigos de recuperação
 * (exibição única, no-store). Invalida o lote anterior. Exige MFA ativo e
 * reautenticação recente: quem gera os códigos entra sem o celular.
 */
export async function mfaCodigos(req: Request, res: Response) {
  const { exigirReautenticacao } = await import('./auth');
  const u = currentUser(req);
  if (u.id <= 0) throw new HttpError(400, 'O acesso de emergência não gerencia MFA.');
  exigirReautenticacao(req);
  const row = await rowUsuario(u.id);
  if (!row.mfa_ativado_em) throw new HttpError(400, 'Ative o MFA antes de gerar códigos de recuperação.');
  const lote = gerarLoteCodigos();
  await getStore().update(RESOURCES.usuarios, u.id, { mfa_backup_hashes: serializarRegistro(lote.registro) });
  await getStore().audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'mfa',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} gerou novos códigos de recuperação do MFA (lote anterior invalidado)`,
    empresa_id: empresaDoAtorAudit(u),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, codigos: lote.codigos, backup_restantes: lote.codigos.length });
}

/** POST /api/auth/mfa/desativar — exige reautenticação recente + código válido. */
export async function mfaDesativar(req: Request, res: Response) {
  const { exigirReautenticacao } = await import('./auth');
  const u = currentUser(req);
  if (u.id <= 0) throw new HttpError(400, 'O acesso de emergência não gerencia MFA.');
  exigirReautenticacao(req);
  const row = await rowUsuario(u.id);
  if (!row.mfa_ativado_em) throw new HttpError(400, 'MFA não está ativado.');
  const segredo = decifrarSegredoMfa(row.mfa_secret);
  if (!segredo || !verificarTOTP(segredo, req.body?.codigo)) {
    throw new HttpError(400, 'Código inválido. Informe o código atual do app autenticador.', { codigo: 'Código inválido' });
  }
  await getStore().update(RESOURCES.usuarios, u.id, { mfa_secret: null, mfa_ativado_em: null, mfa_backup_hashes: null });
  await revogarTodas(u.id, sidAtual(req));
  const { invalidateUserCache } = await import('./auth');
  invalidateUserCache(u.id);
  await getStore().audit({
    usuario_id: u.id,
    usuario: u.name,
    acao: 'mfa',
    recurso: 'usuarios',
    registro_id: u.id,
    descricao: `${u.name} desativou o próprio MFA (com reautenticação) — sessões de outros dispositivos encerradas`,
    empresa_id: empresaDoAtorAudit(u),
  });
  res.json({ ok: true });
}
