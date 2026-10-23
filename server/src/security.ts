// Medidas de segurança da API (sem dependências externas):
//   • cabeçalhos de proteção no navegador
//   • CORS restrito (produção) — o front é servido pelo mesmo domínio
//   • rate limit PERSISTENTE de tentativas de login por IP + e-mail
//     (tabela login_tentativas — sobrevive a reinícios e a mais de uma instância)
//   • exigência de JWT_SECRET em produção
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors';
import { clientIp } from './auth';
import { getStore } from './services';

const isProd = process.env.NODE_ENV === 'production';

// ----------------------------------------------------------------------------
// SEC-02 — confiança EXPLÍCITA de proxy (Express `trust proxy`).
//
// Antes: `app.set('trust proxy', 1)` fixo em TODOS os ambientes. O Express então
// aceitava `X-Forwarded-For` do cliente (salta o último hop) e o rate limit do
// login — que derivava a identidade do IP direto do cabeçalho — podia ser
// contornado trocando o X-Forwarded-For a cada tentativa.
//
// Agora a confiança é uma decisão explícita por ambiente (`TRUST_PROXY`), com
// PADRÃO SEGURO: sem configuração, nenhum cabeçalho de encaminhamento é aceito e
// o IP usado é o da conexão TCP real. O formato é o mesmo que o Express entende
// em `app.set('trust proxy', ...)`:
//
//   (vazio/ausente)              → false: não confia em proxy (padrão)
//   "false" / "0"                → false
//   "true"                       → true  (TODO hop confiável — só quando a
//                                    aplicação é INALCANÇÁVEL por fora)
//   "1", "2", …                  → nº de hops confiáveis (ex.: 1 proxy)
//   "loopback" | "linklocal" ... → nome/lista de sub-redes confiáveis
//   "10.0.0.0/8, 192.168.0.0/16" → IP/CIDR (lista separada por vírgula)
//
// Ver render.yaml: produção na Render define `TRUST_PROXY=1` (um proxy).
// ----------------------------------------------------------------------------
export function trustProxySetting(): boolean | number | string {
  const raw = String(process.env.TRUST_PROXY ?? '').trim();
  if (!raw) return false;
  const low = raw.toLowerCase();
  if (low === 'false' || low === '0' || low === 'no' || low === 'off') return false;
  if (low === 'true' || low === 'yes' || low === 'on') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  // Lista de nomes/IPs/CIDRs — o Express aceita string com itens separados por
  // vírgula e resolve cada um (sub-rede nomeada, IP ou faixa CIDR).
  return raw;
}

/** Aborta a inicialização em produção sem segredo forte do JWT e sem ADMIN_PASSWORD. */
export function assertProductionSecrets() {
  if (!isProd) return;
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 24 || secret === 'brobond-dev-secret') {
    console.error('❌ JWT_SECRET ausente ou fraco em produção. Defina um valor longo e aleatório (render.yaml já gera um).');
    process.exit(1);
  }
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminPassword || adminPassword.length < 8 || adminPassword === 'brobond123') {
    console.error('❌ ADMIN_PASSWORD ausente ou fraca em produção. Defina uma senha com pelo menos 8 caracteres.');
    process.exit(1);
  }
  if (!process.env.MFA_ENCRYPTION_KEY) {
    console.warn('⚠️  MFA_ENCRYPTION_KEY não definida — os segredos TOTP serão cifrados com chave derivada de JWT_SECRET. Defina uma chave dedicada (e não troque o JWT_SECRET depois, ou será preciso resetar o MFA dos administradores).');
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

/** Rotas que uma conta com senha provisória PODE usar (além de qualquer GET). */
const SENHA_PROVISORIA_LIBERADA = /^\/auth\/(me|change-password|logout|logout-all|reautenticar|sessoes|mfa)(\/|$)/;

/** true quando o caminho é seguro para quem ainda não trocou a senha recebida. */
export function senhaProvisoriaLiberada(path: string): boolean {
  return SENHA_PROVISORIA_LIBERADA.test(path);
}

/**
 * Senha provisória (convite aceito, reset de senha ou admin padrão) só lê e só
 * escreve no próprio fluxo de troca de senha/MFA. Sem isso, a senha inicial —
 * que num deploy novo é pública (está no README) — já bastaria para movimentar
 * estoque, fechar inventário e mexer no financeiro antes de qualquer troca.
 */
export function bloquearSenhaProvisoria(req: Request, res: Response, next: NextFunction): void {
  const u = (req as { user?: { trocar_senha?: boolean } }).user;
  if (u?.trocar_senha === true && req.method !== 'GET' && !senhaProvisoriaLiberada(req.path)) {
    res.status(403).json({
      error: 'Defina sua senha definitiva em Configurações → Senha antes de incluir ou alterar dados.',
      code: 'SENHA_PROVISORIA',
    });
    return;
  }
  next();
}

/**
 * Porto do agente local de impressão (P1). O agente escuta SOMENTE em
 * 127.0.0.1 nessa porta; o navegador só o consulta para status/pareamento
 * assistido — o caminho principal de impressão é o agente fazendo polling
 * no ERP, que não passa pelo navegador nem pela CSP.
 */
export const PRINT_AGENT_LOOPBACK = 'http://127.0.0.1:17831';

/**
 * Content-Security-Policy do app. O SPA é 100% same-origin (bundle, API,
 * manifest) e o CSS do editor é autocontido; de fora entram só as fontes do
 * Google e o Cloudinary (imagens/uploads). `style-src 'unsafe-inline'` é
 * obrigatório porque o React escreve style="" nos elementos.
 *
 * `connect-src` e o agente local (P1): a ÚNICA origem não-HTTPS liberada é o
 * loopback literal `http://127.0.0.1:17831` (sem wildcard, sem localhost
 * genérico, sem rede local). Isso não enfraquece a CSP global: 127.0.0.1 é
 * a própria máquina do operador, e o agente ainda exige Origin do ERP +
 * responde ao preflight de Private Network Access. Em produção,
 * `upgrade-insecure-requests` CONTINUA ativo para todo o resto; a exceção
 * de loopback é tratada explicitamente: navegadores consideram 127.0.0.1
 * potencialmente confiável e não o promovem a HTTPS (o agente não tem
 * certificado público possível) — e, se algum navegador bloquear a consulta
 * de status, a impressão NÃO é afetada (polling do agente é o caminho).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://res.cloudinary.com https://*.cloudinary.com",
  `connect-src 'self' https://res.cloudinary.com https://*.cloudinary.com ${PRINT_AGENT_LOOPBACK}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** Cabeçalhos de proteção (equivalente enxuto do helmet). */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  // /api/docs é HTML estático que carrega o Swagger UI de um CDN com um script de
  // bootstrap inline; não é superfície autenticada, então fica fora da CSP do
  // app (os demais cabeçalhos continuam valendo para ele).
  if (req.path !== '/api/docs') {
    res.setHeader('Content-Security-Policy', isProd ? `${CSP}; upgrade-insecure-requests` : CSP);
  }
  // X-Frame-Options em qualquer ambiente (a CSP cobre os navegadores modernos,
  // este é o cinto para os antigos): sem isso, em dev a tela de login podia ser
  // embutida em um iframe de outro site.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

// ----------------------------------------------------------------------------
// Rate limit PERSISTENTE (tabela login_tentativas no Postgres; Map em memória
// no modo demonstração). Buckets por finalidade: login, reset, mfa, convite.
// ----------------------------------------------------------------------------
export type RateBucket = 'login' | 'reset' | 'mfa' | 'convite' | 'reauth' | 'pairing';

const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS) || 15 * 60_000; // 15 min
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;

export function rateWindowMs(): number {
  return WINDOW_MS;
}
export function rateMaxAttempts(): number {
  return MAX_ATTEMPTS;
}

export function rateKey(bucket: RateBucket, chave: string): string {
  return `${bucket}|${chave}`;
}

/** Chave de login: IP + e-mail (igual ao comportamento anterior). */
export function loginBucketKey(req: Request): string {
  return rateKey('login', `${clientIp(req)}|${String(req.body?.email || '').trim().toLowerCase()}`);
}

/** Verifica se o bucket está bloqueado (lança 429). Uso em handlers wrap()-ados. */
export async function exigirRateLimit(bucket: RateBucket, chave: string): Promise<void> {
  try {
    const estado = await getStore().rateLimitEstado(rateKey(bucket, chave), WINDOW_MS);
    if (estado?.bloqueado_ate && new Date(estado.bloqueado_ate).getTime() > Date.now()) {
      const seg = Math.ceil((new Date(estado.bloqueado_ate).getTime() - Date.now()) / 1000);
      throw new HttpError(429, `Muitas tentativas. Tente novamente em ${seg} segundo${seg === 1 ? '' : 's'}.`);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Banco de rate limit indisponível: segue (fail-open) — o login continua
    // exigindo credenciais válidas; o problema é registrado no log.
    console.warn('⚠️  Rate limit indisponível (fail-open):', (e as any)?.message || e);
  }
}

/** Registra uma falha. Retorna quantas tentativas restam (0 = bloqueado agora). */
export async function registrarFalha(bucket: RateBucket, chave: string): Promise<number> {
  try {
    const { restantes } = await getStore().rateLimitHit(rateKey(bucket, chave), WINDOW_MS, MAX_ATTEMPTS);
    return restantes;
  } catch (e) {
    console.warn('⚠️  Rate limit indisponível ao registrar falha (fail-open):', (e as any)?.message || e);
    return MAX_ATTEMPTS - 1;
  }
}

/** Limpa o contador após sucesso. */
export async function registrarSucesso(bucket: RateBucket, chave: string): Promise<void> {
  try {
    await getStore().rateLimitReset(rateKey(bucket, chave));
  } catch {
    // indiferente: bucket sujo expira sozinho na janela
  }
}

// ----------------------------------------------------------------------------
// Compatibilidade com o fluxo de login (IP + e-mail)
// ----------------------------------------------------------------------------

/** Middleware de login: bloqueia após MAX_ATTEMPTS falhas dentro da janela. */
export async function loginRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const estado = await getStore().rateLimitEstado(loginBucketKey(req), WINDOW_MS);
    if (estado?.bloqueado_ate && new Date(estado.bloqueado_ate).getTime() > Date.now()) {
      const min = Math.ceil((new Date(estado.bloqueado_ate).getTime() - Date.now()) / 60_000);
      res.setHeader('Retry-After', String(Math.ceil((new Date(estado.bloqueado_ate).getTime() - Date.now()) / 1000)));
      return void res.status(429).json({ error: `Muitas tentativas de login. Tente novamente em ${min} minuto${min === 1 ? '' : 's'}.` });
    }
    next();
  } catch (e) {
    // fail-open: sem banco de rate limit o login segue (credenciais ainda obrigatórias)
    console.warn('⚠️  Rate limit indisponível (fail-open):', (e as any)?.message || e);
    next();
  }
}

/** Registra uma falha de login. Retorna quantas tentativas restam (0 = bloqueado agora). */
export async function registerLoginFailure(req: Request): Promise<number> {
  return registrarFalha('login', `${clientIp(req)}|${String(req.body?.email || '').trim().toLowerCase()}`);
}

/** Limpa o contador após login bem-sucedido. */
export async function registerLoginSuccess(req: Request): Promise<void> {
  return registrarSucesso('login', `${clientIp(req)}|${String(req.body?.email || '').trim().toLowerCase()}`);
}
