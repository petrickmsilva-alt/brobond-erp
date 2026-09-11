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
//   2. endereço salvo no banco — o administrador grava em Configurações ›
//                              Sistema (tabela `configuracoes`, chave
//                              `app_url`). Resolve na hora: sem variável de
//                              ambiente e sem redeploy na Render.
//   3. origem da requisição   — X-Forwarded-Proto/Host (Render/proxy) ou Host.
//                              É exatamente o endereço por onde o admin está
//                              navegando, então o link do convite sai correto
//                              mesmo com APP_URL ausente.
//   4. desenvolvimento         — http://localhost:5173 (Vite) quando não há
//                              requisição (cron, script) e o front não é servido
//                              pela API.
//
// Nenhum valor de cabeçalho é confiado às cegas: o host precisa ser um
// hostname normal (ou IPv6 entre colchetes) com porta opcional — Host
// adulterado, com caminho ou com CRLF é descartado e cai para o fallback.
// O endereço do banco NUNCA é deduzido sozinho: ele só entra quando alguém
// (admin, com reautenticação) salvou — ver configSistema.ts.
// ============================================================
import type { Request } from 'express';
import { CHAVE_APP_URL, lerConfig } from './configuracoes';

/** Porta do front no `npm run dev` (Vite) — ver client/vite.config.ts. */
const DEV_FRONT_PORT = Number(process.env.DEV_FRONT_PORT) || 5173;
const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

// ----------------------------------------------------------------------------
// Endereço que NUNCA abre na máquina de quem recebeu o e-mail.
//
// Foi exatamente o defeito relatado em produção: APP_URL copiada do
// .env.example (http://localhost:5173 — valor de desenvolvimento) para o
// painel da Render. O link sai "bonito" (absoluto, com esquema) e mesmo assim
// o sócio vê "URL inválida": localhost é a máquina DELE, não o servidor.
// O mesmo vale para IP privado (10.x, 192.168.x), nome interno sem domínio
// ("brobond-erp") e sufixos reservados (.local, .internal). Em produção esses
// valores são DESCARTADOS — é melhor cair na origem da requisição (ou avisar)
// do que entregar um link que não abre para ninguém.
// ----------------------------------------------------------------------------
const SUFIXOS_INTERNOS = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example', '.home.arpa'];

/** true quando o host só resolve dentro da rede local (ou da própria máquina). */
export function hostInterno(hostname: string): boolean {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (SUFIXOS_INTERNOS.some((s) => h.endsWith(s))) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127) return true; // loopback / rede privada
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (h.includes(':')) return true; // IPv6 literal: não utilizável como link de e-mail
  if (!h.includes('.')) return true; // nome solto ("brobond-erp") não resolve na internet
  return false;
}

/**
 * Uma origem só serve para link de e-mail se quem recebe consegue alcançá-la.
 * Com APP_URL_PERMITIR_INTERNA=true (ERP que só é acessado pela rede interna da
 * fábrica, sem endereço público) o filtro é desligado de propósito.
 */
export function origemPublica(origem: string): boolean {
  if (!origem) return false;
  if (process.env.APP_URL_PERMITIR_INTERNA === 'true') return true;
  try {
    return !hostInterno(new URL(origem).hostname);
  } catch {
    return false;
  }
}
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

const avisosInternos = new Set<string>();
/** Avisa uma vez por processo que uma origem interna foi descartada (evita flood). */
function avisarOrigemInterna(fonte: string, origem: string): void {
  const chave = `${fonte}|${origem}`;
  if (avisosInternos.has(chave)) return;
  avisosInternos.add(chave);
  console.warn(
    `⚠️  [url-publica] Origem interna descartada para os links de e-mail: ${fonte} aponta para "${origem}", que só existe dentro do servidor. ` +
      'Quem recebe o convite/redefinição vê "URL inválida". Defina APP_URL com o endereço público do ERP (ex.: https://erp.brobond.com.br).'
  );
}

// ----------------------------------------------------------------------------
// Endereço público gravado pelo administrador (tabela `configuracoes`).
//
// Por que existe: o aviso "defina APP_URL na Render" exigia acesso ao painel e
// um redeploy — e, até lá, cada convite saía com o endereço deduzido da sessão
// de quem gerou (atrás de proxy isso pode sair errado e virar "URL inválida").
// Gravando no banco, o próprio ERP resolve: o admin salva o endereço público em
// Configurações › Sistema e o próximo convite já sai certo.
//
// A leitura é assíncrona (banco) e o valor fica em cache por até 60 s — o link
// é montado em funções async, então os chamadores usam as variantes `…Async`.
// ----------------------------------------------------------------------------
type CacheOrigem = { valor: string; carregadoEm: number };
const TTL_CACHE_ORIGEM_MS = Number(process.env.APP_URL_CACHE_MS) || 60_000;
let cacheOrigem: CacheOrigem | null = null;
let carregandoOrigem: Promise<string> | null = null;

/**
 * Endereço público salvo no banco ('' se nunca foi configurado ou se o banco
 * está fora do ar — nesse caso mantém o último valor conhecido do cache).
 */
export async function carregarOrigemDoBanco(forcar = false): Promise<string> {
  if (!forcar && cacheOrigem && Date.now() - cacheOrigem.carregadoEm < TTL_CACHE_ORIGEM_MS) return cacheOrigem.valor;
  // Duas chamadas simultâneas compartilham a mesma leitura (não disparam 2 queries).
  if (carregandoOrigem) return carregandoOrigem;
  carregandoOrigem = (async () => {
    try {
      const valor = normalizarOrigem(await lerConfig(CHAVE_APP_URL));
      cacheOrigem = { valor, carregadoEm: Date.now() };
      return valor;
    } catch {
      return cacheOrigem?.valor ?? '';
    } finally {
      carregandoOrigem = null;
    }
  })();
  return carregandoOrigem;
}

/** Valor já carregado no cache ('' antes da primeira leitura). */
export function origemDoBanco(): string {
  return cacheOrigem?.valor ?? '';
}

/** Atualiza o cache depois que o admin salva/apaga o endereço (não espera o TTL). */
export function registrarOrigemDoBanco(valor: string): void {
  cacheOrigem = { valor: normalizarOrigem(valor), carregadoEm: Date.now() };
}

/**
 * Aceita um endereço público informado pelo administrador.
 *
 * Validações (em ordem): precisa existir; precisa ser http(s) utilizável; e, em
 * produção, precisa ser ALCANÇÁVEL por quem recebe o e-mail — localhost, IP
 * privado e nome sem domínio são recusados (a menos que o ERP seja interno de
 * propósito: APP_URL_PERMITIR_INTERNA=true).
 */
export function validarOrigemPublica(
  valor: unknown
): { ok: true; origem: string } | { ok: false; erro: string } {
  const bruto = String(valor ?? '').trim();
  if (!bruto) return { ok: false, erro: 'Informe o endereço público do ERP (ex.: https://erp.brobond.com.br).' };
  if (bruto.length > 300) return { ok: false, erro: 'Endereço longo demais (máximo de 300 caracteres).' };
  const origem = normalizarOrigem(bruto);
  if (!origem) {
    return {
      ok: false,
      erro: 'Endereço inválido. Use o formato https://erp.brobond.com.br (sem caminho, sem espaço e sem usuário/senha na URL).',
    };
  }
  if (process.env.NODE_ENV === 'production' && !origemPublica(origem)) {
    return {
      ok: false,
      erro: `"${origem}" não é um endereço público: localhost, IP privado e nome sem domínio só existem dentro do servidor, e o link não abre para quem recebe o e-mail ("URL inválida"). Use o domínio que os usuários digitam no navegador (ex.: https://erp.brobond.com.br).`,
    };
  }
  return { ok: true, origem };
}

/**
 * Base absoluta (sem barra final) para montar links do sistema. '' se impossível.
 *
 * Em produção, uma origem interna (localhost, IP privado, nome sem domínio) é
 * DESCARTADA: o link precisa abrir na máquina de quem recebeu o e-mail, não na
 * do servidor. Em desenvolvimento localhost é o normal — por isso o filtro só vale
 * com NODE_ENV=production.
 */
export function urlBasePublica(req?: Request | null): string {
  return urlBasePublicaCom(origemDoBanco(), req);
}

/** Mesma regra de `urlBasePublica`, recebendo o endereço do banco já carregado. */
function urlBasePublicaCom(doBanco: string, req?: Request | null): string {
  const producao = process.env.NODE_ENV === 'production';
  const config = normalizarOrigem(process.env.APP_URL);
  if (config) {
    if (!producao || origemPublica(config)) return config;
    avisarOrigemInterna('APP_URL', config);
  }
  // Endereço escolhido pelo admin na interface (gravado no banco). Vale tanto
  // quanto o APP_URL e evita o redeploy só para corrigir um link de convite.
  const salva = ajustarParaDev(normalizarOrigem(doBanco));
  if (salva) {
    if (!producao || origemPublica(salva)) return salva;
    avisarOrigemInterna('o endereço salvo em Configurações › Sistema', salva);
  }
  const daRequisicao = ajustarParaDev(origemDaRequisicao(req));
  if (daRequisicao) {
    if (!producao || origemPublica(daRequisicao)) return daRequisicao;
    avisarOrigemInterna('o cabeçalho da requisição', daRequisicao);
  }
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

/** Como `urlBasePublica`, mas garante a leitura do endereço salvo no banco. */
export async function urlBasePublicaAsync(req?: Request | null): Promise<string> {
  const doBanco = await carregarOrigemDoBanco();
  return urlBasePublicaCom(doBanco, req);
}

/**
 * Como `linkPublico`, mas carregando antes o endereço salvo pelo administrador.
 * É a variante que os fluxos de e-mail usam (convite, redefinição): uma leitura
 * de banco a mais é irrelevante perto de enviar um convite com link quebrado.
 */
export async function linkPublicoAsync(caminho: string, req?: Request | null): Promise<string> {
  const caminhoSeguro = `/${String(caminho ?? '').replace(/^\/+/, '')}`;
  const base = await urlBasePublicaAsync(req);
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

export type FonteOrigem = 'env' | 'banco' | 'requisicao' | 'dev' | '';

/** Estado completo da origem (usado em /api/meta e no endpoint de diagnóstico). */
export type StatusOrigem = {
  /** APP_URL (variável de ambiente) presente e utilizável? */
  configurada: boolean;
  /** Endereço que está valendo agora (base dos links). */
  base: string;
  /** A base atual é alcançável por quem recebe o e-mail? */
  publica: boolean;
  /** APP_URL existe, mas foi descartada (aponta para endereço interno). */
  appUrlIgnorada: boolean;
  /** De onde veio a `base`: env (APP_URL), banco (Configurações), requisição ou dev. */
  fonte: FonteOrigem;
  /** Endereço salvo pelo administrador no banco ('' = nunca configurado). */
  doBanco: string;
  /** APP_URL como está no ambiente ('' = ausente/inutilizável) — não é segredo. */
  doAmbiente: string;
  /**
   * Endereço detectado nesta sessão (o que o navegador está usando).
   * É apenas SUGESTÃO para o admin confirmar na tela: nunca é gravado sozinho
   * — o cabeçalho Host é controlado por quem faz a requisição, e confiar nele
   * permitiria enviar tokens de convite/reset para o domínio de um atacante.
   */
  sugerida: string;
  /** APP_URL_PERMITIR_INTERNA ligada (ERP só na rede interna). */
  permitirInterna: boolean;
};

function montarStatus(doBanco: string, req?: Request | null): StatusOrigem {
  const producao = process.env.NODE_ENV === 'production';
  const doAmbiente = normalizarOrigem(process.env.APP_URL);
  const envUtil = Boolean(doAmbiente) && (!producao || origemPublica(doAmbiente));
  const bancoUtil = Boolean(doBanco) && (!producao || origemPublica(doBanco));
  const daRequisicao = ajustarParaDev(origemDaRequisicao(req));
  const reqUtil = Boolean(daRequisicao) && (!producao || origemPublica(daRequisicao));
  const base = urlBasePublicaCom(doBanco, req);
  const fonte: FonteOrigem = base
    ? envUtil && base === doAmbiente
      ? 'env'
      : bancoUtil && base === ajustarParaDev(doBanco)
        ? 'banco'
        : reqUtil && base === daRequisicao
          ? 'requisicao'
          : 'dev'
    : '';
  return {
    configurada: origemConfigurada(),
    base,
    publica: origemPublica(base),
    appUrlIgnorada: Boolean(doAmbiente) && !envUtil,
    fonte,
    doBanco,
    doAmbiente,
    sugerida: daRequisicao,
    permitirInterna: process.env.APP_URL_PERMITIR_INTERNA === 'true',
  };
}

/**
 * Estado da origem pública — usado no diagnóstico de boot e em /api/meta.
 *
 * `publica: false` é o caso que vira "URL inválida" na mão de quem recebeu o
 * e-mail: ou não há origem nenhuma (link relativo) ou a origem é interna
 * (localhost/IP privado). `appUrlIgnorada` diz que a APP_URL configurada
 * existe, mas está sendo descartada por apontar para um endereço interno —
 * é o erro de configuração mais comum (valor de desenvolvimento em produção).
 */
export function statusOrigem(req?: Request | null): StatusOrigem {
  return montarStatus(origemDoBanco(), req);
}

/** Como `statusOrigem`, garantindo a leitura do endereço salvo no banco. */
export async function statusOrigemAsync(req?: Request | null): Promise<StatusOrigem> {
  return montarStatus(await carregarOrigemDoBanco(), req);
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
  if (origemConfigurada()) {
    // APP_URL existe, mas aponta para dentro do servidor (localhost, IP
    // privado, nome sem domínio): o link NUNCA abre para quem recebe o e-mail.
    const appUrl = normalizarOrigem(process.env.APP_URL);
    if (process.env.NODE_ENV === 'production' && appUrl && !origemPublica(appUrl)) {
      const aviso =
        `⚠️  APP_URL="${appUrl}" não é um endereço público — os links de e-mail (convite de acesso, redefinição de senha) não abrem para quem recebe ` +
        '("URL inválida"). Defina APP_URL com o endereço público do ERP (ex.: https://erp.brobond.com.br) ou salve o endereço em Configurações › Sistema.';
      console.warn(aviso);
      return aviso;
    }
    return '';
  }
  if (process.env.NODE_ENV !== 'production') return ''; // dev: o link cai em http://localhost:5173 e funciona
  const aviso =
    '⚠️  APP_URL ausente — o endereço dos links de e-mail (convite de acesso, redefinição de senha) fica dependendo do cabeçalho Host da requisição. ' +
    'Se um proxy não o enviar, o link sai relativo ("/convite/…") e quem recebe vê "URL inválida". Defina APP_URL com o endereço público do ERP ' +
    '(ex.: https://erp.brobond.com.br) ou salve o endereço em Configurações › Sistema (não exige redeploy).';
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
