// ============================================================================
// POST /api/loja/carrinho/quantidade — validação server-side e TENANCY REAL.
//
// Roda com o store em memória (sem DATABASE_URL): prova o endpoint de mutação
// de quantidade de ponta a ponta com Express de verdade — quantidade inválida
// (0, negativo, decimal, NaN, ±Infinity, string, null, undefined, objeto,
// array, boolean) → 400; estoque → 409 com mensagem; produto de OUTRA EMPRESA
// → mesma recusa genérica, sem vazar nome/SKU/estoque; corpo com `empresa_id`,
// `total`, `unit_price`, `discount`, `freight` é IGNORADO.
//
// A prova com PostgreSQL real (reserva/estoque/tenancy em banco) está em
// test/pg/commerce-cart.test.ts e exige DATABASE_URL.
// ============================================================================
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.COMMERCE_LOJA_EMPRESA_ID = '1';

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const vitrine = await import('../src/commerce/vitrine');
const { quantidadeValida, validarCorpoQuantidade, QUANTIDADE_MAXIMA_CARRINHO } = await import('../src/commerce/quantidade-carrinho');

const s = getStore();
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};
const app = express();
app.use(express.json());
app.post('/api/loja/preview', wrap(vitrine.lojaPreview));
app.post('/api/loja/carrinho/quantidade', wrap(vitrine.lojaAtualizarQuantidade));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status || 500).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
});

let produtoA = 0;
let produtoB = 0;

async function semear() {
  await s.insert(RESOURCES.commerce_configuracoes, {
    empresa_id: 1,
    loja_nome: 'Loja A (teste quantidade)',
    frete_provedor: 'retirada',
    frete_valor: 0,
    checkout_expira_minutos: 60,
  });
  const criar = async (empresaId: number, sku: string, nome: string) => {
    const p = await s.insert(RESOURCES.produtos, { empresa_id: empresaId, sku, nome, preco_venda: 80, ativo: true });
    const id = Number(p.id);
    await s.insert(RESOURCES.commerce_produtos, { empresa_id: empresaId, produto_id: id, slug: sku.toLowerCase() });
    await s.insert(RESOURCES.commerce_publicacoes, { empresa_id: empresaId, produto_id: id, canal: 'BROBOND', estado: 'PUBLISHED', versao: 1 });
    await s.insert(RESOURCES.estoques, { empresa_id: empresaId, produto_id: id, local_id: 1, local: 'Acabados', quantidade: 8 });
    return id;
  };
  produtoA = await criar(1, 'CART-QTD-A', 'Produto da empresa A');
  produtoB = await criar(2, 'CART-QTD-B', 'SEGREDO-EMPRESA-B');
}

const corpo = (quantidade: unknown, extra: Record<string, unknown> = {}) => ({
  alvo: { produto_id: produtoA, tamanho_id: null, quantidade },
  itens: [{ produto_id: produtoA, tamanho_id: null, quantidade }],
  ...extra,
});

describe('validação pura de quantidade (sem banco)', () => {
  test('aceita SOMENTE inteiro positivo 1..99; rejeita todos os demais tipos', () => {
    for (const ruim of [0, -1, -99, 1.5, 0.0001, NaN, Infinity, -Infinity, '2', 'abc', '', '1e3', null, undefined, {}, [], [2], true, false, 100, 1e100]) {
      assert.equal(quantidadeValida(ruim), null, `quantidade inválida aceita: ${String(ruim)}`);
    }
    for (const bom of [1, 2, 8, 99]) assert.equal(quantidadeValida(bom), bom);
    assert.equal(QUANTIDADE_MAXIMA_CARRINHO, 99);
  });

  test('o corpo saneado NUNCA contém tenant ou valores monetários do browser', () => {
    const validado = validarCorpoQuantidade({
      alvo: { produto_id: 7, tamanho_id: null, quantidade: 3, empresa_id: 999, total: 1, unit_price: 1 },
      itens: [{ produto_id: 7, tamanho_id: null, quantidade: 3, unit_price: 1, discount: 1, freight: 1 }],
      empresa_id: 999,
      total: 1,
      unit_price: 1,
      discount: 1,
      freight: 1,
      preco: 1,
    });
    assert.deepEqual(validado, {
      alvo: { produto_id: 7, tamanho_id: null, quantidade: 3 },
      itens: [{ produto_id: 7, tamanho_id: null, quantidade: 3 }],
      cupom: '',
    });
    assert.ok(!JSON.stringify(validado).match(/empresa|total|price|discount|freight|preco/i));
  });

  test('alvo precisa existir no carrinho proposto, com a MESMA quantidade', () => {
    assert.throws(() => validarCorpoQuantidade({
      alvo: { produto_id: 7, tamanho_id: null, quantidade: 3 },
      itens: [{ produto_id: 7, tamanho_id: null, quantidade: 2 }],
    }), (e: any) => e.status === 400);
    assert.throws(() => validarCorpoQuantidade({ alvo: { produto_id: 7, quantidade: 2 }, itens: [] }), (e: any) => e.status === 400);
    assert.throws(() => validarCorpoQuantidade({
      alvo: { produto_id: 7, quantidade: 2 },
      itens: [{ produto_id: 7, quantidade: 2 }, { produto_id: 7, quantidade: 2 }],
    }), (e: any) => e.status === 400);
  });
});

describe('POST /api/loja/carrinho/quantidade (HTTP real, store em memória)', () => {
  test('confirma 1 → 2 → 3 → 2 e devolve cotação autoritativa com preço/desconto/frete/total', async () => {
    await semear();
    for (const qtd of [2, 3, 2]) {
      const r = await request(app).post('/api/loja/carrinho/quantidade').send(corpo(qtd)).expect(200);
      assert.equal(r.body.quantidade, qtd);
      assert.equal(r.body.produto_id, produtoA);
      assert.equal(r.body.tamanho_id, null);
      assert.equal(r.body.disponivel, 8);
      assert.equal(r.body.cotacao.itens[0].preco_unitario, 80);
      assert.equal(r.body.cotacao.totais.subtotal, 80 * qtd);
      assert.equal(r.body.cotacao.totais.total, 80 * qtd);
      assert.equal(r.body.cotacao.cupom, null);
      assert.equal(r.body.cotacao.frete.disponivel, true);
    }
  });

  test('quantidade inválida → 400 no endpoint E no preview (sem coerção de tipo)', async () => {
    for (const ruim of [0, -1, 1.5, '2', 'abc', null, undefined, {}, [], [2], true, 100, NaN, Infinity, -Infinity]) {
      const c = corpo(ruim);
      const r = await request(app).post('/api/loja/carrinho/quantidade').send(c);
      assert.equal(r.status, 400, `quantidade ${String(ruim)} deveria ser 400 (foi ${r.status})`);
      const p = await request(app).post('/api/loja/preview').send({ itens: c.itens });
      assert.equal(p.status, 400, `preview aceitou quantidade ${String(ruim)}`);
    }
  });

  test('estoque REAL do servidor: 9 unidades com 8 disponíveis → 409 "Só há 8 unidades disponíveis."', async () => {
    const r = await request(app).post('/api/loja/carrinho/quantidade').send(corpo(9)).expect(409);
    assert.equal(r.body.error, 'Só há 8 unidades disponíveis.');
    assert.equal(r.body.details.disponivel, 8);
    // O endpoint nunca confirma quantidade acima do estoque.
    assert.equal(r.body.quantidade, undefined);
  });

  test('TENANCY: produto da empresa B não é alterável pela loja da empresa A (sem vazar dados)', async () => {
    const r = await request(app).post('/api/loja/carrinho/quantidade').send({
      alvo: { produto_id: produtoB, tamanho_id: null, quantidade: 2 },
      itens: [{ produto_id: produtoB, tamanho_id: null, quantidade: 2 }],
    }).expect(409);
    assert.match(r.body.error, /Este item não está mais disponível na loja/);
    assert.ok(!JSON.stringify(r.body).includes('SEGREDO-EMPRESA-B'), 'vazou nome da empresa B');
    assert.ok(!JSON.stringify(r.body).includes('CART-QTD-B'), 'vazou SKU da empresa B');
    // `empresa_id` enviado pelo browser é ignorado: o tenant continua sendo o
    // resolvido por exigirVitrine() (env/unicidade), nunca o do corpo.
    const comEmpresaForjada = await request(app).post('/api/loja/carrinho/quantidade').send({
      ...corpo(2),
      empresa_id: 2,
      alvo: { produto_id: produtoB, tamanho_id: null, quantidade: 2, empresa_id: 2 },
      itens: [{ produto_id: produtoB, tamanho_id: null, quantidade: 2, empresa_id: 2 }],
    });
    assert.equal(comEmpresaForjada.status, 409);
    const valido = await request(app).post('/api/loja/carrinho/quantidade').send({ ...corpo(2), empresa_id: 2 }).expect(200);
    assert.equal(valido.body.quantidade, 2);
  });

  test('nunca aceita total/unit_price/discount/freight do browser como fonte de verdade', async () => {
    const r = await request(app).post('/api/loja/carrinho/quantidade').send({
      ...corpo(2),
      total: 1,
      unit_price: 1,
      discount: 999,
      freight: 999,
      alvo: { produto_id: produtoA, tamanho_id: null, quantidade: 2, unit_price: 1, subtotal: 1 },
      itens: [{ produto_id: produtoA, tamanho_id: null, quantidade: 2, unit_price: 1, preco_unitario: 1, discount: 999, freight: 999 }],
    }).expect(200);
    assert.equal(r.body.cotacao.itens[0].preco_unitario, 80);
    assert.equal(r.body.cotacao.totais.subtotal, 160);
    assert.equal(r.body.cotacao.totais.desconto, 0);
    assert.equal(r.body.cotacao.totais.total, 160);
  });
});
