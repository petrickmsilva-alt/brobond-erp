// Medidas de segurança da API (sem dependências externas):
//   • cabeçalhos de proteção no navegador
//   • CORS restrito (produção) — o front é servido pelo mesmo domínio
//   • limite de tentativas de login por IP + e-mail
//   • exigência de JWT_SECRET em produção
import type { NextFunction, Request, Response } from 'express';
import { clientIp } from './auth';

const isProd = process.env.NODE_ENV === 'production';

/** Aborta a inicialização em produção sem segredo forte do JWT e sem ADMIN_PASSWORD. */
export function assertProductionSecrets() {
  if (!isProd) return;
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 24 || secret === 'brobond-dev-secret') {
    console.error('❌ JWT_SECRET ausente ou fraco em produção. Defina um valor longo e aleatório (render.yaml já gera um).');
    process.exit(1);
  }
  const vaultKey = process.env.VAULT_KEY || '';
  let vaultBytes = 0;
  try { vaultBytes = /^[0-9a-f]{64}$/i.test(vaultKey) ? 32 : Buffer.from(vaultKey, 'base64').length; } catch { vaultBytes = 0; }
  if (vaultBytes !== 32) {
    console.error('❌ VAULT_KEY inválida em produção. Defina exatamente 32 bytes em base64 ou 64 caracteres hexadecimais.');
    process.exit(1);
  }
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminPassword || adminPassword.length < 8 || adminPassword === 'brobond123') {
    console.error('❌ ADMIN_PASSWORD ausente ou fraca em produção. Defina uma senha com pelo menos 8 caracteres.');
    process.exit(1);
  }
}

/** Origens permitidas para CORS (produção). Ex.: CORS_ORIGINS=https://brobond.com.br,https://erp.brobond.com.br */
export function corsOrigin(): boolean | string[] {
  const list = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) return list;
  // Em produção o front é servido pela própria API (mesma origem) → nenhuma origem externa.
  // Em desenvolvimento o Vite faz proxy, mas liberamos para facilitar testes.
  return isProd ? [] : true;
}

/** Cabeçalhos de proteção (equivalente enxuto do helmet). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
}

// ----------------------------------------------------------------------------
// Limite de tentativas de login
// ----------------------------------------------------------------------------
const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS) || 15 * 60_000; // 15 min
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;
type Bucket = { count: number; first: number; blockedUntil: number };
const buckets = new Map<string, Bucket>();

function bucketKey(req: Request): string {
  const email = String(req.body?.email || '').trim().toLowerCase();
  return `${clientIp(req)}|${email}`;
}

function prune() {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.first > WINDOW_MS && b.blockedUntil < now) buckets.delete(k);
}

/** Middleware: bloqueia após MAX_ATTEMPTS falhas dentro da janela. */
export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  if (buckets.size > 5000) prune();
  const b = buckets.get(bucketKey(req));
  const now = Date.now();
  if (b && b.blockedUntil > now) {
    const min = Math.ceil((b.blockedUntil - now) / 60_000);
    res.setHeader('Retry-After', String(Math.ceil((b.blockedUntil - now) / 1000)));
    return res.status(429).json({ error: `Muitas tentativas de login. Tente novamente em ${min} minuto${min === 1 ? '' : 's'}.` });
  }
  next();
}

/** Registra uma falha de login. Retorna quantas tentativas restam (0 = bloqueado agora). */
export function registerLoginFailure(req: Request): number {
  const key = bucketKey(req);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.first > WINDOW_MS) b = { count: 0, first: now, blockedUntil: 0 };
  b.count += 1;
  if (b.count >= MAX_ATTEMPTS) b.blockedUntil = now + WINDOW_MS;
  buckets.set(key, b);
  return Math.max(0, MAX_ATTEMPTS - b.count);
}

/** Limpa o contador após login bem-sucedido. */
export function registerLoginSuccess(req: Request) {
  buckets.delete(bucketKey(req));
}
