// ============================================================================
// ADR-0007 — RETIRADA DA LOJA PÚBLICA NATIVA `/loja` (executada).
//
// A decisão do Diretor (ADR-0007) é RETIRAR a loja pública nativa `/loja` e
// deixar a RETAIL WooCommerce como única loja pública de varejo. Esta missão
// EXECUTOU a retirada. Este teste trava a coerência do estado FINAL:
//   1. nenhuma superfície pública nativa (`/api/loja/*`, rotas SPA `/loja`);
//   2. os módulos exclusivos da vitrine foram REMOVIDOS;
//   3. os serviços COMPARTILHADOS permanecem (pedidos, cliente, frete, Payment
//      Engine, WooCommerce);
//   4. as URLs antigas têm tratamento explícito (301/410), nunca 200 enganoso.
//
// Não valida DNS, SEO externo nem o fluxo RETAIL (fora do escopo desta missão).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const raiz = new URL('../../', import.meta.url);
const ler = (relativo: string) => readFileSync(new URL(relativo, raiz), 'utf8');
const existe = (relativo: string) => existsSync(new URL(relativo, raiz));

test('a superfície pública nativa foi retirada (rotas /api/loja/* e SPA /loja)', () => {
  const index = ler('server/src/index.ts');
  for (const rota of [
    "'/api/loja/config'",
    "'/api/loja/produtos'",
    "'/api/loja/produtos/:slug'",
    "'/api/loja/preview'",
    "'/api/loja/carrinho/quantidade'",
    "'/api/loja/payment-methods'",
    "'/api/loja/checkout'",
    "'/api/loja/checkout/:chave'",
    "'/api/loja/pedidos/:token'",
    "'/api/commerce/checkout/payment-intent'",
    "'/api/commerce/loja/estado'",
  ]) {
    assert.ok(!index.includes(rota), `rota ${rota} deveria ter sido retirada (ADR-0007)`);
  }

  const app = ler('client/src/App.tsx');
  for (const rota of ['/loja', '/loja/produto/:slug', '/loja/carrinho', '/loja/checkout', '/loja/pedido/:token']) {
    assert.ok(!app.includes(`path="${rota}"`), `rota SPA ${rota} deveria ter sido retirada`);
  }
});

test('os módulos exclusivos da vitrine nativa foram removidos', () => {
  for (const arquivo of [
    'server/src/commerce/vitrine.ts',
    'server/src/commerce/estado-loja.ts',
    'server/src/commerce/loja-base.ts',
    'server/src/commerce/quantidade-carrinho.ts',
    'server/src/commerce/storefront-seo.ts',
    'client/src/pages/commerce/LojaConfigPage.tsx',
    'client/src/pages/commerce/loja/LojaCheckoutPage.tsx',
    'client/src/pages/commerce/loja/LojaInicioPage.tsx',
  ]) {
    assert.ok(!existe(arquivo), `${arquivo} deveria ter sido removido`);
  }
});

test('os serviços compartilhados permanecem (não removidos)', () => {
  for (const arquivo of [
    'server/src/commerce/pedidos.ts',
    'server/src/commerce/cliente.ts',
    'server/src/commerce/frete.ts',
    'server/src/commerce/pagamento-ambiente.ts',
    'server/src/commerce/woocommerce/registry.ts',
  ]) {
    assert.ok(existe(arquivo), `${arquivo} deveria existir (serviço compartilhado)`);
  }
});

test('as URLs antigas da loja nativa têm tratamento explícito (301/410)', () => {
  const retirada = ler('server/src/commerce/loja-nativa-retirada.ts');
  assert.match(retirada, /410/, 'caminhos sem equivalente respondem 410 Gone');
  assert.match(retirada, /redirect\(301/, 'caminho com equivalente redireciona 301 quando STOREFRONT_REDIRECT_URL existe');
  const index = ler('server/src/index.ts');
  assert.match(index, /lojaNativaRetirada/, 'o servidor usa o handler das URLs antigas antes do SPA');
});

test('o menu não expõe mais a Loja própria nem o atalho Abrir Loja', () => {
  const modules = ler('client/src/modules.ts');
  assert.doesNotMatch(modules, /id: 'commerce-loja'/, 'módulo Loja própria retirado do menu');
  assert.doesNotMatch(modules, /id: 'commerce-abrir-loja'/, 'atalho Abrir Loja retirado do menu');
  assert.doesNotMatch(modules, /path: '\/loja'/, 'nenhum item de menu aponta para /loja');
});

test('a RETAIL WooCommerce é preservada como canal de varejo', () => {
  const registry = ler('server/src/commerce/woocommerce/registry.ts');
  assert.match(registry, /'RETAIL'/, 'RETAIL preservada');
  assert.match(registry, /'WHOLESALE'/, 'WHOLESALE preservada');
});

test('a documentação registra a retirada como EXECUTADA (coerência com o estado real)', () => {
  const relatorio = ler('docs/architecture/NATIVE-STORE-DECOMMISSION-REPORT.md');
  assert.match(relatorio, /EXECUTAD/i, 'o relatório deve declarar a retirada como executada');
});

test('ADR-0007 registra a decisão como Aceita', () => {
  const adr = ler('docs/architecture/ADR/ADR-0007-descontinuacao-loja-nativa.md');
  assert.match(adr, /Status:\*\*\s*\*\*Aceita/i, 'ADR-0007 deve estar Aceita');
});
