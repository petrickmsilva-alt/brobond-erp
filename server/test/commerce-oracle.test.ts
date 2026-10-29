// ============================================================================
// BROBOND COMMERCE OS — ORÁCULO INDEPENDENTE DAS REGRAS PURAS
// ----------------------------------------------------------------------------
// Regra deste arquivo: o valor esperado NUNCA é produzido pela função que está
// sendo testada. Cada expectativa deriva de um cálculo reescrito à mão aqui,
// a partir do enunciado de negócio:
//
//   • dinheiro → aritmética decimal EXATA em algarismos inteiros (string de 4
//     casas → half-up para centavos), nunca `round2`/`paraCentavos` do alvo;
//   • estados → máquina de transições escrita de novo (spec de pós-venda);
//   • SQL → vocabulário extraído por regex direto da migration 0068 (contrato
//     banco ↔ código sem passar pelo código).
//
// Cobertura:
//   A) round2 / paraCentavos / deCentavos — meio-centavo para CIMA;
//   B) preço efetivo por canal × vigência × promoção (nunca sobe preço);
//   C) promoção × cupom NÃO acumulam — vence o MAIOR (empate → promoção);
//   D) totais do checkout — subtotal − desconto + frete em centavos inteiros;
//   E) máquina de estados do pedido + estados que seguram reserva;
//   F) backoff de fila (teto 1h, máx 10 tentativas);
//   G) métricas derivadas (tendência, média, razão, dias de SLA) sem NaN;
//   H) slug público (acentos, unicidade, fallback);
//   I) cobrança → estado de pagamento (case-insensitive, desconhecido = null);
//   J) vocabulário do código === CHECKs da migration 0068 (canais/estados).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const {
  round2,
  paraCentavos,
  deCentavos,
  precoEfetivo,
  vigenciaEstaAtiva,
  descontoDaRegra,
  avaliarCupom,
  melhorDesconto,
  calcularTotaisCheckout,
  slugify,
  slugUnico,
  backoffMs,
  MAX_TENTATIVAS,
  tendenciaLinear,
  mediaOuZero,
  razao,
  diasDesde,
  transicaoPedido,
  estadoSeguraReserva,
  mapearEstadoPagamento,
  CANAIS_PUBLICACAO,
  CANAIS_PEDIDO,
  ESTADOS_PUBLICACAO,
  ESTADOS_PEDIDO,
  ESTADOS_PAGAMENTO,
  SLA_ENVIO_DIAS,
} = await import('../src/commerce/regras');
const { resolverFreteProvider, freteNaoConfigurado } = await import('../src/commerce/frete');

// ----------------------------------------------------------------------------
// Utilidades do ORÁCULO (nunca importam o alvo)
// ----------------------------------------------------------------------------

/** PRNG determinístico (mulberry32) — os "aleatórios" são reproduzíveis. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Oráculo de DINHEIRO: decimal exato em 4 casas ("123.4567") → arredonda
 * half-up para centavos com aritmética INTEIRA de algarismos.
 */
function centsHalfUp4(s: string): number {
  const neg = s.startsWith('-');
  const corpo = neg ? s.slice(1) : s;
  const [inteiro, fracionado = ''] = corpo.split('.');
  const n4 = Number(inteiro || 0) * 10000 + Number((fracionado + '0000').slice(0, 4));
  const cents = Math.floor((n4 + 50) / 100); // meio-centavo para cima
  return (neg ? -cents : cents) / 100;
}

/** Gera um decimal de 4 casas a partir do PRNG (0,0000 a 4999,9999). */
function gerar4(rnd: () => number, maxReais = 5000): string {
  const n4 = Math.floor(rnd() * maxReais * 10000);
  const inteiro = Math.floor(n4 / 10000);
  const frac = String(n4 % 10000).padStart(4, '0');
  return `${inteiro}.${frac}`;
}

/** Dia UTC 'YYYY-MM-DD' escrito de forma independente (getUTC*). */
function diaUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Total do checkout em CENTAVOS INTEIROS — enunciado: Σ(qtd × preço − desc. un.) */
function totaisEmCentavos(
  itens: { quantidade: number; precoUnitario: number; descontoUnitario?: number }[],
  freteReais: number,
  descontoReais: number,
  preco: (v: number) => number, // half-up para centavos (oráculo)
): { subtotal: number; desconto: number; frete: number; total: number } {
  let subtotalC = 0;
  for (const it of itens) {
    const p = Math.round(Math.max(0, preco(it.precoUnitario)) * 100); // → centavos
    const d = Math.round(Math.max(0, preco(it.descontoUnitario ?? 0)) * 100);
    const qtd = Math.max(0, Math.trunc(it.quantidade));
    // item nunca contribui negativamente: desconto unitário ≤ valor do item
    subtotalC += Math.max(0, p * qtd - d);
  }
  const descontoC = Math.min(Math.max(0, Math.round(preco(descontoReais) * 100)), Math.max(0, subtotalC));
  const freteC = Math.max(0, Math.round(preco(freteReais) * 100));
  const totalC = Math.max(0, subtotalC - descontoC + freteC);
  return { subtotal: subtotalC / 100, desconto: descontoC / 100, frete: freteC / 100, total: totalC / 100 };
}

// ----------------------------------------------------------------------------
// A) DINHEIRO — round2 / paraCentavos / deCentavos
// ----------------------------------------------------------------------------

test('A) round2: meio-centavo para CIMA em casos fixos (decimal exato)', () => {
  const casos: [string, number][] = [
    ['1.005', 1.01],
    ['2.675', 2.68],
    ['0.005', 0.01],
    ['1.015', 1.02],
    ['1234.565', 1234.57], // magnitude ≥ 100: nudge relativo obrigatório
    ['99.995', 100],
    ['10.125', 10.13],
    ['0.0049', 0], // abaixo do meio-centavo
    ['0.0051', 0.01],
    ['7.9999', 8],
    ['527.93', 527.93],
    ['0', 0],
  ];
  for (const [entrada, esperado] of casos) {
    assert.equal(round2(Number(entrada)), esperado, `round2(${entrada})`);
    assert.equal(round2(Number(entrada)), centsHalfUp4(entrada), `oráculo round2(${entrada})`);
  }
});

test('A) round2/paraCentavos: 5.000 amostras aleatórias de 4 casas vs oráculo inteiro', () => {
  const rnd = mulberry32(0xc0ffee);
  for (let i = 0; i < 5000; i += 1) {
    const s = gerar4(rnd, 5000);
    const esperado = centsHalfUp4(s);
    assert.equal(round2(Number(s)), esperado, `round2(${s})`);
    assert.equal(paraCentavos(Number(s)), Math.round(esperado * 100), `paraCentavos(${s})`);
  }
});

test('A) deCentavos: centavos inteiros → reais exatos (sem deriva)', () => {
  const rnd = mulberry32(0xbeef);
  for (let i = 0; i < 2000; i += 1) {
    const cents = Math.floor(rnd() * 500000000); // 0 a 5.000.000,00
    assert.equal(deCentavos(cents), cents / 100, `deCentavos(${cents})`);
  }
  assert.equal(deCentavos(1), 0.01);
  assert.equal(deCentavos(0), 0);
});

// ----------------------------------------------------------------------------
// B) PREÇO POR CANAL — vigência × promoção (nunca sobe o preço)
// ----------------------------------------------------------------------------

test('B) precoEfetivo: sem linha de canal (ou fora da vigência) vale a base', () => {
  assert.deepEqual(precoEfetivo({ base: 89.9 }), { preco: 89.9, promo: null, origem: 'base' });
  const hoje = new Date('2026-10-15T12:00:00Z');
  // canal existe mas vigência ainda não começou / já terminou
  assert.deepEqual(
    precoEfetivo({ base: 50, precoCanal: 45, vigenciaInicio: '2026-11-01', hoje }),
    { preco: 50, promo: null, origem: 'base' }
  );
  assert.deepEqual(
    precoEfetivo({ base: 50, precoCanal: 45, vigenciaFim: '2026-10-01', hoje }),
    { preco: 50, promo: null, origem: 'base' }
  );
  // vigência aberta (sem limites)
  assert.deepEqual(precoEfetivo({ base: 50, precoCanal: 45, hoje }), { preco: 45, promo: null, origem: 'canal' });
});

test('B) precoEfetivo: promoção de canal só quando MENOR que o preço normal', () => {
  const hoje = new Date('2026-10-15T12:00:00Z');
  // menor → promocional vigente
  assert.deepEqual(
    precoEfetivo({ base: 100, precoCanal: 80, precoPromoCanal: 60, hoje }),
    { preco: 80, promo: 60, origem: 'canal' }
  );
  // MAIOR que o normal → ignorado (nunca sobe o preço)
  assert.deepEqual(
    precoEfetivo({ base: 100, precoCanal: 80, precoPromoCanal: 90, hoje }),
    { preco: 80, promo: null, origem: 'canal' }
  );
  // igual → também ignorada (só conta quando é desconto de verdade)
  assert.deepEqual(
    precoEfetivo({ base: 100, precoCanal: 80, precoPromoCanal: 80, hoje }),
    { preco: 80, promo: null, origem: 'canal' }
  );
  // zero/negativa → sem promoção
  assert.deepEqual(
    precoEfetivo({ base: 100, precoCanal: 80, precoPromoCanal: 0, hoje }),
    { preco: 80, promo: null, origem: 'canal' }
  );
});

test('B) vigenciaEstaAtiva: borda de datas em UTC (dia inclusive dos dois lados)', () => {
  const hoje = new Date('2026-10-15T23:59:59Z');
  assert.equal(vigenciaEstaAtiva('2026-10-15', null, hoje), true, 'início = hoje vale');
  assert.equal(vigenciaEstaAtiva(null, '2026-10-15', hoje), true, 'fim = hoje vale');
  assert.equal(vigenciaEstaAtiva('2026-10-16', null, hoje), false, 'amanhã ainda não');
  assert.equal(vigenciaEstaAtiva(null, '2026-10-14', hoje), false, 'ontem já passou');
  assert.equal(vigenciaEstaAtiva(null, null, hoje), true, 'sem limites = sempre');
  // comparação por dia UTC (mesmo instante, dia diferente no fuso local)
  const quaseMeiaNoiteUtc = new Date('2026-10-16T00:30:00Z');
  assert.equal(vigenciaEstaAtiva('2026-10-16', null, quaseMeiaNoiteUtc), true);
  assert.equal(diaUtc(quaseMeiaNoiteUtc), '2026-10-16');
});

// ----------------------------------------------------------------------------
// C) PROMOÇÃO × CUPOM — nunca acumulam; vence o MAIOR
// ----------------------------------------------------------------------------

test('C) descontoDaRegra: percentual e valor respeitam mínimo e teto do subtotal', () => {
  // percentual comum
  assert.equal(descontoDaRegra(200, { tipo: 'percentual', valor: 10 }), 20);
  // mínimo de pedido não atingido → zero
  assert.equal(descontoDaRegra(99.99, { tipo: 'percentual', valor: 10, minimoPedido: 100 }), 0);
  // mínimo exatamente igual ao subtotal → aplica (>= mínimo)
  assert.equal(descontoDaRegra(100, { tipo: 'percentual', valor: 10, minimoPedido: 100 }), 10);
  // percentual > 100% → limitado ao subtotal
  assert.equal(descontoDaRegra(50, { tipo: 'percentual', valor: 150 }), 50);
  // valor fixo maior que o subtotal → limitado ao subtotal
  assert.equal(descontoDaRegra(30, { tipo: 'valor', valor: 50 }), 30);
  // valor fixo normal
  assert.equal(descontoDaRegra(30, { tipo: 'valor', valor: 12.5 }), 12.5);
  // entradas sujas → nunca negativo
  assert.equal(descontoDaRegra(-10, { tipo: 'valor', valor: 5 }), 0);
  assert.equal(descontoDaRegra(10, { tipo: 'valor', valor: -5 }), 0);
});

test('C) descontoDaRegra: 3.000 amostras aleatórias vs oráculo de centavos inteiros', () => {
  const rnd = mulberry32(0xdec1);
  for (let i = 0; i < 3000; i += 1) {
    const subtotal = Number(gerar4(rnd, 2000));
    const valor = Number(gerar4(rnd, 150));
    const tipo: 'percentual' | 'valor' = rnd() < 0.5 ? 'percentual' : 'valor';
    const minimoPedido = rnd() < 0.3 ? Number(gerar4(rnd, 1000)) : 0;

    // Oráculo em centavos inteiros:
    const subC = Math.round(centsHalfUp4(String(subtotal)) * 100);
    const minC = Math.round(centsHalfUp4(String(minimoPedido)) * 100);
    // valor: em % para tipo percentual (10,5 → 1050 "percent-centavos"), em
    // centavos de dinheiro para tipo valor.
    const valC = Math.round(centsHalfUp4(String(valor)) * 100);
    let esperadoC = 0;
    if (subC >= minC && subC > 0) {
      if (tipo === 'percentual') {
        const pctC = Math.min(10000, Math.max(0, valC)); // teto de 100%
        esperadoC = Math.min(subC, Math.floor((subC * pctC + 5000) / 10000));
      } else {
        esperadoC = Math.min(subC, Math.max(0, valC));
      }
    }
    const obtido = descontoDaRegra(subtotal, { tipo, valor, minimoPedido });
    assert.equal(obtido, esperadoC / 100, `subtotal=${subtotal} tipo=${tipo} valor=${valor} min=${minimoPedido}`);
  }
});

test('C) avaliarCupom: inativo, expirado e limite de uso barram ANTES do desconto', () => {
  const hoje = new Date('2026-10-15T12:00:00Z');
  assert.deepEqual(avaliarCupom({ ativo: false }, 100, hoje), { ok: false, erro: 'Cupom inativo.' });
  assert.deepEqual(avaliarCupom({ ativo: true, validade: '2026-10-14' }, 100, hoje), { ok: false, erro: 'Cupom expirado.' });
  assert.deepEqual(
    avaliarCupom({ ativo: true, validade: '2026-10-15', usoMaximo: 10, usoAtual: 10 }, 100, hoje),
    { ok: false, erro: 'Cupom atingiu o limite de uso.' }
  );
  assert.deepEqual(avaliarCupom({ ativo: true, validade: '2026-10-15', usoMaximo: 10, usoAtual: 9 }, 100, hoje), {
    ok: true,
    desconto: 0,
  });
  // usoMaximo null/0 = ilimitado
  assert.deepEqual(avaliarCupom({ ativo: true, usoMaximo: null, usoAtual: 999 }, 100, hoje), { ok: true, desconto: 0 });
});

test('C) melhorDesconto: promoção × cupom nunca acumulam — vence o MAIOR (empate = promoção)', () => {
  const casos: [number, { promocao?: Parameters<typeof melhorDesconto>[1]['promocao']; cupom?: Parameters<typeof melhorDesconto>[1]['cupom'] }, number, string | null][] = [
    // cupom maior que a promoção
    [100, { promocao: { tipo: 'percentual', valor: 10 }, cupom: { tipo: 'valor', valor: 25 } }, 25, 'cupom'],
    // promoção maior
    [100, { promocao: { tipo: 'percentual', valor: 30 }, cupom: { tipo: 'valor', valor: 25 } }, 30, 'promocao'],
    // EMPATE (30 = 30) → promoção vence (desempate documentado)
    [100, { promocao: { tipo: 'percentual', valor: 30 }, cupom: { tipo: 'valor', valor: 30 } }, 30, 'promocao'],
    // só cupom
    [100, { cupom: { tipo: 'percentual', valor: 5 } }, 5, 'cupom'],
    // só promoção
    [100, { promocao: { tipo: 'percentual', valor: 5 } }, 5, 'promocao'],
    // nenhum → zero, origem null
    [100, {}, 0, null],
    // cupom abaixo do mínimo do pedido → anulado; promoção segue valendo
    [100, { promocao: { tipo: 'percentual', valor: 10 }, cupom: { tipo: 'valor', valor: 90, minimoPedido: 500 } }, 10, 'promocao'],
    // soma NUNCA acontece: 10% + R$25 em R$100 = R$25, não R$35
    [100, { promocao: { tipo: 'percentual', valor: 10 }, cupom: { tipo: 'valor', valor: 25 } }, 25, 'cupom'],
  ];
  for (const [subtotal, regras, esperado, origem] of casos) {
    const r = melhorDesconto(subtotal, regras);
    assert.equal(r.desconto, esperado, `subtotal=${subtotal} ${JSON.stringify(regras)}`);
    assert.equal(r.origem, origem);
  }
});

// ----------------------------------------------------------------------------
// D) TOTAIS DO CHECKOUT
// ----------------------------------------------------------------------------

test('D) calcularTotaisCheckout: casos fixos (subtotal − desconto + frete)', () => {
  assert.deepEqual(
    calcularTotaisCheckout({ itens: [{ quantidade: 2, precoUnitario: 49.9 }], frete: 15, desconto: 0 }),
    { subtotal: 99.8, desconto: 0, frete: 15, total: 114.8 }
  );
  // desconto MAIOR que o subtotal → trava no subtotal (total nunca negativo)
  assert.deepEqual(
    calcularTotaisCheckout({ itens: [{ quantidade: 1, precoUnitario: 10 }], frete: 0, desconto: 50 }),
    { subtotal: 10, desconto: 10, frete: 0, total: 0 }
  );
  // frete negativo → zero; desconto negativo → zero
  assert.deepEqual(
    calcularTotaisCheckout({ itens: [{ quantidade: 1, precoUnitario: 20 }], frete: -5, desconto: -1 }),
    { subtotal: 20, desconto: 0, frete: 0, total: 20 }
  );
  // frete NÃO abate o total (é entrega, não desconto)
  assert.deepEqual(
    calcularTotaisCheckout({ itens: [{ quantidade: 1, precoUnitario: 100, descontoUnitario: 10 }], frete: 20, desconto: 5 }),
    { subtotal: 90, desconto: 5, frete: 20, total: 105 }
  );
  // quantidade fracionada usa só a parte inteira (trunc)
  assert.deepEqual(
    calcularTotaisCheckout({ itens: [{ quantidade: 2.7, precoUnitario: 10 }], frete: 0, desconto: 0 }),
    { subtotal: 20, desconto: 0, frete: 0, total: 20 }
  );
  // itens vazios → tudo zero
  assert.deepEqual(calcularTotaisCheckout({ itens: [], frete: 10, desconto: 3 }), {
    subtotal: 0,
    desconto: 0,
    frete: 10,
    total: 10,
  });
  // desconto unitário MAIOR que o item → item zera (nunca subtotal negativo)
  assert.deepEqual(
    calcularTotaisCheckout({ itens: [{ quantidade: 1, precoUnitario: 14.8, descontoUnitario: 18.06 }], frete: 66.26, desconto: 27.29 }),
    { subtotal: 0, desconto: 0, frete: 66.26, total: 66.26 }
  );
});

test('D) calcularTotaisCheckout: 3.000 cenários aleatórios vs oráculo de centavos inteiros', () => {
  const rnd = mulberry32(0x70ca1);
  for (let i = 0; i < 3000; i += 1) {
    const nItens = 1 + Math.floor(rnd() * 4);
    const itens = Array.from({ length: nItens }, () => {
      const precoUnitario = Number(gerar4(rnd, 500));
      const quantidade = Math.floor(rnd() * 5) + 1;
      const descontoUnitario = rnd() < 0.4 ? Number(gerar4(rnd, 20)) : undefined;
      return { quantidade, precoUnitario, descontoUnitario };
    });
    const frete = Number(gerar4(rnd, 80));
    const desconto = Number(gerar4(rnd, 100));
    const esperado = totaisEmCentavos(itens, frete, desconto, (v) => centsHalfUp4(String(v)));
    const obtido = calcularTotaisCheckout({ itens, frete, desconto });
    assert.deepEqual(obtido, esperado, JSON.stringify({ itens, frete, desconto }));
    // invariante: total nunca negativo e desconto nunca excede o subtotal
    assert.ok(obtido.total >= 0);
    assert.ok(obtido.desconto <= obtido.subtotal);
  }
});

// ----------------------------------------------------------------------------
// E) MÁQUINA DE ESTADOS DO PEDIDO + RESERVAS
// ----------------------------------------------------------------------------

/** Máquina reescrita da spec de pós-venda (NÃO lê TRANSICOES do alvo). */
const MAQUINA_ORACULO: Record<string, Record<string, string>> = {
  AGUARDANDO_PAGAMENTO: {
    pagamento_autorizado: 'PAGAMENTO_AUTORIZADO',
    pago: 'PAGO',
    cancelado: 'CANCELADO',
    expirado: 'EXPIRADO',
    erro: 'ERRO',
  },
  PAGAMENTO_AUTORIZADO: {
    pago: 'PAGO',
    cancelado: 'CANCELADO',
    expirado: 'EXPIRADO',
    pagamento_pendente: 'AGUARDANDO_PAGAMENTO',
    erro: 'ERRO',
  },
  PAGO: {
    convertido: 'CONVERTIDO',
    correcao: 'AGUARDANDO_CORRECAO',
    cancelado: 'CANCELADO',
    estornado: 'ESTORNADO',
    erro: 'ERRO',
  },
  AGUARDANDO_CORRECAO: {
    convertido: 'CONVERTIDO',
    pago: 'PAGO',
    cancelado: 'CANCELADO',
    estornado: 'ESTORNADO',
    erro: 'ERRO',
  },
  CONVERTIDO: { estornado: 'ESTORNADO' },
  CANCELADO: {},
  EXPIRADO: {},
  ESTORNADO: {},
  ERRO: {
    pago: 'PAGO',
    cancelado: 'CANCELADO',
    expirado: 'EXPIRADO',
    reprocessado: 'AGUARDANDO_PAGAMENTO',
  },
};

const EVENTOS = [
  'pagamento_pendente',
  'pagamento_autorizado',
  'pago',
  'correcao',
  'convertido',
  'cancelado',
  'expirado',
  'estornado',
  'erro',
  'reprocessado',
] as const;

test('E) transicaoPedido: matriz completa contra a máquina do oráculo', () => {
  for (const [estado, esperados] of Object.entries(MAQUINA_ORACULO)) {
    for (const evento of EVENTOS) {
      const esperado = (esperados as Record<string, string | undefined>)[evento] ?? null;
      assert.equal(transicaoPedido(estado, evento), esperado, `${estado} + ${evento}`);
    }
  }
});

test('E) transicaoPedido: estados terminais e estados inválidos nunca avançam', () => {
  for (const terminal of ['CANCELADO', 'EXPIRADO', 'ESTORNADO']) {
    for (const evento of EVENTOS) {
      assert.equal(transicaoPedido(terminal, evento), null, `${terminal} é terminal`);
    }
  }
  // CONVERTIDO não cancela (só estorna) — pós-venda preserva o histórico
  assert.equal(transicaoPedido('CONVERTIDO', 'cancelado'), null);
  assert.equal(transicaoPedido('CONVERTIDO', 'estornado'), 'ESTORNADO');
  // estado desconhecido/corrompido → null (nunca força transição)
  assert.equal(transicaoPedido(null, 'pago'), null);
  assert.equal(transicaoPedido('__lixo__', 'pago'), null);
  // ERRO é recuperável (diferente dos terminais)
  assert.equal(transicaoPedido('ERRO', 'reprocessado'), 'AGUARDANDO_PAGAMENTO');
});

test('E) estadoSeguraReserva: exatamente aberto-pagamento segura reserva; pago/convertido/terminais liberam', () => {
  const seguram = ['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO', 'ERRO'];
  const liberam = ['PAGO', 'CONVERTIDO', 'AGUARDANDO_CORRECAO', 'CANCELADO', 'EXPIRADO', 'ESTORNADO'];
  for (const e of seguram) assert.equal(estadoSeguraReserva(e), true, `${e} segura reserva`);
  for (const e of liberam) assert.equal(estadoSeguraReserva(e), false, `${e} não segura reserva`);
  assert.equal(estadoSeguraReserva('qualquer'), false);
  assert.equal(estadoSeguraReserva(null), false);
});

// ----------------------------------------------------------------------------
// F) BACKOFF DA FILA
// ----------------------------------------------------------------------------

test('F) backoffMs: dobra exponencial com teto de 1h (oráculo iterativo)', () => {
  for (let n = 0; n <= 14; n += 1) {
    // oráculo: dobrar a partir da base até o teto, sem usar ** nem min(n,10)
    let v = 30_000;
    for (let k = 0; k < n; k += 1) v = Math.min(3_600_000, v * 2);
    v = Math.min(3_600_000, v);
    assert.equal(backoffMs(n), v, `tentativa ${n}`);
  }
  assert.equal(backoffMs(-3), 30_000, 'negativo tratado como zero');
  assert.equal(backoffMs(2.9), 30_000 * 4, 'trunca casas decimais');
  assert.ok(MAX_TENTATIVAS >= 5 && MAX_TENTATIVAS <= 20, 'teto de tentativas dentro da faixa documentada');
});

// ----------------------------------------------------------------------------
// G) MÉTRICAS DERIVADAS — nunca NaN/Infinity
// ----------------------------------------------------------------------------

test('G) tendenciaLinear: mínimos quadrados vs fórmula alternativa Σxy/Σx²', () => {
  // Casos exatos desenhados à mão:
  const reta = tendenciaLinear([2, 4, 6, 8]); // y = 2x + 2 (x = 0,1,2,3)
  assert.ok(Math.abs(reta.slope - 2) < 1e-9 && Math.abs(reta.intercept - 2) < 1e-9);
  const constante = tendenciaLinear([7, 7, 7, 7]); // sem tendência
  assert.equal(constante.slope, 0);
  assert.equal(constante.intercept, 7);
  assert.deepEqual(tendenciaLinear([5]), { slope: 0, intercept: 5 }, 'n<2 → só intercepto');
  assert.deepEqual(tendenciaLinear([]), { slope: 0, intercept: 0 }, 'vazio → zero, nunca NaN');

  // Aleatórias: fórmula independente slope = (nΣxy − ΣxΣy) / (nΣx² − (Σx)²)
  const rnd = mulberry32(0x5109);
  for (let i = 0; i < 500; i += 1) {
    const n = 2 + Math.floor(rnd() * 12);
    const ys = Array.from({ length: n }, () => Math.floor(rnd() * 200) - 40);
    const xs = ys.map((_, idx) => idx);
    const somaX = xs.reduce((a, b) => a + b, 0);
    const somaY = ys.reduce((a, b) => a + b, 0);
    const somaXY = xs.reduce((a, x, k) => a + x * ys[k], 0);
    const somaX2 = xs.reduce((a, x) => a + x * x, 0);
    const den = n * somaX2 - somaX * somaX;
    const slopeBruto = den === 0 ? 0 : (n * somaXY - somaX * somaY) / den;
    const mediaY = somaY / n;
    const mediaX = somaX / n;
    const interceptEsperado = Math.round((mediaY - slopeBruto * mediaX) * 100) / 100;
    const slopeEsperado = Math.round(slopeBruto * 10000) / 10000;
    const obtido = tendenciaLinear(ys);
    assert.ok(Math.abs(obtido.slope - slopeEsperado) <= 0.0002, `slope ys=${ys.join(',')} → ${obtido.slope} vs ${slopeEsperado}`);
    assert.ok(Math.abs(obtido.intercept - interceptEsperado) <= 0.02, `intercept ys=${ys.join(',')} → ${obtido.intercept} vs ${interceptEsperado}`);
    assert.ok(Number.isFinite(obtido.slope) && Number.isFinite(obtido.intercept), 'nunca NaN');
  }
});

test('G) mediaOuZero e razao: coleção vazia/suja e divisão por zero viram 0, nunca NaN', () => {
  assert.equal(mediaOuZero([]), 0);
  assert.equal(mediaOuZero([2, 4, 6]), 4);
  // Semântica documentada: `Number(v) || 0` — NaN vira 0 e ENTRA na média;
  // Infinity é filtrado. O importânte é nunca devolver NaN.
  assert.equal(mediaOuZero([NaN, 3, Infinity, 6]), 3, 'NaN → 0; Infinity descartado');
  assert.equal(mediaOuZero([-2, 2]), 0);
  assert.equal(razao(0, 0), 0);
  assert.equal(razao(10, 0), 0);
  assert.equal(razao(-5, 2), -2.5, 'numerador negativo segue a conta');
  assert.equal(razao(1, 3), 0.33, 'duas casas');
});

test('G) diasDesde: dias corridos (piso) e entradas inválidas', () => {
  const agora = new Date('2026-10-15T18:00:00Z');
  assert.equal(diasDesde('2026-10-15T10:00:00Z', agora), 0, 'mesmo dia = 0');
  assert.equal(diasDesde('2026-10-12T10:00:00Z', agora), 3, 'piso de dias corridos');
  assert.equal(diasDesde('2026-10-14T10:00:00Z', agora), 1, '32h → 1 dia inteiro');
  assert.equal(diasDesde('2026-10-20T10:00:00Z', agora), 0, 'futuro → 0 (nunca negativo)');
  assert.equal(diasDesde(null, agora), null);
  assert.equal(diasDesde('data-invalida', agora), null);
  assert.ok(SLA_ENVIO_DIAS > 0, 'SLA documentado existe');
});

// ----------------------------------------------------------------------------
// H) SLUG PÚBLICO
// ----------------------------------------------------------------------------

test('H) slugify: acentos, separadores, vazio e tamanho', () => {
  assert.equal(slugify('Camiseta Branca'), 'camiseta-branca');
  assert.equal(slugify('Água Térmica 500ml'), 'agua-termica-500ml');
  assert.equal(slugify('  ---Olá!!Mundo---  '), 'ola-mundo');
  assert.equal(slugify('2ª Edição'), '2-edicao');
  assert.equal(slugify(''), 'produto', 'vazio cai no fallback');
  assert.equal(slugify('   '), 'produto', 'só espaços cai no fallback');
  assert.equal(slugify('!!!'), 'produto', 'só símbolos cai no fallback');
  const longo = slugify('A'.repeat(200));
  assert.equal(longo.length, 80, 'cortado em 80 caracteres');
  assert.equal(slugify('CAMISETA'), 'camiseta', 'minúsculas');
});

test('H) slugUnico: numera a partir de 2 e nunca devolve colisão', () => {
  const existentes = new Set(['camiseta', 'camiseta-2', 'camiseta-3']);
  assert.equal(slugUnico('Camiseta', (s) => existentes.has(s)), 'camiseta-4');
  assert.equal(slugUnico('Bermuda', (s) => existentes.has(s)), 'bermuda');
  // esgota a numeração manual → fallback determinístico com timestamp
  const muitos = new Set(Array.from({ length: 998 }, (_, i) => (i === 0 ? 'kit' : `kit-${i + 1}`)));
  const final = slugUnico('kit', (s) => muitos.has(s));
  assert.ok(final.startsWith('kit-') && final !== 'kit', `fallback de esgotamento: ${final}`);
});

// ----------------------------------------------------------------------------
// I) COBRANÇA → PAGAMENTO
// ----------------------------------------------------------------------------

test('I) mapearEstadoPagamento: tabela case-insensitive e desconhecido = null', () => {
  assert.equal(mapearEstadoPagamento('paga'), 'APPROVED');
  assert.equal(mapearEstadoPagamento('PAGA'), 'APPROVED', 'case-insensitive');
  assert.equal(mapearEstadoPagamento('estornada'), 'REFUNDED');
  assert.equal(mapearEstadoPagamento('autorizada'), 'AUTHORIZED');
  assert.equal(mapearEstadoPagamento('falhou'), 'REJECTED');
  assert.equal(mapearEstadoPagamento('cancelada'), 'CANCELLED');
  assert.equal(mapearEstadoPagamento('expirada'), 'EXPIRED');
  assert.equal(mapearEstadoPagamento('pendente'), 'PENDING');
  assert.equal(mapearEstadoPagamento('inventada'), null, 'status desconhecido não vira pagamento');
  assert.equal(mapearEstadoPagamento(null), null);
  assert.equal(mapearEstadoPagamento(''), null);
});

// ----------------------------------------------------------------------------
// J) VOCABULÁRIO × MIGRATION 0068 — contrato banco ↔ código
// ----------------------------------------------------------------------------

/** Extrai os valores de uma CONSTRAINT ... CHECK (col IN (...)) da migration. */
function checkDaMigration(sql: string, constraint: string): string[] {
  const re = new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\([^)]*IN\\s*\\(([^)]*)\\)`, 'i');
  const m = sql.match(re);
  assert.ok(m, `constraint ${constraint} não encontrada na migration 0068`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('J) canais/estados do código são EXATAMENTE os CHECKs da migration 0068', () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const sql = readFileSync(path.join(raiz, 'db', 'migrations', '0068_commerce_os.sql'), 'utf8');

  const iguais = (esperado: readonly string[], obtido: string[], oQue: string) => {
    assert.deepEqual([...obtido].sort(), [...esperado].sort(), `vocabulário divergente: ${oQue}`);
  };

  // Publicação/preço: 5 canais (Mercado Pago é GATEWAY, não canal de catálogo)
  iguais(CANAIS_PUBLICACAO, checkDaMigration(sql, 'commerce_precos_canal_ck'), 'commerce_precos.canal');
  iguais(CANAIS_PUBLICACAO, checkDaMigration(sql, 'commerce_publicacoes_canal_ck'), 'commerce_publicacoes.canal');
  // Pedido: 6 canais (inclui MERCADOPAGO — pedido pago pela plataforma)
  iguais(CANAIS_PEDIDO, checkDaMigration(sql, 'commerce_pedidos_canal_ck'), 'commerce_pedidos.canal');
  // Máquina de estados projetada
  iguais(ESTADOS_PUBLICACAO, checkDaMigration(sql, 'commerce_publicacoes_estado_ck'), 'commerce_publicacoes.estado');
  iguais(ESTADOS_PEDIDO, checkDaMigration(sql, 'commerce_pedidos_estado_ck'), 'commerce_pedidos.estado');
  iguais(ESTADOS_PAGAMENTO, checkDaMigration(sql, 'commerce_pedidos_pagamento_ck'), 'commerce_pedidos.pagamento_estado');

  // Sanity dos vocabulários (nada vazio, sem duplicata)
  for (const vocab of [CANAIS_PUBLICACAO, CANAIS_PEDIDO, ESTADOS_PUBLICACAO, ESTADOS_PEDIDO, ESTADOS_PAGAMENTO]) {
    assert.equal(new Set(vocab).size, vocab.length, 'vocabulário com duplicata');
    assert.ok(vocab.length >= 4, 'vocabulário esvaziado');
  }
  assert.ok(!(CANAIS_PUBLICACAO as readonly string[]).includes('MERCADOPAGO'), 'MERCADOPAGO não é canal de publicação');
  assert.ok((CANAIS_PEDIDO as readonly string[]).includes('MERCADOPAGO'), 'MERCADOPAGO é canal de pedido');
});

test('J) frete: provedor não configurado responde "Frete não configurado" sem número', async () => {
  const cotacao = await freteNaoConfigurado.cotar({ subtotal: 100 });
  assert.equal(cotacao.disponivel, false);
  assert.ok(!('valor' in cotacao), 'resposta indisponível NUNCA tem valor');
  if (!cotacao.disponivel) assert.equal(cotacao.motivo, 'Frete não configurado');

  const viaConfig = await resolverFreteProvider({ frete_provedor: 'nenhum' }).cotar({ subtotal: 100 });
  assert.equal(viaConfig.disponivel, false);
  const desconhecido = await resolverFreteProvider({ frete_provedor: 'transportadora-x' }).cotar({ subtotal: 100 });
  assert.equal(desconhecido.disponivel, false, 'provedor não reconhecido é fail-closed');
});
