import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const { aplicarMetas, escaparHtml, jsonLdSeguro } = await import('../src/commerce/storefront-seo');

const TEMPLATE = '<!doctype html><html><head><meta charset="UTF-8" /><title>BROBOND</title><meta name="description" content="genérico" /></head><body><div id="root"></div></body></html>';

test('SEO: escaparHtml neutraliza aspas, tags e &', () => {
  assert.equal(escaparHtml(`COTTON "B" <script>&'`), 'COTTON &quot;B&quot; &lt;script&gt;&amp;&#39;');
  assert.equal(escaparHtml(null), '');
});

test('SEO: JSON-LD nunca fecha o <script> nem injeta HTML', () => {
  const out = jsonLdSeguro({ name: '</script><script>alert(1)</script>', sku: 'A"B' });
  assert.ok(!out.includes('</script>') && !out.includes('<'));
  assert.deepEqual(JSON.parse(out), { name: '</script><script>alert(1)</script>', sku: 'A"B' });
});

test('SEO: aplicarMetas troca title/description e injeta canonical, robots, og e JSON-LD', () => {
  const html = aplicarMetas(TEMPLATE, {
    titulo: 'COTTON "B" — Loja', descricao: 'Camiseta <b>premium</b>', canonical: 'https://loja.example/loja/produto/cotton-b',
    indexavel: true, og: { tipo: 'product', imagem: 'https://loja.example/uploads/a.jpg' }, jsonLd: { '@type': 'Product' },
  });
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.match(html, /<title>COTTON &quot;B&quot; — Loja<\/title>/);
  assert.equal((html.match(/name="description"/g) || []).length, 1, 'description genérica foi substituída');
  assert.match(html, /content="Camiseta &lt;b&gt;premium&lt;\/b&gt;"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/loja\.example\/loja\/produto\/cotton-b" \/>/);
  assert.match(html, /name="robots" content="index,follow"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /<div id="root"><\/div>/, 'o SPA continua montável');
});

test('SEO: página não indexável recebe noindex', () => {
  const html = aplicarMetas(TEMPLATE, { titulo: 'Produto não encontrado', descricao: 'x', canonical: 'https://l.example/loja', indexavel: false });
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.ok(!html.includes('application/ld+json'));
});
