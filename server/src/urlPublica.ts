// ============================================================
// Origem pública do sistema — a base de todo link que sai do
// servidor: e-mail de convite de acesso, "esqueci minha senha", portal do
// cliente, catálogo público e QR code de etiqueta.
//
// Por que existe: um link relativo ("/convite/abc…") dentro de um
// e-mail não tem protocolo nem domínio — o cliente de e-mail (Gmail,
// Outlook, app do celular) não sabe para onde ir e reclama de
// "URL inválida". Todo link de e-mail precisa ser ABSOLUTO.
//
// Ordem de resolução da origem:
//   1. APP_URL               — origem canônica configurada (produção: defina!)
//                              aceita com ou sem esquema ("brobond.com.br"
//                              vira "https://brobond.com.br") e sem a barra final.
//   2. origem da requisição   — X-Forwarded-Proto/Host (Render/proxy) ou Host.
//                              É exatamente o endereço por onde o admin está
//                              navegando, então o link do convite sai correto
//                              mesmo com APP_URL ausente.
//   3. desenvolvimento         — http://localhost:5173 (Vite) quando não há
//                              requisição (cron, script) e o front não é servido
//                              pela API.
//
// Nenhum valor de cabeçalho é confiado às cegas: o host precisa ser um
// hostname normal (ou IPv6 entre colchetes) com porta opcional — Host
// adulterado, com caminho ou com CRLF é descartado e cai para o fallback.
// ============================================================
import type { Request } from 'express';

/** Porta do front no `npm run dev` (Vite) — ver client/vite.config.ts. */
const DEV_FRONT_PORT = Number(process.env.DEV_FRONT_PORT) || 5173;
const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
// Host de cabeçalho: hostname normal ou literal IPv6 entre colchetes, com porta opcional.
const HOST_VALIDO = /^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/;

/**
 * Normaliza uma origem ("https://x.com/", "x.com", "http://localhost:5173/app")
 * em uma base absoluta sem barra final. Devolve '' quando o valor não pode ser
 * usado (vazio, sem host, esquema que não é http/https, URL malformada).
 */
export function normalizarOrigem(bruto?: string | null): string {
  let v = String(bruto ?? '').trim();
  if (!v) return '';
  // X-Forwarded-* pode chegar como lista ("a, b") — só o primeiro valor interessa.
  v = v.split(',')[0]!.trim();
  if (!v) return '';
  // Sem esquema (erro de configuração comum): assume https.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) v = `https://${v}`;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (!u.hostname) return '';
  const caminho = u.pathname.replace(/\/+$/, '');
  // `origin` já descarta usuário/senha da URL — credencial nenhuma vai para o e-mail.
  return `${u.origin}${caminho}`;
}

/** Origem derivada dos cabeçalhos da requisição ('' quando não dá para determinar). */
export function origemDaRequisicao(req?: Request | null): string {
  if (!req) return '';
  const headers: Record<string, unknown> = (req.headers || {}) as Record<string, unknown>;
  const host = String(headers['x-forwarded-host'] || headers.host || '')
    .split(',')[0]!
    .trim();
  if (!host || !HOST_VALIDO.test(host)) return ''; // Host adulterado/incompleto: ignora e usa o próximo fallback

  // Protocolo: X-Forwarded-Proto (Render/proxy) → conexão → https. Um valor
  // presente mas inválido ("gopher", lixo de scanner) NUNCA rebaixa para http:
  // link de convite/reset em http entregaria o token em texto na rede.
  let proto = 'https';
  const encaminhado = String(headers['x-forwarded-proto'] || '')
    .split(',')[0]!
    .trim()
    .replace(/:$/, ''); // alguns proxies enviam "https:"
  if (encaminhado) {
    proto = encaminhado === 'http' ? 'http' : 'https';
  } else if ((req as { secure?: unknown }).secure === true || (req as { protocol?: unknown }).protocol === 'http') {
    proto = 'http';
  }
  return normalizarOrigem(`${proto}://${host}`);
}

/**
 * Em dev a API (3001) não serve o front — um link apontando para a porta da API
 * abriria um 404. Se a origem derivada é local e está na porta da API, troca
 * pela porta do Vite. Em produção (front e API no mesmo serviço) não faz nada.
 */
function ajustarParaDev(origem: string): string {
  if (!origem || process.env.NODE_ENV === 'production') return origem;
  try {
    const u = new URL(origem);
    const portaApi = Number(process.env.PORT) || 3001;
    if (!HOSTS_LOCAIS.has(u.hostname)) return origem;
    if (!u.port || Number(u.port) === portaApi) {
      u.port = String(DEV_FRONT_PORT);
      return normalizarOrigem(u.origin) || origem;
    }
  } catch {
    /* mantém a origem */
  }
  return origem;
}

/** Base absoluta (sem barra final) para montar links do sistema. '' se impossível. */
export function urlBasePublica(req?: Request | null): string {
  const config = normalizarOrigem(process.env.APP_URL);
  if (config) return config;
  const daRequisicao = ajustarParaDev(origemDaRequisicao(req));
  if (daRequisicao) return daRequisicao;
  // Sem APP_URL e sem requisição (job/cron/script): em dev usa o Vite; em
  // produção devolve '' e o chamador avisa — link relativo é pior que nenhum.
  return process.env.NODE_ENV === 'production' ? '' : `http://localhost:${DEV_FRONT_PORT}`;
}

/** Monta um link absoluto a partir de um caminho interno ('convite/abc' ou '/convite/abc'). */
export function linkPublico(caminho: string, req?: Request | null): string {
  const caminhoSeguro = `/${String(caminho ?? '').replace(/^\/+/, '')}`;
  const base = urlBasePublica(req);
  return base ? `${base}${caminhoSeguro}` : caminhoSeguro;
}

/** true quando o valor é uma URL http(s) absoluta (com origem). */
export function urlAbsoluta(valor: string): boolean {
  try {
    const u = new URL(String(valor));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** APP_URL presente e utilizável? (diagnóstico em /api/meta e no boot) */
export function origemConfigurada(): boolean {
  return Boolean(normalizarOrigem(process.env.APP_URL));
}

/** Estado da origem pública — usado no diagnóstico de boot e em /api/meta. */
export function statusOrigem(req?: Request | null): { configurada: boolean; base: string } {
  return { configurada: origemConfigurada(), base: urlBasePublica(req) };
}

/**
 * Diagnóstico de boot. Um link de e-mail sem origem ("/convite/abc") é exatamente
 * o que faz o cliente de e-mail responder "URL inválida", então avisamos na saída.
 * Em produção a origem ainda pode ser deduzida do cabeçalho da requisição — o
 * aviso existe porque depender disso é frágil (proxy sem X-Forwarded-*, URL de
 * preview, domínio trocado depois). Devolve o texto para o chamador reaproveitar
 * (/api/meta → Configurações › Sistema).
 */
export function revisarConfiguracaoOrigem(): string {
  if (origemConfigurada()) return '';
  if (process.env.NODE_ENV !== 'production') return ''; // dev: o link cai em http://localhost:5173 e funciona
  const aviso =
    '⚠️  APP_URL ausente — o endereço dos links de e-mail (convite de acesso, redefinição de senha) fica dependendo do cabeçalho Host da requisição. ' +
    'Se um proxy não o enviar, o link sai relativo ("/convite/…") e quem recebe vê "URL inválida". Defina APP_URL com o endereço público do ERP ' +
    '(ex.: https://erp.brobond.com.br).';
  console.warn(aviso);
  return aviso;
}

let avisoEmitido = false;
/** Avisa uma única vez por processo que a origem não pôde ser determinada. */
export function avisarOrigemIndefinida(uso: string): void {
  if (avisoEmitido) return;
  avisoEmitido = true;
  console.warn(
    `⚠️  [url-publica] Sem APP_URL e sem origem na requisição: o link de "${uso}" ficou relativo e não abre no e-mail. Defina APP_URL com o endereço público do ERP (ex.: https://erp.brobond.com.br).`
  );
}
