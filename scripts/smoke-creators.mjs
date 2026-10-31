// Smoke restrito a Creators. Use apenas servidor de teste recém-iniciado em
// memória (NODE_ENV=test, SEM DATABASE_URL), nunca produção. O fluxo de acesso
// usa o MFA e a troca de senha reais já adotados pelo smoke existente.
// NODE_ENV=test npm --workspace server start
// npm --workspace client run dev
// node scripts/smoke-creators.mjs
// Browser opcional: SMOKE_BROWSER=1 (playwright-core + @sparticuz/chromium).
import { createHmac } from 'node:crypto';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3001/api';
const FRONT = process.env.SMOKE_FRONT || 'http://127.0.0.1:5173';
const EMAIL = process.env.SMOKE_EMAIL || 'admin@brobond.com.br';
const SENHA_INICIAL = process.env.SMOKE_SENHA || 'brobond123';
const SENHA_NOVA = process.env.SMOKE_SENHA_NOVA || 'Brobond#2026SenhaForte';

const out = [];
let falhas = 0;
let token = null;

function check(nome, cond, extra = '') {
  if (!cond) falhas++;
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${nome}${extra ? '  — ' + extra : ''}`);
}

async function req(method, path, body, bearer = token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* corpo vazio */ }
  return { status: r.status, json };
}

const msg = (j) => String(j?.erro || j?.error || '').slice(0, 70);

// ---------------------------------------------------------------- TOTP (RFC 6238)
function base32Decode(s) {
  const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, valor = 0;
  const bytes = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const v = ALFA.indexOf(ch);
    if (v < 0) continue;
    valor = (valor << 5) | v;
    bits += 5;
    if (bits >= 8) { bytes.push((valor >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function totp(segredo) {
  const contador = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const h = createHmac('sha1', base32Decode(segredo)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const cod = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(cod).padStart(6, '0');
}

// Guarda de segurança: o smoke de primeiro acesso nunca deve modificar
// credenciais de uma instalação com PostgreSQL ou fora do sandbox local.
if (!['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)) {
  throw new Error('Use este smoke somente em servidor local de teste.');
}
const health = await req('GET', '/health', undefined, null);
if (health.status !== 200 || health.json?.db !== 'memory') {
  throw new Error('O smoke Creators exige servidor de teste em memória, sem DATABASE_URL.');
}

// ---------------------------------------------------------------- acesso
const login1 = await req('POST', '/auth/login', { email: EMAIL, password: SENHA_INICIAL }, null);
check('POST /auth/login exige MFA do admin', login1.json?.mfa_setup_required === true, `status ${login1.status}`);

const ticket = login1.json?.mfa_ticket;
// O cadastro pré-login é /auth/mfa/desafio com o ticket no CORPO: o ticket tem
// typ:'mfa' e requireAuth o recusa como Bearer (server/src/auth.ts).
const setup = await req('POST', '/auth/mfa/desafio', { mfa_ticket: ticket }, null);
check('POST /auth/mfa/desafio (cadastro TOTP)', setup.status === 200 && !!setup.json?.segredo, `status ${setup.status}`);
const segredo = setup.json?.segredo;

const mfa = await req('POST', '/auth/login/mfa', { mfa_ticket: ticket, codigo: totp(segredo) }, null);
token = mfa.json?.token;
check('POST /auth/login/mfa → token (TOTP real)', !!token, `status ${mfa.status}`);

const troca = await req('POST', '/auth/change-password', { senha_atual: SENHA_INICIAL, senha_nova: SENHA_NOVA });
check('POST /auth/change-password', troca.status === 200, `status ${troca.status} ${msg(troca.json)}`);

const login2 = await req('POST', '/auth/login', { email: EMAIL, password: SENHA_NOVA }, null);
const mfa2 = await req('POST', '/auth/login/mfa', { mfa_ticket: login2.json?.mfa_ticket, codigo: totp(segredo) }, null);
token = mfa2.json?.token;
check('relogin com senha definitiva + MFA', !!token, `status ${mfa2.status}`);


const anon = await req('GET', '/creators/capabilities', undefined, null);
check('API Creators recusa acesso anônimo', anon.status === 401, `HTTP ${anon.status}`);
const caps = await req('GET', '/creators/capabilities');
check('API Creators autenticada', caps.status === 200 && caps.json?.empresa_id > 0, `HTTP ${caps.status}`);
const ids = ['creators', 'creator-matches', 'outreach-ai', 'campanhas'];
// As quatro capacidades agora têm FONTE REAL (perfis, afinidades, contatos e
// campanhas). O que permanece desligado é a GERAÇÃO/ENVIO do outreach — nada
// é simulado, e nenhuma capacidade devolve registros fabricados.
check('quatro capacidades com fonte real e sem registros fictícios', ids.every((id) => {
  const cap = caps.json?.modulos?.[id];
  return cap && cap.fonte && cap.consulta === true && !('rows' in cap) && !('total' in cap);
}));
check('outreach não promete geração nem envio', (() => {
  const cap = caps.json?.modulos?.['outreach-ai'];
  return cap?.geracao === false && cap?.envio === false;
})());
check('matches não promete recomendação automática', caps.json?.modulos?.['creator-matches']?.recomendacao === false);
const injected = await req('GET', '/creators/capabilities?empresa_id=999&consolidado=true');
check('query não troca o tenant da sessão', injected.status === 200 && injected.json?.empresa_id === caps.json?.empresa_id);
const paths = ['/creators', '/matches', '/outreach-ai', '/campanhas'];
for (const path of paths) {
  const response = await fetch(FRONT + path);
  check(`GET ${path} entrega a aplicação`, response.status === 200 && (response.headers.get('content-type') || '').includes('text/html'), `HTTP ${response.status}`);
}

if (process.env.SMOKE_BROWSER === '1') {
  const { chromium: playwright } = await import('playwright-core');
  const { default: chromium } = await import('@sparticuz/chromium');
  const browser = await playwright.launch({ executablePath: await chromium.executablePath(), args: chromium.args.filter((arg) => !['--disable-web-security', '--allow-running-insecure-content'].includes(arg)), headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript((value) => localStorage.setItem('brobond_token', value), token);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const titles = ['CREATORS', 'MATCHES', 'OUTREACH AI', 'CAMPANHAS'];
    for (const width of [1440, 1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (let index = 0; index < paths.length; index++) {
        const response = await page.goto(FRONT + paths[index]);
        await page.getByRole('heading', { level: 1, name: titles[index], exact: true }).waitFor();
        const content = page.locator('#conteudo-principal');
        const text = await content.innerText();
        check(`${width}px ${paths[index]}: página autenticada`, response.status() === 200 && !page.url().includes('/login'));
        check(`${width}px ${paths[index]}: sem roadmap`, !/em breve|em construção planejada|ações em breve|próximas capacidades|escopo inicial do módulo/i.test(text));
        check(`${width}px ${paths[index]}: sem formulário sobreposto`, await content.locator('[role="dialog"], [aria-modal], dialog').count() === 0);
        const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
        check(`${width}px ${paths[index]}: sem overflow horizontal`, dimensions.document <= dimensions.viewport, JSON.stringify(dimensions));
        const breadcrumb = page.getByRole('navigation', { name: /breadcrumb|trilha/i });
        check(`${width}px ${paths[index]}: breadcrumb`, await breadcrumb.count() > 0 && (await breadcrumb.innerText()).includes('Creators'));
      }
    }
    // Navegação local efetiva e breadcrumb clicável até a base Creators.
    await page.getByRole('navigation', { name: 'Módulos de Creators' }).getByRole('link', { name: 'Matches', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'MATCHES', exact: true }).waitFor();
    check('navegação entre submódulos', page.url().endsWith('/matches'));
    const breadcrumb = page.getByRole('navigation', { name: /breadcrumb|trilha/i });
    await breadcrumb.getByRole('link', { name: 'Creators', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'CREATORS', exact: true }).waitFor();
    check('breadcrumb volta à página de Creators', page.url().endsWith('/creators'));
    check('nenhum erro JavaScript nas quatro telas', errors.length === 0, errors.join('; '));
  } finally {
    await browser.close();
  }
}
console.log(out.join('\n'));
console.log(`\nCreators: ${out.length - falhas}/${out.length} verificações aprovadas.`);
process.exitCode = falhas ? 1 : 0;
