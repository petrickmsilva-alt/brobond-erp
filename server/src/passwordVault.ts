import type { Request, Response } from 'express';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { currentUser, verifyPassword } from './auth';
import { HttpError } from './errors';
import { enviarEmail, smtpConfigurado } from './mail';
import { RESOURCES } from './resources';
import { getStore } from './services';

const COOLDOWN_MS = Math.max(5_000, Number(process.env.VAULT_COOLDOWN_MS || 30_000));
const attempts = new Map<number, number>();
const challenges = new Map<number, { hash: string; expires: number }>();

function key(): Buffer {
  const raw = String(process.env.VAULT_KEY || '');
  let b: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) b = Buffer.from(raw, 'hex');
  else {
    try { b = Buffer.from(raw, 'base64'); } catch { b = Buffer.alloc(0); }
  }
  if (b.length !== 32) throw new HttpError(503, 'Cofre indisponível: configure VAULT_KEY com 32 bytes (base64 ou 64 caracteres hexadecimais).');
  return b;
}

/** AES-256-GCM; formato versionado iv.tag.ciphertext (base64url). */
export function encryptVaultPassword(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptVaultPassword(payload: string): string {
  const [version, iv, tag, encrypted] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new HttpError(500, 'Senha cifrada inválida.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new HttpError(500, 'Não foi possível decifrar a senha. Verifique a VAULT_KEY.'); }
}

function ensureAdmin(req: Request) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' || actor.id <= 0) throw new HttpError(403, 'Apenas administradores podem visualizar senhas.');
  const until = attempts.get(actor.id) || 0;
  if (until > Date.now()) throw new HttpError(429, `Aguarde ${Math.ceil((until - Date.now()) / 1000)} segundos antes de tentar novamente.`);
  return actor;
}
function fail(actorId: number) { attempts.set(actorId, Date.now() + COOLDOWN_MS); }
function hashCode(code: string) { return createHash('sha256').update(code).digest(); }

export async function requestVaultEmail(req: Request, res: Response) {
  const actor = ensureAdmin(req);
  if (!smtpConfigurado()) throw new HttpError(503, 'A confirmação por e-mail exige SMTP configurado.');
  const code = String(randomInt(100000, 1000000));
  challenges.set(actor.id, { hash: hashCode(code).toString('hex'), expires: Date.now() + 10 * 60_000 });
  await enviarEmail({ to: actor.email, assunto: 'BROBOND ERP — confirmação para visualizar senha', html: `Seu código de confirmação é <strong>${code}</strong>.<br/>Ele expira em 10 minutos. Se você não solicitou, revise a Auditoria.` });
  res.json({ ok: true, cooldownSeconds: 0 });
}

export async function revealPassword(req: Request, res: Response) {
  const actor = ensureAdmin(req);
  const targetId = Number(req.params.id);
  const store = getStore();
  const admin = await store.findOneWhere(RESOURCES.usuarios, { id: actor.id });
  let authorized = false;
  let method = 'senha_admin';
  if (typeof req.body?.adminPassword === 'string' && req.body.adminPassword) authorized = await verifyPassword(req.body.adminPassword, admin?.senha_hash);
  else if (typeof req.body?.emailCode === 'string') {
    method = 'email';
    const c = challenges.get(actor.id);
    const supplied = hashCode(req.body.emailCode);
    authorized = !!c && c.expires > Date.now() && timingSafeEqual(supplied, Buffer.from(c.hash, 'hex'));
    if (authorized) challenges.delete(actor.id);
  }
  if (!authorized) { fail(actor.id); throw new HttpError(403, 'Confirmação inválida. Aguarde o cooldown para tentar novamente.'); }
  const target = await store.findOneWhere(RESOURCES.usuarios, { id: targetId });
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  if (!target.senha_cifrada) throw new HttpError(404, 'Senha não recuperável: somente senhas definidas após a ativação do cofre podem ser exibidas.');
  const password = decryptVaultPassword(target.senha_cifrada);
  attempts.set(actor.id, Date.now() + COOLDOWN_MS);
  await store.audit({ usuario_id: actor.id, usuario: actor.name, acao: 'senha', recurso: 'usuarios', registro_id: targetId, descricao: 'Visualização de senha', dados: { usuario_alvo: target.email, metodo: method } });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ password, cooldownSeconds: Math.ceil(COOLDOWN_MS / 1000) });
}
