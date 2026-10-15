// UX-05 — validação real de viewports/teclado/responsividade da Master Top
// Navigation. Uso: node scripts/ux05-browser-check.mjs [baseURL]
import puppeteer from 'puppeteer-core';
import { totpAgora } from './ux05-totp.mjs';

const BASE = process.argv[2] || 'http://localhost:12000';
const EMAIL = 'admin@brobond.com.br';
const PASS = process.env.UX05_PASS;

const falhas = [];
const ok = (cond, msg) => {
  if (cond) console.log(`  ✅ ${msg}`);
  else {
    console.log(`  ❌ ${msg}`);
    falhas.push(msg);
  }
};

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// ---- login ---------------------------------------------------------------
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
await page.type('input[type="email"]', EMAIL);
await page.type('input[type="password"]', PASS);
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 3000));

let url = page.url();
if (url.includes('/login')) {
  // desafio TOTP (código gerado agora: validade de 30 s)
  const codigo = totpAgora();
  if (codigo) {
    await page.waitForSelector('input[placeholder="000000"]', { timeout: 10000 });
    await page.type('input[placeholder="000000"]', codigo);
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 3000));
  }
}
console.log('URL pós-login:', page.url());

const areaBtns = () =>
  page.$$eval('[data-testid="top-navigation"] button[data-topnav-area]', (els) => els.map((e) => e.getAttribute('data-topnav-area')));

/**
 * Abre a Área pelo botão da barra ou, quando ela transbordou (§17), pelo
 * agrupador "Mais". Devolve o seletor do dropdown aberto.
 */
const abrirArea = async (area) => {
  const naBarra = await page.$(`[data-testid="top-navigation"] button[data-topnav-area="${area}"]`);
  if (naBarra) {
    await naBarra.click();
  } else {
    await page.click('[data-testid="top-navigation"] button[data-topnav-area="__mais__"]');
    await new Promise((r) => setTimeout(r, 300));
    const btn = await page.$(`#topnav-menu-mais button[data-topnav-area="${area}"]`);
    if (!btn) return null;
    await btn.click();
  }
  await new Promise((r) => setTimeout(r, 400));
  const slug = area
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return (await page.$(`#topnav-menu-${slug}`)) || (await page.$('#topnav-menu-mais'));
};

const fecharMenus = async () => {
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 250));
};

const rota = async (path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1200));
};

// ---- DESKTOP 1440x900 ----------------------------------------------------
console.log('\n=== DESKTOP 1440×900 ===');
await rota('/movimentacoes');
const areas1440 = await areaBtns();
ok(areas1440.includes('Estoque & Suprimentos'), 'menu principal renderiza Estoque & Suprimentos');
const ativo1440 = await page.$eval('[data-testid="top-navigation"] button[data-topnav-area="Estoque & Suprimentos"]', (b) =>
  b.getAttribute('aria-current')
);
ok(ativo1440 === 'page', 'active state da Área marcado por aria-current na rota /movimentacoes');

const semOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
ok(semOverflow, 'sem overflow horizontal em 1440');

// dropdown por clique + Escape
ok(!!(await abrirArea('Vendas')), 'dropdown abre por clique');
await fecharMenus();
ok(!(await page.$('#topnav-menu-Vendas')), 'Escape fecha o dropdown');

// clique fora
await abrirArea('Vendas');
await page.mouse.click(700, 700);
await new Promise((r) => setTimeout(r, 300));
ok(!(await page.$('#topnav-menu-Vendas')), 'clique fora fecha o dropdown');

// teclado: ArrowDown abre e foca item; setas navegam
await page.focus('[data-testid="top-navigation"] button[data-topnav-area="Vendas"]');
await page.keyboard.press('ArrowDown');
await new Promise((r) => setTimeout(r, 400));
const foco1 = await page.evaluate(() => document.activeElement?.getAttribute('role'));
ok(foco1 === 'menuitem', 'ArrowDown abre e foca o primeiro módulo');
const href1 = await page.evaluate(() => document.activeElement?.getAttribute('href'));
await page.keyboard.press('ArrowDown');
const href2 = await page.evaluate(() => document.activeElement?.getAttribute('href'));
ok(href1 !== href2, 'ArrowDown move o foco para o próximo módulo');
await page.keyboard.press('Escape');
const focoVolta = await page.evaluate(() => document.activeElement?.getAttribute('data-topnav-area'));
ok(focoVolta === 'Vendas', 'Escape devolve o foco ao botão da Área');

// dropdown dentro dos limites da tela (Área mais à direita da barra)
const areasBarra = (await areaBtns()).filter((a) => a !== '__mais__');
const ultima = areasBarra[areasBarra.length - 1];
await page.click(`[data-testid="top-navigation"] button[data-topnav-area="${ultima}"]`);
await new Promise((r) => setTimeout(r, 400));
const caixa = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="top-navigation"] [role="menu"]');
  const r = el.getBoundingClientRect();
  return { right: r.right, left: r.left, w: innerWidth };
});
ok(caixa.right <= caixa.w + 1 && caixa.left >= -1, `dropdown de "${ultima}" permanece dentro do viewport`);
await fecharMenus();

// overflow: Áreas excedentes ficam acessíveis pelo agrupador "Mais"
const temMais = (await areaBtns()).includes('__mais__');
if (temMais) {
  const menuMais = await abrirArea('Creators');
  const alcancaveis = menuMais
    ? await page.$$eval('#topnav-menu-mais button[data-topnav-area]', (els) => els.map((e) => e.getAttribute('data-topnav-area')))
    : [];
  ok(alcancaveis.includes('Creators'), 'Área transbordada acessível pelo agrupador "Mais"');
  await fecharMenus();
}

// ---- 1280x800 ------------------------------------------------------------
console.log('\n=== DESKTOP 1280×800 ===');
await page.setViewport({ width: 1280, height: 800 });
await rota('/vendas');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sem overflow horizontal em 1280');
const temMais1280 = await page.$('button[data-topnav-area="__mais__"]');
console.log(`  ℹ️  agrupador "Mais" presente em 1280: ${!!temMais1280}`);

// ---- TABLET 768x1024 -----------------------------------------------------
console.log('\n=== TABLET 768×1024 ===');
await page.setViewport({ width: 768, height: 1024 });
await rota('/vendas');
const topnavVisivelTablet = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="top-navigation"]');
  return !!el && el.getBoundingClientRect().height > 0;
});
ok(!topnavVisivelTablet, 'Top Navigation oculta no tablet (drawer assume)');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sem overflow horizontal em 768');

// ---- MOBILE 390x844 ------------------------------------------------------
console.log('\n=== MOBILE 390×844 ===');
await page.setViewport({ width: 390, height: 844 });
await rota('/vendas');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sem overflow horizontal em 390');

// ---- MOBILE 375x812 ------------------------------------------------------
console.log('\n=== MOBILE 375×812 ===');
await page.setViewport({ width: 375, height: 812 });
await rota('/produtos');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sem overflow horizontal em 375');

// ---- deep links nas 11 áreas --------------------------------------------
console.log('\n=== DEEP LINKS (11 Áreas) ===');
await page.setViewport({ width: 1440, height: 900 });
const rotas = [
  ['/', 'Meu Negócio'],
  ['/produtos', 'Cadastros'],
  ['/vendas', 'Vendas'],
  ['/movimentacoes', 'Estoque & Suprimentos'],
  ['/ordens', 'Produção'],
  ['/financeiro', 'Financeiro'],
  ['/ncm', 'Fiscal'],
  ['/empresas', 'Administração'],
  ['/conectores/mercado-livre', 'Commerce'],
  ['/creators', 'Creators'],
  ['/config', 'Utilidades Globais'],
];
for (const [path, area] of rotas) {
  await rota(path);
  const ativo = await page.evaluate((nome) => {
    const nav = document.querySelector('[data-testid="top-navigation"]');
    const btn = nav?.querySelector(`button[data-topnav-area="${nome}"]`);
    if (btn) return btn.getAttribute('aria-current');
    // Área que transbordou: o agrupador "Mais" assume o estado ativo (§17).
    return nav?.querySelector('button[data-topnav-area="__mais__"]')?.getAttribute('aria-current') === 'page' ? 'page' : null;
  }, area);
  const conteudo = await page.evaluate(() => document.querySelector('main')?.innerText?.length || 0);
  ok(ativo === 'page' && conteudo > 50, `${path} → Área ativa "${area}" e conteúdo renderizado`);
}

await browser.close();
console.log(`\n${falhas.length ? `❌ ${falhas.length} falha(s)` : '✅ TODAS AS VERIFICAÇÕES PASSARAM'}`);
process.exit(falhas.length ? 1 : 0);
