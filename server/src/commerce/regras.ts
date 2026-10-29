// ============================================================================
// COMMERCE OS — REGRAS PURAS (sem banco, sem express, sem efeitos).
//
// Toda fórmula de dinheiro/estado do Commerce vive AQUI e é exercitada por
// `server/test/commerce-oracle.test.ts` com um ORÁCULO INDEPENDENTE (cálculo
// reescrito à mão no teste). Se mudar uma regra, o oráculo acusa.
//
// Política de desconto (documentada em docs/COMMERCE-ARCHITECTURE.md):
//   • promoções ativas e cupons NÃO se acumulam — vence o MAIOR desconto;
//   • o cliente nunca recebe menos desconto do que a melhor regra isolada.
// ============================================================================

// ---------------------------------------------------------------------------- 
// Vocabulário
// ----------------------------------------------------------------------------

/** Canais em que um PRODUTO pode ser publicado/preçado. */
export const CANAIS_PUBLICACAO = [
  'BROBOND', // vitrine própria (/loja)
  'MERCADOLIVRE',
  'NUVEMSHOP',
  'WOOCOMMERCE',
  'INSTAGRAM_SHOPPING',
] as const;
export type CanalPublicacao = (typeof CANAIS_PUBLICACAO)[number];

/** Canais de PEDIDO (espeta o enum `sale_channel` do banco). */
export const CANAIS_PEDIDO = [
  'BROBOND',
  'INSTAGRAM_SHOPPING',
  'MERCADOLIVRE',
  'MERCADOPAGO',
  'NUVEMSHOP',
  'WOOCOMMERCE',
] as const;
export type CanalPedido = (typeof CANAIS_PEDIDO)[number];

export const ESTADOS_PUBLICACAO = [
  'DRAFT',
  'READY',
  'QUEUED',
  'PUBLISHING',
  'PUBLISHED',
  'UPDATE_QUEUED',
  'ERROR',
  'REJECTED',
  'UNPUBLISHED',
] as const;
export type EstadoPublicacao = (typeof ESTADOS_PUBLICACAO)[number];

export const ESTADOS_PEDIDO = [
  'AGUARDANDO_PAGAMENTO',
  'PAGAMENTO_AUTORIZADO',
  'PAGO',
  'AGUARDANDO_CORRECAO',
  'CONVERTIDO',
  'CANCELADO',
  'EXPIRADO',
  'ESTORNADO',
  'ERRO',
] as const;
export type EstadoPedido = (typeof ESTADOS_PEDIDO)[number];

export const ESTADOS_PAGAMENTO = [
  'PENDING',
  'AUTHORIZED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'REFUNDED',
  'CHARGEBACK',
  'EXPIRED',
] as const;
export type EstadoPagamento = (typeof ESTADOS_PAGAMENTO)[number];

/** Status brutos de `gateway_cobrancas.status` → vocabulário de pagamento. */
export const PAGAMENTO_DA_COBRANCA: Record<string, EstadoPagamento> = {
  pendente: 'PENDING',
  autorizada: 'AUTHORIZED',
  paga: 'APPROVED',
  cancelada: 'CANCELLED',
  expirada: 'EXPIRED',
  estornada: 'REFUNDED',
  falhou: 'REJECTED',
};

export function mapearEstadoPagamento(statusCobranca: unknown): EstadoPagamento | null {
  return PAGAMENTO_DA_COBRANCA[String(statusCobranca || '').toLowerCase()] ?? null;
}

// ----------------------------------------------------------------------------
// Máquina de estados do pedido (projeção — a verdade operacional é sales/vendas)
// ----------------------------------------------------------------------------

type EventoPedido =
  | 'pagamento_pendente'
  | 'pagamento_autorizado'
  | 'pago'
  | 'correcao'
  | 'convertido'
  | 'cancelado'
  | 'expirado'
  | 'estornado'
  | 'erro'
  | 'reprocessado';

const TRANSICOES: Record<EstadoPedido, Partial<Record<EventoPedido, EstadoPedido>>> = {
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
    pago: 'PAGO', // item recasado + pagamento segue válido
    cancelado: 'CANCELADO',
    estornado: 'ESTORNADO',
    erro: 'ERRO',
  },
  CONVERTIDO: {
    estornado: 'ESTORNADO',
  },
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

/** Próximo estado ou `null` quando a transição é inválida (nunca força). */
export function transicaoPedido(atual: unknown, evento: EventoPedido): EstadoPedido | null {
  const de = String(atual || '') as EstadoPedido;
  const mapa = TRANSICOES[de];
  if (!mapa) return null;
  return mapa[evento] ?? null;
}

export function ehEstadoPedido(valor: unknown): valor is EstadoPedido {
  return typeof valor === 'string' && (ESTADOS_PEDIDO as readonly string[]).includes(valor);
}

/** Estados que ainda seguram reserva de estoque (pagamento em aberto). */
export function estadoSeguraReserva(estado: unknown): boolean {
  return estado === 'AGUARDANDO_PAGAMENTO' || estado === 'PAGAMENTO_AUTORIZADO' || estado === 'ERRO';
}

// ----------------------------------------------------------------------------
// Dinheiro — arredondamento canônico (2 casas, meio para cima por soma inteira)
// ----------------------------------------------------------------------------

/** Arredonda para 2 casas usando centavos inteiros (sem deriva de float). */
export function round2(valor: number): number {
  // Nudge RELATIVO (≈ 1 ulp do valor): o Number.EPSILON absoluto não resgata
  // o "meio para cima" em valores ≥ ~100 (ex.: 527,93 × 50% = 263,965 ficava
  // 263,96 — desconto 1 centavo abaixo do canônico). O ruído de float real fica
  // muito abaixo do meio-centavo e não vira arredondamento indevido.
  const v = Number(valor);
  return Math.round((v + Math.abs(v) * Number.EPSILON) * 100) / 100;
}

/** Converte reais → centavos de forma determinística. */
export function paraCentavos(valor: number): number {
  return Math.round(round2(valor) * 100);
}

/** Converte centavos → reais. */
export function deCentavos(centavos: number): number {
  return round2(Number(centavos) / 100);
}

// ----------------------------------------------------------------------------
// Preço por canal
// ----------------------------------------------------------------------------

/**
 * Preço EFETIVO de um produto em um canal: a linha vigente de
 * `commerce_precos` sobre a base `produtos.preco_venda`. Promocional vigente
 * vence quando existir e for menor que o preço normal (nunca sobe o preço).
 */
export function precoEfetivo(params: {
  base: number;
  canal?: number | null;
  precoCanal?: number | null;
  precoPromoCanal?: number | null;
  hoje?: Date;
  vigenciaInicio?: string | null;
  vigenciaFim?: string | null;
}): { preco: number; promo: number | null; origem: 'canal' | 'base' } {
  const hoje = params.hoje ?? new Date();
  const base = Math.max(0, round2(params.base));
  const vigente =
    params.precoCanal != null &&
    vigenciaEstaAtiva(params.vigenciaInicio ?? null, params.vigenciaFim ?? null, hoje);
  if (!vigente || params.precoCanal == null) {
    return { preco: base, promo: null, origem: 'base' };
  }
  const preco = Math.max(0, round2(params.precoCanal));
  const promo =
    params.precoPromoCanal != null && round2(params.precoPromoCanal) > 0 && round2(params.precoPromoCanal) < preco
      ? round2(params.precoPromoCanal)
      : null;
  return { preco, promo, origem: 'canal' };
}

export function vigenciaEstaAtiva(inicio: string | null, fim: string | null, hoje = new Date()): boolean {
  const dia = hoje.toISOString().slice(0, 10);
  if (inicio && String(inicio).slice(0, 10) > dia) return false;
  if (fim && String(fim).slice(0, 10) < dia) return false;
  return true;
}

// ----------------------------------------------------------------------------
// Promoções e cupons
// ----------------------------------------------------------------------------

export type RegraDesconto = {
  tipo: 'percentual' | 'valor';
  valor: number;
  minimoPedido?: number | null;
};

export type AvaliacaoRegra = { ok: true; desconto: number } | { ok: false; erro: string };

/** Desconto que UMA regra produz sobre o subtotal (0 quando não se aplica). */
export function descontoDaRegra(subtotal: number, regra: RegraDesconto): number {
  const base = Math.max(0, round2(subtotal));
  const minimo = Math.max(0, round2(regra.minimoPedido ?? 0));
  if (base < minimo) return 0;
  const valor = Math.max(0, round2(regra.valor));
  if (regra.tipo === 'percentual') {
    const pct = Math.min(100, valor);
    return round2(Math.min(base, (base * pct) / 100));
  }
  return round2(Math.min(base, valor));
}

/** Valida um cupom contra o pedido (validade, mínimo, limite de uso, ativo). */
export function avaliarCupom(
  cupom: { ativo?: boolean | null; validade?: string | null; usoMaximo?: number | null; usoAtual?: number | null },
  subtotal: number,
  hoje = new Date()
): AvaliacaoRegra {
  if (cupom.ativo === false) return { ok: false, erro: 'Cupom inativo.' };
  if (cupom.validade && String(cupom.validade).slice(0, 10) < hoje.toISOString().slice(0, 10)) {
    return { ok: false, erro: 'Cupom expirado.' };
  }
  if (cupom.usoMaximo != null && Number(cupom.usoMaximo) > 0 && Number(cupom.usoAtual ?? 0) >= Number(cupom.usoMaximo)) {
    return { ok: false, erro: 'Cupom atingiu o limite de uso.' };
  }
  void subtotal;
  return { ok: true, desconto: 0 };
}

/**
 * Aplica a MELHOR regra (promoção automática × cupom) — nunca acumulam.
 * `promocao` e `cupom` chegam já validadas em data/limite; o subtotal mínimo
 * de cada uma é conferido aqui de novo (fonte única da comparação).
 */
export function melhorDesconto(
  subtotal: number,
  regras: { promocao?: RegraDesconto | null; cupom?: RegraDesconto | null }
): { desconto: number; origem: 'promocao' | 'cupom' | null } {
  const base = Math.max(0, round2(subtotal));
  const dPromo = regras.promocao ? descontoDaRegra(base, regras.promocao) : 0;
  const dCupom = regras.cupom ? descontoDaRegra(base, regras.cupom) : 0;
  if (dCupom > dPromo) return { desconto: dCupom, origem: 'cupom' };
  if (dPromo > 0) return { desconto: dPromo, origem: 'promocao' };
  return { desconto: 0, origem: dCupom > 0 ? 'cupom' : null };
}

// ----------------------------------------------------------------------------
// Totais do checkout
// ----------------------------------------------------------------------------

export type ItemCheckout = { quantidade: number; precoUnitario: number; descontoUnitario?: number };

/**
 * Totais do checkout: subtotal − desconto + frete, nunca negativo, sempre em
 * 2 casas. O frete entra como NÃO descontável (é entrega, não abatimento).
 * Rede de segurança por item: o desconto unitário jamais supera o valor do
 * item (alocação correta sempre respeita; entrada corrompida vira 0, não
 * subtotal negativo).
 */
export function calcularTotaisCheckout(params: {
  itens: ItemCheckout[];
  frete: number;
  desconto: number;
}): { subtotal: number; desconto: number; frete: number; total: number } {
  const subtotal = round2(
    params.itens.reduce(
      (soma, it) =>
        soma +
        Math.max(
          0,
          Math.max(0, round2(it.precoUnitario)) * Math.max(0, Math.trunc(it.quantidade)) -
            Math.max(0, round2(it.descontoUnitario ?? 0))
        ),
      0
    )
  );
  const desconto = round2(Math.min(Math.max(0, params.desconto), Math.max(0, subtotal)));
  const frete = Math.max(0, round2(params.frete));
  const total = Math.max(0, round2(subtotal - desconto + frete));
  return { subtotal, desconto, frete, total };
}

// ----------------------------------------------------------------------------
// Vitrine: slug público
// ----------------------------------------------------------------------------

/** Slug estável e URL-safe (acentos removidos, hífens normalizados). */
export function slugify(texto: string): string {
  const base = String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'produto';
}

/**
 * Garante slug único dentro da empresa: base → base-2 → base-3…
 * `existe` é a consulta do chamador (escopada na empresa).
 */
export function slugUnico(base: string, existe: (slug: string) => boolean): string {
  const candidato = slugify(base);
  if (!existe(candidato)) return candidato;
  for (let n = 2; n <= 999; n += 1) {
    const tentativa = `${candidato}-${n}`;
    if (!existe(tentativa)) return tentativa;
  }
  return `${candidato}-${Date.now().toString(36)}`;
}

// ----------------------------------------------------------------------------
// Retry / backoff (fila de publicação + outbox)
// ----------------------------------------------------------------------------

/** Backoff exponencial com teto: 30s, 1min, 2min… teto 1h. */
export function backoffMs(tentativas: number, baseMs = 30_000, tetoMs = 3_600_000): number {
  const n = Math.max(0, Math.trunc(tentativas));
  return Math.min(tetoMs, baseMs * 2 ** Math.min(n, 10));
}

export const MAX_TENTATIVAS = 10;

// ----------------------------------------------------------------------------
// Métricas derivadas (analytics/trends) — tudo sobre dado real
// ----------------------------------------------------------------------------

/**
 * Tendência de uma série (mínimos quadrados). Pontos < 2 ou variância nula →
 * slope 0 (sem tendência), nunca NaN.
 */
export function tendenciaLinear(pontos: number[]): { slope: number; intercept: number } {
  const ys = pontos.map((p) => Number(p) || 0);
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 };
  const xs = ys.map((_, i) => i);
  const mediaX = xs.reduce((a, b) => a + b, 0) / n;
  const mediaY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mediaX) * (ys[i] - mediaY);
    den += (xs[i] - mediaX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope: round2(slope * 100) / 100, intercept: round2(mediaY - slope * mediaX) };
}

/** Média simples que devolve 0 (nunca NaN) para coleção vazia. */
export function mediaOuZero(valores: number[]): number {
  const limpos = valores.map((v) => Number(v) || 0).filter((v) => Number.isFinite(v));
  if (!limpos.length) return 0;
  return round2(limpos.reduce((a, b) => a + b, 0) / limpos.length);
}

/** Divisão protegida: 0/0 = 0 (painéis nunca mostram NaN/Infinity). */
export function razao(numerador: number, denominador: number): number {
  const d = Number(denominador) || 0;
  if (d <= 0) return 0;
  return round2((Number(numerador) || 0) / d);
}

// ----------------------------------------------------------------------------
// Dias de SLA do fulfillment (regra única, exibida na tela)
// ----------------------------------------------------------------------------

/** Dias corridos desde a faturamento/expedição — usado no painel delivery. */
export function diasDesde(iso: string | null | undefined, agora = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((agora.getTime() - t) / 86_400_000));
}

export const SLA_ENVIO_DIAS = 3;
