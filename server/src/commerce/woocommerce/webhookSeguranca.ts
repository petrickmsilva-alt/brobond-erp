// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › SEGURANÇA DE WEBHOOK.
//
// A loja envia a entrega assinada. Nada do que chega por HTTP é confiável:
//
//   • a LOJA vem da ROTA (`/api/commerce/woocommerce/webhooks/:store`), nunca
//     do corpo — um atacante não escolhe o segredo de validação;
//   • a ASSINATURA é HMAC-SHA256 sobre os BYTES CRUS, comparada em tempo
//     constante (`timingSafeEqual`), com segredo INDEPENDENTE por loja;
//   • o PAYLOAD tem teto de tamanho (o parser recusa antes do HMAC);
//   • REPLAY é barrado pelo ID de entrega único (inbox) e, quando a loja manda
//     o timestamp da entrega, por uma janela de tolerância;
//   • RATE LIMIT por IP protege o endpoint de força bruta e de flood;
//   • o payload é MINIMIZADO (dados pessoais de pedido descartados) antes de
//     ser gravado — o ERP não retém o que não precisa.
//
// Contrato oficial do WooCommerce (REST API v3): a cada entrega o WooCommerce
// envia o header `X-WC-Webhook-Signature` com o BASE64 do HMAC-SHA256 do corpo
// da requisição usando o "Secret" configurado no webhook. O `X-WC-Webhook-Topic`
// identifica o evento (`order.created`, `product.updated`, ...), o
// `X-WC-Webhook-Delivery-ID` o identificador de entrega e o
// `X-WC-Webhook-Resource`/`-Event` a decomposição do tópico.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StoreKey } from './registry';

/** Cabeçalhos do WooCommerce (nomes canônicos, minúsculos no Node). */
export const HEADER_ASSINATURA = 'x-wc-webhook-signature';
export const HEADER_TOPICO = 'x-wc-webhook-topic';
export const HEADER_RECURSO = 'x-wc-webhook-resource';
export const HEADER_EVENTO = 'x-wc-webhook-event';
export const HEADER_DELIVERY = 'x-wc-webhook-delivery-id';
export const HEADER_ENTREGA_HORA = 'x-wc-webhook-delivery-time';
export const HEADER_FONTE = 'x-wc-webhook-source';
export const HEADER_TIMESTAMP = 'x-wc-webhook-timestamp';

/** Teto do corpo (bytes). Acima disso a entrega é recusada sem calcular HMAC. */
export function limiteBytes(): number {
  const n = Number(process.env.WOOCOMMERCE_WEBHOOK_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 8 * 1024 * 1024) : 1_048_576;
}

/** Tolerância do timestamp da entrega (segundos). 0 desliga a checagem. */
export function toleranciaSegundos(): number {
  const n = Number(process.env.WOOCOMMERCE_WEBHOOK_TOLERANCE_S);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 86_400) : 300;
}

/** Janela e teto do rate limit do endpoint de webhook, por IP. */
export function rateJanelaMs(): number {
  const n = Number(process.env.WOOCOMMERCE_WEBHOOK_RATE_WINDOW_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}
export function rateMaximo(): number {
  const n = Number(process.env.WOOCOMMERCE_WEBHOOK_RATE_MAX);
  return Number.isInteger(n) && n > 0 ? n : 120;
}

/**
 * Segredo do webhook de UMA loja. NUNCA é derivado da CK/CS (a chave da API
 * REST vaza em logs de proxy com muito mais facilidade que o segredo do
 * webhook) e NUNCA é aceito do corpo. Ausente = endpoint desabilitado para
 * aquela loja (falha fechada).
 */
export function segredoWebhook(store: StoreKey): string | null {
  const valor = String(process.env[`WOOCOMMERCE_${store}_WEBHOOK_SECRET`] ?? '').trim();
  return valor || null;
}

export function webhookHabilitado(store: StoreKey): boolean {
  return segredoWebhook(store) !== null;
}

export type ResultadoAssinatura =
  | { ok: true }
  | { ok: false; motivo: string };

/**
 * Valida a assinatura HMAC-SHA256 (base64) sobre os BYTES CRUS.
 *
 * Comparação em TEMPO CONSTANTE: `timingSafeEqual` exige buffers do mesmo
 * tamanho — o comprimento é conferido antes para não vazar o tamanho esperado
 * por exceção. Assinatura ausente, malformada ou de outra loja é recusada.
 */
export function validarAssinatura(corpo: Buffer | string, assinatura: string | undefined, store: StoreKey): ResultadoAssinatura {
  const segredo = segredoWebhook(store);
  if (!segredo) return { ok: false, motivo: `Webhook da loja ${store} não está configurado (WOOCOMMERCE_${store}_WEBHOOK_SECRET).` };
  const bruta = String(assinatura ?? '').trim();
  if (!bruta) return { ok: false, motivo: 'Assinatura ausente.' };
  const bytes = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  const esperado = createHmac('sha256', segredo).update(bytes).digest();
  let recebido: Buffer;
  try {
    recebido = Buffer.from(bruta, 'base64');
  } catch {
    return { ok: false, motivo: 'Assinatura malformada.' };
  }
  if (recebido.length !== esperado.length) return { ok: false, motivo: 'Assinatura inválida.' };
  return timingSafeEqual(recebido, esperado) ? { ok: true } : { ok: false, motivo: 'Assinatura inválida.' };
}

/** Assinatura de teste (usada apenas pelos testes e por ferramentas de diagnóstico). */
export function assinarCorpo(corpo: Buffer | string, segredo: string): string {
  const bytes = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  return createHmac('sha256', segredo).update(bytes).digest('base64');
}

/**
 * Replay por timestamp: quando a loja informa o instante da entrega, entregas
 * fora da janela são recusadas. Sem o header, a checagem é dispensada — o ID de
 * entrega (inbox) continua sendo a barreira primária de replay.
 */
export function validarTimestamp(valor: string | undefined, agora = Date.now()): ResultadoAssinatura {
  const tol = toleranciaSegundos();
  if (!tol) return { ok: true };
  const bruto = String(valor ?? '').trim();
  if (!bruto) return { ok: true };
  const numero = Number(bruto);
  const instante = Number.isFinite(numero) && numero > 0 ? numero * 1000 : Date.parse(bruto);
  if (!Number.isFinite(instante)) return { ok: true };
  if (Math.abs(agora - instante) > tol * 1000) return { ok: false, motivo: 'Entrega fora da janela de tolerância (possível replay).' };
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Rate limit por IP (janela deslizante simples, em memória — mesmo desenho do
// `rateLimitPublico` do catálogo). Não é a autenticação: a assinatura é. É a
// defesa contra flood e força bruta de assinatura.
// ----------------------------------------------------------------------------
type Bucket = { count: number; desde: number };
const buckets = new Map<string, Bucket>();

/** IP do cliente atrás do proxy (primeiro da cadeia confiável). */
export function ipDoPedido(headers: Record<string, unknown>, remoto: string | undefined): string {
  const encaminhado = headers['x-forwarded-for'];
  const texto = Array.isArray(encaminhado) ? encaminhado[0] : encaminhado;
  return String(texto ?? '').split(',')[0]?.trim() || String(remoto || '?');
}

/** Consome uma unidade do bucket do IP. Devolve `retryAfterSeg` quando excede. */
export function consumirRateLimit(ip: string, agora = Date.now()): { ok: true } | { ok: false; retryAfterSeg: number } {
  const janela = rateJanelaMs();
  const maximo = rateMaximo();
  let b = buckets.get(ip);
  if (!b || agora - b.desde > janela) b = { count: 0, desde: agora };
  b.count += 1;
  buckets.set(ip, b);
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (agora - v.desde > janela) buckets.delete(k);
  if (b.count > maximo) return { ok: false, retryAfterSeg: Math.max(1, Math.ceil((janela - (agora - b.desde)) / 1000)) };
  return { ok: true };
}

/** Limpa os buckets (testes). */
export function limparRateLimit(): void {
  buckets.clear();
}

// ----------------------------------------------------------------------------
// MINIMIZAÇÃO DO PAYLOAD
//
// O corpo do pedido carrega PII (nome, e-mail, telefone, endereço do cliente).
// O ERP só precisa do suficiente para identificar o pedido e decidir a
// atualização; o resto é buscado na API oficial quando necessário. A remoção é
// RECURSIVA e por nome de chave — nunca depende do formato exato do evento.
// ----------------------------------------------------------------------------
const CHAVES_PII = new Set([
  'billing',
  'shipping',
  'customer',
  'customer_note',
  'email',
  'phone',
  'first_name',
  'last_name',
  'address_1',
  'address_2',
  'address',
  'postcode',
  'city',
  'company',
  'cpf',
  'cnpj',
  'ip_address',
  'customer_ip_address',
  'customer_user_agent',
  'date_paid',
  'date_completed',
  'payment_method_title',
  'transaction_id',
  'meta_data',
]);

/** Remove recursivamente chaves de PII conhecidas. Nunca altera a estrutura. */
export function minimizarPayload(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 12) return null;
  if (Array.isArray(valor)) return valor.slice(0, 200).map((v) => minimizarPayload(v, profundidade + 1));
  if (valor && typeof valor === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if (CHAVES_PII.has(k.toLowerCase())) continue;
      out[k] = minimizarPayload(v, profundidade + 1);
    }
    return out;
  }
  return valor;
}

/** Tópico do evento: header quando presente, senão deduzido do corpo. */
export function topicoDoEvento(headers: Record<string, unknown>, corpo: Record<string, unknown>): string {
  const header = String(headers[HEADER_TOPICO] ?? '').trim();
  if (header) return header.slice(0, 80);
  const recurso = String(headers[HEADER_RECURSO] ?? corpo?.type ?? '').trim();
  const evento = String(headers[HEADER_EVENTO] ?? corpo?.action ?? '').trim();
  return [recurso, evento].filter(Boolean).join('.') || 'desconhecido';
}

/** ID do recurso externo (pedido/produto) a que a entrega se refere. */
export function recursoExterno(corpo: Record<string, unknown>): string | null {
  const id = corpo?.id;
  if (id === undefined || id === null || id === '') return null;
  return String(id).slice(0, 64);
}
