// Regressão P0-01 (publicação duplicada em marketplaces) e suspensão controlada
// de publicação ML/Nuvemshop. Sem rede e sem credenciais: `fetch` e o token do
// conector são substituídos por dublês em memória.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PUBLICACAO_CANAIS_LIBERADOS = 'MERCADOLIVRE';

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { dependenciasPublicacao, enfileirarPublicacao, processarPublicacao } = await import('../src/commerce/catalogo');
const s = getStore();

type Payload = Parameters<typeof enfileirarPublicacao>[3];

let seq = 0;
async function produto(sku = `P0-${++seq}`) {
  const p = await s.insert(RESOURCES.produtos, { empresa_id: 1, sku, nome: `Produto P0 ${sku}`, ativo: true, preco_venda: 50 });
  return { id: Number(p.id), sku };
}

function payloadMl(sku: string, preco = 50): Payload {
  return {
    sku, titulo: `Camiseta ${sku}`, resumo: null, descricao: 'Algodão', slug: sku.toLowerCase(), preco,
    preco_promo: null, condicao: 'novo', ativo: true, destaque: false, disponivel: 7,
    metadados: { ml_category_id: 'MLB1234' },
  } as Payload;
}

/** Dublê do Mercado Livre: cria, atualiza, busca por SKU; pode "perder" a resposta da 1ª criação. */
function fakeMercadoLivre(opcoes: { perderRespostaNaPrimeiraCriacao?: boolean } = {}) {
  const itens = new Map<string, { id: string; sku: string; price: number; available_quantity: number }>();
  const chamadas: string[] = [];
  let seq = 0;
  let perder = opcoes.perderRespostaNaPrimeiraCriacao === true;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fn = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const metodo = String(init.method || 'GET').toUpperCase();
    chamadas.push(`${metodo} ${url.hostname}${url.pathname}${url.search}`);
    if (url.hostname !== 'api.mercadolibre.com') return json(500, { message: 'host não simulado' });
    if (metodo === 'GET' && url.pathname === '/users/me') return json(200, { id: 999 });
    if (metodo === 'GET' && url.pathname === '/users/999/items/search') {
      const sku = url.searchParams.get('seller_sku');
      return json(200, { results: [...itens.values()].filter((i) => i.sku === sku).map((i) => i.id) });
    }
    if (metodo === 'POST' && url.pathname === '/items') {
      const body = JSON.parse(String(init.body));
      const id = `MLB${++seq}`;
      itens.set(id, { id, sku: String(body.seller_custom_field ?? ''), price: body.price, available_quantity: body.available_quantity });
      if (perder) {
        perder = false;
        return json(504, { message: 'gateway timeout' }); // anúncio criado, resposta perdida
      }
      return json(201, { id });
    }
    const alvo = url.pathname.match(/^\/items\/(MLB\d+)$/);
    if (metodo === 'PUT' && alvo) {
      const item = itens.get(alvo[1]);
      if (!item) return json(404, { message: 'item não encontrado' });
      const body = JSON.parse(String(init.body));
      if (body.price !== undefined) item.price = body.price;
      if (body.available_quantity !== undefined) item.available_quantity = body.available_quantity;
      return json(200, { id: item.id });
    }
    return json(404, { message: 'rota não simulada' });
  };
  return { fetch: fn, itens, chamadas };
}

function tokenFalso(t: { after: (fn: () => void) => void }) {
  const original = dependenciasPublicacao.obterTokenCanal;
  dependenciasPublicacao.obterTokenCanal = async () => ({ accessToken: 'TOKEN-FALSO-TESTE', shopId: '4242' });
  t.after(() => { dependenciasPublicacao.obterTokenCanal = original; });
}

const linha = async (id: number) => (await s.get(RESOURCES.commerce_publicacoes, id))!;

test('P0-01: editar produto já publicado atualiza o anúncio existente (PUT) e não cria duplicata', async (t) => {
  tokenFalso(t);
  const ml = fakeMercadoLivre();
  t.mock.method(globalThis, 'fetch', ml.fetch);
  const p = await produto();
  const primeira = await enfileirarPublicacao(1, p.id, 'MERCADOLIVRE', payloadMl(p.sku, 50), null);
  assert.equal(await processarPublicacao(await linha(Number(primeira.id))), 'processada');
  assert.equal((await linha(Number(primeira.id))).external_id, 'MLB1');

  const edicao = await enfileirarPublicacao(1, p.id, 'MERCADOLIVRE', payloadMl(p.sku, 60), null);
  assert.equal(edicao.external_id, 'MLB1', 'nova versão deve herdar o vínculo com o anúncio publicado');
  assert.equal(await processarPublicacao(await linha(Number(edicao.id))), 'processada');

  assert.equal(ml.itens.size, 1, 'não pode existir segundo anúncio');
  assert.equal(ml.itens.get('MLB1')?.price, 60);
  assert.ok(ml.chamadas.some((c) => c.startsWith('PUT api.mercadolibre.com/items/MLB1')));
});

test('P0-01: retry após timeout (anúncio criado, resposta perdida) não duplica o anúncio', async (t) => {
  tokenFalso(t);
  const ml = fakeMercadoLivre({ perderRespostaNaPrimeiraCriacao: true });
  t.mock.method(globalThis, 'fetch', ml.fetch);
  const p = await produto();
  const row = await enfileirarPublicacao(1, p.id, 'MERCADOLIVRE', payloadMl(p.sku), null);
  assert.equal(await processarPublicacao(await linha(Number(row.id))), 'falhou');
  assert.equal((await linha(Number(row.id))).estado, 'ERROR');
  assert.equal(ml.itens.size, 1, 'a 1ª tentativa criou o anúncio no provedor');

  await s.update(RESOURCES.commerce_publicacoes, Number(row.id), { proxima_tentativa_em: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await processarPublicacao(await linha(Number(row.id))), 'processada');
  assert.equal(ml.itens.size, 1, 'retry deve localizar o anúncio pelo SKU e não criar outro');
  assert.equal((await linha(Number(row.id))).external_id, 'MLB1');
});

test('P0-01: publicar sem SKU é recusado antes de qualquer chamada ao canal', async (t) => {
  tokenFalso(t);
  const ml = fakeMercadoLivre();
  t.mock.method(globalThis, 'fetch', ml.fetch);
  const p = await produto();
  const row = await enfileirarPublicacao(1, p.id, 'MERCADOLIVRE', payloadMl(''), null);
  assert.equal(await processarPublicacao(await linha(Number(row.id))), 'rejeitada');
  assert.equal((await linha(Number(row.id))).estado, 'REJECTED');
  assert.equal(ml.chamadas.length, 0);
});

test('suspensão: sem liberação explícita, ML não recebe chamada e a linha permanece na fila com o vínculo', async (t) => {
  tokenFalso(t);
  const ml = fakeMercadoLivre();
  t.mock.method(globalThis, 'fetch', ml.fetch);
  const p = await produto();
  const original = process.env.PUBLICACAO_CANAIS_LIBERADOS;
  delete process.env.PUBLICACAO_CANAIS_LIBERADOS;
  try {
    const row = await enfileirarPublicacao(1, p.id, 'MERCADOLIVRE', payloadMl(p.sku), null);
    assert.equal(await processarPublicacao(await linha(Number(row.id))), 'ignorada');
    assert.equal((await linha(Number(row.id))).estado, 'QUEUED');
    assert.equal(ml.chamadas.length, 0);
  } finally {
    if (original === undefined) delete process.env.PUBLICACAO_CANAIS_LIBERADOS; else process.env.PUBLICACAO_CANAIS_LIBERADOS = original;
  }
});

test('Nuvemshop liberada: publicação usa o contrato 2025-03 e nunca o v1 (decisão (b) aprovada)', async (t) => {
  // Antes da migração este teste exigia recusa sem HTTP (stub desligado). Requisito atualizado:
  // com a Nuvemshop liberada, a chamada vai à base 2025-03. Resposta sem identificador
  // verificável NÃO é tratada como sucesso nem repetida: fica 'falhou'.
  tokenFalso(t);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown) => { calls.push(String(input)); return new Response('{}', { status: 201 }); });
  const original = process.env.PUBLICACAO_CANAIS_LIBERADOS;
  process.env.PUBLICACAO_CANAIS_LIBERADOS = 'MERCADOLIVRE,NUVEMSHOP';
  // Ordem Final 2.5: gancho de TESTE liga o contrato 2025-03 com dublê de rede (produção segue bloqueada).
  const escritaOriginal = dependenciasPublicacao.nuvemshopEvidenciaOficialEscrita;
  dependenciasPublicacao.nuvemshopEvidenciaOficialEscrita = true;
  try {
    const p = await produto();
    const row = await enfileirarPublicacao(1, p.id, 'NUVEMSHOP', payloadMl(p.sku), null);
    assert.equal(await processarPublicacao(await linha(Number(row.id))), 'falhou');
    assert.ok(calls.length > 0);
    assert.ok(calls.every((u) => u.startsWith('https://api.tiendanube.com/2025-03/')), calls.join(' | '));
    assert.ok(calls.every((u) => !u.includes('nuvemshop.com.br') && !u.includes('/v1/')));
    assert.equal(calls.filter((u) => u.endsWith('/products')).length, 1, 'no máximo um cadastro por tentativa');
  } finally {
    dependenciasPublicacao.nuvemshopEvidenciaOficialEscrita = escritaOriginal;
    if (original === undefined) delete process.env.PUBLICACAO_CANAIS_LIBERADOS; else process.env.PUBLICACAO_CANAIS_LIBERADOS = original;
  }
});
