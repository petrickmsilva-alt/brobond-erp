// Fluxo completo da publicação Nuvemshop (contrato 2025-03) pela fila de
// publicação. LOCAL: fetch simulado, token falso, sem rede e sem credencial real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PUBLICACAO_CANAIS_LIBERADOS = 'NUVEMSHOP';

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { dependenciasPublicacao, enfileirarPublicacao, processarPublicacao } = await import('../src/commerce/catalogo');
const s = getStore();

type Payload = Parameters<typeof enfileirarPublicacao>[3];
let seq = 0;
const linha = async (id: number) => (await s.get(RESOURCES.commerce_publicacoes, id))!;

async function produto(sku = `NV-${++seq}`) {
  const p = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku, nome: `Produto ${sku}`, ativo: true, preco_venda: 80 });
  return { id: Number(p.id), sku };
}

function payload(sku: string, preco = 80, disponivel = 4): Payload {
  return {
    sku, titulo: `Tênis ${sku}`, resumo: null, descricao: 'Couro', slug: sku.toLowerCase(), preco,
    preco_promo: null, condicao: 'novo', ativo: true, destaque: false, disponivel, metadados: {},
  } as Payload;
}

/** Dublê da Nuvemshop 2025-03: registra cada chamada e mantém os produtos criados. */
function fakeNuvemshop() {
  const produtos = new Map<string, { id: number; variantId: number; sku: string }>();
  const chamadas: Array<{ metodo: string; url: string; corpo: any; headers: Record<string, string> }> = [];
  let seq = 500;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fn = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const metodo = String(init.method || 'GET').toUpperCase();
    chamadas.push({
      metodo, url: `${url.hostname}${url.pathname}`,
      corpo: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init.headers || {}) as Record<string, string>,
    });
    if (url.hostname !== 'api.tiendanube.com') return json(500, { message: 'host não simulado' });
    const sku = url.pathname.match(/^\/2025-03\/\d+\/products\/sku\/(.+)$/);
    if (metodo === 'GET' && sku) {
      const achado = produtos.get(decodeURIComponent(sku[1]));
      return achado ? json(200, { id: achado.id, variants: [{ id: achado.variantId, sku: achado.sku }] }) : json(404, {});
    }
    if (metodo === 'POST' && url.pathname === '/2025-03/4242/products') {
      const corpo = JSON.parse(String(init.body));
      const v = corpo.variants[0];
      const id = ++seq;
      const variantId = ++seq;
      produtos.set(v.sku, { id, variantId, sku: v.sku });
      return json(201, { id, variants: [{ id: variantId, sku: v.sku }] });
    }
    if (metodo === 'PATCH' && url.pathname === '/2025-03/4242/products/stock-price') {
      const corpo = JSON.parse(String(init.body));
      return json(200, corpo.map((p: any) => ({ id: p.id, variants: p.variants.map((v: any) => ({ id: v.id, success: true })) })));
    }
    return json(404, {});
  };
  return { fn, chamadas, produtos };
}

test('liberada: primeira publicação cria no 2025-03 e grava o vínculo "produto:variante"', async (t) => {
  const original = dependenciasPublicacao.obterTokenCanal;
  dependenciasPublicacao.obterTokenCanal = async () => ({ accessToken: 'TOKEN-FALSO-TESTE', shopId: '4242' });
  t.after(() => { dependenciasPublicacao.obterTokenCanal = original; });
  const nv = fakeNuvemshop();
  t.mock.method(globalThis, 'fetch', nv.fn);

  const p = await produto();
  const row = await enfileirarPublicacao(1, p.id, 'NUVEMSHOP', payload(p.sku), null);
  assert.equal(await processarPublicacao(await linha(Number(row.id))), 'processada');
  const gravada = await linha(Number(row.id));
  assert.match(String(gravada.external_id), /^\d+:\d+$/);

  const criacao = nv.chamadas.find((c) => c.metodo === 'POST')!;
  assert.equal(criacao.url, 'api.tiendanube.com/2025-03/4242/products');
  assert.equal(criacao.headers.Authorization, 'Bearer TOKEN-FALSO-TESTE');
  assert.ok(criacao.headers['User-Agent'], 'User-Agent é obrigatório na plataforma');
  assert.ok(nv.chamadas.every((c) => !c.url.includes('nuvemshop.com.br') && !c.url.includes('/v1/')));
});

test('edição posterior atualiza pelo vínculo (PATCH) e não cria outro produto', async (t) => {
  const original = dependenciasPublicacao.obterTokenCanal;
  dependenciasPublicacao.obterTokenCanal = async () => ({ accessToken: 'TOKEN-FALSO-TESTE', shopId: '4242' });
  t.after(() => { dependenciasPublicacao.obterTokenCanal = original; });
  const nv = fakeNuvemshop();
  t.mock.method(globalThis, 'fetch', nv.fn);

  const p = await produto();
  const primeira = await enfileirarPublicacao(1, p.id, 'NUVEMSHOP', payload(p.sku, 80, 4), null);
  assert.equal(await processarPublicacao(await linha(Number(primeira.id))), 'processada');
  nv.chamadas.length = 0;

  const edicao = await enfileirarPublicacao(1, p.id, 'NUVEMSHOP', payload(p.sku, 95, 2), null);
  assert.equal(await processarPublicacao(await linha(Number(edicao.id))), 'processada');
  assert.ok(!nv.chamadas.some((c) => c.metodo === 'POST'), 'edição não pode criar');
  const patch = nv.chamadas.find((c) => c.metodo === 'PATCH')!;
  assert.equal(patch.corpo[0].variants[0].price, '95.00');
  assert.equal(patch.corpo[0].variants[0].inventory_levels[0].stock, 2);
});

test('suspensa (sem NUVEMSHOP em PUBLICACAO_CANAIS_LIBERADOS): nada é enviado ao provedor', async (t) => {
  const anterior = process.env.PUBLICACAO_CANAIS_LIBERADOS;
  process.env.PUBLICACAO_CANAIS_LIBERADOS = 'MERCADOLIVRE';
  t.after(() => { process.env.PUBLICACAO_CANAIS_LIBERADOS = anterior; });
  const nv = fakeNuvemshop();
  t.mock.method(globalThis, 'fetch', nv.fn);

  const p = await produto();
  const row = await enfileirarPublicacao(1, p.id, 'NUVEMSHOP', payload(p.sku), null);
  assert.equal(await processarPublicacao(await linha(Number(row.id))), 'ignorada');
  assert.equal(nv.chamadas.length, 0);
});
