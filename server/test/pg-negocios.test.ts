// ============================================================
// Motor analítico 1. MEU NEGÓCIOS — a MESMA prova matemática da
// suíte de memória (negocios.test.ts), agora contra Postgres de
// verdade: a query SQL que materializa margens nas colunas reais de
// `sales`, a curva ABC persistida em `produto_abc` com janela
// De/Até, a linha-padrão `ncm IS NULL` de impostos_ncm (CRUD +
// índice parcial de unicidade) e os filtros estritos de BI.
//
// Rodam no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo
// se auto-pula, para não quebrar a suíte local.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Actor = { id: number; name: string; perfil: string };
const gerente: Actor = { id: 0, name: 'Teste PG', perfil: 'gerente' };

function mockReq(user: any, query: Record<string, string> = {}, body: any = {}): any {
  return { user, query, body, params: {} };
}
function mockRes() {
  let _payload: any;
  let _status = 0;
  const res: any = {
    json: (d: any) => {
      _payload = d;
      if (!_status) _status = 200;
      return res;
    },
    status: (s: number) => {
      _status = s;
      return res;
    },
    setHeader: () => res,
  };
  return { res, payload: () => _payload, code: () => _status };
}
async function chamar(handler: (req: any, res: any) => Promise<unknown>, req: any) {
  const r = mockRes();
  await handler(req, r.res);
  return { code: r.code(), payload: r.payload() };
}

/** Cria as fixtures do motor e devolve ids + função de limpeza. */
async function cenario(sufixo: string) {
  const { migrate, pool } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { createRecord } = await import('../src/services');

  // sales.usuario_id tem FK para usuarios — a venda manual é atribuída a um
  // usuário real (quem registrou), então o fixture cria um vendedor.
  const vendedor = await pool!.query(
    `INSERT INTO usuarios (nome, email, perfil) VALUES ($1, $2, 'gerente') RETURNING id`,
    [`Vendedor PG ${sufixo}`, `vendedor-${sufixo}@pg.teste`]
  );
  const vendedorId = Number(vendedor.rows[0].id);
  const gerente: Actor = { id: vendedorId, name: 'Vendedor PG', perfil: 'gerente' };

  const insumo = await createRecord(RESOURCES.insumos, { nome: `Insumo PG ${sufixo}`, unidade: 'm', custo_medio: 2 }, gerente);
  const p1 = Number((await createRecord(RESOURCES.produtos, { sku: `PG1-${sufixo}`, nome: 'Camiseta PG', ncm: '6109.10.00', custo: 8, preco_venda: 50 }, gerente)).id);
  const p2 = Number((await createRecord(RESOURCES.produtos, { sku: `PG2-${sufixo}`, nome: 'Calça PG', ncm: '6203.42.00', custo: 5, preco_venda: 40 }, gerente)).id);
  const p3 = Number((await createRecord(RESOURCES.produtos, { sku: `PG3-${sufixo}`, nome: 'Bermuda PG', custo: 3, preco_venda: 20 }, gerente)).id);
  const p4 = Number((await createRecord(RESOURCES.produtos, { sku: `PG4-${sufixo}`, nome: 'Boné PG', custo: 2, preco_venda: 5 }, gerente)).id);
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: p1, mao_obra: 4, custos_indiretos: 0.7 }, gerente);
  await pool!.query(
    `INSERT INTO itens_ficha_tecnica (ficha_id, insumo_id, consumo, perda_pct) VALUES ($1, $2, 1.5, 10)`,
    [Number(ficha.id), Number(insumo.id)]
  );

  const impostoPrefixo = await createRecord(RESOURCES.impostos_ncm, { ncm: '6109', aliquota_pct: 12 }, gerente);
  const impostoExato = await createRecord(RESOURCES.impostos_ncm, { ncm: '62034200', aliquota_pct: 8 }, gerente);

  const limpar = async (saleIds: string[] = []) => {
    await pool!.query(`DELETE FROM sales WHERE id = ANY($1::text[])`, [saleIds.length ? saleIds : ['-']]);
    await pool!.query(`DELETE FROM produto_abc WHERE produto_id = ANY($1::int[])`, [[p1, p2, p3, p4]]);
    await pool!.query(`DELETE FROM itens_ficha_tecnica WHERE ficha_id = $1`, [Number(ficha.id)]);
    await pool!.query(`DELETE FROM fichas_tecnicas WHERE id = $1`, [Number(ficha.id)]);
    await pool!.query(`DELETE FROM produtos WHERE id = ANY($1::int[])`, [[p1, p2, p3, p4]]);
    await pool!.query(`DELETE FROM insumos WHERE id = $1`, [Number(insumo.id)]);
    await pool!.query(`DELETE FROM impostos_ncm WHERE id = ANY($1::int[])`, [[Number(impostoPrefixo.id), Number(impostoExato.id)]]);
    await pool!.query(`DELETE FROM usuarios WHERE id = $1`, [vendedorId]);
  };

  return { pool, RESOURCES, createRecord, gerente, p1, p2, p3, p4, impostoPrefixo, impostoExato, limpar };
}

test('motor de margem: lucro bruto materializado nas colunas reais de sales (PG)', { skip }, async () => {
  const { negociosVendaManual, negociosMargensRecalcular, negociosMargens } = await import('../src/negocios');
  const sufixo = `m${Date.now() % 1e9}`;
  const c = await cenario(sufixo);
  const gerente = c.gerente;
  let impostoPadrao: any = null;
  const saleIds: string[] = [];
  try {
    // linha-padrão: CRUD envia ncm vazio → persiste NULL → 5% para quem não tem NCM
    impostoPadrao = await c.createRecord(c.RESOURCES.impostos_ncm, { ncm: '', aliquota_pct: 5 }, gerente);
    const guardado = await c.pool!.query(`SELECT ncm FROM impostos_ncm WHERE id = $1`, [Number(impostoPadrao.id)]);
    assert.equal(guardado.rows[0].ncm, null, 'ncm em branco vira a linha-padrão (NULL)');

    const criar = async (body: any) => {
      const r = await chamar(negociosVendaManual, mockReq(gerente, {}, body));
      assert.equal(r.code, 201, JSON.stringify(r.payload));
      saleIds.push(r.payload.venda.id);
      return r.payload.venda;
    };

    // Venda 1: ficha técnica viva (R$8,00) + imposto 12% (prefixo 6109) + frete
    const v1 = await criar({
      canal: 'LOJA_FISICA',
      occurred_at: '2026-01-15',
      itens: [{ product_id: c.p1, quantity: 2, unit_price_cents: 5000, discount_cents: 1000 }],
      freight_cents: 500,
    });
    assert.equal(v1.amountCents, 9000);
    assert.equal(v1.netCents, 9000);
    assert.equal(v1.cmvCents, 1600);
    assert.equal(v1.taxCents, 1080);
    assert.equal(v1.grossProfitCents, 5820);
    assert.equal(v1.marginPct, 64.6667);

    // Venda 2: sem ficha → custo do produto; NCM exato 8% vence o padrão 5%
    const v2 = await criar({ canal: 'BROBOND', occurred_at: '2026-01-20', itens: [{ product_id: c.p2, quantity: 1, unit_price_cents: 4000 }] });
    assert.equal(v2.cmvCents, 500);
    assert.equal(v2.taxCents, 320);
    assert.equal(v2.grossProfitCents, 3180);
    assert.equal(v2.marginPct, 79.5);

    // Venda 3: produto sem NCM → alíquota padrão 5%
    const v3 = await criar({ canal: 'MERCADOLIVRE', occurred_at: '2026-01-25', itens: [{ product_id: c.p3, quantity: 1, unit_price_cents: 2000 }] });
    assert.equal(v3.taxCents, 100);
    assert.equal(v3.grossProfitCents, 1600);
    assert.equal(v3.marginPct, 80);

    // O recálculo global reescreve as MESMAS colunas (idempotente) direto no banco.
    const recalc = await chamar(negociosMargensRecalcular, mockReq(gerente, {}, {}));
    assert.equal(recalc.payload.ok, true);
    const noBanco = await c.pool!.query(
      `SELECT id, net_cents, cmv_cents, tax_cents, gross_profit_cents, margin_pct, margem_calculada_em
         FROM sales WHERE id = ANY($1::text[]) ORDER BY occurred_at`,
      [saleIds]
    );
    assert.deepEqual(
      noBanco.rows.map((r: any) => [Number(r.net_cents), Number(r.cmv_cents), Number(r.tax_cents), Number(r.gross_profit_cents), Number(r.margin_pct)]),
      [
        [9000, 1600, 1080, 5820, 64.6667],
        [4000, 500, 320, 3180, 79.5],
        [2000, 300, 100, 1600, 80],
      ]
    );
    assert.ok(noBanco.rows.every((r: any) => r.margem_calculada_em !== null), 'carimbo do cálculo gravado');

    // Alíquota nova aplicada RETROATIVAMENTE pela query do motor.
    const { updateRecord } = await import('../src/services');
    await updateRecord(c.RESOURCES.impostos_ncm, Number(c.impostoPrefixo.id), { aliquota_pct: 20 }, gerente);
    await chamar(negociosMargensRecalcular, mockReq(gerente, {}, {}));
    const margens = await chamar(negociosMargens, mockReq(gerente, {}, {}));
    const linhaV1 = margens.payload.linhas.find((l: any) => l.id === v1.id);
    assert.equal(linhaV1.taxCents, 1800, '20% de R$90');
    assert.equal(linhaV1.grossProfitCents, 5100);
    assert.equal(linhaV1.marginPct, 56.6667);
  } finally {
    await c.limpar(saleIds);
    if (impostoPadrao) await c.pool!.query(`DELETE FROM impostos_ncm WHERE id = $1`, [Number(impostoPadrao.id)]);
  }
});

test('curva ABC: classificação 80/15/5 persistida em produto_abc com janela De/Até (PG)', { skip }, async () => {
  const { negociosVendaManual, negociosABCRecalcular, negociosABC } = await import('../src/negocios');
  const sufixo = `a${Date.now() % 1e9}`;
  const c = await cenario(sufixo);
  const gerente = c.gerente;
  const saleIds: string[] = [];
  try {
    await c.createRecord(c.RESOURCES.impostos_ncm, { ncm: '', aliquota_pct: 0 }, gerente);
    const criar = async (body: any) => {
      const r = await chamar(negociosVendaManual, mockReq(gerente, {}, body));
      saleIds.push(r.payload.venda.id);
      return r.payload.venda;
    };
    // 5000 / 3000 (duas vendas) / 1500 / 500 — total 10000
    await criar({ canal: 'LOJA_FISICA', occurred_at: '2026-01-02', itens: [{ product_id: c.p1, quantity: 1, unit_price_cents: 5000 }] });
    await criar({ canal: 'LOJA_FISICA', occurred_at: '2026-01-03', itens: [{ product_id: c.p2, quantity: 2, unit_price_cents: 1000 }] });
    await criar({ canal: 'BROBOND', occurred_at: '2026-01-04', itens: [{ product_id: c.p2, quantity: 1, unit_price_cents: 1000 }] });
    await criar({ canal: 'BROBOND', occurred_at: '2026-01-05', itens: [{ product_id: c.p3, quantity: 3, unit_price_cents: 500 }] });
    await criar({ canal: 'MERCADOLIVRE', occurred_at: '2026-01-06', itens: [{ product_id: c.p4, quantity: 1, unit_price_cents: 500 }] });

    const recalc = await chamar(negociosABCRecalcular, mockReq(gerente, { de: '2026-01-01', ate: '2026-01-31' }));
    assert.equal(recalc.payload.ok, true);
    assert.equal(recalc.payload.produtos, 4);

    const { payload } = await chamar(negociosABC, mockReq(gerente, { de: '2026-01-01', ate: '2026-01-31' }));
    const porProduto = Object.fromEntries(payload.linhas.map((l: any) => [l.produtoId, l]));
    assert.equal(porProduto[c.p1].classe, 'A');
    assert.equal(porProduto[c.p1].pctTotal, 50);
    assert.equal(porProduto[c.p2].classe, 'A');
    assert.equal(porProduto[c.p2].pctAcumulado, 80);
    assert.equal(porProduto[c.p2].faturamentoCents, 3000, 'acumulado por produto, não por pedido');
    assert.equal(porProduto[c.p3].classe, 'B');
    assert.equal(porProduto[c.p3].pctAcumulado, 95);
    assert.equal(porProduto[c.p4].classe, 'C');
    assert.equal(porProduto[c.p4].pctAcumulado, 100);

    // persistiu de verdade, com a janela usada
    const tabela = await c.pool!.query(
      `SELECT produto_id, classe, faturamento_cents, janela_de::date, janela_ate::date
         FROM produto_abc WHERE produto_id = ANY($1::int[]) ORDER BY faturamento_cents DESC`,
      [[c.p1, c.p2, c.p3, c.p4]]
    );
    assert.equal(tabela.rows.length, 4);
    assert.equal(new Date(tabela.rows[0].janela_de).toISOString().slice(0, 10), '2026-01-01');
    assert.equal(new Date(tabela.rows[0].janela_ate).toISOString().slice(0, 10), '2026-01-31');

    // janela estreita reclassifica: só a venda de 06/01 → p4 vira o único A
    const soUmDia = await chamar(negociosABCRecalcular, mockReq(gerente, { de: '2026-01-06', ate: '2026-01-06' }));
    assert.equal(soUmDia.payload.produtos, 1);
    const abcUmDia = await chamar(negociosABC, mockReq(gerente, { de: '2026-01-06', ate: '2026-01-06' }));
    assert.equal(abcUmDia.payload.linhas.length, 1);
    assert.equal(abcUmDia.payload.linhas[0].classe, 'A');
  } finally {
    await c.limpar(saleIds);
    await c.pool!.query(`DELETE FROM impostos_ncm WHERE aliquota_pct = 0 AND ncm IS NULL`);
  }
});

test('impostos_ncm: a linha-padrão é única — índice parcial recusa a segunda (PG)', { skip }, async () => {
  const { RESOURCES, createRecord, pool } = await (async () => {
    const { migrate, pool } = await import('../src/db');
    await migrate();
    const { RESOURCES } = await import('../src/resources');
    const { createRecord } = await import('../src/services');
    return { RESOURCES, createRecord, pool };
  })();
  const padrao = await createRecord(RESOURCES.impostos_ncm, { ncm: '', aliquota_pct: 5 }, gerente);
  try {
    await assert.rejects(
      () => createRecord(RESOURCES.impostos_ncm, { ncm: '', aliquota_pct: 9 }, gerente),
      (e: any) => e.status === 409,
      'duas linhas-padrão são um conflito (409), não um 500'
    );
  } finally {
    await pool!.query(`DELETE FROM impostos_ncm WHERE id = $1`, [Number(padrao.id)]);
  }
});

test('filtros estritos de BI: De/Até inclusivos, canal por grupo e empresa_id (PG)', { skip }, async () => {
  const { negociosVendaManual, negociosResumo } = await import('../src/negocios');
  const sufixo = `f${Date.now() % 1e9}`;
  const c = await cenario(sufixo);
  const gerente = c.gerente;
  const saleIds: string[] = [];
  try {
    await c.createRecord(c.RESOURCES.impostos_ncm, { ncm: '', aliquota_pct: 0 }, gerente);
    const criar = async (body: any) => {
      const r = await chamar(negociosVendaManual, mockReq(gerente, {}, body));
      saleIds.push(r.payload.venda.id);
      return r.payload.venda;
    };
    const vFev = await criar({ canal: 'BROBOND', occurred_at: '2026-02-10', itens: [{ product_id: c.p1, quantity: 1, unit_price_cents: 2000 }] });

    // janela inclusiva do mesmo dia
    const noDia = await chamar(negociosResumo, mockReq(gerente, { de: '2026-02-10', ate: '2026-02-10' }));
    assert.equal(noDia.payload.kpis.faturamentoCents, 2000);
    const umDiaDepois = await chamar(negociosResumo, mockReq(gerente, { de: '2026-02-11', ate: '2026-02-28' }));
    assert.equal(umDiaDepois.payload.kpis.faturamentoCents, 0);

    // canal por grupo e específico
    const ecommerce = await chamar(negociosResumo, mockReq(gerente, { canal: 'ecommerce' }));
    assert.equal(ecommerce.payload.kpis.faturamentoCents, 2000);
    const lojaFisica = await chamar(negociosResumo, mockReq(gerente, { canal: 'loja_fisica' }));
    assert.equal(lojaFisica.payload.kpis.faturamentoCents, 0, 'a única venda é e-commerce');

    // datas ruins continuam 400 no PG
    await assert.rejects(() => chamar(negociosResumo, mockReq(gerente, { de: '2026-13-01' })), /Período inválido/);
    await assert.rejects(() => chamar(negociosResumo, mockReq(gerente, { canal: 'shopee' })), /Canal inválido|Filtro inválido/);

    assert.ok(vFev.id);
  } finally {
    await c.limpar(saleIds);
    await c.pool!.query(`DELETE FROM impostos_ncm WHERE aliquota_pct = 0 AND ncm IS NULL`);
  }
});

test('fuso do negócio (PG): De/Até e data seguem o dia civil de Brasília, nas fronteiras', { skip }, async () => {
  const { negociosVendaManual, negociosResumo } = await import('../src/negocios');
  const sufixo = `f${Date.now() % 1e9}`;
  const c = await cenario(sufixo);
  const gerente = c.gerente;
  const saleIds: string[] = [];
  try {
    const criar = async (iso: string) => {
      const r = await chamar(negociosVendaManual, mockReq(gerente, {}, {
        canal: 'LOJA_FISICA',
        occurred_at: iso,
        itens: [{ product_id: c.p4, quantity: 1, unit_price_cents: 100 }],
      }));
      assert.equal(r.code, 201, JSON.stringify(r.payload));
      saleIds.push(r.payload.venda.id);
      return r.payload.venda;
    };
    const dia = async (de: string, ate: string = de) => {
      const r = await chamar(negociosResumo, mockReq(gerente, { de, ate }));
      return r.payload.kpis.pedidos as number;
    };

    // Fronteiras de 08/10/2026 em Brasília = [03:00Z de 08, 03:00Z de 09).
    const inicio = await criar('2026-10-08T03:00:00.000Z'); // 00:00 BRT dia 08 → dentro
    const fim = await criar('2026-10-09T02:59:59.999Z'); // 23:59:59,999 BRT dia 08 → dentro
    const virada = await criar('2026-10-09T01:30:00.000Z'); // 22:30 BRT dia 08 → dentro (UTC seria dia 09)
    const dia09 = await criar('2026-10-09T03:00:00.000Z'); // 00:00 BRT dia 09 → fora do dia 08
    const antes = await criar('2026-10-08T02:59:59.999Z'); // 23:59:59,999 BRT dia 07 → fora do dia 08

    assert.equal(inicio.data, '2026-10-08');
    assert.equal(fim.data, '2026-10-08');
    assert.equal(virada.data, '2026-10-08');
    assert.equal(dia09.data, '2026-10-09');
    assert.equal(antes.data, '2026-10-07');

    assert.equal(await dia('2026-10-08'), 3, 'início, fim e virada UTC/Brasília no dia 08');
    assert.equal(await dia('2026-10-09'), 1, 'só a meia-noite do dia 09');
    assert.equal(await dia('2026-10-07'), 1, 'só o 23:59:59,999 do dia 07');

    // Virada de mês: 31/10 às 22h BRT = 01/11 UTC → outubro.
    const fimOutubro = await criar('2026-11-01T01:00:00.000Z');
    assert.equal(fimOutubro.mes, '2026-10');
    assert.equal(await dia('2026-10-31'), 1);
    assert.equal(await dia('2026-11-01'), 0);

    // Virada de ano: 31/12 às 21h30 BRT = 01/01 UTC → 2026-12.
    const fimAno = await criar('2027-01-01T00:30:00.000Z');
    assert.equal(fimAno.data, '2026-12-31');
    assert.equal(await dia('2026-12-31'), 1);
    assert.equal(await dia('2027-01-01'), 0);
  } finally {
    await c.limpar(saleIds);
  }
});
