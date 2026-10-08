// ============================================================
// Motor analítico 1. MEU NEGÓCIOS — testes da matemática e dos
// filtros estritos em modo memória (mesmas regras do Postgres).
//
// Os números esperados são calculados À MÃO, centavo a centavo: a
// fórmula do lucro bruto (líquido − CMV da ficha técnica − impostos
// por NCM − frete pago), a curva ABC 80/15/5 e os agregadores de BI
// têm que bater EXATAMENTE — nunca "aproximadamente".
//
// Contra Postgres de verdade (query SQL materializada), a mesma prova
// roda em pg-negocios.test.ts (job testes-postgres do CI).
// ============================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, getStore } = await import('../src/services');
const {
  __reiniciarMemoriaNegocios,
  agregarResumo,
  calcularLucroBrutoCents,
  calcularMargemPct,
  classificarCurvaABC,
  grupoDoCanal,
  normalizarNcm,
  resolverAliquota,
  round4,
  roundCents,
  negociosABC,
  negociosABCRecalcular,
  negociosCanais,
  negociosMargens,
  negociosMargensRecalcular,
  negociosResumo,
  negociosVendaManual,
} = await import('../src/negocios');

const admin = { id: 1, name: 'Admin', email: 'admin@brobond.com.br', perfil: 'admin' as const };
const gerente = { id: 2, name: 'Gerente', email: 'gerente@brobond.com.br', perfil: 'gerente' as const };
const operador = { id: 3, name: 'Operador', email: 'operador@brobond.com.br', perfil: 'operador' as const };

function mockReq(user: any, query: Record<string, string> = {}, body: any = {}): any {
  return { user, query, body, params: {} };
}
function mockRes(): { res: any; payload: () => any; code: () => number } {
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

/** Registra uma venda manual (o caminho da API — nada de atalho interno). */
async function vender(body: any, user = gerente) {
  return chamar(negociosVendaManual, mockReq(user, {}, body));
}

// --- Fixtures: produtos, ficha técnica, insumos e alíquotas ----------------

let p1 = 0; // com ficha técnica viva (custo 8,00) e NCM 6109.10.00
let p2 = 0; // sem ficha → produtos.custo 5,00; NCM 6203.42.00 (chave exata)
let p3 = 0; // sem NCM → alíquota padrão; sem ficha → custo 3,00
let tamanhoM = 0;

async function setupFixtures() {
  const s = getStore();
  const insumo = await createRecord(RESOURCES.insumos, { nome: 'Malha penteada', unidade: 'm', custo_medio: 2 }, admin);

  p1 = Number(
    (
      await createRecord(
        RESOURCES.produtos,
        { sku: 'NEG-1', nome: 'Camiseta Meu Negócio', ncm: '6109.10.00', custo: 8, preco_venda: 50 },
        admin
      )
    ).id
  );
  p2 = Number((await createRecord(RESOURCES.produtos, { sku: 'NEG-2', nome: 'Calça Meu Negócio', ncm: '6203.42.00', custo: 5, preco_venda: 40 }, admin)).id);
  p3 = Number((await createRecord(RESOURCES.produtos, { sku: 'NEG-3', nome: 'Bermuda sem NCM', custo: 3, preco_venda: 20 }, admin)).id);

  // Ficha técnica de P1: 1,5 m × R$2,00 × (1 + 10% perda) + R$4,00 mão de
  // obra + R$0,70 indiretos = R$3,30 + R$4,70 = R$8,00 por peça.
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: p1, mao_obra: 4, custos_indiretos: 0.7 }, admin);
  await s.insert(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: 1.5, perda_pct: 10 });

  // Alíquotas: prefixo 6109 → 12%; NCM exato 62034200 → 8%; padrão (vazio) → 5%.
  await createRecord(RESOURCES.impostos_ncm, { ncm: '6109', aliquota_pct: 12 }, admin);
  await createRecord(RESOURCES.impostos_ncm, { ncm: '62034200', aliquota_pct: 8 }, admin);
  await createRecord(RESOURCES.impostos_ncm, { ncm: '', aliquota_pct: 5 }, admin);

  const tamanhos = await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 50 });
  tamanhoM = tamanhos.rows.length ? Number(tamanhos.rows[0].id) : Number((await createRecord(RESOURCES.tamanhos, { codigo: 'M', ordem: 1 }, admin)).id);
}

before(async () => {
  await setupFixtures();
});

// ----------------------------------------------------------------------------
// 1) Motor puro
// ----------------------------------------------------------------------------

test('round4/roundCents: metade para LONGE do zero (idêntico ao ROUND do Postgres)', () => {
  assert.equal(round4(64.66666666666667), 64.6667);
  assert.equal(round4(-12.3456789), -12.3457);
  assert.equal(round4(0.00005), 0.0001);
  assert.equal(round4(-0.00005), -0.0001);
  assert.equal(roundCents(2.5), 3);
  assert.equal(roundCents(-2.5), -3);
  assert.equal(roundCents(1079.9999999), 1080);
});

test('normalizarNcm: remove pontuação e limita a 8 dígitos', () => {
  assert.equal(normalizarNcm('6109.10.00'), '61091000');
  assert.equal(normalizarNcm('61.09.10.00.99'), '61091000');
  assert.equal(normalizarNcm(null), '');
  assert.equal(normalizarNcm('abc'), '');
});

test('resolverAliquota: exato > prefixo > padrão; sem cadastro = 0%', () => {
  const chaves = new Map([
    ['61091000', 18],
    ['6109', 12],
    ['61', 7],
    ['', 5], // linha-padrão (ncm IS NULL no banco)
  ]);
  assert.equal(resolverAliquota('6109.10.00', chaves), 18, 'NCM exato (8d) vence');
  assert.equal(resolverAliquota('6109.20.00', chaves), 12, 'sem o exato, o prefixo 6109 vence o capítulo 61');
  assert.equal(resolverAliquota('6199.99.99', chaves), 7, 'capítulo 61 (2 dígitos) casa com qualquer NCM 61xxxxxx');
  assert.equal(resolverAliquota('6203.42.00', chaves), 5, '6203 não casa com nenhuma chave → alíquota padrão');
  assert.equal(resolverAliquota('', chaves), 5, 'sem NCM → linha-padrão');
  assert.equal(resolverAliquota('99999999', new Map([['61', 7]])), 0, 'sem casamento e sem padrão = 0%');
  assert.equal(resolverAliquota('61091000', new Map()), 0, 'tabela vazia = 0%');
});

test('classificarCurvaABC: 80/15/5 exatos com cruzamento pertencente à classe anterior', () => {
  // 50 + 30 + 15 + 5 = 100 → A={50,30} (acum. 80%), B={15} (95%), C={5}
  const linhas = classificarCurvaABC([
    { produtoId: 4, faturamentoCents: 500 },
    { produtoId: 1, faturamentoCents: 5000 },
    { produtoId: 3, faturamentoCents: 1500 },
    { produtoId: 2, faturamentoCents: 3000 },
  ]);
  assert.deepEqual(
    linhas.map((l) => [l.produtoId, l.classe]),
    [
      [1, 'A'],
      [2, 'A'],
      [3, 'B'],
      [4, 'C'],
    ]
  );
  assert.equal(linhas[0].pctTotal, 50);
  assert.equal(linhas[0].pctAcumulado, 50);
  assert.equal(linhas[1].pctTotal, 30);
  assert.equal(linhas[1].pctAcumulado, 80);
  assert.equal(linhas[2].pctAcumulado, 95);
  assert.equal(linhas[3].pctAcumulado, 100);

  // Produto único com 100% do faturamento é A (não C) — o item que cruza o
  // limite pertence à classe anterior.
  const unico = classificarCurvaABC([{ produtoId: 9, faturamentoCents: 100 }]);
  assert.equal(unico[0].classe, 'A');
  assert.equal(unico[0].pctAcumulado, 100);

  // Empate de faturamento: ordem determinística pelo menor produto_id.
  const empate = classificarCurvaABC([
    { produtoId: 2, faturamentoCents: 100 },
    { produtoId: 1, faturamentoCents: 100 },
  ]);
  assert.deepEqual(empate.map((l) => l.produtoId), [1, 2]);

  // Sem faturamento → nada classificado (nada é fabricado).
  assert.deepEqual(classificarCurvaABC([{ produtoId: 1, faturamentoCents: 0 }]), []);
  assert.deepEqual(classificarCurvaABC([]), []);
});

test('fórmula: lucro = líquido − CMV − impostos − frete; margem = lucro/líquido × 100', () => {
  assert.equal(calcularLucroBrutoCents(9000, 1600, 1080, 500), 5820);
  assert.equal(calcularMargemPct(5820, 9000), 64.6667);
  assert.equal(calcularMargemPct(-500, 9000), -5.5556);
  assert.equal(calcularMargemPct(100, 0), 0, 'líquido zero → margem 0 (nunca dividi por zero)');
});

test('grupoDoCanal: Loja Física / E-commerce / Marketplaces', () => {
  assert.equal(grupoDoCanal('LOJA_FISICA'), 'loja_fisica');
  assert.equal(grupoDoCanal('BROBOND'), 'ecommerce');
  assert.equal(grupoDoCanal('NUVEMSHOP'), 'ecommerce');
  assert.equal(grupoDoCanal('INSTAGRAM_SHOPPING'), 'ecommerce');
  assert.equal(grupoDoCanal('MERCADOPAGO'), 'ecommerce');
  assert.equal(grupoDoCanal('MERCADOLIVRE'), 'marketplace');
});

// ----------------------------------------------------------------------------
// 2) Motor de margem por pedido (venda manual → colunas reais)
// ----------------------------------------------------------------------------

test('margem por pedido: ficha técnica viva + imposto por NCM (prefixo) + frete', async () => {
  __reiniciarMemoriaNegocios();
  const { code, payload } = await vender({
    itens: [{ product_id: p1, size_id: tamanhoM, quantity: 2, unit_price_cents: 5000, discount_cents: 1000 }],
    freight_cents: 500,
  });
  assert.equal(code, 201);
  const v = payload.venda;
  assert.equal(v.canal, 'LOJA_FISICA', 'canal padrão da venda manual é Loja Física');
  assert.equal(v.status, 'PAID', 'status padrão é PAID (faturada)');
  assert.equal(v.amountCents, 9000, '2 × R$50 − R$10 de desconto = R$90');
  assert.equal(v.netCents, 9000, 'valor líquido = total pago');
  assert.equal(v.cmvCents, 1600, 'CMV = 2 peças × R$8,00 da ficha técnica');
  assert.equal(v.taxCents, 1080, 'impostos = 12% (NCM 6109) de R$90 = R$10,80');
  assert.equal(v.freightCents, 500, 'frete pago gravado');
  assert.equal(v.grossProfitCents, 5820, 'lucro bruto = 9000 − 1600 − 1080 − 500');
  assert.equal(v.marginPct, 64.6667, 'margem = 5820/9000 × 100');
  assert.ok(v.margemCalculadaEm, 'carimbo do cálculo presente');
  assert.equal(payload.itens.length, 1);
});

test('margem por pedido: sem ficha → custo do produto; NCM exato vence o padrão', async () => {
  const { payload } = await vender({ canal: 'BROBOND', itens: [{ product_id: p2, quantity: 1, unit_price_cents: 4000 }] });
  const v = payload.venda;
  assert.equal(v.canalGrupo, 'ecommerce');
  assert.equal(v.cmvCents, 500, 'sem ficha técnica → produtos.custo R$5,00');
  assert.equal(v.taxCents, 320, 'NCM 62034200 exato → 8% de R$40 = R$3,20 (não os 5% padrão)');
  assert.equal(v.grossProfitCents, 4000 - 500 - 320);
  assert.equal(v.marginPct, 79.5);
});

test('margem por pedido: produto sem NCM usa a alíquota padrão cadastrada', async () => {
  const { payload } = await vender({ itens: [{ product_id: p3, quantity: 1, unit_price_cents: 2000 }] });
  const v = payload.venda;
  assert.equal(v.cmvCents, 300);
  assert.equal(v.taxCents, 100, '5% padrão de R$20');
  assert.equal(v.grossProfitCents, 1600);
  assert.equal(v.marginPct, 80);
});

test('recalcular margens: nova alíquota aplicada retroativamente pela query do motor', async () => {
  // sobe a alíquota do prefixo 6109 de 12% para 20%
  const impostos = await getStore().list(RESOURCES.impostos_ncm, { page: 1, pageSize: 50, filter: { ncm: '6109' } });
  await updateRecord(RESOURCES.impostos_ncm, Number(impostos.rows[0].id), { aliquota_pct: 20 }, admin);
  const { payload } = await chamar(negociosMargensRecalcular, mockReq(gerente, {}, {}));
  assert.equal(payload.ok, true);
  assert.equal(payload.vendas, 3, 'três vendas recalculadas');

  const margens = await chamar(negociosMargens, mockReq(gerente, {}, {}));
  const venda1 = margens.payload.linhas.find((l: any) => l.amountCents === 9000);
  assert.ok(venda1, 'a venda de R$90 está na listagem');
  assert.equal(venda1.taxCents, 1800, '20% de R$90 = R$18,00');
  assert.equal(venda1.grossProfitCents, 9000 - 1600 - 1800 - 500);
  assert.equal(venda1.marginPct, 56.6667);
  const vendaPadrao = margens.payload.linhas.find((l: any) => l.amountCents === 2000);
  assert.equal(vendaPadrao.taxCents, 100, 'a venda sem NCM continua nos 5% padrão');

  // volta para 12% e prova que o recálculo é retroativo de novo
  await updateRecord(RESOURCES.impostos_ncm, Number(impostos.rows[0].id), { aliquota_pct: 12 }, admin);
  await chamar(negociosMargensRecalcular, mockReq(gerente, {}, {}));
  const restaurado = await chamar(negociosMargens, mockReq(gerente, {}, {}));
  assert.equal(restaurado.payload.linhas.find((l: any) => l.amountCents === 9000).taxCents, 1080);
});

// ----------------------------------------------------------------------------
// 3) Filtros estritos de BI (De/Até, empresa_id, canal)
// ----------------------------------------------------------------------------

test('filtros estritos: datas inválidas, canal desconhecido, empresa e status ruins → 400', async () => {
  const casos: Record<string, string>[] = [
    { de: '2026-13-01' },
    { de: '15/01/2026' },
    { de: '2026-02-30' },
    { de: '2026-01-10', ate: '2026-01-01' },
    { canal: 'shopee' },
    { empresa_id: 'abc' },
    { empresa_id: '-3' },
    { status: 'CONCLUIDA' },
  ];
  for (const query of casos) {
    await assert.rejects(() => chamar(negociosResumo, mockReq(gerente, query)), /inválido|posterior/i, JSON.stringify(query));
  }
});

test('filtros estritos: período De/Até por data UTC de occurred_at', async () => {
  __reiniciarMemoriaNegocios();
  await vender({ canal: 'LOJA_FISICA', occurred_at: '2026-01-15', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }] });
  await vender({ canal: 'BROBOND', occurred_at: '2026-02-10', itens: [{ product_id: p2, quantity: 1, unit_price_cents: 2000 }] });
  await vender({ canal: 'MERCADOLIVRE', occurred_at: '2026-03-05', itens: [{ product_id: p3, quantity: 1, unit_price_cents: 3000 }] });

  const fevereiro = await chamar(negociosResumo, mockReq(gerente, { de: '2026-02-01', ate: '2026-02-28' }));
  assert.equal(fevereiro.payload.kpis.faturamentoCents, 2000, 'só a venda de fevereiro');
  assert.equal(fevereiro.payload.kpis.pedidos, 1);

  const limite = await chamar(negociosResumo, mockReq(gerente, { de: '2026-01-15', ate: '2026-01-15' }));
  assert.equal(limite.payload.kpis.faturamentoCents, 1000, 'De e Até são inclusivos (mesmo dia)');

  const fora = await chamar(negociosResumo, mockReq(gerente, { de: '2026-01-16', ate: '2026-01-31' }));
  assert.equal(fora.payload.kpis.faturamentoCents, 0, 'um dia depois já não entra');
});

test('filtros estritos: canal por grupo (Loja Física/E-commerce/Marketplaces) e por canal específico', async () => {
  const lojaFisica = await chamar(negociosResumo, mockReq(gerente, { canal: 'loja_fisica' }));
  assert.equal(lojaFisica.payload.kpis.faturamentoCents, 1000);

  const ecommerce = await chamar(negociosResumo, mockReq(gerente, { canal: 'ecommerce' }));
  assert.equal(ecommerce.payload.kpis.faturamentoCents, 2000, 'BROBOND é E-commerce');

  const marketplaces = await chamar(negociosResumo, mockReq(gerente, { canal: 'marketplace' }));
  assert.equal(marketplaces.payload.kpis.faturamentoCents, 3000, 'Mercado Livre é Marketplace');

  const especifico = await chamar(negociosResumo, mockReq(gerente, { canal: 'MERCADOLIVRE' }));
  assert.equal(especifico.payload.kpis.faturamentoCents, 3000, 'filtro por canal específico também funciona');
});

test('filtros estritos: empresa_id isola o faturamento da empresa (com concessão explícita)', async () => {
  const empresa2 = Number((await createRecord(RESOURCES.empresas, { nome: 'Brobond Filial' }, admin)).id);
  const gerenteMulti = { ...gerente, empresa_id: 1, empresas: [1, empresa2] };
  await vender({ canal: 'LOJA_FISICA', empresa_id: 1, occurred_at: '2026-04-01', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }] });
  await vender({ canal: 'BROBOND', empresa_id: empresa2, occurred_at: '2026-04-02', itens: [{ product_id: p2, quantity: 1, unit_price_cents: 4000 }] }, gerenteMulti);

  const daEmpresa1 = await chamar(negociosResumo, mockReq(gerenteMulti, { empresa_id: '1' }));
  assert.equal(daEmpresa1.payload.kpis.faturamentoCents, 7000, 'jan 1000 + fev 2000 + mar 3000 + abr 1000 — nada da filial');
  const daEmpresa2 = await chamar(negociosResumo, mockReq(gerenteMulti, { empresa_id: String(empresa2) }));
  assert.equal(daEmpresa2.payload.kpis.faturamentoCents, 4000, 'só a venda da filial');
  assert.equal(daEmpresa2.payload.kpis.pedidos, 1);

  // Filial concedida mas sem vendas: zero (não erro, não consolidação).
  const filialVazia = Number((await createRecord(RESOURCES.empresas, { nome: 'Filial Vazia' }, admin)).id);
  const gerenteComVazia = { ...gerente, empresa_id: 1, empresas: [1, empresa2, filialVazia] };
  const semVendas = await chamar(negociosResumo, mockReq(gerenteComVazia, { empresa_id: String(filialVazia) }));
  assert.equal(semVendas.payload.kpis.faturamentoCents, 0, 'empresa concedida sem vendas retorna zero (não erro)');

  // MULTIEMPRESA: sem concessão, empresa alheia ou inexistente responde 403.
  await assert.rejects(() => chamar(negociosResumo, mockReq(gerente, { empresa_id: String(empresa2) })), /Você não tem acesso/);
  await assert.rejects(() => chamar(negociosResumo, mockReq(gerente, { empresa_id: '999' })), /não tem acesso/);
});

test('BI multiempresa: empresa não concedida responde 403 (resumo, margens, ABC, venda manual)', async () => {
  const outra = Number((await createRecord(RESOURCES.empresas, { nome: 'Filial 403' }, admin)).id);
  const soA = { ...gerente, empresa_id: 1, empresas: [1] };
  await assert.rejects(() => chamar(negociosResumo, mockReq(soA, { empresa_id: String(outra) })), /não tem acesso/);
  await assert.rejects(() => chamar(negociosMargens, mockReq(soA, { empresa_id: String(outra) })), /não tem acesso/);
  await assert.rejects(() => chamar(negociosABC, mockReq(soA, { empresa_id: String(outra) })), /não tem acesso/);
  await assert.rejects(
    () => vender({ canal: 'LOJA_FISICA', empresa_id: outra, itens: [{ product_id: p1, quantity: 1, unit_price_cents: 100 }] }, soA),
    /não tem acesso/
  );
});

test('BI multiempresa: sem empresa_id filtra pela ativa; consolidado autorizado soma tudo', async () => {
  const filial = Number((await createRecord(RESOURCES.empresas, { nome: 'Filial BI' }, admin)).id);
  const gerenteA = { ...gerente, empresa_id: 1, empresas: [1] };
  const gerenteB = { ...gerente, id: 22, empresa_id: filial, empresas: [filial] };
  const auditor = { ...gerente, id: 23, empresa_id: 1, empresas: [1, filial], pode_consolidar: true, consolidar: true };
  const antesCons = await chamar(negociosResumo, mockReq(auditor, {}));
  await vender({ canal: 'LOJA_FISICA', empresa_id: 1, itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }] }, gerenteA);
  await vender({ canal: 'LOJA_FISICA', empresa_id: filial, itens: [{ product_id: p1, quantity: 1, unit_price_cents: 5000 }] }, gerenteB);

  const soB = await chamar(negociosResumo, mockReq(gerenteB, {}));
  assert.equal(soB.payload.kpis.faturamentoCents, 5000, 'sem empresa_id, a filial vê só a filial');
  const tudo = await chamar(negociosResumo, mockReq(auditor, {}));
  assert.equal(tudo.payload.kpis.faturamentoCents - antesCons.payload.kpis.faturamentoCents, 6000, 'consolidado soma todas as empresas');

  const abcB = await chamar(negociosABC, mockReq(gerenteB, {}));
  assert.ok(abcB.payload.linhas.length > 0, 'a filial tem linhas na curva ABC');
  assert.ok(abcB.payload.linhas.every((l: any) => l.empresaId === filial), 'ABC sem empresa_id filtra pela ativa');

  // Venda manual sem empresa cai na ATIVA (antes caía sempre na 1).
  const { payload } = await vender({ canal: 'LOJA_FISICA', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 700 }] }, gerenteB);
  assert.equal(payload.venda.empresaId, filial);
});

test('filtros estritos: status filtra a listagem de margens', async () => {
  await vender({ canal: 'LOJA_FISICA', status: 'PENDING', occurred_at: '2026-04-02', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 700 }] });
  const pendentes = await chamar(negociosMargens, mockReq(gerente, { status: 'PENDING' }));
  assert.ok(pendentes.payload.linhas.every((l: any) => l.status === 'PENDING'));
  assert.equal(pendentes.payload.linhas.length, 1);
});

// ----------------------------------------------------------------------------
// 4) Agregadores do Dashboard
// ----------------------------------------------------------------------------

test('resumo: KPIs, por canal, por status, por mês e top produtos — só vendas PAID faturam', async () => {
  __reiniciarMemoriaNegocios();
  // Janeiro: loja física R$100 (lucro 58,20… recalculado abaixo) + e-commerce R$40
  await vender({ canal: 'LOJA_FISICA', occurred_at: '2026-01-15', itens: [{ product_id: p1, quantity: 2, unit_price_cents: 5000, discount_cents: 1000 }], freight_cents: 500 });
  await vender({ canal: 'BROBOND', occurred_at: '2026-01-20', itens: [{ product_id: p2, quantity: 1, unit_price_cents: 4000 }] });
  // Fevereiro: marketplace R$20 (PENDING — não conta no faturamento)
  await vender({ canal: 'MERCADOLIVRE', occurred_at: '2026-02-05', status: 'PENDING', itens: [{ product_id: p3, quantity: 1, unit_price_cents: 2000 }] });

  const { payload } = await chamar(negociosResumo, mockReq(gerente, {}));
  const k = payload.kpis;
  assert.equal(k.faturamentoCents, 13000, '9000 + 4000 — PENDING não fatura');
  assert.equal(k.pedidos, 2);
  assert.equal(k.pedidosPendentes, 1);
  assert.equal(k.ticketMedioCents, 6500, '13000 ÷ 2');
  // lucro = 5820 (venda 1) + 3180 (venda 2)
  assert.equal(k.lucroBrutoCents, 5820 + 3180);
  assert.equal(k.cmvCents, 1600 + 500);
  assert.equal(k.impostosCents, 1080 + 320);
  assert.equal(k.freteCents, 500);
  assert.equal(k.margemPct, 69.2308, '9000/13000 × 100');
  assert.equal(k.semMargemCalculada, 0);

  const grupos = Object.fromEntries(payload.porCanal.map((g: any) => [g.grupo, g]));
  assert.equal(grupos.loja_fisica.faturamentoCents, 9000);
  assert.equal(grupos.loja_fisica.pedidos, 1);
  assert.equal(grupos.ecommerce.faturamentoCents, 4000);
  assert.equal(grupos.marketplace.faturamentoCents, 0, 'marketplace só tem venda PENDING');
  assert.equal(payload.porCanal.length, 3, 'os três grupos sempre presentes (mesmo zerados)');

  const statusPendente = payload.porStatus.find((s: any) => s.status === 'PENDING');
  assert.equal(statusPendente.pedidos, 1);

  assert.deepEqual(
    payload.porMes.map((m: any) => [m.mes, m.faturamentoCents]),
    [['2026-01', 13000]], 'fevereiro só tem venda PENDING → não aparece no faturamento'
  );

  assert.equal(payload.topProdutos[0].productId, p1, 'top produto por faturamento');
  assert.equal(payload.topProdutos[0].faturamentoCents, 9000);
  assert.equal(payload.topProdutos[0].quantidade, 2);
});

test('agregarResumo: venda sem margem calculada é contada, nunca fabricada', () => {
  const venda = {
    id: 'x',
    reference: 'r',
    externalOrderId: null,
    status: 'PAID',
    canal: 'LOJA_FISICA',
    canalLabel: 'Loja física',
    canalGrupo: 'loja_fisica' as const,
    grupoLabel: 'Loja Física',
    data: '2026-01-01',
    mes: '2026-01',
    occurredAt: '2026-01-01T12:00:00.000Z',
    empresaId: 1,
    quantidade: 1,
    amountCents: 1000,
    netCents: null,
    cmvCents: null,
    taxCents: null,
    freightCents: 0,
    grossProfitCents: null,
    marginPct: null,
    margemCalculadaEm: null,
    itens: 1,
  };
  const r = agregarResumo([venda as any], [], []);
  assert.equal(r.kpis.faturamentoCents, 0, 'sem margem materializada o KPI não inventa valor');
  assert.equal(r.kpis.semMargemCalculada, 1);
});

// ----------------------------------------------------------------------------
// 5) Curva ABC nativa (persistida e contínua)
// ----------------------------------------------------------------------------

test('curva ABC: faturamento acumulado 80/15/5 classificado e persistido', async () => {
  __reiniciarMemoriaNegocios();
  // Distribuição exata 50/30/15/5 — p2 faturado em DUAS vendas para provar
  // que o acumulado é por produto, não por pedido.
  const p4 = Number((await createRecord(RESOURCES.produtos, { sku: 'NEG-4', nome: 'Boné Meu Negócio', custo: 2, preco_venda: 5 }, admin)).id);
  await vender({ canal: 'LOJA_FISICA', occurred_at: '2026-01-02', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 5000 }] });
  await vender({ canal: 'LOJA_FISICA', occurred_at: '2026-01-03', itens: [{ product_id: p2, quantity: 2, unit_price_cents: 1000 }] });
  await vender({ canal: 'BROBOND', occurred_at: '2026-01-04', itens: [{ product_id: p2, quantity: 1, unit_price_cents: 1000 }] });
  await vender({ canal: 'BROBOND', occurred_at: '2026-01-05', itens: [{ product_id: p3, quantity: 3, unit_price_cents: 500 }] });
  await vender({ canal: 'MERCADOLIVRE', occurred_at: '2026-01-06', itens: [{ product_id: p4, quantity: 1, unit_price_cents: 500 }] });

  // Recalcula com janela explícita para provar o recorte por período.
  const recalc = await chamar(negociosABCRecalcular, mockReq(gerente, { de: '2026-01-01', ate: '2026-01-31' }));
  assert.equal(recalc.payload.ok, true);
  assert.equal(recalc.payload.produtos, 4);

  const { payload } = await chamar(negociosABC, mockReq(gerente, {}));
  // p1 = 5000 (50%), p2 = 2000 + 1000 (30%, acum. 80%), p3 = 1500 (15%, acum. 95%), p4 = 500 (5%)
  const porProduto = Object.fromEntries(payload.linhas.map((l: any) => [l.produtoId, l]));
  assert.equal(porProduto[p1].classe, 'A');
  assert.equal(porProduto[p1].pctTotal, 50);
  assert.equal(porProduto[p1].pctAcumulado, 50);
  assert.equal(porProduto[p2].classe, 'A', 'p2 fecha os 80% acumulados → A');
  assert.equal(porProduto[p2].pctTotal, 30);
  assert.equal(porProduto[p2].pctAcumulado, 80);
  assert.equal(porProduto[p3].classe, 'B', '15% seguinte → B');
  assert.equal(porProduto[p3].pctAcumulado, 95);
  assert.equal(porProduto[p4].classe, 'C', '5% restantes → C');
  assert.equal(porProduto[p4].pctAcumulado, 100);
  assert.equal(porProduto[p2].faturamentoCents, 3000, 'faturamento acumulado por produto, não por pedido');

  const resumoA = payload.resumo.find((r: any) => r.classe === 'A');
  assert.equal(resumoA.itens, 2);
  assert.equal(resumoA.faturamentoCents, 8000);
  const resumoC = payload.resumo.find((r: any) => r.classe === 'C');
  assert.equal(resumoC.faturamentoCents, 500);
  const soA = await chamar(negociosABC, mockReq(gerente, { classe: 'A' }));
  assert.equal(soA.payload.linhas.length, 2);

  await assert.rejects(() => chamar(negociosABC, mockReq(gerente, { classe: 'D' })), /classe/i);
});

test('curva ABC: recorte por janela De/Até muda a classificação', async () => {
  // Fora da janela, p1 (o item A acima) não existe: só p4 → A sozinho.
  const { payload } = await chamar(negociosABCRecalcular, mockReq(gerente, { de: '2026-01-06', ate: '2026-01-06' }));
  assert.equal(payload.produtos, 1);
  const abc = await chamar(negociosABC, mockReq(gerente, { de: '2026-01-06', ate: '2026-01-06' }));
  assert.equal(abc.payload.linhas.length, 1);
  assert.equal(abc.payload.linhas[0].classe, 'A', 'produto único na janela é classe A');
  // sem janela = tudo
  await chamar(negociosABCRecalcular, mockReq(gerente, {}));
});

test('curva ABC: classificação contínua após cada venda (sem recálculo manual)', async () => {
  __reiniciarMemoriaNegocios();
  await vender({ canal: 'LOJA_FISICA', occurred_at: '2026-01-02', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 8000 }] });
  let { payload } = await chamar(negociosABC, mockReq(gerente, {}));
  assert.equal(payload.linhas.length, 1, 'classificou logo após a venda');
  assert.equal(payload.linhas[0].classe, 'A');

  await vender({ canal: 'MERCADOLIVRE', occurred_at: '2026-01-03', itens: [{ product_id: p2, quantity: 1, unit_price_cents: 2000 }] });
  ({ payload } = await chamar(negociosABC, mockReq(gerente, {})));
  assert.equal(payload.linhas.length, 2);
  assert.equal(payload.linhas[0].produtoId, p1, 'ordenada por faturamento decrescente');
});

// ----------------------------------------------------------------------------
// 6) Permissões
// ----------------------------------------------------------------------------

test('margens e recálculos exigem gerente/admin; resumo e ABC bastam leitura de vendas', async () => {
  await assert.rejects(() => chamar(negociosMargens, mockReq(operador, {})), /gerente/i);
  await assert.rejects(() => chamar(negociosMargensRecalcular, mockReq(operador, {})), /gerente/i);
  await assert.rejects(() => chamar(negociosABCRecalcular, mockReq(operador, {})), /gerente/i);

  const resumoOperador = await chamar(negociosResumo, mockReq(operador, {}));
  assert.equal(resumoOperador.code, 200, 'operador vê o resumo (leitura de vendas)');
  const abcOperador = await chamar(negociosABC, mockReq(operador, {}));
  assert.equal(abcOperador.code, 200);

  const margensGerente = await chamar(negociosMargens, mockReq(gerente, {}));
  assert.equal(margensGerente.code, 200, 'gerente vê margens por pedido');
  const adminOk = await chamar(negociosMargensRecalcular, mockReq(admin, {}));
  assert.equal(adminOk.payload.ok, true);
});

test('venda manual: operador pode registrar (mesma permissão de criar vendas)', async () => {
  const { code, payload } = await vender({ canal: 'LOJA_FISICA', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }] }, operador);
  assert.equal(code, 201);
  assert.equal(payload.venda.status, 'PAID');
});

// ----------------------------------------------------------------------------
// 7) Venda manual — validações estritas
// ----------------------------------------------------------------------------

test('venda manual: payload inválido é rejeitado com 400 e mensagem clara', async () => {
  const casos: any[] = [
    { canal: 'SHOPEE', itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }] },
    { canal: 'loja_fisica', itens: [] }, // grupo não é canal válido + sem itens
    { itens: [] },
    { itens: [{ product_id: 999999, quantity: 1, unit_price_cents: 1000 }] },
    { itens: [{ product_id: p1, quantity: 0, unit_price_cents: 1000 }] },
    { itens: [{ product_id: p1, quantity: 1, unit_price_cents: -5 }] },
    { itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000, discount_cents: 99999 }] },
    { itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000, size_id: 987654 }] },
    { itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }], freight_cents: -10 },
    { itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }], status: 'REFUNDED' },
    { itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }], occurred_at: 'ontem' },
    { itens: [{ product_id: p1, quantity: 1, unit_price_cents: 1000 }], currency: 'reais' },
  ];
  for (const body of casos) {
    await assert.rejects(() => vender(body), /inválido|inexistente|Campo obrigatório|precisa de ao menos/i, JSON.stringify(body));
  }
});

test('venda manual: desconto por item reduz o subtotal e o valor líquido', async () => {
  __reiniciarMemoriaNegocios();
  const { payload } = await vender({
    canal: 'LOJA_FISICA',
    itens: [
      { product_id: p1, quantity: 1, unit_price_cents: 5000, discount_cents: 500 },
      { product_id: p2, quantity: 2, unit_price_cents: 2000, discount_cents: 400 },
    ],
  });
  const v = payload.venda;
  assert.equal(v.quantidade, 3, 'quantidade = Σ itens');
  assert.equal(v.amountCents, 4500 + 3600, 'Σ subtotais líquidos de desconto');
  assert.equal(v.netCents, 8100);
});

// ----------------------------------------------------------------------------
// 8) Mapa de canais (contrato para a UI)
// ----------------------------------------------------------------------------

test('GET /api/negocios/canais devolve o mapeamento aprovado', async () => {
  const { payload } = await chamar(negociosCanais, mockReq(operador, {}));
  const grupos = Object.fromEntries(payload.grupos.map((g: any) => [g.grupo, g.canais.map((c: any) => c.canal)]));
  assert.deepEqual(grupos.loja_fisica, ['LOJA_FISICA']);
  assert.deepEqual(grupos.ecommerce.sort(), ['BROBOND', 'INSTAGRAM_SHOPPING', 'MERCADOPAGO', 'NUVEMSHOP'].sort());
  assert.deepEqual(grupos.marketplace, ['MERCADOLIVRE']);
  assert.equal(payload.statusFaturamento, 'PAID');
});
