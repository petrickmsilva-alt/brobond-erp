// ============================================================================
// MOTOR DE FRETE › INFRA › SEGURANÇA DE WEBHOOK DE TRANSPORTADORA
//
// O webhook é a única porta pública do módulo. Nada que chega por HTTP é
// confiável:
//
//   • o OPERADOR vem da ROTA (`/api/logistics/webhooks/:provider`) — nunca do
//     corpo; um atacante não escolhe o segredo de validação;
//   • a ASSINATURA é HMAC-SHA256 sobre os BYTES CRUS, comparada em tempo
//     constante, com segredo INDEPENDENTE por operador;
//   • o payload tem TETO de tamanho (recusado antes do HMAC);
//   • REPLAY é barrado pelo ID de entrega (inbox) e por uma JANELA de
//     tolerância sobre o timestamp, quando o operador o envia;
//   • RATE LIMIT por IP protege de flood e força bruta de assinatura;
//   • o payload é MINIMIZADO (dados pessoais descartados) antes de ser gravado.
//
// Segredo: `LOGISTICS_<PROVIDER>_WEBHOOK_SECRET`. Ausente = endpoint
// DESABILITADO para aquele operador (falha fechada).
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';

export const HEADER_ASSINATURA = 'x-logistics-signature';
export const HEADER_DELIVERY = 'x-logistics-delivery-id';
export const HEADER_EVENTO = 'x-logistics-event';
export const HEADER_TIMESTAMP = 'x-logistics-timestamp';

/** Teto do corpo (bytes). Acima disso a entrega é recusada sem calcular HMAC. */
export function limiteBytes(): number {
  const n = Number(process.env.LOGISTICS_WEBHOOK_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 8 * 1024 * 1024) : 1_048_576;
}

/** Tolerância do timestamp da entrega (segundos). 0 desliga a checagem. */
export function toleranciaSegundos(): number {
  const n = Number(process.env.LOGISTICS_WEBHOOK_TOLERANCE_S);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 86_400) : 300;
}

export function rateJanelaMs(): number {
  const n = Number(process.env.LOGISTICS_WEBHOOK_RATE_WINDOW_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}
export function rateMaximo(): number {
  const n = Number(process.env.LOGISTICS_WEBHOOK_RATE_MAX);
  return Number.isInteger(n) && n > 0 ? n : 120;
}

/** Segredo do webhook de UM operador. NUNCA vem do corpo. */
export function segredoWebhook(provider: string): string | null {
  const chave = `LOGISTICS_${String(provider).toUpperCase()}_WEBHOOK_SECRET`;
  const valor = String(process.env[chave] ?? '').trim();
  return valor || null;
}

export function webhookHabilitado(provider: string): boolean {
  return segredoWebhook(provider) !== null;
}

export type ResultadoAssinatura = { ok: true } | { ok: false; motivo: string };

/**
 * Valida a assinatura HMAC-SHA256 (base64 ou hex) sobre os BYTES CRUS.
 * Comparação em TEMPO CONSTANTE. Assinatura ausente/malformada é recusada.
 */
export function validarAssinatura(corpo: Buffer | string, assinatura: string | undefined, provider: string): ResultadoAssinatura {
  const segredo = segredoWebhook(provider);
  if (!segredo) return { ok: false, motivo: `Webhook do operador ${provider} não está configurado (LOGISTICS_${provider.toUpperCase()}_WEBHOOK_SECRET).` };
  const bruta = String(assinatura ?? '').trim();
  if (!bruta) return { ok: false, motivo: 'Assinatura ausente.' };
  const bytes = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  const esperado = createHmac('sha256', segredo).update(bytes).digest();
  // Aceita base64 (padrão) e hex (alguns operadores).
  const candidatos: Buffer[] = [];
  try {
    candidatos.push(Buffer.from(bruta, 'base64'));
  } catch {
    /* ignora */
  }
  if (/^[0-9a-f]{64}$/i.test(bruta)) candidatos.push(Buffer.from(bruta, 'hex'));
  for (const recebido of candidatos) {
    if (recebido.length === esperado.length && timingSafeEqual(recebido, esperado)) return { ok: true };
  }
  return { ok: false, motivo: 'Assinatura inválida.' };
}

/** Assinatura de teste (apenas testes e ferramentas de diagnóstico). */
export function assinarCorpo(corpo: Buffer | string, segredo: string): string {
  const bytes = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  return createHmac('sha256', segredo).update(bytes).digest('base64');
}

/** Replay por timestamp: entregas fora da janela são recusadas. */
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
// Rate limit por IP (janela deslizante em memória).
// ----------------------------------------------------------------------------
type Bucket = { count: number; desde: number };
const buckets = new Map<string, Bucket>();

export function ipDoPedido(headers: Record<string, unknown>, remoto: string | undefined): string {
  const encaminhado = headers['x-forwarded-for'];
  const texto = Array.isArray(encaminhado) ? encaminhado[0] : encaminhado;
  return String(texto ?? '').split(',')[0]?.trim() || String(remoto || '?');
}

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

export function limparRateLimit(): void {
  buckets.clear();
}

// ----------------------------------------------------------------------------
// MINIMIZAÇÃO DO PAYLOAD
// ----------------------------------------------------------------------------
const CHAVES_PII = new Set([
  'destinatario',
  'recipient',
  'nome',
  'name',
  'email',
  'telefone',
  'phone',
  'endereco',
  'address',
  'cpf',
  'cnpj',
  'documento',
  'document',
  'customer',
  'billing',
  'shipping',
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
