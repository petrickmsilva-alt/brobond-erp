// Ordem Final 2.4 — leitura de anúncios do Mercado Livre: SOMENTE GET, sem alterar anúncios.
// LOCAL: fetch injetado; nenhuma chamada real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const L: any = await import('../src/commerce/leituraAnunciosMercadoLivre');
const R: any = await import('../src/commerce/reconciliacaoMercadoLivre');

const TOKEN = 'fixture-token-leitura-anuncios-000';
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

function fabricaFetch(opts: { total: number; itensPorBusca?: number; falhaBusca?: number }) {
  const chamadas: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = async (url: string, init: any) => {
    chamadas.push({ url, method: init.method, body: init.body });
    if (url.includes('/items/search')) {
      if (opts.falhaBusca) return json({ message: 'nope' }, opts.falhaBusca);
      const off = Number(new URL(url).searchParams.get('offset'));
      const pagina = Array.from({ length: Math.max(0, Math.min(50, opts.total - off)) }, (_, k) => `MLB${off + k + 1}`);
      return json({ results: pagina, paging: { total: opts.total } });
    }
    const ids = new URL(url).searchParams.get('ids')!.split(',');
    return json(ids.map((id, k) => (k === 3 ? { code: 404, body: { error: 'not_found' } } : { code: 200, body: { id, seller_custom_field: k % 2 ? `SKU-${id}` : null } })));
  };
  return { chamadas, fetchImpl: fetchImpl as any };
}

test('usa somente GET, sem corpo, em busca e multiget', async () => {
  const f = fabricaFetch({ total: 60 });
  await L.lerAnunciosMercadoLivre({ token: TOKEN, sellerId: 987, fetchImpl: f.fetchImpl });
  assert.ok(f.chamadas.length > 0);
  for (const c of f.chamadas) {
    assert.equal(c.method, 'GET');
    assert.equal(c.body, undefined);
  }
});

test('paginação completa da busca e multiget em lotes de no máximo 20', async () => {
  const f = fabricaFetch({ total: 60 });
  const r = await L.lerAnunciosMercadoLivre({ token: TOKEN, sellerId: 987, fetchImpl: f.fetchImpl });
  const buscas = f.chamadas.filter((c) => c.url.includes('/items/search'));
  const multis = f.chamadas.filter((c) => c.url.includes('/items?ids='));
  assert.equal(buscas.length, 2, '60 itens em páginas de 50 = 2 buscas');
  for (const m of multis) assert.ok(new URL(m.url).searchParams.get('ids')!.split(',').length <= 20);
  assert.equal(r.total_informado, 60);
  assert.equal(r.anuncios.length + r.nao_lidos.length, 60);
});

test('o usuário da busca é o seller informado e a URL usa /users/{id}/items/search', async () => {
  const f = fabricaFetch({ total: 1 });
  await L.lerAnunciosMercadoLivre({ token: TOKEN, sellerId: 987, fetchImpl: f.fetchImpl });
  assert.ok(f.chamadas[0].url.startsWith('https://api.mercadolibre.com/users/987/items/search?'));
  assert.ok(f.chamadas[0].url.includes('status=active'));
});

test('item com código diferente de 200 vai para nao_lidos, não entra no relatório', async () => {
  const f = fabricaFetch({ total: 5 });
  const r = await L.lerAnunciosMercadoLivre({ token: TOKEN, sellerId: 987, fetchImpl: f.fetchImpl });
  assert.deepEqual(r.nao_lidos, ['MLB4']);
  assert.equal(r.anuncios.length, 4);
});

test('busca recusada lança erro sem expor o token', async () => {
  const f = fabricaFetch({ total: 5, falhaBusca: 401 });
  await assert.rejects(
    () => L.lerAnunciosMercadoLivre({ token: TOKEN, sellerId: 987, fetchImpl: f.fetchImpl }),
    (e: any) => { assert.match(e.message, /HTTP 401/); assert.ok(!e.message.includes(TOKEN)); return true; }
  );
});

test('sem token ou sem identidade numérica: falha fechada sem chamada', async () => {
  const f = fabricaFetch({ total: 5 });
  await assert.rejects(() => L.lerAnunciosMercadoLivre({ token: '', sellerId: 987, fetchImpl: f.fetchImpl }));
  await assert.rejects(() => L.lerAnunciosMercadoLivre({ token: TOKEN, sellerId: 'seller_id', fetchImpl: f.fetchImpl }));
  assert.equal(f.chamadas.length, 0);
});

test('o relatório de reconciliação sobre a leitura não altera nada (alterações e exclusões zero)', async () => {
  const f = fabricaFetch({ total: 6 });
  const lido = await L.lerAnunciosMercadoLivre({ token: TOKEN, sellerId: 987, fetchImpl: f.fetchImpl });
  const relatorio = R.reconciliarAnunciosMercadoLivre([{ produto_id: 1, sku: 'SKU-MLB2', external_id: null }], lido.anuncios);
  assert.equal(relatorio.exclusoes, 0);
  assert.equal(relatorio.alteracoes, 0);
  assert.equal(relatorio.resumo.total, relatorio.linhas.length, 'resumo consistente com as linhas');
});

test('o módulo não contém verbos de escrita nem chamadas de mutação', () => {
  const fonte = readFileSync(fileURLToPath(new URL('../src/commerce/leituraAnunciosMercadoLivre.ts', import.meta.url)), 'utf8');
  for (const verbo of ["method: 'PUT'", "method: 'POST'", "method: 'DELETE'", "method: 'PATCH'"]) assert.equal(fonte.includes(verbo), false, verbo);
});
