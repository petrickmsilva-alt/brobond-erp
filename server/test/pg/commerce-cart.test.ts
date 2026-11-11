// ============================================================================
// COMMERCE — CARRINHO / COTAÇÃO / CHECKOUT INTERNO em PostgreSQL REAL.
//
// Servidor de verdade (HTTP) + banco real. Prova, com o produto do go-live
// (nome COM aspas, SKU COM aspas, R$ 80,00, estoque 8, frete = retirada):
//   • cotação do servidor: preço/estoque/total/frete reais, imagem/SKU/variante;
//   • autoridade do servidor: "total: 1" / "preco_unitario: 1" do browser são
//     ignorados — no preview E no checkout;
//   • quantidades inválidas (0, negativa, NaN, Infinity, texto, decimal, >99) → 400;
//   • estoque: acima do disponível → ok:false; reserva do checkout reduz a
//     disponibilidade (physical − reserved);
//   • cupom aplicado/recalculado/inválido; frete fail-closed;
//   • produto despublicado: continua VISÍVEL (e removível) no carrinho sem vazar
//     nome e o checkout recusa (409);
//   • tenancy: item de outra empresa → mesma resposta de "indisponível";
//   • loja nativa retirada (ADR-0007): URLs antigas respondem 410 Gone;
//   • webhook duplicado + conversão repetida → UMA venda (idempotência);
//   • RBAC: o checkout interno EXIGE sessão (sem token → 401); operador não
//     altera a config; outro tenant não vê o pedido.
// ============================================================================
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { criarCliente, criarUsuario, msg, paginaHtml, reservePort, startRealServer, stopServer } from './_commerce-harness';

if (!process.env.DATABASE_URL) {
  throw new Error('commerce-cart.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}
process.env.NODE_ENV = 'test';

const { migrate, pool } = await import('../../src/db');
await migrate();
const { hashPassword } = await import('../../src/password');
const { cifrarSegredo } = await import('../../src/segredos');
const { processarFilaPublicacoes } = await import('../../src/commerce/catalogo');

const RODADA = `cart${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 22);
const RS = RODADA.slice(-6).toUpperCase(); // SKU tem teto de 40 caracteres
const SKU_ASPAS = `CAM-BAS-PREM-VERM-"B" LOGO BRANCA ${RS}`;
const NOME_ASPAS = `COTTON "B" ${RODADA}`;
const EMAIL_DOMINIO = '@cart.example.test';

test('CARRINHO PG: cotação autoritativa, anti-tamper, estoque/reserva, cupom, frete, despublicação, tenancy e idempotência', async (t) => {
  const porta = await reservePort();
  const { child, baseUrl } = await startRealServer(porta);
  const req = criarCliente(baseUrl);
  const cliente = new Client({ connectionString: String(process.env.DATABASE_URL) });
  await cliente.connect();
  const configsCriadas: number[] = [];
  let empresaB = 0;

  t.after(async () => {
    const limpar = async (sql: string, params: unknown[] = []) => {
      try {
        await cliente.query(sql, params as never[]);
      } catch (e) {
        console.error('cleanup:', sql.slice(0, 80), String(e));
      }
    };
    try {
      const pedidos = `SELECT id FROM commerce_pedidos WHERE chave_checkout LIKE $1`;
      for (const table of ['payment_refunds', 'payment_disputes', 'payment_settlements', 'payment_operations', 'payment_attempts']) {
        await limpar(`DELETE FROM ${table} WHERE payment_intent_id IN (SELECT pi.id FROM payment_intents pi WHERE pi.order_id IN (${pedidos}))`, [`%${RODADA}%`]);
      }
      await limpar(`DELETE FROM payment_intents WHERE order_id IN (${pedidos})`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM gateway_webhook_events WHERE payload->>'event_id' LIKE $1`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM gateway_webhook_events WHERE cobranca_id IN (SELECT cobranca_id FROM commerce_pedidos WHERE chave_checkout LIKE $1 AND cobranca_id IS NOT NULL)`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM gateway_cobrancas WHERE id IN (SELECT cobranca_id FROM commerce_pedidos WHERE chave_checkout LIKE $1 AND cobranca_id IS NOT NULL)`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM commerce_outbox WHERE chave LIKE $1`, [`%${RODADA}%`]);
      const salesAlvo = await cliente.query(`SELECT id, operational_venda_id FROM sales WHERE buyer_email ILIKE $1`, [`%${EMAIL_DOMINIO}`]).catch(() => ({ rows: [] as { id: string; operational_venda_id: number | null }[] }));
      const idsSales = salesAlvo.rows.map((r) => r.id);
      const idsVendas = salesAlvo.rows.map((r) => Number(r.operational_venda_id ?? 0)).filter((n) => n > 0);
      await limpar(`DELETE FROM estoque_reservas WHERE origem_recurso = 'commerce_checkout' AND origem_id IN (${pedidos})`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM creator_attributions WHERE order_id IN (${pedidos})`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM commerce_pedidos WHERE chave_checkout LIKE $1`, [`%${RODADA}%`]);
      if (idsVendas.length) {
        await limpar(`DELETE FROM itens_venda WHERE venda_id = ANY($1::int[])`, [idsVendas]);
        await limpar(`DELETE FROM commerce_rastreio WHERE venda_id = ANY($1::int[])`, [idsVendas]);
        await limpar(`DELETE FROM movimentacoes WHERE venda_id = ANY($1::int[])`, [idsVendas]);
      }
      if (idsSales.length) await limpar(`DELETE FROM sales WHERE id = ANY($1::text[])`, [idsSales]);
      if (idsVendas.length) await limpar(`DELETE FROM vendas WHERE id = ANY($1::int[])`, [idsVendas]);
      const prods = `SELECT id FROM produtos WHERE sku LIKE $1`;
      await limpar(`DELETE FROM commerce_publicacoes WHERE produto_id IN (${prods})`, [`%${RS}%`]);
      await limpar(`DELETE FROM commerce_precos WHERE produto_id IN (${prods})`, [`%${RS}%`]);
      await limpar(`DELETE FROM commerce_produtos WHERE produto_id IN (${prods})`, [`%${RS}%`]);
      await limpar(`DELETE FROM commerce_cupons WHERE codigo LIKE $1`, [`CART${RODADA.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`]);
      await limpar(`DELETE FROM movimentacoes WHERE produto_id IN (${prods})`, [`%${RS}%`]);
      await limpar(`DELETE FROM estoques WHERE produto_id IN (${prods})`, [`%${RS}%`]);
      await limpar(`DELETE FROM produtos WHERE sku LIKE $1`, [`%${RS}%`]);
      await limpar(`DELETE FROM commerce_configuracoes WHERE loja_nome LIKE $1`, [`%${RODADA}%`]);
      for (const id of configsCriadas.splice(0)) await limpar(`DELETE FROM gateway_configs WHERE id = $1`, [id]);
      await limpar(`DELETE FROM clientes WHERE email ILIKE $1`, [`%${EMAIL_DOMINIO}`]);
      await limpar(`DELETE FROM usuarios WHERE email LIKE $1`, [`%${EMAIL_DOMINIO}`]);
    } finally {
      await cliente.end().catch(() => undefined);
      await stopServer(child);
      await pool?.end().catch(() => undefined);
    }
  });

  // ---- atores ----------------------------------------------------------------
  const emailGer = `ger-${RODADA}${EMAIL_DOMINIO}`;
  const senhaGer = await criarUsuario(cliente, hashPassword, `Gerente ${RODADA}`, emailGer, 'gerente', 1);
  const emailOp = `op-${RODADA}${EMAIL_DOMINIO}`;
  const senhaOp = await criarUsuario(cliente, hashPassword, `Operador ${RODADA}`, emailOp, 'operador', 1);
  const empB = await cliente.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Filial CART ${RODADA}`]);
  empresaB = Number(empB.rows[0].id);
  const emailB = `b-${RODADA}${EMAIL_DOMINIO}`;
  const senhaB = await criarUsuario(cliente, hashPassword, `Gerente B ${RODADA}`, emailB, 'gerente', empresaB);
  const login = async (email: string, password: string) => {
    const r = await req('POST', '/auth/login', { email, password });
    assert.equal(r.status, 200, `login ${email}: ${r.texto}`);
    return String(r.body?.token || '');
  };
  const tokenA = await login(emailGer, senhaGer);
  const tokenOp = await login(emailOp, senhaOp);
  const tokenB = await login(emailB, senhaB);
  // Motor de checkout INTERNO (ADR-0007): rotas autenticadas, tenant da sessão.
  const reqInt = (metodo: string, rota: string, corpo?: unknown) => req(metodo, rota, corpo, tokenA);

  const cfgRow = await cliente.query(
    `INSERT INTO gateway_configs (empresa_id, provider, ambiente, ativo, credenciais_cifradas)
     VALUES (1, 'mock', 'teste', true, $1)
     ON CONFLICT (empresa_id, lower(provider)) DO UPDATE SET ambiente = 'teste', ativo = true, credenciais_cifradas = EXCLUDED.credenciais_cifradas, atualizado_em = now()
     RETURNING id`,
    [cifrarSegredo(JSON.stringify({ fake: 'cart' }))]
  );
  configsCriadas.push(Number(cfgRow.rows[0].id));

  // ---- catálogo: produto do go-live (R$ 80, estoque 8) ------------------------
  const prod = await req('POST', '/produtos', { sku: SKU_ASPAS, nome: NOME_ASPAS, preco_venda: 80, custo: 30, codigo_barras: '7891234567895' }, tokenA);
  assert.ok([200, 201].includes(prod.status), `produto: ${msg(prod)}`);
  const produtoId = Number(prod.body.id);
  const entrada = await req('POST', '/movimentacoes', { tipo: 'entrada', produto_id: produtoId, quantidade: 8, motivo: `Saldo ${RODADA}` }, tokenA);
  assert.ok([200, 201].includes(entrada.status), `estoque: ${msg(entrada)}`);
  const projetado = await req('POST', '/commerce/produtos', { produto_id: produtoId }, tokenA);
  assert.ok([200, 201].includes(projetado.status), `projeção: ${msg(projetado)}`);
  const slug = String(projetado.body?.produto_commerce?.slug ?? projetado.body?.slug ?? '');
  assert.ok(slug.length > 3, `slug: ${msg(projetado)}`);

  // outro tenant: produto da empresa B
  const prodB = await req('POST', '/produtos', { sku: `OUTRA-${RS}`, nome: `Peça da filial ${RODADA}`, preco_venda: 10, custo: 1 }, tokenB);
  assert.ok([200, 201].includes(prodB.status), `produto B: ${msg(prodB)}`);
  const produtoIdB = Number(prodB.body.id);

  const publ = await req('POST', '/commerce/publicacoes', { produto_id: produtoId, canais: ['BROBOND'] }, tokenA);
  assert.ok([200, 201].includes(publ.status), `publicar: ${msg(publ)}`);
  for (let i = 0; i < 40; i += 1) {
    await processarFilaPublicacoes(50);
    const fila = await req('GET', '/commerce/publicacoes', undefined, tokenA);
    const minha = (fila.body?.publicacoes || []).find((p: any) => Number(p.produto_id) === produtoId && p.canal === 'BROBOND');
    if (minha?.estado === 'PUBLISHED') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const gerRow = await cliente.query(`SELECT id FROM usuarios WHERE email = $1`, [emailGer]);
  const cfg = await req('POST', '/commerce_configuracoes', {
    loja_nome: `Loja ${RODADA}`,
    loja_descricao: 'Loja de teste do carrinho',
    frete_provedor: 'retirada',
    frete_valor: 0,
    frete_gratis_acima: null,
    frete_prazo_dias: null,
    checkout_usuario_id: Number(gerRow.rows[0].id),
    checkout_expira_minutos: 60,
  }, tokenA);
  assert.ok([200, 201].includes(cfg.status), `config da loja: ${msg(cfg)}`);

  // ---- 1) cotação do motor de checkout INTERNO (autenticado) -----------------------
  const itens1 = [{ produto_id: produtoId, tamanho_id: null, quantidade: 1 }];
  const q1 = await reqInt('POST', '/commerce/checkout/preview', { itens: itens1 });
  assert.equal(q1.status, 200, `preview: ${msg(q1)}`);
  assert.equal(q1.headers.get('cache-control'), 'no-store', 'cotação nunca é cacheada');
  const linha = q1.body.itens[0];
  assert.equal(linha.nome, NOME_ASPAS);
  assert.equal(linha.sku, SKU_ASPAS);
  assert.equal(linha.preco_unitario, 80);
  assert.equal(linha.subtotal, 80);
  assert.equal(linha.disponivel, 8);
  assert.equal(linha.ok, true);
  assert.ok('foto_url' in linha && 'variante' in linha, 'linha traz imagem e variante (null quando não há)');
  assert.deepEqual(q1.body.totais, { subtotal: 80, desconto: 0, frete: 0, total: 80 });
  assert.equal(q1.body.frete.disponivel, true);
  assert.equal(q1.body.frete.provedor, 'retirada');
  assert.equal(q1.body.pronto_para_checkout, true);
  assert.ok(q1.body.payment_methods.some((m: any) => m.code === 'PIX'), 'métodos vêm do Payment Engine');
  assert.ok(Date.parse(q1.body.calculado_em) > 0);

  // ---- 2) ANTI-TAMPER: o browser nunca define preço/total/desconto/frete -------------
  const tamper = await reqInt('POST', '/commerce/checkout/preview', {
    itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 1, preco_unitario: 1, preco: 1, subtotal: 1, disponivel: 999 }],
    total: 1, totais: { total: 1 }, desconto: 79, frete: 0, subtotal: 1,
  });
  assert.equal(tamper.status, 200);
  assert.equal(tamper.body.totais.total, 80, 'total:1 do browser é ignorado');
  assert.equal(tamper.body.itens[0].preco_unitario, 80);
  assert.equal(tamper.body.itens[0].disponivel, 8, 'estoque informado pelo browser é ignorado');

  // ---- 3) quantidades inválidas -----------------------------------------------------
  for (const ruim of [0, -1, 'abc', 'NaN', 'Infinity', 1.5, null, 100, '', {}]) {
    const r = await reqInt('POST', '/commerce/checkout/preview', { itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: ruim }] });
    assert.equal(r.status, 400, `quantidade ${JSON.stringify(ruim)} deve ser 400: ${msg(r)}`);
  }
  assert.equal((await reqInt('POST', '/commerce/checkout/preview', { itens: [] })).status, 400, 'carrinho vazio → 400');
  assert.equal((await reqInt('POST', '/commerce/checkout/preview', { itens: [{ produto_id: 'x', quantidade: 1 }] })).status, 400);
  assert.equal((await reqInt('POST', '/commerce/checkout/preview', { itens: [...itens1, ...itens1] })).status, 400, 'linha duplicada → 400');

  // ---- 3b) ENDPOINT DE QUANTIDADE (+ / −): confirmação server-side -------------
  const mutacao = (quantidade: unknown, extra: Record<string, unknown> = {}) => ({
    alvo: { produto_id: produtoId, tamanho_id: null, quantidade },
    itens: [{ produto_id: produtoId, tamanho_id: null, quantidade }],
    ...extra,
  });
  for (const qtd of [2, 3, 2]) {
    const r = await reqInt('POST', '/commerce/checkout/carrinho/quantidade', mutacao(qtd));
    assert.equal(r.status, 200, `quantidade ${qtd} confirmada: ${msg(r)}`);
    assert.equal(r.body.quantidade, qtd, 'só a quantidade confirmada pelo servidor é devolvida');
    assert.equal(r.body.cotacao.totais.subtotal, 80 * qtd, 'subtotal recalculado no servidor');
    assert.equal(r.body.cotacao.totais.total, 80 * qtd, 'total recalculado no servidor');
  }
  for (const ruim of [0, -1, 1.5, 100, '2', 'abc', null, {}, [], [2], true, NaN, Infinity, -Infinity]) {
    const r = await reqInt('POST', '/commerce/checkout/carrinho/quantidade', mutacao(ruim));
    assert.equal(r.status, 400, `quantidade inválida ${JSON.stringify(ruim)} → 400: ${msg(r)}`);
  }
  const m9 = await reqInt('POST', '/commerce/checkout/carrinho/quantidade', mutacao(9));
  assert.equal(m9.status, 409, `acima do estoque → 409: ${msg(m9)}`);
  assert.equal(m9.body.error, 'Só há 8 unidades disponíveis.');
  assert.equal(m9.body.quantidade, undefined, 'nunca confirma quantidade acima do estoque');
  // Tenant: produto da empresa B não pode ser alterado pela loja da empresa A.
  const mB = await reqInt('POST', '/commerce/checkout/carrinho/quantidade', {
    alvo: { produto_id: produtoIdB, tamanho_id: null, quantidade: 2 },
    itens: [{ produto_id: produtoIdB, tamanho_id: null, quantidade: 2 }],
    empresa_id: 2, // forjado pelo browser: precisa ser ignorado
  });
  assert.equal(mB.status, 409, `item de outra empresa → 409: ${msg(mB)}`);
  assert.ok(!mB.texto.includes('filial') && !mB.texto.includes(`OUTRA-${RS}`), 'nada do tenant B vaza');
  const mTamper = await reqInt('POST', '/commerce/checkout/carrinho/quantidade', mutacao(2, { total: 1, unit_price: 1, discount: 79, freight: 9, empresa_id: 999 }));
  assert.equal(mTamper.status, 200, `campos monetários/de tenant do browser são ignorados: ${msg(mTamper)}`);
  assert.equal(mTamper.body.cotacao.totais.total, 160);

  // CONTATO DO CHECKOUT: o contrato Storefront Enterprise exige nome completo,
  // e-mail, WhatsApp normalizado para E.164 e CPF válido quando o meio é PIX
  // (decisão server-side, `exigirDocumento`). CPF abaixo é fixture com dígitos
  // verificadores válidos — nenhum dado real de cliente.
  // Os fixtures abaixo foram atualizados para esse contrato; as asserções de
  // estoque/frete/tenancy/SEO/idempotência permanecem exatamente as mesmas.
  // ---- 4) estoque -------------------------------------------------------------------
  const q9 = await reqInt('POST', '/commerce/checkout/preview', { itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 9 }] });
  assert.equal(q9.status, 200);
  assert.equal(q9.body.itens[0].ok, false);
  assert.equal(q9.body.itens[0].aviso, 'Só 8 em estoque.');
  assert.equal(q9.body.pronto_para_checkout, false);
  assert.deepEqual(q9.body.payment_methods, [], 'sem estoque → nenhum método oferecido');
  const co9 = await reqInt('POST', '/commerce/checkout', { chave: `chave-${RODADA}-9`, comprador: { nome: 'Cliente X', email: `x${EMAIL_DOMINIO}`, whatsapp: '62999991234', documento: '529.982.247-25' }, itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 9 }] });
  assert.equal(co9.status, 409, `checkout com estoque insuficiente: ${msg(co9)}`);

  // ---- 5) cupom -----------------------------------------------------------------------
  const codigo = `CART${RODADA}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  const cupom = await req('POST', '/commerce/cupons', { codigo, tipo: 'percentual', valor: 10, minimo_pedido: 0, uso_maximo: 5, validade: null, ativo: true }, tokenA);
  assert.ok([200, 201].includes(cupom.status), `cupom: ${msg(cupom)}`);
  const qc = await reqInt('POST', '/commerce/checkout/preview', { itens: itens1, cupom: codigo.toLowerCase() });
  assert.equal(qc.body.cupom.valido, true);
  assert.equal(qc.body.desconto, 8);
  assert.equal(qc.body.totais.total, 72, 'cupom recalculado no servidor');
  const qci = await reqInt('POST', '/commerce/checkout/preview', { itens: itens1, cupom: 'NAOEXISTE999', desconto: 79 });
  assert.equal(qci.status, 200);
  assert.equal(qci.body.cupom.valido, false);
  assert.equal(qci.body.totais.total, 80, 'cupom inválido não desconta');
  assert.equal(qci.body.pronto_para_checkout, false, 'cupom inválido bloqueia o checkout (decisão do servidor)');

  // ---- 6) tenancy: item de outra empresa == indisponível, sem vazar nada ------------
  const qb = await reqInt('POST', '/commerce/checkout/preview', { itens: [{ produto_id: produtoIdB, tamanho_id: null, quantidade: 1 }] });
  assert.equal(qb.status, 200);
  assert.equal(qb.body.itens[0].ok, false);
  assert.equal(qb.body.itens[0].indisponivel, true);
  assert.equal(qb.body.itens[0].nome, 'Item indisponível');
  assert.ok(!qb.texto.includes('filial') && !qb.texto.includes(`OUTRA-${RS}`), 'nada do tenant B vaza');
  assert.equal(qb.body.pronto_para_checkout, false);
  const cob = await reqInt('POST', '/commerce/checkout', { chave: `chave-${RODADA}-b`, comprador: { nome: 'Cliente X', email: `x${EMAIL_DOMINIO}`, whatsapp: '62999991234', documento: '529.982.247-25' }, itens: [{ produto_id: produtoIdB, tamanho_id: null, quantidade: 1 }] });
  assert.equal(cob.status, 409, `checkout com item de outro tenant: ${msg(cob)}`);

  // ---- 7) URLs antigas da loja nativa → 410 Gone (ADR-0007) ------------------------
  // A vitrine própria foi retirada: nenhuma URL antiga pode devolver 200 (seria um
  // SEO enganoso). Sem STOREFRONT_REDIRECT_URL, o tratamento é 410 explícito.
  const antiga = await paginaHtml(baseUrl, `/loja/produto/${encodeURIComponent(slug)}`);
  assert.equal(antiga.status, 410, 'URL antiga de produto → 410 Gone');
  assert.match(antiga.html, /noindex/);
  const antigaHome = await paginaHtml(baseUrl, '/loja');
  assert.equal(antigaHome.status, 410, 'home da vitrine → 410 Gone');
  assert.match(antigaHome.html, /noindex/);

  // ---- 8) CHECKOUT anti-tamper + reserva reduz disponibilidade ----------------------
  const chave = `chave-${RODADA}-${randomUUID().slice(0, 8)}`.slice(0, 64);
  const corpoCheckout = {
    chave,
    comprador: { nome: 'Cliente Cart', email: `cliente${EMAIL_DOMINIO}`, whatsapp: '62999991234', documento: '529.982.247-25' },
    itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 1, preco_unitario: 1, subtotal: 1 }],
    total: 1, totais: { total: 1 }, frete: 0, desconto: 79,
    endereco: null,
  };
  const checkout = await reqInt('POST', '/commerce/checkout', corpoCheckout);
  assert.equal(checkout.status, 201, `checkout: ${msg(checkout)}`);
  const saleId = String(checkout.body.sale_id);
  const pedido = await cliente.query(`SELECT id, total, frete_valor, desconto FROM commerce_pedidos WHERE sale_id = $1`, [saleId]);
  assert.equal(Number(pedido.rows[0].total), 80, 'pedido nasce com o total do SERVIDOR (R$ 80), não R$ 1');
  assert.equal(Number(pedido.rows[0].desconto), 0);
  const sale = await cliente.query(`SELECT amount_cents FROM sales WHERE id = $1`, [saleId]);
  assert.equal(Number(sale.rows[0].amount_cents), 8000);
  const checkoutRepetido = await reqInt('POST', '/commerce/checkout', corpoCheckout);
  assert.equal(checkoutRepetido.status, 200);
  assert.equal(checkoutRepetido.body.idempotente, true, 'retry/refresh não cria segundo pedido');
  assert.equal((await cliente.query(`SELECT count(*)::int n FROM commerce_pedidos WHERE chave_checkout = $1`, [chave])).rows[0].n, 1);

  const depoisReserva = await reqInt('POST', '/commerce/checkout/preview', { itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 8 }] });
  assert.equal(depoisReserva.body.itens[0].disponivel, 7, 'reserva do checkout reduz o disponível (físico − reservado)');
  assert.equal(depoisReserva.body.itens[0].ok, false);
  const fisico = await cliente.query(`SELECT coalesce(sum(quantidade),0)::int q FROM estoques WHERE produto_id = $1`, [produtoId]);
  assert.equal(fisico.rows[0].q, 8, 'o checkout RESERVA; não baixa o estoque físico');

  // ---- 9) webhook duplicado + conversão repetida → UMA venda -----------------------
  const ped = await cliente.query(`SELECT id FROM commerce_pedidos WHERE sale_id = $1`, [saleId]);
  const cobranca = await cliente.query(`SELECT provider_ref FROM gateway_cobrancas WHERE idempotency_key = $1`, [`checkout:${ped.rows[0].id}`]);
  assert.equal(cobranca.rows.length, 1);
  const corpoEvento = JSON.stringify({ event: 'payment.paid', event_id: `evt-${RODADA}`, data: { id: String(cobranca.rows[0].provider_ref) }, status: 'pago' });
  const enviar = () => fetch(`${baseUrl}/api/gateway/webhooks/mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: corpoEvento });
  const [w1, w2] = await Promise.all([enviar(), enviar()]);
  assert.equal(w1.status, 200);
  assert.equal(w2.status, 200);
  const conv1 = await req('POST', `/commerce/pedidos/${saleId}/converter`, {}, tokenA);
  const conv2 = await req('POST', `/commerce/pedidos/${saleId}/converter`, {}, tokenA);
  assert.ok([200, 201].includes(conv1.status), `conversão: ${msg(conv1)}`);
  assert.equal(Number(conv2.body.venda_id), Number(conv1.body.venda_id), 'reconversão devolve a MESMA venda');
  const nVendas = await cliente.query(`SELECT count(*)::int n FROM sales WHERE id = $1 AND operational_venda_id IS NOT NULL`, [saleId]);
  assert.equal(nVendas.rows[0].n, 1);
  assert.equal((await cliente.query(`SELECT count(*)::int n FROM vendas WHERE id = $1`, [Number(conv1.body.venda_id)])).rows[0].n, 1, 'webhook duplicado + reconversão = UMA venda');
  const eventos = await cliente.query(`SELECT count(*)::int n FROM gateway_webhook_events WHERE payload->>'event_id' = $1`, [`evt-${RODADA}`]);
  assert.equal(eventos.rows[0].n, 1, 'evento duplicado é deduplicado por (provider, evento_id)');

  // ---- 10) frete fail-closed ---------------------------------------------------------
  await cliente.query(`UPDATE commerce_configuracoes SET frete_provedor = 'nenhum' WHERE loja_nome LIKE $1`, [`Loja ${RODADA}%`]);
  const semFrete = await reqInt('POST', '/commerce/checkout/preview', { itens: itens1 });
  assert.equal(semFrete.status, 200);
  assert.equal(semFrete.body.frete_indisponivel, true);
  assert.match(String(semFrete.body.frete_motivo), /frete não configurado/i);
  assert.equal(semFrete.body.pronto_para_checkout, false);
  assert.equal(semFrete.body.totais.frete, 0, 'frete NÃO é inventado');
  await cliente.query(`UPDATE commerce_configuracoes SET frete_provedor = 'retirada' WHERE loja_nome LIKE $1`, [`Loja ${RODADA}%`]);

  // ---- 11) produto despublicado: visível/removível no carrinho, checkout recusa, 404 real --
  const desp = await req('POST', `/commerce/produtos/${produtoId}/despublicar`, { canal: 'BROBOND' }, tokenA);
  assert.equal(desp.status, 200, `despublicar: ${msg(desp)}`);
  const qd = await reqInt('POST', '/commerce/checkout/preview', { itens: itens1 });
  assert.equal(qd.status, 200, 'o carrinho NÃO falha inteiro por causa de um item despublicado');
  assert.equal(qd.body.itens[0].indisponivel, true);
  assert.equal(qd.body.itens[0].ok, false);
  assert.ok(!qd.texto.includes('COTTON'), 'produto despublicado não vaza nome');
  assert.equal(qd.body.pronto_para_checkout, false);
  const coDesp = await reqInt('POST', '/commerce/checkout', { chave: `chave-${RODADA}-d`, comprador: { nome: 'Cliente X', email: `x${EMAIL_DOMINIO}`, whatsapp: '62999991234', documento: '529.982.247-25' }, itens: itens1 });
  assert.equal(coDesp.status, 409, `checkout de item despublicado: ${msg(coDesp)}`);

  // ---- 12) RBAC ------------------------------------------------------------------------
  assert.equal((await req('POST', '/commerce/checkout/preview', { itens: itens1 })).status, 401, 'checkout interno exige sessão (sem token → 401)');
  assert.equal((await req('POST', '/commerce_configuracoes', { loja_nome: 'x' }, tokenOp)).status, 403, 'operador não altera a config da loja');
  assert.equal((await req('PUT', `/commerce/produtos/${produtoId}/precos`, { canal: 'BROBOND', preco: 1, preco_promo: null }, tokenOp)).status, 403, 'operador não altera preço');
  assert.equal((await req('GET', '/commerce/pedidos')).status, 401);
  assert.equal((await req('GET', `/commerce/pedidos/${saleId}`, undefined, tokenB)).status, 404, 'outro tenant não vê o pedido');
});
