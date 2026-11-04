// Ordem Final 2.5 — Nuvemshop 2025-03: escrita BLOQUEADA sem evidência oficial dos endpoints.
// LOCAL: fetch simulado que registra chamadas. Nenhuma chamada à loja, nenhuma credencial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const P: any = await import('../src/commerce/publicacaoNuvemshop');
const ler = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const item = { sku: 'SKU-1', titulo: 'Produto', preco: 10, disponivel: 3 };
function espiao() {
  const chamadas: Array<{ url: string; method: string }> = [];
  const fn = async (url: string, init: any) => { chamadas.push({ url, method: init?.method ?? 'GET' }); return new Response('{}', { status: 200 }); };
  return { chamadas, fn: fn as any };
}

test('a constante de liberação está fechada (false) no código', () => {
  assert.equal(P.ESCRITA_NUVEMSHOP_2025_LIBERADA, false);
});

test('sem o contrato de teste, publicar falha ANTES de qualquer chamada (inclusive GET por SKU)', async () => {
  for (const vinculo of [null, '555:777']) {
    const e = espiao();
    await assert.rejects(
      () => P.publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App (x@y.com)', fetch: e.fn }, item, vinculo),
      (err: any) => { assert.match(err.message, /bloqueada/); assert.equal(err.rejeitada, true, 'bloqueio não deve ser repetido às cegas'); return true; }
    );
    assert.equal(e.chamadas.length, 0, 'zero chamadas à loja');
  }
});

test('evidenciaOficialEscrita diferente de true (ex.: "true" em texto) continua bloqueado', async () => {
  const e = espiao();
  await assert.rejects(() => P.publicarItemNuvemshop({ accessToken: 'tok', storeId: '9001', userAgent: 'App', evidenciaOficialEscrita: 'true' as any, fetch: e.fn }, item, null));
  assert.equal(e.chamadas.length, 0);
});

test('produção: catalogo.ts mantém o gancho em false e não liga o contrato de teste', () => {
  const fonte = ler('../src/commerce/catalogo.ts');
  assert.match(fonte, /nuvemshopEvidenciaOficialEscrita: false,/);
  assert.match(fonte, /userAgent: userAgentNuvemshop\(\), evidenciaOficialEscrita: dependenciasPublicacao\.nuvemshopEvidenciaOficialEscrita \}/);
  assert.equal(/nuvemshopEvidenciaOficialEscrita\s*=\s*true/.test(fonte), false, 'produção não liga o gancho');
});

test('nenhum outro módulo de produção liga o contrato de teste', () => {
  const raiz = fileURLToPath(new URL('../src', import.meta.url));
  const achados: string[] = [];
  const visitar = (d: string) => {
    for (const nome of readdirSync(d)) {
      const c = join(d, nome);
      if (statSync(c).isDirectory()) visitar(c);
      else if (c.endsWith('.ts') && readFileSync(c, 'utf8').includes('evidenciaOficialEscrita')) achados.push(c);
    }
  };
  visitar(raiz);
  assert.deepEqual(achados.map((a) => a.split('/src/')[1]).sort(), ['commerce/catalogo.ts', 'commerce/publicacaoNuvemshop.ts']);
});
