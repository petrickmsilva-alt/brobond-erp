// UX-05 — teste de RBAC da Master Top Navigation (ADMIN/GERENTE/OPERADOR).
// Uso: node scripts/ux05-rbac-check.mjs [baseURL]
//
// Este script depende de FIXTURES provisionadas (perfis gerente/operador e as
// expectativas de módulos proibidos em UX05_ESPERADO). Sem elas não há o que
// verificar — por isso aborta em vez de reportar sucesso vazio.
import puppeteer from 'puppeteer-core';
import { totpAgora } from './ux05-totp.mjs';

const BASE = process.argv[2] || process.env.UX05_BASE || 'http://localhost:12000';
const falhas = [];

const esperado = JSON.parse(process.env.UX05_ESPERADO || '{}');
// Sem expectativas não existe verificação: falhar alto evita um "RBAC OK" falso.
const perfisEsperados = Object.keys(esperado);
if (!perfisEsperados.length) {
  console.error(
    '❌ UX05_ESPERADO ausente/vazio. Rode `node scripts/ux05-fixtures.mjs` e exporte as\n' +
      '   variáveis que ele imprime (contém os módulos proibidos por perfil).'
  );
  process.exit(1);
}

const ok = (c, m) => {
  console.log(`  ${c ? '✅' : '❌'} ${m}`);
  if (!c) falhas.push(m);
};

const PERFIS = [
  { nome: 'ADMIN', email: 'admin@brobond.com.br', senha: process.env.UX05_PASS },
  { nome: 'GERENTE', email: 'gerente@brobond.com.br', senha: process.env.UX05_SENHA_GERENTE },
  { nome: 'OPERADOR', email: 'operador@brobond.com.br', senha: process.env.UX05_SENHA_OPERADOR },
];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const p of PERFIS) {
  console.log(`\n=== ${p.nome} (${p.email}) ===`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // Sessão anterior (outro perfil) não pode vazar: o token vive em localStorage,
  // que é compartilhado por origem entre as abas do mesmo navegador.
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  const client = await page.createCDPSession();
  await client.send('Network.clearBrowserCookies');
  await client.send('Network.clearBrowserCache');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.type('input[type="email"]', p.email);
  await page.type('input[type="password"]', p.senha);
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 3000));

  // MFA (só admin, e já ativado → apenas código). Código gerado agora.
  if (page.url().includes('/login')) {
    const totp = totpAgora();
    if (totp) {
      await page.waitForSelector('input[placeholder="000000"]', { timeout: 8000 }).catch(() => null);
      await page.type('input[placeholder="000000"]', totp);
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Login pode falhar (senha provisória já trocada, conta bloqueada etc.).
  if (page.url().includes('/login')) {
    const erro = await page.evaluate(() => document.body.innerText.slice(0, 300));
    ok(false, `${p.nome}: login falhou — ${erro.replace(/\n+/g, ' | ').slice(0, 160)}`);
    await page.close();
    continue;
  }

  // Senha provisória → troca obrigatória (comportamento pré-existente).
  // A política rejeita senha que contenha o e-mail, então usamos uma senha neutra.
  if (page.url().includes('/config')) {
    const novo = process.env.UX05_SENHA_NOVA || p.senha;
    const campos = await page.$$('input[type="password"]');
    if (campos.length >= 3) {
      await campos[0].type(p.senha);
      await campos[1].type(novo);
      await campos[2].type(novo);
      const salvar = await page.$$('button');
      for (const b of salvar) {
        const t = await page.evaluate((el) => el.textContent, b);
        if (t && t.includes('Salvar nova senha')) {
          await b.click();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2500));
      p.senha = novo;
      console.log('  ℹ️  senha provisória trocada');
    }
  }

  await page.goto(`${BASE}/vendas`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1500));

  const info = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="top-navigation"]');
    if (!nav) return null;
    const areas = [...nav.querySelectorAll('button[data-topnav-area]')].map((b) => b.getAttribute('data-topnav-area'));
    // módulos oferecidos por TODOS os dropdowns (barra + Mais), respeitando RBAC
    const links = [...nav.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    return { areas, links, hrefs: [...new Set(links)] };
  });

  if (!info) {
    ok(false, 'Top Navigation renderizada');
    await page.close();
    continue;
  }
  console.log('  Áreas:', info.areas.filter((a) => a !== '__mais__').join(', '));

  const proibidos = esperado[p.nome]?.proibidos || [];
  for (const rota of proibidos) {
    ok(!info.hrefs.includes(rota), `módulo proibido ${rota} ausente do menu`);
  }

  // deep link proibido continua protegido: o guard de rota redireciona para "/"
  // (App.tsx → ModuleAccess/AdminOnly), então a URL não permanece no módulo.
  for (const rota of proibidos) {
    await page.goto(`${BASE}${rota}`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1500));
    const final = new URL(page.url()).pathname;
    ok(final === '/', `deep link proibido ${rota} redireciona para "/" (bloqueado)`);
  }

  // Command Palette não revela módulo proibido
  await page.goto(`${BASE}/vendas`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1200));
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 600));
  for (const rota of proibidos) {
    const termo = rota.replace(/^\//, '').split('/')[0];
    await page.keyboard.type(termo);
    await new Promise((r) => setTimeout(r, 600));
    const achou = await page.evaluate((r) => !!document.querySelector(`a[href="${r}"]`), rota);
    ok(!achou, `Command Palette não revela ${rota}`);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise((r) => setTimeout(r, 300));
  }
  await page.keyboard.press('Escape');

  await page.close();
}

await browser.close();
console.log(`\n${falhas.length ? `❌ ${falhas.length} falha(s)` : '✅ RBAC OK'}`);
process.exit(falhas.length ? 1 : 0);
