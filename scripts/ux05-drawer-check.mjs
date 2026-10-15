// UX-05 — drawer mobile/tablet + CompanySwitcher/multiempresa.
import puppeteer from 'puppeteer-core';
import { totpAgora } from './ux05-totp.mjs';

const BASE = 'http://localhost:12000';
const falhas = [];
const ok = (c, m) => {
  console.log(`  ${c ? '✅' : '❌'} ${m}`);
  if (!c) falhas.push(m);
};

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

const entrar = async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', 'admin@brobond.com.br');
  await page.type('input[type="password"]', process.env.UX05_PASS);
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 3000));
  if (page.url().includes('/login')) {
    await page.waitForSelector('input[placeholder="000000"]', { timeout: 10000 });
    await page.type('input[placeholder="000000"]', totpAgora());
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (page.url().includes('/config')) {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1500));
  }
};

await entrar();

for (const [w, h, rotulo] of [
  [768, 1024, 'TABLET 768×1024'],
  [390, 844, 'MOBILE 390×844'],
  [375, 812, 'MOBILE 375×812'],
]) {
  console.log(`\n=== ${rotulo} ===`);
  await page.setViewport({ width: w, height: h });
  await page.goto(`${BASE}/vendas`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1200));

  const estado = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="top-navigation"]');
    const navVisivel = !!nav && nav.getBoundingClientRect().height > 0 && getComputedStyle(nav).display !== 'none';
    const burger = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Abrir menu');
    return {
      navVisivel,
      burger: !!burger,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      burgerLabel: burger?.getAttribute('aria-label') || null,
    };
  });
  ok(!estado.navVisivel, 'Top Navigation oculta (drawer assume)');
  ok(estado.burger, `botão hamburger presente (${estado.burgerLabel})`);
  ok(!estado.overflow, 'sem overflow horizontal');

  if (estado.burger) {
    const sel = await page.evaluateHandle(() => {
      return [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Abrir menu');
    });
    await sel.asElement().click();
    await new Promise((r) => setTimeout(r, 700));
    const drawer = await page.evaluate(() => {
      const el = document.querySelector('[data-mobile-open]');
      const aberto = el?.getAttribute('data-mobile-open') === 'true';
      const areas = el ? [...el.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => t.length > 2) : [];
      const cs = document.querySelector('[data-testid="company-switcher"], [aria-label*="mpresa"]');
      return { aberto, temAreas: areas.length > 0, amostra: areas.slice(0, 6), cs: !!cs };
    });
    ok(drawer.aberto, 'drawer abre no mobile/tablet');
    ok(drawer.temAreas, `drawer expõe a árvore master (${drawer.amostra.join(' | ')})`);
    ok(drawer.cs, 'CompanySwitcher acessível');
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 600));
  }
}

// --- Multiempresa -----------------------------------------------------------
console.log('\n=== MULTIEMPRESA ===');
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/vendas`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1500));

const cs = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-haspopup="listbox"], button[aria-label*="mpresa"]');
  return { existe: !!btn, texto: btn?.textContent?.trim().slice(0, 80) || null };
});
ok(cs.existe, `CompanySwitcher presente no header (${cs.texto})`);

const antes = await page.evaluate(() => document.body.innerText.length);
await page.goto(`${BASE}/movimentacoes`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1500));
const ativo = await page.evaluate(() => {
  const nav = document.querySelector('[data-testid="top-navigation"]');
  return [...(nav?.querySelectorAll('button[aria-current="page"]') || [])].map((b) => b.getAttribute('data-topnav-area'));
});
ok(ativo.length > 0, `navegação preserva contexto após reload (área ativa: ${ativo.join(',')})`);
ok(antes > 0, 'conteúdo renderizado antes da troca de rota');

// Troca real de empresa (exige mais de uma empresa concedida)
const trocou = await page.evaluate(async () => {
  const btn = document.querySelector('button[aria-haspopup="listbox"], button[aria-label*="mpresa"]');
  if (!btn) return { ok: false, motivo: 'sem botão (usuário com empresa única)' };
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
  const opts = [...document.querySelectorAll('[role="option"]')];
  if (opts.length < 2) return { ok: false, motivo: `apenas ${opts.length} opção(ões) de empresa` };
  const alvo = opts[1];
  const nomeAlvo = alvo.textContent.trim().slice(0, 40);
  alvo.querySelector('button')?.click();
  await new Promise((r) => setTimeout(r, 2500));
  const nav = document.querySelector('[data-testid="top-navigation"]');
  const rotulo = document.querySelector('[aria-label*="mpresa"]')?.getAttribute('aria-label') || '';
  return { ok: !!nav, areas: nav ? nav.querySelectorAll('button[data-topnav-area]').length : 0, nomeAlvo, rotulo };
});
if (trocou.ok) {
  ok(true, `troca de empresa mantém a Top Navigation (${trocou.areas} entradas)`);
  ok(trocou.rotulo.includes(trocou.nomeAlvo.split(' ')[0]), `empresa ativa passou a ser "${trocou.nomeAlvo}"`);
  // navegação continua funcional no novo contexto
  await page.goto(`${BASE}/movimentacoes`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1800));
  const ativo2 = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="top-navigation"]');
    return [...(nav?.querySelectorAll('button[aria-current="page"]') || [])].map((b) => b.getAttribute('data-topnav-area'));
  });
  ok(ativo2.length > 0, `navegação funcional após a troca (área ativa: ${ativo2.join(',')})`);
  // restaura a empresa original para não deixar estado sujo
  await page.evaluate(async () => {
    const btn = document.querySelector('button[aria-haspopup="listbox"], button[aria-label*="mpresa"]');
    btn?.click();
    await new Promise((r) => setTimeout(r, 500));
    document.querySelectorAll('[role="option"]')[0]?.querySelector('button')?.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
} else {
  console.log(`  ℹ️  troca de empresa não exercitada: ${trocou.motivo}`);
}

await browser.close();
console.log(`\n${falhas.length ? `❌ ${falhas.length} falha(s)` : '✅ DRAWER/MULTIEMPRESA OK'}`);
process.exit(falhas.length ? 1 : 0);
