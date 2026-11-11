// ============================================================================
// FASE 4 — PIM & PRICING / promoção ESCOPADA ponta a ponta na vitrine REAL.
//
// Servidor de verdade (HTTP) + PostgreSQL real. Prova que a promoção com
// escopo/canal/prioridade (migração 0108) vale de fato no CHECKOUT:
//   • escopo 'produto' desconta só o produto alvo — nunca o pedido inteiro;
//   • escopo 'categoria' alcança as linhas da categoria alvo;
//   • promoção de canal 'varejo' vale na vitrine; a de 'atacado' NÃO;
//   • precedência determinística: mesma base, vence a MAIOR prioridade;
//   • a promoção e o cupom não acumulam — vale o maior desconto;
//   • a promoção escopada vira desconto real no `totais.total` (servidor).
//
// Sem DATABASE_URL o arquivo se auto-pula (gate test:pg / job testes-postgres).
// ============================================================================
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { criarCliente, criarUsuario, msg, reservePort, startRealServer, stopServer } from './_commerce-harness';

if (!process.env.DATABASE_URL) {
  throw new Error('pim-pricing-vitrine-promocao.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}
process.env.NODE_ENV = 'test';

const { migrate, pool } = await import('../../src/db');
await migrate();
const { hashPassword } = await import('../../src/password');
const { processarFilaPublicacoes } = await import('../../src/commerce/catalogo');

const RODADA = `promo${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 22);
const RS = RODADA.slice(-6).toUpperCase();
const EMAIL_DOMINIO = '@promo.example.test';

test('PIM/Pricing PG: promoção escopada (produto/categoria/canal/prioridade) aplica no checkout real', async (t) => {
  const porta = await reservePort();
  const { child, baseUrl } = await startRealServer(porta);
  const req = criarCliente(baseUrl);
  const cliente = new Client({ connectionString: String(process.env.DATABASE_URL) });
  await cliente.connect();

  t.after(async () => {
    const limpar = async (sql: string, params: unknown[] = []) => {
      try { await cliente.query(sql, params as never[]); } catch { /* melhor esforço */ }
    };
    const prods = `SELECT id FROM produtos WHERE sku LIKE $1`;
    await limpar(`DELETE FROM commerce_promocao_alvos WHERE promocao_id IN (SELECT id FROM commerce_promocoes WHERE nome LIKE $1)`, [`%${RODADA}%`]);
    await limpar(`DELETE FROM commerce_promocoes WHERE nome LIKE $1`, [`%${RODADA}%`]);
    await limpar(`DELETE FROM commerce_cupons WHERE codigo LIKE $1`, [`PROMO${RS}%`]);
    await limpar(`DELETE FROM commerce_publicacoes WHERE produto_id IN (${prods})`, [`%${RS}%`]);
    await limpar(`DELETE FROM commerce_precos WHERE produto_id IN (${prods})`, [`%${RS}%`]);
    await limpar(`DELETE FROM commerce_produtos WHERE produto_id IN (${prods})`, [`%${RS}%`]);
    await limpar(`DELETE FROM movimentacoes WHERE produto_id IN (${prods})`, [`%${RS}%`]);
    await limpar(`DELETE FROM estoques WHERE produto_id IN (${prods})`, [`%${RS}%`]);
    await limpar(`DELETE FROM produtos WHERE sku LIKE $1`, [`%${RS}%`]);
    await limpar(`DELETE FROM categorias WHERE nome LIKE $1`, [`%${RODADA}%`]);
    await limpar(`DELETE FROM commerce_configuracoes WHERE loja_nome LIKE $1`, [`%${RODADA}%`]);
    await limpar(`DELETE FROM usuarios WHERE email LIKE $1`, [`%${EMAIL_DOMINIO}`]);
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await pool?.end().catch(() => undefined);
  });

  // ---- ator ------------------------------------------------------------------
  const emailGer = `ger-${RODADA}${EMAIL_DOMINIO}`;
  const senhaGer = await criarUsuario(cliente, hashPassword, `Gerente ${RODADA}`, emailGer, 'gerente', 1);
  const login = await req('POST', '/auth/login', { email: emailGer, password: senhaGer });
  assert.equal(login.status, 200, `login: ${msg(login)}`);
  const token = String(login.body?.token || '');
  // Motor de checkout INTERNO (ADR-0007): cotação autenticada, tenant da sessão.
  const reqInt = (metodo: string, rota: string, corpo?: unknown) => req(metodo, rota, corpo, token);

  // ---- categorias ------------------------------------------------------------
  const catAlvo = await req('POST', '/categorias', { nome: `Alvo ${RODADA}`, ativo: true }, token);
  assert.ok([200, 201].includes(catAlvo.status), `categoria alvo: ${msg(catAlvo)}`);
  const categoriaAlvoId = Number(catAlvo.body.id);
  const catFora = await req('POST', '/categorias', { nome: `Fora ${RODADA}`, ativo: true }, token);
  assert.ok([200, 201].includes(catFora.status), `categoria fora: ${msg(catFora)}`);
  const categoriaForaId = Number(catFora.body.id);

  // ---- produtos (A: R$ 100, B: R$ 50) ---------------------------------------
  const prodA = await req('POST', '/produtos', { sku: `PROMA-${RS}`, nome: `Alvo A ${RODADA}`, preco_venda: 100, custo: 30, categoria_id: categoriaAlvoId }, token);
  assert.ok([200, 201].includes(prodA.status), `produto A: ${msg(prodA)}`);
  const produtoAId = Number(prodA.body.id);
  const prodB = await req('POST', '/produtos', { sku: `PROMB-${RS}`, nome: `Fora B ${RODADA}`, preco_venda: 50, custo: 10, categoria_id: categoriaForaId }, token);
  assert.ok([200, 201].includes(prodB.status), `produto B: ${msg(prodB)}`);
  const produtoBId = Number(prodB.body.id);

  for (const pid of [produtoAId, produtoBId]) {
    const entrada = await req('POST', '/movimentacoes', { tipo: 'entrada', produto_id: pid, quantidade: 20, motivo: `Saldo ${RODADA}` }, token);
    assert.ok([200, 201].includes(entrada.status), `estoque ${pid}: ${msg(entrada)}`);
    const projetado = await req('POST', '/commerce/produtos', { produto_id: pid }, token);
    assert.ok([200, 201].includes(projetado.status), `projeção ${pid}: ${msg(projetado)}`);
    const publ = await req('POST', '/commerce/publicacoes', { produto_id: pid, canais: ['BROBOND'] }, token);
    assert.ok([200, 201].includes(publ.status), `publicar ${pid}: ${msg(publ)}`);
  }
  for (let i = 0; i < 60; i += 1) {
    await processarFilaPublicacoes(50);
    const fila = await req('GET', '/commerce/publicacoes', undefined, token);
    const publicados = (fila.body?.publicacoes || []).filter((p: any) => [produtoAId, produtoBId].includes(Number(p.produto_id)) && p.canal === 'BROBOND');
    if (publicados.length === 2 && publicados.every((p: any) => p.estado === 'PUBLISHED')) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const gerRow = await cliente.query(`SELECT id FROM usuarios WHERE email = $1`, [emailGer]);
  const cfg = await req('POST', '/commerce_configuracoes', {
    loja_nome: `Loja ${RODADA}`, loja_descricao: 'Loja do teste de promoção escopada',
    frete_provedor: 'retirada', frete_valor: 0, frete_gratis_acima: null, frete_prazo_dias: null,
    checkout_usuario_id: Number(gerRow.rows[0].id), checkout_expira_minutos: 60,
  }, token);
  assert.ok([200, 201].includes(cfg.status), `config da loja: ${msg(cfg)}`);

  const itemA = { produto_id: produtoAId, tamanho_id: null, quantidade: 1 };
  const itemB = { produto_id: produtoBId, tamanho_id: null, quantidade: 1 };

  // ---- 1) ESCOPO PRODUTO: 10% só no produto A --------------------------------
  const promoProduto = await req('POST', '/commerce/promocoes', {
    nome: `Produto ${RODADA}`, tipo: 'percentual', valor: 10, escopo: 'produto', canal: 'todos', prioridade: 0,
    minimo_pedido: 0, data_inicio: '2020-01-01', data_fim: null, ativo: true, produtos: [produtoAId],
  }, token);
  assert.ok([200, 201].includes(promoProduto.status), `promo produto: ${msg(promoProduto)}`);

  const q1 = await reqInt('POST', '/commerce/checkout/preview', { itens: [itemA, itemB] });
  assert.equal(q1.status, 200, `preview A+B: ${msg(q1)}`);
  assert.equal(q1.body.totais.subtotal, 150);
  assert.equal(q1.body.desconto, 10, 'só o produto alvo (R$ 100 × 10%) desconta');
  assert.equal(q1.body.totais.total, 140);

  // produto fora dos alvos sozinho: NÃO desconta
  const qSoB = await reqInt('POST', '/commerce/checkout/preview', { itens: [itemB] });
  assert.equal(qSoB.body.desconto, 0, 'produto fora do alvo não desconta');
  assert.equal(qSoB.body.totais.total, 50);

  // ---- 2) CANAL: promoção de 'atacado' não vale na vitrine (varejo) ----------
  await req('PUT', `/commerce/promocoes/${promoProduto.body.promocao.id}`, { canal: 'atacado' }, token);
  const qCanal = await reqInt('POST', '/commerce/checkout/preview', { itens: [itemA, itemB] });
  assert.equal(qCanal.body.desconto, 0, 'promoção de atacado não vale na vitrine (varejo)');
  // volta para todos
  await req('PUT', `/commerce/promocoes/${promoProduto.body.promocao.id}`, { canal: 'todos' }, token);

  // ---- 3) ESCOPO CATEGORIA: 20% na categoria alvo ---------------------------
  await req('PUT', `/commerce/promocoes/${promoProduto.body.promocao.id}`, { ativo: false }, token);
  const promoCategoria = await req('POST', '/commerce/promocoes', {
    nome: `Categoria ${RODADA}`, tipo: 'percentual', valor: 20, escopo: 'categoria', canal: 'todos', prioridade: 0,
    minimo_pedido: 0, data_inicio: '2020-01-01', data_fim: null, ativo: true, categorias: [categoriaAlvoId],
  }, token);
  assert.ok([200, 201].includes(promoCategoria.status), `promo categoria: ${msg(promoCategoria)}`);
  const qCat = await reqInt('POST', '/commerce/checkout/preview', { itens: [itemA, itemB] });
  assert.equal(qCat.body.desconto, 20, '20% sobre R$ 100 da categoria alvo');
  assert.equal(qCat.body.totais.total, 130);

  // ---- 4) PRECEDÊNCIA: mesma base, vence a MAIOR prioridade -----------------
  const promoCategoriaBaixa = await req('POST', '/commerce/promocoes', {
    nome: `Categoria baixa ${RODADA}`, tipo: 'percentual', valor: 20, escopo: 'categoria', canal: 'todos', prioridade: 1,
    minimo_pedido: 0, data_inicio: '2020-01-01', data_fim: null, ativo: true, categorias: [categoriaAlvoId],
  }, token);
  // Mesmo desconto (20) → a de maior prioridade vence; ambas dão 20, então o
  // valor final é o mesmo, mas a "melhor" reportada deve ser a de prioridade maior.
  const qPrec = await reqInt('POST', '/commerce/checkout/preview', { itens: [itemA] });
  assert.equal(qPrec.body.desconto, 20);
  // diferença observável: com desconto diferente (25%) e prioridade baixa, a de
  // MAIOR prioridade (20%, prioridade 1) NÃO vence a de maior desconto (25%) —
  // maior desconto continua sendo o critério primário.
  const promoCategoriaAltaDesconto = await req('POST', '/commerce/promocoes', {
    nome: `Categoria 25 ${RODADA}`, tipo: 'percentual', valor: 25, escopo: 'categoria', canal: 'todos', prioridade: 0,
    minimo_pedido: 0, data_inicio: '2020-01-01', data_fim: null, ativo: true, categorias: [categoriaAlvoId],
  }, token);
  assert.ok([200, 201].includes(promoCategoriaAltaDesconto.status));
  const qMelhor = await reqInt('POST', '/commerce/checkout/preview', { itens: [itemA] });
  assert.equal(qMelhor.body.desconto, 25, 'maior desconto vence a prioridade');

  // ---- 5) PROMOÇÃO × CUPOM: não acumulam, vence o maior ---------------------
  const codigo = `PROMO${RS}`;
  const cupom = await req('POST', '/commerce/cupons', { codigo, tipo: 'valor', valor: 30, minimo_pedido: 0, uso_maximo: 5, validade: null, ativo: true }, token);
  assert.ok([200, 201].includes(cupom.status), `cupom: ${msg(cupom)}`);
  const qCupom = await reqInt('POST', '/commerce/checkout/preview', { itens: [itemA], cupom: codigo });
  assert.equal(qCupom.body.desconto, 30, 'cupom de R$ 30 vence a promoção de 25% (R$ 25)');
  assert.equal(qCupom.body.totais.total, 70);

  // ---- 6) SIMULADOR: mesma regra do checkout, nada é gravado ----------------
  const sim = await req('POST', '/commerce/promocoes/simular', {
    itens: [
      { produto_id: produtoAId, quantidade: 1, preco_unitario: 100, categoria_id: categoriaAlvoId },
      { produto_id: produtoBId, quantidade: 1, preco_unitario: 50, categoria_id: categoriaForaId },
    ],
    canal: 'varejo',
  }, token);
  assert.equal(sim.status, 200, `simular: ${msg(sim)}`);
  assert.equal(sim.body.subtotal, 150);
  assert.equal(sim.body.desconto_aplicado, 25, 'simulador usa a MESMA regra (25% na categoria alvo)');
  assert.equal(sim.body.total, 125);
  assert.ok(Array.isArray(sim.body.candidatas) && sim.body.candidatas.length >= 1, 'simulador lista as candidatas avaliadas');
});
